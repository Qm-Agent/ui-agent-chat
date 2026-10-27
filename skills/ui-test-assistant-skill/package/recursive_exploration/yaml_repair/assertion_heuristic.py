"""断言相关启发式：瞬时 Toast / 提示文案类断言在执行到达时常已消失，易导致 aiAssert 误失败。"""

from __future__ import annotations

import copy
import logging
import re
from pathlib import Path
from typing import Any

import yaml

from recursive_exploration.yaml_repair.assertions import ASSERT_STEP_KEYS, _iter_flow_steps

logger = logging.getLogger(__name__)


def _read_log(log_dir: Path) -> str:
    p = Path(log_dir) / "log.log"
    if not p.is_file():
        return ""
    try:
        return p.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return ""


# 命中则认为「依赖瞬时 UI 文案」、可删断言（不新增其它断言）
_TRANSIENT_ASSERT_MARKERS_PLAIN: tuple[str, ...] = (
    "创建成功",
    "保存成功",
    "提交成功",
    "删除成功",
    "操作成功",
)

_POST_CREATE_WAIT_TEXT = "等待页面加载完成"


def _log_suggests_assert_failure(log_text: str, stderr: str, stdout: str) -> bool:
    blob = f"{log_text}\n{stderr}\n{stdout}"
    if "Assertion: False" in blob:
        return True
    if "Assertion reason:" in blob:
        return True
    if "[断言]" in blob and ("ERROR" in blob or "Error executing command" in blob):
        return True
    if "RuntimeError" in blob and "断言" in blob:
        return True
    return False


def _step_is_transient_assert(step: Any) -> bool:
    if not isinstance(step, dict):
        return False
    for key in ASSERT_STEP_KEYS:
        if key not in step:
            continue
        val = step[key]
        if not isinstance(val, str):
            continue
        if any(m in val for m in _TRANSIENT_ASSERT_MARKERS_PLAIN):
            return True
        if re.search(r"提示.*成功", val):
            return True
    return False


def _tap_is_create_submit(step: Any) -> bool:
    if not isinstance(step, dict) or "aiTap" not in step:
        return False
    v = step["aiTap"]
    return isinstance(v, str) and ("创建" in v or "提交" in v)


def _upgrade_sleep_after_submit(flow: list[Any]) -> int:
    """将「创建/提交」后的长 sleep 换成 aiWaitFor 页面加载，减少 Toast 错过仍傻等。"""
    changed = 0
    for i in range(len(flow) - 1):
        if not _tap_is_create_submit(flow[i]):
            continue
        nxt = flow[i + 1]
        if not isinstance(nxt, dict) or "sleep" not in nxt:
            continue
        try:
            ms = int(nxt["sleep"])
        except (TypeError, ValueError):
            continue
        if ms >= 1500:
            flow[i + 1] = {"aiWaitFor": _POST_CREATE_WAIT_TEXT}
            changed += 1
    return changed


def _strip_transient_asserts_from_tasks(data: dict[str, Any]) -> int:
    """返回删除的断言步数。"""
    removed = 0
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
            if _step_is_transient_assert(step):
                removed += 1
                continue
            new_flow.append(copy.deepcopy(step))
        task["flow"] = new_flow

    return removed


def try_transient_assert_repair(
    baseline_yaml: str,
    *,
    log_dir: Path,
    stderr: str,
    stdout: str,
    enabled: bool = True,
    upgrade_post_submit_sleep: bool = True,
    log_text_override: str | None = None,
) -> tuple[str | None, str]:
    """
    若日志显示断言失败且存在「创建成功」等瞬时文案断言，则删除这些断言；
    可选将「创建」后的长 sleep 改为 aiWaitFor「等待页面加载完成」。
    """
    if not enabled:
        return None, ""

    log_text = log_text_override if log_text_override is not None else _read_log(log_dir)
    if not _log_suggests_assert_failure(log_text, stderr, stdout):
        return None, ""

    try:
        data = yaml.safe_load(baseline_yaml)
    except Exception as e:
        logger.debug("assertion_heuristic: YAML 解析失败: %s", e)
        return None, ""

    if not isinstance(data, dict):
        return None, ""

    # 快速扫描：至少有一处瞬时断言才改写
    found_transient = False
    tasks = data.get("tasks")
    if isinstance(tasks, list):
        for t in tasks:
            if not isinstance(t, dict):
                continue
            flow = t.get("flow")
            if not isinstance(flow, list):
                continue
            for step in _iter_flow_steps(flow):
                if _step_is_transient_assert(step):
                    found_transient = True
                    break
            if found_transient:
                break

    if not found_transient:
        return None, ""

    removed = _strip_transient_asserts_from_tasks(data)
    if removed <= 0:
        return None, ""

    upgraded = 0
    if upgrade_post_submit_sleep and isinstance(tasks, list):
        for task in tasks:
            if not isinstance(task, dict):
                continue
            flow = task.get("flow")
            if isinstance(flow, list):
                upgraded += _upgrade_sleep_after_submit(flow)

    try:
        out_text = yaml.dump(
            data,
            allow_unicode=True,
            default_flow_style=False,
            sort_keys=False,
            width=120,
        )
    except Exception as e:
        logger.warning("assertion_heuristic: dump 失败: %s", e)
        return None, ""

    parts = [
        f"已删除 {removed} 条依赖瞬时提示（如 Toast「创建成功」）的断言；"
        "执行到达断言步骤时提示往往已消失，此类断言不稳定。"
    ]
    if upgraded:
        parts.append(f"已将 {upgraded} 处「创建/提交」后的长 sleep 改为 aiWaitFor:「{_POST_CREATE_WAIT_TEXT}」。")
    parts.append("建议后续用列表中出现的数据源名称等**稳定态**做校验，或在手工验收中确认。")
    note = "".join(parts)
    return out_text, note
