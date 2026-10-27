"""
探索 run 的人类叙事审查产物：timeline.json + review_timeline.html。

从 `events.jsonl`、`graph.json` 派生；可选读取 `queues.jsonl` 仅做聚合统计（不逐行嵌入 HTML）。
timeline schema 常量：TIMELINE_SCHEMA（exploration-timeline/v1）。
"""
from __future__ import annotations

import base64
import html
import json
import re
import sys
from collections import Counter
from typing import Any, Callable, Sequence
from datetime import datetime, timezone
from pathlib import Path

from recursive_exploration.task_labels import step_origin_display

TIMELINE_SCHEMA = "exploration-timeline/v1"

_YAML_FULL_MAX_CHARS = 120_000


def _guess_image_mime(path: Path) -> str:
    s = path.suffix.lower()
    if s == ".png":
        return "image/png"
    if s in (".jpg", ".jpeg"):
        return "image/jpeg"
    if s == ".gif":
        return "image/gif"
    if s == ".webp":
        return "image/webp"
    if s == ".svg":
        return "image/svg+xml"
    return "image/png"


def _resolve_asset_path(ref: str, base: Path) -> Path | None:
    """将报告中的相对路径解析为 base 下的真实文件；禁止跳出 base。"""
    ref = ref.strip().replace("\\", "/")
    if not ref or ref.startswith(("http://", "https://", "data:", "//")):
        return None
    try:
        base_r = base.resolve()
        p = Path(ref)
        if p.is_absolute():
            cand = p.resolve()
        else:
            cand = (base_r / ref).resolve()
        cand.relative_to(base_r)
    except ValueError:
        return None
    if cand.is_file():
        return cand
    return None


def _image_file_to_data_uri(path: Path) -> str | None:
    try:
        raw = path.read_bytes()
    except OSError:
        return None
    mime = _guess_image_mime(path)
    b64 = base64.standard_b64encode(raw).decode("ascii")
    return f"data:{mime};base64,{b64}"

_TIMELINE_BUCKET_ORDER = ("native", "expand", "composite", "intent", "other")
_TIMELINE_BUCKET_LABEL = {
    "native": "首轮入队",
    "expand": "扩队新增",
    "composite": "多步组合",
    "intent": "意图任务",
    "other": "其它",
}


def _schedule_order_by_anchor_norm(sched_rows: list[Any]) -> dict[str, int]:
    """url_anchor_schedule 行 → url_norm → 出队序号（# 列）。"""
    m: dict[str, int] = {}
    for r in sched_rows:
        if not isinstance(r, dict):
            continue
        un = str(r.get("url_norm") or "").strip()
        ord_ = r.get("order")
        if un and isinstance(ord_, int):
            m.setdefault(un, ord_)
    return m


def _timeline_origin_bucket(st: dict[str, Any]) -> str:
    """时间轴书签分组：与 step_origin / 组合链 对齐。"""
    if st.get("timeline_kind") == "composite_chain":
        return "composite"
    so = str(st.get("step_origin") or "").strip()
    if so == "single_native":
        return "native"
    if so == "single_expand":
        return "expand"
    if so == "composite":
        return "composite"
    if so == "intent_mission":
        return "intent"
    return "other"


def _step_anchor_id(st: dict[str, Any]) -> str:
    seq = st.get("seq")
    if isinstance(seq, int) and seq > 0:
        return f"tl-step-{seq}"
    return "tl-step-0"


def _timeline_nav_step_label(st: dict[str, Any]) -> str:
    if st.get("timeline_kind") == "composite_chain":
        a = st.get("seq")
        b = st.get("seq_end")
        if isinstance(a, int) and isinstance(b, int) and a != b:
            return f"组合链 · 全局 {a}–{b}"
        if isinstance(a, int):
            return f"组合链 · 全局 {a}"
        return "组合链"
    seq = st.get("seq")
    aseq = st.get("anchor_step_seq")
    if isinstance(seq, int) and isinstance(aseq, int):
        return f"步骤 {seq} · 会话 {aseq}"
    if isinstance(seq, int):
        return f"步骤 {seq}"
    return "步骤"


def _step_result_badge(st: dict[str, Any]) -> tuple[str, str]:
    """单步任务 result → (css 类名片段, 中文短标签)，用于侧栏步骤书签。"""
    r = str(st.get("result") or "").strip().lower()
    if r == "ok":
        return "ok", "成功"
    if r == "failed":
        return "failed", "失败"
    if r == "skipped":
        return "skipped", "跳过"
    return "unknown", "未知"


def _timeline_bucket_outcome(bucket_items: list[dict[str, Any]]) -> tuple[str, str]:
    """
    单个时间轴来源分组（首轮入队 / 扩队新增 / …）内步骤的成败聚合，用于侧栏与分组标题角标。
    任一步 failed → 有失败；否则存在 ok → 成功；否则均 skipped → 均跳过。
    """
    if not bucket_items:
        return "unknown", "无步骤"
    results: list[str] = []
    for st in bucket_items:
        r = str(st.get("result") or "").strip().lower()
        if r in ("ok", "failed", "skipped"):
            results.append(r)
        elif r:
            results.append(r)
    if not results:
        return "unknown", "未知"
    if any(x == "failed" for x in results):
        return "failed", "有失败"
    if any(x == "ok" for x in results):
        return "ok", "成功"
    if all(x == "skipped" for x in results):
        return "skipped", "均跳过"
    return "unknown", "未知"


def _render_timeline_url_section(
    anchor_norm: str,
    items: list[dict[str, Any]],
    card_fn: Any,
    *,
    url_order: int,
    expl_depth_s: str,
) -> tuple[str, str]:
    """
    单调度锚点下的时间轴 HTML + 侧栏 <li> 片段（内含多级 <ul>）。
    步骤按来源桶分组，桶内保留时间序并插入浏览上下文小标题。
    """
    from collections import defaultdict

    buckets: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for st in items:
        buckets[_timeline_origin_bucket(st)].append(st)

    block_id = f"tl-url-{url_order}"
    title_esc = html.escape(anchor_norm) if anchor_norm else "（无 anchor_url_norm）"
    hint = (
        f'<p class="section-hint"><small>对应<strong> URL-{url_order} </strong>（与上方「锚点出队序」一致），调度锚点 <code>{title_esc}</code>。'
        "下列按<strong>首轮入队 / 扩队新增 / 多步组合 / 意图任务</strong>分组，组内为时间顺序；"
        "<strong>点击分组标题</strong>可折叠或展开其下步骤与截图。左侧书签树可折叠、可跳转。"
        f"<code>exploration_depth</code>={expl_depth_s}。</small></p>"
    )
    body_parts: list[str] = [
        f'<section class="anchor-block tl-url-block" id="{block_id}">',
        f'<h2 class="anchor-title">URL-{url_order} · <code>{title_esc}</code></h2>',
        hint,
    ]
    nav_bucket_lis: list[str] = []

    for bucket in _TIMELINE_BUCKET_ORDER:
        bucket_items = buckets.get(bucket, [])
        if not bucket_items:
            continue
        bucket_id = f"{block_id}-bucket-{bucket}"
        label = _TIMELINE_BUCKET_LABEL[bucket]
        b_code, b_label = _timeline_bucket_outcome(bucket_items)
        b_cls = html.escape(b_code) if b_code in ("ok", "failed", "skipped", "unknown") else "unknown"
        b_label_e = html.escape(b_label)
        bucket_badge = (
            f'<span class="tl-session-badge tl-sess-{b_cls}" title="本分组内各步结果聚合（非整页 URL 汇总）">{b_label_e}</span>'
        )
        nav_bucket_badge = (
            f'<span class="tl-session-badge tl-sess-{b_cls} tl-nav-sess-bucket" title="本分组内结果聚合">{b_label_e}</span>'
        )

        body_parts.append(
            f'<details class="tl-origin-block" id="{bucket_id}" open>'
            f'<summary class="tl-origin-title">'
            f'<span class="tl-origin-chevron" aria-hidden="true"></span>'
            f'<span class="tl-origin-label">{html.escape(label)}</span>{bucket_badge}'
            f'<span class="tl-fold-hint"><small>点击标题 · 展开/折叠</small></span>'
            f"</summary>"
            f'<div class="tl-origin-body">'
        )

        prev_disp: str | None = None
        step_nav_lis: list[str] = []
        for st in bucket_items:
            ua = str(st.get("url_after") or "").strip()
            ub = str(st.get("url_before") or "").strip()
            gk_raw = ua if ua else ub
            if not gk_raw:
                gk_raw = "（本步前后地址均未记录）"
            disp = _browse_context_display_label(gk_raw)
            if disp != prev_disp:
                extra = ""
                if gk_raw.lower().startswith("chrome-error:"):
                    extra = f'<p class="url-after-raw"><small>原始 URL：<code>{html.escape(gk_raw)}</code></small></p>'
                body_parts.append(
                    f'<h4 class="url-after-change">浏览上下文 · <code>{html.escape(disp)}</code></h4>{extra}'
                )
                prev_disp = disp
            body_parts.append(card_fn(st))
            sid = html.escape(_step_anchor_id(st))
            slabel = html.escape(_timeline_nav_step_label(st))
            res_cls, res_zh = _step_result_badge(st)
            rcls = html.escape(res_cls) if res_cls in ("ok", "failed", "skipped", "unknown") else "unknown"
            rzh = html.escape(res_zh)
            step_badge = (
                f'<span class="tl-session-badge tl-sess-{rcls} tl-nav-step-sess" title="本步任务执行结果">{rzh}</span>'
            )
            step_nav_lis.append(f'<li class="tl-nav-step-li"><a href="#{sid}">{slabel}{step_badge}</a></li>')

        body_parts.append("</div></details>")
        nav_bucket_lis.append(
            '<li class="tl-nav-bucket-li">'
            f'<details class="tl-nav-details" open>'
            f'<summary class="tl-nav-summary">'
            f'<span class="tl-nav-caret" aria-hidden="true"></span>'
            f'<a class="tl-nav-jump" href="#{bucket_id}">{html.escape(label)}</a>{nav_bucket_badge}'
            f"</summary>"
            f'<ul class="tl-nav-steps">{"".join(step_nav_lis)}</ul>'
            f"</details></li>"
        )

    body_parts.append("</section>")
    nav_li = (
        '<li class="tl-nav-url-li">'
        f'<details class="tl-nav-details tl-nav-details-url" open>'
        f'<summary class="tl-nav-summary">'
        f'<span class="tl-nav-caret" aria-hidden="true"></span>'
        f'<a class="tl-nav-jump" href="#{block_id}"><span class="tl-nav-url-badge">URL-{url_order}</span></a>'
        f'<small class="tl-nav-norm">{title_esc}</small>'
        f"</summary>"
        f'<ul class="tl-nav-buckets">{"".join(nav_bucket_lis)}</ul>'
        f"</details></li>"
    )
    return "\n".join(body_parts), nav_li


def _now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def _action_skipped_event_counts(events: Sequence[dict[str, Any]]) -> tuple[int, int, int]:
    """action_skipped 事件：总数、语义黑名单、结构化黑名单。"""
    total = 0
    sem = 0
    stc = 0
    for ev in events:
        if ev.get("kind") != "action_skipped":
            continue
        total += 1
        ex = ev.get("extra") if isinstance(ev.get("extra"), dict) else {}
        mk = ex.get("match_kind")
        if mk == "semantic":
            sem += 1
        elif mk == "structured":
            stc += 1
    return total, sem, stc


def _render_filter_stats_panel(
    filter_summary: dict[str, Any],
    skip_event_counts: dict[str, Any],
) -> str:
    if not filter_summary and not skip_event_counts:
        return ""
    sk = int((skip_event_counts or {}).get("action_skipped_total") or 0)
    bsem = int((skip_event_counts or {}).get("blacklist_semantic") or 0)
    bst = int((skip_event_counts or {}).get("blacklist_structured") or 0)
    bl = int(filter_summary.get("skip_blacklist_hits") or 0)
    bsem_m = int(filter_summary.get("skip_blacklist_semantic_hits") or 0)
    bst_m = int(filter_summary.get("skip_blacklist_structured_hits") or 0)
    coh = int(filter_summary.get("coherence_strict_dropped") or 0)
    rnk = int(filter_summary.get("coherence_rank_deprioritized") or 0)
    if not any([sk, bsem, bst, bl, bsem_m, bst_m, coh, rnk]):
        return ""
    return f"""
<details class="filter-stats" id="sec-filter" open>
<summary><strong>过滤与连贯性统计</strong></summary>
<p class="footnote"><small>「事件」列来自 <code>events.jsonl</code> 中 <code>kind=action_skipped</code>；「运行汇总」来自 <code>graph.json</code> 的 <code>run_meta.filter_summary</code>（与事件可能因统计口径略有差异）。</small></p>
<table class="wide-schedule"><thead><tr>
<th>类型</th><th>事件计数</th><th>运行汇总</th>
</tr></thead><tbody>
<tr><td>黑名单跳过（合计）</td><td>{html.escape(str(sk))}</td><td>{html.escape(str(bl))}</td></tr>
<tr><td>· 语义规则</td><td>{html.escape(str(bsem))}</td><td>{html.escape(str(bsem_m))}</td></tr>
<tr><td>· 结构化规则</td><td>{html.escape(str(bst))}</td><td>{html.escape(str(bst_m))}</td></tr>
<tr><td>组合链·严格丢弃（版面不连贯）</td><td>—</td><td>{html.escape(str(coh))}</td></tr>
<tr><td>组合链·降权重排</td><td>—</td><td>{html.escape(str(rnk))}</td></tr>
</tbody></table>
</details>
"""


def _read_jsonl_events(path: Path) -> list[dict[str, Any]]:
    if not path.is_file():
        return []
    out: list[dict[str, Any]] = []
    with path.open(encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                out.append(json.loads(line))
            except json.JSONDecodeError:
                continue
    return out


def _load_graph(path: Path) -> dict[str, Any]:
    if not path.is_file():
        return {}
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return {}


def _edges_by_event_id(graph: dict[str, Any]) -> dict[str, dict[str, Any]]:
    """event_id 与 edge 上 event_id 字段对齐。"""
    m: dict[str, dict[str, Any]] = {}
    for e in graph.get("edges") or []:
        eid = e.get("event_id")
        if isinstance(eid, str) and eid:
            m[eid] = e
    return m


def _queue_type_counts(queues_path: Path) -> dict[str, int]:
    if not queues_path.is_file():
        return {}
    c: Counter[str] = Counter()
    with queues_path.open(encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                obj = json.loads(line)
            except json.JSONDecodeError:
                continue
            t = obj.get("type")
            if isinstance(t, str):
                c[t] += 1
    return dict(sorted(c.items(), key=lambda x: (-x[1], x[0])))


def _split_tap_index_and_body(tap: str) -> tuple[str | None, str]:
    """`[12] 描述` → (\"12\", \"描述\")；无索引时 (None, 原串)。"""
    t = (tap or "").strip()
    if t.startswith("[") and "]" in t:
        inner, rest = t.split("]", 1)
        idx = inner[1:].strip()
        tail = rest.strip()
        return (idx if idx else None, tail)
    return (None, t)


def _looks_like_dom_or_selector_fragment(s: str) -> bool:
    """粗判：是否像 DOM 链/标签片段（而非人读文案）。"""
    t = s.strip()
    if not t:
        return False
    low = t.lower()
    if ">" in t and any(x in low for x in ("<", "div", "span", "img", "button", "input", "svg", "path")):
        return True
    if low.startswith((".", "#", "[", "role=")) or "nth-child" in low:
        return True
    # 连续出现多个 HTML 标签名
    tags = re.findall(
        r"\b(div|span|img|button|input|a|li|ul|nav|header|footer|main|section|svg|path)\b",
        low,
    )
    return len(tags) >= 2


def _execution_summary(
    ev: dict[str, Any],
    edge: dict[str, Any] | None,
) -> str:
    """
    本步执行的自然语言摘要：动作类型、前缀、目标、结果、地址栏变化。
    与 _readable_summary 的短标签不同，用于报告「执行摘要」主叙述。
    """
    tgt = ev.get("target_step") if isinstance(ev.get("target_step"), dict) else {}
    kind = (tgt.get("kind") or "click").strip()

    res = str(ev.get("result") or "").strip()
    res_zh = {"ok": "成功", "failed": "失败", "skipped": "已跳过"}.get(res, res or "未知")
    sk = str(ev.get("skip_reason") or "").strip()
    if res == "skipped" and sk:
        res_zh = f"{res_zh}（{sk}）"

    if kind == "intent_mission":
        raw_steps = tgt.get("intent_ai_steps")
        lines: list[str] = []
        if isinstance(raw_steps, list):
            for i, s in enumerate(raw_steps):
                st = str(s).strip()
                if st:
                    lines.append(f"{i + 1}. {st[:420]}")
        body = " | ".join(lines) if lines else str(tgt.get("locate_prompt") or "").strip() or "(无步骤)"
        ub = str(ev.get("url_before") or "").strip()
        ua = str(ev.get("url_after") or "").strip()
        tail = ""
        if ub or ua:
            if ub == ua:
                tail = " 当前标签页地址栏 URL 与动作前后一致（常见于同页交互、浮层或 SPA 路由未改 history）。"
            else:
                tail = f" 动作前后地址栏由「{ub}」变为「{ua}」。"
        return f"执行意图多步任务（ai flow）。步骤：{body}。本步执行结果：{res_zh}。{tail}".replace("。。", "。")

    tap = (tgt.get("tap_description") or "").strip()
    lp = (tgt.get("locate_prompt") or "").strip()
    iv = (tgt.get("input_value") or "").strip()
    pfx: list[str] = []
    if edge:
        raw = edge.get("prefix_steps_summary")
        if isinstance(raw, list):
            pfx = [str(x) for x in raw if str(x).strip()]

    idx_s, tap_body = _split_tap_index_and_body(tap)
    index_phrase = (
        f"使用页面可交互控件枚举第 {idx_s} 项" if idx_s and idx_s.isdigit() else ""
    )

    if lp:
        target_phrase = f"以自然语言定位：{lp}"
    elif tap_body:
        if _looks_like_dom_or_selector_fragment(tap_body):
            human = "该步在 YAML/事件里用 DOM 路径或标签链定位（用于与录制时树结构对齐），不等同于人类可见文案位置；请结合上下截图理解。"
            joiner = f"{index_phrase}；{human}" if index_phrase else human
            target_phrase = f"目标元素技术描述为「{tap_body}」；{joiner}"
        else:
            target_phrase = f"目标为「{tap_body}」" + (f"；{index_phrase}" if index_phrase else "")
    else:
        target_phrase = "未记录目标描述" + (f"；{index_phrase}" if index_phrase else "")

    prefix_phrase = ""
    if pfx:
        prefix_phrase = "在完成前缀路径「" + " → ".join(pfx) + "」之后，"

    if kind == "input" and iv:
        verb = f"{prefix_phrase}在输入类控件上输入内容 {iv!r}"
    elif kind == "scroll":
        verb = f"{prefix_phrase}执行页面滚动"
    else:
        verb = f"{prefix_phrase}执行点击"

    sentence_core = f"{verb}；{target_phrase}。本步执行结果：{res_zh}。"

    ub = str(ev.get("url_before") or "").strip()
    ua = str(ev.get("url_after") or "").strip()
    if ub or ua:
        if ub == ua:
            sentence_core += " 当前标签页地址栏 URL 与动作前后一致（常见于同页交互、浮层或 SPA 路由未改 history）。"
        else:
            sentence_core += f" 动作前后地址栏由「{ub}」变为「{ua}」。"
    return sentence_core


def _readable_summary(
    ev: dict[str, Any],
    edge: dict[str, Any] | None,
) -> str:
    tgt = ev.get("target_step") if isinstance(ev.get("target_step"), dict) else {}
    tap = (tgt.get("tap_description") or "").strip()
    lp = (tgt.get("locate_prompt") or "").strip()
    kind = (tgt.get("kind") or "click").strip()
    iv = (tgt.get("input_value") or "").strip()
    pfx: list[str] = []
    if edge:
        raw = edge.get("prefix_steps_summary")
        if isinstance(raw, list):
            pfx = [str(x) for x in raw if str(x).strip()]
    target_head = lp or (
        tap.split("]", 1)[-1].strip() if tap.startswith("[") and "]" in tap else tap
    )
    if kind == "input" and iv:
        body = target_head or tap or "输入框"
        if pfx:
            return "前缀: " + " → ".join(pfx) + f" | 输入 {iv!r} @ {body}"
        return f"输入 {iv!r} @ {body}"
    if pfx and target_head:
        return "前缀: " + " → ".join(pfx) + " | 目标: " + target_head
    if target_head:
        return target_head
    if pfx:
        return "前缀: " + " → ".join(pfx)
    return ev.get("dedupe_path_key", "")[:32] + "…" if ev.get("dedupe_path_key") else "(无描述)"


def merge_composite_timeline_steps(steps: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """
    将连续、同一 task_id 且 composite_atomic_index 1..N 的事件合并为一条「组合链」卡片，
    便于 HTML 横向展示各原子步 before/after。
    """
    out: list[dict[str, Any]] = []
    i = 0
    n = len(steps)
    while i < n:
        st = steps[i]
        tid = st.get("task_id")
        cat = st.get("composite_atomic_total")
        cai = st.get("composite_atomic_index")
        if (
            isinstance(tid, str)
            and tid.strip()
            and isinstance(cat, int)
            and cat > 1
            and isinstance(cai, int)
            and cai == 1
        ):
            chunk = [st]
            j = i + 1
            expect = 2
            while j < n and len(chunk) < cat:
                sj = steps[j]
                if sj.get("task_id") == tid and sj.get("composite_atomic_index") == expect:
                    chunk.append(sj)
                    expect += 1
                    j += 1
                else:
                    break
            if len(chunk) == cat:
                out.append(_build_merged_composite_chain_step(chunk))
                i = j
                continue
        out.append(st)
        i += 1
    return out


def _build_merged_composite_chain_step(chunk: list[dict[str, Any]]) -> dict[str, Any]:
    first = chunk[0]
    last = chunk[-1]
    segs: list[dict[str, Any]] = []
    for seg in chunk:
        shots = seg.get("screenshots") if isinstance(seg.get("screenshots"), dict) else {}
        segs.append(
            {
                "seq": seg.get("seq"),
                "event_id": seg.get("event_id"),
                "result": seg.get("result"),
                "readable_summary": seg.get("readable_summary"),
                "execution_summary": seg.get("execution_summary"),
                "composite_atomic_index": seg.get("composite_atomic_index"),
                "composite_atomic_total": seg.get("composite_atomic_total"),
                "url_before": seg.get("url_before"),
                "url_after": seg.get("url_after"),
                "screenshots": {
                    "before": shots.get("before"),
                    "after": shots.get("after"),
                },
            }
        )
    pfx = first.get("prefix_flow_frames")
    pfx_list = pfx if isinstance(pfx, list) else []
    atom_exec: list[str] = []
    for i, seg in enumerate(chunk):
        ex = str(seg.get("execution_summary") or seg.get("readable_summary") or "").strip()
        if ex:
            atom_exec.append(f"原子步 {i + 1}/{len(chunk)}：{ex}")
    chain_exec = "\n\n".join(atom_exec) if atom_exec else ""
    return {
        "timeline_kind": "composite_chain",
        "seq": first.get("seq"),
        "seq_end": last.get("seq"),
        "anchor_step_seq": last.get("anchor_step_seq"),
        "event_id": first.get("event_id"),
        "event_id_end": last.get("event_id"),
        "task_id": first.get("task_id"),
        "queue_seq": first.get("queue_seq"),
        "anchor_url_norm": first.get("anchor_url_norm"),
        "anchor_url": first.get("anchor_url"),
        "anchor_depth": first.get("anchor_depth"),
        "yaml_full_body": last.get("yaml_full_body"),
        "yaml_flow_total": last.get("yaml_flow_total"),
        "yaml_flow_target_index": last.get("yaml_flow_target_index"),
        "step_origin": first.get("step_origin"),
        "composite_segments": segs,
        "prefix_flow_frames": pfx_list,
        "url_before": first.get("url_before"),
        "url_after": last.get("url_after"),
        "readable_summary": f"组合任务 · {len(chunk)} 个原子步（同一 task_id）",
        "execution_summary": chain_exec
        or f"组合任务 · {len(chunk)} 个原子步（同一 task_id），详见下方各原子步截图与摘要。",
        "result": last.get("result"),
        "skip_reason": last.get("skip_reason"),
    }


def _split_generated_yaml_header_and_body(text: str) -> tuple[str, str]:
    """将 `write_task_yaml` 顶行 # 注释与 YAML 正文分开，便于 HTML 分区与复制。"""
    lines = text.splitlines()
    i = 0
    while i < len(lines) and lines[i].lstrip().startswith("#"):
        i += 1
    head = "\n".join(lines[:i]).strip("\n")
    body = "\n".join(lines[i:]).lstrip("\n")
    if not body.strip():
        return "", text
    return head, body


def _yaml_full_document(out_dir: Path, edge: dict[str, Any] | None, ev: dict[str, Any]) -> str | None:
    """读取本步对应 task 的完整 generated_cases YAML 文本（含 target/tasks/flow 与头部注释）。"""
    rel: str | None = None
    if edge and isinstance(edge.get("yaml_ref"), str) and str(edge.get("yaml_ref") or "").strip():
        rel = str(edge.get("yaml_ref"))
    else:
        tid = ev.get("task_id") if isinstance(ev.get("task_id"), str) else ""
        tid = tid.strip() if tid else ""
        qs = ev.get("queue_seq")
        ass_raw = ev.get("anchor_step_seq")
        try:
            a_seq = int(ass_raw) if ass_raw is not None else None
        except (TypeError, ValueError):
            a_seq = None
        if tid:
            cand: list[Path] = []
            try:
                n = int(qs) if qs is not None else None
            except (TypeError, ValueError):
                n = None
            if a_seq is not None and a_seq > 0 and n is not None:
                cand.append(out_dir / "generated_cases" / f"{a_seq:04d}_{n:06d}_{tid}.yaml")
            if n is not None:
                cand.append(out_dir / "generated_cases" / f"{n:06d}_{tid}.yaml")
            cand.append(out_dir / "generated_cases" / f"{tid}.yaml")
            for path in cand:
                if path.is_file():
                    try:
                        rel = str(path.relative_to(out_dir))
                    except ValueError:
                        rel = None
                    break
    if not rel:
        return None
    path = out_dir / rel
    if not path.is_file():
        return None
    try:
        raw = path.read_text(encoding="utf-8")
    except OSError:
        return None
    if len(raw) > _YAML_FULL_MAX_CHARS:
        raw = raw[: _YAML_FULL_MAX_CHARS - 80] + "\n\n# …（已截断，文件过长）…\n"
    return raw


def _anchor_action_counts(events: Sequence[dict[str, Any]]) -> tuple[dict[str, int], dict[str, int]]:
    """按 anchor_url_norm 统计成功步数与全部 action_result 条数。"""
    ok_n: Counter[str] = Counter()
    all_n: Counter[str] = Counter()
    for ev in events:
        if ev.get("kind") != "action_result":
            continue
        an = str(ev.get("anchor_url_norm") or "").strip()
        if not an:
            continue
        all_n[an] += 1
        if ev.get("result") == "ok":
            ok_n[an] += 1
    return dict(ok_n), dict(all_n)


def _url_queue_overview_rows(queues_path: Path, events: Sequence[dict[str, Any]] | None = None) -> list[dict[str, Any]]:
    """解析 queues.jsonl，构建**全量** URL 发现概览。

    本视图同时收录：
    - ``url_enqueue`` 实际入队的 URL（执行 / 待执行）
    - ``url_skip_budget`` 因预算或 URL 等价键被丢弃的 URL（``reason=max_new_urls`` / ``url_equivalence``）
    - ``url_skip_state_dup`` 因页面结构指纹去重被跳过的 URL
    - ``url_skip_seen`` / ``url_skip_depth`` 等其它跳过原因
    - ``url_discovered`` 中曾出现但因预算/去重未入队的 URL（兜底）

    对实际出队过的 URL 依据 ``url_dequeue`` 标记 ``done``；其余入队条目为 ``pending``。
    每行附 ``tag`` / ``tag_label``，便于 HTML 报告里按用户参数核对「本次执行」「去重」「预算外」等。

    *events* 可选，用于按 ``url_after`` 匹配首次出现的截图。
    """
    if not queues_path.is_file():
        return []
    discovered_first_seen: dict[str, dict[str, Any]] = {}
    enqueued_order: list[str] = []
    enqueued_meta: dict[str, dict[str, Any]] = {}
    dequeued_norms: set[str] = set()
    skip_records: list[dict[str, Any]] = []
    with queues_path.open(encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                o = json.loads(line)
            except json.JSONDecodeError:
                continue
            t = o.get("type")
            un = str(o.get("url_norm") or "").strip()
            if not un:
                continue
            if un not in discovered_first_seen and t in {
                "url_discovered",
                "url_enqueue",
                "url_skip_budget",
                "url_skip_state_dup",
                "url_skip_seen",
                "url_skip_depth",
            }:
                discovered_first_seen[un] = {
                    "url_norm": un,
                    "raw_url": str(o.get("raw_url") or un),
                    "anchor_depth": o.get("anchor_depth"),
                    "from_parent": o.get("from_parent"),
                    "first_ts": o.get("ts"),
                }
            if t == "url_enqueue":
                if un not in enqueued_meta:
                    enqueued_order.append(un)
                    enqueued_meta[un] = {
                        "url_norm": un,
                        "raw_url": str(o.get("raw_url") or un),
                        "anchor_depth": o.get("anchor_depth"),
                        "from_parent": o.get("from_parent"),
                        "ts": o.get("ts"),
                    }
            elif t == "url_dequeue":
                dequeued_norms.add(un)
            elif t in {"url_skip_budget", "url_skip_state_dup", "url_skip_seen", "url_skip_depth"}:
                skip_records.append(
                    {
                        "type": t,
                        "url_norm": un,
                        "raw_url": str(o.get("raw_url") or un),
                        "reason": o.get("reason") or t.replace("url_skip_", ""),
                        "anchor_depth": o.get("anchor_depth"),
                        "from_parent": o.get("from_parent"),
                        "ts": o.get("ts"),
                    }
                )

    url_screenshot_map: dict[str, str] = {}
    if events:
        for ev in events:
            if ev.get("kind") != "action_result":
                continue
            ua = str(ev.get("url_after") or "").strip()
            if not ua:
                continue
            shots = ev.get("screenshots") if isinstance(ev.get("screenshots"), dict) else {}
            shot_after = shots.get("after")
            if shot_after and ua not in url_screenshot_map:
                url_screenshot_map[ua] = str(shot_after)

    rows: list[dict[str, Any]] = []
    seen_in_rows: set[str] = set()
    # 1) 已入队（含已执行 / 待执行）
    for i, un in enumerate(enqueued_order):
        e = enqueued_meta[un]
        if un in dequeued_norms:
            tag = "executed"
            tag_label = "本次执行"
        else:
            tag = "pending"
            tag_label = "本次待执行"
        row: dict[str, Any] = {
            "order": len(rows) + 1,
            "enqueue_order": i + 1,
            "url_norm": un,
            "raw_url": e.get("raw_url") or un,
            "anchor_depth": e.get("anchor_depth"),
            "status": "done" if un in dequeued_norms else "pending",
            "tag": tag,
            "tag_label": tag_label,
            "from_parent": e.get("from_parent"),
            "ts": e.get("ts"),
        }
        shot = url_screenshot_map.get(e.get("raw_url") or "") or url_screenshot_map.get(un)
        if shot:
            row["screenshot"] = shot
        rows.append(row)
        seen_in_rows.add(un)

    # 2) 被跳过：用首次记录到的 reason，按发现时间排序
    skip_first_by_norm: dict[str, dict[str, Any]] = {}
    for sk in skip_records:
        un = sk["url_norm"]
        if un in seen_in_rows:
            continue
        if un not in skip_first_by_norm:
            skip_first_by_norm[un] = sk
    for un, sk in skip_first_by_norm.items():
        reason = str(sk.get("reason") or "")
        if reason == "max_new_urls":
            tag, label = "skipped_budget", "预算外跳过"
        elif reason == "url_equivalence":
            tag, label = "skipped_equivalence", "URL 等价去重"
        elif reason == "page_state_duplicate":
            tag, label = "skipped_state_dup", "页面指纹去重"
        elif sk.get("type") == "url_skip_seen":
            tag, label = "skipped_seen", "已访问"
        elif sk.get("type") == "url_skip_depth":
            tag, label = "skipped_depth", "深度超限"
        else:
            tag, label = "skipped_other", reason or "已跳过"
        rows.append(
            {
                "order": len(rows) + 1,
                "enqueue_order": None,
                "url_norm": un,
                "raw_url": sk.get("raw_url") or un,
                "anchor_depth": sk.get("anchor_depth"),
                "status": "skipped",
                "tag": tag,
                "tag_label": label,
                "skip_reason": reason or sk.get("type"),
                "from_parent": sk.get("from_parent"),
                "ts": sk.get("ts"),
            }
        )
        seen_in_rows.add(un)

    # 3) 兜底：仅 url_discovered，但既未入队也未被显式跳过的 URL（少见，但保证全量可见）
    for un, info in discovered_first_seen.items():
        if un in seen_in_rows:
            continue
        rows.append(
            {
                "order": len(rows) + 1,
                "enqueue_order": None,
                "url_norm": un,
                "raw_url": info.get("raw_url") or un,
                "anchor_depth": info.get("anchor_depth"),
                "status": "discovered",
                "tag": "discovered_only",
                "tag_label": "仅发现",
                "from_parent": info.get("from_parent"),
                "ts": info.get("first_ts"),
            }
        )
    return rows


def _render_url_queue_overview_html(queues_path: Path) -> str:
    """折叠面板：URL 队列全貌（含执行状态）。

    此方法不传 events 因此无截图；主流程应改用 ``_render_url_queue_overview_html_from_rows``。
    """
    rows = _url_queue_overview_rows(queues_path)
    return _render_url_queue_overview_html_from_rows(rows)


_TAG_STYLE: dict[str, str] = {
    "executed": "background:#198754;color:#fff;",
    "pending": "background:#0d6efd;color:#fff;",
    "skipped_budget": "background:#fd7e14;color:#fff;",
    "skipped_equivalence": "background:#6f42c1;color:#fff;",
    "skipped_state_dup": "background:#6c757d;color:#fff;",
    "skipped_seen": "background:#adb5bd;color:#212529;",
    "skipped_depth": "background:#adb5bd;color:#212529;",
    "skipped_other": "background:#adb5bd;color:#212529;",
    "discovered_only": "background:#e9ecef;color:#212529;",
}


def _render_url_queue_overview_html_from_rows(
    rows: list[dict[str, Any]],
    *,
    attr_img_src: Callable[[str], str] | None = None,
) -> str:
    """从预计算的行渲染 URL 发现概览面板（含截图缩略图、标签、跳过原因）。"""
    if not rows:
        return ""
    max_display = 300
    truncated = len(rows) > max_display
    display_rows = rows[:max_display]
    has_any_screenshot = any(isinstance(r, dict) and r.get("screenshot") for r in display_rows)
    body_parts: list[str] = []
    for r in display_rows:
        if not isinstance(r, dict):
            continue
        seq = html.escape(str(r.get("order", "")))
        un = html.escape(str(r.get("url_norm", "")))
        ad = r.get("anchor_depth")
        ad_s = html.escape(str(ad)) if isinstance(ad, int) else "—"
        tag = str(r.get("tag", ""))
        tag_label = html.escape(str(r.get("tag_label", "—")))
        tag_style = _TAG_STYLE.get(tag, "background:#adb5bd;color:#212529;")
        skip_reason = r.get("skip_reason")
        reason_s = (
            f"<br><small>原因: <code>{html.escape(str(skip_reason))}</code></small>"
            if skip_reason else ""
        )
        parent = r.get("from_parent")
        parent_s = (
            f"<br><small>来自: <code>{html.escape(str(parent)[:80])}</code></small>"
            if parent else ""
        )
        tag_html = (
            f'<span style="display:inline-block;padding:2px 8px;border-radius:4px;'
            f'font-size:12px;font-weight:600;{tag_style}">{tag_label}</span>'
        )
        shot_cell = ""
        if has_any_screenshot:
            shot = r.get("screenshot")
            if shot:
                if attr_img_src is not None:
                    shot_esc = attr_img_src(str(shot))
                else:
                    shot_esc = html.escape(str(shot), quote=True)
                shot_cell = (
                    f'<td><a href="{shot_esc}" target="_blank">'
                    f'<img src="{shot_esc}" style="max-width:180px;max-height:120px;border:1px solid #ccc;border-radius:4px;" '
                    f'loading="lazy" alt="页面截图"/></a></td>'
                )
            else:
                shot_cell = "<td><small>—</small></td>"
        body_parts.append(
            f"<tr><td>{seq}</td><td><code>{un}</code>{parent_s}{reason_s}</td>"
            f"<td>{ad_s}</td><td>{tag_html}</td>{shot_cell}</tr>"
        )
    tbody = "".join(body_parts)
    trunc_note = (
        f'<p class="footnote"><small>共 {len(rows)} 条 URL，仅展示前 {max_display} 条。</small></p>'
        if truncated else ""
    )
    counts: dict[str, int] = {}
    for r in rows:
        if not isinstance(r, dict):
            continue
        counts[r.get("tag", "")] = counts.get(r.get("tag", ""), 0) + 1
    summary_segments = [
        ("executed", "本次执行"),
        ("pending", "本次待执行"),
        ("skipped_budget", "预算外跳过"),
        ("skipped_equivalence", "URL 等价去重"),
        ("skipped_state_dup", "页面指纹去重"),
        ("skipped_seen", "已访问"),
        ("skipped_depth", "深度超限"),
        ("skipped_other", "其它跳过"),
        ("discovered_only", "仅发现"),
    ]
    summary_parts: list[str] = []
    for k, label in summary_segments:
        n = counts.get(k, 0)
        if n <= 0:
            continue
        style = _TAG_STYLE.get(k, "background:#adb5bd;color:#212529;")
        summary_parts.append(
            f'<span style="display:inline-block;margin-right:6px;padding:2px 8px;'
            f'border-radius:4px;font-size:12px;font-weight:600;{style}">{label}: {n}</span>'
        )
    summary_html = "".join(summary_parts)
    intro = (
        '<p class="footnote"><small>来源：<code>queues.jsonl</code> 全量收录 '
        '<code>url_enqueue</code> / <code>url_dequeue</code> / <code>url_skip_budget</code> / '
        '<code>url_skip_state_dup</code> 等事件。<strong>本次执行</strong>=已 dequeue；'
        '<strong>本次待执行</strong>=已入队但本次未轮到；<strong>预算外跳过</strong>=受 '
        '<code>--max-new-urls</code> 限制未入队，<em>下次可再调大预算或用 <code>--resume-session</code> '
        '直接续跑同目录</em>来覆盖；<strong>URL 等价 / 页面指纹去重</strong>=已有同构页被探索过，无需重复。</small></p>'
    )
    shot_th = "<th>页面截图</th>" if has_any_screenshot else ""
    return (
        '<details class="url-queue-overview" id="sec-url-overview" open>'
        f"<summary><strong>URL 发现全量概览</strong>（共 {len(rows)} 条，{summary_html}）</summary>"
        f"{intro}"
        '<table class="wide-schedule"><thead><tr>'
        f"<th>#</th><th>URL</th><th>深度</th><th>标签 / 状态</th>{shot_th}"
        f"</tr></thead><tbody>{tbody}</tbody></table>"
        f"{trunc_note}</details>"
    )


def _render_url_anchor_schedule_html(rows: list[Any]) -> str:
    """折叠表：URL 锚点按 url_dequeue 出队顺序。"""
    if not rows:
        return ""
    body_parts: list[str] = []
    for r in rows:
        if not isinstance(r, dict):
            continue
        ord_s = html.escape(str(r.get("order") or ""))
        qs = r.get("queue_seq")
        qs_s = html.escape(str(qs)) if qs is not None else "—"
        ad = r.get("anchor_depth")
        ad_s = html.escape(str(ad)) if isinstance(ad, int) else "—"
        un = html.escape(str(r.get("url_norm") or ""))
        ok_c = html.escape(str(r.get("success_actions") if r.get("success_actions") is not None else 0))
        tot = html.escape(str(r.get("action_events_total") if r.get("action_events_total") is not None else 0))
        ts = html.escape(str(r.get("ts") or ""))
        body_parts.append(
            f"<tr><td>{ord_s}</td><td>{qs_s}</td><td>{ad_s}</td><td><code>{un}</code></td>"
            f"<td>{ok_c}</td><td>{tot}</td><td><small>{ts}</small></td></tr>"
        )
    tbody = "".join(body_parts)
    intro = (
        "<p class=\"footnote\"><small>来源：<code>queues.jsonl</code> 中每条 <code>url_dequeue</code>。"
        "「成功动作数」为本锚点下 <code>result=ok</code> 的步数；「动作事件总数」含 ok/failed/skipped。"
        "调度锚点（<code>url_norm</code>）与单步「地址栏」允许不同：同一锚点会话内可在多页间操作。</small></p>"
    )
    return (
        '<details class="url-schedule-wrap" id="sec-url-schedule" open>'
        "<summary><strong>URL 锚点出队序（调度）</strong></summary>"
        f"{intro}"
        '<table class="wide-schedule"><thead><tr>'
        "<th>#</th><th>queue seq</th><th>深度</th><th>url_norm（调度）</th>"
        "<th>成功动作</th><th>动作事件</th><th>时间</th>"
        f"</tr></thead><tbody>{tbody}</tbody></table>"
        "</details>"
    )


def _url_dequeue_schedule_rows(
    queues_path: Path, events: Sequence[dict[str, Any]]
) -> list[dict[str, Any]]:
    """解析 queues.jsonl 中 url_dequeue，生成审查页「锚点出队序」表格行。"""
    ok_n, all_n = _anchor_action_counts(events)
    if not queues_path.is_file():
        return []
    rows: list[dict[str, Any]] = []
    with queues_path.open(encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                o = json.loads(line)
            except json.JSONDecodeError:
                continue
            if o.get("type") != "url_dequeue":
                continue
            un = str(o.get("url_norm") or "").strip()
            raw = str(o.get("raw_url") or un)
            ad = o.get("anchor_depth")
            rows.append(
                {
                    "order": len(rows) + 1,
                    "queue_seq": o.get("seq"),
                    "url_norm": un,
                    "raw_url": raw,
                    "anchor_depth": ad if isinstance(ad, int) else None,
                    "ts": o.get("ts"),
                    "success_actions": ok_n.get(un, 0),
                    "action_events_total": all_n.get(un, 0),
                }
            )
    return rows


def _fallback_run_id_from_events(raw_events: Sequence[dict[str, Any]]) -> str:
    """graph.json 缺少 run_meta 时，从 event_id（形如 runid_seq）推导 run_id。"""
    for ev in raw_events:
        if not isinstance(ev, dict):
            continue
        eid = str(ev.get("event_id") or "")
        if "_" in eid:
            return eid.rsplit("_", 1)[0]
    return ""


def _fallback_entry_url_from_events(raw_events: Sequence[dict[str, Any]]) -> str:
    """run_meta.entry_url 缺失时，用首条事件的锚点 URL 兜底。"""
    for ev in raw_events:
        if not isinstance(ev, dict):
            continue
        u = str(ev.get("anchor_url") or ev.get("anchor_url_norm") or "").strip()
        if u:
            return u
    return ""


def _browse_context_display_label(url: str) -> str:
    """时间轴「浏览上下文」分组标题：压缩 chrome-error 等噪声 URL 的重复含义。"""
    u = (url or "").strip()
    if not u:
        return "（本步前后地址均未记录）"
    if u == "（本步前后地址均未记录）":
        return u
    low = u.lower()
    if low.startswith("chrome-error:"):
        return "chrome-error（内部错误页 · 常见于导航瞬断/页面被替换）"
    return u


def _session_churn_banner_html(steps: Sequence[dict[str, Any]]) -> str:
    """检测 login-redirect / 统一认证 / chrome-error，便于对照「掉登录态」类问题。"""
    login_redirect = antchain = chrome_err = 0
    for st in steps:
        if not isinstance(st, dict):
            continue
        for key in ("url_before", "url_after"):
            u = str(st.get(key) or "").lower()
            if "login-redirect" in u:
                login_redirect += 1
            if "antchain-group-auth" in u:
                antchain += 1
            if "chrome-error:" in u:
                chrome_err += 1
    if login_redirect + antchain + chrome_err == 0:
        return ""
    bits = []
    if login_redirect:
        bits.append(f"含 <code>login-redirect</code> 的地址栏记录：<strong>{login_redirect}</strong> 次")
    if antchain:
        bits.append(f"统一认证域（<code>antchain-group-auth</code>）：<strong>{antchain}</strong> 次")
    if chrome_err:
        bits.append(f"<code>chrome-error</code>：<strong>{chrome_err}</strong> 次")
    li = "；".join(bits)
    return f"""
<details class="session-churn" id="sec-session-churn" open>
<summary><strong>会话 / 认证漂移（自动统计）</strong></summary>
<p class="session-churn-body">以下计数来自本 run 时间轴各步的 <code>url_before</code>/<code>url_after</code>：{li}。
侧栏点击若频繁回到统一认证或中转页，多与<strong>会话过期、整页刷新或重复导航</strong>有关；前置 bootstrap 应避免对与入口相同的 URL 再次 <code>goTo</code>，并适当延长登录后静置。</p>
</details>
"""


def _load_budget_truncation(out_dir: Path) -> dict[str, Any] | None:
    p = out_dir / "budget_truncation.json"
    if not p.is_file():
        return None
    try:
        raw = json.loads(p.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return None
    if not isinstance(raw, dict):
        return None
    if raw.get("schema") != "exploration-budget-truncation/v1":
        return None
    # 兼容旧产物：无 budget_scope 时仍展示
    return raw


def build_timeline_payload(out_dir: Path) -> dict[str, Any]:
    """纯函数：从 run 目录已有产物构建 timeline 字典（不写盘）。"""
    out_dir = Path(out_dir)
    events_path = out_dir / "events.jsonl"
    graph_path = out_dir / "graph.json"
    queues_path = out_dir / "queues.jsonl"

    graph = _load_graph(graph_path)
    run_meta = graph.get("run_meta") if isinstance(graph.get("run_meta"), dict) else {}
    run_id = str(run_meta.get("run_id") or graph.get("run_id") or "")
    edges_by_ev = _edges_by_event_id(graph)

    raw_events = _read_jsonl_events(events_path)
    if not run_id:
        run_id = _fallback_run_id_from_events(raw_events)
    run_meta_out: dict[str, Any] = dict(run_meta)
    if not str(run_meta_out.get("entry_url") or "").strip():
        fe = _fallback_entry_url_from_events(raw_events)
        if fe:
            run_meta_out["entry_url"] = fe
    steps: list[dict[str, Any]] = []
    seq = 0
    anchor_step_counters: dict[str, int] = {}
    for ev in raw_events:
        if ev.get("kind") != "action_result":
            continue
        event_id = str(ev.get("event_id") or "")
        edge = edges_by_ev.get(event_id)
        pfx_list: list[str] = []
        if edge:
            ps = edge.get("prefix_steps_summary")
            if isinstance(ps, list):
                pfx_list = [str(x) for x in ps if str(x).strip()]
        tgt = ev.get("target_step") if isinstance(ev.get("target_step"), dict) else {}
        tap = (tgt.get("tap_description") or "").strip() if isinstance(tgt, dict) else ""

        shots = ev.get("screenshots")
        if not isinstance(shots, dict):
            shots = {}

        seq += 1
        an_key = str(ev.get("anchor_url_norm") or "")
        stored_ass = ev.get("anchor_step_seq")
        if isinstance(stored_ass, int) and stored_ass > 0:
            anchor_step_seq = stored_ass
            anchor_step_counters[an_key] = max(anchor_step_counters.get(an_key, 0), stored_ass)
        else:
            anchor_step_counters[an_key] = anchor_step_counters.get(an_key, 0) + 1
            anchor_step_seq = anchor_step_counters[an_key]

        qs = ev.get("queue_seq")
        if isinstance(qs, int):
            queue_seq = qs
        elif isinstance(qs, str) and qs.isdigit():
            queue_seq = int(qs)
        else:
            queue_seq = None

        ad = ev.get("anchor_depth")
        yft = ev.get("yaml_flow_total")
        yti = ev.get("yaml_flow_target_index")
        yfull = _yaml_full_document(out_dir, edge, ev)
        so = ev.get("step_origin")
        step_origin = str(so) if isinstance(so, str) and so.strip() else None
        cai = ev.get("composite_atomic_index")
        cat = ev.get("composite_atomic_total")
        au_raw = ev.get("anchor_url")
        anchor_url_disp = au_raw if isinstance(au_raw, str) and au_raw.strip() else None
        ex_raw = ev.get("extra") if isinstance(ev.get("extra"), dict) else {}
        pfx_frames_raw = ex_raw.get("prefix_flow_frames")
        pfx_frames_out = pfx_frames_raw if isinstance(pfx_frames_raw, list) else []
        steps.append(
            {
                "seq": seq,
                "anchor_step_seq": anchor_step_seq,
                "event_id": event_id,
                "task_id": ev.get("task_id"),
                "queue_seq": queue_seq,
                "result": str(ev.get("result") or ""),
                "skip_reason": ev.get("skip_reason"),
                "anchor_url_norm": ev.get("anchor_url_norm"),
                "anchor_url": anchor_url_disp,
                "anchor_depth": ad if isinstance(ad, int) else None,
                "yaml_flow_total": yft if isinstance(yft, int) else None,
                "yaml_flow_target_index": yti if isinstance(yti, int) else None,
                "yaml_full_body": yfull,
                "step_origin": step_origin,
                "composite_atomic_index": cai if isinstance(cai, int) else None,
                "composite_atomic_total": cat if isinstance(cat, int) else None,
                "url_before": ev.get("url_before"),
                "url_after": ev.get("url_after"),
                "readable_summary": _readable_summary(ev, edge),
                "execution_summary": _execution_summary(ev, edge),
                "prefix_steps_summary": pfx_list,
                "target_description": tap,
                "screenshots": {"before": shots.get("before"), "after": shots.get("after")},
                "prefix_flow_frames": pfx_frames_out,
            }
        )

    steps = merge_composite_timeline_steps(steps)

    url_anchor_schedule = _url_dequeue_schedule_rows(queues_path, raw_events)
    url_queue_overview = _url_queue_overview_rows(queues_path, events=raw_events)

    sk_t, sk_sem, sk_st = _action_skipped_event_counts(raw_events)
    return {
        "schema": TIMELINE_SCHEMA,
        "run_id": run_id,
        "generated_at": _now_iso(),
        "source_dir": str(out_dir.resolve()),
        "run_meta": run_meta_out,
        "queue_stats": _queue_type_counts(queues_path),
        "queues_jsonl": str(queues_path.name) if queues_path.is_file() else None,
        "budget_truncation": _load_budget_truncation(out_dir),
        "url_anchor_schedule": url_anchor_schedule,
        "url_queue_overview": url_queue_overview,
        "skip_event_counts": {
            "action_skipped_total": sk_t,
            "blacklist_semantic": sk_sem,
            "blacklist_structured": sk_st,
        },
        "steps": steps,
    }


def render_review_html(
    payload: dict[str, Any],
    *,
    embed_images: bool = False,
    asset_base: Path | None = None,
) -> str:
    """由 timeline payload 生成 HTML。默认 img 为相对路径；``embed_images=True`` 时将「本地」截图读入并转为 data URL，便于单文件离线打开。"""
    run_meta = payload.get("run_meta") if isinstance(payload.get("run_meta"), dict) else {}
    entry = html.escape(str(run_meta.get("entry_url") or ""))
    rid_raw = str(payload.get("run_id") or "").strip()
    run_id = html.escape(rid_raw or "（未写入 run_id，已从 events 兜底时请重新生成）")
    expl_depth = run_meta.get("exploration_depth")
    expl_depth_s = html.escape(str(expl_depth)) if expl_depth is not None else "—"
    qstats = payload.get("queue_stats") if isinstance(payload.get("queue_stats"), dict) else {}
    queues_name = payload.get("queues_jsonl")

    base: Path | None = None
    if embed_images:
        if asset_base is not None:
            base = Path(asset_base).expanduser().resolve()
        else:
            sd = payload.get("source_dir")
            if isinstance(sd, str) and sd.strip():
                base = Path(sd).expanduser().resolve()
        if base is None or not base.is_dir():
            embed_images = False
            base = None

    embed_cache: dict[str, str] = {}

    def _attr_img_src(ref: str) -> str:
        ref_s = (ref or "").strip()
        if not ref_s:
            return ""
        if not embed_images or base is None:
            return html.escape(ref_s, quote=True)
        low = ref_s.lower()
        if low.startswith(("http://", "https://", "data:")):
            return html.escape(ref_s, quote=True)
        rp = _resolve_asset_path(ref_s, base)
        if rp is None:
            return html.escape(ref_s, quote=True)
        key = str(rp)
        if key not in embed_cache:
            uri = _image_file_to_data_uri(rp)
            embed_cache[key] = uri or ""
        uri = embed_cache[key]
        if not uri:
            return html.escape(ref_s, quote=True)
        return html.escape(uri, quote=True)

    standalone_banner = ""
    if embed_images:
        standalone_banner = (
            '<p class="standalone-banner" role="status">本报告已<strong>内嵌截图</strong>（data URL），可单文件拷贝分享，'
            "无需同目录 <code>assets/</code> 或其它外部图片路径。体积可能较大。</p>"
        )
    title_suffix = " · 内嵌图" if embed_images else ""

    bt = payload.get("budget_truncation") if isinstance(payload.get("budget_truncation"), dict) else None
    bt_segments = bt.get("segments") if bt and isinstance(bt.get("segments"), list) else []
    ma = None
    mrun = None
    if bt:
        ma = bt.get("max_actions_per_anchor")
        if ma is None:
            ma = bt.get("max_actions")
        mrun = bt.get("max_total_actions")
    fa = bt.get("final_actions_executed") if bt else None
    bscope = (bt.get("budget_scope") if bt else None) or ""

    sched_raw = payload.get("url_anchor_schedule")
    sched_list: list[Any] = sched_raw if isinstance(sched_raw, list) else []
    schedule_html = _render_url_anchor_schedule_html(sched_list)
    sched_ordermap_base = _schedule_order_by_anchor_norm(sched_list)

    def _render_budget_truncation_html() -> str:
        if not bt_segments:
            return ""
        ma_s = html.escape(str(ma)) if ma is not None else "—"
        mrun_s = html.escape(str(mrun)) if mrun is not None else "—"
        fa_s = html.escape(str(fa)) if fa is not None else "—"
        scope_note = (
            "每个锚点 URL 独立计数。"
            if bscope == "per_anchor_url"
            else (
                "每锚点上限与全 run 总步上限同时生效，任一耗尽即截断。"
                if bscope == "per_anchor_url_and_run_total"
                else ("预算范围: " + html.escape(str(bscope)) + "。" if bscope else "")
            )
        )
        blocks: list[str] = []
        for seg in bt_segments:
            if not isinstance(seg, dict):
                continue
            phase_raw = str(seg.get("phase") or "")
            phase_label = {
                "anchor_action_queue": "当前锚点 · 动作队列中未出队",
                "url_pending_queue": "待爬 URL 锚点队列中未出队",
                "run_total_actions": "全 run · 达到全局成功步上限",
            }.get(phase_raw, phase_raw)
            phase = html.escape(phase_label)
            reason = html.escape(str(seg.get("reason") or "max_actions_per_anchor"))
            rc = seg.get("remaining_count")
            rc_s = html.escape(str(rc)) if rc is not None else "—"
            lim = seg.get("sample_limit")
            lim_s = html.escape(str(lim)) if lim is not None else ""
            head = f"<h3>{phase} <small>({reason})</small></h3><p>未处理条数（估算）: <strong>{rc_s}</strong>"
            if lim_s:
                head += f"；下列最多展示 {lim_s} 条样本"
            head += "</p>"
            samples = seg.get("samples") if isinstance(seg.get("samples"), list) else []
            items: list[str] = []
            for s in samples:
                if not isinstance(s, dict):
                    continue
                if seg.get("phase") == "url_pending_queue":
                    ru = html.escape(str(s.get("raw_url") or s.get("url_norm") or ""))
                    ad = s.get("anchor_depth")
                    ad_s = html.escape(str(ad)) if isinstance(ad, int) else "—"
                    items.append(f"<li><code>{ru}</code> · 锚点深度 {ad_s}</li>")
                else:
                    tid = html.escape(str(s.get("task_id") or ""))
                    td = html.escape(str(s.get("target_description") or ""))
                    lp = html.escape(str(s.get("locate_prompt") or ""))
                    ad = s.get("anchor_depth")
                    ad_s = html.escape(str(ad)) if isinstance(ad, int) else "—"
                    tail = f'<span class="lp">{lp}</span>' if lp else (td if td else "")
                    sep = " · " if tail else ""
                    items.append(f'<li><code>{tid}</code> · 锚点 L{ad_s}{sep}{tail}</li>')
            ul = "<ul>" + "".join(items) + "</ul>" if items else "<p>（无样本）</p>"
            blocks.append(head + ul)
        inner = "\n".join(blocks)
        return f"""
<section class="budget-trunc" id="sec-budget">
<h2>因达到动作预算而未继续执行的内容</h2>
<p><small>{scope_note}每锚点 <code>max_actions={ma_s}</code> · 全 run <code>max_total_actions={mrun_s}</code> · 本 run 成功动作总计 <code>{fa_s}</code> · 详见 <code>budget_truncation.json</code></small></p>
{inner}
</section>"""

    url_like = {k: v for k, v in qstats.items() if isinstance(k, str) and k.startswith("url_")}
    action_skip = int(qstats.get("action_skip", 0) or 0)
    action_enq = int(qstats.get("action_enqueue", 0) or 0)
    action_dq = int(qstats.get("action_dequeue", 0) or 0)

    rows_q = "".join(
        f"<tr><td>{html.escape(str(k))}</td><td>{int(v)}</td></tr>"
        for k, v in sorted(qstats.items(), key=lambda x: (-int(x[1]), str(x[0])))
    )

    def _img(src: Any, alt: str) -> str:
        if not src or not isinstance(src, str):
            return f'<div class="ph">{html.escape(alt)}：无图</div>'
        esc_src = _attr_img_src(src)
        alt_esc = html.escape(alt)
        alt_attr = html.escape(alt, quote=True)
        return (
            f'<span class="review-zoom-wrap" role="button" tabindex="0" '
            f'data-fullsrc="{esc_src}" data-alt="{alt_attr}" title="点击放大" '
            f'aria-label="放大查看：{alt_esc}">'
            f'<img src="{esc_src}" alt="{alt_esc}" loading="lazy" /></span>'
        )

    def _exec_summary_paragraph(text: str, *, title: str = "执行摘要") -> str:
        raw = (text or "").strip()
        if not raw:
            return ""
        esc = html.escape(raw).replace("\n", "<br/>\n")
        return (
            f'<p class="exec-summary"><strong>{html.escape(title)}</strong><br/>'
            f'<span class="exec-summary-body">{esc}</span></p>'
        )

    def _flow_tile_prefix(fr: dict[str, Any]) -> str:
        kind = fr.get("kind")
        si = fr.get("step_index")
        if kind == "prefix_entry":
            cap = "起点"
        elif isinstance(si, int):
            cap = f"前缀 {si}"
        else:
            cap = "前缀"
        lab = html.escape(str(fr.get("label") or "")[:140])
        shot = fr.get("screenshot_after")
        u = html.escape(str(fr.get("url_after") or "")[:88])
        return (
            f'<div class="flow-tile flow-tile-prefix">'
            f'<div class="flow-tile-cap">{html.escape(cap)}</div>'
            f'<div class="flow-tile-one">{_img(shot, cap)}</div>'
            f'<p class="flow-tile-lab"><small>{lab}</small></p>'
            f'<p class="flow-url"><small>{u}</small></p></div>'
        )

    def _prefix_flow_html(st: dict[str, Any]) -> str:
        pfx = st.get("prefix_flow_frames")
        if not isinstance(pfx, list) or not pfx:
            return ""
        tiles = [_flow_tile_prefix(fr) for fr in pfx if isinstance(fr, dict)]
        if not tiles:
            return ""
        parts: list[str] = []
        for k, t in enumerate(tiles):
            parts.append(t)
            if k < len(tiles) - 1:
                parts.append('<span class="flow-arrow" aria-hidden="true">→</span>')
        return (
            '<section class="shot-flow shot-flow-prefix" role="group" aria-label="前缀重放轨迹">'
            '<h4 class="flow-h">前缀重放轨迹（扩队路径）</h4><div class="flow-strip">'
            + "".join(parts)
            + "</div></section>"
        )

    def _composite_chain_html(st: dict[str, Any]) -> str:
        segs = st.get("composite_segments")
        if not isinstance(segs, list) or not segs:
            return ""
        parts: list[str] = []
        for k, seg in enumerate(segs):
            if not isinstance(seg, dict):
                continue
            shots = seg.get("screenshots") if isinstance(seg.get("screenshots"), dict) else {}
            sb = shots.get("before")
            sa = shots.get("after")
            cai = seg.get("composite_atomic_index")
            cat = seg.get("composite_atomic_total")
            cap_i = html.escape(str(cai)) if isinstance(cai, int) else "?"
            cap_t = html.escape(str(cat)) if isinstance(cat, int) else "?"
            sr = html.escape(str(seg.get("result") or ""))
            # 与单步一致：大号并排 before/after；摘要仅在上方「执行摘要」中体现，此处不放文案以免挤压图片
            tile = (
                f'<div class="flow-tile flow-tile-atomic-wide">'
                f'<div class="flow-tile-cap">原子 {cap_i}/{cap_t} · <span class="res">{sr}</span></div>'
                f'<p class="atomic-ba-label"><small>before → after（点击放大）</small></p>'
                f'<div class="shots shots-main shots-composite-pair">{_img(sb, "before")}{_img(sa, "after")}</div>'
                f"</div>"
            )
            parts.append(tile)
            if k < len(segs) - 1:
                parts.append('<span class="flow-arrow" aria-hidden="true">→</span>')
        return (
            '<section class="shot-flow shot-flow-composite" role="group" aria-label="组合任务原子步">'
            '<h4 class="flow-h">组合任务 · 原子步截图链</h4>'
            '<div class="flow-strip flow-strip-composite-wide">'
            + "".join(parts)
            + "</div></section>"
        )

    def _yaml_details_block(yfull: Any, yti: Any, seq_id: int) -> str:
        if isinstance(yfull, str) and yfull.strip():
            head, body = _split_generated_yaml_header_and_body(yfull)
            head_fold = ""
            if head.strip():
                head_fold = (
                    '<details class="yaml-head-fold">'
                    "<summary><small>生成文件头注释（不参与执行）</small></summary>"
                    f'<pre class="yaml-snippet yaml-head">{html.escape(head)}</pre>'
                    "</details>"
                )
            body_n = len(body)
            body_block = (
                '<p class="yaml-part-label"><strong>YAML 主体</strong> '
                f"<small>（约 {body_n} 字符，与磁盘 <code>generated_cases</code> 一致，可直接复制）</small></p>"
                f'<pre id="yaml-body-{seq_id}" class="yaml-snippet yaml-body">{html.escape(body)}</pre>'
                f'<p><button type="button" class="yaml-copy-btn" '
                f'onclick="explorerCopyYamlBody({seq_id})">复制 YAML 主体</button>'
                f'<span class="yaml-copy-hint" id="yaml-copy-hint-{seq_id}" aria-live="polite"></span></p>'
            )
            return (
                '<details class="yaml-full">'
                "<summary><strong>完整执行 YAML（generated_cases）</strong> "
                "<small>展开后即为落盘的 tasks/target/flow 全文；文件头注释可单独折叠</small></summary>"
                f"{head_fold}{body_block}"
                "</details>"
            )
        if isinstance(yti, int):
            return (
                '<p class="yaml-footnote"><small>未找到对应 <code>generated_cases/*.yaml</code>（可能未写入或路径不一致）；'
                "仍可通过上方 flow 步号对照 events。</small></p>"
            )
        return ""

    def _one_step_card(st: dict[str, Any]) -> str:
        tk = st.get("timeline_kind")
        if tk == "composite_chain":
            seq_a = st.get("seq")
            seq_b = st.get("seq_end")
            aseq = st.get("anchor_step_seq")
            res_raw = str(st.get("result") or "")
            res_esc = html.escape(res_raw)
            res_cls = html.escape(res_raw) if res_raw in ("ok", "failed", "skipped") else "unknown"
            ev_a = html.escape(str(st.get("event_id") or ""))
            ev_b = html.escape(str(st.get("event_id_end") or ""))
            tid = html.escape(str(st.get("task_id") or ""))
            qseq = st.get("queue_seq")
            qseq_s = html.escape(str(qseq)) if qseq is not None else "—"
            exec_block = _exec_summary_paragraph(
                str(st.get("execution_summary") or st.get("readable_summary") or ""),
                title="执行摘要（组合链）",
            )
            ub = html.escape(str(st.get("url_before") or ""))
            ua = html.escape(str(st.get("url_after") or ""))
            ad = st.get("anchor_depth")
            yft = st.get("yaml_flow_total")
            yti = st.get("yaml_flow_target_index")
            yfull = st.get("yaml_full_body")
            so_raw = st.get("step_origin")
            so_code = str(so_raw) if isinstance(so_raw, str) and so_raw.strip() else ""
            layer_bits: list[str] = []
            if so_code:
                od = step_origin_display(so_code)
                layer_bits.append(f'<span class="origin">{html.escape(od)} · 组合链</span>')
            if isinstance(ad, int):
                layer_bits.append(f'<span class="L">锚点 L{ad}</span>')
            if isinstance(yft, int) and isinstance(yti, int):
                layer_bits.append(
                    f'<span class="L">末原子步对应 flow 第 {html.escape(str(yti))}/{html.escape(str(yft))} 步</span>'
                )
            layer_html = ('<p class="layer">' + " ".join(layer_bits) + "</p>") if layer_bits else ""
            au = st.get("anchor_url")
            if isinstance(au, str) and au.strip():
                aun2 = st.get("anchor_url_norm")
                aun_esc = html.escape(str(aun2 or ""))
                sa_line = (
                    f'<p class="session-anchor"><small>'
                    f'<strong>调度锚点</strong> <code>{aun_esc}</code>'
                    f' · <strong>YAML target / 重放根</strong> <code>{html.escape(au)}</code>'
                    f"</small></p>"
                )
            else:
                aun = st.get("anchor_url_norm")
                sa_line = f'<p class="session-anchor"><small>会话锚点: <code>{html.escape(str(aun or ""))}</code></small></p>'
            rng = f"{seq_a}–{seq_b}" if seq_a != seq_b else str(seq_a)
            hdr = f"步骤 {rng}（全局序）"
            if isinstance(aseq, int):
                hdr += f" · 会话内第 {aseq} 步"
            hdr += f' · <span class="res {res_cls}">{res_esc}</span>'
            aun_c = st.get("anchor_url_norm")
            hdr += f' · <small>调度 <code>{html.escape(str(aun_c or ""))}</code></small>'
            # 当前递归 URL 标注
            recurse_url_line = f'<p class="recurse-url"><small><strong>当前递归 URL</strong>：<code>{html.escape(str(aun_c or ""))}</code></small></p>'
            seq_id = int(seq_a) if isinstance(seq_a, int) else 0
            yaml_block = _yaml_details_block(yfull, yti, seq_id)
            sid_attr = html.escape(_step_anchor_id(st))
            return f"""
<article class="step step-composite-chain" id="{sid_attr}">
  <header>{hdr}</header>
  {recurse_url_line}
  {sa_line}
  {layer_html}
  <p class="meta">event_id: <code>{ev_a}</code> – <code>{ev_b}</code> · task_id: <code>{tid}</code> · queue_seq: <code>{qseq_s}</code></p>
  {exec_block}
  <p class="urls"><small><strong>地址栏（组合链整体）</strong>：{ub} → {ua}</small></p>
  {_prefix_flow_html(st)}
  {_composite_chain_html(st)}
  {yaml_block}
</article>"""

        seq = st.get("seq")
        aseq = st.get("anchor_step_seq")
        res_raw = str(st.get("result") or "")
        res_esc = html.escape(res_raw)
        res_cls = html.escape(res_raw) if res_raw in ("ok", "failed", "skipped") else "unknown"
        ev_id = html.escape(str(st.get("event_id") or ""))
        tid = html.escape(str(st.get("task_id") or ""))
        qseq = st.get("queue_seq")
        qseq_s = html.escape(str(qseq)) if qseq is not None else "—"
        exec_block = _exec_summary_paragraph(
            str(st.get("execution_summary") or st.get("readable_summary") or "")
        )
        shots = st.get("screenshots") if isinstance(st.get("screenshots"), dict) else {}
        b = shots.get("before")
        a = shots.get("after")
        ub = html.escape(str(st.get("url_before") or ""))
        ua = html.escape(str(st.get("url_after") or ""))
        ad = st.get("anchor_depth")
        yft = st.get("yaml_flow_total")
        yti = st.get("yaml_flow_target_index")
        yfull = st.get("yaml_full_body")
        so_raw = st.get("step_origin")
        so_code = str(so_raw) if isinstance(so_raw, str) and so_raw.strip() else ""
        cai = st.get("composite_atomic_index")
        cat = st.get("composite_atomic_total")
        layer_bits = []
        if so_code:
            od = step_origin_display(so_code)
            comp_hint = ""
            if isinstance(cai, int) and isinstance(cat, int):
                comp_hint = f" · 原子步 {cai}/{cat}"
            layer_bits.append(
                f'<span class="origin">{html.escape(od)}{html.escape(comp_hint)}</span>'
            )
        if isinstance(ad, int):
            layer_bits.append(f'<span class="L">锚点 L{ad}</span>')
        if isinstance(yft, int) and isinstance(yti, int):
            layer_bits.append(
                f'<span class="L">本事件对应 flow 第 {html.escape(str(yti))}/{html.escape(str(yft))} 步（含 aiWaitFor / 断言）</span>'
            )
        layer_html = ('<p class="layer">' + " ".join(layer_bits) + "</p>") if layer_bits else ""
        au = st.get("anchor_url")
        aun = st.get("anchor_url_norm")
        if isinstance(au, str) and au.strip():
            sa = html.escape(au)
            aun_s = html.escape(str(aun or ""))
            sa_line = (
                f'<p class="session-anchor"><small>'
                f'<strong>调度锚点</strong> <code>{aun_s}</code>'
                f' · <strong>YAML target / 重放根</strong> <code>{sa}</code>'
                f"</small></p>"
            )
        else:
            aun_s = html.escape(str(aun or ""))
            sa_line = f'<p class="session-anchor"><small>会话锚点: <code>{aun_s}</code> <em>（旧产物无 <code>anchor_url</code> 字段，已用规范化 URL）</em></small></p>'
        hdr = f"步骤 {seq}（全局序）"
        if isinstance(aseq, int):
            hdr += f" · 会话内第 {aseq} 步"
        hdr += f' · <span class="res {res_cls}">{res_esc}</span>'
        hdr += (
            f' · <small>调度 <code>{html.escape(str(aun or ""))}</code></small>'
        )
        seq_id = int(seq) if isinstance(seq, int) else 0
        yaml_block = _yaml_details_block(yfull, yti, seq_id)
        pfx_h = _prefix_flow_html(st)
        main_title = '<h4 class="flow-h">本步目标动作（before → after）</h4>' if pfx_h else ""
        art_cls = "step step-has-flow" if pfx_h else "step"
        # 当前递归 URL 标注
        recurse_url_line = f'<p class="recurse-url"><small><strong>当前递归 URL</strong>：<code>{html.escape(str(aun or ""))}</code></small></p>'
        has_no_shots = (not b or not isinstance(b, str)) and (not a or not isinstance(a, str))
        fail_hint = ""
        if res_raw == "failed":
            if has_no_shots:
                fail_hint = (
                    '<p class="footnote"><small><strong>失败说明（无截图）：</strong>before/after 截图均缺失，'
                    "通常因控件索引解析失败（DOM 不一致）或前缀重放失败导致截图流程被跳过。"
                    "首轮批量入队阶段的 failed 通常<strong>未生成</strong> <code>generated_cases</code>。</small></p>"
                )
            else:
                fail_hint = (
                    '<p class="footnote"><small><strong>失败说明：</strong>常见为控件索引解析失败（异步渲染/列表变化导致枚举与 DOM 不一致）或点击异常；'
                    "首轮批量入队阶段失败时通常<strong>未生成</strong> <code>generated_cases</code>。</small></p>"
                )
        elif has_no_shots:
            fail_hint = (
                '<p class="footnote"><small><strong>截图缺失：</strong>before/after 截图均未生成，'
                "可能因前缀重放中断或控件索引解析异常导致截图流程被跳过。</small></p>"
            )
        sid_attr = html.escape(_step_anchor_id(st))
        return f"""
<article class="{art_cls}" id="{sid_attr}">
  <header>{hdr}</header>
  {recurse_url_line}
  {sa_line}
  {layer_html}
  <p class="meta">event_id: <code>{ev_id}</code> · task_id: <code>{tid}</code> · queue_seq: <code>{qseq_s}</code></p>
  {exec_block}
  {fail_hint}
  <p class="urls"><small><strong>地址栏（当前标签页）</strong>：{ub} → {ua}</small></p>
  {pfx_h}
  {main_title}
  <div class="shots shots-main">{_img(b, "before")}{_img(a, "after")}</div>
  {yaml_block}
</article>"""

    steps_raw = payload.get("steps") if isinstance(payload.get("steps"), list) else []
    sections_html: list[str] = []
    nav_li_accum: list[str] = []
    url_order_assign: dict[str, int] = dict(sched_ordermap_base)
    next_ord = max(url_order_assign.values(), default=0) + 1
    cur_anchor: str | None = None
    chunk: list[dict[str, Any]] = []

    def _flush_timeline_chunk() -> None:
        nonlocal chunk, cur_anchor, next_ord
        if not chunk or cur_anchor is None:
            return
        an = str(cur_anchor)
        uo = url_order_assign.get(an)
        if uo is None:
            url_order_assign[an] = next_ord
            uo = next_ord
            next_ord += 1
        body, nav_li = _render_timeline_url_section(
            an,
            chunk,
            _one_step_card,
            url_order=uo,
            expl_depth_s=expl_depth_s,
        )
        sections_html.append(body)
        nav_li_accum.append(nav_li)
        chunk = []

    for st in steps_raw:
        if not isinstance(st, dict):
            continue
        an = str(st.get("anchor_url_norm") or "")
        if cur_anchor is None:
            cur_anchor = an
            chunk = [st]
            continue
        if an != cur_anchor:
            _flush_timeline_chunk()
            cur_anchor = an
            chunk = [st]
        else:
            chunk.append(st)
    if chunk and cur_anchor is not None:
        _flush_timeline_chunk()

    timeline_body = "\n".join(sections_html) if sections_html else "<p>（无 action_result 事件）</p>"
    if nav_li_accum:
        timeline_nav_html = (
            '<div class="timeline-nav-inner">'
            '<p class="timeline-nav-hint"><small>书签树：<strong>点击行首三角与文字空白处</strong>可折叠/展开下级；点击<strong>蓝色链接</strong>跳转锚点。步骤旁小角标为该步任务成败。</small></p>'
            '<ul class="tl-nav-tree">'
            + "".join(nav_li_accum)
            + "</ul></div>"
        )
    else:
        timeline_nav_html = '<p class="tl-nav-empty"><small>（无步骤可跳转）</small></p>'

    url_summary_rows = "".join(
        f"<tr><td>{html.escape(str(k))}</td><td>{int(v)}</td></tr>" for k, v in sorted(url_like.items())
    )
    url_block = (
        f"<table><thead><tr><th>类型</th><th>次数</th></tr></thead><tbody>{url_summary_rows}</tbody></table>"
        if url_summary_rows
        else "<p>（无 url_* 队列事件）</p>"
    )

    queues_note = ""
    if queues_name:
        queues_note = f"<p>完整轨迹见同目录 <code>{html.escape(str(queues_name))}</code>；下方为按 type 聚合计数。</p>"

    # URL 队列全貌面板
    overview_raw = payload.get("url_queue_overview")
    if isinstance(overview_raw, list) and overview_raw:
        overview_html = _render_url_queue_overview_html_from_rows(overview_raw, attr_img_src=_attr_img_src)
    else:
        overview_html = ""

    churn_html = _session_churn_banner_html(
        payload.get("steps") if isinstance(payload.get("steps"), list) else []
    )
    fs = run_meta.get("filter_summary") if isinstance(run_meta.get("filter_summary"), dict) else {}
    sev = payload.get("skip_event_counts") if isinstance(payload.get("skip_event_counts"), dict) else {}
    filter_panel = _render_filter_stats_panel(fs, sev)
    title_run = html.escape(str(payload.get("run_id") or "").strip() or "unknown")

    toc_items: list[tuple[str, str]] = [("sec-top", "页顶")]
    if churn_html.strip():
        toc_items.append(("sec-session-churn", "会话 / 认证"))
    if filter_panel.strip():
        toc_items.append(("sec-filter", "过滤统计"))
    toc_items.append(("sec-legend", "阅读说明"))
    if overview_html.strip():
        toc_items.append(("sec-url-overview", "URL 全量概览"))
    if schedule_html.strip():
        toc_items.append(("sec-url-schedule", "锚点出队序"))
    toc_items.extend(
        [
            ("sec-url-stats", "URL 队列聚合"),
            ("sec-queue-actions", "队列与跳过"),
            ("sec-timeline", "动作时间轴"),
        ]
    )
    if bt_segments:
        toc_items.append(("sec-budget", "预算截断"))
    toc_html = (
        '<nav class="report-toc" aria-label="报告目录"><span class="report-toc-label">目录</span>'
        + "".join(f'<a href="#{hid}">{html.escape(lab)}</a>' for hid, lab in toc_items)
        + "</nav>"
    )

    return f"""<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>探索叙事审查 · {title_run}{title_suffix}</title>
<style>
html {{ scroll-behavior: smooth; }}
body {{ font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; margin: 0; padding: 0; line-height: 1.5; color: #1a1a1a; scroll-padding-top: 1rem; }}
.report-shell {{ max-width: min(1320px, 96vw); margin: 0 auto; padding: 1rem min(1.25rem, 3vw) 2.5rem; box-sizing: border-box; }}
.report-header {{ margin-bottom: 0.35rem; }}
.report-header h1 {{ font-size: 1.35rem; margin: 0 0 0.35rem; }}
.standalone-banner {{ margin: 0.45rem 0 0; padding: 0.45rem 0.65rem; background: #ecfdf5; border: 1px solid #6ee7b7; border-radius: 8px; font-size: 0.88rem; color: #065f46; line-height: 1.45; }}
.report-toc {{ margin: 0.5rem 0 1rem; padding: 0.4rem 0.55rem; background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; font-size: 0.8rem; display: flex; flex-wrap: wrap; gap: 0.35rem 0.5rem; align-items: center; }}
.report-toc-label {{ font-size: 0.68rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em; color: #64748b; margin-right: 0.25rem; flex-shrink: 0; }}
.report-toc a {{ font-size: 0.78rem; color: #1d4ed8; text-decoration: none; padding: 0.15rem 0.45rem; border-radius: 6px; background: #fff; border: 1px solid #e2e8f0; white-space: nowrap; }}
.report-toc a:hover {{ background: #eff6ff; border-color: #bfdbfe; }}
#sec-top, #sec-legend, #sec-filter, #sec-session-churn, #sec-url-overview, #sec-url-schedule, #sec-url-stats, #sec-queue-actions, #sec-timeline, #sec-budget,
.tl-url-block, details.tl-origin-block, article.step {{ scroll-margin-top: 1rem; }}
h1 {{ font-size: 1.25rem; }}
.res.ok {{ color: #0a0; }} .res.failed {{ color: #a00; }} .res.skipped {{ color: #666; }}
.layer {{ font-size: 0.9rem; color: #444; margin: 0.25rem 0 0.5rem; }}
.layer .L {{ display: inline-block; padding: 0.1rem 0.45rem; border-radius: 4px; background: #eef6ff; border: 1px solid #cde; margin-right: 0.35rem; }}
.layer .origin {{ display: inline-block; padding: 0.1rem 0.45rem; border-radius: 4px; background: #f0fdf4; border: 1px solid #bbf7d0; margin-right: 0.35rem; font-weight: 600; }}
.yaml-full summary {{ font-weight: 600; margin-bottom: 0.35rem; }}
.yaml-full {{ margin-top: 0.5rem; }}
.yaml-head-fold {{ margin: 0.4rem 0 0.6rem; padding-left: 0.25rem; border-left: 2px solid #e2e8f0; }}
.exec-summary {{ margin: 0.45rem 0 0.65rem; padding: 0.45rem 0.55rem; background: #fafafa; border-radius: 6px; border: 1px solid #ececec; line-height: 1.45; }}
.exec-summary-body {{ display: inline-block; max-width: 100%; }}
.report-legend {{ margin: 0.75rem 0 1rem; padding: 0.5rem 0.65rem; background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; }}
.report-legend summary {{ font-weight: 600; }}
.report-legend p {{ margin: 0.35rem 0 0; color: #334155; font-size: 0.92rem; }}
.budget-trunc {{ margin: 1.5rem 0; padding: 0.75rem; background: #fffaf0; border: 1px solid #e6d4a8; border-radius: 8px; }}
.budget-trunc ul {{ margin: 0.35rem 0 0 1rem; }}
.budget-trunc .lp {{ color: #333; }}
.step {{ border: 1px solid #ddd; border-radius: 8px; padding: 0.75rem; margin: 1rem 0; }}
.step header {{ font-weight: 600; }}
.shots {{ display: flex; gap: 0.5rem; flex-wrap: wrap; align-items: flex-start; }}
.shots .review-zoom-wrap {{ flex: 1 1 40%; max-width: 50%; min-width: 180px; box-sizing: border-box; }}
.shots .review-zoom-wrap img {{ width: 100%; height: auto; border: 1px solid #e5e7eb; border-radius: 6px; display: block; vertical-align: middle; object-fit: contain; }}
.review-zoom-wrap {{ cursor: zoom-in; transition: box-shadow 0.15s ease; border-radius: 6px; }}
.review-zoom-wrap:hover {{ box-shadow: 0 2px 12px rgba(15, 23, 42, 0.12); }}
.review-zoom-wrap:focus {{ outline: 2px solid #3b82f6; outline-offset: 2px; }}
.ph {{ background: #f5f5f5; padding: 2rem; text-align: center; color: #666; flex: 1; min-width: 200px; }}
.explorer-lightbox {{ display: none; position: fixed; inset: 0; z-index: 10000; background: rgba(15, 23, 42, 0.9); align-items: center; justify-content: center; padding: 2vh 2vw; box-sizing: border-box; cursor: zoom-out; }}
.explorer-lightbox.is-open {{ display: flex; }}
.explorer-lightbox-close {{ position: fixed; top: 0.75rem; right: 0.85rem; z-index: 10001; font-size: 1.75rem; line-height: 1; width: 2.25rem; height: 2.25rem; border: none; border-radius: 8px; background: rgba(255,255,255,0.95); color: #334155; cursor: pointer; box-shadow: 0 2px 8px rgba(0,0,0,0.2); }}
.explorer-lightbox-close:hover {{ background: #fff; }}
#explorer-lightbox-img {{ max-width: min(96vw, 1400px); max-height: 92vh; width: auto; height: auto; object-fit: contain; border-radius: 6px; box-shadow: 0 12px 48px rgba(0,0,0,0.45); cursor: default; }}
summary {{ cursor: pointer; }}
table {{ border-collapse: collapse; width: 100%; max-width: 100%; }}
.url-schedule-wrap {{ margin: 1rem 0; }}
table.wide-schedule {{ max-width: 100%; }}
th, td {{ border: 1px solid #ddd; padding: 0.35rem 0.5rem; text-align: left; }}
code {{ font-size: 0.85em; }}
.anchor-title {{ font-size: 1.05rem; margin: 0.5rem 0; }}
.url-after-change {{ font-size: 0.95rem; color: #444; margin: 0.75rem 0 0.25rem; border-bottom: 1px dashed #ddd; padding-bottom: 0.25rem; }}
.yaml-snippet {{ background: #f8f8f8; padding: 0.5rem; overflow-x: auto; font-size: 0.82rem; border-radius: 6px; border: 1px solid #eee; white-space: pre-wrap; }}
.yaml-head {{ border-left: 3px solid #cbd5e1; }}
.yaml-body {{ border-left: 3px solid #22c55e; }}
.yaml-part-label {{ margin: 0.5rem 0 0.15rem; color: #64748b; }}
.yaml-copy-btn {{ padding: 0.25rem 0.65rem; font-size: 0.85rem; cursor: pointer; border-radius: 6px; border: 1px solid #cbd5e1; background: #fff; }}
.yaml-copy-btn:hover {{ background: #f8fafc; }}
.yaml-copy-hint {{ margin-left: 0.5rem; font-size: 0.85rem; color: #16a34a; }}
.yaml-footnote {{ margin: 0.35rem 0; color: #666; }}
.footnote {{ color: #555; }}
.section-hint {{ color: #444; margin: 0.35rem 0 0.75rem; line-height: 1.45; }}
.session-anchor {{ margin: 0.35rem 0 0.5rem; padding: 0.35rem 0.5rem; background: #f7f9fc; border-radius: 6px; border: 1px solid #e2e8f0; }}
.recurse-url {{ margin: 0.25rem 0; padding: 0.25rem 0.5rem; background: #eff6ff; border-radius: 6px; border: 1px solid #bfdbfe; }}
.recurse-url code {{ word-break: break-all; color: #1d4ed8; }}
.session-anchor code {{ word-break: break-all; }}
.step-composite-chain .footnote {{ color: #64748b; font-size: 0.88rem; }}
.shot-flow {{ margin: 0.65rem 0; }}
.flow-h {{ font-size: 0.92rem; margin: 0 0 0.4rem; color: #475569; font-weight: 600; }}
.flow-strip {{ display: flex; align-items: flex-start; gap: 0.35rem; overflow-x: auto; padding: 0.4rem 0; -webkit-overflow-scrolling: touch; scroll-snap-type: x proximity; }}
.flow-strip-composite-wide {{ align-items: stretch; gap: 0.65rem; padding: 0.5rem 0 0.75rem; }}
.flow-arrow {{ align-self: center; color: #94a3b8; flex-shrink: 0; font-size: 1.1rem; padding: 0 0.1rem; user-select: none; }}
.flow-tile {{ flex: 0 0 auto; width: min(300px, 46vw); max-width: 100%; border: 1px solid #e5e7eb; border-radius: 8px; padding: 0.4rem; background: #fafafa; scroll-snap-align: start; }}
.flow-tile-atomic-wide {{ width: min(880px, 96vw); max-width: 100%; padding: 0.65rem 0.75rem; scroll-snap-align: start; }}
.flow-tile-atomic-wide .shots-composite-pair .review-zoom-wrap {{ max-width: 48%; flex: 1 1 45%; }}
.flow-tile-atomic-wide .shots-composite-pair .review-zoom-wrap img {{ max-height: min(56vh, 520px); }}
.atomic-ba-label {{ margin: 0.15rem 0 0.35rem; color: #94a3b8; font-size: 0.82rem; }}
.flow-tile-cap {{ font-size: 0.78rem; font-weight: 600; margin-bottom: 0.25rem; color: #334155; }}
.flow-tile-one .review-zoom-wrap img {{ display: block; width: 100%; height: auto; max-height: 200px; object-fit: contain; border: 1px solid #eee; border-radius: 4px; }}
.flow-tile-lab {{ margin: 0.25rem 0 0; color: #475569; line-height: 1.35; }}
.flow-url {{ margin: 0.15rem 0 0; color: #64748b; word-break: break-all; }}
.shots-main {{ margin-top: 0.35rem; }}
.step-has-flow .shots-main .review-zoom-wrap {{ max-width: 48%; flex: 1 1 40%; }}
.timeline-zone {{ margin-top: 1.75rem; padding: 1rem 1.1rem 0.35rem; background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 12px; }}
.timeline-zone > h2 {{ margin-top: 0; padding-bottom: 0.35rem; border-bottom: 1px solid #e2e8f0; }}
.timeline-split {{ display: grid; grid-template-columns: minmax(220px, 270px) minmax(0, 1fr); gap: 1.25rem; align-items: start; margin-top: 0.65rem; }}
.timeline-sidebar-wrap {{ align-self: start; position: sticky; top: 0.5rem; z-index: 2; }}
.timeline-drawer-toggle {{
  display: none; width: 100%; box-sizing: border-box; margin: 0 0 0.5rem; padding: 0.45rem 0.65rem;
  font-size: 0.85rem; font-weight: 600; cursor: pointer; border-radius: 8px; border: 1px solid #bfdbfe;
  background: linear-gradient(180deg, #eff6ff, #dbeafe); color: #1e3a8a;
}}
.timeline-drawer-toggle:hover {{ background: #dbeafe; border-color: #93c5fd; }}
.timeline-drawer-toggle:focus {{ outline: 2px solid #3b82f6; outline-offset: 2px; }}
.timeline-drawer-overlay {{ display: none; }}
@media (max-width: 960px) {{
  .timeline-split {{ grid-template-columns: 1fr; }}
  .timeline-sidebar-wrap {{ position: static; z-index: auto; }}
  .timeline-drawer-toggle {{ display: flex; align-items: center; justify-content: center; gap: 0.35rem; }}
  .timeline-sidebar-wrap.is-drawer-open .timeline-drawer-overlay {{
    display: block; position: fixed; inset: 0; z-index: 9000; background: rgba(15, 23, 42, 0.38);
    border: none; padding: 0; margin: 0; cursor: pointer;
  }}
  .timeline-sidebar {{
    position: fixed !important; left: 0 !important; top: 0 !important; bottom: 0 !important;
    width: min(300px, 90vw) !important; max-width: 100vw !important; max-height: none !important;
    z-index: 9001 !important; margin: 0 !important; border-radius: 0 !important;
    transform: translateX(-100%); transition: transform 0.22s ease; box-shadow: 4px 0 24px rgba(15,23,42,0.18);
  }}
  .timeline-sidebar-wrap.is-drawer-open .timeline-sidebar {{ transform: translateX(0); }}
}}
.timeline-sidebar {{ position: relative; max-height: calc(100vh - 1rem); overflow-y: auto; overflow-x: hidden; padding: 0.65rem 0.72rem; background: #fff; border: 1px solid #e2e8f0; border-radius: 10px; font-size: 0.8rem; box-shadow: 0 1px 3px rgba(15,23,42,0.06); }}
.tl-session-badge {{
  display: inline-block; font-size: 0.68rem; font-weight: 700; padding: 0.14rem 0.5rem; border-radius: 999px;
  vertical-align: middle; margin-left: 0.35rem; letter-spacing: 0.02em; white-space: nowrap;
}}
.anchor-title .tl-session-badge {{ font-size: 0.72rem; }}
.tl-sess-ok {{ background: #dcfce7; color: #166534; border: 1px solid #86efac; }}
.tl-sess-failed {{ background: #fee2e2; color: #991b1b; border: 1px solid #fca5a5; }}
.tl-sess-skipped {{ background: #f3f4f6; color: #4b5563; border: 1px solid #d1d5db; }}
.tl-sess-unknown {{ background: #fef3c7; color: #92400e; border: 1px solid #fcd34d; }}
.tl-nav-sess-bucket {{ margin-left: 0.22rem; font-size: 0.58rem; padding: 0.05rem 0.32rem; vertical-align: middle; flex-shrink: 0; }}
.tl-nav-norm {{ display: block; width: 100%; margin-top: 0.08rem; color: #64748b; font-weight: 400; line-height: 1.3; word-break: break-all; }}
.timeline-nav-inner {{ padding-bottom: 0.25rem; }}
.timeline-nav-hint {{ margin: 0 0 0.45rem; color: #64748b; line-height: 1.35; }}
.tl-nav-empty {{ margin: 0; color: #94a3b8; }}
.tl-nav-tree {{ list-style: none; margin: 0; padding: 0; }}
.tl-nav-tree ul {{ list-style: none; margin: 0.12rem 0 0.3rem 0.45rem; padding: 0 0 0 0.45rem; border-left: 2px solid #cbd5e1; }}
.tl-nav-tree li {{ margin: 0.08rem 0; line-height: 1.38; }}
.tl-nav-tree a {{
  color: #1d4ed8; text-decoration: none; border-radius: 4px;
  display: inline-flex; flex-wrap: wrap; align-items: center; gap: 0.15rem 0.25rem; max-width: 100%;
}}
.tl-nav-tree a:hover {{ background: #eff6ff; }}
.tl-nav-tree a.tl-nav-active {{
  background: #dbeafe; color: #1e3a8a !important; font-weight: 600;
  box-shadow: inset 3px 0 0 #2563eb; padding-left: 0.35rem; margin-left: -0.35rem;
}}
.tl-nav-url-badge {{ font-weight: 700; color: #0f172a; }}
.tl-nav-buckets {{ margin-top: 0.2rem !important; }}
.tl-nav-details {{ margin: 0.06rem 0; }}
.tl-nav-summary {{
  display: flex; flex-wrap: wrap; align-items: center; gap: 0.2rem 0.32rem;
  list-style: none; cursor: pointer; padding: 0.22rem 0.28rem; margin: 0; border-radius: 6px;
  font-size: 0.78rem; line-height: 1.35; color: #334155;
}}
.tl-nav-summary:hover {{ background: #f1f5f9; }}
.tl-nav-summary::-webkit-details-marker {{ display: none; }}
.tl-nav-summary::marker {{ content: ""; }}
.tl-nav-caret {{
  display: inline-block; width: 0.38rem; height: 0.38rem; border-right: 2px solid #64748b; border-bottom: 2px solid #64748b;
  transform: rotate(-45deg); flex-shrink: 0; transition: transform 0.12s ease; vertical-align: middle;
}}
details.tl-nav-details[open] > .tl-nav-summary .tl-nav-caret {{ transform: rotate(45deg); margin-top: -0.06rem; }}
.tl-nav-jump {{ color: #1d4ed8 !important; text-decoration: none; font-weight: 600; border-radius: 4px; padding: 0.06rem 0.12rem; margin: -0.06rem -0.12rem; }}
.tl-nav-jump:hover {{ background: #eff6ff; }}
.tl-nav-details-url > .tl-nav-summary .tl-nav-norm {{ flex: 1 1 100%; margin: 0.1rem 0 0 1rem; max-width: 100%; }}
.tl-nav-steps {{ margin-top: 0.08rem !important; }}
.tl-nav-step-sess {{ font-size: 0.54rem !important; padding: 0.04rem 0.28rem !important; margin-left: 0.2rem !important; font-weight: 700; }}
.tl-nav-tree .tl-nav-summary .tl-nav-jump {{ display: inline-flex; flex-wrap: wrap; align-items: center; gap: 0.2rem; max-width: 100%; }}
details.tl-origin-block {{
  margin: 0.65rem 0 0.85rem; padding: 0; border: 1px solid #e2e8f0; border-radius: 10px; background: #fff;
  box-shadow: 0 1px 2px rgba(15,23,42,0.04);
}}
details.tl-origin-block + details.tl-origin-block {{ margin-top: 0.5rem; }}
.tl-url-block > .section-hint + details.tl-origin-block {{ margin-top: 0.35rem; }}
summary.tl-origin-title {{
  display: flex; align-items: center; flex-wrap: wrap; gap: 0.35rem 0.5rem;
  list-style: none; cursor: pointer; margin: 0; padding: 0.55rem 0.65rem;
  font-size: 0.95rem; font-weight: 600; color: #334155;
  border-bottom: 1px solid #e2e8f0; border-radius: 10px 10px 0 0; background: linear-gradient(180deg, #f8fafc, #f1f5f9);
  user-select: none;
}}
details.tl-origin-block:not([open]) > summary.tl-origin-title {{ border-bottom: none; border-radius: 10px; }}
summary.tl-origin-title::-webkit-details-marker {{ display: none; }}
summary.tl-origin-title::marker {{ content: ""; }}
.tl-origin-chevron {{
  display: inline-block; width: 0.5rem; height: 0.5rem; border-right: 2px solid #64748b; border-bottom: 2px solid #64748b;
  transform: rotate(-45deg); flex-shrink: 0; margin-right: 0.15rem; transition: transform 0.15s ease;
}}
details.tl-origin-block[open] > summary.tl-origin-title .tl-origin-chevron {{ transform: rotate(45deg); margin-top: -0.1rem; }}
.tl-origin-label {{ flex: 1 1 auto; min-width: 4rem; }}
.tl-fold-hint {{ margin-left: auto; flex-shrink: 0; }}
.tl-fold-hint small {{ font-size: 0.68rem; color: #94a3b8; font-weight: 400; }}
.tl-origin-body {{ padding: 0.35rem 0.65rem 0.65rem; }}
.tl-origin-body > .url-after-change:first-child {{ margin-top: 0.35rem; }}
.tl-url-block {{ margin-bottom: 0.5rem; }}
.timeline-main-col {{ min-width: 0; }}
.anchor-block {{ border-left: 3px solid #94a3b8; padding-left: 1rem; margin: 1.25rem 0; background: #fff; border-radius: 0 8px 8px 0; padding-top: 0.35rem; padding-bottom: 0.5rem; }}
.url-after-raw {{ margin: 0.15rem 0 0.5rem; color: #64748b; }}
.session-churn {{ margin: 0.75rem 0 1rem; padding: 0.5rem 0.65rem; background: #fff7ed; border: 1px solid #fdba74; border-radius: 8px; }}
.session-churn summary {{ font-weight: 600; }}
.session-churn-body {{ margin: 0.35rem 0 0; color: #9a3412; font-size: 0.92rem; line-height: 1.45; }}
</style>
</head>
<body>
<div class="report-shell">
<header class="report-header" id="sec-top">
<h1>递归探索 · 叙事审查</h1>
<p><strong>入口</strong> {entry}<br/><strong>run_id</strong> <code>{run_id}</code></p>
{standalone_banner}
</header>
{toc_html}
{churn_html}
{filter_panel}
<details class="report-legend" id="sec-legend">
<summary>如何阅读：无图 · 地址栏不变 · generated_cases</summary>
<p><strong>「before/after：无图」</strong>表示该事件未带上截图路径（字段为空）。常见于动作失败提前返回、控件索引解析失败、前缀重放未完成等，截图流水线未写入路径——不代表页面一定未打开。</p>
<p><strong>地址栏 before → after 相同</strong>常见于同 URL 内的点击（未整页跳转）、浮层/抽屉、或 SPA 仅切换视图不改 history；与调度锚点 <code>anchor_url_norm</code> 是否相同是两回事。</p>
<p><strong>完整执行 YAML</strong>默认折叠；展开后直接展示<strong>磁盘上</strong> <code>generated_cases/</code> 下对应文件的主体（与回放文件一致）。默认可为 <code>&lt;anchor_step_seq 四位&gt;_&lt;action_dequeue.seq 六位&gt;_&lt;task_id&gt;.yaml</code>（与上方「会话内第 N 步」及 <code>events.anchor_step_seq</code> 对齐），与同次 run 下 <code>bootstrap_replay_logs_task/&lt;seq&gt;_&lt;task_id&gt;/</code> 的队列 <code>seq</code> 一致；可选关闭锚点前缀或仅用 <code>task_id</code> 的模式见 <code>exploration_report.md</code> 中 <code>generated_cases_*</code> 配置。其中 <code>aiTap</code>/<code>locate</code> 若出现 <code>div &gt; img</code> 等片段，是录制/枚举时的 DOM 技术定位，便于复现对齐。</p>
<p>若提示未找到 <code>generated_cases/*.yaml</code>：多为该步未成功落盘 YAML（首轮失败步常见），仍可用上方 flow 步号或 <code>events.jsonl</code> 对照。</p>
<p><small>请在本 HTML 所在目录打开（或与 <code>assets/</code> 保持相对路径），否则已有截图路径也可能无法在浏览器中加载。</small></p>
<p><small><strong>截图</strong>均可点击（或按 Enter）在当前页<strong>放大预览</strong>，按 Esc 或点击半透明背景关闭。</small></p>
</details>
{overview_html}
{schedule_html}

<h2 id="sec-url-stats">URL 队列（聚合）</h2>
{url_block}

<details id="sec-queue-actions">
<summary>动作队列与跳过（聚合 · 默认折叠）</summary>
{queues_note}
<p>action_enqueue: {action_enq} · action_dequeue: {action_dq} · action_skip: {action_skip}</p>
<table><thead><tr><th>queues type</th><th>count</th></tr></thead><tbody>{rows_q}</tbody></table>
</details>

<section class="timeline-zone">
<h2 id="sec-timeline">动作时间轴</h2>
<p class="footnote"><small><strong>左侧</strong>为书签树（与「锚点出队序」中 URL-# 对齐）；<strong>seq</strong> 为全局序，「会话」为锚点内步号。组合链显示为一条卡片。<strong>彩色角标</strong>：分组标题旁为<strong>该分组</strong>内汇总；侧栏<strong>步骤</strong>旁为<strong>该步任务</strong>结果。<strong>侧栏</strong>点击 URL/分级行（三角或留白）可折叠下级书签，点击<strong>蓝色链接</strong>跳转；主正文分组标题仍折叠正文。窄屏用「时间轴书签」打开侧栏；滚动时侧栏高亮当前段落。</small></p>
<div class="timeline-split">
<div class="timeline-sidebar-wrap" id="timeline-sidebar-wrap">
<button type="button" class="timeline-drawer-toggle" id="timeline-drawer-open" aria-controls="timeline-sidebar-panel" aria-expanded="false">时间轴书签</button>
<div class="timeline-drawer-overlay" id="timeline-drawer-overlay" aria-hidden="true"></div>
<aside class="timeline-sidebar" id="timeline-sidebar-panel" aria-label="时间轴书签">{timeline_nav_html}</aside>
</div>
<div class="timeline-main-col">{timeline_body}</div>
</div>
</section>
{_render_budget_truncation_html()}
</div>
<div id="explorer-lightbox" class="explorer-lightbox" aria-hidden="true" role="dialog" aria-modal="true" aria-label="大图预览">
<button type="button" class="explorer-lightbox-close" aria-label="关闭">&times;</button>
<img id="explorer-lightbox-img" alt="" />
</div>
<script>
function explorerOpenLightbox(el) {{
  if (!el || !el.classList || !el.classList.contains("review-zoom-wrap")) return;
  var box = document.getElementById("explorer-lightbox");
  var im = document.getElementById("explorer-lightbox-img");
  if (!box || !im) return;
  var src = el.getAttribute("data-fullsrc");
  if (!src) {{
    var inner = el.querySelector("img");
    if (inner) src = inner.getAttribute("src");
  }}
  if (!src) return;
  im.src = src;
  im.alt = el.getAttribute("data-alt") || "";
  box.classList.add("is-open");
  box.setAttribute("aria-hidden", "false");
  document.body.style.overflow = "hidden";
}}
function explorerCloseLightbox() {{
  var box = document.getElementById("explorer-lightbox");
  var im = document.getElementById("explorer-lightbox-img");
  if (!box || !box.classList.contains("is-open")) return;
  box.classList.remove("is-open");
  box.setAttribute("aria-hidden", "true");
  document.body.style.overflow = "";
  if (im) {{ im.removeAttribute("src"); im.alt = ""; }}
}}
document.addEventListener("click", function (e) {{
  var w = e.target.closest(".review-zoom-wrap");
  if (w) {{ e.preventDefault(); explorerOpenLightbox(w); }}
}});
document.addEventListener("keydown", function (e) {{
  if (e.key === "Escape") {{
    var lb = document.getElementById("explorer-lightbox");
    if (lb && lb.classList.contains("is-open")) explorerCloseLightbox();
    return;
  }}
  var w = e.target && e.target.closest ? e.target.closest(".review-zoom-wrap") : null;
  if (w && (e.key === "Enter" || e.key === " ")) {{
    e.preventDefault();
    explorerOpenLightbox(w);
  }}
}});
(function () {{
  var box = document.getElementById("explorer-lightbox");
  if (box) {{
    box.addEventListener("click", function (e) {{
      if (e.target === box) explorerCloseLightbox();
    }});
  }}
  var closeBtn = document.querySelector(".explorer-lightbox-close");
  if (closeBtn) {{
    closeBtn.addEventListener("click", function (e) {{
      e.stopPropagation();
      explorerCloseLightbox();
    }});
  }}
  var lim = document.getElementById("explorer-lightbox-img");
  if (lim) lim.addEventListener("click", function (e) {{ e.stopPropagation(); }});
}})();
function explorerCopyYamlBody(seq) {{
  var el = document.getElementById("yaml-body-" + seq);
  var hint = document.getElementById("yaml-copy-hint-" + seq);
  if (!el || !el.textContent) return;
  var text = el.textContent;
  function ok() {{
    if (hint) hint.textContent = "已复制";
    setTimeout(function () {{ if (hint) hint.textContent = ""; }}, 2500);
  }}
  function fail() {{
    if (hint) hint.textContent = "复制失败，请手动选择文本";
  }}
  if (navigator.clipboard && navigator.clipboard.writeText) {{
    navigator.clipboard.writeText(text).then(ok).catch(fail);
  }} else {{
    try {{
      var ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.left = "-9999px";
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
      ok();
    }} catch (e) {{ fail(); }}
  }}
}}
(function initTimelineDrawer() {{
  var wrap = document.getElementById("timeline-sidebar-wrap");
  var btn = document.getElementById("timeline-drawer-open");
  var overlay = document.getElementById("timeline-drawer-overlay");
  var panel = document.getElementById("timeline-sidebar-panel");
  if (!wrap || !btn) return;
  function setOpen(on) {{
    wrap.classList.toggle("is-drawer-open", !!on);
    btn.setAttribute("aria-expanded", on ? "true" : "false");
    if (overlay) overlay.setAttribute("aria-hidden", on ? "false" : "true");
    if (!on) {{
      document.body.style.overflow = "";
    }} else if (window.matchMedia && window.matchMedia("(max-width: 960px)").matches) {{
      document.body.style.overflow = "hidden";
    }}
  }}
  btn.addEventListener("click", function () {{
    setOpen(!wrap.classList.contains("is-drawer-open"));
  }});
  if (overlay) {{
    overlay.addEventListener("click", function () {{ setOpen(false); }});
  }}
  document.addEventListener("keydown", function (e) {{
    if (e.key !== "Escape" || !wrap.classList.contains("is-drawer-open")) return;
    var lb = document.getElementById("explorer-lightbox");
    if (lb && lb.classList.contains("is-open")) return;
    setOpen(false);
  }});
  if (panel) {{
    panel.addEventListener("click", function (e) {{
      if (!e.target.closest || !e.target.closest("a")) return;
      if (!wrap.classList.contains("is-drawer-open")) return;
      if (window.matchMedia && window.matchMedia("(max-width: 960px)").matches) {{
        window.setTimeout(function () {{ setOpen(false); }}, 320);
      }}
    }});
  }}
  window.addEventListener("resize", function () {{
    if (window.matchMedia && !window.matchMedia("(max-width: 960px)").matches) {{
      setOpen(false);
      document.body.style.overflow = "";
    }}
  }});
}})();
(function initTimelineScrollSpy() {{
  var main = document.querySelector(".timeline-main-col");
  var navRoot = document.querySelector(".tl-nav-tree");
  if (!main || !navRoot) return;
  var links = Array.prototype.slice.call(navRoot.querySelectorAll('a[href^="#"]'));
  if (!links.length) return;
  var hrefs = links.map(function (a) {{ return a.getAttribute("href").slice(1); }});
  var sel = "section.tl-url-block, details.tl-origin-block, article.step, article.step-composite-chain";
  var targets = [];
  var all = main.querySelectorAll(sel);
  for (var i = 0; i < all.length; i++) {{
    var el = all[i];
    if (el.id && hrefs.indexOf(el.id) >= 0) targets.push(el);
  }}
  if (!targets.length) return;
  var line = 100;
  var ticking = false;
  function updateActive() {{
    var activeId = "";
    for (var t = 0; t < targets.length; t++) {{
      var r = targets[t].getBoundingClientRect();
      if (r.top <= line) activeId = targets[t].id;
    }}
    if (!activeId && targets.length) activeId = targets[0].id;
    for (var L = 0; L < links.length; L++) {{
      var a = links[L];
      var id = a.getAttribute("href").slice(1);
      a.classList.toggle("tl-nav-active", id === activeId);
    }}
    var wrap = document.getElementById("timeline-sidebar-wrap");
    var panel = document.getElementById("timeline-sidebar-panel");
    if (wrap && panel && wrap.classList.contains("is-drawer-open")) {{
      for (var j = 0; j < links.length; j++) {{
        if (links[j].getAttribute("href") === "#" + activeId) {{
          try {{ links[j].scrollIntoView({{ block: "nearest", behavior: "smooth" }}); }} catch (e) {{}}
          break;
        }}
      }}
    }}
    ticking = false;
  }}
  function onScroll() {{
    if (!ticking) {{ ticking = true; requestAnimationFrame(updateActive); }}
  }}
  window.addEventListener("scroll", onScroll, {{ passive: true }});
  window.addEventListener("resize", onScroll);
  window.addEventListener("hashchange", onScroll);
  updateActive();
}})();
(function initTimelineFoldDeepLink() {{
  function openAncestors(el) {{
    if (!el || !el.closest) return;
    var d = el.closest("details.tl-origin-block");
    while (d) {{
      d.open = true;
      var p = d.parentElement;
      d = p ? p.closest("details.tl-origin-block") : null;
    }}
  }}
  function openSidebarNavDetails(id) {{
    var panel = document.getElementById("timeline-sidebar-panel");
    if (!panel || !id) return;
    var link = null;
    try {{
      link = panel.querySelector('a[href="#' + id + '"]');
    }} catch (e) {{ return; }}
    if (!link) return;
    var d = link.closest("details.tl-nav-details");
    while (d) {{
      d.open = true;
      var p = d.parentElement;
      d = p ? p.closest("details.tl-nav-details") : null;
    }}
  }}
  function fromHash() {{
    var id = (location.hash || "").replace(/^#/, "");
    if (!id) return;
    var t = document.getElementById(id);
    if (t) openAncestors(t);
    openSidebarNavDetails(id);
  }}
  var navRoot = document.querySelector(".tl-nav-tree");
  if (navRoot) {{
    navRoot.addEventListener("click", function (e) {{
      var a = e.target.closest && e.target.closest("a[href^='#']");
      if (!a) return;
      var id = a.getAttribute("href").slice(1);
      window.setTimeout(function () {{
        var t = document.getElementById(id);
        if (t) openAncestors(t);
        openSidebarNavDetails(id);
      }}, 0);
    }});
  }}
  window.addEventListener("hashchange", fromHash);
  fromHash();
}})();
</script>
</body>
</html>"""


def load_timeline_payload_for_review(out_dir: Path) -> dict[str, Any]:
    """读取 ``timeline.json``；损坏或缺失时从 events/graph 等重建（仅内存，不写盘）。"""
    out_dir = Path(out_dir)
    jpath = out_dir / "timeline.json"
    if jpath.is_file():
        try:
            data = json.loads(jpath.read_text(encoding="utf-8"))
            if isinstance(data, dict) and data.get("schema") == TIMELINE_SCHEMA:
                return data
        except json.JSONDecodeError:
            pass
    return build_timeline_payload(out_dir)


def write_standalone_review_html(out_dir: Path) -> Path:
    """
    仅写出 ``review_timeline.standalone.html``：基于同目录已有叙事数据内嵌本地截图（data URL），
    **不**重写 ``review_timeline.html`` / ``timeline.json``，也**不**重新跑探索。
    若仅有 events 而无 ``timeline.json``，会在内存中重建 payload 后再渲染（仍不写 json）。
    """
    out_dir = Path(out_dir).resolve()
    out_dir.mkdir(parents=True, exist_ok=True)
    payload = load_timeline_payload_for_review(out_dir)
    standalone_path = out_dir / "review_timeline.standalone.html"
    standalone_path.write_text(
        render_review_html(payload, embed_images=True, asset_base=out_dir),
        encoding="utf-8",
    )
    return standalone_path


def generate_exploration_review(out_dir: Path) -> tuple[Path, Path]:
    """
    写入 timeline.json 与 review_timeline.html。
    **不**生成 ``review_timeline.standalone.html``；内嵌离线版由用户在事后执行
    ``python -m recursive_exploration.review_report <dir> --standalone`` 单独转换。
    返回 (html_path, json_path)。
    """
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    payload = build_timeline_payload(out_dir)
    json_path = out_dir / "timeline.json"
    html_path = out_dir / "review_timeline.html"
    json_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    html_path.write_text(render_review_html(payload), encoding="utf-8")
    return html_path, json_path


def main(argv: list[str] | None = None) -> int:
    """补生成审查产物或仅导出内嵌图 HTML。

    - ``<out_dir>``：刷新 ``timeline.json`` + ``review_timeline.html``（与探索 run 结束行为一致）。
    - ``<out_dir> --standalone``：**仅**生成 ``review_timeline.standalone.html``（读已有 ``timeline.json`` 内嵌截图，不覆盖常规报告）。
    """
    args = list(argv if argv is not None else sys.argv[1:])
    standalone_only = False
    while "--standalone" in args:
        standalone_only = True
        args.remove("--standalone")
    if len(args) != 1:
        print(
            "用法:\n"
            "  python -m recursive_exploration.review_report <run_output_dir>\n"
            "      刷新 timeline.json 与 review_timeline.html\n"
            "  python -m recursive_exploration.review_report <run_output_dir> --standalone\n"
            "      仅生成 review_timeline.standalone.html（内嵌截图；不重新跑探索；不覆盖上述两文件）",
            file=sys.stderr,
        )
        return 2
    p = Path(args[0]).expanduser()
    if not p.is_dir():
        print(f"不是目录: {p}", file=sys.stderr)
        return 2
    if standalone_only:
        sp = write_standalone_review_html(p)
        print(sp)
        return 0
    h, j = generate_exploration_review(p)
    print(h)
    print(j)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
