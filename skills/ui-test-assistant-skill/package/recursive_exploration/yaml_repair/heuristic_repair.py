"""失败后的启发式 YAML 修补（不调用 LLM）。

典型场景：登录页已展示用户名/密码框，但 aiWaitFor「直至账号密码登录表单显示」因语义/缓存等待过严而长时间阻塞或超时。
默认将此类 aiWaitFor 替换为 **aiWaitFor:「等待页面加载完成」**（可配置），避免滥用固定长 sleep；
若显式关闭「用等待替代」，则回退为短 sleep（毫秒可配），并合并连续 sleep。
"""

from __future__ import annotations

import copy
import logging
from pathlib import Path
from typing import Any

import yaml

logger = logging.getLogger(__name__)

# 与登录表单相关的等待文案（命中即视为可替换）
_LOGIN_FORM_WAIT_MARKERS: tuple[str, ...] = (
    "账号密码登录表单",
    "登录表单显示",
)

def _read_log(log_dir: Path) -> str:
    p = Path(log_dir) / "log.log"
    if not p.is_file():
        return ""
    try:
        return p.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return ""


def _blob_has_timeout(blob: str) -> bool:
    low = (blob or "").lower()
    return "timeout" in low or "timed out" in low


def _blob_mentions_login_form_context(blob: str) -> bool:
    """超时类失败是否与「登录表单」等待相关（避免误伤其它 aiWaitFor 超时）。"""
    return any(m in (blob or "") for m in _LOGIN_FORM_WAIT_MARKERS)


def _count_login_form_waits(yaml_text: str) -> int:
    try:
        data = yaml.safe_load(yaml_text)
    except Exception:
        return 0
    if not isinstance(data, dict):
        return 0
    tasks = data.get("tasks")
    if not isinstance(tasks, list):
        return 0
    n = 0
    for t in tasks:
        if not isinstance(t, dict):
            continue
        flow = t.get("flow")
        if not isinstance(flow, list):
            continue
        for step in flow:
            if _step_is_login_form_ai_wait(step):
                n += 1
    return n


def _step_is_login_form_ai_wait(step: Any) -> bool:
    if not isinstance(step, dict):
        return False
    v = step.get("aiWaitFor")
    if not isinstance(v, str):
        return False
    return any(m in v for m in _LOGIN_FORM_WAIT_MARKERS)


def _step_is_sleep(step: Any) -> bool:
    return isinstance(step, dict) and "sleep" in step and len(step) == 1


def _collapse_consecutive_sleeps(flow: list[Any]) -> list[Any]:
    out: list[Any] = []
    for step in flow:
        if (
            out
            and _step_is_sleep(out[-1])
            and _step_is_sleep(step)
            and isinstance(out[-1]["sleep"], (int, float))
            and isinstance(step["sleep"], (int, float))
        ):
            merged = int(out[-1]["sleep"]) + int(step["sleep"])
            out[-1] = {"sleep": min(merged, 10_000)}
        else:
            out.append(copy.deepcopy(step))
    return out


def _apply_login_form_wait_patch(
    data: dict[str, Any],
    *,
    use_ai_wait_for: bool,
    sleep_ms: int,
    wait_text: str,
) -> int:
    """将匹配的 aiWaitFor 替换为 aiWaitFor（推荐）或 sleep；返回替换次数。"""
    replaced = 0
    wt = (wait_text or "").strip() or "等待页面加载完成"
    tasks = data.get("tasks")
    if not isinstance(tasks, list):
        return 0
    for task in tasks:
        if not isinstance(task, dict):
            continue
        flow = task.get("flow")
        if not isinstance(flow, list):
            continue
        new_flow: list[Any] = []
        for step in flow:
            if _step_is_login_form_ai_wait(step):
                if use_ai_wait_for:
                    new_flow.append({"aiWaitFor": wt})
                else:
                    new_flow.append({"sleep": int(sleep_ms)})
                replaced += 1
            else:
                new_flow.append(copy.deepcopy(step))
        task["flow"] = _collapse_consecutive_sleeps(new_flow)
    return replaced


def should_apply_login_form_heuristic(
    yaml_text: str,
    *,
    log_text: str,
    stderr: str,
    stdout: str,
) -> bool:
    if _count_login_form_waits(yaml_text) == 0:
        return False

    blob = f"{log_text}\n{stderr}\n{stdout}"

    # 重复的「等登录表单」步骤（冗余 tap+wait）
    if _count_login_form_waits(yaml_text) >= 2:
        return True
    # 超时：日志/ stderr 中须出现登录表单相关文案，避免误替换无关步骤导致的 timeout
    if _blob_has_timeout(blob) and _blob_mentions_login_form_context(blob):
        return True

    return False


def try_heuristic_repair(
    baseline_yaml: str,
    *,
    log_dir: Path,
    stderr: str,
    stdout: str,
    enabled: bool = True,
    use_ai_wait_for: bool = True,
    sleep_ms: int = 1500,
    wait_text: str = "等待页面加载完成",
    log_text_override: str | None = None,
) -> tuple[str | None, str]:
    """
    若启发式适用，返回 (新 YAML 全文, 说明)；否则 (None, "").
    """
    if not enabled:
        return None, ""
    log_text = log_text_override if log_text_override is not None else _read_log(log_dir)
    if not should_apply_login_form_heuristic(
        baseline_yaml,
        log_text=log_text,
        stderr=stderr,
        stdout=stdout,
    ):
        return None, ""

    try:
        data = yaml.safe_load(baseline_yaml)
    except Exception as e:
        logger.debug("heuristic_repair: 跳过（YAML 解析失败）: %s", e)
        return None, ""

    if not isinstance(data, dict):
        return None, ""

    ms = max(300, int(sleep_ms))
    n = _apply_login_form_wait_patch(
        data,
        use_ai_wait_for=use_ai_wait_for,
        sleep_ms=ms,
        wait_text=wait_text,
    )
    if n <= 0:
        return None, ""

    try:
        out_text = yaml.dump(
            data,
            allow_unicode=True,
            default_flow_style=False,
            sort_keys=False,
            width=120,
        )
    except Exception as e:
        logger.warning("heuristic_repair: dump 失败: %s", e)
        return None, ""

    if out_text.strip() == baseline_yaml.strip():
        return None, ""

    if use_ai_wait_for:
        note = (
            f"将 {n} 处「账号密码登录表单」类 aiWaitFor 替换为 aiWaitFor:「{(wait_text or '').strip() or '等待页面加载完成'}」"
        )
    else:
        note = f"将 {n} 处「账号密码登录表单」类 aiWaitFor 替换为 sleep:{ms}ms，并合并连续 sleep"
    return out_text, note
