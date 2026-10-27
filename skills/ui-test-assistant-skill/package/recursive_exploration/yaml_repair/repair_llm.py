"""调用 LLM 生成候选 YAML（可选；无模型时由会话侧跳过）。"""

from __future__ import annotations

import logging
import re
from dataclasses import dataclass

import yaml

from recursive_exploration.input_mock_llm import try_get_page_extraction_llm

logger = logging.getLogger(__name__)


def strip_md_fence(text: str) -> str:
    s = (text or "").strip()
    if s.startswith("```"):
        lines = s.splitlines()
        if lines and lines[0].startswith("```"):
            lines = lines[1:]
        if lines and lines[-1].strip() == "```":
            lines = lines[:-1]
        s = "\n".join(lines).strip()
    return s


@dataclass
class RepairPromptContext:
    user_intent: str
    baseline_yaml: str
    failure_summary: str
    use_vision_hint: bool


async def propose_yaml_repair(ctx: RepairPromptContext) -> str:
    """返回候选 YAML 正文；失败返回空串。"""
    llm = try_get_page_extraction_llm()
    if llm is None:
        logger.warning("yaml_repair: 无可用 LLM，跳过自动生成")
        return ""
    try:
        from langchain_core.messages import HumanMessage, SystemMessage
    except ImportError:
        logger.warning("yaml_repair: 缺少 langchain_core")
        return ""

    vision_note = ""
    if ctx.use_vision_hint:
        vision_note = "\n当前轮次建议结合页面截图/视觉信息（若日志不足）；仍只输出 YAML。"

    system = (
        "你是 UI 自动化专家，修复 browser-use TasksConfig YAML。\n"
        "约束：\n"
        "1) 只输出合法 YAML，禁止 markdown 围栏以外的解释。\n"
        "2) 不得新增 aiAssert/aiAssertText/assertText 断言步骤（允许删除或弱化现有断言）。\n"
        "3) 不得新增 pyCode/jsCode/aiQuery 步骤。\n"
        "4) 少用固定长 sleep（尤其连续多个 3000ms）；耗时跳转、页面白屏、列表加载等优先用 aiWaitFor"
        "（如「等待页面加载完成」「xxx 页面加载完成」），由运行时动态等待更稳。\n"
        "5) 若失败原因是断言「创建成功/保存成功」等 Toast：此类提示常转瞬即逝，到达断言步骤时已消失；"
        "应删除该断言或改为校验稳定结果（如列表中出现某行、某数据源名称），不要强行加长前置 sleep。\n"
        "6) 登录流程若「账号密码登录表单」等待不稳，可改为 aiWaitFor「等待页面加载完成」或去掉重复 tap+wait，避免堆叠 sleep。\n"
        "7) 若某 aiWaitFor 依赖后台接口或无明显界面变化（如无 Toast/DOM 标记），等待会一直不满足直至超时；"
        "应改为短 sleep、或改为等待「具体控件可见/可输入」（如分区标签输入框），不要用抽象的「xxx 获取完成」。\n"
        "8) 保持 target 与 tasks 顶层结构；steps 仅在 flow 内。\n"
        f"{vision_note}"
    )
    user = (
        f"用户意图/背景:\n{ctx.user_intent or '(未提供)'}\n\n"
        f"失败与日志摘要:\n{ctx.failure_summary[:12000]}\n\n"
        f"当前 YAML:\n{ctx.baseline_yaml[:20000]}\n"
    )
    msg = await llm.ainvoke([SystemMessage(content=system), HumanMessage(content=user)])
    content = getattr(msg, "content", None)
    text = str(content) if content is not None else ""
    text = strip_md_fence(text)
    try:
        yaml.safe_load(text)
    except Exception:
        logger.warning("yaml_repair: 模型输出非合法 YAML")
        return ""
    return text


def looks_like_yaml_tasks_config(text: str) -> bool:
    try:
        d = yaml.safe_load(text)
    except Exception:
        return False
    if not isinstance(d, dict):
        return False
    return "tasks" in d and isinstance(d.get("tasks"), list)


_HTTP_CLIENT_PATTERN = re.compile(r"\b(requests\.|httpx\.|urllib\.|fetch\s*\()", re.I)


def contains_http_client_snippet(text: str) -> bool:
    """粗检 pyCode/jsCode 字符串是否夹带 HTTP 客户端调用（双保险）。"""
    return bool(_HTTP_CLIENT_PATTERN.search(text or ""))
