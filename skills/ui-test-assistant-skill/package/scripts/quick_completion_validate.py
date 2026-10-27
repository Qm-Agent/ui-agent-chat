#!/usr/bin/env python3
"""Quick 模式用例完成度二次验收：对照原始步骤/预期与执行轨迹，避免 Agent 仅登录即 done(success=true) 的假阳性。"""
from __future__ import annotations

import asyncio
import json
import os
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Iterable

# 仅用于从步骤/预期中识别「登录不算完成」的业务里程碑（子串匹配，大小写不敏感）
_BUSINESS_MILESTONE_HINTS = (
    "新建知识库",
    "问答对",
    "命中测试",
    "联网搜索",
    "参数设置",
    "历史会话",
    "多轮",
    "图文",
    "相似度",
    "上传",
    "导入",
    "加工",
    "查看详情",
    "原始数据",
    "文档知识",
    "表格加工",
    "发送按钮",
    "发送",
    "切换模型",
    "deepseek",
    "选择知识库",
    "知识库文件",
)

_LOGIN_ONLY_DONE_MARKERS = (
    "登录流程完成",
    "确认登录",
    "已成功登录",
    "登录成功",
    "完成登录",
    "进入知识库管理界面",
    "进入知识问答",
)

_STEP_NOISE_PREFIXES = (
    "点击",
    "选择",
    "输入",
    "打开",
    "关闭",
    "等待",
    "查看",
    "校验",
    "验证",
    "返回",
    "调整",
    "勾选",
    "保存",
    "提交",
    "在",
    "将",
    "从",
    "到",
    "并",
    "后",
    "再",
    "进行",
    "确保",
    "确认",
)

_QUERY_TASK_STOP_RE = re.compile(
    r"(?=若出现登录|如果出现登录|必须严格|文本唯一性规则|业务执行提示|通用执行约束|$)",
    re.S,
)


@dataclass
class CaseAcceptanceCriteria:
    title: str = ""
    steps_text: str = ""
    expected_text: str = ""
    test_point: str = ""
    milestones: list[str] = field(default_factory=list)
    business_hints: list[str] = field(default_factory=list)


@dataclass
class QuickAttemptOutcome:
    returncode: int = 1
    agent_done_success: bool | None = None
    agent_done_text: str = ""
    action_types: list[str] = field(default_factory=list)
    action_events: list[str] = field(default_factory=list)
    action_summary: str = ""
    step_count: int = 0
    parse_error: str = ""


@dataclass
class CompletionValidation:
    passed: bool
    method: str  # skipped | heuristic | llm | cli_failed | agent_failed
    reason: str
    milestones_total: int = 0
    milestones_met: int = 0
    missing_milestones: list[str] = field(default_factory=list)
    agent_done_success: bool | None = None
    agent_done_text: str = ""

    def to_dict(self) -> dict[str, Any]:
        return {
            "passed": self.passed,
            "method": self.method,
            "reason": self.reason,
            "milestones_total": self.milestones_total,
            "milestones_met": self.milestones_met,
            "missing_milestones": self.missing_milestones,
            "agent_done_success": self.agent_done_success,
            "agent_done_text": self.agent_done_text,
        }


def _clean(text: Any) -> str:
    if text is None:
        return ""
    return re.sub(r"\s+", " ", str(text)).strip()


def _normalize_steps(raw_steps: Any) -> list[str]:
    if isinstance(raw_steps, list):
        items = [_clean(s) for s in raw_steps if _clean(s)]
    else:
        text = _clean(raw_steps)
        if not text:
            return []
        text = re.sub(r"(^|\s)\d+\.\s*", "\n", text)
        items = re.split(r"\n|；|;", text)
        items = [_clean(re.sub(r"^\d+\.\s*", "", x)) for x in items if _clean(x)]
    return [s for s in items if len(s) >= 3]


def _looks_like_generic_quick_title(title: str) -> bool:
    title = _clean(title)
    if not title:
        return False
    return bool(re.match(r"^(快速测试|普通测试|冒烟测试|巡检)(\s+https?://|\s*$)", title))


def _extract_query_task_milestones(query: str) -> list[str]:
    """从单条自然语言 quick query 中抽取真正的业务目标，避免只用 URL 标题验收。"""
    query = _clean(query)
    if not query:
        return []
    patterns = (
        r"(?:快速测试一下|快速测试|普通测试一下|普通测试|测试一下)[：:，,]\s*(.+)",
        r"(?:执行|校验|验证)\s*(.+)",
    )
    for pat in patterns:
        m = re.search(pat, query, re.S)
        if not m:
            continue
        text = _QUERY_TASK_STOP_RE.split(m.group(1), maxsplit=1)[0]
        text = re.sub(r"^https?://\S+\s*", "", text).strip(" 。；;，,")
        if len(text) >= 6:
            return _normalize_steps(text)
    return []


def criteria_from_record(record: Any) -> CaseAcceptanceCriteria:
    """从 QuickRecord.raw 或 query 文本提取验收口径。"""
    raw = getattr(record, "raw", None) or {}
    title = _clean(getattr(record, "title", "") or raw.get("title"))
    steps = _normalize_steps(raw.get("steps") or raw.get("测试步骤"))
    expected = _clean(raw.get("expected") or raw.get("预期结果"))
    test_point = _clean(raw.get("test_point") or raw.get("测试点") or raw.get("tp"))
    query = _clean(getattr(record, "query", ""))

    if not steps:
        m = re.search(r"测试步骤[：:](.+?)(?=预期结果|请按该测试|$)", query, re.S)
        if m:
            steps = _normalize_steps(m.group(1))
    if not expected:
        m = re.search(r"预期结果[：:](.+?)(?=请按该测试|$)", query, re.S)
        if m:
            expected = _clean(m.group(1))

    query_milestones: list[str] = []
    if not steps:
        query_milestones = _extract_query_task_milestones(query)

    blob = "\n".join([title, test_point, " ".join(steps), expected, " ".join(query_milestones), query])
    hints = [h for h in _BUSINESS_MILESTONE_HINTS if h.lower() in blob.lower()]
    if steps:
        milestones = steps
    elif query_milestones:
        milestones = query_milestones
    elif title and not _looks_like_generic_quick_title(title):
        milestones = [title]
    else:
        milestones = []
    if expected and expected not in milestones:
        milestones = list(milestones) + [f"预期：{expected[:120]}"]

    return CaseAcceptanceCriteria(
        title=title,
        steps_text="；".join(steps),
        expected_text=expected,
        test_point=test_point,
        milestones=milestones,
        business_hints=hints,
    )


def _action_label(action: dict[str, Any]) -> str:
    for key in action:
        if key == "done":
            payload = action.get("done") or {}
            text = _clean(payload.get("text"))
            ok = payload.get("success")
            return f"done(success={ok}): {text[:200]}"
        if key == "input_text":
            payload = action.get("input_text") or {}
            text = _clean(payload.get("text"))
            if re.fullmatch(r"\$\{?(?:USERNAME|PASSWORD|QUICK_USERNAME|QUICK_PASSWORD)\}?", text):
                text = "<sensitive>"
            desc = _clean(payload.get("detailed_input_field_description"))
            extra = f"text={text[:80]}" if text else ""
            if desc:
                extra = f"{extra}; desc={desc[:120]}" if extra else f"desc={desc[:120]}"
            return f"input_text({extra})" if extra else "input_text"
        if key == "click":
            payload = action.get("click") or {}
            desc = _clean(payload.get("detailed_element_description"))
            return f"click(desc={desc[:160]})" if desc else "click"
        if key == "send_keys":
            payload = action.get("send_keys") or {}
            keys = _clean(payload.get("keys"))
            return f"send_keys(keys={keys[:80]})" if keys else "send_keys"
        if key in (
            "click",
            "go_to_url",
            "scroll_up",
            "scroll_down",
            "wait",
            "send_keys",
            "upload",
            "clear_input_text",
            "scroll_to_text",
        ):
            return key
    return "other"


def _parse_jsonish_text(text: Any) -> dict[str, Any] | None:
    raw = str(text or "").strip()
    if not raw:
        return None
    try:
        data = json.loads(raw)
    except Exception:
        return None
    return data if isinstance(data, dict) else None


def _planner_output_text(output: Any) -> str:
    if not isinstance(output, dict):
        return ""
    parts: list[str] = []
    for key in ("state_analysis", "progress_evaluation", "reasoning", "plan"):
        value = output.get(key)
        if value:
            parts.append(_clean(value))
    current_state = output.get("current_state")
    if isinstance(current_state, dict):
        for key in ("reasoning", "expected_outcome"):
            value = current_state.get(key)
            if value:
                parts.append(_clean(value))
    return " ".join(p for p in parts if p)


def _apply_done_from_text(outcome: QuickAttemptOutcome, text: str, *, success: bool | None) -> None:
    text = _clean(text)
    if not text:
        return
    if success is not None:
        outcome.agent_done_success = bool(success)
    if len(text) > len(outcome.agent_done_text):
        outcome.agent_done_text = text


def parse_quick_attempt_outcome(log_dir: Path, *, returncode: int) -> QuickAttemptOutcome:
    outcome = QuickAttemptOutcome(returncode=returncode)
    result_files = sorted(log_dir.glob("quick_task_result*.json"))
    if not result_files:
        outcome.parse_error = "未找到 quick_task_result*.json"
        return outcome

    try:
        doc = json.loads(result_files[-1].read_text(encoding="utf-8"))
    except Exception as exc:
        outcome.parse_error = f"{type(exc).__name__}: {exc}"
        return outcome

    history = doc.get("history") or []
    outcome.step_count = len(history)
    action_lines: list[str] = []

    for item in history:
        if not isinstance(item, dict):
            continue
        for conv in item.get("conversations") or []:
            if not isinstance(conv, dict):
                continue
            output = conv.get("output_message")
            if not isinstance(output, dict):
                continue
            output_text = _planner_output_text(output)
            if output_text:
                if output.get("is_ultimate_task_done") is True:
                    _apply_done_from_text(outcome, output_text, success=True)
                    action_lines.append(f"planner_done(success=True): {output_text[:300]}")
                else:
                    action_lines.append(f"planner: {output_text[:300]}")

        for action in item.get("executed_actions") or []:
            if not isinstance(action, dict):
                continue
            label = _action_label(action)
            action_lines.append(label)
            outcome.action_events.append(label)
            if "done" in action:
                payload = action.get("done") or {}
                outcome.agent_done_text = _clean(payload.get("text"))
                success = payload.get("success")
                outcome.agent_done_success = bool(success) if success is not None else None
            else:
                for key in action:
                    if key != "done":
                        outcome.action_types.append(key)

        for result in item.get("result") or []:
            if not isinstance(result, dict):
                continue
            extracted = _clean(result.get("extracted_content"))
            parsed = _parse_jsonish_text(extracted)
            if parsed:
                extracted = _planner_output_text(parsed) or extracted
            is_done = result.get("is_done")
            success = result.get("success")
            if is_done is True:
                _apply_done_from_text(outcome, extracted, success=success)
                action_lines.append(f"result_done(success={success}): {extracted[:300]}")
            elif extracted:
                action_lines.append(f"result: {extracted[:300]}")

    outcome.action_summary = "\n".join(action_lines[-40:])
    return outcome


def _criteria_blob(criteria: CaseAcceptanceCriteria) -> str:
    return "\n".join(
        [
            criteria.title,
            criteria.steps_text,
            criteria.expected_text,
            criteria.test_point,
            "\n".join(criteria.milestones),
        ]
    )


def _requires_fresh_submit_flow(criteria: CaseAcceptanceCriteria) -> bool:
    """识别必须按本轮输入+提交完成的生成/发送类 quick 任务。

    这类任务不能用页面已有历史结果或 Agent done 文案代替本轮真实操作。
    """
    blob = _criteria_blob(criteria)
    if not blob:
        return False
    has_input = bool(re.search(r"(输入|填写|填入|录入|提问|提示词|prompt)", blob, re.I))
    has_submit = bool(re.search(r"(提交|生成|发送|发起|创建|开始|运行|执行)", blob, re.I))
    generation_domain = bool(
        re.search(r"(视频生成|图片生成|图像生成|生成视频|生成图片|AI\s*正在回复|可播放|预览视频|生成成功)", blob, re.I)
    )
    return has_input and has_submit and generation_domain


def _has_fresh_submit_flow(outcome: QuickAttemptOutcome) -> tuple[bool, str]:
    """要求动作轨迹里存在输入动作，以及其后的提交/生成/发送类点击或回车。"""
    events = outcome.action_events
    input_indexes = [i for i, event in enumerate(events) if event.startswith("input_text")]
    if not input_indexes:
        return False, "生成/提交类任务未在本轮动作轨迹中发现 input_text 输入动作，不能用历史结果判成功"

    submit_re = re.compile(r"(提交|生成|发送|开始|运行|确认|上箭头|send|submit|generate)", re.I)
    for input_idx in input_indexes:
        for event in events[input_idx + 1 :]:
            if event.startswith("click") and submit_re.search(event):
                return True, ""
            if event.startswith("send_keys") and re.search(r"(enter|return)", event, re.I):
                return True, ""
    return False, "生成/提交类任务已输入但未在输入后发现提交/生成/发送动作，不能判定本次执行成功"


def _quoted_phrases(text: str) -> list[str]:
    found = re.findall(r"[「『\"']([^」』\"']+)[」』\"']", text)
    return [_clean(q) for q in found if len(_clean(q)) >= 2]


def _milestone_fragments(milestone: str) -> list[str]:
    """从步骤句中提取用于验收匹配的短语（引号内容、去噪后的名词片段）。"""
    phrases = list(_quoted_phrases(milestone))
    text = re.sub(r"[「」\"'‘’“”\[\]()（）:：]", "", milestone)
    for prefix in _STEP_NOISE_PREFIXES:
        if text.startswith(prefix):
            text = text[len(prefix) :].strip()
            break
    text = _clean(text)
    if text.startswith("预期"):
        text = text[2:].strip()
    stop = {"按钮", "页面", "输入框", "下拉框", "选项", "区域", "列表", "详情", "名称", "类型"}
    if len(text) >= 2 and text not in stop:
        phrases.append(text)
    # 2~6 字中文片段，便于匹配「问答框」vs「问答输入框」等等价表述
    for frag in re.findall(r"[\u4e00-\u9fff]{2,6}", text):
        if frag not in stop and frag not in phrases:
            phrases.append(frag)
    # 英文/数字词
    for frag in re.findall(r"[a-zA-Z][a-zA-Z0-9_-]{2,}", text):
        phrases.append(frag)
    # 去重保序
    seen: set[str] = set()
    out: list[str] = []
    for p in phrases:
        key = p.lower()
        if key not in seen and len(p) >= 2:
            seen.add(key)
            out.append(p)
    return out


_GENERIC_SUBSTRINGS = frozenset(
    {
        "知识库",
        "管理",
        "界面",
        "页面",
        "按钮",
        "确定",
        "输入",
        "选择",
        "测试",
        "问答",
        "文件",
        "列表",
        "详情",
        "名称",
        "类型",
        "保存",
        "登录",
        "成功",
        "进入",
        "流程",
        "完成",
    }
)


def _fragment_in_evidence(frag: str, ev: str) -> bool:
    f = frag.lower()
    if f in ev:
        return True
    # 复合 UI 词（如「发送按钮」）允许用核心 2~3 字子串匹配，但排除过于泛化的词
    if len(f) >= 4:
        for sublen in (2, 3):
            for i in range(len(f) - sublen + 1):
                sub = f[i : i + sublen]
                if sub in _GENERIC_SUBSTRINGS:
                    continue
                if sub in ev:
                    return True
    return False


def _milestone_met(milestone: str, evidence: str) -> bool:
    ev = evidence.lower()
    ms = milestone.lower()
    if len(ms) >= 4 and ms in ev:
        return True
    fragments = _milestone_fragments(milestone)
    if not fragments:
        return False
    hit = sum(1 for f in fragments if _fragment_in_evidence(f, ev))
    need = max(1, (len(fragments) + 1) // 2)
    return hit >= need


def _expected_assertion_satisfied(expected: str, done_text: str, evidence: str) -> bool:
    expected_l = (expected or "").lower()
    done_l = (done_text or "").lower()
    ev = (evidence or "").lower()
    if not expected_l or not done_l:
        return False

    key_terms = [q.lower() for q in _quoted_phrases(expected) if len(q) >= 2]
    if "引用文件" in expected:
        key_terms.append("引用文件")
    if "命中测试" in expected:
        key_terms.append("命中测试")
    key_terms = list(dict.fromkeys(key_terms))

    negative_expected = bool(
        re.search(r"(不包含|未出现|没有|无|不显示|无召回)", expected_l)
    )
    negative_done = bool(re.search(r"(未出现|没有|不包含|未显示|无)", done_l))
    positive_done = bool(re.search(r"(满足|通过|已出现|显示|返回|成功)", done_l))

    if negative_expected and negative_done:
        if not key_terms or any(term in done_l or term in ev for term in key_terms):
            return True
    if not negative_expected and positive_done:
        if key_terms and all(term in done_l or term in ev for term in key_terms[:3]):
            return True
        expected_core = expected_l[:18].strip()
        if len(expected_core) >= 6 and expected_core in done_l:
            return True
    return False


def _heuristic_validate(criteria: CaseAcceptanceCriteria, outcome: QuickAttemptOutcome) -> CompletionValidation:
    evidence = "\n".join(
        [
            outcome.agent_done_text,
            outcome.action_summary,
            " ".join(outcome.action_types),
        ]
    ).lower()

    milestones = criteria.milestones
    if not milestones and criteria.business_hints:
        milestones = [f"需覆盖：{h}" for h in criteria.business_hints[:6]]

    if not milestones:
        # 无结构化步骤时：要求 done 文案与预期/标题有交集，且不能仅是登录
        expected_blob = f"{criteria.title} {criteria.expected_text} {criteria.test_point}".lower()
        done = outcome.agent_done_text.lower()
        if criteria.expected_text and criteria.expected_text.lower()[:8] not in done and len(done) < 20:
            return CompletionValidation(
                passed=False,
                method="heuristic",
                reason="Agent 结束说明过短，且未体现预期结果关键词",
                agent_done_success=outcome.agent_done_success,
                agent_done_text=outcome.agent_done_text,
            )
        if any(m in done for m in _LOGIN_ONLY_DONE_MARKERS) and not any(
            h.lower() in done for h in criteria.business_hints
        ):
            if criteria.business_hints:
                return CompletionValidation(
                    passed=False,
                    method="heuristic",
                    reason="结束说明仅描述登录/进入页面，未覆盖业务验收点",
                    agent_done_success=outcome.agent_done_success,
                    agent_done_text=outcome.agent_done_text,
                )
        return CompletionValidation(
            passed=True,
            method="heuristic",
            reason="无结构化步骤，Agent 结束说明与用例目标无明显冲突",
            agent_done_success=outcome.agent_done_success,
            agent_done_text=outcome.agent_done_text,
        )

    met: list[str] = []
    missing: list[str] = []
    for ms in milestones:
        if _milestone_met(ms, evidence):
            met.append(ms)
        else:
            missing.append(ms)

    total = len(milestones)
    met_n = len(met)

    if _requires_fresh_submit_flow(criteria):
        fresh_ok, fresh_reason = _has_fresh_submit_flow(outcome)
        if not fresh_ok:
            return CompletionValidation(
                passed=False,
                method="heuristic",
                reason=fresh_reason,
                milestones_total=total,
                milestones_met=met_n,
                missing_milestones=missing[:8],
                agent_done_success=outcome.agent_done_success,
                agent_done_text=outcome.agent_done_text,
            )

    if outcome.agent_done_success is True and _expected_assertion_satisfied(
        criteria.expected_text,
        outcome.agent_done_text,
        evidence,
    ):
        return CompletionValidation(
            passed=True,
            method="heuristic",
            reason="Agent 结束说明已明确覆盖预期结果断言，判定通过",
            milestones_total=total,
            milestones_met=max(met_n, total),
            missing_milestones=[],
            agent_done_success=outcome.agent_done_success,
            agent_done_text=outcome.agent_done_text,
        )

    # 登录即结束：有业务步骤但 done 仅声称登录完成
    if criteria.business_hints and outcome.agent_done_text:
        done_l = outcome.agent_done_text.lower()
        login_only = any(m.lower() in done_l for m in _LOGIN_ONLY_DONE_MARKERS)
        biz_in_done = any(h.lower() in done_l for h in criteria.business_hints)
        if login_only and not biz_in_done and met_n < max(1, total // 2):
            return CompletionValidation(
                passed=False,
                method="heuristic",
                reason="Agent 声称成功但结束说明仅覆盖登录/进入页面，未完成用例业务步骤",
                milestones_total=total,
                milestones_met=met_n,
                missing_milestones=missing[:8],
                agent_done_success=outcome.agent_done_success,
                agent_done_text=outcome.agent_done_text,
            )

    if met_n >= total:
        return CompletionValidation(
            passed=True,
            method="heuristic",
            reason=f"执行轨迹与结束说明已覆盖全部 {total} 条验收步骤/要点",
            milestones_total=total,
            milestones_met=met_n,
            missing_milestones=[],
            agent_done_success=outcome.agent_done_success,
            agent_done_text=outcome.agent_done_text,
        )

    if met_n == 0:
        return CompletionValidation(
            passed=False,
            method="heuristic",
            reason="执行轨迹与结束说明未体现任何一条原始测试步骤",
            milestones_total=total,
            milestones_met=0,
            missing_milestones=missing[:8],
            agent_done_success=outcome.agent_done_success,
            agent_done_text=outcome.agent_done_text,
        )

    # 部分覆盖：交给 LLM 复核
    return CompletionValidation(
        passed=False,
        method="heuristic_partial",
        reason=f"仅覆盖 {met_n}/{total} 条步骤，需 LLM 复核",
        milestones_total=total,
        milestones_met=met_n,
        missing_milestones=missing[:8],
        agent_done_success=outcome.agent_done_success,
        agent_done_text=outcome.agent_done_text,
    )


def _parse_llm_json(text: str) -> dict[str, Any]:
    text = text.strip()
    fence = re.search(r"```(?:json)?\s*([\s\S]*?)```", text)
    if fence:
        text = fence.group(1).strip()
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        m = re.search(r"\{[\s\S]*\}", text)
        if m:
            return json.loads(m.group(0))
        raise


def _get_validation_llm() -> Any:
    from browser_use.agent.chat_models import build_models

    default_model = "qwen3.7-plus"

    def env_model(key: str, fallback: str) -> str:
        value = (os.environ.get(key) or "").strip()
        return value if value else fallback

    dm = env_model("BU_PAGE_EXTRACTION_LLM", default_model)
    _, _, _, aux = build_models(
        actor=env_model("BU_ACTOR_MODEL", dm),
        planner=env_model("BU_PLANNER_MODEL", dm),
        asserter=env_model("BU_ASSERTER_MODEL", dm),
        page_extraction_llm=env_model("BU_PAGE_EXTRACTION_LLM", dm),
        locating_llm=env_model("BU_LOCATING_LLM", dm),
        coding_llm=env_model("BU_CODING_LLM", dm),
    )
    llm = aux.get("page_extraction_llm")
    if llm is None:
        raise RuntimeError("page_extraction_llm 不可用，无法执行 quick 完成度 LLM 验收")
    return llm


async def _llm_validate_async(
    *,
    criteria: CaseAcceptanceCriteria,
    outcome: QuickAttemptOutcome,
    partial: CompletionValidation,
) -> CompletionValidation:
    from langchain_core.messages import HumanMessage, SystemMessage

    llm = _get_validation_llm()
    system = (
        "你是 UI 自动化测试验收裁判。只输出一个 JSON 对象，不要 markdown。\n"
        "字段：passed(bool), reason(str), completed_items(list[str]), missing_items(list[str])。\n"
        "规则：\n"
        "1. 对照「原始用例标题、测试步骤、预期结果」判断浏览器 Agent 是否真正完成业务验收，而不是只完成登录/进入首页。\n"
        "2. 若 Agent done 仅描述登录成功、进入管理页，但用例要求新建库/问答/上传/命中测试等，必须 passed=false。\n"
        "3. 预期结果中的断言必须在执行轨迹或 done 说明中有可观察证据。\n"
        "4. 不要因步骤表述差异否定合理等价操作（如「参数设置」与「设置」）。"
    )
    user = (
        f"用例标题：{criteria.title}\n"
        f"测试点：{criteria.test_point}\n"
        f"测试步骤：{criteria.steps_text}\n"
        f"预期结果：{criteria.expected_text}\n\n"
        f"Agent done(success={outcome.agent_done_success})：{outcome.agent_done_text}\n\n"
        f"执行动作摘要（最近）：\n{outcome.action_summary[:3500]}\n\n"
        f"启发式预检：已覆盖 {partial.milestones_met}/{partial.milestones_total} 条，"
        f"缺失：{'; '.join(partial.missing_milestones[:6])}\n\n"
        "请输出 JSON："
    )
    msg = await llm.ainvoke([SystemMessage(content=system), HumanMessage(content=user)])
    raw = str(getattr(msg, "content", ""))
    try:
        data = _parse_llm_json(raw)
    except Exception as exc:
        return CompletionValidation(
            passed=False,
            method="llm_parse_error",
            reason=f"验收 LLM 输出无法解析，沿用启发式结论：{partial.reason}（{type(exc).__name__}）",
            milestones_total=partial.milestones_total,
            milestones_met=partial.milestones_met,
            missing_milestones=partial.missing_milestones,
            agent_done_success=outcome.agent_done_success,
            agent_done_text=outcome.agent_done_text,
        )

    passed = bool(data.get("passed"))
    reason = _clean(data.get("reason")) or partial.reason
    missing = data.get("missing_items") or partial.missing_milestones
    if isinstance(missing, list):
        missing = [_clean(x) for x in missing if _clean(x)][:8]
    else:
        missing = partial.missing_milestones

    return CompletionValidation(
        passed=passed,
        method="llm",
        reason=reason,
        milestones_total=partial.milestones_total,
        milestones_met=partial.milestones_met,
        missing_milestones=missing,
        agent_done_success=outcome.agent_done_success,
        agent_done_text=outcome.agent_done_text,
    )


def _should_skip_validation() -> bool:
    return os.environ.get("QUICK_SKIP_COMPLETION_VALIDATE", "").strip().lower() in {
        "1",
        "true",
        "yes",
    }


def validate_quick_attempt(
    record: Any,
    attempt_log_dir: Path,
    *,
    returncode: int,
    dry_run: bool = False,
    use_llm: bool = True,
) -> CompletionValidation:
    """对单轮 quick 做完成度二次验收。"""
    if dry_run or _should_skip_validation():
        return CompletionValidation(
            passed=True,
            method="skipped",
            reason="dry-run 或已设置 QUICK_SKIP_COMPLETION_VALIDATE",
        )

    outcome = parse_quick_attempt_outcome(attempt_log_dir, returncode=returncode)
    if returncode != 0:
        return CompletionValidation(
            passed=False,
            method="cli_failed",
            reason=f"browser-use CLI returncode={returncode}",
            agent_done_success=outcome.agent_done_success,
            agent_done_text=outcome.agent_done_text,
        )

    if outcome.agent_done_success is False:
        return CompletionValidation(
            passed=False,
            method="agent_failed",
            reason=f"Agent done(success=false)：{outcome.agent_done_text[:500]}",
            agent_done_success=False,
            agent_done_text=outcome.agent_done_text,
        )

    if outcome.parse_error:
        return CompletionValidation(
            passed=False,
            method="parse_error",
            reason=outcome.parse_error,
            agent_done_success=outcome.agent_done_success,
            agent_done_text=outcome.agent_done_text,
        )

    criteria = criteria_from_record(record)
    partial = _heuristic_validate(criteria, outcome)

    if partial.method == "heuristic" and partial.passed:
        return partial
    if partial.method == "heuristic" and not partial.passed and partial.milestones_met == 0:
        return partial

    if not use_llm:
        partial.method = "heuristic"
        partial.passed = partial.milestones_met >= partial.milestones_total and partial.milestones_total > 0
        if not partial.passed and partial.reason.endswith("需 LLM 复核"):
            partial.reason = partial.reason.replace("需 LLM 复核", "未启用 LLM 复核")
        return partial

    try:
        return asyncio.run(
            _llm_validate_async(criteria=criteria, outcome=outcome, partial=partial)
        )
    except Exception as exc:
        partial.method = "llm_error"
        if partial.milestones_met == 0:
            partial.passed = False
            partial.reason = f"验收 LLM 不可用，启发式判定未通过：{partial.reason}（{type(exc).__name__}: {exc}）"
        else:
            # 部分覆盖且 LLM 失败：保守判失败
            partial.passed = False
            partial.reason = (
                f"验收 LLM 失败，且仅覆盖 {partial.milestones_met}/{partial.milestones_total} 条步骤："
                f"{partial.reason}（{type(exc).__name__}）"
            )
        return partial


def write_validation_artifact(attempt_log_dir: Path, validation: CompletionValidation) -> Path:
    path = attempt_log_dir / "completion_validation.json"
    path.write_text(json.dumps(validation.to_dict(), ensure_ascii=False, indent=2), encoding="utf-8")
    md = attempt_log_dir / "completion_validation.md"
    lines = [
        "# Quick 完成度二次验收",
        "",
        f"- **通过**：{'是' if validation.passed else '否'}",
        f"- **方法**：{validation.method}",
        f"- **说明**：{validation.reason}",
    ]
    if validation.milestones_total:
        lines.append(f"- **步骤覆盖**：{validation.milestones_met}/{validation.milestones_total}")
    if validation.missing_milestones:
        lines.append("- **未覆盖要点**：")
        for m in validation.missing_milestones:
            lines.append(f"  - {m}")
    if validation.agent_done_text:
        lines.extend(["", "## Agent 结束说明", validation.agent_done_text])
    md.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return path
