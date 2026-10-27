"""任务来源标签（事件与 HTML 审查共用）。"""

from __future__ import annotations

import re

from recursive_exploration.models import ActionTask


def infer_action_tag(
    task: ActionTask,
    *,
    url_before: str = "",
    url_after: str = "",
) -> str:
    """基于描述/URL 变化的启发式动作语义标签。"""
    text = f"{task.locate_prompt} {task.target_description}".lower()
    url_b = (url_before or "").lower()
    url_a = (url_after or "").lower()
    if "login" in text or "登录" in text or "/login" in url_b or "/login" in url_a:
        return "login"
    if "search" in text or "搜索" in text or "query" in text:
        return "search"
    if "filter" in text or "筛选" in text:
        return "filter"
    if re.search(r"\b(nav|menu|sidebar|导航)\b", text) or "菜单" in text:
        return "nav"
    if any(x in text for x in ("submit", "保存", "确认", "提交")):
        return "submit"
    if any(x in text for x in ("create", "新建", "新增", "添加")):
        return "create"
    if any(x in text for x in ("detail", "详情", "查看")):
        return "open_detail"
    if any(x in text for x in ("back", "返回", "上一页")):
        return "back"
    if url_before and url_after and url_before != url_after:
        return "nav"
    return "unknown"


def step_origin_code(task: ActionTask) -> str:
    """用于事件 JSON / timeline：single_native | single_expand | composite | intent_mission。"""
    if task.task_kind == "composite":
        return "composite"
    if task.task_kind == "intent_mission":
        return "intent_mission"
    if not task.prefix_steps:
        return "single_native"
    return "single_expand"


def step_origin_display(code: str) -> str:
    """中文短标签（HTML）。"""
    return {
        "single_native": "单步·首轮入队（页面初始枚举）",
        "single_expand": "单步·扩队新增（前缀重放后的新操作）",
        "composite": "多步组合（composite 规划）",
        "intent_mission": "意图任务（LLM 多步 ai）",
    }.get(code, code)
