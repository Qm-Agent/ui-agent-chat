from __future__ import annotations

import json
import re
import uuid
from pathlib import Path
from typing import Any

from browser_use.browser.views import BrowserState

from recursive_exploration.config import ExplorationRunConfig
from recursive_exploration.layout_context import layout_hints_for_step, spatial_pair_incoherent
from recursive_exploration.fingerprints import (
    canonical_prefix_steps_json,
    dedupe_path_key,
    normalize_url,
    scroll_fingerprint,
    stable_hash,
)
from recursive_exploration.models import ActionTask, ExplorationStep

# 与 explorer 中一致；避免循环 import 的轻量复制
def _is_file_input(attrs: dict[str, Any]) -> bool:
    return str((attrs or {}).get("type", "")).lower() == "file"


def _is_text_input_element_el(el: Any) -> bool:
    tag = (getattr(el, "tag_name", None) or "").lower()
    attrs = el.attributes or {}
    if _is_file_input(attrs):
        return False
    if tag == "textarea":
        return True
    if tag != "input":
        return False
    typ = str(attrs.get("type", "text") or "text").lower()
    if typ in ("submit", "button", "checkbox", "radio", "hidden", "image", "reset", "file"):
        return False
    return True


def _is_submit_like_el(el: Any) -> bool:
    tag = (getattr(el, "tag_name", None) or "").lower()
    attrs = el.attributes or {}
    typ = str(attrs.get("type", "")).lower()
    if tag == "button":
        return True
    if tag == "input" and typ in ("submit", "button", "image"):
        return True
    if (attrs.get("role") or "").lower() == "button":
        return True
    try:
        tx = el.get_all_text_till_next_clickable_element(max_depth=1)
    except Exception:
        tx = ""
    t = re.sub(r"\s+", " ", (tx or "").strip()).lower()
    for w in ("提交", "确定", "查询", "搜索", "send", "submit", "search", "ok", "apply"):
        if w in t:
            return True
    return False


def _tap_desc(idx: int, el: Any) -> str:
    attrs = el.attributes or {}
    bits = [str(el.tag_name)]
    for k in ("aria-label", "title", "id", "name", "role"):
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
    return f"[{idx}] " + " ".join(bits)[:220]


def _locate_prompt_from_element(idx: int, el: Any) -> str:
    attrs = el.attributes or {}
    parts: list[str] = []
    ph = attrs.get("placeholder")
    if ph:
        parts.append(f"占位符「{str(ph)[:50]}」")
    for key in ("aria-label", "title", "name", "id"):
        v = attrs.get(key)
        if v:
            parts.append(f"{key}={str(v)[:36]}")
    tag = (getattr(el, "tag_name", None) or "").lower()
    try:
        tx = el.get_all_text_till_next_clickable_element(max_depth=2)
    except Exception:
        tx = ""
    tx = re.sub(r"\s+", " ", (tx or "").strip())[:90]
    if tx:
        parts.append(f"附近文案「{tx}」")
    body = " · ".join(parts)
    if body:
        return (f"{tag} " if tag else "") + body[:220]
    return (f"{tag} 可交互控件" if tag else "可交互控件")[:220]


def _step_from_target_element(
    idx: int, el: Any, *, input_value: str = "", kind: str = "click"
) -> ExplorationStep:
    bh = el.hash.branch_path_hash
    if kind == "input":
        return ExplorationStep(
            element_index=idx,
            branch_path_hash=bh,
            tap_description=_tap_desc(idx, el),
            locate_prompt=_locate_prompt_from_element(idx, el),
            step_kind="input",
            input_value=input_value,
        )
    return ExplorationStep(
        element_index=idx,
        branch_path_hash=bh,
        tap_description=_tap_desc(idx, el),
        locate_prompt=_locate_prompt_from_element(idx, el),
        step_kind="click",
    )


def _step_scroll(delta_y: int) -> ExplorationStep:
    fp = scroll_fingerprint(delta_y)
    return ExplorationStep(
        element_index=-1,
        branch_path_hash=fp,
        tap_description=f"[scroll] viewport Δy={delta_y}px",
        locate_prompt="浏览器主视口向下滚动一段",
        step_kind="scroll",
        scroll_delta_y=int(delta_y),
    )


def exploration_step_from_graph_target_step(ts: dict[str, Any]) -> ExplorationStep | None:
    """从 graph.json 边中的 target_step 恢复可重放步（与执行时写入结构对齐）。"""
    if not ts or not isinstance(ts, dict):
        return None
    kind = (ts.get("kind") or "click").lower()
    if kind == "scroll":
        return None
    try:
        idx = int(ts.get("element_index") or 0)
    except (TypeError, ValueError):
        return None
    bh = str(ts.get("branch_path_hash") or "")
    if not bh:
        return None
    tap = str(ts.get("tap_description") or "")
    loc = str(ts.get("locate_prompt") or "")
    iv = str(ts.get("input_value") or "")
    sk: str = "input" if kind == "input" else "click"
    return ExplorationStep(
        element_index=idx,
        branch_path_hash=bh,
        tap_description=tap,
        locate_prompt=loc,
        step_kind=sk,  # type: ignore[arg-type]
        input_value=iv,
    )


def _chain_to_composite_steps(edge_chain: list[dict[str, Any]]) -> list[ExplorationStep] | None:
    steps: list[ExplorationStep] = []
    for e in edge_chain:
        ts = e.get("target_step")
        if not isinstance(ts, dict):
            return None
        st = exploration_step_from_graph_target_step(ts)
        if st is None:
            return None
        steps.append(st)
    return steps if len(steps) >= 2 else None


def _steps_layout_pair_incoherent(
    steps: list[ExplorationStep],
    selector_map: dict[int, Any],
    vw: float,
    vh: float,
) -> bool:
    hints_list: list[Any] = []
    for st in steps:
        if st.step_kind == "scroll":
            continue
        h = layout_hints_for_step(st, selector_map, vw, vh)
        if h is not None:
            hints_list.append(h)
    for i in range(len(hints_list) - 1):
        if spatial_pair_incoherent(hints_list[i], hints_list[i + 1], strict=True):
            return True
    return False


def filter_action_tasks_by_coherence(
    tasks: list[ActionTask],
    *,
    selector_map: dict[int, Any],
    vw: float,
    vh: float,
    cfg: ExplorationRunConfig,
    stats_sink: dict[str, Any] | None = None,
) -> tuple[list[ActionTask], int]:
    """返回（过滤后任务列表，strict 模式下丢弃的不协调链数量）。rank 模式仅重排，丢弃数为 0。"""
    if not cfg.composite_coherence_enabled or cfg.composite_coherence_mode == "off":
        return tasks, 0
    mode = cfg.composite_coherence_mode
    kept: list[ActionTask] = []
    ranked_bad: list[ActionTask] = []
    strict_dropped = 0
    rank_moved = 0
    for t in tasks:
        if t.task_kind != "composite":
            kept.append(t)
            continue
        body = list(t.composite_steps or [])
        if len(body) < 2:
            kept.append(t)
            continue
        bad = _steps_layout_pair_incoherent(body, selector_map, vw, vh)
        if not bad:
            kept.append(t)
            continue
        if mode == "strict":
            strict_dropped += 1
            continue
        if mode == "rank":
            ranked_bad.append(t)
            rank_moved += 1
            continue
        kept.append(t)
    if mode == "rank":
        kept.extend(ranked_bad)
    if stats_sink is not None:
        if strict_dropped:
            stats_sink["coherence_strict_dropped"] = stats_sink.get("coherence_strict_dropped", 0) + int(
                strict_dropped
            )
        if rank_moved:
            stats_sink["coherence_rank_deprioritized"] = stats_sink.get(
                "coherence_rank_deprioritized", 0
            ) + int(rank_moved)
    return kept, strict_dropped


def plan_graph_guided_composite_tasks(
    *,
    graph: Any,
    anchor_url: str,
    anchor_norm: str,
    anchor_depth: int,
    run_id: str,
    cfg: ExplorationRunConfig,
    blocked_path_keys: set[str],
    selector_map: dict[int, Any] | None = None,
    viewport_wh: tuple[float, float] | None = None,
    stats_sink: dict[str, Any] | None = None,
) -> list[ActionTask]:
    """
    基于当前 run 已持久化的图谱边，生成「沿成功边衔接」的多步组合任务，用于在不依赖表单启发式的情况下深化导航。
    仅从 url_norm 等于当前锚点的节点出发，沿 result==ok 的边扩展；链长 2..graph_guided_composite_max_hops。
    """
    if not cfg.graph_guided_composite_enabled or not cfg.composite_enabled:
        return []
    max_edges = max(2, int(cfg.graph_guided_composite_max_hops or 2))
    step_cap = max(2, int(cfg.composite_max_step_count or 8))
    max_edges = min(max_edges, step_cap)

    nodes: dict[str, Any] = getattr(graph, "nodes", {}) or {}
    edges: dict[str, Any] = getattr(graph, "edges", {}) or {}
    if not nodes or not edges:
        return []

    edges_from: dict[str, list[dict[str, Any]]] = {}
    for e in edges.values():
        if not isinstance(e, dict):
            continue
        if str(e.get("result") or "") != "ok":
            continue
        fid = e.get("from_node_id")
        if fid:
            edges_from.setdefault(str(fid), []).append(e)

    def _edge_chain_key(e: dict[str, Any]) -> str:
        eid = e.get("edge_id") or e.get("event_id")
        if eid:
            return str(eid)
        return stable_hash(
            [
                "e",
                e.get("from_node_id"),
                e.get("to_node_id"),
                e.get("dedupe_path_key"),
            ]
        )

    candidates: list[list[dict[str, Any]]] = []

    def dfs_extend(
        acc: list[dict[str, Any]], last_to: str, used_edge_keys: frozenset[str]
    ) -> None:
        if len(acc) >= max_edges:
            return
        for e_next in edges_from.get(last_to, []):
            if str(e_next.get("result") or "") != "ok":
                continue
            ek = _edge_chain_key(e_next)
            if ek in used_edge_keys:
                continue
            new_acc = acc + [e_next]
            if len(new_acc) >= 2:
                candidates.append(new_acc)
            if len(new_acc) < max_edges:
                tid = e_next.get("to_node_id")
                if tid:
                    dfs_extend(new_acc, str(tid), used_edge_keys | {ek})

    for e1 in edges.values():
        if not isinstance(e1, dict) or str(e1.get("result") or "") != "ok":
            continue
        fnid = str(e1.get("from_node_id") or "")
        fn = nodes.get(fnid)
        if not isinstance(fn, dict):
            continue
        nu = normalize_url(
            str(fn.get("url_norm") or ""),
            strip_trailing_slash=cfg.url_strip_trailing_slash,
            keep_fragment=cfg.url_keep_fragment,
        )
        if nu != anchor_norm:
            continue
        to1 = e1.get("to_node_id")
        if not to1:
            continue
        acc1 = [e1]
        k1 = _edge_chain_key(e1)
        dfs_extend(acc1, str(to1), frozenset({k1}))

    candidates.sort(key=len)

    out_tasks: list[ActionTask] = []
    seen_pk: set[str] = set()
    for chain in candidates:
        steps = _chain_to_composite_steps(chain)
        if not steps:
            continue
        steps = steps[:step_cap]
        if len(steps) < 2:
            continue
        pk = _composite_path_key(anchor_norm, [], steps)
        if pk in seen_pk:
            continue
        seen_pk.add(pk)
        if cfg.skip_redundant_single and pk in blocked_path_keys:
            continue

        plan_id = f"gp_{uuid.uuid4().hex[:12]}"
        tid = "t_" + pk[:16]
        first = steps[0]
        tgt_idx = first.element_index if first.element_index >= 0 else 0
        out_tasks.append(
            ActionTask(
                task_id=tid,
                run_id=run_id,
                anchor_url=anchor_url,
                anchor_url_norm=anchor_norm,
                dedupe_path_key=pk,
                prefix_steps=[],
                target_index=tgt_idx,
                target_branch_path_hash=first.branch_path_hash,
                target_description=first.tap_description,
                action_kind="click",
                locate_prompt=first.locate_prompt,
                anchor_depth=anchor_depth,
                task_kind="composite",
                composite_plan_id=plan_id,
                task_source="graph_guided_composite",  # type: ignore[arg-type]
                composite_steps=steps,
            )
        )
        if len(out_tasks) >= cfg.composite_max_tasks_per_anchor:
            break

    vw, vh = viewport_wh or (
        float(cfg.composite_viewport_fallback_width),
        float(cfg.composite_viewport_fallback_height),
    )
    if selector_map is not None:
        out_tasks, _ = filter_action_tasks_by_coherence(
            out_tasks,
            selector_map=selector_map,
            vw=vw,
            vh=vh,
            cfg=cfg,
            stats_sink=stats_sink,
        )
    return out_tasks


def load_prior_dedupe_keys(graph_json_path: Path | None) -> set[str]:
    if not graph_json_path or not graph_json_path.is_file():
        return set()
    try:
        data = json.loads(graph_json_path.read_text(encoding="utf-8"))
    except Exception:
        return set()
    keys: set[str] = set()
    for e in data.get("edges") or []:
        k = e.get("dedupe_path_key")
        if isinstance(k, str) and k:
            keys.add(k)
    return keys


def _composite_path_key(
    anchor_norm: str,
    prefix_steps: list[ExplorationStep],
    composite_body: list[ExplorationStep],
) -> str:
    """组合任务路径键：前缀 + 组合体内每步指纹。"""
    p_json = canonical_prefix_steps_json(_steps_to_wire(prefix_steps))
    bodies: list[str] = []
    for st in composite_body:
        if st.step_kind == "scroll":
            bodies.append(scroll_fingerprint(st.scroll_delta_y))
        else:
            bodies.append(f"{st.element_index}:{st.branch_path_hash}:{st.step_kind}")
    inner = stable_hash(["composite_body", "|".join(bodies)])
    return dedupe_path_key(anchor_norm, p_json, inner)


def _steps_to_wire(steps: list[ExplorationStep]) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for s in steps:
        d: dict[str, Any] = {"i": s.element_index, "h": s.branch_path_hash}
        if s.step_kind == "scroll":
            d["sy"] = s.scroll_delta_y
            d["k"] = "scroll"
        else:
            d["k"] = s.step_kind
            if s.input_value:
                d["v"] = s.input_value
        out.append(d)
    return out


def plan_composite_tasks_for_anchor(
    *,
    state: BrowserState,
    anchor_url: str,
    anchor_norm: str,
    anchor_depth: int,
    run_id: str,
    cfg: ExplorationRunConfig,
    prior_path_keys: set[str],
    scroll_first: bool,
    scroll_delta_y: int,
    stats_sink: dict[str, Any] | None = None,
) -> list[ActionTask]:
    """启发式生成组合任务（full/partial submit + 可选首部 scroll）。不计入 dedupe.try_action。"""
    sm = state.selector_map or {}
    inputs: list[tuple[int, Any]] = []
    submits: list[tuple[int, Any]] = []
    for idx in sorted(sm.keys()):
        el = sm[idx]
        if not el.is_interactive or not el.rectangle:
            continue
        if not getattr(el, "is_in_viewport", False):
            continue
        if _is_text_input_element_el(el):
            inputs.append((idx, el))
        elif _is_submit_like_el(el):
            submits.append((idx, el))

    if not submits or len(inputs) == 0:
        return []

    submit_idx, submit_el = submits[0]
    ordered_inputs = sorted(inputs, key=lambda x: x[0])[: max(1, cfg.composite_max_step_count - 2)]

    plans: list[list[ExplorationStep]] = []

    # full：所有候选输入 → 提交
    body_full: list[ExplorationStep] = []
    if scroll_first:
        body_full.append(_step_scroll(scroll_delta_y))
    for ix, el in ordered_inputs:
        body_full.append(_step_from_target_element(ix, el, kind="input"))
    body_full.append(_step_from_target_element(submit_idx, submit_el, kind="click"))
    if len(body_full) >= 2:
        plans.append(body_full[: cfg.composite_max_step_count])

    # partial：仅第一个输入 → 提交（校验/错误态）
    if len(ordered_inputs) >= 2:
        body_p: list[ExplorationStep] = []
        if scroll_first:
            body_p.append(_step_scroll(scroll_delta_y))
        ix0, el0 = ordered_inputs[0]
        body_p.append(_step_from_target_element(ix0, el0, kind="input"))
        body_p.append(_step_from_target_element(submit_idx, submit_el, kind="click"))
        if len(body_p) >= 2:
            plans.append(body_p[: cfg.composite_max_step_count])

    out_tasks: list[ActionTask] = []
    seen_pk: set[str] = set()
    for body in plans:
        if len(body) < 2:
            continue
        pk = _composite_path_key(anchor_norm, [], body)
        if pk in seen_pk:
            continue
        seen_pk.add(pk)
        if cfg.skip_redundant_single and pk in prior_path_keys:
            continue

        plan_id = f"p_{uuid.uuid4().hex[:12]}"
        tid = "t_" + pk[:16]
        # composite 占位 target：使用第一步可解析索引（scroll 时为 -1）
        first = body[0]
        tgt_idx = first.element_index if first.element_index >= 0 else 0
        tsrc = "incremental_composite" if cfg.incremental_composite_mode else "composite_planner"
        out_tasks.append(
            ActionTask(
                task_id=tid,
                run_id=run_id,
                anchor_url=anchor_url,
                anchor_url_norm=anchor_norm,
                dedupe_path_key=pk,
                prefix_steps=[],
                target_index=tgt_idx,
                target_branch_path_hash=first.branch_path_hash,
                target_description=first.tap_description,
                action_kind="click",
                locate_prompt=first.locate_prompt,
                anchor_depth=anchor_depth,
                task_kind="composite",
                composite_plan_id=plan_id,
                task_source=tsrc,  # type: ignore[arg-type]
                composite_steps=body,
            )
        )
        if len(out_tasks) >= cfg.composite_max_tasks_per_anchor:
            break

    vw = float(cfg.composite_viewport_fallback_width)
    vh = float(cfg.composite_viewport_fallback_height)
    sm = state.selector_map or {}
    out_tasks, _ = filter_action_tasks_by_coherence(
        out_tasks,
        selector_map=sm,
        vw=vw,
        vh=vh,
        cfg=cfg,
        stats_sink=stats_sink,
    )
    return out_tasks
