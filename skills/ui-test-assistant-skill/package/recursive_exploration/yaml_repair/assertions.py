"""识别 flow 中断言类步骤（启发式），用于禁止模型擅自新增断言。"""

from __future__ import annotations

import re
from typing import Any

ASSERT_STEP_KEYS = frozenset({"aiAssert", "aiAssertText", "assertText"})
CODE_STEP_KEYS = frozenset({"pyCode", "jsCode"})
QUERY_LIKE_KEYS = frozenset({"aiQuery"})


def _iter_flow_steps(flow: Any) -> list[dict[str, Any]]:
    """扁平遍历 flow 列表，展开简单 if.then/else。"""
    out: list[dict[str, Any]] = []
    if not isinstance(flow, list):
        return out
    for step in flow:
        if not isinstance(step, dict):
            continue
        if "if" in step:
            then_flow = step.get("then")
            else_flow = step.get("else")
            if isinstance(then_flow, list):
                out.extend(_iter_flow_steps(then_flow))
            if isinstance(else_flow, list):
                out.extend(_iter_flow_steps(else_flow))
            continue
        out.append(step)
    return out


def step_keys_histogram(flow: list[Any]) -> dict[str, int]:
    hist: dict[str, int] = {}
    for step in _iter_flow_steps(flow):
        for k in step:
            hist[k] = hist.get(k, 0) + 1
    return hist


def count_assert_steps_in_tasks(tasks: list[dict[str, Any]]) -> int:
    n = 0
    for t in tasks:
        flow = t.get("flow")
        if not isinstance(flow, list):
            continue
        for step in _iter_flow_steps(flow):
            if any(k in ASSERT_STEP_KEYS for k in step):
                n += 1
    return n


def count_code_query_steps(tasks: list[dict[str, Any]]) -> tuple[int, int, int]:
    """返回 (py/js 步骤数, aiQuery 数, 其它可计数 key 用于扩展)。"""
    pyjs = 0
    ai_q = 0
    for t in tasks:
        flow = t.get("flow")
        if not isinstance(flow, list):
            continue
        for step in _iter_flow_steps(flow):
            for k in step:
                if k in CODE_STEP_KEYS:
                    pyjs += 1
                if k in QUERY_LIKE_KEYS:
                    ai_q += 1
    return pyjs, ai_q, 0


def yaml_declares_assertions(tasks: list[dict[str, Any]]) -> bool:
    return count_assert_steps_in_tasks(tasks) > 0


def unclear_attribution_snippet(stderr_text: str, patterns: tuple[str, ...]) -> bool:
    """日志是否「难以归因」（启发式）：匹配常见超时/找不到类描述。"""
    s = stderr_text or ""
    if len(s.strip()) < 30:
        return True
    low = s.lower()
    for p in patterns:
        if re.search(p, s, flags=re.I) or re.search(p, low, flags=re.I):
            return True
    return False
