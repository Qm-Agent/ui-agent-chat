"""
为 input/textarea 探索步骤生成短占位文本：优先调用与探索脚本一致的 build_models（BU_*），
失败或未配置凭据时由调用方使用配置中的回退串。

须在已 load_dotenv 且可 import browser_use 的进程内调用（与 run_recursive_exploration 一致）。
"""
from __future__ import annotations

import logging
import os
import re
from typing import Any

logger = logging.getLogger(__name__)

_llm_cache: Any | None | bool = False  # False = 未尝试, None = 不可用


def reset_llm_cache_for_tests() -> None:
    global _llm_cache
    _llm_cache = False


def _env_model(key: str, fallback: str) -> str:
    v = (os.getenv(key) or "").strip()
    return v if v else fallback


def try_get_page_extraction_llm() -> Any | None:
    """懒加载单例；失败返回 None。"""
    global _llm_cache
    if _llm_cache is not False:
        return _llm_cache
    try:
        from browser_use.agent.chat_models import build_models

        dm = _env_model("BU_PAGE_EXTRACTION_LLM", "qwen3.7-plus")
        actor = _env_model("BU_ACTOR_MODEL", dm)
        planner = _env_model("BU_PLANNER_MODEL", dm)
        asserter = _env_model("BU_ASSERTER_MODEL", dm)
        page = _env_model("BU_PAGE_EXTRACTION_LLM", dm)
        locating = _env_model("BU_LOCATING_LLM", page)
        coding = _env_model("BU_CODING_LLM", page)
        _, _, _, aux = build_models(
            actor=actor,
            planner=planner,
            asserter=asserter,
            page_extraction_llm=page,
            locating_llm=locating,
            coding_llm=coding,
        )
        _llm_cache = aux.get("page_extraction_llm")
    except Exception as e:  # pragma: no cover - 依赖环境
        logger.warning("recursive_exploration: build_models 不可用，input 占位将用回退串: %s", e)
        _llm_cache = None
    return _llm_cache


def _clean_model_line(raw: str) -> str:
    s = (raw or "").strip()
    if not s:
        return ""
    s = s.splitlines()[0].strip()
    s = s.strip('"').strip("'").strip("`")
    s = re.sub(r"^填充[:：]\s*", "", s, flags=re.I)
    return s[:120]


async def suggest_input_mock_text(
    llm: Any | None,
    *,
    page_url: str,
    page_title: str,
    locate_prompt: str,
    tap_description: str,
    fallback: str,
) -> str:
    """
    由模型生成一条适合当前控件的短测试输入；无模型或失败时返回 fallback。
    """
    if llm is None:
        return fallback
    try:
        from langchain_core.messages import HumanMessage, SystemMessage
    except ImportError:
        return fallback

    system = (
        "你是 UI 自动化测试助手。根据页面 URL、标题与输入控件描述，生成**一条**适合填入该控件的"
        "短占位文本（模拟真实用户输入）。\n"
        "规则：只输出一行纯文本，不要引号、不要 markdown、不要解释；长度不超过 80 字符。\n"
        "若为搜索框，输出简短中文检索词；若为邮箱，类似 test@example.com；若为密码框，"
        "输出虚构密码串；若为姓名/公司名，输出虚构中文词。"
    )
    user = (
        f"当前页 URL: {page_url}\n"
        f"页面标题: {page_title}\n"
        f"控件自然语言描述: {locate_prompt or '(无)'}\n"
        f"DOM 摘要: {tap_description or '(无)'}\n"
        "请只输出要填入的文本本身。"
    )
    try:
        msg = await llm.ainvoke([SystemMessage(content=system), HumanMessage(content=user)])
        content = getattr(msg, "content", None)
        text = _clean_model_line(str(content) if content is not None else "")
        return text if text else fallback
    except Exception as e:  # pragma: no cover
        logger.debug("suggest_input_mock_text LLM 失败: %s", e)
        return fallback
