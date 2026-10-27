"""
探索黑名单：结构化匹配 + 可选自然语言语义匹配（LLM）。
"""
from __future__ import annotations

import hashlib
import json
import logging
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Literal

from recursive_exploration.layout_context import layout_hints_for_element

logger = logging.getLogger(__name__)

Scope = Literal["all", "single_step", "composite_only"]

# 与仓库 layout 一致：技能根下统一放 ``config/skip_rules.json``（可与 ``skip_rules.example.json`` 对照编辑）
DEFAULT_SKIP_RULES_FILENAME = "skip_rules.json"
DEFAULT_SKIP_RULES_SUBDIR = "config"


def resolve_skip_rules_path(explicit: str | None, skill_root: Path | None) -> str | None:
    """
    解析黑名单文件路径。

    - 若 ``explicit`` 非空：使用该路径（显式覆盖）。
    - 否则若 ``skill_root`` 非空且存在 ``{skill_root}/config/skip_rules.json``：使用该文件。
    - 否则返回 None（不启用黑名单）。
    """
    if explicit is not None and str(explicit).strip():
        p = Path(explicit).expanduser()
        return str(p.resolve() if p.exists() else p)
    if skill_root is None:
        return None
    default_file = Path(skill_root).expanduser().resolve() / DEFAULT_SKIP_RULES_SUBDIR / DEFAULT_SKIP_RULES_FILENAME
    if default_file.is_file():
        return str(default_file)
    return None


@dataclass
class SkipRule:
    id: str
    reason: str = ""
    scope: Scope = "all"
    label_regex: str | None = None
    selector_regex: str | None = None
    url_regex: str | None = None
    action_fingerprint_prefix: str | None = None
    semantic_description: str | None = None
    _compiled_label: re.Pattern[str] | None = field(default=None, repr=False)
    _compiled_selector: re.Pattern[str] | None = field(default=None, repr=False)
    _compiled_url: re.Pattern[str] | None = field(default=None, repr=False)

    def __post_init__(self) -> None:
        if self.label_regex:
            self._compiled_label = re.compile(self.label_regex, re.I)
        if self.selector_regex:
            self._compiled_selector = re.compile(self.selector_regex, re.I)
        if self.url_regex:
            self._compiled_url = re.compile(self.url_regex, re.I)


def load_skip_rules_from_path(path: str | Path | None) -> list[SkipRule]:
    if not path:
        return []
    p = Path(path).expanduser()
    if not p.is_file():
        logger.warning("skip_rules 文件不存在: %s", p)
        return []
    try:
        raw = p.read_text(encoding="utf-8")
    except OSError as e:
        logger.warning("skip_rules 读取失败: %s", e)
        return []
    try:
        if p.suffix.lower() in (".yaml", ".yml"):
            try:
                import yaml  # type: ignore[import-not-found]

                data = yaml.safe_load(raw)
            except ImportError:
                logger.warning("skip_rules YAML 需要 PyYAML，尝试按 JSON 解析: %s", p)
                data = json.loads(raw)
        else:
            data = json.loads(raw)
    except Exception as e:
        logger.warning("skip_rules 解析失败: %s", e)
        return []
    if not data:
        return []
    if isinstance(data, dict) and "skip_rules" in data:
        data = data["skip_rules"]
    if not isinstance(data, list):
        return []
    out: list[SkipRule] = []
    for i, item in enumerate(data):
        if not isinstance(item, dict):
            continue
        rid = str(item.get("id") or f"rule_{i}")
        reason = str(item.get("reason") or "")
        scope = str(item.get("scope") or "all")
        if scope not in ("all", "single_step", "composite_only"):
            scope = "all"
        out.append(
            SkipRule(
                id=rid,
                reason=reason,
                scope=scope,  # type: ignore[arg-type]
                label_regex=(str(item["label_regex"]).strip() if item.get("label_regex") else None),
                selector_regex=(str(item["selector_regex"]).strip() if item.get("selector_regex") else None),
                url_regex=(str(item["url_regex"]).strip() if item.get("url_regex") else None),
                action_fingerprint_prefix=(
                    str(item["action_fingerprint_prefix"]).strip()
                    if item.get("action_fingerprint_prefix")
                    else None
                ),
                semantic_description=(
                    str(item["semantic_description"]).strip()
                    if item.get("semantic_description")
                    else None
                ),
            )
        )
    return out


def build_candidate_summary(
    *,
    url: str,
    page_title: str,
    tap_description: str,
    locate_prompt: str,
    selector_hint: str,
    action_fingerprint: str,
    tag_name: str,
    action_kind: str,
    el: Any | None,
    viewport_width: float,
    viewport_height: float,
) -> dict[str, Any]:
    summary: dict[str, Any] = {
        "current_url": url[:500],
        "page_title": (page_title or "")[:200],
        "tap_description": (tap_description or "")[:300],
        "locate_prompt": (locate_prompt or "")[:300],
        "selector_hint": (selector_hint or "")[:200],
        "action_fingerprint_prefix": (action_fingerprint or "")[:80],
        "tag_name": tag_name,
        "action_kind": action_kind,
    }
    if el is not None and viewport_width > 1 and viewport_height > 1:
        try:
            hints = layout_hints_for_element(el, viewport_width, viewport_height)
            summary["viewport_quadrant"] = hints.quadrant
            summary["layout_zone_id"] = hints.zone_id
            summary["is_left_rail"] = hints.is_left_rail
            summary["is_top_bar"] = hints.is_top_bar
            summary["is_right_cluster"] = hints.is_right_cluster
        except Exception:
            pass
    return summary


def summary_cache_key(summary: dict[str, Any], rule_id: str) -> str:
    payload = json.dumps({"r": rule_id, "s": summary}, ensure_ascii=False, sort_keys=True)
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()[:20]


def match_skip_rule_structured(
    rule: SkipRule,
    *,
    url: str,
    text_blob: str,
    selector_hint: str,
    fingerprint: str,
) -> bool:
    """不含语义；任一已配置维度命中即 True。"""
    if rule.action_fingerprint_prefix and fingerprint.startswith(rule.action_fingerprint_prefix):
        return True
    if rule._compiled_url and rule._compiled_url.search(url or ""):
        return True
    if rule._compiled_label and rule._compiled_label.search(text_blob or ""):
        return True
    if rule._compiled_selector and rule._compiled_selector.search(selector_hint or ""):
        return True
    return False


async def match_semantic_description(
    llm: Any | None,
    *,
    user_description: str,
    candidate_summary: dict[str, Any],
) -> Literal["match", "no_match", "uncertain"]:
    """
    返回 match / no_match / uncertain。无 llm 时返回 uncertain。
    """
    if llm is None or not (user_description or "").strip():
        return "uncertain"
    try:
        from langchain_core.messages import HumanMessage, SystemMessage
    except ImportError:
        return "uncertain"

    system = (
        "你是 UI 探索黑名单助手。用户用自然语言描述要禁止点击/探索的界面区域或控件类型。\n"
        "你会收到一个 JSON：当前页面 URL、标题、候选控件摘要（含视口方位 quadrant、是否左栏 is_left_rail 等）。\n"
        "请判断该候选控件是否属于用户描述所指对象。\n"
        "只输出一行 JSON，格式严格为："
        '{"decision":"match"|"no_match"|"uncertain"}'
        "\n不要其它文字。"
    )
    user = (
        f"用户黑名单描述：{user_description}\n\n"
        f"候选控件摘要 JSON：\n{json.dumps(candidate_summary, ensure_ascii=False)[:6000]}"
    )
    try:
        msg = await llm.ainvoke([SystemMessage(content=system), HumanMessage(content=user)])
        content = getattr(msg, "content", None)
        raw = str(content or "").strip()
        m = re.search(r"\{[^{}]*\}", raw)
        if m:
            raw = m.group(0)
        obj = json.loads(raw)
        d = str(obj.get("decision", "")).lower().strip()
        if d == "match":
            return "match"
        if d == "no_match":
            return "no_match"
        return "uncertain"
    except Exception as e:  # pragma: no cover
        logger.debug("semantic blacklist LLM 失败: %s", e)
        return "uncertain"


class ActionSkipEvaluator:
    """入队前黑名单判定（结构化同步 + 语义异步）。"""

    def __init__(
        self,
        rules: list[SkipRule],
        *,
        uncertain_policy: Literal["allow", "skip"] = "allow",
    ) -> None:
        self.rules = rules
        self.uncertain_policy = uncertain_policy
        self._semantic_cache: dict[str, Literal["match", "no_match", "uncertain"]] = {}

    def applies_scope(self, rule: SkipRule, task_kind: str) -> bool:
        if rule.scope == "all":
            return True
        if rule.scope == "single_step" and task_kind == "single":
            return True
        if rule.scope == "composite_only" and task_kind == "composite":
            return True
        return False

    async def evaluate(
        self,
        *,
        url: str,
        page_title: str,
        tap_description: str,
        locate_prompt: str,
        selector_hint: str,
        fingerprint: str,
        tag_name: str,
        action_kind: str,
        el: Any | None,
        viewport_width: float,
        viewport_height: float,
        task_kind: str,
        llm: Any | None,
    ) -> tuple[str | None, str | None, str | None]:
        """
        返回 (rule_id, reason, match_kind) 或 (None, None, None) 表示不跳过。
        match_kind: structured | semantic
        """
        text_blob = f"{tap_description}\n{locate_prompt}"
        for rule in self.rules:
            if not self.applies_scope(rule, task_kind):
                continue
            if match_skip_rule_structured(
                rule,
                url=url,
                text_blob=text_blob,
                selector_hint=selector_hint,
                fingerprint=fingerprint,
            ):
                return rule.id, rule.reason or "structured_rule", "structured"

            sem = (rule.semantic_description or "").strip()
            if sem:
                summary = build_candidate_summary(
                    url=url,
                    page_title=page_title,
                    tap_description=tap_description,
                    locate_prompt=locate_prompt,
                    selector_hint=selector_hint,
                    action_fingerprint=fingerprint,
                    tag_name=tag_name,
                    action_kind=action_kind,
                    el=el,
                    viewport_width=viewport_width,
                    viewport_height=viewport_height,
                )
                ck = summary_cache_key(summary, rule.id)
                if ck in self._semantic_cache:
                    verdict = self._semantic_cache[ck]
                else:
                    verdict = await match_semantic_description(
                        llm, user_description=sem, candidate_summary=summary
                    )
                    self._semantic_cache[ck] = verdict
                if verdict == "match":
                    return rule.id, rule.reason or sem[:120], "semantic"
                if verdict == "uncertain" and self.uncertain_policy == "skip":
                    return rule.id, f"semantic_uncertain_skip:{rule.id}", "semantic"
        return None, None, None
