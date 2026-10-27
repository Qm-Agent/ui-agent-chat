from __future__ import annotations

import asyncio
import dataclasses
import json
import logging
import shutil
import sys
import time
import re
import uuid
from collections import deque
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Literal

from browser_use.browser.browser import Browser, BrowserConfig
from browser_use.browser.context import BrowserContext, BrowserContextConfig
from browser_use.browser.views import BrowserState

from recursive_exploration.action_skip import (
    ActionSkipEvaluator,
    load_skip_rules_from_path,
    resolve_skip_rules_path,
)
from recursive_exploration.config import ExplorationRunConfig
from recursive_exploration.relaxed_browser_context import RelaxedLoadBrowserContext
from recursive_exploration.composite_planner import (
    load_prior_dedupe_keys,
    plan_composite_tasks_for_anchor,
    plan_graph_guided_composite_tasks,
)
from recursive_exploration.dedupe import DedupeStore, SkipReason
from recursive_exploration.fingerprints import (
    actionable_signature_from_hashes,
    canonical_prefix_steps_json,
    css_selector_skeleton,
    dedupe_action_key,
    dedupe_path_key,
    dedupe_url_key,
    element_fingerprint,
    normalize_url,
    page_state_id,
    site_key_from_url,
    stable_hash,
    structural_state_id,
    text_overlap_ratio,
    url_equivalence_key,
)
from recursive_exploration.graph_store import GraphStore
from recursive_exploration.models import (
    ActionKind,
    ActionTask,
    BootstrapResult,
    ExplorationEvent,
    ExplorationStep,
    GraphEdgeRecord,
    GraphNodeRecord,
    StartContext,
    UrlTask,
)
from recursive_exploration.bootstrap import run_bootstrap_phase
from recursive_exploration.bootstrap_agent_replay import replay_bootstrap_agent_on_context
from recursive_exploration.intent_mission_exec import (
    replay_intent_mission_quick_cli,
    replay_intent_mission_yaml_on_context,
)
from recursive_exploration.intent_missions import (
    build_intent_action_tasks,
    intent_target_fingerprint,
    plan_intent_mission_continuation_llm,
    plan_intent_missions_llm,
)
from recursive_exploration.report import write_exploration_report
from recursive_exploration.review_report import generate_exploration_review
from recursive_exploration.session_state import (
    CurrentAnchorState,
    exploration_config_from_dict,
    exploration_config_to_dict,
    pending_to_deque,
    read_session_state,
    SessionPayload,
    write_session_state,
)
from recursive_exploration.task_labels import infer_action_tag, step_origin_code
from recursive_exploration.yaml_render import (
    generated_cases_yaml_filename,
    parse_bootstrap_yaml_flow_steps,
    post_action_slow_navigation_hint,
    read_bootstrap_target_overlay,
    write_task_yaml,
    yaml_meta_failed_or_skipped,
    yaml_meta_single_success,
)
from recursive_exploration.input_mock_llm import try_get_page_extraction_llm

logger = logging.getLogger(__name__)


_UNIFIED_AGENT_LOG_FILENAME = "agent_unified.log"


class _UnifiedAgentLogFormatter(logging.Formatter):
    """与 browser_use.logging_config 的展示风格保持一致（截断 browser_use.* 名称尾段）。"""

    def format(self, record: logging.LogRecord) -> str:
        if isinstance(record.name, str) and record.name.startswith("browser_use."):
            record.name = record.name.split(".")[-2]
        return super().format(record)


class _DedupLogRecordFilter(logging.Filter):
    """同一 record 经多个 logger（root / browser_use / recursive_exploration）转发到同一 FileHandler 时去重。

    设计：
    - 只看 ``id(record)``；同一条 LogRecord 第一次写入后，后续再到同一个 handler 直接丢弃。
    - 由于 logging 是线程同步的（Handler 内有锁），单进程内 ``id(record)`` 在写入间隔里足够稳定。
    - 不影响真实重复的两条不同 record（它们 ``id`` 不同）。
    """

    def __init__(self) -> None:
        super().__init__()
        self._last_record_id: int | None = None

    def filter(self, record: logging.LogRecord) -> bool:
        rid = id(record)
        if rid == self._last_record_id:
            return False
        self._last_record_id = rid
        return True


def install_unified_agent_log_handler(out_dir: Path) -> Path:
    """在 ``out_dir`` 下追加一个 ``agent_unified.log``，把递归探索期间所有 UI agent 的 stderr 日志按时间顺序汇总。

    覆盖范围：
    - 根 logger（包含子进程外的一切 logging 输出）
    - ``browser_use``（browser_use 默认 ``propagate=False``，需单独挂 handler）
    - ``recursive_exploration``（本仓库代码）

    设计取舍：
    - 同进程内同路径只挂一次，避免 resume / 重复 ``run()`` 时日志翻倍。
    - 文件名固定，便于 SKILL/文档/排查命令统一引用（``tail -f agent_unified.log``）。
    - 仅追加（``mode='a'``），保留历史；resume 与新 run 可在同目录里串接成一条时间线。
    """
    log_path = (Path(out_dir) / _UNIFIED_AGENT_LOG_FILENAME).resolve()
    log_path.parent.mkdir(parents=True, exist_ok=True)
    target_path_str = str(log_path)

    target_loggers = ("", "browser_use", "recursive_exploration")
    for lg_name in target_loggers:
        lg = logging.getLogger(lg_name)
        for h in lg.handlers:
            if isinstance(h, logging.FileHandler) and getattr(h, "baseFilename", "") == target_path_str:
                return log_path

    fh = logging.FileHandler(log_path, mode="a", encoding="utf-8")
    fh.setLevel(logging.INFO)
    fh.setFormatter(
        _UnifiedAgentLogFormatter("%(asctime)s %(levelname)-7s [%(name)s] %(message)s")
    )
    fh.addFilter(_DedupLogRecordFilter())
    for lg_name in target_loggers:
        target_logger = logging.getLogger(lg_name)
        target_logger.addHandler(fh)
        if target_logger.level == logging.NOTSET or target_logger.level > logging.INFO:
            target_logger.setLevel(logging.INFO)

    logging.getLogger("recursive_exploration").info(
        "===== agent_unified.log 启动 path=%s ts=%s =====",
        log_path,
        _ts(),
    )
    return log_path


def _ts() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def _node_id(url_norm: str, structural_state_id: str) -> str:
    return "n_" + stable_hash(["node", url_norm, structural_state_id])[:24]


def _observation(state: BrowserState, cfg: ExplorationRunConfig) -> dict[str, Any]:
    url = state.url or ""
    url_norm = normalize_url(
        url,
        strip_trailing_slash=cfg.url_strip_trailing_slash,
        keep_fragment=cfg.url_keep_fragment,
    )
    title = state.title or ""
    sm = state.selector_map or {}
    inview_hashes: list[str] = []
    landmark_chunks: list[str] = []
    indices: list[int] = []
    for idx in sorted(sm.keys()):
        el = sm[idx]
        if not el.is_interactive or not el.rectangle:
            continue
        if not getattr(el, "is_in_viewport", False):
            continue
        indices.append(idx)
        inview_hashes.append(el.hash.branch_path_hash)
        try:
            t = el.get_all_text_till_next_clickable_element(max_depth=2)
        except Exception:
            t = ""
        t = re.sub(r"\s+", " ", (t or "").strip())
        if t:
            landmark_chunks.append(t[:80])
    landmark = " | ".join(landmark_chunks[:12])
    struct = structural_state_id(url_norm, title, landmark)
    sig = actionable_signature_from_hashes(sorted(set(inview_hashes)))
    ps = page_state_id(struct, sig)
    out: dict[str, Any] = {
        "url": url,
        "url_norm": url_norm,
        "title": title,
        "structural_state_id": struct,
        "actionable_signature": sig,
        "page_state_id": ps,
        "inview_indices": indices,
        "selector_map": sm,
    }
    if cfg.extended_observation:
        out.update(_observation_extensions(state))
    return out


def _observation_extensions(state: BrowserState) -> dict[str, Any]:
    """启发式扩展摘要（不增加额外异步 round-trip）。"""
    sm = state.selector_map or {}
    dialog_like = 0
    tab_like = 0
    headers: list[str] = []
    form_labels: list[str] = []
    sub = ""
    if state.title:
        parts = re.split(r"[\|\-–—:/]", state.title, maxsplit=3)
        if len(parts) >= 2:
            sub = parts[-1].strip()[:120]
    for idx in sorted(sm.keys())[:80]:
        el = sm[idx]
        if not el.rectangle:
            continue
        tag = (el.tag_name or "").lower()
        attrs = el.attributes or {}
        cls = " ".join(attrs.get("class") or []) if isinstance(attrs.get("class"), list) else str(attrs.get("class") or "")
        role = str(attrs.get("role") or "").lower()
        if role in ("dialog", "alertdialog") or "modal" in cls.lower():
            dialog_like += 1
        if role == "tab" or "tab" in cls.lower():
            tab_like += 1
        if tag in ("th",):
            try:
                t = el.get_all_text_till_next_clickable_element(max_depth=1)
            except Exception:
                t = ""
            t = re.sub(r"\s+", " ", (t or "").strip())
            if t:
                headers.append(t[:60])
        if tag in ("label", "legend"):
            try:
                t = el.get_all_text_till_next_clickable_element(max_depth=1)
            except Exception:
                t = ""
            t = re.sub(r"\s+", " ", (t or "").strip())
            if t:
                form_labels.append(t[:80])
    return {
        "obs_heading_line": sub,
        "obs_breadcrumb": "",
        "obs_tab_summary": f"tabs_like={tab_like}",
        "obs_overlay_hint": f"dialog_like={dialog_like}",
        "obs_table_headers": " | ".join(headers[:16]),
        "obs_form_sections": " | ".join(form_labels[:12]),
    }


def _candidates_audit(state: BrowserState, cfg: ExplorationRunConfig) -> list[dict[str, Any]]:
    sm = state.selector_map or {}
    out: list[dict[str, Any]] = []
    seen_resolved_idx: set[int] = set()
    for idx in sorted(sm.keys()):
        el = sm[idx]
        if not el.is_interactive or not el.rectangle:
            continue
        el_u, idx_u = _resolve_text_input_for_task(el, idx, sm)
        if idx_u in seen_resolved_idx:
            continue
        seen_resolved_idx.add(idx_u)
        inv = bool(getattr(el_u, "is_in_viewport", False))
        if not cfg.record_offviewport_candidates and not inv:
            continue
        bh = el_u.hash.branch_path_hash
        ak = _action_kind_for_element(el_u)
        fp = element_fingerprint(
            idx_u, bh, el_u.tag_name, el_u.attributes or {}, action_kind=ak
        )
        out.append(
            {
                "element_index": idx_u,
                "branch_path_hash": bh,
                "action_fingerprint": fp,
                "action_kind": ak,
                "tap_description": _tap_desc(idx_u, el_u),
                "in_viewport": inv,
            }
        )
    return out


def _log_enumeration_round(
    graph: GraphStore,
    state: BrowserState,
    obs: dict[str, Any],
    *,
    source: str,
    anchor_depth: int,
    cfg: ExplorationRunConfig,
) -> None:
    vf = "all_interactive" if cfg.record_offviewport_candidates else "in_viewport_only"
    graph.append_enumeration(
        anchor_url_norm=obs["url_norm"],
        anchor_depth=anchor_depth,
        page_state_id=obs["page_state_id"],
        source=source,
        viewport_filter=vf,
        candidates=_candidates_audit(state, cfg),
    )


async def _scroll_enumerate(
    ctx: Any,
    cfg: ExplorationRunConfig,
    base_obs: dict[str, Any],
) -> tuple[list[int], dict[int, Any], set[str]]:
    """多轮向下滚动，收集视口外交互元素。

    返回 (额外发现的 indices, 合并后的 selector_map 片段, 已收集的 branch_path_hash 集合)。
    仅在首轮入队阶段调用。
    """
    seen_hashes: set[str] = set()
    for idx in base_obs["inview_indices"]:
        el = base_obs["selector_map"][idx]
        seen_hashes.add(el.hash.branch_path_hash)

    extra_indices: list[int] = []
    extra_sm: dict[int, Any] = {}
    no_new_count = 0
    page = await ctx.get_current_page()

    for _round in range(cfg.scroll_enumerate_max_rounds):
        await page.evaluate(f"window.scrollBy(0, {cfg.scroll_delta_y_px})")
        await asyncio.sleep(cfg.scroll_enumerate_settle_ms / 1000.0)

        state = await ctx.get_state()
        sm = state.selector_map or {}
        found_new = False
        for idx in sorted(sm.keys()):
            el = sm[idx]
            if not el.is_interactive or not el.rectangle:
                continue
            if not getattr(el, "is_in_viewport", False):
                continue
            bh = el.hash.branch_path_hash
            if bh in seen_hashes:
                continue
            seen_hashes.add(bh)
            extra_indices.append(idx)
            extra_sm[idx] = el
            found_new = True

        if found_new:
            no_new_count = 0
        else:
            no_new_count += 1
            if no_new_count >= 2:
                break

    # 恢复到顶部
    await page.evaluate("window.scrollTo(0, 0)")
    await asyncio.sleep(cfg.scroll_enumerate_settle_ms / 1000.0)

    return extra_indices, extra_sm, seen_hashes


def _prefix_steps_summary(steps: list[ExplorationStep], cfg: ExplorationRunConfig) -> list[str]:
    out: list[str] = []
    lim = cfg.prefix_summary_max_steps
    chars = cfg.prefix_summary_max_step_chars
    for s in steps[:lim]:
        t = (s.locate_prompt or s.tap_description or "").strip()
        if len(t) > chars:
            t = t[: chars - 1] + "…"
        out.append(t or f"[{s.element_index}]")
    return out


def _action_task_budget_sample(task: ActionTask, *, max_chars: int = 200) -> dict[str, Any]:
    td = (task.target_description or "")[:max_chars]
    lp = (task.locate_prompt or "")[:max_chars]
    return {
        "task_id": task.task_id,
        "anchor_depth": task.anchor_depth,
        "anchor_url_norm": task.anchor_url_norm,
        "dedupe_path_key": task.dedupe_path_key,
        "action_kind": task.action_kind,
        "target_description": td,
        "locate_prompt": lp,
    }


def _target_step_dict(
    task: ActionTask,
    resolved_index: int | None,
    *,
    input_value_used: str = "",
) -> dict[str, Any]:
    return {
        "kind": task.action_kind,
        "tap_description": task.target_description,
        "locate_prompt": task.locate_prompt,
        "input_value": input_value_used or task.input_mock_value,
        "element_index": resolved_index if resolved_index is not None else task.target_index,
        "branch_path_hash": task.target_branch_path_hash,
    }


def _target_step_dict_intent(task: ActionTask) -> dict[str, Any]:
    return {
        "kind": "intent_mission",
        "intent_ai_steps": list(task.intent_ai_steps),
        "tap_description": task.target_description,
        "locate_prompt": task.locate_prompt,
        "element_index": -1,
        "branch_path_hash": "",
    }


def _atomic_step_result_dict(
    step: ExplorationStep,
    resolved_index: int | None,
    *,
    input_value_used: str = "",
) -> dict[str, Any]:
    return {
        "kind": step.step_kind,
        "tap_description": step.tap_description,
        "locate_prompt": step.locate_prompt,
        "input_value": input_value_used or step.input_value,
        "element_index": resolved_index if resolved_index is not None else step.element_index,
        "branch_path_hash": step.branch_path_hash,
    }


def _synth_from_composite(task: ActionTask) -> ActionTask:
    """组合任务成功后扩队用：折叠为「前缀 + 末步 target」的单步语义 ActionTask。"""
    if task.task_kind != "composite" or not task.composite_steps:
        return task
    body = task.composite_steps
    last = body[-1]
    prefix = list(body[:-1])
    ak: ActionKind = (
        last.step_kind if last.step_kind in ("click", "input", "scroll") else "click"
    )
    return dataclasses.replace(
        task,
        task_kind="single",
        prefix_steps=prefix,
        target_index=last.element_index,
        target_branch_path_hash=last.branch_path_hash,
        target_description=last.tap_description,
        action_kind=ak,
        locate_prompt=last.locate_prompt,
        composite_steps=[],
        composite_plan_id="",
    )


def hydrate_anchor_step_seq_max_by_anchor(events_path: Path) -> dict[str, int]:
    """从已有 ``events.jsonl`` 恢复各 ``anchor_url_norm`` 的最后 ``anchor_step_seq``，便于 resume 续号。"""
    counts: dict[str, int] = {}
    if not events_path.is_file():
        return counts
    try:
        lines = events_path.read_text(encoding="utf-8").splitlines()
    except OSError:
        return counts
    for line in lines:
        line = line.strip()
        if not line:
            continue
        try:
            ev = json.loads(line)
        except json.JSONDecodeError:
            continue
        if ev.get("kind") != "action_result":
            continue
        an = str(ev.get("anchor_url_norm") or "")
        sas = ev.get("anchor_step_seq")
        if isinstance(sas, int) and sas > 0:
            counts[an] = max(counts.get(an, 0), sas)
        else:
            counts[an] = counts.get(an, 0) + 1
    return counts


# --------------- 辅助工具函数：语义祖先攀升、结构路径、CSS 选择器 ---------------

_SEMANTIC_INTERACTIVE_TAGS = {"button", "a", "input", "select", "textarea", "summary"}


def _find_semantic_ancestor(el: Any) -> Any | None:
    """从 bare span/div 向上查找最近的语义化交互祖先（button/a/input 等）。"""
    tag = (getattr(el, "tag_name", None) or "").lower()
    if tag in _SEMANTIC_INTERACTIVE_TAGS:
        return None  # 自身已是语义元素
    current = getattr(el, "parent", None)
    while current is not None:
        ctag = (getattr(current, "tag_name", None) or "").lower()
        if (
            ctag in _SEMANTIC_INTERACTIVE_TAGS
            and getattr(current, "is_interactive", False)
            and getattr(current, "rectangle", None) is not None
        ):
            return current
        current = getattr(current, "parent", None)
    return None


def _get_parent_tag_chain(el: Any, max_depth: int = 6) -> list[str]:
    """沿 parent 链收集 tag_name（从根到叶方向），最多 max_depth 级。"""
    chain: list[str] = []
    cur = el
    while cur is not None and len(chain) < max_depth:
        tn = getattr(cur, "tag_name", None)
        if tn:
            chain.append(tn.lower())
        cur = getattr(cur, "parent", None)
    chain.reverse()
    return chain


def _safe_css_selector(el: Any) -> str:
    """生成 CSS 选择器（复用 browser-use 的 _enhanced_css_selector_for_element）。"""
    try:
        return BrowserContext._enhanced_css_selector_for_element(el)[:200]
    except Exception:
        return ""


def _el_text(el: Any) -> str:
    """安全提取元素可见文本。"""
    try:
        return el.get_all_text_till_next_clickable_element(max_depth=2) or ""
    except Exception:
        return ""


# --------------- 元素描述生成 ---------------

def _tap_desc(idx: int, el: Any) -> str:
    attrs = el.attributes or {}
    tag = (getattr(el, "tag_name", None) or "").lower()
    bits = [tag]
    for k in ("aria-label", "title", "id", "name", "role", "data-testid"):
        v = attrs.get(k)
        if v:
            bits.append(f"{k}={str(v)[:50]}")
    try:
        tx = el.get_all_text_till_next_clickable_element(max_depth=2)
    except Exception:
        tx = ""
    tx = re.sub(r"\s+", " ", (tx or "").strip())[:80]
    if tx:
        bits.append(tx)
    # 若信息太少（仅 tag），尝试语义祖先
    if len(bits) <= 1:
        ancestor = _find_semantic_ancestor(el)
        if ancestor:
            a_attrs = ancestor.attributes or {}
            a_tag = (getattr(ancestor, "tag_name", None) or "").lower()
            bits[0] = a_tag  # 替换 tag 为语义父级
            for k in ("aria-label", "title", "name", "id"):
                v = a_attrs.get(k)
                if v:
                    bits.append(f"{k}={str(v)[:50]}")
                    break
            if len(bits) <= 1:
                try:
                    atx = ancestor.get_all_text_till_next_clickable_element(max_depth=3)
                except Exception:
                    atx = ""
                atx = re.sub(r"\s+", " ", (atx or "").strip())[:80]
                if atx:
                    bits.append(atx)
    return f"[{idx}] " + " ".join(bits)[:220]


def _is_file_input(attrs: dict[str, Any]) -> bool:
    return str((attrs or {}).get("type", "")).lower() == "file"


def _is_text_input_element(el: Any) -> bool:
    tag = (getattr(el, "tag_name", None) or "").lower()
    attrs = el.attributes or {}
    if _is_file_input(attrs):
        return False
    role = str(attrs.get("role", "")).lower()
    if role in ("textbox", "searchbox"):
        return True
    if "contenteditable" in attrs:
        raw = str(attrs.get("contenteditable", "")).lower().strip()
        if raw in ("true", "plaintext-only", "") and tag in (
            "div",
            "span",
            "p",
            "section",
            "main",
            "form",
        ):
            return True
    if tag == "textarea":
        return True
    if tag != "input":
        return False
    typ = str(attrs.get("type", "text") or "text").lower()
    if typ in ("submit", "button", "checkbox", "radio", "hidden", "image", "reset", "file"):
        return False
    return True


def _action_kind_for_element(el: Any) -> Literal["click", "input"]:
    return "input" if _is_text_input_element(el) else "click"


def _dfs_first_text_input_in_subtree(node: Any, *, max_depth: int = 8, _d: int = 0) -> Any | None:
    if node is None or _d > max_depth:
        return None
    for ch in getattr(node, "children", None) or []:
        if not hasattr(ch, "tag_name"):
            continue
        if _is_text_input_element(ch):
            return ch
        found = _dfs_first_text_input_in_subtree(ch, max_depth=max_depth, _d=_d + 1)
        if found is not None:
            return found
    return None


def _first_text_input_among_siblings(el: Any) -> Any | None:
    """label > span(可点) + input 等：在父节点下找兄弟中的文本框。"""
    p = getattr(el, "parent", None)
    if p is None:
        return None
    for ch in getattr(p, "children", None) or []:
        if ch is el or not hasattr(ch, "tag_name"):
            continue
        if _is_text_input_element(ch):
            return ch
        found = _dfs_first_text_input_in_subtree(ch)
        if found is not None:
            return found
    return None


def _resolve_to_text_input_surface(el: Any) -> Any:
    """若可交互节点是包裹层（如 label 内 span），解析到子树/兄弟中第一个可输入表面。"""
    if _is_text_input_element(el):
        return el
    found = _dfs_first_text_input_in_subtree(el)
    if found is not None:
        return found
    found = _first_text_input_among_siblings(el)
    if found is not None:
        return found
    return el


def _resolve_text_input_for_task(el: Any, idx: int, sm: dict[int, Any]) -> tuple[Any, int]:
    """入队/执行与真实 input 索引对齐，避免对 span 发 aiTap 而从未 input_text。"""
    resolved = _resolve_to_text_input_surface(el)
    ri = getattr(resolved, "highlight_index", None)
    if isinstance(ri, int) and ri in sm:
        return sm[ri], ri
    return el, idx


def _locate_prompt_from_element(idx: int, el: Any) -> str:
    """供 YAML aiTap/aiInput 的自然语言定位（不含 [索引] 前缀）。

    分 4 阶段提取信息：
    1. 直接属性（placeholder/aria-label/title/name/id/role/data-testid/href）
    2. 附近文案
    3. 语义祖先攀升（bare span/div → 父级 button/a 的属性和文案）
    4. 结构路径兜底（nav > ul > li 形式）
    """
    attrs = el.attributes or {}
    parts: list[str] = []
    tag = (getattr(el, "tag_name", None) or "").lower()

    # --- Phase 1: 直接属性 ---
    ph = attrs.get("placeholder")
    if ph:
        parts.append(f"占位符「{str(ph)[:50]}」")
    for key in ("aria-label", "title", "name", "id", "role", "data-testid"):
        v = attrs.get(key)
        if v:
            parts.append(f"{key}={str(v)[:36]}")
    href = attrs.get("href")
    if href and tag == "a":
        parts.append(f"链接→{str(href)[:72]}")

    # --- Phase 2: 附近文案 ---
    try:
        tx = el.get_all_text_till_next_clickable_element(max_depth=2)
    except Exception:
        tx = ""
    tx = re.sub(r"\s+", " ", (tx or "").strip())[:90]
    if tx:
        parts.append(f"附近文案「{tx}」")

    # --- Phase 3: 语义祖先攀升（当信息不足时） ---
    effective_tag = tag
    if not parts or (len(parts) == 1 and parts[0].startswith("附近文案")):
        ancestor = _find_semantic_ancestor(el)
        if ancestor:
            effective_tag = (getattr(ancestor, "tag_name", None) or "").lower()
            a_attrs = ancestor.attributes or {}
            for key in ("aria-label", "title", "name", "id", "role", "data-testid"):
                v = a_attrs.get(key)
                if v and f"{key}=" not in " ".join(parts):
                    parts.append(f"父级{effective_tag}.{key}={str(v)[:36]}")
            # 补充父级文案（若自身无文案）
            if not tx:
                try:
                    atx = ancestor.get_all_text_till_next_clickable_element(max_depth=3)
                except Exception:
                    atx = ""
                atx = re.sub(r"\s+", " ", (atx or "").strip())[:90]
                if atx:
                    parts.append(f"附近文案「{atx}」")

    # --- Phase 4: 结构路径兜底 ---
    if not parts:
        chain = _get_parent_tag_chain(el)
        if len(chain) > 1:
            # 取最后 4 级，去掉太通用的 html/body
            meaningful = [t for t in chain if t not in ("html", "body")][-4:]
            if meaningful:
                parts.append(f"位于 {' > '.join(meaningful)}")

    body = " · ".join(parts)
    if body:
        return (f"{effective_tag} " if effective_tag else "") + body[:220]
    return (f"{effective_tag} 可交互控件" if effective_tag else "可交互控件")[:220]


def _score_candidate(el: Any, step: ExplorationStep) -> float:
    """多信号打分：用于 Tier 3 模糊匹配。"""
    score = 0.0
    # tag_name 匹配
    if step.tag_name and (getattr(el, "tag_name", None) or "").lower() == step.tag_name:
        score += 3.0
    # attributes_hash 匹配（属性完全一致，极强信号）
    if step.attributes_hash and getattr(getattr(el, "hash", None), "attributes_hash", "") == step.attributes_hash:
        score += 5.0
    # text_content Jaccard 相似度
    if step.text_content:
        try:
            el_text = re.sub(r"\s+", " ", (el.get_all_text_till_next_clickable_element(max_depth=2) or "").strip())[:100]
        except Exception:
            el_text = ""
        if el_text:
            score += text_overlap_ratio(step.text_content, el_text) * 4.0
    # branch_path_hash 匹配（结构相同）
    if getattr(getattr(el, "hash", None), "branch_path_hash", "") == step.branch_path_hash:
        score += 2.0
    return score


def _resolve_in_scope(
    sm: dict[int, Any],
    step: ExplorationStep,
    candidates: list[int],
) -> int | None:
    """在给定 candidates 范围内执行 Tier 1-3 解析。"""
    # Tier 1: 精确 index + branch_path_hash
    pref = sm.get(step.element_index)
    if pref and step.element_index in candidates:
        if getattr(getattr(pref, "hash", None), "branch_path_hash", "") == step.branch_path_hash:
            return step.element_index

    # Tier 2: branch_path_hash 扫描 + attributes_hash 消歧
    hash_matches = [
        idx for idx in candidates
        if getattr(getattr(sm[idx], "hash", None), "branch_path_hash", "") == step.branch_path_hash
    ]
    if len(hash_matches) == 1:
        return hash_matches[0]
    if len(hash_matches) > 1 and step.attributes_hash:
        for idx in hash_matches:
            if getattr(getattr(sm[idx], "hash", None), "attributes_hash", "") == step.attributes_hash:
                return idx
        return hash_matches[0]
    if hash_matches:
        return hash_matches[0]

    # Tier 3: 多信号打分匹配
    if step.tag_name or step.attributes_hash or step.text_content:
        best_idx, best_score = None, 0.0
        for idx in candidates:
            s = _score_candidate(sm[idx], step)
            if s > best_score:
                best_score = s
                best_idx = idx
        if best_idx is not None and best_score >= 5.0:
            return best_idx

    return None


def _resolve_click_index(
    state: BrowserState,
    step: ExplorationStep,
    *,
    allow_offviewport: bool = False,
) -> int | None:
    """4 级元素解析：Tier 1 精确 → Tier 2 hash扫描+消歧 → Tier 3 多信号打分 → Tier 4 视口外兜底。

    枚举会话与重放会话对同一 DOM 的 ``is_in_viewport`` 标注可能不一致；若仅在「视口内候选」上解析，
    会导致明明同一 index + branch_path_hash 仍可靠却无法命中。因此在视口内失败后：
    先对 ``step.element_index`` 做 hash 一致的直接采纳，再在「全部可交互」集合上复用 Tier 2/3。

    ``allow_offviewport`` 保留兼容；全页兜底已覆盖「仅视口外存在匹配」的场景，该参数不再改变分支。
    """
    _ = allow_offviewport  # noqa: ARG001 — API 兼容
    sm = state.selector_map or {}

    # 视口内候选
    inview = [
        idx for idx in sorted(sm.keys())
        if sm[idx].is_interactive and sm[idx].rectangle and getattr(sm[idx], "is_in_viewport", False)
    ]
    result = _resolve_in_scope(sm, step, inview)
    if result is not None:
        return result

    # 视口漂移：目标下标仍在 selector_map 中且结构 hash 一致，则仍视为命中（不依赖 is_in_viewport）
    pref = sm.get(step.element_index)
    if pref is not None and getattr(pref, "is_interactive", False) and pref.rectangle:
        if getattr(getattr(pref, "hash", None), "branch_path_hash", "") == step.branch_path_hash:
            return step.element_index

    # 全页可交互：Tier2/3 在视口子集上失败时，在全量节点上再找（含仅出现在视口外的 hash）
    all_interactive = [
        idx for idx in sorted(sm.keys())
        if sm[idx].is_interactive and sm[idx].rectangle
    ]
    if sorted(all_interactive) != sorted(inview):
        result = _resolve_in_scope(sm, step, all_interactive)
        if result is not None:
            return result

    # SPA 重渲染：同一控件在两次快照间 branch_path_hash 可能变化；枚举得到的 element_index 通常仍指向同一控件。
    # 在同一下标上做弱信号打分（tag / 文案 / attributes），达到阈值则采纳，避免整批 resolve_failed。
    pref = sm.get(step.element_index)
    if pref is not None and getattr(pref, "is_interactive", False) and pref.rectangle:
        if _score_candidate(pref, step) >= 4.0:
            return step.element_index

    return None


class RecursiveExplorer:
    """基于 browser-use `BrowserContext` 的 DOM 优先递归探索。"""

    def __init__(self, config: ExplorationRunConfig) -> None:
        self.config = config
        self._invocation_config = config
        self._seq = 0
        self._progress_last_mono = 0.0
        self._progress_last_action_count = -1
        self._review_archive_last_mono = 0.0
        self._bootstrap_flow_prefix: list[dict[str, Any]] = []
        self._bootstrap_target_overlay: dict[str, Any] = {}
        self._skip_evaluator: ActionSkipEvaluator | None = None
        self._skip_eval_cache_path: str | None = None
        self._suppress_next_dom_expansion: bool = False
        self._anchor_known_element_fps: set[str] = set()
        self._anchor_skeleton_counts: dict[str, int] = {}
        self._anchor_step_seq_by_norm: dict[str, int] = {}
        self._skip_bootstrap_agent_replay: bool = False
        self._anchor_checkpoint_sink: Any = None
        self._anchor_checkpoint_clear_sink: Any = None

    def _flush_exploration_anchor_checkpoint(
        self,
        *,
        anchor_url: str,
        anchor_norm: str,
        anchor_depth: int,
        queue: deque[ActionTask],
        anchor_ok_actions: int,
        strict_resume_phase: str,
    ) -> None:
        sink = getattr(self, "_anchor_checkpoint_sink", None)
        if callable(sink):
            sink(
                anchor_url=anchor_url,
                anchor_norm=anchor_norm,
                anchor_depth=anchor_depth,
                anchor_ok_actions=anchor_ok_actions,
                strict_resume_phase=strict_resume_phase,
                action_queue=list(queue),
            )

    def _clear_exploration_anchor_checkpoint(self) -> None:
        sink = getattr(self, "_anchor_checkpoint_clear_sink", None)
        if callable(sink):
            sink()

    def _alloc_anchor_step_seq(self, anchor_url_norm: str) -> int:
        """本锚点下一 action_result 的会话内序号（1-based），写入事件与文件名。"""
        k = anchor_url_norm or ""
        n = self._anchor_step_seq_by_norm.get(k, 0) + 1
        self._anchor_step_seq_by_norm[k] = n
        return n

    def _should_skip_bootstrap_replay(self) -> bool:
        """第二轮意图等模式，或入口 bootstrap Agent 重放失败且允许继续探索时：不执行 bootstrap.yaml 的 Agent 重放（仍可使用 bootstrap 中的 cookie/视口覆盖）。"""
        if bool(getattr(self.config, "intent_missions_second_round", False)):
            return True
        return bool(getattr(self, "_skip_bootstrap_agent_replay", False))

    def _ensure_skip_evaluator(self) -> ActionSkipEvaluator | None:
        path = resolve_skip_rules_path(self.config.skip_rules_path, self.config.skill_root)
        if not path:
            return None
        if self._skip_eval_cache_path == path:
            return self._skip_evaluator
        rules = load_skip_rules_from_path(path)
        self._skip_eval_cache_path = path
        if not rules:
            self._skip_evaluator = None
            return None
        self._skip_evaluator = ActionSkipEvaluator(
            rules,
            uncertain_policy=self.config.semantic_blacklist_uncertain,
        )
        return self._skip_evaluator

    def _viewport_dimensions(self) -> tuple[float, float]:
        o = self._bootstrap_target_overlay or {}
        try:
            vw = float(
                o.get("viewportWidth")
                or o.get("viewport_width")
                or self.config.composite_viewport_fallback_width
            )
            vh = float(
                o.get("viewportHeight")
                or o.get("viewport_height")
                or self.config.composite_viewport_fallback_height
            )
            return vw, vh
        except (TypeError, ValueError):
            return (
                float(self.config.composite_viewport_fallback_width),
                float(self.config.composite_viewport_fallback_height),
            )

    def _emit_action_skipped(
        self,
        graph: GraphStore,
        run_id: str,
        *,
        anchor_url_norm: str,
        anchor_depth: int,
        skip_class: str,
        reason: str,
        rule_id: str | None = None,
        match_kind: str | None = None,
        extra: dict[str, Any] | None = None,
    ) -> None:
        ex = dict(extra or {})
        if rule_id:
            ex["rule_id"] = rule_id
        if match_kind:
            ex["match_kind"] = match_kind
        ex["skip_class"] = skip_class
        graph.append_event(
            {
                "schema": "exploration-event/v1",
                "kind": "action_skipped",
                "event_id": "e_skip_" + uuid.uuid4().hex[:14],
                "run_id": run_id,
                "ts": _ts(),
                "anchor_url_norm": anchor_url_norm,
                "anchor_depth": anchor_depth,
                "result": "skipped",
                "skip_reason": reason,
                "extra": ex,
            }
        )

    async def _should_skip_blacklist_for_target(
        self,
        graph: GraphStore,
        obs: dict[str, Any],
        *,
        run_id: str,
        anchor_norm: str,
        anchor_depth: int,
        idx: int,
        el: Any,
        fp: str,
        action_kind: str,
        stats: dict[str, Any],
        phase: str,
    ) -> bool:
        ev = self._ensure_skip_evaluator()
        if ev is None:
            return False
        need_llm = any((r.semantic_description or "").strip() for r in ev.rules)
        llm = try_get_page_extraction_llm() if need_llm else None
        vw, vh = self._viewport_dimensions()
        title = str(obs.get("title") or "")
        url = str(obs.get("url") or "")
        rid, reason, mk = await ev.evaluate(
            url=url,
            page_title=title,
            tap_description=_tap_desc(idx, el),
            locate_prompt=_locate_prompt_from_element(idx, el),
            selector_hint=_safe_css_selector(el),
            fingerprint=fp,
            tag_name=(getattr(el, "tag_name", None) or "").lower(),
            action_kind=action_kind,
            el=el,
            viewport_width=vw,
            viewport_height=vh,
            task_kind="single",
            llm=llm,
        )
        if not rid:
            return False
        stats["skip_blacklist_hits"] = stats.get("skip_blacklist_hits", 0) + 1
        if mk == "semantic":
            stats["skip_blacklist_semantic_hits"] = stats.get("skip_blacklist_semantic_hits", 0) + 1
        else:
            stats["skip_blacklist_structured_hits"] = stats.get("skip_blacklist_structured_hits", 0) + 1
        self._emit_action_skipped(
            graph,
            run_id,
            anchor_url_norm=anchor_norm,
            anchor_depth=anchor_depth,
            skip_class="blacklist",
            reason=reason or rid,
            rule_id=rid,
            match_kind=mk,
            extra={"phase": phase, "element_index": idx},
        )
        return True

    async def _filter_composite_tasks_blacklist(
        self,
        tasks: list[ActionTask],
        obs: dict[str, Any] | None,
        graph: GraphStore,
        run_id: str,
        anchor_norm: str,
        anchor_depth: int,
        stats: dict[str, Any],
    ) -> list[ActionTask]:
        ev = self._ensure_skip_evaluator()
        if ev is None or not tasks:
            return tasks
        need_llm = any((r.semantic_description or "").strip() for r in ev.rules)
        llm = try_get_page_extraction_llm() if need_llm else None
        vw, vh = self._viewport_dimensions()
        url = str((obs or {}).get("url") or "")
        title = str((obs or {}).get("title") or "")
        sm = (obs or {}).get("selector_map") or {}
        kept: list[ActionTask] = []
        for t in tasks:
            if t.task_kind != "composite":
                kept.append(t)
                continue
            blocked = False
            for step in t.composite_steps or []:
                if step.step_kind == "scroll":
                    continue
                idx = int(step.element_index)
                el = sm.get(idx) if isinstance(sm, dict) else None
                attrs = el.attributes if el is not None else {}
                tag_n = (getattr(el, "tag_name", None) or step.tag_name or "div").lower()
                fp = (
                    element_fingerprint(idx, step.branch_path_hash, tag_n, attrs or {}, action_kind=step.step_kind)
                    if el is not None
                    else stable_hash(["fp_fallback", step.branch_path_hash, str(idx)])
                )
                tap = step.tap_description or ""
                loc = step.locate_prompt or ""
                rid, reason, mk = await ev.evaluate(
                    url=url,
                    page_title=title,
                    tap_description=tap,
                    locate_prompt=loc,
                    selector_hint="",
                    fingerprint=fp,
                    tag_name=tag_n,
                    action_kind=step.step_kind,
                    el=el,
                    viewport_width=vw,
                    viewport_height=vh,
                    task_kind="composite",
                    llm=llm,
                )
                if rid:
                    blocked = True
                    stats["skip_blacklist_hits"] = stats.get("skip_blacklist_hits", 0) + 1
                    if mk == "semantic":
                        stats["skip_blacklist_semantic_hits"] = stats.get(
                            "skip_blacklist_semantic_hits", 0
                        ) + 1
                    else:
                        stats["skip_blacklist_structured_hits"] = stats.get(
                            "skip_blacklist_structured_hits", 0
                        ) + 1
                    self._emit_action_skipped(
                        graph,
                        run_id,
                        anchor_url_norm=anchor_norm,
                        anchor_depth=anchor_depth,
                        skip_class="blacklist",
                        reason=reason or rid,
                        rule_id=rid,
                        match_kind=mk,
                        extra={
                            "phase": "composite_enqueue",
                            "task_id": t.task_id,
                            "composite_plan_id": t.composite_plan_id,
                        },
                    )
                    break
            if not blocked:
                kept.append(t)
        return kept

    def _overlay_cli_config_on_resume(self, restored: ExplorationRunConfig) -> ExplorationRunConfig:
        """续跑时 session 快照会覆盖 CLI：用本次命令行传入的 config 覆盖预算与可调开关。"""
        inv = self._invocation_config
        return dataclasses.replace(
            restored,
            exploration_depth=inv.exploration_depth,
            max_actions=inv.max_actions,
            max_total_actions=inv.max_total_actions,
            max_new_urls=inv.max_new_urls,
            composite_checkpoint_every_single_successes=inv.composite_checkpoint_every_single_successes,
            yaml_policy=inv.yaml_policy,
            execution_mode=inv.execution_mode,
            headless=inv.headless,
            use_llm_for_input_mock=inv.use_llm_for_input_mock,
            composite_enabled=inv.composite_enabled,
            prior_graph_path=inv.prior_graph_path or restored.prior_graph_path,
            incremental_composite_mode=inv.incremental_composite_mode,
            strict_phase_traversal=inv.strict_phase_traversal,
            bootstrap_task_file=inv.bootstrap_task_file or restored.bootstrap_task_file,
            bootstrap_description=inv.bootstrap_description or restored.bootstrap_description,
            bootstrap_abort_on_failure=inv.bootstrap_abort_on_failure,
            replay_bootstrap_on_resume=inv.replay_bootstrap_on_resume,
            embed_bootstrap_in_generated_yaml=inv.embed_bootstrap_in_generated_yaml,
            bootstrap_same_session=inv.bootstrap_same_session,
            skill_root=inv.skill_root if inv.skill_root is not None else restored.skill_root,
            extended_observation=inv.extended_observation,
            scroll_enumerate_enabled=inv.scroll_enumerate_enabled,
            scroll_enumerate_max_rounds=inv.scroll_enumerate_max_rounds,
            scroll_enumerate_settle_ms=inv.scroll_enumerate_settle_ms,
            graph_guided_composite_enabled=inv.graph_guided_composite_enabled,
            graph_guided_composite_max_hops=inv.graph_guided_composite_max_hops,
            composite_coherence_enabled=inv.composite_coherence_enabled,
            composite_coherence_mode=inv.composite_coherence_mode,
            composite_coherence_llm_enabled=inv.composite_coherence_llm_enabled,
            composite_viewport_fallback_width=inv.composite_viewport_fallback_width,
            composite_viewport_fallback_height=inv.composite_viewport_fallback_height,
            skip_rules_path=inv.skip_rules_path,
            semantic_blacklist_uncertain=inv.semantic_blacklist_uncertain,
            intent_missions_enabled=inv.intent_missions_enabled or restored.intent_missions_enabled,
            intent_mission_max_per_anchor=max(
                inv.intent_mission_max_per_anchor, restored.intent_mission_max_per_anchor
            ),
            intent_mission_phase=inv.intent_mission_phase,
            intent_mission_suppress_dom_expand=(
                inv.intent_mission_suppress_dom_expand or restored.intent_mission_suppress_dom_expand
            ),
            intent_mission_max_ai_steps=max(
                inv.intent_mission_max_ai_steps, restored.intent_mission_max_ai_steps
            ),
            intent_mission_max_step_chars=max(
                inv.intent_mission_max_step_chars, restored.intent_mission_max_step_chars
            ),
            intent_missions_replace_composite_planners=(
                inv.intent_missions_replace_composite_planners
                or restored.intent_missions_replace_composite_planners
            ),
            intent_missions_execution_only=(
                inv.intent_missions_execution_only or restored.intent_missions_execution_only
            ),
            intent_missions_second_round=(
                inv.intent_missions_second_round or restored.intent_missions_second_round
            ),
            intent_mission_reserved_actions=inv.intent_mission_reserved_actions,
            intent_mission_synthesize_when_empty=inv.intent_mission_synthesize_when_empty,
            intent_mission_continuation_rounds=max(
                inv.intent_mission_continuation_rounds, restored.intent_mission_continuation_rounds
            ),
            intent_mission_continuation_max_steps=max(
                inv.intent_mission_continuation_max_steps, restored.intent_mission_continuation_max_steps
            ),
            intent_mission_enqueue_discovered_urls=(
                inv.intent_mission_enqueue_discovered_urls or restored.intent_mission_enqueue_discovered_urls
            ),
            generated_cases_filename_mode=inv.generated_cases_filename_mode,
            generated_cases_include_anchor_step_seq=inv.generated_cases_include_anchor_step_seq,
            screenshot_remove_highlights_before_capture=inv.screenshot_remove_highlights_before_capture,
        )

    def _generated_cases_yaml_relative(
        self,
        task_id: str,
        queue_seq: int | None,
        *,
        anchor_step_seq: int | None,
    ) -> str:
        fn = generated_cases_yaml_filename(
            task_id,
            queue_seq=queue_seq,
            anchor_step_seq=anchor_step_seq,
            include_anchor_step=self.config.generated_cases_include_anchor_step_seq,
            mode=self.config.generated_cases_filename_mode,
        )
        return f"generated_cases/{fn}"

    def _browser_context_config_from_bootstrap_overlay(self) -> BrowserContextConfig:
        """与 CLI 一致：Playwright context 创建时注入 bootstrap target.cookie（browser_use 读 cookies_file）。"""
        overlay = self._bootstrap_target_overlay or {}
        kwargs: dict[str, Any] = {}
        ck = overlay.get("cookie")
        if isinstance(ck, str):
            s = ck.strip()
            if s and s != "[]":
                kwargs["cookies_file"] = s
        vw = overlay.get("viewportWidth") or overlay.get("viewport_width")
        vh = overlay.get("viewportHeight") or overlay.get("viewport_height")
        try:
            if vw is not None and vh is not None:
                kwargs["browser_window_size"] = {"width": int(vw), "height": int(vh)}
        except (TypeError, ValueError):
            pass
        return BrowserContextConfig(**kwargs)

    def _create_task_browser_context(self, browser: Browser) -> RelaxedLoadBrowserContext:
        """单条队列任务专用：新开窗口/上下文（与首轮枚举会话隔离）。"""
        shot_until = self.config.page_goto_wait_until
        if shot_until == "commit":
            shot_until = "domcontentloaded"
        return RelaxedLoadBrowserContext(
            browser=browser,
            config=self._browser_context_config_from_bootstrap_overlay(),
            screenshot_wait_timeout_ms=self.config.page_goto_timeout_ms,
            screenshot_capture_timeout_ms=self.config.page_screenshot_timeout_ms,
            screenshot_wait_until=shot_until,
        )

    async def _replay_bootstrap_agent_if_yaml(
        self,
        ctx: RelaxedLoadBrowserContext,
        out_dir: Path,
        *,
        log_subdir: str,
    ) -> None:
        """若产物目录存在 bootstrap.yaml，则在当前上下文上完整执行前置（与同目录 CLI bootstrap 一致）。"""
        if self._should_skip_bootstrap_replay():
            return
        root = Path(out_dir).expanduser().resolve()
        bootstrap_yaml = root / "bootstrap.yaml"
        if not bootstrap_yaml.is_file():
            return
        safe = re.sub(r"[^\w\-]+", "_", log_subdir)[:200] or "task"
        log_dir = root / "bootstrap_replay_logs_task" / safe
        logger.info(
            "===== bootstrap_replay START subdir=%s log_dir=%s =====",
            log_subdir,
            log_dir,
        )
        t0 = time.monotonic()
        try:
            await replay_bootstrap_agent_on_context(
                ctx=ctx,
                bootstrap_yaml=bootstrap_yaml,
                headless=self.config.headless,
                log_dir=log_dir,
            )
        except BaseException as exc:
            logger.warning(
                "===== bootstrap_replay FAIL subdir=%s elapsed=%.1fs error=%r =====",
                log_subdir,
                time.monotonic() - t0,
                exc,
            )
            raise
        else:
            logger.info(
                "===== bootstrap_replay END   subdir=%s elapsed=%.1fs =====",
                log_subdir,
                time.monotonic() - t0,
            )

    def _bootstrap_prefix_for_yaml(self, out_dir: Path) -> list[dict[str, Any]]:
        """将产物目录下 bootstrap.yaml 的 flow 前置到各用例 YAML；不依赖与主探索同一会话。"""
        if not self.config.embed_bootstrap_in_generated_yaml:
            return []
        return parse_bootstrap_yaml_flow_steps(Path(out_dir) / "bootstrap.yaml")

    def _touch_exploration_review(self, graph: GraphStore, *, force: bool = False) -> None:
        """周期性或强制重写 timeline/review HTML，便于长任务中途查看。"""
        iv = self.config.review_archive_interval_seconds
        now = time.monotonic()
        if not force:
            if iv <= 0:
                return
            if now - self._review_archive_last_mono < iv:
                return
        self._review_archive_last_mono = now
        try:
            generate_exploration_review(graph.out_dir)
            outp = graph.out_dir
            tl = outp / "timeline.json"
            rh = outp / "review_timeline.html"
            if tl.is_file():
                shutil.copyfile(tl, outp / "timeline.last.json")
            if rh.is_file():
                shutil.copyfile(rh, outp / "review_timeline.last.html")
        except Exception as exc:
            logging.getLogger(__name__).warning("增量审查归档失败（下次继续尝试）: %s", exc)

    def _log_explore_progress(
        self,
        stats: dict[str, Any],
        *,
        pending: deque | None,
        anchor_norm: str | None,
        anchor_ok: int | None,
        action_queue_len: int | None,
        run_id: str,
        note: str,
        force: bool,
    ) -> None:
        if not self.config.progress_log_enabled:
            return
        ae = int(stats.get("actions_executed", 0) or 0)
        now = time.monotonic()
        if not force:
            dt = now - self._progress_last_mono
            dae = ae - self._progress_last_action_count
            if dt < self.config.progress_log_min_interval_seconds:
                if dae < self.config.progress_log_every_n_global_actions:
                    return
        self._progress_last_mono = now
        self._progress_last_action_count = ae
        disc = int(stats.get("discovery_url_enqueues_used", 0) or 0)
        mnu = self.config.max_new_urls
        g_rem = max(0, self.config.max_total_actions - ae)
        plen = len(pending) if pending is not None else None
        ps = str(plen) if plen is not None else "—"
        if anchor_ok is None:
            step_s = "—"
            rem_a = "—"
            aq = "—"
        else:
            rsv = self._intent_mission_reserve_cap()
            cap_eff = self.config.max_actions + rsv
            if rsv:
                step_s = f"{anchor_ok}/{self.config.max_actions}+{rsv}意图"
                rem_a = str(max(0, cap_eff - anchor_ok))
            else:
                step_s = f"{anchor_ok}/{self.config.max_actions}"
                rem_a = str(max(0, self.config.max_actions - anchor_ok))
            aq = str(action_queue_len) if action_queue_len is not None else "—"
        an = (anchor_norm or "")[:52] + ("…" if anchor_norm and len(anchor_norm) > 52 else "")
        line = (
            f"[explore] {note} | url队列={ps} | "
            f"发现入队={disc}/{mnu} | "
            f"全局成功步 {ae}/{self.config.max_total_actions} 余{g_rem} | "
            f"单锚步数 {step_s} 单锚余 {rem_a} | 动作队列待出队={aq} | "
            f"锚点 {an or '—'} | run_id={run_id[:12]}"
        )
        print(line, file=sys.stderr, flush=True)

    def _intent_mission_reserve_cap(self) -> int:
        if self.config.intent_missions_enabled:
            return max(0, int(self.config.intent_mission_reserved_actions))
        return 0

    def _anchor_ok_cap_for_task_kind(self, task_kind: str) -> int:
        base = self.config.max_actions
        if task_kind == "intent_mission" and self.config.intent_missions_enabled:
            return base + self._intent_mission_reserve_cap()
        return base

    def _anchor_ok_allows_task(self, task: ActionTask, anchor_ok: int) -> bool:
        cap = self._anchor_ok_cap_for_task_kind(task.task_kind)
        return anchor_ok < cap

    def _anchor_in_intent_reserve_zone(self, anchor_ok: int) -> bool:
        r = self._intent_mission_reserve_cap()
        if r <= 0:
            return False
        return anchor_ok >= self.config.max_actions and anchor_ok < self.config.max_actions + r

    def _dequeue_next_anchor_task(
        self,
        queue: deque[ActionTask],
        anchor_ok: int,
        *,
        phase_a_skip_composite: bool,
    ) -> ActionTask | None:
        """按锚点预算出队下一任务；在「意图预留」区间内仅消费 ``intent_mission``，必要时旋转队列。"""
        if not queue:
            return None
        if phase_a_skip_composite and queue[0].task_kind == "composite":
            return None
        if self._anchor_in_intent_reserve_zone(anchor_ok):
            n = len(queue)
            for _ in range(n):
                t = queue.popleft()
                if phase_a_skip_composite and t.task_kind == "composite":
                    queue.append(t)
                    continue
                if t.task_kind == "intent_mission" and self._anchor_ok_allows_task(t, anchor_ok):
                    return t
                queue.append(t)
            return None
        t0 = queue[0]
        if phase_a_skip_composite and t0.task_kind == "composite":
            return None
        if not self._anchor_ok_allows_task(t0, anchor_ok):
            return None
        return queue.popleft()

    def _anchor_has_any_runnable_task(self, queue: deque[ActionTask], anchor_ok: int) -> bool:
        """队列非空且至少有一条任务在当前 anchor_ok 下仍可成功执行一步（含意图预留）。"""
        if not queue:
            return False
        if self._anchor_in_intent_reserve_zone(anchor_ok):
            return any(
                t.task_kind == "intent_mission" and self._anchor_ok_allows_task(t, anchor_ok) for t in queue
            )
        return any(self._anchor_ok_allows_task(t, anchor_ok) for t in queue)

    async def _navigate_with_settings(self, ctx: BrowserContext, url: str) -> None:
        """与 BrowserContext.navigate_to 一致校验 allowed URL，使用配置的 goto 超时与 wait_until。"""
        from browser_use.browser.views import BrowserError

        if not ctx._is_url_allowed(url):
            raise BrowserError(f"Navigation to non-allowed URL: {url}")
        page = await ctx.get_current_page()
        await page.goto(
            url,
            timeout=self.config.page_goto_timeout_ms,
            wait_until=self.config.page_goto_wait_until,
        )

    async def _settle_after_task_nav(self) -> None:
        """队列任务在导航到锚点后、采 DOM 前等待 SPA 收敛（与首轮枚举会话对齐）。"""
        ms = int(getattr(self.config, "task_step_post_nav_settle_ms", 0) or 0)
        if ms > 0:
            await asyncio.sleep(ms / 1000.0)

    async def _maybe_goto_anchor(self, ctx: BrowserContext, url: str) -> None:
        """当前页已与锚点 URL（规范化）一致则不再 goto，减轻同锚点每步重复导航导致的 SPA 状态丢失。"""
        if not (url or "").strip():
            return
        try:
            page = await ctx.get_current_page()
            cur = (page.url or "").strip()
        except Exception:
            cur = ""
        nu = normalize_url(
            cur,
            strip_trailing_slash=self.config.url_strip_trailing_slash,
            keep_fragment=self.config.url_keep_fragment,
        )
        tu = normalize_url(
            url,
            strip_trailing_slash=self.config.url_strip_trailing_slash,
            keep_fragment=self.config.url_keep_fragment,
        )
        if nu == tu:
            return
        await self._navigate_with_settings(ctx, url)

    async def _suggest_input_mock_text(
        self,
        *,
        page_url: str,
        page_title: str,
        locate_prompt: str,
        tap_description: str,
    ) -> str:
        from recursive_exploration.input_mock_llm import suggest_input_mock_text, try_get_page_extraction_llm

        if not self.config.use_llm_for_input_mock:
            return self.config.mock_input_text
        llm = try_get_page_extraction_llm()
        return await suggest_input_mock_text(
            llm,
            page_url=page_url,
            page_title=page_title,
            locate_prompt=locate_prompt,
            tap_description=tap_description,
            fallback=self.config.mock_input_text,
        )

    def _next_event_id(self, run_id: str) -> str:
        self._seq += 1
        return f"{run_id}_{self._seq:06d}"

    async def _await_screenshot_paint(self, page: Any) -> None:
        """在「动作后已 settle + domcontentloaded」之后、真正 page.screenshot 之前再稳一稳，减轻白屏/骨架图。"""
        cfg = self.config
        lim = int(getattr(cfg, "screenshot_try_load_timeout_ms", 0) or 0)
        if lim > 0:
            try:
                await page.wait_for_load_state("load", timeout=min(lim, 30_000))
            except Exception:
                pass
        rounds = int(getattr(cfg, "screenshot_paint_raf_rounds", 0) or 0)
        for _ in range(max(0, rounds)):
            try:
                await page.evaluate(
                    """async () => {
  await new Promise((resolve) => {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => resolve());
    });
  });
}"""
                )
            except Exception:
                break
        settle = int(getattr(cfg, "screenshot_paint_settle_ms", 0) or 0)
        if settle > 0:
            await asyncio.sleep(settle / 1000.0)

    async def _wait_post_action_settled(
        self, ctx: BrowserContext, *, task: ActionTask | None = None
    ) -> None:
        """动作触发导航或 DOM 大变后：等待 load/DOM、可选 networkidle、URL 稳定，再采状态/截图。"""
        cfg = self.config
        heavy = bool(task and post_action_slow_navigation_hint(task))
        extra_deadline = (cfg.post_action_heavy_nav_extra_deadline_ms / 1000.0) if heavy else 0.0
        deadline = time.monotonic() + cfg.post_action_settle_timeout_ms / 1000.0 + extra_deadline

        # 新标签页：click 后 Playwright 可能稍后才把 Page 挂到 context；若只持有旧 Page，
        # URL 会立即「稳定」在首页而过早退出。先在一段时间窗内等待 pages 数量稳定并刷新当前页。
        session = await ctx.get_session()
        grace_budget = min(
            cfg.post_action_new_tab_grace_ms / 1000.0,
            max(0.0, deadline - time.monotonic()),
        )
        quiet_need = (
            max(0.05, cfg.post_action_new_tab_quiet_ms / 1000.0)
            if cfg.post_action_new_tab_quiet_ms > 0
            else 0.15
        )
        if grace_budget > 0:
            grace_end = time.monotonic() + grace_budget
            last_n = len(session.context.pages)
            quiet_since: float | None = None
            while time.monotonic() < grace_end:
                session = await ctx.get_session()
                n = len(session.context.pages)
                now = time.monotonic()
                if n != last_n:
                    last_n = n
                    quiet_since = None
                else:
                    if quiet_since is None:
                        quiet_since = now
                    elif now - quiet_since >= quiet_need:
                        break
                try:
                    p = await ctx.get_current_page()
                    await p.bring_to_front()
                except Exception:
                    pass
                await asyncio.sleep(0.05)

        page = await ctx.get_current_page()
        try:
            await page.bring_to_front()
        except Exception:
            pass
        first_load_to = min(12_000, cfg.post_action_settle_timeout_ms)
        try:
            await page.wait_for_load_state("domcontentloaded", timeout=first_load_to)
        except Exception:
            pass
        nid = cfg.post_action_try_networkidle_ms
        if nid > 0:
            try:
                await page.wait_for_load_state("networkidle", timeout=min(nid, first_load_to))
            except Exception:
                pass
        try:
            await page.wait_for_function(
                "() => document.readyState === 'complete' || document.readyState === 'interactive'",
                timeout=min(6000, first_load_to),
            )
        except Exception:
            pass
        stable_extra = cfg.post_action_heavy_nav_stable_extra_ms if heavy else 0
        stable_need = (cfg.post_action_url_stable_ms + stable_extra) / 1000.0
        poll = max(0.05, cfg.post_action_poll_interval_ms / 1000.0)
        last_url: str | None = None
        stable_start: float | None = None
        url_phase_started = time.monotonic()
        min_url_phase_s = (cfg.post_action_heavy_min_url_phase_ms / 1000.0) if heavy else 0.0
        while time.monotonic() < deadline:
            try:
                page = await ctx.get_current_page()
                await page.bring_to_front()
                cur = page.url
            except Exception:
                cur = ""
            now = time.monotonic()
            if cur != last_url:
                last_url = cur
                stable_start = now
            elif stable_start is not None and now - stable_start >= stable_need:
                # 慢导航：顶栏 URL 可能长期不变（同页内嵌地图/SPA），不能仅 550ms 就结束
                if heavy and min_url_phase_s > 0 and (now - url_phase_started) < min_url_phase_s:
                    await asyncio.sleep(poll)
                    continue
                break
            await asyncio.sleep(poll)
        page = await ctx.get_current_page()
        try:
            await page.bring_to_front()
        except Exception:
            pass
        try:
            await page.wait_for_load_state("domcontentloaded", timeout=4000)
        except Exception:
            pass
        if heavy and cfg.post_action_heavy_nav_load_timeout_ms > 0:
            try:
                await page.wait_for_load_state(
                    "load",
                    timeout=min(int(cfg.post_action_heavy_nav_load_timeout_ms), 45_000),
                )
            except Exception:
                pass
        if heavy and cfg.post_action_heavy_ready_state_complete_timeout_ms > 0:
            try:
                await page.wait_for_function(
                    "() => document.readyState === 'complete'",
                    timeout=min(int(cfg.post_action_heavy_ready_state_complete_timeout_ms), 35_000),
                )
            except Exception:
                pass
        paint = cfg.post_action_paint_delay_ms / 1000.0
        if heavy:
            paint += cfg.post_action_heavy_nav_after_stable_sleep_ms / 1000.0
        if paint > 0:
            await asyncio.sleep(paint)

    async def _screenshot_rel(self, ctx: BrowserContext, graph: GraphStore, tag: str) -> str:
        page = await ctx.get_current_page()
        try:
            await page.bring_to_front()
        except Exception:
            pass
        wt = "domcontentloaded"
        wto = min(60_000, self.config.page_goto_timeout_ms)
        if isinstance(ctx, RelaxedLoadBrowserContext):
            wt = getattr(ctx, "_screenshot_wait_until", wt) or wt
            wto = int(getattr(ctx, "_screenshot_wait_timeout_ms", wto) or wto)
        if wt not in ("load", "domcontentloaded", "commit"):
            wt = "domcontentloaded"
        try:
            await page.wait_for_load_state(wt, timeout=wto)
        except Exception:
            pass
        await self._await_screenshot_paint(page)
        if self.config.screenshot_remove_highlights_before_capture:
            try:
                await ctx.remove_highlights()
            except Exception:
                logger.debug(
                    "remove_highlights before exploration screenshot failed",
                    exc_info=True,
                )
        name = f"{tag}_{self._next_event_id(graph.run_id)}.png"
        path = graph.shot_dir / name
        path.parent.mkdir(parents=True, exist_ok=True)
        await page.screenshot(
            path=str(path),
            type="png",
            timeout=min(self.config.page_screenshot_timeout_ms, 120_000),
        )
        return str(path.relative_to(graph.out_dir))

    async def _screenshot_rel_optional(
        self, ctx: BrowserContext, graph: GraphStore, tag: str
    ) -> str | None:
        """失败分支补拍（例如解析失败时页面实际仍可用）；异常时返回 None。"""
        try:
            return await self._screenshot_rel(ctx, graph, tag)
        except Exception:
            logger.debug("optional screenshot %s failed", tag, exc_info=True)
            return None

    async def _perform_click(self, ctx: BrowserContext, idx: int) -> None:
        el = await ctx.get_dom_element_by_index(idx)
        rect = el.rectangle
        if not rect:
            raise RuntimeError(f"element {idx} has no rectangle")
        await ctx.click(rect, hover=True)
        await ctx.get_state()

    async def _replay_single_step(self, ctx: BrowserContext, st: ExplorationStep) -> bool:
        state = await ctx.get_state()
        idx = _resolve_click_index(state, st)
        if idx is None:
            return False
        try:
            if st.step_kind == "input":
                val = (st.input_value or "").strip()
                if not val:
                    val = await self._suggest_input_mock_text(
                        page_url=state.url or "",
                        page_title=state.title or "",
                        locate_prompt=st.locate_prompt,
                        tap_description=st.tap_description,
                    )
                val = (val or self.config.mock_input_text).strip()
                if not val:
                    return False
                eln = await ctx.get_dom_element_by_index(idx)
                await ctx.input_text_element_node(eln, val)
            else:
                await self._perform_click(ctx, idx)
        except Exception:
            return False
        return True

    async def _replay_prefix(self, ctx: BrowserContext, steps: list[ExplorationStep]) -> bool:
        for st in steps:
            if not await self._replay_single_step(ctx, st):
                return False
        return True

    async def _replay_prefix_with_flow_shots(
        self,
        ctx: BrowserContext,
        graph: GraphStore,
        steps: list[ExplorationStep],
    ) -> tuple[bool, list[dict[str, Any]]]:
        """重放前缀并在每步后截图，供审查 HTML 展示完整前缀轨迹。"""
        frames: list[dict[str, Any]] = []
        if not steps:
            return True, frames
        obs0 = _observation(await ctx.get_state(), self.config)
        entry_shot = await self._screenshot_rel(ctx, graph, "prefix_entry")
        frames.append(
            {
                "step_index": 0,
                "kind": "prefix_entry",
                "screenshot_after": entry_shot,
                "url_after": obs0["url"],
                "label": "前缀重放起点（当前页）",
            }
        )
        for i, st in enumerate(steps):
            if not await self._replay_single_step(ctx, st):
                return False, []
            await self._wait_post_action_settled(ctx, task=None)
            obs = _observation(await ctx.get_state(), self.config)
            shot = await self._screenshot_rel(ctx, graph, f"prefix_{i}")
            hint = ((st.locate_prompt or st.tap_description or "")[:100]).strip()
            frames.append(
                {
                    "step_index": i + 1,
                    "kind": "prefix_step",
                    "screenshot_after": shot,
                    "url_after": obs["url"],
                    "label": hint or f"前缀第 {i + 1} 步",
                }
            )
        return True, frames

    async def _maybe_enqueue_intent_missions(
        self,
        graph: GraphStore,
        obs: dict[str, Any],
        anchor_url: str,
        anchor_norm: str,
        anchor_depth: int,
        run_id: str,
        queue: deque[ActionTask],
        stats: dict[str, Any],
        *,
        enum_state: Any | None = None,
        blocked_path_keys: set[str] | None = None,
        late_phase: bool = False,
    ) -> int:
        """规划并直接把意图任务 append 到 queue 尾部；返回入队数。

        ``late_phase=False``：anchor_start 阶段调用，仅在 ``intent_missions_execution_only=True`` 时
            真正规划（execution_only 不打算跑探索单步，必须早期产出意图）。
        ``late_phase=True``：anchor 末尾在「单步 + 扩对」全部消耗后调用，意图规划依赖此时的
            graph（成功边）+ 最新页面观测，价值显著高于 anchor_start。
        """
        if not self.config.intent_missions_enabled:
            return 0
        if self.config.intent_mission_phase != "anchor_start":
            return 0
        # 默认延迟到 late_phase；execution_only 仍走早期规划（它本身就是「不跑探索单步」的模式）。
        if not late_phase and not self.config.intent_missions_execution_only:
            return 0
        plan = await plan_intent_missions_llm(
            graph=graph,
            anchor_url=anchor_url,
            anchor_url_norm=anchor_norm,
            obs=obs,
            cfg=self.config,
            run_id=run_id,
            anchor_depth=anchor_depth,
            enum_state=enum_state,
            blocked_path_keys=blocked_path_keys,
        )
        missions = plan.missions
        if not missions:
            stats["intent_mission_plan_empty"] = stats.get("intent_mission_plan_empty", 0) + 1
            sk = plan.skip_reason or "no_missions"
            graph.append_queue(
                "intent_mission_skip",
                {
                    "reason": sk,
                    "anchor_url_norm": anchor_norm,
                    "validate_err": plan.validate_err,
                    "phase": "late" if late_phase else "anchor_start",
                },
            )
            return 0
        tasks = build_intent_action_tasks(
            missions,
            anchor_url=anchor_url,
            anchor_url_norm=anchor_norm,
            run_id=run_id,
            anchor_depth=anchor_depth,
        )
        batch_seen: set[str] = set()
        n = 0
        for t in tasks:
            if t.dedupe_path_key in batch_seen:
                continue
            batch_seen.add(t.dedupe_path_key)
            queue.append(t)
            n += 1
            graph.append_queue(
                "intent_mission_enqueue",
                {
                    "task_id": t.task_id,
                    "dedupe_path_key": t.dedupe_path_key,
                    "anchor_url_norm": anchor_norm,
                    "ai_steps_count": len(t.intent_ai_steps),
                    "phase": "late" if late_phase else "anchor_start",
                },
            )
        stats["intent_mission_planned"] = stats.get("intent_mission_planned", 0) + n
        stats["intent_mission_enqueued"] = stats.get("intent_mission_enqueued", 0) + n

        # execution_only：清掉本锚点队列中已经入队的单步/合成任务，仅保留 intent_mission。
        if self.config.intent_missions_execution_only and not late_phase and n > 0:
            kept = deque[ActionTask]()
            dropped = 0
            for t in queue:
                if t.task_kind == "intent_mission":
                    kept.append(t)
                else:
                    dropped += 1
            queue.clear()
            queue.extend(kept)
            stats["intent_missions_queue_filtered"] = (
                stats.get("intent_missions_queue_filtered", 0) + dropped
            )
            graph.append_queue(
                "intent_missions_execution_only",
                {
                    "anchor_url_norm": anchor_norm,
                    "dropped_non_intent": dropped,
                    "kept_intent": len(kept),
                },
            )
        return n

    async def _plan_intent_missions_late(
        self,
        browser: Browser,
        graph: GraphStore,
        anchor_url: str,
        anchor_norm: str,
        anchor_depth: int,
        run_id: str,
        queue: deque[ActionTask],
        stats: dict[str, Any],
        dedupe: DedupeStore,
        prior_path_keys: set[str],
        out_dir: Path,
    ) -> int:
        """anchor 末尾：重新打开 ctx 拍 obs，再调用 LLM 规划意图任务并入队。"""
        if not self.config.intent_missions_enabled:
            return 0
        if self.config.intent_mission_phase != "anchor_start":
            return 0
        if self.config.intent_missions_execution_only:
            # execution_only 模式已在 anchor_start 早期规划入队，此处不重复。
            return 0
        plan_ctx = self._create_task_browser_context(browser)
        try:
            if not self._should_skip_bootstrap_replay():
                await self._replay_bootstrap_agent_if_yaml(
                    plan_ctx, out_dir, log_subdir="intent_mission_late_plan"
                )
            await self._maybe_goto_anchor(plan_ctx, anchor_url)
            await self._settle_after_task_nav()
            st_late = await plan_ctx.get_state()
            obs_late = _observation(st_late, self.config)
        finally:
            await plan_ctx.close()
        blocked_for_intent = set(prior_path_keys)
        blocked_for_intent |= dedupe.seen_path
        return await self._maybe_enqueue_intent_missions(
            graph,
            obs_late,
            anchor_url,
            anchor_norm,
            anchor_depth,
            run_id,
            queue,
            stats,
            enum_state=st_late,
            blocked_path_keys=blocked_for_intent,
            late_phase=True,
        )

    async def _execute_intent_mission_task(
        self,
        ctx: BrowserContext,
        graph: GraphStore,
        dedupe: DedupeStore,
        task: ActionTask,
        *,
        new_urls: list[UrlTask],
        stats: dict[str, Any],
        queue_seq: int | None = None,
        prefix_flow_frames: list[dict[str, Any]] | None = None,
    ) -> str:
        """task_kind=intent_mission：在同一上下文执行 YAML（多条 ai）。"""
        run_id = task.run_id
        event_id = self._next_event_id(run_id)

        before = await ctx.get_state()
        obs_before = _observation(before, self.config)
        from_node_id = _node_id(obs_before["url_norm"], obs_before["structural_state_id"])
        graph.register_entry_node(from_node_id)
        graph.upsert_node(
            GraphNodeRecord(
                node_id=from_node_id,
                url_norm=obs_before["url_norm"],
                raw_url=obs_before["url"],
                structural_state_id=obs_before["structural_state_id"],
                page_state_id=obs_before["page_state_id"],
                title=obs_before["title"],
                first_seen_at=_ts(),
                last_seen_at=_ts(),
                seen_run_ids=[run_id],
            )
        )
        shot_before = await self._screenshot_rel(ctx, graph, "before")
        path_key = task.dedupe_path_key

        if not dedupe.try_path(path_key):
            ass_skip = self._alloc_anchor_step_seq(task.anchor_url_norm)
            graph.append_queue(
                "action_skip",
                {
                    "reason": "dedupe_path",
                    "task_id": task.task_id,
                    "dedupe_path_key": path_key,
                    "anchor_url_norm": task.anchor_url_norm,
                    "event_id": event_id,
                },
            )
            yft, yidx = yaml_meta_failed_or_skipped(
                task,
                default_input_text=self.config.mock_input_text,
                bootstrap_flow_prefix=self._bootstrap_flow_prefix,
            )
            graph.append_event(
                ExplorationEvent(
                    event_id=event_id,
                    run_id=run_id,
                    ts=_ts(),
                    kind="action_result",
                    result="skipped",
                    skip_reason=SkipReason.DEDUPE_PATH.value,
                    dedupe_path_key=path_key,
                    anchor_url_norm=task.anchor_url_norm,
                    anchor_url=task.anchor_url,
                    task_id=task.task_id,
                    target_step=_target_step_dict_intent(task),
                    queue_seq=queue_seq,
                    anchor_step_seq=ass_skip,
                    anchor_depth=task.anchor_depth,
                    yaml_flow_total=yft,
                    yaml_flow_target_index=yidx,
                    step_origin=step_origin_code(task),
                    task_source=task.task_source,
                    action_kind=task.action_kind,
                ).to_json_obj()
            )
            return "skipped"

        ass = self._alloc_anchor_step_seq(task.anchor_url_norm)
        merged_steps: list[str] = list(task.intent_ai_steps or [])
        max_round = 1 + max(0, int(self.config.intent_mission_continuation_rounds))
        yaml_rel_p_kept = ""
        _t0_intent = time.monotonic()
        quick_executor_succeeded = False
        quick_executor_info: dict[str, Any] = {}

        for round_i in range(max_round):
            if round_i > 0:
                await self._wait_post_action_settled(ctx, task=task)
                st_plan = await ctx.get_state()
                obs_plan = _observation(st_plan, self.config)
                cont = await plan_intent_mission_continuation_llm(
                    graph=graph,
                    anchor_url=task.anchor_url,
                    anchor_url_norm=task.anchor_url_norm,
                    obs=obs_plan,
                    cfg=self.config,
                    run_id=run_id,
                    prior_executed_steps=list(merged_steps),
                    continuation_index=round_i,
                )
                if not cont:
                    logger.info("intent_mission 深化轮 %s：LLM 无新步骤，停止", round_i)
                    break
                merged_steps.extend(cont)
                steps_run = cont
                round_tid = f"{task.task_id}_c{round_i}"
            else:
                steps_run = list(task.intent_ai_steps or [])
                round_tid = task.task_id

            yaml_rel_p = self._generated_cases_yaml_relative(
                round_tid, queue_seq, anchor_step_seq=ass
            )
            if round_i == 0:
                yaml_rel_p_kept = yaml_rel_p
            ypath = graph.out_dir / yaml_rel_p
            ypath.parent.mkdir(parents=True, exist_ok=True)
            log_dir = graph.out_dir / "intent_mission_logs" / task.task_id / f"round_{round_i}"
            log_dir.mkdir(parents=True, exist_ok=True)
            head = (steps_run[0] or "").strip()[:180] if steps_run else ""
            round_task = dataclasses.replace(
                task,
                task_id=round_tid,
                intent_ai_steps=steps_run,
                target_description=(steps_run[0] or task.target_description)[:120]
                if steps_run
                else task.target_description,
                locate_prompt=(
                    f"意图任务第 {round_i + 1} 段（本段 {len(steps_run)} 步），首步：{head}"
                ),
            )
            write_task_yaml(
                round_task,
                ypath,
                default_input_text=self.config.mock_input_text,
                bootstrap_flow_prefix=self._bootstrap_flow_prefix,
                bootstrap_target_overlay=self._bootstrap_target_overlay,
            )
            logger.info(
                "===== intent_mission START round=%s task_id=%s yaml=%s log_dir=%s =====",
                round_i,
                task.task_id,
                ypath.name,
                log_dir,
            )
            try:
                if self.config.intent_mission_executor == "quick":
                    quick_info = await replay_intent_mission_quick_cli(
                        anchor_url=task.anchor_url,
                        intent_ai_steps=steps_run,
                        log_dir=log_dir / "quick_primary",
                        max_steps=self.config.intent_mission_quick_max_steps,
                        no_cdp=self.config.intent_mission_quick_no_cdp,
                        python_bin=self.config.intent_mission_quick_python,
                    )
                    if int(quick_info.get("returncode") or 0) != 0:
                        raise RuntimeError(
                            f"intent_mission quick primary failed rc={quick_info.get('returncode')}"
                        )
                    stats["intent_mission_quick_primary_ok"] = (
                        stats.get("intent_mission_quick_primary_ok", 0) + 1
                    )
                    quick_executor_succeeded = True
                    quick_executor_info = {"mode": "quick", "round": round_i, **quick_info}
                    break
                await replay_intent_mission_yaml_on_context(
                    ctx=ctx,
                    task_yaml=ypath,
                    headless=self.config.headless,
                    log_dir=log_dir,
                )
            except Exception as exc:
                quick_info: dict[str, Any] | None = None
                if self.config.intent_mission_executor == "hybrid":
                    quick_log_dir = log_dir / "quick_fallback"
                    logger.warning(
                        "intent_mission 原链路失败，尝试 quick fallback task_id=%s round=%s log=%s",
                        task.task_id,
                        round_i,
                        quick_log_dir,
                    )
                    try:
                        quick_info = await replay_intent_mission_quick_cli(
                            anchor_url=task.anchor_url,
                            intent_ai_steps=steps_run,
                            log_dir=quick_log_dir,
                            max_steps=self.config.intent_mission_quick_max_steps,
                            no_cdp=self.config.intent_mission_quick_no_cdp,
                            python_bin=self.config.intent_mission_quick_python,
                        )
                    except Exception as quick_exc:
                        quick_info = {
                            "returncode": -1,
                            "error": repr(quick_exc),
                            "log_dir": str(quick_log_dir),
                        }
                    if int(quick_info.get("returncode") or 0) == 0:
                        logger.info(
                            "intent_mission quick fallback 成功 task_id=%s round=%s log=%s",
                            task.task_id,
                            round_i,
                            quick_log_dir,
                        )
                        stats["intent_mission_quick_fallback_ok"] = (
                            stats.get("intent_mission_quick_fallback_ok", 0) + 1
                        )
                        graph.append_queue(
                            "intent_mission_quick_fallback_ok",
                            {
                                "task_id": task.task_id,
                                "dedupe_path_key": path_key,
                                "anchor_url_norm": task.anchor_url_norm,
                                "round": round_i,
                                "quick": quick_info,
                            },
                        )
                        quick_executor_succeeded = True
                        quick_executor_info = {
                            "mode": "hybrid_fallback",
                            "round": round_i,
                            "original_error": repr(exc),
                            **quick_info,
                        }
                        break
                    stats["intent_mission_quick_fallback_failed"] = (
                        stats.get("intent_mission_quick_fallback_failed", 0) + 1
                    )
                logger.warning(
                    "===== intent_mission FAIL round=%s task_id=%s elapsed=%.1fs error=%r =====",
                    round_i,
                    task.task_id,
                    time.monotonic() - _t0_intent,
                    exc,
                )
                logger.warning(
                    "intent_mission Agent 执行失败 task_id=%s: %s", task.task_id, exc
                )
                logger.debug("intent_mission Agent 执行失败 traceback", exc_info=True)
                stats["intent_mission_execute_failed"] = stats.get("intent_mission_execute_failed", 0) + 1
                graph.append_queue(
                    "intent_mission_failed",
                    {
                        "task_id": task.task_id,
                        "dedupe_path_key": path_key,
                        "anchor_url_norm": task.anchor_url_norm,
                        "round": round_i,
                    },
                )
                fail_task = dataclasses.replace(task, intent_ai_steps=merged_steps)
                yft, yidx = yaml_meta_failed_or_skipped(
                    fail_task,
                    default_input_text=self.config.mock_input_text,
                    bootstrap_flow_prefix=self._bootstrap_flow_prefix,
                )
                u_b = str(obs_before.get("url") or "")
                shot_after_fail = await self._screenshot_rel_optional(ctx, graph, "after")
                shots_fail: dict[str, str] = {"before": shot_before}
                if shot_after_fail:
                    shots_fail["after"] = shot_after_fail
                graph.append_event(
                    ExplorationEvent(
                        event_id=event_id,
                        run_id=run_id,
                        ts=_ts(),
                        kind="action_result",
                        result="failed",
                        skip_reason=SkipReason.REPLAY_FAILED.value,
                        dedupe_path_key=path_key,
                        anchor_url_norm=task.anchor_url_norm,
                        anchor_url=task.anchor_url,
                        task_id=task.task_id,
                        target_step=_target_step_dict_intent(fail_task),
                        queue_seq=queue_seq,
                        anchor_step_seq=ass,
                        anchor_depth=task.anchor_depth,
                        yaml_flow_total=yft,
                        yaml_flow_target_index=yidx,
                        step_origin=step_origin_code(task),
                        task_source=task.task_source,
                        action_kind=task.action_kind,
                        url_before=u_b,
                        url_after=u_b,
                        screenshots=shots_fail,
                        extra={
                            "intent_mission_round_failed": round_i,
                            "intent_mission_executor": self.config.intent_mission_executor,
                            "quick_fallback": quick_info,
                        },
                    ).to_json_obj()
                )
                return "failed"

        logger.info(
            "===== intent_mission END   task_id=%s merged_ai_steps=%s elapsed=%.1fs =====",
            task.task_id,
            len(merged_steps),
            time.monotonic() - _t0_intent,
        )
        stats["actions_executed"] = stats.get("actions_executed", 0) + 1
        stats["intent_missions_ok"] = stats.get("intent_missions_ok", 0) + 1

        if self.config.intent_mission_suppress_dom_expand:
            self._suppress_next_dom_expansion = True

        await self._wait_post_action_settled(ctx, task=task)
        after = await ctx.get_state()
        obs_after = _observation(after, self.config)
        first_head = (merged_steps[0] or "").strip()[:180] if merged_steps else ""
        final_task = dataclasses.replace(
            task,
            intent_ai_steps=merged_steps,
            target_description=(merged_steps[0] or task.target_description)[:120]
            if merged_steps
            else task.target_description,
            locate_prompt=f"多步意图任务（共 {len(merged_steps)} 步），首步摘要：{first_head}",
        )
        to_node_id = _node_id(obs_after["url_norm"], obs_after["structural_state_id"])
        graph.upsert_node(
            GraphNodeRecord(
                node_id=to_node_id,
                url_norm=obs_after["url_norm"],
                raw_url=obs_after["url"],
                structural_state_id=obs_after["structural_state_id"],
                page_state_id=obs_after["page_state_id"],
                title=obs_after["title"],
                first_seen_at=_ts(),
                last_seen_at=_ts(),
                seen_run_ids=[run_id],
            )
        )
        shot_after = await self._screenshot_rel(ctx, graph, "after")

        url_before_norm = obs_before["url_norm"]
        url_changed = obs_after["url_norm"] != url_before_norm
        edge_id = f"e_{event_id}"
        afp = intent_target_fingerprint(merged_steps)
        tgt_step = _target_step_dict_intent(final_task)

        yaml_rel_p = yaml_rel_p_kept

        yaml_rel: str | None = None
        critical = url_changed or (obs_before["structural_state_id"] != obs_after["structural_state_id"])
        if self.config.yaml_policy == "all" or critical:
            yaml_rel = yaml_rel_p

        rec = GraphEdgeRecord(
            edge_id=edge_id,
            from_node_id=from_node_id,
            to_node_id=to_node_id,
            action_type="intent_mission",
            action_fingerprint=afp,
            anchor_url_norm=task.anchor_url_norm,
            prefix_steps_ref=None,
            prefix_steps_summary=[],
            target_step=tgt_step,
            result="ok",
            url_changed=url_changed,
            screenshots={"before": shot_before, "after": shot_after},
            run_id=run_id,
            event_id=event_id,
            dedupe_path_key=path_key,
            yaml_ref=yaml_rel,
            action_tag=infer_action_tag(
                final_task,
                url_before=str(obs_before.get("url") or ""),
                url_after=str(obs_after.get("url") or ""),
            ),
        )
        graph.upsert_edge(rec)

        if url_changed and self.config.intent_mission_enqueue_discovered_urls:
            uk = dedupe_url_key(obs_after["url_norm"])
            if dedupe.try_url(uk):
                new_urls.append(
                    UrlTask(
                        url_norm=obs_after["url_norm"],
                        raw_url=obs_after["url"],
                        anchor_depth=task.anchor_depth + 1,
                    )
                )
                graph.append_queue(
                    "url_discovered",
                    {
                        "url_norm": obs_after["url_norm"],
                        "raw_url": obs_after["url"],
                        "from_anchor_depth": task.anchor_depth,
                        "task_id": task.task_id,
                        "event_id": event_id,
                        "edge_id": edge_id,
                    },
                )

        yft, yidx = yaml_meta_single_success(
            final_task,
            default_input_text=self.config.mock_input_text,
            page_title_after=str(obs_after.get("title") or ""),
            page_url_after=str(obs_after.get("url") or ""),
            bootstrap_flow_prefix=self._bootstrap_flow_prefix,
        )
        ex_ok: dict[str, Any] = {}
        if prefix_flow_frames:
            ex_ok["prefix_flow_frames"] = prefix_flow_frames
        if quick_executor_succeeded:
            ex_ok["intent_mission_executor"] = quick_executor_info.get("mode") or self.config.intent_mission_executor
            ex_ok["intent_mission_quick"] = quick_executor_info
        graph.append_event(
            ExplorationEvent(
                event_id=event_id,
                run_id=run_id,
                ts=_ts(),
                anchor_url_norm=task.anchor_url_norm,
                anchor_url=task.anchor_url,
                dedupe_path_key=path_key,
                from_node_id=from_node_id,
                to_node_id=to_node_id,
                edge_id=edge_id,
                url_before=obs_before["url"],
                url_after=obs_after["url"],
                structural_before=obs_before["structural_state_id"],
                structural_after=obs_after["structural_state_id"],
                page_state_before=obs_before["page_state_id"],
                page_state_after=obs_after["page_state_id"],
                action_fingerprint=afp,
                result="ok",
                skip_reason=None,
                screenshots={"before": shot_before, "after": shot_after},
                task_id=task.task_id,
                target_step=tgt_step,
                queue_seq=queue_seq,
                anchor_step_seq=ass,
                anchor_depth=task.anchor_depth,
                yaml_flow_total=yft,
                yaml_flow_target_index=yidx,
                step_origin=step_origin_code(task),
                task_source=task.task_source,
                action_kind=task.action_kind,
                extra=ex_ok,
            ).to_json_obj()
        )

        self._touch_exploration_review(graph, force=False)
        return "ok"

    async def _execute_click_task(
        self,
        ctx: BrowserContext,
        graph: GraphStore,
        dedupe: DedupeStore,
        task: ActionTask,
        *,
        new_urls: list[UrlTask],
        stats: dict[str, Any],
        queue_seq: int | None = None,
        prefix_flow_frames: list[dict[str, Any]] | None = None,
    ) -> str:
        """执行单个 ActionTask（假定已在 anchor 且 prefix 已重放）。返回 ok|skipped|failed。"""
        run_id = task.run_id
        event_id = self._next_event_id(run_id)

        if task.task_kind == "intent_mission" and task.intent_ai_steps:
            return await self._execute_intent_mission_task(
                ctx,
                graph,
                dedupe,
                task,
                new_urls=new_urls,
                stats=stats,
                queue_seq=queue_seq,
                prefix_flow_frames=prefix_flow_frames,
            )

        if task.task_kind == "composite" and task.composite_steps:
            from recursive_exploration.composite_chain import execute_composite_chain

            return await execute_composite_chain(
                self,
                ctx,
                graph,
                dedupe,
                task,
                new_urls=new_urls,
                stats=stats,
                queue_seq=queue_seq,
                prefix_flow_frames=prefix_flow_frames,
            )

        before = await ctx.get_state()
        obs_before = _observation(before, self.config)
        from_node_id = _node_id(obs_before["url_norm"], obs_before["structural_state_id"])
        graph.register_entry_node(from_node_id)
        graph.upsert_node(
            GraphNodeRecord(
                node_id=from_node_id,
                url_norm=obs_before["url_norm"],
                raw_url=obs_before["url"],
                structural_state_id=obs_before["structural_state_id"],
                page_state_id=obs_before["page_state_id"],
                title=obs_before["title"],
                first_seen_at=_ts(),
                last_seen_at=_ts(),
                seen_run_ids=[run_id],
            )
        )
        shot_before = await self._screenshot_rel(ctx, graph, "before")

        st_click = await ctx.get_state()
        resolve_step = ExplorationStep(
            task.target_index,
            task.target_branch_path_hash,
            task.target_description,
            locate_prompt=task.locate_prompt,
            step_kind=task.action_kind,
            input_value="",
            attributes_hash=task.target_attributes_hash,
            tag_name=task.target_tag_name,
            css_selector_hint=task.target_css_selector_hint,
            text_content=task.target_text_content,
        )
        idx = _resolve_click_index(
            st_click,
            resolve_step,
            allow_offviewport=task.discovered_by_scroll,
        )
        if idx is None:
            stats["failed_resolves"] = stats.get("failed_resolves", 0) + 1
            graph.append_queue(
                "action_skip",
                {
                    "reason": "resolve_failed",
                    "task_id": task.task_id,
                    "dedupe_path_key": task.dedupe_path_key,
                    "anchor_url_norm": task.anchor_url_norm,
                    "event_id": event_id,
                },
            )
            yft, yidx = yaml_meta_failed_or_skipped(
                task,
                default_input_text=self.config.mock_input_text,
                bootstrap_flow_prefix=self._bootstrap_flow_prefix,
            )
            u_b = str(obs_before.get("url") or "")
            shot_after_fail = await self._screenshot_rel_optional(ctx, graph, "after")
            shots_fail: dict[str, str] = {"before": shot_before}
            if shot_after_fail:
                shots_fail["after"] = shot_after_fail
            ass_res = self._alloc_anchor_step_seq(task.anchor_url_norm)
            graph.append_event(
                ExplorationEvent(
                    event_id=event_id,
                    run_id=run_id,
                    ts=_ts(),
                    kind="action_result",
                    result="failed",
                    skip_reason=SkipReason.REPLAY_FAILED.value,
                    dedupe_path_key=task.dedupe_path_key,
                    anchor_url_norm=task.anchor_url_norm,
                    anchor_url=task.anchor_url,
                    task_id=task.task_id,
                    target_step=_target_step_dict(task, None, input_value_used=""),
                    queue_seq=queue_seq,
                    anchor_step_seq=ass_res,
                    anchor_depth=task.anchor_depth,
                    yaml_flow_total=yft,
                    yaml_flow_target_index=yidx,
                    step_origin=step_origin_code(task),
                    task_source=task.task_source,
                    action_kind=task.action_kind,
                    url_before=u_b,
                    url_after=u_b,
                    screenshots=shots_fail,
                ).to_json_obj()
            )
            return "failed"

        el = (st_click.selector_map or {})[idx]
        afp = element_fingerprint(
            idx,
            task.target_branch_path_hash,
            el.tag_name,
            el.attributes or {},
            action_kind=task.action_kind,
        )
        path_key = task.dedupe_path_key

        if not dedupe.try_path(path_key):
            graph.append_queue(
                "action_skip",
                {
                    "reason": "dedupe_path",
                    "task_id": task.task_id,
                    "dedupe_path_key": path_key,
                    "anchor_url_norm": task.anchor_url_norm,
                    "event_id": event_id,
                },
            )
            yft, yidx = yaml_meta_failed_or_skipped(
                task,
                default_input_text=self.config.mock_input_text,
                bootstrap_flow_prefix=self._bootstrap_flow_prefix,
            )
            ass_dedupe = self._alloc_anchor_step_seq(task.anchor_url_norm)
            graph.append_event(
                ExplorationEvent(
                    event_id=event_id,
                    run_id=run_id,
                    ts=_ts(),
                    kind="action_result",
                    result="skipped",
                    skip_reason=SkipReason.DEDUPE_PATH.value,
                    dedupe_path_key=path_key,
                    anchor_url_norm=task.anchor_url_norm,
                    anchor_url=task.anchor_url,
                    task_id=task.task_id,
                    target_step=_target_step_dict(task, idx, input_value_used=""),
                    queue_seq=queue_seq,
                    anchor_step_seq=ass_dedupe,
                    anchor_depth=task.anchor_depth,
                    yaml_flow_total=yft,
                    yaml_flow_target_index=yidx,
                    step_origin=step_origin_code(task),
                    task_source=task.task_source,
                    action_kind=task.action_kind,
                ).to_json_obj()
            )
            return "skipped"

        # 滚动枚举任务：若目标元素不在视口内，先 scrollIntoView 再重新截 before 图
        if task.discovered_by_scroll and not getattr(el, "is_in_viewport", False):
            try:
                dom_el = await ctx.get_dom_element_by_index(idx)
                page = await ctx.get_current_page()
                await page.evaluate(
                    "el => el.scrollIntoView({block: 'center'})",
                    dom_el._element_handle if hasattr(dom_el, "_element_handle") else None,
                )
            except Exception:
                # fallback: 用坐标估算滚动
                if el.rectangle:
                    page = await ctx.get_current_page()
                    await page.evaluate(
                        f"window.scrollTo(0, {max(0, int(el.rectangle.y) - 300)})"
                    )
            await asyncio.sleep(self.config.scroll_enumerate_settle_ms / 1000.0)
            # 重新获取状态和截图
            st_click = await ctx.get_state()
            el = (st_click.selector_map or {}).get(idx, el)
            before = st_click
            obs_before = _observation(before, self.config)
            shot_before = await self._screenshot_rel(ctx, graph, "before")

        url_before_norm = obs_before["url_norm"]
        input_val = ""
        if task.action_kind == "input":
            input_val = await self._suggest_input_mock_text(
                page_url=obs_before["url"],
                page_title=obs_before["title"] or "",
                locate_prompt=task.locate_prompt,
                tap_description=task.target_description,
            )
        try:
            if task.action_kind == "input":
                eln = await ctx.get_dom_element_by_index(idx)
                await ctx.input_text_element_node(eln, input_val)
            else:
                await self._perform_click(ctx, idx)
        except Exception:
            dedupe.note_hit(SkipReason.REPLAY_FAILED)
            graph.append_queue(
                "action_skip",
                {
                    "reason": "click_failed",
                    "task_id": task.task_id,
                    "dedupe_path_key": path_key,
                    "anchor_url_norm": task.anchor_url_norm,
                    "event_id": event_id,
                },
            )
            yft, yidx = yaml_meta_failed_or_skipped(
                task,
                default_input_text=self.config.mock_input_text,
                bootstrap_flow_prefix=self._bootstrap_flow_prefix,
            )
            u_b = str(obs_before.get("url") or "")
            u_a = u_b
            try:
                st_e = await ctx.get_state()
                obs_e = _observation(st_e, self.config)
                u_a = str(obs_e.get("url") or u_b)
            except Exception:
                pass
            shot_after_fail = await self._screenshot_rel_optional(ctx, graph, "after")
            shots_click_fail: dict[str, str] = {"before": shot_before}
            if shot_after_fail:
                shots_click_fail["after"] = shot_after_fail
            ass_cf = self._alloc_anchor_step_seq(task.anchor_url_norm)
            graph.append_event(
                ExplorationEvent(
                    event_id=event_id,
                    run_id=run_id,
                    ts=_ts(),
                    kind="action_result",
                    result="failed",
                    skip_reason=SkipReason.REPLAY_FAILED.value,
                    dedupe_path_key=path_key,
                    anchor_url_norm=task.anchor_url_norm,
                    anchor_url=task.anchor_url,
                    task_id=task.task_id,
                    target_step=_target_step_dict(task, idx, input_value_used=input_val),
                    queue_seq=queue_seq,
                    anchor_step_seq=ass_cf,
                    anchor_depth=task.anchor_depth,
                    yaml_flow_total=yft,
                    yaml_flow_target_index=yidx,
                    step_origin=step_origin_code(task),
                    task_source=task.task_source,
                    action_kind=task.action_kind,
                    url_before=u_b,
                    url_after=u_a,
                    screenshots=shots_click_fail,
                ).to_json_obj()
            )
            return "failed"

        if task.action_kind == "input":
            task.input_mock_value = input_val

        stats["actions_executed"] = stats.get("actions_executed", 0) + 1

        await self._wait_post_action_settled(ctx, task=task)
        after = await ctx.get_state()
        obs_after = _observation(after, self.config)
        to_node_id = _node_id(obs_after["url_norm"], obs_after["structural_state_id"])
        graph.upsert_node(
            GraphNodeRecord(
                node_id=to_node_id,
                url_norm=obs_after["url_norm"],
                raw_url=obs_after["url"],
                structural_state_id=obs_after["structural_state_id"],
                page_state_id=obs_after["page_state_id"],
                title=obs_after["title"],
                first_seen_at=_ts(),
                last_seen_at=_ts(),
                seen_run_ids=[run_id],
            )
        )
        shot_after = await self._screenshot_rel(ctx, graph, "after")

        url_changed = obs_after["url_norm"] != url_before_norm
        edge_id = f"e_{event_id}"
        steps_payload = [
            {
                "i": s.element_index,
                "h": s.branch_path_hash,
                "d": s.tap_description,
                "p": s.locate_prompt,
                "k": s.step_kind,
                "v": s.input_value,
            }
            for s in task.prefix_steps
        ]
        pref_ref = graph.maybe_write_prefix_sidecar(edge_id, steps_payload)
        pfx_sum = _prefix_steps_summary(task.prefix_steps, self.config)
        tgt_step = _target_step_dict(task, idx, input_value_used=input_val if task.action_kind == "input" else "")

        ass_ok = self._alloc_anchor_step_seq(task.anchor_url_norm)
        yaml_rel: str | None = None
        critical = url_changed or (obs_before["structural_state_id"] != obs_after["structural_state_id"])
        if self.config.yaml_policy == "all" or critical:
            yaml_rel = self._generated_cases_yaml_relative(
                task.task_id, queue_seq, anchor_step_seq=ass_ok
            )
            ypath = graph.out_dir / yaml_rel
            ypath.parent.mkdir(parents=True, exist_ok=True)
            write_task_yaml(
                task,
                ypath,
                default_input_text=self.config.mock_input_text,
                page_title_after=str(obs_after.get("title") or ""),
                page_url_after=str(obs_after.get("url") or ""),
                bootstrap_flow_prefix=self._bootstrap_flow_prefix,
                bootstrap_target_overlay=self._bootstrap_target_overlay,
            )

        rec = GraphEdgeRecord(
            edge_id=edge_id,
            from_node_id=from_node_id,
            to_node_id=to_node_id,
            action_type=task.action_kind,
            action_fingerprint=afp,
            anchor_url_norm=task.anchor_url_norm,
            prefix_steps_ref=pref_ref,
            prefix_steps_summary=pfx_sum,
            target_step=tgt_step,
            result="ok",
            url_changed=url_changed,
            screenshots={"before": shot_before, "after": shot_after},
            run_id=run_id,
            event_id=event_id,
            dedupe_path_key=path_key,
            yaml_ref=yaml_rel,
            action_tag=infer_action_tag(
                task,
                url_before=str(obs_before.get("url") or ""),
                url_after=str(obs_after.get("url") or ""),
            ),
        )
        graph.upsert_edge(rec)

        if url_changed:
            uk = dedupe_url_key(obs_after["url_norm"])
            if dedupe.try_url(uk):
                new_urls.append(
                    UrlTask(
                        url_norm=obs_after["url_norm"],
                        raw_url=obs_after["url"],
                        anchor_depth=task.anchor_depth + 1,
                    )
                )
                graph.append_queue(
                    "url_discovered",
                    {
                        "url_norm": obs_after["url_norm"],
                        "raw_url": obs_after["url"],
                        "from_anchor_depth": task.anchor_depth,
                        "task_id": task.task_id,
                        "event_id": event_id,
                        "edge_id": edge_id,
                    },
                )

        yft, yidx = yaml_meta_single_success(
            task,
            default_input_text=self.config.mock_input_text,
            page_title_after=str(obs_after.get("title") or ""),
            page_url_after=str(obs_after.get("url") or ""),
            bootstrap_flow_prefix=self._bootstrap_flow_prefix,
        )
        ex_ok: dict[str, Any] = {}
        if prefix_flow_frames:
            ex_ok["prefix_flow_frames"] = prefix_flow_frames
        graph.append_event(
            ExplorationEvent(
                event_id=event_id,
                run_id=run_id,
                ts=_ts(),
                anchor_url_norm=task.anchor_url_norm,
                anchor_url=task.anchor_url,
                dedupe_path_key=path_key,
                from_node_id=from_node_id,
                to_node_id=to_node_id,
                edge_id=edge_id,
                url_before=obs_before["url"],
                url_after=obs_after["url"],
                structural_before=obs_before["structural_state_id"],
                structural_after=obs_after["structural_state_id"],
                page_state_before=obs_before["page_state_id"],
                page_state_after=obs_after["page_state_id"],
                action_fingerprint=afp,
                result="ok",
                skip_reason=None,
                screenshots={"before": shot_before, "after": shot_after},
                task_id=task.task_id,
                target_step=tgt_step,
                queue_seq=queue_seq,
                anchor_step_seq=ass_ok,
                anchor_depth=task.anchor_depth,
                yaml_flow_total=yft,
                yaml_flow_target_index=yidx,
                step_origin=step_origin_code(task),
                task_source=task.task_source,
                action_kind=task.action_kind,
                extra=ex_ok,
            ).to_json_obj()
        )

        self._touch_exploration_review(graph, force=False)
        return "ok"

    async def _enqueue_initial(
        self,
        graph: GraphStore,
        obs: dict[str, Any],
        anchor_url: str,
        anchor_norm: str,
        anchor_depth: int,
        run_id: str,
        dedupe: DedupeStore,
        queue: deque[ActionTask],
        stats: dict[str, Any],
        *,
        scroll_extra_indices: list[int] | None = None,
        scroll_extra_sm: dict[int, Any] | None = None,
    ) -> None:
        sm = obs["selector_map"]
        # 合并首屏 + 滚动发现的元素（滚动发现的排在后面）
        all_indices = list(obs["inview_indices"])
        viewport_hashes: set[str] = set()
        for idx in all_indices:
            viewport_hashes.add(sm[idx].hash.branch_path_hash)
        scroll_hashes: set[str] = set()
        if scroll_extra_indices and scroll_extra_sm:
            for idx in scroll_extra_indices:
                el = scroll_extra_sm[idx]
                if el.hash.branch_path_hash not in viewport_hashes:
                    all_indices.append(idx)
                    sm[idx] = el
                    scroll_hashes.add(el.hash.branch_path_hash)
        n = 0
        for idx in all_indices:
            if n >= self.config.max_initial_candidates:
                break
            el = sm[idx]
            if _is_file_input(el.attributes or {}):
                continue
            el, idx = _resolve_text_input_for_task(el, idx, sm)
            if _is_file_input(el.attributes or {}):
                continue
            bh = el.hash.branch_path_hash
            action_kind = _action_kind_for_element(el)
            fp = element_fingerprint(idx, bh, el.tag_name, el.attributes or {}, action_kind=action_kind)
            ak = dedupe_action_key(anchor_norm, obs["page_state_id"], fp)
            if not dedupe.try_action(ak):
                stats["enqueue_skipped_action_dedupe"] = stats.get("enqueue_skipped_action_dedupe", 0) + 1
                graph.append_queue(
                    "action_skip",
                    {
                        "reason": "dedupe_action",
                        "phase": "initial_enqueue",
                        "anchor_url_norm": anchor_norm,
                        "page_state_id": obs["page_state_id"],
                        "element_index": idx,
                        "action_fingerprint": fp,
                        "anchor_depth": anchor_depth,
                    },
                )
                continue
            if await self._should_skip_blacklist_for_target(
                graph,
                obs,
                run_id=run_id,
                anchor_norm=anchor_norm,
                anchor_depth=anchor_depth,
                idx=idx,
                el=el,
                fp=fp,
                action_kind=action_kind,
                stats=stats,
                phase="initial_enqueue",
            ):
                continue
            # 列表行骨架等价去重：同一 CSS 骨架的兄弟元素只入队前 max_equivalent_siblings 个
            max_eq = self.config.max_equivalent_siblings
            if max_eq > 0:
                css_hint = _safe_css_selector(el)
                skeleton = css_selector_skeleton(css_hint)
                if skeleton:
                    cnt = self._anchor_skeleton_counts.get(skeleton, 0)
                    if cnt >= max_eq:
                        stats["enqueue_skipped_equivalent_sibling"] = (
                            stats.get("enqueue_skipped_equivalent_sibling", 0) + 1
                        )
                        graph.append_queue(
                            "action_skip",
                            {
                                "reason": "equivalent_sibling",
                                "phase": "initial_enqueue",
                                "anchor_url_norm": anchor_norm,
                                "element_index": idx,
                                "css_skeleton": skeleton[:200],
                                "existing_count": cnt,
                                "max_equivalent_siblings": max_eq,
                                "anchor_depth": anchor_depth,
                            },
                        )
                        continue
                    self._anchor_skeleton_counts[skeleton] = cnt + 1

            prefix_json = canonical_prefix_steps_json([])
            pk = dedupe_path_key(anchor_norm, prefix_json, fp)
            tid = "t_" + pk[:16]
            is_scroll_discovered = bh in scroll_hashes
            self._anchor_known_element_fps.add(fp)
            queue.append(
                ActionTask(
                    task_id=tid,
                    run_id=run_id,
                    anchor_url=anchor_url,
                    anchor_url_norm=anchor_norm,
                    dedupe_path_key=pk,
                    prefix_steps=[],
                    target_index=idx,
                    target_branch_path_hash=bh,
                    target_description=_tap_desc(idx, el),
                    action_kind=action_kind,
                    locate_prompt=_locate_prompt_from_element(idx, el),
                    anchor_depth=anchor_depth,
                    discovered_by_scroll=is_scroll_discovered,
                    target_attributes_hash=getattr(getattr(el, "hash", None), "attributes_hash", ""),
                    target_tag_name=(getattr(el, "tag_name", None) or "").lower(),
                    target_css_selector_hint=_safe_css_selector(el),
                    target_text_content=re.sub(r"\s+", " ", (_el_text(el) or "").strip())[:100],
                )
            )
            graph.append_queue(
                "action_enqueue",
                {
                    "phase": "initial",
                    "task_id": tid,
                    "dedupe_path_key": pk,
                    "anchor_url_norm": anchor_norm,
                    "anchor_depth": anchor_depth,
                    "element_index": idx,
                },
            )
            n += 1

    async def _enqueue_expansion(
        self,
        graph: GraphStore,
        obs: dict[str, Any],
        anchor_url: str,
        anchor_norm: str,
        anchor_depth: int,
        run_id: str,
        completed: ActionTask,
        dedupe: DedupeStore,
        queue: deque[ActionTask],
        stats: dict[str, Any],
    ) -> None:
        if self._suppress_next_dom_expansion:
            self._suppress_next_dom_expansion = False
            stats["intent_mission_dom_expand_suppressed"] = (
                stats.get("intent_mission_dom_expand_suppressed", 0) + 1
            )
            graph.append_queue(
                "action_skip",
                {
                    "reason": "intent_mission_suppress_dom_expand",
                    "phase": "expansion_enqueue",
                    "anchor_url_norm": anchor_norm,
                    "after_task_id": completed.task_id,
                    "anchor_depth": anchor_depth,
                },
            )
            return

        sm = obs["selector_map"]
        new_prefix = list(completed.prefix_steps) + [
            ExplorationStep(
                element_index=completed.target_index,
                branch_path_hash=completed.target_branch_path_hash,
                tap_description=completed.target_description,
                locate_prompt=completed.locate_prompt,
                step_kind=completed.action_kind,
                input_value=(
                    (completed.input_mock_value or "").strip()
                    if completed.action_kind == "input"
                    else ""
                ),
                attributes_hash=completed.target_attributes_hash,
                tag_name=completed.target_tag_name,
                css_selector_hint=completed.target_css_selector_hint,
                text_content=completed.target_text_content,
            )
        ]
        if len(new_prefix) > self.config.max_prefix_depth:
            stats["enqueue_skipped_prefix_depth"] = stats.get("enqueue_skipped_prefix_depth", 0) + 1
            graph.append_queue(
                "action_skip",
                {
                    "reason": "prefix_depth",
                    "phase": "expansion",
                    "anchor_url_norm": anchor_norm,
                    "after_task_id": completed.task_id,
                    "anchor_depth": anchor_depth,
                },
            )
            return
        # 跨页（规范化 URL 已与锚点不一致）时：新页的可点元素应留给后续「该 URL 作为锚点」的探索，
        # 不在本会话的 action 队列继续扩队（否则会混入新页索引；对应 URL 已通过 UrlTask 进入 pending）。
        if obs["url_norm"] != anchor_norm:
            stats["enqueue_skipped_cross_url_expansion"] = stats.get("enqueue_skipped_cross_url_expansion", 0) + 1
            graph.append_queue(
                "action_skip",
                {
                    "reason": "cross_url_skip_expansion",
                    "phase": "expansion_enqueue",
                    "anchor_url_norm": anchor_norm,
                    "current_url_norm": obs["url_norm"],
                    "after_task_id": completed.task_id,
                    "anchor_depth": anchor_depth,
                },
            )
            return

        prefix_json = canonical_prefix_steps_json([{"i": s.element_index, "h": s.branch_path_hash} for s in new_prefix])
        for idx in obs["inview_indices"]:
            el = sm[idx]
            if _is_file_input(el.attributes or {}):
                continue
            el, idx = _resolve_text_input_for_task(el, idx, sm)
            if _is_file_input(el.attributes or {}):
                continue
            bh = el.hash.branch_path_hash
            action_kind = _action_kind_for_element(el)
            fp = element_fingerprint(idx, bh, el.tag_name, el.attributes or {}, action_kind=action_kind)
            ak = dedupe_action_key(anchor_norm, obs["page_state_id"], fp)
            if not dedupe.try_action(ak):
                stats["enqueue_skipped_action_dedupe"] = stats.get("enqueue_skipped_action_dedupe", 0) + 1
                graph.append_queue(
                    "action_skip",
                    {
                        "reason": "dedupe_action",
                        "phase": "expansion_enqueue",
                        "anchor_url_norm": anchor_norm,
                        "page_state_id": obs["page_state_id"],
                        "after_task_id": completed.task_id,
                        "element_index": idx,
                        "action_fingerprint": fp,
                        "anchor_depth": anchor_depth,
                    },
                )
                continue
            # 扩队去重：如果该元素在本锚点已被入队过（初始 or 之前的扩队），跳过，
            # 仅入队操作后新出现的控件（URL 未变前提下已由上方 cross_url 检查保证）。
            if fp in self._anchor_known_element_fps:
                stats["enqueue_skipped_expansion_known_fp"] = (
                    stats.get("enqueue_skipped_expansion_known_fp", 0) + 1
                )
                graph.append_queue(
                    "action_skip",
                    {
                        "reason": "expansion_known_element_fp",
                        "phase": "expansion_enqueue",
                        "anchor_url_norm": anchor_norm,
                        "after_task_id": completed.task_id,
                        "element_index": idx,
                        "element_fingerprint": fp,
                        "anchor_depth": anchor_depth,
                    },
                )
                continue
            # 列表行骨架等价去重（扩队）
            max_eq = self.config.max_equivalent_siblings
            if max_eq > 0:
                css_hint = _safe_css_selector(el)
                skeleton = css_selector_skeleton(css_hint)
                if skeleton:
                    cnt = self._anchor_skeleton_counts.get(skeleton, 0)
                    if cnt >= max_eq:
                        stats["enqueue_skipped_equivalent_sibling"] = (
                            stats.get("enqueue_skipped_equivalent_sibling", 0) + 1
                        )
                        graph.append_queue(
                            "action_skip",
                            {
                                "reason": "equivalent_sibling",
                                "phase": "expansion_enqueue",
                                "anchor_url_norm": anchor_norm,
                                "after_task_id": completed.task_id,
                                "element_index": idx,
                                "css_skeleton": skeleton[:200],
                                "existing_count": cnt,
                                "max_equivalent_siblings": max_eq,
                                "anchor_depth": anchor_depth,
                            },
                        )
                        continue
                    self._anchor_skeleton_counts[skeleton] = cnt + 1

            if await self._should_skip_blacklist_for_target(
                graph,
                obs,
                run_id=run_id,
                anchor_norm=anchor_norm,
                anchor_depth=anchor_depth,
                idx=idx,
                el=el,
                fp=fp,
                action_kind=action_kind,
                stats=stats,
                phase="expansion_enqueue",
            ):
                continue
            pk = dedupe_path_key(anchor_norm, prefix_json, fp)
            tid = "t_" + pk[:16]
            self._anchor_known_element_fps.add(fp)
            queue.append(
                ActionTask(
                    task_id=tid,
                    run_id=run_id,
                    anchor_url=anchor_url,
                    anchor_url_norm=anchor_norm,
                    dedupe_path_key=pk,
                    prefix_steps=new_prefix,
                    target_index=idx,
                    target_branch_path_hash=bh,
                    target_description=_tap_desc(idx, el),
                    action_kind=action_kind,
                    locate_prompt=_locate_prompt_from_element(idx, el),
                    anchor_depth=anchor_depth,
                    target_attributes_hash=getattr(getattr(el, "hash", None), "attributes_hash", ""),
                    target_tag_name=(getattr(el, "tag_name", None) or "").lower(),
                    target_css_selector_hint=_safe_css_selector(el),
                    target_text_content=re.sub(r"\s+", " ", (_el_text(el) or "").strip())[:100],
                )
            )
            graph.append_queue(
                "action_enqueue",
                {
                    "phase": "expansion",
                    "task_id": tid,
                    "dedupe_path_key": pk,
                    "anchor_url_norm": anchor_norm,
                    "anchor_depth": anchor_depth,
                    "after_task_id": completed.task_id,
                    "element_index": idx,
                },
            )

    async def _explore_anchor_strict_phases(
        self,
        browser: Browser,
        anchor_url: str,
        anchor_norm: str,
        anchor_depth: int,
        graph: GraphStore,
        dedupe: DedupeStore,
        run_id: str,
        stats: dict[str, Any],
        budget_truncation_segments: list[dict[str, Any]],
        prior: set[str],
        queue: deque[ActionTask],
        new_urls: list[UrlTask],
        out_dir: Path,
        *,
        resume_checkpoint: CurrentAnchorState | None = None,
    ) -> None:
        anchor_ok_actions = 0
        bn = stats.get("anchor_ok_baseline_norm")
        if bn and str(bn) == anchor_norm:
            anchor_ok_actions = int(stats.get("anchor_ok_baseline", 0) or 0)

        rk_phase = "during_phase_a"
        if resume_checkpoint is not None:
            rk_phase = (
                getattr(resume_checkpoint, "strict_resume_phase", "") or "during_phase_a"
            ).strip() or "during_phase_a"
        if rk_phase not in ("during_phase_a", "post_phase_a", "post_intent_late"):
            rk_phase = "during_phase_a"
        skip_phase_a = resume_checkpoint is not None and rk_phase in ("post_phase_a", "post_intent_late")
        skip_until_phase_b = resume_checkpoint is not None and rk_phase == "post_intent_late"

        # 从 post_phase_a 断点接续时整块跳过阶段 A，会绕过阶段 A 收尾时的 flush；补一次以保持 session 快照与队列一致。
        if skip_phase_a and not skip_until_phase_b:
            self._flush_exploration_anchor_checkpoint(
                anchor_url=anchor_url,
                anchor_norm=anchor_norm,
                anchor_depth=anchor_depth,
                queue=queue,
                anchor_ok_actions=anchor_ok_actions,
                strict_resume_phase="post_phase_a",
            )

        async def _trunc_run_total(*, after_success: bool) -> None:
            budget_truncation_segments.append(
                {
                    "phase": "run_total_actions",
                    "reason": "max_total_actions_after_success" if after_success else "max_total_actions",
                    "anchor_url": anchor_url,
                    "anchor_url_norm": anchor_norm,
                    "anchor_depth": anchor_depth,
                    "max_total_actions": self.config.max_total_actions,
                    "actions_executed_at_truncation": int(stats.get("actions_executed", 0) or 0),
                }
            )
            graph.append_queue(
                "budget_truncated",
                {
                    "phase": "run_total_actions",
                    "reason": "max_total_actions",
                    "anchor_url_norm": anchor_norm,
                    "anchor_depth": anchor_depth,
                    "max_total_actions": self.config.max_total_actions,
                },
            )

        async def _one_step(task: ActionTask, *, exploration_phase_local: str) -> bool:
            """每步：关闭上一轮窗口 → 新开 BrowserContext → 完整 Agent 重放 bootstrap（若存在）→
            导航锚点 → 重放前缀 → 执行目标任务 → 扩展枚举。
            返回 True 表示应结束本锚点（全 run 预算）。"""
            nonlocal anchor_ok_actions
            if stats["actions_executed"] >= self.config.max_total_actions:
                await _trunc_run_total(after_success=False)
                return True
            qseq = graph.append_queue(
                "action_dequeue",
                {
                    "task_id": task.task_id,
                    "dedupe_path_key": task.dedupe_path_key,
                    "anchor_depth": task.anchor_depth,
                    "anchor_url_norm": task.anchor_url_norm,
                    "exploration_phase": exploration_phase_local,
                },
            )
            task_ctx = self._create_task_browser_context(browser)
            try:
                if not self._should_skip_bootstrap_replay():
                    await self._replay_bootstrap_agent_if_yaml(
                        task_ctx, out_dir, log_subdir=f"{qseq}_{task.task_id}"
                    )
                # bootstrap 已导航到锚点时勿重复 goto，以免整页重载冲掉 SPA hydration（首轮枚举与单步执行一致）
                await self._maybe_goto_anchor(task_ctx, task.anchor_url)
                await self._settle_after_task_nav()
                await task_ctx.get_state()
                rp_ok, pfx_frames = await self._replay_prefix_with_flow_shots(task_ctx, graph, task.prefix_steps)
                if not rp_ok:
                    stats["failed_replays"] = stats.get("failed_replays", 0) + 1
                    graph.append_queue(
                        "action_skip",
                        {
                            "reason": "replay_failed",
                            "task_id": task.task_id,
                            "dedupe_path_key": task.dedupe_path_key,
                            "anchor_url_norm": task.anchor_url_norm,
                        },
                    )
                    return False
                outcome = await self._execute_click_task(
                    task_ctx,
                    graph,
                    dedupe,
                    task,
                    new_urls=new_urls,
                    stats=stats,
                    queue_seq=qseq,
                    prefix_flow_frames=pfx_frames,
                )
                if outcome != "ok":
                    return False
                anchor_ok_actions += 1
                self._log_explore_progress(
                    stats,
                    pending=None,
                    anchor_norm=anchor_norm,
                    anchor_ok=anchor_ok_actions,
                    action_queue_len=len(queue),
                    run_id=run_id,
                    note=f"strict·{exploration_phase_local} 步",
                    force=False,
                )
                if stats["actions_executed"] >= self.config.max_total_actions:
                    await _trunc_run_total(after_success=True)
                    return True
                st2 = await task_ctx.get_state()
                obs2 = _observation(st2, self.config)
                _log_enumeration_round(
                    graph, st2, obs2, source="pre_expansion_enqueue", anchor_depth=anchor_depth, cfg=self.config
                )
                expand_src = _synth_from_composite(task) if task.task_kind == "composite" else task
                await self._enqueue_expansion(
                    graph,
                    obs2,
                    anchor_url,
                    anchor_norm,
                    anchor_depth,
                    run_id,
                    expand_src,
                    dedupe,
                    queue,
                    stats,
                )
                phase_ck = (
                    "post_intent_late" if exploration_phase_local == "B" else "during_phase_a"
                )
                self._flush_exploration_anchor_checkpoint(
                    anchor_url=anchor_url,
                    anchor_norm=anchor_norm,
                    anchor_depth=anchor_depth,
                    queue=queue,
                    anchor_ok_actions=anchor_ok_actions,
                    strict_resume_phase=phase_ck,
                )
                return False
            finally:
                await task_ctx.close()

        # 阶段 A：仅单步；遇 composite 则结束 A；达 max_actions 后若启用意图预留，仅继续消费 intent_mission
        if not skip_phase_a:
            while True:
                if stats["actions_executed"] >= self.config.max_total_actions:
                    await _trunc_run_total(after_success=False)
                    break
                if not queue:
                    break
                if queue[0].task_kind == "composite":
                    break
                nxt = self._dequeue_next_anchor_task(
                    queue, anchor_ok_actions, phase_a_skip_composite=True
                )
                if nxt is None:
                    break
                stop = await _one_step(nxt, exploration_phase_local="A")
                if stop:
                    break
            self._flush_exploration_anchor_checkpoint(
                anchor_url=anchor_url,
                anchor_norm=anchor_norm,
                anchor_depth=anchor_depth,
                queue=queue,
                anchor_ok_actions=anchor_ok_actions,
                strict_resume_phase="post_phase_a",
            )

        _intent_replaces_composite = (
            self.config.intent_missions_enabled and self.config.intent_missions_replace_composite_planners
        )
        if (
            not skip_until_phase_b
            and not _intent_replaces_composite
            and not queue
            and self.config.graph_guided_composite_enabled
            and self.config.composite_enabled
            and anchor_ok_actions < self.config.max_actions
            and stats["actions_executed"] < self.config.max_total_actions
        ):
            obs_plan: dict[str, Any] | None = None
            need_snap = (
                (self.config.composite_coherence_enabled and self.config.composite_coherence_mode != "off")
                or (self._ensure_skip_evaluator() is not None)
            )
            if need_snap:
                plan_ctx = self._create_task_browser_context(browser)
                try:
                    await self._replay_bootstrap_agent_if_yaml(
                        plan_ctx, out_dir, log_subdir="graph_guided_plan"
                    )
                    await self._maybe_goto_anchor(plan_ctx, anchor_url)
                    await self._settle_after_task_nav()
                    st_p = await plan_ctx.get_state()
                    obs_plan = _observation(st_p, self.config)
                finally:
                    await plan_ctx.close()
            blocked_gg = set(prior)
            blocked_gg |= dedupe.seen_path
            vw_pl, vh_pl = self._viewport_dimensions()
            sm_pl = (obs_plan or {}).get("selector_map") if isinstance(obs_plan, dict) else None
            gg_tasks = plan_graph_guided_composite_tasks(
                graph=graph,
                anchor_url=anchor_url,
                anchor_norm=anchor_norm,
                anchor_depth=anchor_depth,
                run_id=run_id,
                cfg=self.config,
                blocked_path_keys=blocked_gg,
                selector_map=sm_pl if isinstance(sm_pl, dict) else None,
                viewport_wh=(vw_pl, vh_pl),
                stats_sink=stats,
            )
            obs_for_bl = obs_plan or {
                "url": anchor_url,
                "title": "",
                "selector_map": sm_pl if isinstance(sm_pl, dict) else {},
            }
            gg_tasks = await self._filter_composite_tasks_blacklist(
                gg_tasks,
                obs_for_bl,
                graph,
                run_id,
                anchor_norm,
                anchor_depth,
                stats,
            )
            if gg_tasks:
                stats["graph_guided_composite_enqueued"] = stats.get("graph_guided_composite_enqueued", 0) + len(
                    gg_tasks
                )
                for ct in gg_tasks:
                    queue.append(ct)
                    graph.append_queue(
                        "action_enqueue",
                        {
                            "phase": "strict_graph_composite_seed",
                            "task_id": ct.task_id,
                            "dedupe_path_key": ct.dedupe_path_key,
                            "anchor_url_norm": anchor_norm,
                            "anchor_depth": anchor_depth,
                            "task_kind": "composite",
                            "task_source": ct.task_source,
                            "composite_plan_id": ct.composite_plan_id,
                        },
                    )

        strict_can_seed_b = (
            not skip_until_phase_b
            and not _intent_replaces_composite
            and not queue
            and stats["actions_executed"] < self.config.max_total_actions
            and anchor_ok_actions < self.config.max_actions
            and self.config.composite_enabled
        )
        planned_b = None
        if strict_can_seed_b:
            seed_ctx = self._create_task_browser_context(browser)
            try:
                await self._replay_bootstrap_agent_if_yaml(seed_ctx, out_dir, log_subdir="composite_seed")
                st_seed = await seed_ctx.get_state()
                planned_b = plan_composite_tasks_for_anchor(
                    state=st_seed,
                    anchor_url=anchor_url,
                    anchor_norm=anchor_norm,
                    anchor_depth=anchor_depth,
                    run_id=run_id,
                    cfg=self.config,
                    prior_path_keys=prior,
                    scroll_first=False,
                    scroll_delta_y=self.config.scroll_delta_y_px,
                    stats_sink=stats,
                )
                planned_b = await self._filter_composite_tasks_blacklist(
                    planned_b,
                    _observation(st_seed, self.config),
                    graph,
                    run_id,
                    anchor_norm,
                    anchor_depth,
                    stats,
                )
            finally:
                await seed_ctx.close()
            if planned_b:
                stats["composite_phase_enqueued"] = stats.get("composite_phase_enqueued", 0) + len(planned_b)
                for ct in planned_b:
                    queue.append(ct)
                    graph.append_queue(
                        "action_enqueue",
                        {
                            "phase": "strict_composite_seed",
                            "task_id": ct.task_id,
                            "dedupe_path_key": ct.dedupe_path_key,
                            "anchor_url_norm": anchor_norm,
                            "anchor_depth": anchor_depth,
                            "task_kind": "composite",
                            "task_source": ct.task_source,
                            "composite_plan_id": ct.composite_plan_id,
                        },
                    )
            else:
                graph.append_queue(
                    "composite_phase_skipped",
                    {
                        "reason": "strict_phase_a_end_no_plans",
                        "anchor_url_norm": anchor_norm,
                        "anchor_depth": anchor_depth,
                    },
                )

        # 单步（Phase A）+ 扩对（含 graph_guided composite）已结束，开始基于已累积的成功边规划高价值意图任务。
        if not skip_until_phase_b:
            await self._plan_intent_missions_late(
                browser=browser,
                graph=graph,
                anchor_url=anchor_url,
                anchor_norm=anchor_norm,
                anchor_depth=anchor_depth,
                run_id=run_id,
                queue=queue,
                stats=stats,
                dedupe=dedupe,
                prior_path_keys=prior,
                out_dir=out_dir,
            )
            self._flush_exploration_anchor_checkpoint(
                anchor_url=anchor_url,
                anchor_norm=anchor_norm,
                anchor_depth=anchor_depth,
                queue=queue,
                anchor_ok_actions=anchor_ok_actions,
                strict_resume_phase="post_intent_late",
            )

        while stats["actions_executed"] < self.config.max_total_actions:
            nxt = self._dequeue_next_anchor_task(
                queue, anchor_ok_actions, phase_a_skip_composite=False
            )
            if nxt is None:
                break
            if stats["actions_executed"] >= self.config.max_total_actions:
                await _trunc_run_total(after_success=False)
                break
            stop = await _one_step(nxt, exploration_phase_local="B")
            if stop:
                break

        if queue and not self._anchor_has_any_runnable_task(queue, anchor_ok_actions):
            stats["anchor_ok_baseline"] = anchor_ok_actions
            stats["anchor_ok_baseline_norm"] = anchor_norm
            lim = 50
            qlist = list(queue)
            samples = [_action_task_budget_sample(t) for t in qlist[:lim]]
            budget_truncation_segments.append(
                {
                    "phase": "anchor_action_queue",
                    "reason": "max_actions_per_anchor",
                    "anchor_url": anchor_url,
                    "anchor_url_norm": anchor_norm,
                    "anchor_depth": anchor_depth,
                    "max_actions_per_anchor": self.config.max_actions,
                    "intent_mission_reserved_actions": self._intent_mission_reserve_cap(),
                    "anchor_ok_actions": anchor_ok_actions,
                    "remaining_count": len(qlist),
                    "sample_limit": lim,
                    "samples": samples,
                }
            )
            graph.append_queue(
                "budget_truncated",
                {
                    "phase": "anchor_action_queue",
                    "reason": "max_actions_per_anchor",
                    "remaining_count": len(qlist),
                    "anchor_depth": anchor_depth,
                    "anchor_url_norm": anchor_norm,
                    "max_actions_per_anchor": self.config.max_actions,
                    "intent_mission_reserved_actions": self._intent_mission_reserve_cap(),
                },
            )

    async def _explore_anchor(
        self,
        browser: Browser,
        anchor_url: str,
        anchor_depth: int,
        graph: GraphStore,
        dedupe: DedupeStore,
        run_id: str,
        stats: dict[str, Any],
        budget_truncation_segments: list[dict[str, Any]],
        prior_path_keys: set[str] | None = None,
        *,
        reuse_context: RelaxedLoadBrowserContext | None = None,
        seen_structural_state: set[str] | None = None,
        anchor_resume_checkpoint: CurrentAnchorState | None = None,
    ) -> list[UrlTask]:
        anchor_norm = normalize_url(
            anchor_url,
            strip_trailing_slash=self.config.url_strip_trailing_slash,
            keep_fragment=self.config.url_keep_fragment,
        )
        self._suppress_next_dom_expansion = False
        self._anchor_known_element_fps = set()
        self._anchor_skeleton_counts = {}
        # 每锚点重置「late 规划已触发」标记：保证非 strict 路径下每个锚点最多触发一次后期意图规划。
        self._late_intent_planned_for_anchor = False
        queue: deque[ActionTask] = deque()
        new_urls: list[UrlTask] = []

        shot_until = self.config.page_goto_wait_until
        if shot_until == "commit":
            shot_until = "domcontentloaded"
        # run() 在 bootstrap_same_session 时传入的上下文仅用于推导入口 URL；首轮枚举若直接复用，
        # DOM 与「每条队列任务：新开上下文 → 完整 bootstrap → navigate 锚点」不一致，导致索引/business resolve_failed。
        if reuse_context is not None:
            try:
                await reuse_context.close()
            except Exception:
                logger.debug("closing reuse_context before aligned enumeration failed", exc_info=True)
        enum_ctx = RelaxedLoadBrowserContext(
            browser=browser,
            config=self._browser_context_config_from_bootstrap_overlay(),
            screenshot_wait_timeout_ms=self.config.page_goto_timeout_ms,
            screenshot_capture_timeout_ms=self.config.page_screenshot_timeout_ms,
            screenshot_wait_until=shot_until,
        )
        ctx: RelaxedLoadBrowserContext | None = enum_ctx

        rk_eff: CurrentAnchorState | None = None
        ca_req = anchor_resume_checkpoint
        if ca_req is not None:
            if not self.config.strict_phase_traversal:
                graph.append_queue(
                    "explorer_anchor_resume_checkpoint_ignored",
                    {
                        "reason": "non_strict_phase_traversal",
                        "checkpoint_url_norm": ca_req.url_norm,
                        "anchor_url_norm": anchor_norm,
                    },
                )
            elif (
                ca_req.url_norm != anchor_norm
                or int(ca_req.anchor_depth) != int(anchor_depth)
            ):
                graph.append_queue(
                    "explorer_anchor_resume_checkpoint_mismatch",
                    {
                        "checkpoint_url_norm": ca_req.url_norm,
                        "checkpoint_anchor_depth": int(ca_req.anchor_depth),
                        "job_url_norm": anchor_norm,
                        "job_anchor_depth": int(anchor_depth),
                    },
                )
            else:
                rk_eff = ca_req
        resume_strict_ok = rk_eff is not None

        try:
            if resume_strict_ok and rk_eff is not None:
                rk = rk_eff
                queue.extend(list(rk.action_queue))
                stats["anchor_ok_baseline_norm"] = anchor_norm
                stats["anchor_ok_baseline"] = int(rk.anchor_ok_actions or 0)
                graph.append_queue(
                    "explorer_resume_anchor_checkpoint",
                    {
                        "anchor_url_norm": anchor_norm,
                        "anchor_depth": anchor_depth,
                        "restored_task_count": len(rk.action_queue),
                        "strict_resume_phase": getattr(rk, "strict_resume_phase", "") or "",
                        "anchor_ok_actions_snapshot": int(rk.anchor_ok_actions or 0),
                    },
                )
                await enum_ctx.close()
                ctx = None
                await self._explore_anchor_strict_phases(
                    browser,
                    anchor_url,
                    anchor_norm,
                    anchor_depth,
                    graph,
                    dedupe,
                    run_id,
                    stats,
                    budget_truncation_segments,
                    prior,
                    queue,
                    new_urls,
                    graph.out_dir,
                    resume_checkpoint=rk,
                )
            if not resume_strict_ok:
                # 与 _one_step / 非 strict 队列循环相同的准备顺序，保证首轮入队时的 element_index 与执行时一致。
                if not self._should_skip_bootstrap_replay():
                    await self._replay_bootstrap_agent_if_yaml(
                        enum_ctx, graph.out_dir, log_subdir="initial_enqueue"
                    )
                # 与锚点 URL 一致则跳过二次 goto，避免冲掉 bootstrap+sleep 后的渲染态（此前易导致首轮 candidates 为空）
                await self._maybe_goto_anchor(enum_ctx, anchor_url)
                await self._settle_after_task_nav()
                st = await enum_ctx.get_state()
                obs = _observation(st, self.config)
                _log_enumeration_round(
                    graph, st, obs, source="pre_initial_enqueue", anchor_depth=anchor_depth, cfg=self.config
                )
                if seen_structural_state is not None:
                    page_struct = obs.get("structural_state_id") or ""
                    if page_struct:
                        if page_struct in seen_structural_state:
                            # 同一页面（不同 URL）已探索过：跳过本锚点的扩对/意图，避免对同构页面做无意义的重复枚举。
                            graph.append_queue(
                                "url_skip_state_dup",
                                {
                                    "reason": "page_state_duplicate",
                                    "url_norm": anchor_norm,
                                    "raw_url": anchor_url,
                                    "anchor_depth": anchor_depth,
                                    "structural_state_id": page_struct[:32],
                                },
                            )
                            stats["url_skipped_state_dup"] = (
                                stats.get("url_skipped_state_dup", 0) + 1
                            )
                            await enum_ctx.close()
                            ctx = None
                            self._clear_exploration_anchor_checkpoint()
                            return []
                        seen_structural_state.add(page_struct)
                prior = set(prior_path_keys or ())
                blocked_for_intent = set(prior)
                blocked_for_intent |= dedupe.seen_path
                # 滚动枚举：首轮入队阶段通过多轮滚动覆盖视口外元素
                scroll_extra_indices: list[int] | None = None
                scroll_extra_sm: dict[int, Any] | None = None
                if self.config.scroll_enumerate_enabled:
                    scroll_extra_indices, scroll_extra_sm, _ = await _scroll_enumerate(
                        enum_ctx, self.config, obs
                    )
                    if scroll_extra_indices:
                        logger.info(
                            "scroll_enumerate: 发现 %d 个视口外元素", len(scroll_extra_indices)
                        )
                await self._enqueue_initial(
                    graph, obs, anchor_url, anchor_norm, anchor_depth, run_id, dedupe, queue, stats,
                    scroll_extra_indices=scroll_extra_indices,
                    scroll_extra_sm=scroll_extra_sm,
                )
                await self._maybe_enqueue_intent_missions(
                    graph,
                    obs,
                    anchor_url,
                    anchor_norm,
                    anchor_depth,
                    run_id,
                    queue,
                    stats,
                    enum_state=st,
                    blocked_path_keys=blocked_for_intent,
                )
                self._log_explore_progress(
                    stats,
                    pending=None,
                    anchor_norm=anchor_norm,
                    anchor_ok=0,
                    action_queue_len=len(queue),
                    run_id=run_id,
                    note="锚点首轮入队完成",
                    force=True,
                )

                await enum_ctx.close()
                ctx = None

                if self.config.strict_phase_traversal:
                    await self._explore_anchor_strict_phases(
                        browser,
                        anchor_url,
                        anchor_norm,
                        anchor_depth,
                        graph,
                        dedupe,
                        run_id,
                        stats,
                        budget_truncation_segments,
                        prior,
                        queue,
                        new_urls,
                        graph.out_dir,
                    )
                else:
                    anchor_ok_actions = 0
                    bn0 = stats.get("anchor_ok_baseline_norm")
                    if bn0 and str(bn0) == anchor_norm:
                        anchor_ok_actions = int(stats.get("anchor_ok_baseline", 0) or 0)
                    while True:
                        if stats.get("actions_executed", 0) >= self.config.max_total_actions:
                            budget_truncation_segments.append(
                                {
                                    "phase": "run_total_actions",
                                    "reason": "max_total_actions",
                                    "anchor_url": anchor_url,
                                    "anchor_url_norm": anchor_norm,
                                    "anchor_depth": anchor_depth,
                                    "max_total_actions": self.config.max_total_actions,
                                    "actions_executed_at_truncation": int(stats.get("actions_executed", 0) or 0),
                                }
                            )
                            graph.append_queue(
                                "budget_truncated",
                                {
                                    "phase": "run_total_actions",
                                    "reason": "max_total_actions",
                                    "anchor_url_norm": anchor_norm,
                                    "anchor_depth": anchor_depth,
                                    "max_total_actions": self.config.max_total_actions,
                                },
                            )
                            break
                        task = self._dequeue_next_anchor_task(
                            queue, anchor_ok_actions, phase_a_skip_composite=False
                        )
                        if task is None:
                            # 非 strict 路径：queue 自然排空时，**才**触发意图规划，保证规划用到了
                            # 单步 + 扩对累积下来的成功边/枚举数据。late hook 仅触发一次：注入后再重试 dequeue。
                            if not getattr(self, "_late_intent_planned_for_anchor", False):
                                self._late_intent_planned_for_anchor = True
                                await self._plan_intent_missions_late(
                                    browser=browser,
                                    graph=graph,
                                    anchor_url=anchor_url,
                                    anchor_norm=anchor_norm,
                                    anchor_depth=anchor_depth,
                                    run_id=run_id,
                                    queue=queue,
                                    stats=stats,
                                    dedupe=dedupe,
                                    prior_path_keys=prior,
                                    out_dir=graph.out_dir,
                                )
                                task = self._dequeue_next_anchor_task(
                                    queue, anchor_ok_actions, phase_a_skip_composite=False
                                )
                            if task is None:
                                break
                        qseq = graph.append_queue(
                            "action_dequeue",
                            {
                                "task_id": task.task_id,
                                "dedupe_path_key": task.dedupe_path_key,
                                "anchor_depth": task.anchor_depth,
                                "anchor_url_norm": task.anchor_url_norm,
                            },
                        )
                        task_ctx = self._create_task_browser_context(browser)
                        try:
                            if not self._should_skip_bootstrap_replay():
                                await self._replay_bootstrap_agent_if_yaml(
                                    task_ctx, graph.out_dir, log_subdir=f"{qseq}_{task.task_id}"
                                )
                            await self._maybe_goto_anchor(task_ctx, task.anchor_url)
                            await self._settle_after_task_nav()
                            await task_ctx.get_state()
                            rp_ok, pfx_frames = await self._replay_prefix_with_flow_shots(task_ctx, graph, task.prefix_steps)
                            if not rp_ok:
                                stats["failed_replays"] = stats.get("failed_replays", 0) + 1
                                graph.append_queue(
                                    "action_skip",
                                    {
                                        "reason": "replay_failed",
                                        "task_id": task.task_id,
                                        "dedupe_path_key": task.dedupe_path_key,
                                        "anchor_url_norm": task.anchor_url_norm,
                                    },
                                )
                                continue
                            outcome = await self._execute_click_task(
                                task_ctx,
                                graph,
                                dedupe,
                                task,
                                new_urls=new_urls,
                                stats=stats,
                                queue_seq=qseq,
                                prefix_flow_frames=pfx_frames,
                            )
                            if outcome != "ok":
                                continue
                            anchor_ok_actions += 1
                            self._log_explore_progress(
                                stats,
                                pending=None,
                                anchor_norm=anchor_norm,
                                anchor_ok=anchor_ok_actions,
                                action_queue_len=len(queue),
                                run_id=run_id,
                                note="动作成功",
                                force=False,
                            )
                            st2 = await task_ctx.get_state()
                            obs2 = _observation(st2, self.config)
                            _log_enumeration_round(
                                graph, st2, obs2, source="pre_expansion_enqueue", anchor_depth=anchor_depth, cfg=self.config
                            )
                            await self._enqueue_expansion(
                                graph,
                                obs2,
                                anchor_url,
                                anchor_norm,
                                anchor_depth,
                                run_id,
                                task,
                                dedupe,
                                queue,
                                stats,
                            )
                        finally:
                            await task_ctx.close()
                    if queue and not self._anchor_has_any_runnable_task(queue, anchor_ok_actions):
                        stats["anchor_ok_baseline"] = anchor_ok_actions
                        stats["anchor_ok_baseline_norm"] = anchor_norm
                        lim = 50
                        qlist = list(queue)
                        samples = [_action_task_budget_sample(t) for t in qlist[:lim]]
                        budget_truncation_segments.append(
                            {
                                "phase": "anchor_action_queue",
                                "reason": "max_actions_per_anchor",
                                "anchor_url": anchor_url,
                                "anchor_url_norm": anchor_norm,
                                "anchor_depth": anchor_depth,
                                "max_actions_per_anchor": self.config.max_actions,
                                "intent_mission_reserved_actions": self._intent_mission_reserve_cap(),
                                "anchor_ok_actions": anchor_ok_actions,
                                "remaining_count": len(qlist),
                                "sample_limit": lim,
                                "samples": samples,
                            }
                        )
                        graph.append_queue(
                            "budget_truncated",
                            {
                                "phase": "anchor_action_queue",
                                "reason": "max_actions_per_anchor",
                                "remaining_count": len(qlist),
                                "anchor_depth": anchor_depth,
                                "anchor_url_norm": anchor_norm,
                                "max_actions_per_anchor": self.config.max_actions,
                                "intent_mission_reserved_actions": self._intent_mission_reserve_cap(),
                            },
                        )
            if not queue:
                stats.pop("anchor_ok_baseline", None)
                stats.pop("anchor_ok_baseline_norm", None)
            self._log_explore_progress(
                stats,
                pending=None,
                anchor_norm=anchor_norm,
                anchor_ok=None,
                action_queue_len=len(queue),
                run_id=run_id,
                note="锚点会话收尾",
                force=True,
            )
            self._touch_exploration_review(graph, force=True)
            self._clear_exploration_anchor_checkpoint()
        finally:
            if ctx is not None:
                await ctx.close()

        return new_urls

    def _emit_terminal_exploration_artifacts(
        self,
        *,
        graph: GraphStore,
        entry_url: str,
        run_id: str,
        start_ctx: StartContext,
        stats: dict[str, Any],
        dedupe: DedupeStore,
        budget_truncation_segments: list[dict[str, Any]],
        session_file: Path,
        sp: SessionPayload | None,
        interruption: BaseException | None,
    ) -> Path:
        """
        正常结束或主循环/探索抛错后均调用：写出 graph.json、timeline、review_timeline.html、exploration_report.md，
        便于中断/失败后仍能打开 HTML 审查。
        """
        if interruption is not None:
            stats.setdefault(
                "exploration_abort_exception",
                f"{type(interruption).__name__}: {interruption}",
            )
            if sp is not None:
                sp.status = "failed"
                sp.active_url_task = None
                sp.touch()
                write_session_state(session_file, sp)
        else:
            if sp is not None:
                sp.status = "completed"
                sp.active_url_task = None
                sp.touch()
                write_session_state(session_file, sp)

        stats["max_actions_scope"] = "per_anchor_url"
        stats["max_actions_per_anchor"] = self.config.max_actions

        if budget_truncation_segments:
            trunc_doc = {
                "schema": "exploration-budget-truncation/v1",
                "budget_scope": "per_anchor_url",
                "max_actions_per_anchor": self.config.max_actions,
                "max_actions": self.config.max_actions,
                "final_actions_executed": int(stats.get("actions_executed", 0) or 0),
                "segments": budget_truncation_segments,
            }
            tp = graph.out_dir / "budget_truncation.json"
            tp.write_text(json.dumps(trunc_doc, ensure_ascii=False, indent=2), encoding="utf-8")

        stats["dedupe_hits"] = dict(dedupe.hits)
        run_meta: dict[str, Any] = {
            "entry_url": entry_url,
            "exploration_depth": self.config.exploration_depth,
            "execution_mode": self.config.execution_mode.value,
            "yaml_policy": self.config.yaml_policy,
            "generated_cases_filename_mode": self.config.generated_cases_filename_mode,
            "generated_cases_include_anchor_step_seq": self.config.generated_cases_include_anchor_step_seq,
            "strict_phase_traversal": self.config.strict_phase_traversal,
            "start_context": start_ctx.to_run_meta_dict(),
            "filter_summary": {
                "skip_blacklist_hits": int(stats.get("skip_blacklist_hits", 0) or 0),
                "skip_blacklist_semantic_hits": int(stats.get("skip_blacklist_semantic_hits", 0) or 0),
                "skip_blacklist_structured_hits": int(stats.get("skip_blacklist_structured_hits", 0) or 0),
                "coherence_strict_dropped": int(stats.get("coherence_strict_dropped", 0) or 0),
                "coherence_rank_deprioritized": int(stats.get("coherence_rank_deprioritized", 0) or 0),
            },
        }
        if interruption is not None:
            run_meta["run_interrupted"] = True
            run_meta["interrupted_exception"] = repr(interruption)
        graph.write_graph(run_meta)
        review_html_path, timeline_json_path = generate_exploration_review(graph.out_dir)
        trunc_path = graph.out_dir / "budget_truncation.json"
        audit_paths: dict[str, Path] = {
            "queues": graph.queues_path,
            "enumerations": graph.enumerations_path,
            "events": graph.events_path,
            "graph": graph.graph_path,
            "review_html": review_html_path,
            "timeline": timeline_json_path,
        }
        if trunc_path.is_file():
            audit_paths["budget_truncation"] = trunc_path
        write_exploration_report(
            graph.out_dir / "exploration_report.md",
            config=self.config,
            entry_url=entry_url,
            run_id=run_id,
            stats=stats,
            audit_paths=audit_paths,
        )
        return graph.graph_path

    async def run(self, entry_url: str, out_dir: Path) -> Path:
        out_dir = Path(out_dir).expanduser()
        resume_root = Path(self.config.resume_session_dir).expanduser() if self.config.resume_session_dir else None
        if resume_root:
            out_dir = resume_root

        out_dir.mkdir(parents=True, exist_ok=True)
        try:
            install_unified_agent_log_handler(out_dir)
        except Exception as exc:
            logger.warning("无法启用 agent_unified.log 汇总日志（不影响主流程）: %s", exc)

        session_file = out_dir / "session_state.json"
        start_ctx = StartContext()
        sp: SessionPayload | None = None
        defer_anchor_queue = False

        if resume_root:
            sp = read_session_state(session_file)
            self.config = exploration_config_from_dict(sp.config_snapshot)
            self.config = self._overlay_cli_config_on_resume(self.config)
            entry_url = sp.entry_url
            run_id = sp.run_id
            site_key = self.config.site_key or site_key_from_url(entry_url)
            dedupe = sp.dedupe
            stats = dict(sp.stats or {})
            stats.setdefault("actions_executed", 0)
            stats.setdefault("discovery_url_enqueues_used", 0)
            start_ctx = sp.start_context
            self._seq = sp.explorer_seq_cursor

            pending: deque[UrlTask] = deque()
            if sp.active_url_task:
                pending.append(sp.active_url_task)
            pending.extend(sp.pending_urls)
            seen_anchor = set(sp.seen_anchor_urls)
            seen_url_equiv: set[str] = {url_equivalence_key(u) for u in sp.seen_anchor_urls}
            seen_structural_state: set[str] = set(sp.seen_structural_state_ids or [])

            graph = GraphStore(out_dir, site_key=site_key, run_id=run_id)
            graph.hydrate_from_existing_graph()
            graph.restore_sequences_from_audit()

            if self.config.intent_missions_second_round:
                en_re = normalize_url(
                    entry_url,
                    strip_trailing_slash=self.config.url_strip_trailing_slash,
                    keep_fragment=self.config.url_keep_fragment,
                )
                pending = deque([UrlTask(url_norm=en_re, raw_url=entry_url, anchor_depth=0)])
                seen_anchor.discard(en_re)
                sp.status = "running"
                sp.status_reason = "intent_missions_second_round"
                sp.touch()
                write_session_state(session_file, sp)

            if (
                start_ctx.bootstrap_used
                and self.config.replay_bootstrap_on_resume
                and not sp.replay_bootstrap_done
                and not self.config.intent_missions_second_round
            ):
                # 续跑无法恢复已结束的同会话浏览器：临时关闭 same_session，走子进程 CLI 重放前置。
                cfg_resume = dataclasses.replace(self.config, bootstrap_same_session=False)
                await run_bootstrap_phase(
                    cfg_resume,
                    entry_url=entry_url,
                    out_dir=out_dir,
                    skill_root=self.config.skill_root,
                )
                sp.replay_bootstrap_done = True
                sp.touch()
                write_session_state(session_file, sp)
        else:
            run_id = uuid.uuid4().hex[:12]
            session_uuid = uuid.uuid4().hex
            site_key = self.config.site_key or site_key_from_url(entry_url)
            graph = GraphStore(out_dir, site_key=site_key, run_id=run_id)
            dedupe = DedupeStore()
            stats = {"actions_executed": 0, "discovery_url_enqueues_used": 0}

            start_ctx = StartContext(start_kind="entry_url", bootstrap_used=False)
            br: BootstrapResult | None = None
            if self.config.bootstrap_task_file or self.config.bootstrap_description:
                br, _bp = await run_bootstrap_phase(
                    self.config,
                    entry_url=entry_url,
                    out_dir=out_dir,
                    skill_root=self.config.skill_root,
                )
                if not br.ok and self.config.bootstrap_abort_on_failure:
                    raise RuntimeError(br.error or "bootstrap failed")
                if br.result != "skipped":
                    start_ctx = StartContext(
                        start_kind="bootstrap",
                        bootstrap_used=True,
                        bootstrap_ref=br.flow_ref,
                        bootstrap_last_url=br.last_url or "",
                    )

            defer_anchor_queue = bool(
                getattr(self.config, "bootstrap_same_session", True)
                and (self.config.bootstrap_task_file or self.config.bootstrap_description)
                and br is not None
                and br.ok
                and br.result != "skipped"
            )
            if defer_anchor_queue:
                pending = deque()
                seen_anchor = set()
                seen_url_equiv: set[str] = set()
            else:
                entry_norm = normalize_url(
                    entry_url,
                    strip_trailing_slash=self.config.url_strip_trailing_slash,
                    keep_fragment=self.config.url_keep_fragment,
                )
                pending = deque([UrlTask(url_norm=entry_norm, raw_url=entry_url, anchor_depth=0)])
                seen_anchor = set()
                seen_url_equiv = {url_equivalence_key(entry_norm)}
            seen_structural_state: set[str] = set()

            sp = SessionPayload(
                session_id=session_uuid,
                run_id=run_id,
                entry_url=entry_url,
                status="running",
                config_snapshot=exploration_config_to_dict(self.config),
                start_context=start_ctx,
                bootstrap_result=br,
                dedupe=dedupe,
                stats=stats,
                pending_urls=[],
                active_url_task=None,
                seen_anchor_urls=[],
            )
            write_session_state(session_file, sp)

        self._bootstrap_flow_prefix = self._bootstrap_prefix_for_yaml(out_dir)
        self._bootstrap_target_overlay = read_bootstrap_target_overlay(out_dir / "bootstrap.yaml")
        self._anchor_step_seq_by_norm = hydrate_anchor_step_seq_max_by_anchor(out_dir / "events.jsonl")

        browser = Browser(config=BrowserConfig(headless=self.config.headless))
        budget_truncation_segments: list[dict[str, Any]] = []
        prior_path_keys = load_prior_dedupe_keys(
            Path(self.config.prior_graph_path).expanduser() if self.config.prior_graph_path else None
        )

        def persist() -> None:
            if sp is None:
                return
            sp.pending_urls = list(pending)
            sp.seen_anchor_urls = sorted(seen_anchor)
            sp.seen_structural_state_ids = sorted(seen_structural_state)
            sp.dedupe = dedupe
            sp.stats = dict(stats)
            sp.start_context = start_ctx
            cfg_snap = exploration_config_to_dict(self.config)
            cfg_snap.pop("resume_session_dir", None)
            sp.config_snapshot = cfg_snap
            sp.entry_url = entry_url
            sp.run_id = run_id
            sp.explorer_seq_cursor = self._seq
            sp.touch()
            write_session_state(session_file, sp)

        def anchor_ck_flush(**kw: Any) -> None:
            """strict 模式下将当前队列与 anchor_ok 快照写入 session_state.json，便于 --resume-session 接续。"""
            if sp is None:
                return
            sp.current_anchor = CurrentAnchorState(
                raw_url=str(kw["anchor_url"]),
                url_norm=str(kw["anchor_norm"]),
                anchor_depth=int(kw["anchor_depth"]),
                anchor_ok_actions=int(kw["anchor_ok_actions"]),
                strict_resume_phase=str(kw["strict_resume_phase"]),
                action_queue=list(kw["action_queue"]),
            )
            persist()

        def anchor_ck_clear() -> None:
            if sp is None:
                return
            sp.current_anchor = None
            persist()

        self._anchor_checkpoint_sink = anchor_ck_flush
        self._anchor_checkpoint_clear_sink = anchor_ck_clear

        # 续跑默认行为：保留之前快照里的 pending / seen_anchor，不主动改变参数语义、不重新入队入口 URL。
        # 仅当用户**显式**设置 ``resume_reopen_entry_on_higher_budget=True`` 时，把入口 URL 重新放进队列以
        # 消耗新追加的 max_actions 预算。否则，已 ``completed`` 的会话续跑时按队列剩余执行（可能立即结束），
        # 由用户决定是否再追加 URL 任务。
        if (
            resume_root
            and sp is not None
            and not pending
            and sp.status == "completed"
            and bool(getattr(self.config, "resume_reopen_entry_on_higher_budget", False))
        ):
            old_max = int((sp.config_snapshot or {}).get("max_actions", 0) or 0)
            if self.config.max_actions > old_max and old_max > 0:
                en = normalize_url(
                    sp.entry_url,
                    strip_trailing_slash=self.config.url_strip_trailing_slash,
                    keep_fragment=self.config.url_keep_fragment,
                )
                seen_anchor.discard(en)
                pending.append(UrlTask(url_norm=en, raw_url=sp.entry_url, anchor_depth=0))
                sp.status = "running"
                sp.status_reason = "resume_reopen_entry_on_higher_budget"
                if not stats.get("anchor_ok_baseline_norm"):
                    stats["anchor_ok_baseline"] = old_max
                    stats["anchor_ok_baseline_norm"] = en
                persist()

        bootstrap_reuse_ctx: RelaxedLoadBrowserContext | None = None
        if (
            not resume_root
            and defer_anchor_queue
            and (out_dir / "bootstrap.yaml").is_file()
        ):
            seed_url = entry_url
            boot_yaml = out_dir / "bootstrap.yaml"
            shot_until2 = self.config.page_goto_wait_until
            if shot_until2 == "commit":
                shot_until2 = "domcontentloaded"
            ctx_boot = RelaxedLoadBrowserContext(
                browser=browser,
                config=self._browser_context_config_from_bootstrap_overlay(),
                screenshot_wait_timeout_ms=self.config.page_goto_timeout_ms,
                screenshot_capture_timeout_ms=self.config.page_screenshot_timeout_ms,
                screenshot_wait_until=shot_until2,
            )
            replay_log = out_dir / "bootstrap_replay_logs"
            try:
                await replay_bootstrap_agent_on_context(
                    ctx=ctx_boot,
                    bootstrap_yaml=boot_yaml,
                    headless=self.config.headless,
                    log_dir=replay_log,
                )
            except Exception as exc:
                await ctx_boot.close()
                logger.warning("bootstrap 同会话重放失败: %s", exc)
                if self.config.bootstrap_abort_on_failure:
                    await browser.close()
                    raise RuntimeError(f"bootstrap 同会话重放失败: {exc}") from exc
                self._skip_bootstrap_agent_replay = True
                entry_norm_fb = normalize_url(
                    seed_url,
                    strip_trailing_slash=self.config.url_strip_trailing_slash,
                    keep_fragment=self.config.url_keep_fragment,
                )
                pending = deque(
                    [UrlTask(url_norm=entry_norm_fb, raw_url=seed_url, anchor_depth=0)]
                )
                seen_anchor = set()
                seen_url_equiv = {url_equivalence_key(entry_norm_fb)}
            else:
                page = await ctx_boot.get_current_page()
                entry_url = page.url
                if start_ctx.bootstrap_used:
                    start_ctx.bootstrap_last_url = entry_url
                entry_norm_eff = normalize_url(
                    entry_url,
                    strip_trailing_slash=self.config.url_strip_trailing_slash,
                    keep_fragment=self.config.url_keep_fragment,
                )
                pending = deque(
                    [UrlTask(url_norm=entry_norm_eff, raw_url=entry_url, anchor_depth=0)]
                )
                seen_anchor = set()
                seen_url_equiv = {url_equivalence_key(entry_norm_eff)}
                bootstrap_reuse_ctx = ctx_boot
                if sp is not None:
                    persist()

        interruption: BaseException | None = None
        try:
            try:
                while pending:
                    job = pending.popleft()
                    if sp is not None:
                        sp.pending_urls = list(pending)
                        sp.active_url_task = job
                        persist()

                    if job.anchor_depth >= self.config.exploration_depth:
                        graph.append_queue(
                            "url_skip_depth",
                            {
                                "url_norm": job.url_norm,
                                "raw_url": job.raw_url,
                                "anchor_depth": job.anchor_depth,
                                "exploration_depth": self.config.exploration_depth,
                            },
                        )
                        if sp is not None:
                            sp.active_url_task = None
                            persist()
                        continue
                    if job.url_norm in seen_anchor:
                        graph.append_queue(
                            "url_skip_seen",
                            {
                                "url_norm": job.url_norm,
                                "raw_url": job.raw_url,
                                "anchor_depth": job.anchor_depth,
                            },
                        )
                        if sp is not None:
                            sp.active_url_task = None
                            persist()
                        continue
                    graph.append_queue(
                        "url_dequeue",
                        {
                            "url_norm": job.url_norm,
                            "raw_url": job.raw_url,
                            "anchor_depth": job.anchor_depth,
                        },
                    )
                    seen_anchor.add(job.url_norm)
                    self._log_explore_progress(
                        stats,
                        pending=pending,
                        anchor_norm=job.url_norm,
                        anchor_ok=None,
                        action_queue_len=None,
                        run_id=run_id,
                        note=f"URL 锚点开始 depth={job.anchor_depth}",
                        force=True,
                    )
                    reuse = bootstrap_reuse_ctx
                    anchor_ck: CurrentAnchorState | None = (
                        sp.current_anchor
                        if (
                            resume_root
                            and sp is not None
                            and sp.current_anchor is not None
                            and sp.current_anchor.url_norm == job.url_norm
                            and int(sp.current_anchor.anchor_depth) == int(job.anchor_depth)
                        )
                        else None
                    )
                    discovered = await self._explore_anchor(
                        browser,
                        job.raw_url,
                        job.anchor_depth,
                        graph,
                        dedupe,
                        run_id,
                        stats,
                        budget_truncation_segments,
                        prior_path_keys=prior_path_keys,
                        reuse_context=reuse,
                        seen_structural_state=seen_structural_state,
                        anchor_resume_checkpoint=anchor_ck,
                    )
                    bootstrap_reuse_ctx = None
                    if sp is not None:
                        sp.active_url_task = None
                        persist()
                    # 发现顺序 = DOM 出现顺序，预算与去重均按「先发现先入队」执行；
                    # 队列保持 FIFO（先发现先 popleft），故先收集 admitted，再以 reversed 的 appendleft 推入队首。
                    admitted: list[UrlTask] = []
                    for u in discovered:
                        if u.anchor_depth >= self.config.exploration_depth:
                            continue
                        if u.url_norm in seen_anchor:
                            continue
                        if self.config.url_equivalence_enabled:
                            eq_key = url_equivalence_key(u.url_norm)
                            if eq_key in seen_url_equiv:
                                stats["url_skipped_equivalence"] = (
                                    stats.get("url_skipped_equivalence", 0) + 1
                                )
                                graph.append_queue(
                                    "url_skip_budget",
                                    {
                                        "reason": "url_equivalence",
                                        "url_norm": u.url_norm,
                                        "raw_url": u.raw_url,
                                        "anchor_depth": u.anchor_depth,
                                        "equivalence_key": eq_key[:32],
                                        "from_parent": job.url_norm,
                                    },
                                )
                                continue
                            seen_url_equiv.add(eq_key)
                        used = int(stats.get("discovery_url_enqueues_used", 0) or 0)
                        if used >= self.config.max_new_urls:
                            graph.append_queue(
                                "url_skip_budget",
                                {
                                    "reason": "max_new_urls",
                                    "url_norm": u.url_norm,
                                    "raw_url": u.raw_url,
                                    "anchor_depth": u.anchor_depth,
                                    "max_new_urls": self.config.max_new_urls,
                                    "discovery_url_enqueues_used": used,
                                    "from_parent": job.url_norm,
                                },
                            )
                            continue
                        stats["discovery_url_enqueues_used"] = used + 1
                        graph.append_queue(
                            "url_enqueue",
                            {
                                "url_norm": u.url_norm,
                                "raw_url": u.raw_url,
                                "anchor_depth": u.anchor_depth,
                                "from_parent": job.url_norm,
                            },
                        )
                        admitted.append(u)
                    for u in reversed(admitted):
                        pending.appendleft(u)
            finally:
                await browser.close()
        except BaseException as exc:
            interruption = exc

        gp = graph.graph_path
        try:
            gp = self._emit_terminal_exploration_artifacts(
                graph=graph,
                entry_url=entry_url,
                run_id=run_id,
                start_ctx=start_ctx,
                stats=stats,
                dedupe=dedupe,
                budget_truncation_segments=budget_truncation_segments,
                session_file=session_file,
                sp=sp,
                interruption=interruption,
            )
        except Exception:
            logger.exception(
                "写出终端审计产物失败（review_timeline.html / exploration_report.md 等）"
            )

        if interruption is not None:
            raise interruption
        return gp
