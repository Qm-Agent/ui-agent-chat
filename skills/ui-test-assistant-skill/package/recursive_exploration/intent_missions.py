"""锚点级意图任务：图谱摘要 + 页面观测 → LLM → 多条 `ai` 步（YAML / Agent）。"""

from __future__ import annotations

import json
import logging
import re
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from recursive_exploration.config import ExplorationRunConfig
from recursive_exploration.fingerprints import canonical_prefix_steps_json, dedupe_path_key, stable_hash
from recursive_exploration.graph_store import GraphStore
from recursive_exploration.input_mock_llm import try_get_page_extraction_llm
from recursive_exploration.models import ActionTask, ExplorationStep
from recursive_exploration.review_report import _looks_like_dom_or_selector_fragment

logger = logging.getLogger(__name__)


def intent_target_fingerprint(ai_steps: list[str]) -> str:
    norm = "\n".join(x.strip() for x in ai_steps if x and x.strip())
    return stable_hash(["intent_mission", norm])


def prior_graph_edges_summary(
    prior_graph_path: Path | None,
    anchor_url_norm: str,
    *,
    limit: int = 24,
) -> str | None:
    """
    从已有 graph.json 读取与本锚点相关的边摘要（当前 run 的 GraphStore 尚为空时常用）。
    文件不存在或解析失败时返回 None。
    """
    if prior_graph_path is None:
        return None
    p = Path(prior_graph_path).expanduser()
    if not p.is_file():
        return None
    try:
        doc = json.loads(p.read_text(encoding="utf-8"))
    except Exception:
        return None
    rows: list[str] = []
    for e in doc.get("edges") or []:
        if not isinstance(e, dict):
            continue
        if str(e.get("anchor_url_norm") or "") != anchor_url_norm:
            continue
        tag = str(e.get("action_tag") or "")
        ts = e.get("target_step") if isinstance(e.get("target_step"), dict) else {}
        desc = (
            str((ts or {}).get("locate_prompt") or "")
            or str((ts or {}).get("tap_description") or "")
        )[:100]
        rows.append(f"- [{tag}] {desc}".strip())
        if len(rows) >= limit:
            break
    if not rows:
        return None
    return "\n".join(rows)


def graph_edges_summary_enriched(graph: GraphStore, anchor_url_norm: str, *, limit: int = 32) -> str:
    """边摘要：含 action_tag、动作描述、落地节点 title/url（若有），便于规划分支与跨页理解。"""
    nodes: dict[str, Any] = getattr(graph, "nodes", {}) or {}
    rows: list[str] = []
    for e in graph.edges.values():
        if str(e.get("anchor_url_norm") or "") != anchor_url_norm:
            continue
        tag = str(e.get("action_tag") or "")
        ts = e.get("target_step") if isinstance(e.get("target_step"), dict) else {}
        desc = (
            str((ts or {}).get("locate_prompt") or "")
            or str((ts or {}).get("tap_description") or "")
        )[:100]
        uc = bool(e.get("url_changed"))
        tid = str(e.get("to_node_id") or "")
        to_title = ""
        to_url = ""
        if tid and tid in nodes:
            tn = nodes[tid]
            if isinstance(tn, dict):
                to_title = str(tn.get("title") or "")[:80]
                to_url = str(tn.get("url_norm") or "")[:140]
        landing = ""
        if to_title or to_url:
            landing = f" → 落地「{to_title or '?'}」 {to_url}".strip()
        rows.append(f"- [{tag}] {'跨页' if uc else '同页'} {desc}{landing}".strip())
        if len(rows) >= limit:
            break
    return "\n".join(rows) if rows else "（当前尚无比锚点记录的成功边，可为首次访问）"


def graph_edges_summary(graph: GraphStore, anchor_url_norm: str, *, limit: int = 24) -> str:
    """兼容旧名：等价于带落地节点信息的摘要。"""
    return graph_edges_summary_enriched(graph, anchor_url_norm, limit=limit)


def effective_intent_max_ai_steps(cfg: ExplorationRunConfig) -> int:
    """与组合任务链共享步数上限：取意图配置与 composite_max_step_count 的较小值。"""
    return max(1, min(int(cfg.intent_mission_max_ai_steps), int(cfg.composite_max_step_count)))


# 意图步中禁止的「元叙事 / 指代」片段（易诱发重跑摘要式措辞，且对 Agent 不自洽）
_DEICTIC_SUBSTRINGS: tuple[str, ...] = (
    "沿已成功路径",
    "在同一业务流程中继续",
    "已成功路径",
    "沿成功路径",
    "复现并延伸该成功交互",
)


def intent_ai_step_passes_quality(step: str) -> bool:
    """单条 ai 步是否适合写入 YAML：拒绝指代性模板与 DOM 标签链描述。"""
    t = (step or "").strip()
    if not t:
        return False
    for sub in _DEICTIC_SUBSTRINGS:
        if sub in t:
            return False
    if _looks_like_dom_or_selector_fragment(t):
        return False
    if "位于" in t and ">" in t and re.search(r"\b(div|span|li|ul|a|button|input)\b", t.lower()):
        return False
    return True


def _deepening_step_sentence() -> str:
    return (
        "基于当前页面新出现的内容，执行一次更深入的操作（填写一项表单、打开子 Tab、展开「更多/高级」或核对关键业务指标/文案），"
        "并确认界面有可验证的反馈。"
    )


def _edge_imperative_sentence(edge: dict[str, Any], graph: GraphStore) -> str:
    """
    将图谱边改写成自包含的动作句：优先用户可见文案；图谱仅有 DOM 路径时用落地页标题等消歧。
    """
    label = _edge_user_intent_label(edge)
    if (
        _looks_like_dom_or_selector_fragment(label)
        or ("位于" in label and ">" in label)
        or not (label or "").strip()
    ):
        tid = str(edge.get("to_node_id") or "")
        nodes: dict[str, Any] = getattr(graph, "nodes", {}) or {}
        nd = nodes.get(tid) if tid else None
        title = ""
        if isinstance(nd, dict):
            title = str(nd.get("title") or "").strip()
        if title:
            return (
                f"结合页面可见文案进入或停留于与「{title[:100]}」一致的业务视图，并完成该视图下的主操作；"
                f"仅用语义化描述，勿使用 HTML 标签层级。"
            )
        return (
            "在视口内选择业务相关性最高的可点击入口（按钮、链接或 Tab），完成主流程中的一步；"
            "仅用用户可见文案指称目标，勿写 DOM 路径或「第几步」式措辞。"
        )
    return f"完成界面操作：{label[:300]}"


def load_graph_run_meta_digest(graph_path: Path, *, max_chars: int = 600) -> str | None:
    """graph.json 内 run_meta 一行级摘要（口径/入口等），体积小。"""
    if not graph_path.is_file():
        return None
    try:
        doc = json.loads(graph_path.read_text(encoding="utf-8"))
    except Exception:
        return None
    rm = doc.get("run_meta") if isinstance(doc.get("run_meta"), dict) else {}
    parts: list[str] = []
    for k in ("execution_mode", "yaml_policy", "exploration_depth", "strict_phase_traversal"):
        if k in rm and rm[k] is not None:
            parts.append(f"{k}={rm[k]}")
    entry = rm.get("start_context") if isinstance(rm.get("start_context"), dict) else {}
    if isinstance(entry, dict):
        sk = entry.get("start_kind")
        if sk:
            parts.append(f"start_kind={sk}")
    s = " | ".join(parts)[:max_chars]
    return s or None


def enumerate_recent_candidates_digest(
    enumerations_path: Path | None,
    anchor_url_norm: str,
    *,
    tail_lines: int = 220,
    max_rounds: int = 5,
    max_items: int = 56,
) -> str | None:
    """
    从 enumerations.jsonl 尾部抽取与本锚点相关的最近若干轮候选控件摘要（tap 文案短截断），体积小、偏语义。
    """
    if enumerations_path is None or not enumerations_path.is_file():
        return None
    try:
        raw = enumerations_path.read_text(encoding="utf-8")
    except OSError:
        return None
    lines = raw.splitlines()
    chunk = lines[-tail_lines:] if len(lines) > tail_lines else lines
    rounds: list[dict[str, Any]] = []
    for line in chunk:
        line = line.strip()
        if not line:
            continue
        try:
            o = json.loads(line)
        except json.JSONDecodeError:
            continue
        if str(o.get("anchor_url_norm") or "") != anchor_url_norm:
            continue
        if (o.get("schema") or "").startswith("exploration-enumeration"):
            rounds.append(o)
    if not rounds:
        return None
    rounds = rounds[-max_rounds:]
    labels: list[str] = []
    seen: set[str] = set()
    for r in rounds:
        src = str(r.get("source") or "")
        ps = str(r.get("page_state_id") or "")[:24]
        header = f"[round source={src} ps≈{ps}]"
        labels.append(header)
        for c in r.get("candidates") or []:
            if not isinstance(c, dict):
                continue
            td = str(c.get("tap_description") or "").strip()
            lp = str(c.get("locate_prompt") or "").strip()
            ak = str(c.get("action_kind") or "")
            cell = " | ".join(x for x in (ak, lp[:120], td[:120]) if x).strip()
            if cell and cell not in seen:
                seen.add(cell)
                labels.append(f"  · {cell}")
            if len(labels) >= max_items + max_rounds:
                break
        if len(labels) >= max_items + max_rounds:
            break
    if len(labels) <= 1:
        return None
    out = "## 近期 DOM 枚举候选（与本锚点相关的尾部轮次）\n" + "\n".join(labels[: max_items + max_rounds])
    return out[:8000]


def compact_selector_map_summary(obs: dict[str, Any], *, max_items: int = 44) -> str:
    """从观测中的 selector_map 提取视口内控件的短文本（补全 title/url 之外的控件级语义）。"""
    sm = obs.get("selector_map")
    if not isinstance(sm, dict):
        return ""
    lines: list[str] = []
    for idx in sorted(sm.keys()):
        el = sm.get(idx)
        if el is None:
            continue
        if not getattr(el, "is_interactive", False) or not getattr(el, "rectangle", None):
            continue
        if not getattr(el, "is_in_viewport", False):
            continue
        tag = (getattr(el, "tag_name", None) or "").lower()[:24]
        try:
            t = el.get_all_text_till_next_clickable_element(max_depth=2)
        except Exception:
            t = ""
        t = re.sub(r"\s+", " ", (t or "").strip())[:110]
        role = ""
        attrs = getattr(el, "attributes", None) or {}
        if isinstance(attrs, dict):
            role = str(attrs.get("role") or "")[:32]
        bits = [x for x in (role, tag, t) if x]
        if bits:
            lines.append(f"- [{idx}] " + " | ".join(bits))
        if len(lines) >= max_items:
            break
    if not lines:
        return ""
    return "## 视口内交互控件摘要（索引仅供对齐，步骤描述请用语义化自然语言）\n" + "\n".join(lines)


def observation_summary(obs: dict[str, Any], cfg: ExplorationRunConfig) -> str:
    title = str(obs.get("title") or "")
    url = str(obs.get("url") or "")
    ps = str(obs.get("page_state_id") or "")
    n_iv = len(obs.get("inview_indices") or [])
    lines = [
        f"title: {title[:200]}",
        f"url: {url[:300]}",
        f"page_state_id: {ps}",
        f"inview_interactive_count: {n_iv}",
    ]
    if cfg.extended_observation:
        for k in (
            "obs_heading_line",
            "obs_overlay_hint",
            "obs_form_sections",
            "obs_table_headers",
        ):
            v = obs.get(k)
            if v:
                lines.append(f"{k}: {str(v)[:300]}")
    return "\n".join(lines)


def _format_exploration_steps_chain(steps: list[ExplorationStep]) -> str:
    parts: list[str] = []
    for i, s in enumerate(steps):
        label = (s.locate_prompt or "").strip() or (s.tap_description or "").strip() or f"idx {s.element_index}"
        parts.append(f"{i + 1}) [{s.step_kind}@{s.element_index}] {label[:100]}")
    return " → ".join(parts)


def _format_composite_tasks_for_intent_context(tasks: list[ActionTask], *, limit: int) -> str:
    lines: list[str] = []
    for t in tasks[: max(1, limit)]:
        if not t.composite_steps:
            continue
        src = str(t.task_source or "")
        pk = (t.dedupe_path_key or "")[:24]
        chain = _format_exploration_steps_chain(t.composite_steps)
        lines.append(f"- [{src}] key…{pk} | {chain}")
    return "\n".join(lines) if lines else ""


def build_intent_planner_extra_context(
    *,
    graph: GraphStore,
    anchor_url: str,
    anchor_norm: str,
    anchor_depth: int,
    run_id: str,
    cfg: ExplorationRunConfig,
    enum_state: Any | None,
    blocked_path_keys: set[str],
) -> str:
    """将原 graph_guided / composite_seed  planner 的候选压缩为文本，供意图 LLM 吸收。"""
    from dataclasses import replace

    from recursive_exploration.composite_planner import (
        plan_composite_tasks_for_anchor,
        plan_graph_guided_composite_tasks,
    )

    blocks: list[str] = []
    lim = max(1, int(cfg.composite_max_tasks_per_anchor or 3))

    cfg_gg = replace(
        cfg,
        graph_guided_composite_enabled=True,
        composite_enabled=True,
    )
    vw = float(cfg.composite_viewport_fallback_width)
    vh = float(cfg.composite_viewport_fallback_height)
    sm: dict[int, Any] | None = None
    if enum_state is not None:
        sm_raw = getattr(enum_state, "selector_map", None)
        sm = sm_raw if isinstance(sm_raw, dict) else None
    gg_tasks = plan_graph_guided_composite_tasks(
        graph=graph,
        anchor_url=anchor_url,
        anchor_norm=anchor_norm,
        anchor_depth=anchor_depth,
        run_id=run_id,
        cfg=cfg_gg,
        blocked_path_keys=set(),
        selector_map=sm,
        viewport_wh=(vw, vh),
        stats_sink=None,
    )
    gg_txt = _format_composite_tasks_for_intent_context(gg_tasks, limit=lim)
    if gg_txt:
        blocks.append(
            "## 图谱链组合候选（与原 graph_guided 同源；供深化与排重，勿机械照搬 DOM 索引）\n" + gg_txt
        )
    else:
        blocks.append("## 图谱链组合候选\n（尚无≥2 跳的成功边链，或图尚未写入）")

    if enum_state is not None:
        hp_tasks = plan_composite_tasks_for_anchor(
            state=enum_state,
            anchor_url=anchor_url,
            anchor_norm=anchor_norm,
            anchor_depth=anchor_depth,
            run_id=run_id,
            cfg=cfg,
            prior_path_keys=set(),
            scroll_first=False,
            scroll_delta_y=int(cfg.scroll_delta_y_px),
            stats_sink=None,
        )
        heur_txt = _format_composite_tasks_for_intent_context(hp_tasks, limit=lim)
        if heur_txt:
            blocks.append(
                "## 视口内表单启发式候选（与原 composite_seed 同源；可改写为自然语言步骤，避免与上表重复）\n"
                + heur_txt
            )
        else:
            blocks.append(
                "## 视口内表单启发式候选\n（无「输入+提交」类组合或视口内无满足条件的控件）"
            )
    else:
        blocks.append("## 视口内表单启发式候选\n（无枚举 BrowserState，跳过）")

    if blocked_path_keys:
        sample = sorted(blocked_path_keys)[:48]
        bl = "\n".join(f"- {k[:96]}" for k in sample)
        more = len(blocked_path_keys) - len(sample)
        tail = f"\n… 另有 {more} 条已记录路径键" if more > 0 else ""
        blocks.append(
            "## 原子路径键（dedupe；仅供参考）\n"
            "以下为单次 DOM 点击序列指纹，**不代表端到端业务场景已穷尽**。\n"
            "请基于图谱与页面仍规划新的高价值端到端 mission（不同数据、断言、分支入口）；勿仅因列表较长而返回空。\n"
            + bl
            + tail
        )

    return "\n\n".join(blocks)


def _strip_json_fence(text: str) -> str:
    s = (text or "").strip()
    if s.startswith("```"):
        lines = s.splitlines()
        if lines and lines[0].startswith("```"):
            lines = lines[1:]
        if lines and lines[-1].strip() == "```":
            lines = lines[:-1]
        s = "\n".join(lines).strip()
    return s


def _extract_first_json_value(s: str) -> Any:
    """
    从夹杂自然语言的文本中切出第一个完整 JSON 数组或对象（括号配对 + 字符串内忽略括号）。
    """
    s = s.strip()
    pairs = {"[": "]", "{": "}"}
    i = 0
    while i < len(s):
        if s[i] not in pairs:
            i += 1
            continue
        start = i
        stack = [s[i]]
        i += 1
        in_str = False
        esc = False
        str_q = ""
        while i < len(s) and stack:
            c = s[i]
            if in_str:
                if esc:
                    esc = False
                elif c == "\\":
                    esc = True
                elif c == str_q:
                    in_str = False
                i += 1
                continue
            if c in "'\"":
                in_str = True
                str_q = c
                i += 1
                continue
            if c in pairs:
                stack.append(c)
            elif c in "]}":
                if not stack:
                    break
                op = stack[-1]
                if pairs[op] != c:
                    break
                stack.pop()
            i += 1
            if not stack:
                return json.loads(s[start:i])
        break
    raise json.JSONDecodeError("intent_missions: no balanced JSON value", s, 0)


def _parse_json_loose(raw: str) -> Any:
    s = _strip_json_fence(raw)
    try:
        return json.loads(s)
    except json.JSONDecodeError:
        pass
    try:
        return _extract_first_json_value(s)
    except (json.JSONDecodeError, ValueError):
        pass
    m = re.search(r"\{[\s\S]*\}", s)
    if m:
        try:
            return json.loads(m.group(0))
        except json.JSONDecodeError:
            pass
    m_arr = re.search(r"\[[\s\S]*\]", s)
    if m_arr:
        return json.loads(m_arr.group(0))
    raise json.JSONDecodeError("intent_missions: no JSON object or array found", s, 0)


def coerce_root_payload(parsed: Any) -> Any:
    """把常见的模型偏差规整为 {\"missions\": [...]}。"""
    if isinstance(parsed, list):
        if parsed and all(isinstance(x, dict) for x in parsed):
            return {"missions": parsed}
        return {"missions": []}
    if not isinstance(parsed, dict):
        return parsed
    if "missions" in parsed:
        return parsed
    if isinstance(parsed.get("mission"), list):
        return {"missions": parsed["mission"]}
    data = parsed.get("data")
    if isinstance(data, dict) and isinstance(data.get("missions"), list):
        return {"missions": data["missions"]}
    if "ai_steps" in parsed or "steps" in parsed:
        return {"missions": [parsed]}
    return parsed


def normalize_ai_steps(
    raw: Any,
    *,
    max_steps: int,
    max_chars: int,
) -> list[str]:
    """统一得到非空字符串步骤列表（支持 string / list / 数字项）。"""
    if raw is None:
        return []
    if isinstance(raw, str):
        lines = re.split(r"[\n\r]+", raw.strip())
        out: list[str] = []
        for line in lines:
            line = re.sub(r"^\s*[\d]+[.)、]\s*", "", line.strip())
            if line:
                out.append(line[:max_chars])
            if len(out) >= max_steps:
                break
        if len(out) <= 1 and "；" in raw:
            for part in raw.split("；")[:max_steps]:
                t = part.strip()
                if t:
                    out.append(t[:max_chars])
        return out[:max_steps]
    if isinstance(raw, list):
        out2: list[str] = []
        for x in raw[:max_steps]:
            if isinstance(x, str):
                t = x.strip()
            else:
                t = str(x).strip()
            if t:
                out2.append(t[:max_chars])
        return out2
    return []


def _edge_user_intent_label(e: dict[str, Any]) -> str:
    """从成功边提炼面向 Agent 的自然语言片段（不含 DOM 索引）。"""
    ts = e.get("target_step") if isinstance(e.get("target_step"), dict) else {}
    s = (
        str(ts.get("locate_prompt") or "").strip()
        or str(ts.get("tap_description") or "").strip()
    )
    if s:
        return s[:320]
    tag = str(e.get("action_tag") or "").strip()
    uc = bool(e.get("url_changed"))
    hint = "跨页导航" if uc else "同页交互"
    return f"{hint}（{tag or '未知'}）"


def synthesize_fallback_intent_missions(
    graph: GraphStore,
    anchor_url_norm: str,
    obs: dict[str, Any],
    cfg: ExplorationRunConfig,
) -> list[dict[str, Any]]:
    """
    LLM 返回空 missions 时的确定性兜底：按成功边链或非重叠边对构造 ≥2 步的端到端描述。
    图谱表示可达性与信号，**不**表示业务场景已穷举。
    """
    max_m = max(1, min(int(cfg.intent_mission_max_per_anchor), 32))
    step_cap = effective_intent_max_ai_steps(cfg)

    ok_edges: list[dict[str, Any]] = []
    for e in graph.edges.values():
        if not isinstance(e, dict):
            continue
        if str(e.get("anchor_url_norm") or "") != anchor_url_norm:
            continue
        if str(e.get("result") or "") != "ok":
            continue
        ok_edges.append(e)
    ok_edges.sort(key=lambda x: str(x.get("edge_id") or ""))

    missions: list[dict[str, Any]] = []
    seen_pairs: set[tuple[str, str]] = set()

    # 1) 图中前后相接的两条成功边（真实路径片段）
    by_from: dict[str, list[dict[str, Any]]] = {}
    for e in ok_edges:
        fid = str(e.get("from_node_id") or "")
        if fid:
            by_from.setdefault(fid, []).append(e)

    pri = 0
    for e1 in ok_edges:
        if len(missions) >= max_m:
            break
        tid = str(e1.get("to_node_id") or "")
        if not tid:
            continue
        for e2 in by_from.get(tid, ()):
            if len(missions) >= max_m:
                break
            k = (str(e1.get("edge_id")), str(e2.get("edge_id")))
            if k in seen_pairs:
                continue
            seen_pairs.add(k)
            raw_steps = [
                _edge_imperative_sentence(e1, graph),
                _edge_imperative_sentence(e2, graph),
            ]
            if step_cap >= 3:
                raw_steps.append(_deepening_step_sentence())
            missions.append({"priority": pri, "ai_steps": raw_steps[:step_cap]})
            pri += 1

    # 2) 仍不足：按 edge_id 排序后的非重叠相邻边对
    i_pair = 0
    while len(missions) < max_m and i_pair + 1 < len(ok_edges):
        e1, e2 = ok_edges[i_pair], ok_edges[i_pair + 1]
        k = (str(e1.get("edge_id")), str(e2.get("edge_id")))
        i_pair += 2
        if k in seen_pairs:
            continue
        seen_pairs.add(k)
        raw_steps = [
            _edge_imperative_sentence(e1, graph),
            _edge_imperative_sentence(e2, graph),
        ]
        if step_cap >= 3:
            raw_steps.append(_deepening_step_sentence())
        missions.append({"priority": pri, "ai_steps": raw_steps[:step_cap]})
        pri += 1

    # 3) 仅一条成功边：两步叙事
    if len(missions) < max_m and len(ok_edges) == 1:
        e = ok_edges[0]
        raw_steps = [
            _edge_imperative_sentence(e, graph),
            _deepening_step_sentence(),
        ]
        missions.append({"priority": pri, "ai_steps": raw_steps[:step_cap]})

    # 4) 仍无（极少）：页面摘要兜底
    if not missions:
        title = str(obs.get("title") or "").strip()[:120]
        url_h = str(obs.get("url") or "").strip()[:160]
        head = title or url_h or "当前业务页面"
        missions.append(
            {
                "priority": 0,
                "ai_steps": [
                    f"在「{head}」上识别主导航或核心业务入口并进入主流程",
                    "完成一条端到端操作（含必要输入/提交/切换），并断言可见结果或页面状态变化。",
                ],
            }
        )

    out: list[dict[str, Any]] = []
    for m in missions[:max_m]:
        raw_steps = m.get("ai_steps") or []
        if not isinstance(raw_steps, list):
            continue
        steps = [str(x).strip() for x in raw_steps if str(x).strip()][:step_cap]
        if len(steps) >= 2:
            out.append({"priority": int(m.get("priority", 0)), "ai_steps": steps})
    return out


def validate_and_normalize_missions(
    raw: Any,
    *,
    max_missions: int,
    max_steps_per_mission: int,
    max_step_chars: int,
) -> tuple[list[dict[str, Any]], str | None]:
    """
    校验 LLM 输出；返回 (missions, error_reason)。
    每项为 {"priority": int, "ai_steps": [str, ...]}。
    """
    raw = coerce_root_payload(raw)
    if not isinstance(raw, dict):
        return [], "root_not_object"
    missions = raw.get("missions")
    if not isinstance(missions, list):
        return [], "missions_not_list"
    out: list[dict[str, Any]] = []
    for i, m in enumerate(missions[: max(0, max_missions)]):
        if not isinstance(m, dict):
            continue
        pri = m.get("priority", i)
        try:
            pri_i = int(pri)
        except (TypeError, ValueError):
            pri_i = i
        steps_raw = m.get("ai_steps")
        if steps_raw is None:
            steps_raw = m.get("steps") or m.get("subtasks") or m.get("tasks")
        steps = normalize_ai_steps(
            steps_raw,
            max_steps=max_steps_per_mission,
            max_chars=max_step_chars,
        )
        steps = [s for s in steps if intent_ai_step_passes_quality(s)]
        if len(steps) < 2:
            continue
        out.append({"priority": pri_i, "ai_steps": steps})
    out.sort(key=lambda x: int(x.get("priority", 0)))
    if not out:
        return [], "no_valid_missions"
    return out, None


def _append_plan_audit(
    audit_path: Path,
    *,
    run_id: str,
    anchor_url_norm: str,
    phase: str,
    raw_text_head: str,
    validate_err: str | None,
) -> None:
    """追加一行 JSONL，便于排查模型输出格式问题。"""
    try:
        audit_path.parent.mkdir(parents=True, exist_ok=True)
        line = json.dumps(
            {
                "ts": datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z"),
                "run_id": run_id,
                "anchor_url_norm": anchor_url_norm,
                "phase": phase,
                "raw_text_head": (raw_text_head or "")[:4000],
                "validate_err": validate_err,
            },
            ensure_ascii=False,
        )
        with audit_path.open("a", encoding="utf-8") as f:
            f.write(line + "\n")
    except OSError:
        logger.debug("intent_missions: 无法写入审计文件", exc_info=True)


@dataclass(frozen=True)
class IntentPlanResult:
    """意图规划结果：missions 为空时 skip_reason 说明原因（机器可读）。"""

    missions: list[dict[str, Any]]
    skip_reason: str = ""
    raw_text: str = ""
    validate_err: str | None = None


async def plan_intent_missions_llm(
    *,
    graph: GraphStore,
    anchor_url: str,
    anchor_url_norm: str,
    obs: dict[str, Any],
    cfg: ExplorationRunConfig,
    run_id: str,
    anchor_depth: int,
    enum_state: Any | None = None,
    blocked_path_keys: set[str] | None = None,
) -> IntentPlanResult:
    """调用 LLM；失败时 missions 为空并设置 skip_reason。"""
    audit_path = graph.out_dir / "intent_mission_plan_audit.jsonl"

    if cfg.intent_mission_max_per_anchor <= 0:
        return IntentPlanResult([], skip_reason="disabled_max_zero")

    llm = try_get_page_extraction_llm()
    if llm is None:
        logger.warning("intent_missions: 无可用 page_extraction_llm，跳过规划")
        _append_plan_audit(
            audit_path,
            run_id=run_id,
            anchor_url_norm=anchor_url_norm,
            phase="llm_unavailable",
            raw_text_head="",
            validate_err=None,
        )
        return IntentPlanResult([], skip_reason="llm_unavailable")

    try:
        from langchain_core.messages import HumanMessage, SystemMessage
    except ImportError as e:
        logger.warning("intent_missions: 需要 langchain_core: %s", e)
        _append_plan_audit(
            audit_path,
            run_id=run_id,
            anchor_url_norm=anchor_url_norm,
            phase="no_langchain",
            raw_text_head="",
            validate_err=str(e),
        )
        return IntentPlanResult([], skip_reason="no_langchain")

    gtxt = graph_edges_summary_enriched(graph, anchor_url_norm)
    prior_p = Path(cfg.prior_graph_path).expanduser() if cfg.prior_graph_path else None
    prior_txt = prior_graph_edges_summary(prior_p, anchor_url_norm)
    if prior_txt:
        gtxt = gtxt + "\n\n## 历史 run 图谱（prior_graph）\n" + prior_txt

    otxt = observation_summary(obs, cfg)
    ctrl_txt = compact_selector_map_summary(obs)
    meta_txt = load_graph_run_meta_digest(graph.out_dir / "graph.json")
    enum_txt = enumerate_recent_candidates_digest(getattr(graph, "enumerations_path", None), anchor_url_norm)
    step_cap = effective_intent_max_ai_steps(cfg)
    extra = build_intent_planner_extra_context(
        graph=graph,
        anchor_url=anchor_url,
        anchor_norm=anchor_url_norm,
        anchor_depth=anchor_depth,
        run_id=run_id,
        cfg=cfg,
        enum_state=enum_state,
        blocked_path_keys=set(blocked_path_keys or ()),
    )
    system = (
        "你是资深 Web 端测试与可用性探索规划助手。请站在「真实使用者 + 质量测试」视角，基于给定上下文输出**仅一段合法 JSON**，不要用 Markdown 围栏。\n"
        "必须严格使用英文键名：顶层 key 为 missions（数组）；每项含 priority（整数，越小越优先）与 ai_steps（字符串数组）。\n"
        "每条 ai_steps 中的句子会被映射为 browser-use 的 `ai` 自然语言步：模型将自行判断点击、输入、选择、滚动等，你应用**具体动词**写出动作意图（如打开、选择、输入、提交、展开、切换、确认），"
        "涉及文本录入时必须写成明确的「输入/填写 …」类表述，避免把本该键盘输入的动作写成仅「点击输入框」。\n"
        "\n要求：\n"
        f"1) 每个 mission 的 ai_steps 至少 2 条、至多 {step_cap} 条；步数硬上限与组合任务链一致（本配置下为 {step_cap}）。\n"
        "2) **图谱与枚举是素材**：成功边只说明系统可达，**绝不等于**场景已探索完毕。你必须优先产出端到端、可验证的用户旅程（跨页、配置、输入变体、回归断言、异常路径等）。\n"
        "3) 规划若干**叙事主线不同**的 mission：不同入口、数据、断言焦点或业务目标；避免多条 mission 仅在措辞上重复同一故事。\n"
        "4) 图谱链/表单启发式、原子路径键均为辅助信号：改写为自然语言步骤，**禁止**复述 DOM 索引或内部哈希；路径键表示单次原子序列曾出现，**禁止**据此推断「无需再测」而返回空。\n"
        "5) 每步中文或英文均可；单步字符上限见校验配置。\n"
        f"6) 至多 {cfg.intent_mission_max_per_anchor} 条 mission；优先高价值与可区分性。\n"
        "7) **禁止**因「边很多」「与历史相似」「不确定」而输出 {\"missions\":[]}；"
        "仅当缺少页面标题/URL、且图谱摘要无任何成功边、且视口无任何交互线索时，才允许空 missions。\n"
        "其它情况**必须**至少输出 1 条且每条 ≥2 步。\n"
        "8) 每条 ai_steps 必须**自包含**：禁止「第一步/第二步」「上一步之后」「沿已成功路径」「同一业务流程接下来」等指代措辞；"
        "禁止「span 位于 div > …」类 DOM 层级描述，须使用按钮/链接/字段上**可见的中文或英文文案**。\n"
        "9) 在步数预算内优先主流程 + **可验证结果**（核对反馈文案、关键数值）或再向下一级界面推进，避免把多步写成对图谱的简单复述。\n"
    )
    user_parts = [
        f"anchor_url_norm={anchor_url_norm}",
        f"anchor_url={anchor_url}",
        f"run_id={run_id} anchor_depth={anchor_depth}",
        f"intent_step_cap_shared_with_composite={step_cap}",
        "",
        "## 图谱摘要",
        gtxt,
        "",
        "## 页面观测",
        otxt,
    ]
    if ctrl_txt:
        user_parts.extend(["", ctrl_txt])
    if meta_txt:
        user_parts.extend(["", "## 本 run 配置摘要（graph.json run_meta）", meta_txt])
    if enum_txt:
        user_parts.extend(["", enum_txt])
    user_parts.extend(["", extra])
    user = "\n".join(user_parts) + "\n"
    text = ""
    try:
        msg = await llm.ainvoke([SystemMessage(content=system), HumanMessage(content=user)])
        content = getattr(msg, "content", None)
        text = str(content) if content is not None else ""
        parsed = _parse_json_loose(text)
    except Exception as e:
        logger.warning("intent_missions: LLM 调用或 JSON 解析失败", exc_info=True)
        _append_plan_audit(
            audit_path,
            run_id=run_id,
            anchor_url_norm=anchor_url_norm,
            phase="parse_error",
            raw_text_head=text,
            validate_err=repr(e),
        )
        return IntentPlanResult([], skip_reason="parse_error", raw_text=text, validate_err=repr(e))

    missions, err = validate_and_normalize_missions(
        parsed,
        max_missions=cfg.intent_mission_max_per_anchor,
        max_steps_per_mission=step_cap,
        max_step_chars=cfg.intent_mission_max_step_chars,
    )
    used_fallback = False
    if err:
        logger.info("intent_missions: 校验未产生任务: %s", err)
        _append_plan_audit(
            audit_path,
            run_id=run_id,
            anchor_url_norm=anchor_url_norm,
            phase=f"validate:{err}",
            raw_text_head=text,
            validate_err=err,
        )

    if getattr(cfg, "intent_mission_synthesize_when_empty", True) and not missions:
        fb = synthesize_fallback_intent_missions(graph, anchor_url_norm, obs, cfg)
        missions_fb, err_fb = validate_and_normalize_missions(
            {"missions": fb},
            max_missions=cfg.intent_mission_max_per_anchor,
            max_steps_per_mission=step_cap,
            max_step_chars=cfg.intent_mission_max_step_chars,
        )
        if missions_fb:
            missions = missions_fb
            err = None
            used_fallback = True
            logger.info(
                "intent_missions: LLM 未产出合法 mission，已启用图谱兜底合成 %d 条",
                len(missions_fb),
            )
            _append_plan_audit(
                audit_path,
                run_id=run_id,
                anchor_url_norm=anchor_url_norm,
                phase="fallback_synthesized",
                raw_text_head=json.dumps({"missions": fb}, ensure_ascii=False)[:4000],
                validate_err=None,
            )
        elif err_fb:
            logger.info("intent_missions: 兜底合成校验未通过: %s", err_fb)

    if not missions:
        sr = err or "no_valid_missions"
        return IntentPlanResult(
            [],
            skip_reason=f"validate:{sr}" if err else "empty_after_validate",
            raw_text=text,
            validate_err=err,
        )

    if not used_fallback:
        _append_plan_audit(
            audit_path,
            run_id=run_id,
            anchor_url_norm=anchor_url_norm,
            phase="ok",
            raw_text_head=text[:2000],
            validate_err=None,
        )
    return IntentPlanResult(missions, skip_reason="", raw_text=text, validate_err=None)


async def plan_intent_mission_continuation_llm(
    *,
    graph: GraphStore,
    anchor_url: str,
    anchor_url_norm: str,
    obs: dict[str, Any],
    cfg: ExplorationRunConfig,
    run_id: str,
    prior_executed_steps: list[str],
    continuation_index: int,
) -> list[str]:
    """首轮 intent YAML 完成后在同一会话内深化：仅返回新的 ``ai`` 步列表。"""
    audit_path = graph.out_dir / "intent_mission_plan_audit.jsonl"
    max_steps = max(
        2,
        min(int(cfg.intent_mission_continuation_max_steps), int(cfg.intent_mission_max_ai_steps)),
    )
    max_chars = int(cfg.intent_mission_max_step_chars)

    llm = try_get_page_extraction_llm()
    if llm is None:
        _append_plan_audit(
            audit_path,
            run_id=run_id,
            anchor_url_norm=anchor_url_norm,
            phase="continuation_llm_unavailable",
            raw_text_head="",
            validate_err=None,
        )
        return []

    try:
        from langchain_core.messages import HumanMessage, SystemMessage
    except ImportError as e:
        _append_plan_audit(
            audit_path,
            run_id=run_id,
            anchor_url_norm=anchor_url_norm,
            phase="continuation_no_langchain",
            raw_text_head="",
            validate_err=str(e),
        )
        return []

    gtxt = graph_edges_summary_enriched(graph, anchor_url_norm, limit=40)
    otxt = observation_summary(obs, cfg)
    ctrl_txt = compact_selector_map_summary(obs)
    done_lines = "\n".join(f"- {(s or '')[:400]}" for s in prior_executed_steps[:32])

    system = (
        "你是测试探索规划助手。当前浏览器已执行完一段多步 intent 任务；请在**同一会话、同一标签页**上继续深化测试。\n"
        "输出**仅**合法 JSON：顶层对象形如 {\"ai_steps\":[\"...\", \"...\"]}。不要用 Markdown 围栏。\n"
        f"ai_steps：至少 2 条、至多 {max_steps} 条；每条为 browser-use `ai` 自然语言步，须**自包含**"
        "（禁止「上一步之后」「第二步」等指代），禁止 DOM 标签链；须用**可见文案**描述目标。\n"
        "优先：边界输入、提交后核对反馈、打开二级详情、切换 Tab、展开高级项、断言关键业务数据。不要重复已列出的步骤。\n"
    )
    user_parts = [
        f"continuation_index={continuation_index}",
        f"anchor_url_norm={anchor_url_norm}",
        f"anchor_url={anchor_url}",
        f"run_id={run_id}",
        "",
        "## 图谱摘要",
        gtxt,
        "",
        "## 当前页面观测",
        otxt,
    ]
    if ctrl_txt:
        user_parts.extend(["", ctrl_txt])
    user_parts.extend(
        [
            "",
            "## 已执行 intent 步骤（勿重复；只输出**新**步骤）",
            done_lines if done_lines else "（无）",
            "",
        ]
    )
    user = "\n".join(user_parts) + "\n"
    text = ""
    try:
        msg = await llm.ainvoke([SystemMessage(content=system), HumanMessage(content=user)])
        content = getattr(msg, "content", None)
        text = str(content) if content is not None else ""
        parsed = _parse_json_loose(text)
    except Exception as e:
        logger.warning("intent_missions: continuation LLM 调用或 JSON 解析失败", exc_info=True)
        _append_plan_audit(
            audit_path,
            run_id=run_id,
            anchor_url_norm=anchor_url_norm,
            phase="continuation_parse_error",
            raw_text_head=text[:4000],
            validate_err=repr(e),
        )
        return []

    raw_steps = None
    if isinstance(parsed, dict):
        raw_steps = parsed.get("ai_steps")
    steps = normalize_ai_steps(
        raw_steps,
        max_steps=max_steps,
        max_chars=max_chars,
    )
    steps = [s for s in steps if intent_ai_step_passes_quality(s)]
    prior_set = {x.strip() for x in prior_executed_steps if x.strip()}
    steps = [s for s in steps if s.strip() not in prior_set]
    if len(steps) < 2:
        _append_plan_audit(
            audit_path,
            run_id=run_id,
            anchor_url_norm=anchor_url_norm,
            phase="continuation_validate_empty",
            raw_text_head=text[:2000],
            validate_err=None,
        )
        return []
    _append_plan_audit(
        audit_path,
        run_id=run_id,
        anchor_url_norm=anchor_url_norm,
        phase=f"continuation_ok_{continuation_index}",
        raw_text_head=text[:2000],
        validate_err=None,
    )
    return steps


def build_intent_action_tasks(
    missions: list[dict[str, Any]],
    *,
    anchor_url: str,
    anchor_url_norm: str,
    run_id: str,
    anchor_depth: int,
) -> list[ActionTask]:
    out: list[ActionTask] = []
    for m in missions:
        steps = list(m.get("ai_steps") or [])
        if not steps:
            continue
        fp = intent_target_fingerprint(steps)
        pk = dedupe_path_key(anchor_url_norm, canonical_prefix_steps_json([]), fp)
        tid = "t_" + pk[:16]
        desc = steps[0][:120]
        head = (steps[0] or "").strip()[:180]
        lp = f"多步意图任务（共 {len(steps)} 步），首步摘要：{head}"
        out.append(
            ActionTask(
                task_id=tid,
                run_id=run_id,
                anchor_url=anchor_url,
                anchor_url_norm=anchor_url_norm,
                dedupe_path_key=pk,
                prefix_steps=[],
                target_index=-1,
                target_branch_path_hash="",
                target_description=desc,
                action_kind="intent_mission",
                locate_prompt=lp,
                anchor_depth=anchor_depth,
                task_kind="intent_mission",
                task_source="intent_mission",
                intent_ai_steps=steps,
            )
        )
    return out
