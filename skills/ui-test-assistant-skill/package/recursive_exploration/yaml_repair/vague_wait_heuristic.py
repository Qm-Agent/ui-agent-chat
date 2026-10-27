"""aiWaitFor 文案在页面上无可感知特征时，易导致长时间空等直至超时。

当日志显示某步「直至 xxx」的等待发生 timeout，且 xxx 属于已知「弱特征」文案时，
将该步改为短 sleep 或改为更易观测的等待目标，避免同一 YAML 在多轮自愈中反复卡死。
"""

from __future__ import annotations

import copy
import logging
import re
from pathlib import Path
from typing import Any

import yaml

logger = logging.getLogger(__name__)


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


# 命中则优先替换为 sleep（API 无接口返回、DOM 上常无独立「完成」态）
_DEFAULT_REPLACE_SLEEP_MS = 5000
_KNOWN_WEAK_WAIT_PHRASES: frozenset[str] = frozenset(
    {
        "分区名获取完成",
        "ODPS分区名获取完成",
        "分区获取完成",
    }
)


def _executed_wait_phrases_from_log(log_text: str) -> list[str]:
    """从 log 中解析 [等待] 直至 … 的文案序列。"""
    out: list[str] = []
    for m in re.finditer(
        r"Executing command:\s*\[等待\]\s*直至\s*(.+?)\s*$",
        log_text,
        re.MULTILINE,
    ):
        out.append(m.group(1).strip())
    return out


def _last_wait_before_timeout(log_text: str) -> str | None:
    """取 Timeout 之前最后一次出现的「直至」文案，作为失败等待目标的首选。"""
    if "Timeout after" not in log_text and "timeout after" not in log_text.lower():
        return None
    phrases = _executed_wait_phrases_from_log(log_text)
    return phrases[-1] if phrases else None


def _replace_weak_ai_wait_in_doc(
    data: dict[str, Any],
    *,
    phrase: str,
    sleep_ms: int,
    prefer_sleep: bool,
    alternate_wait: str | None,
) -> tuple[int, str]:
    """
    将 flow 中 aiWaitFor == phrase 的步骤替换。
    prefer_sleep=True → sleep；否则若提供 alternate_wait → aiWaitFor；再退回 sleep。
    返回 (替换次数, 策略说明).
    """
    n = 0
    strategy = "sleep"
    tasks = data.get("tasks")
    if not isinstance(tasks, list):
        return 0, strategy

    rep_sleep = max(500, int(sleep_ms))
    alt = (alternate_wait or "").strip()

    for task in tasks:
        if not isinstance(task, dict):
            continue
        flow = task.get("flow")
        if not isinstance(flow, list):
            continue
        new_flow: list[Any] = []
        for step in flow:
            if (
                isinstance(step, dict)
                and step.get("aiWaitFor") == phrase
            ):
                n += 1
                if prefer_sleep or not alt:
                    new_flow.append({"sleep": rep_sleep})
                    strategy = "sleep"
                else:
                    new_flow.append({"aiWaitFor": alt})
                    strategy = "aiWaitFor"
            else:
                new_flow.append(copy.deepcopy(step))
        task["flow"] = new_flow

    return n, strategy


def should_apply_vague_wait_fallback(
    yaml_text: str,
    *,
    log_text: str,
    stderr: str,
    stdout: str,
) -> tuple[bool, str | None]:
    """
    若本轮为 aiWaitFor 超时，且超时前最后一条「直至」文案在 YAML 中存在且属于弱特征，返回 (True, phrase)。
    """
    blob = f"{log_text}\n{stderr}\n{stdout}"
    if not _blob_has_timeout(blob):
        return False, None

    last_phrase = _last_wait_before_timeout(log_text)
    if not last_phrase:
        return False, None

    try:
        doc = yaml.safe_load(yaml_text)
    except Exception:
        return False, None
    if not isinstance(doc, dict):
        return False, None
    tasks = doc.get("tasks")
    if not isinstance(tasks, list):
        return False, None

    yaml_phrases: set[str] = set()
    for t in tasks:
        if not isinstance(t, dict):
            continue
        flow = t.get("flow")
        if not isinstance(flow, list):
            continue
        for step in flow:
            if isinstance(step, dict) and isinstance(step.get("aiWaitFor"), str):
                yaml_phrases.add(step["aiWaitFor"].strip())

    if last_phrase not in yaml_phrases:
        return False, None

    if last_phrase in _KNOWN_WEAK_WAIT_PHRASES:
        return True, last_phrase
    if "分区名获取" in last_phrase or "ODPS表分区" in last_phrase:
        return True, last_phrase

    return False, None


def try_vague_wait_fallback_repair(
    baseline_yaml: str,
    *,
    log_dir: Path,
    stderr: str,
    stdout: str,
    enabled: bool = True,
    sleep_ms: int = _DEFAULT_REPLACE_SLEEP_MS,
    prefer_sleep: bool = True,
    alternate_wait: str = "",
    log_text_override: str | None = None,
) -> tuple[str | None, str]:
    """
    将弱特征 aiWaitFor 换成 sleep 或备用 aiWaitFor；返回 (新 YAML, 说明)。
    """
    if not enabled:
        return None, ""

    log_text = log_text_override if log_text_override is not None else _read_log(log_dir)
    use, phrase = should_apply_vague_wait_fallback(
        baseline_yaml,
        log_text=log_text,
        stderr=stderr,
        stdout=stdout,
    )
    if not use or not phrase:
        return None, ""

    try:
        data = yaml.safe_load(baseline_yaml)
    except Exception as e:
        logger.debug("vague_wait_heuristic: YAML 解析失败: %s", e)
        return None, ""

    if not isinstance(data, dict):
        return None, ""

    alt = alternate_wait.strip()
    n, strat = _replace_weak_ai_wait_in_doc(
        data,
        phrase=phrase,
        sleep_ms=sleep_ms,
        prefer_sleep=prefer_sleep,
        alternate_wait=alt or None,
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
        logger.warning("vague_wait_heuristic: dump 失败: %s", e)
        return None, ""

    if out_text.strip() == baseline_yaml.strip():
        return None, ""

    if strat == "sleep":
        note = (
            f"弱特征等待「{phrase}」在日志中已触发超时：页面可能无可判定视觉态。"
            f"已改为 sleep:{max(500, int(sleep_ms))}ms，避免 aiWaitFor 空转；"
            f"你可再改为「分区标签输入框可见」等更可观测条件。"
        )
    else:
        note = (
            f"弱特征等待「{phrase}」已超时：已改为 aiWaitFor:「{alt}」，"
            "请按页面实际控件文案微调。"
        )
    return out_text, note
