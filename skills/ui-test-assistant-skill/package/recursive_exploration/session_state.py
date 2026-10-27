"""session_state.json：resume-strict 唯一恢复源（与事件/队列审计分离）。"""

from __future__ import annotations

import dataclasses
import json
from collections import deque
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Literal

from recursive_exploration.config import ExecutionMode, ExplorationRunConfig
from recursive_exploration.dedupe import DedupeStore
from recursive_exploration.models import ActionTask, BootstrapResult, ExplorationStep, StartContext, UrlTask


SESSION_SCHEMA = "exploration-session-state/v1"


def _iso_now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def exploration_config_to_dict(cfg: ExplorationRunConfig) -> dict[str, Any]:
    d = dataclasses.asdict(cfg)
    em = cfg.execution_mode
    d["execution_mode"] = em.value if isinstance(em, ExecutionMode) else str(em)
    if cfg.skill_root is not None:
        d["skill_root"] = str(cfg.skill_root)
    return d


def exploration_config_from_dict(raw: dict[str, Any]) -> ExplorationRunConfig:
    d = dict(raw)
    d.pop("resume_session_dir", None)
    sr = d.get("skill_root")
    if sr:
        d["skill_root"] = Path(sr)
    else:
        d["skill_root"] = None
    em = d.get("execution_mode", "fast")
    d["execution_mode"] = ExecutionMode(str(em))
    d.setdefault("generated_cases_filename_mode", "queue_seq_task_id")
    d.setdefault("generated_cases_include_anchor_step_seq", True)
    d.setdefault("screenshot_remove_highlights_before_capture", False)
    return ExplorationRunConfig(**d)


def exploration_step_from_dict(o: dict[str, Any]) -> ExplorationStep:
    return ExplorationStep(
        element_index=int(o["element_index"]),
        branch_path_hash=str(o["branch_path_hash"]),
        tap_description=str(o.get("tap_description") or ""),
        locate_prompt=str(o.get("locate_prompt") or ""),
        step_kind=o.get("step_kind") or "click",
        input_value=str(o.get("input_value") or ""),
        scroll_delta_y=int(o.get("scroll_delta_y") or 0),
    )


def exploration_step_to_dict(s: ExplorationStep) -> dict[str, Any]:
    return {
        "element_index": s.element_index,
        "branch_path_hash": s.branch_path_hash,
        "tap_description": s.tap_description,
        "locate_prompt": s.locate_prompt,
        "step_kind": s.step_kind,
        "input_value": s.input_value,
        "scroll_delta_y": s.scroll_delta_y,
    }


def action_task_from_dict(o: dict[str, Any]) -> ActionTask:
    pfx = [exploration_step_from_dict(x) for x in (o.get("prefix_steps") or [])]
    comp = [exploration_step_from_dict(x) for x in (o.get("composite_steps") or [])]
    raw_intent = o.get("intent_ai_steps") or []
    intent_steps = [str(x).strip() for x in raw_intent if str(x).strip()] if isinstance(raw_intent, list) else []
    return ActionTask(
        task_id=str(o["task_id"]),
        run_id=str(o["run_id"]),
        anchor_url=str(o["anchor_url"]),
        anchor_url_norm=str(o["anchor_url_norm"]),
        dedupe_path_key=str(o["dedupe_path_key"]),
        prefix_steps=pfx,
        target_index=int(o["target_index"]),
        target_branch_path_hash=str(o["target_branch_path_hash"]),
        target_description=str(o.get("target_description") or ""),
        action_kind=o.get("action_kind") or "click",
        input_mock_value=str(o.get("input_mock_value") or ""),
        locate_prompt=str(o.get("locate_prompt") or ""),
        anchor_depth=int(o.get("anchor_depth") or 0),
        task_kind=o.get("task_kind") or "single",
        composite_plan_id=str(o.get("composite_plan_id") or ""),
        task_source=o.get("task_source") or "single_expand",
        composite_steps=comp,
        scroll_delta_y=int(o.get("scroll_delta_y") or 0),
        intent_ai_steps=intent_steps,
    )


def action_task_to_dict(t: ActionTask) -> dict[str, Any]:
    return {
        "task_id": t.task_id,
        "run_id": t.run_id,
        "anchor_url": t.anchor_url,
        "anchor_url_norm": t.anchor_url_norm,
        "dedupe_path_key": t.dedupe_path_key,
        "prefix_steps": [exploration_step_to_dict(s) for s in t.prefix_steps],
        "target_index": t.target_index,
        "target_branch_path_hash": t.target_branch_path_hash,
        "target_description": t.target_description,
        "action_kind": t.action_kind,
        "input_mock_value": t.input_mock_value,
        "locate_prompt": t.locate_prompt,
        "anchor_depth": t.anchor_depth,
        "task_kind": t.task_kind,
        "composite_plan_id": t.composite_plan_id,
        "task_source": t.task_source,
        "composite_steps": [exploration_step_to_dict(s) for s in t.composite_steps],
        "scroll_delta_y": t.scroll_delta_y,
        "intent_ai_steps": list(t.intent_ai_steps),
    }


def url_task_from_dict(o: dict[str, Any]) -> UrlTask:
    return UrlTask(
        url_norm=str(o["url_norm"]),
        raw_url=str(o["raw_url"]),
        anchor_depth=int(o.get("anchor_depth") or 0),
    )


def url_task_to_dict(u: UrlTask) -> dict[str, Any]:
    return {"url_norm": u.url_norm, "raw_url": u.raw_url, "anchor_depth": u.anchor_depth}


def dedupe_from_serial(d: dict[str, Any]) -> DedupeStore:
    ds = DedupeStore()
    ds.seen_action = set(d.get("seen_action") or [])
    ds.seen_path = set(d.get("seen_path") or [])
    ds.seen_url = set(d.get("seen_url") or [])
    ds.hits = dict(d.get("hits") or {})
    return ds


def dedupe_to_serial(ds: DedupeStore) -> dict[str, Any]:
    return {
        "seen_action": sorted(ds.seen_action),
        "seen_path": sorted(ds.seen_path),
        "seen_url": sorted(ds.seen_url),
        "hits": dict(ds.hits),
    }


def start_context_from_dict(d: dict[str, Any]) -> StartContext:
    return StartContext(
        start_kind=d.get("start_kind") or "entry_url",
        bootstrap_used=bool(d.get("bootstrap_used")),
        bootstrap_ref=d.get("bootstrap_ref"),
        bootstrap_last_url=d.get("bootstrap_last_url"),
        environment_summary=str(d.get("environment_summary") or ""),
        auth_summary=str(d.get("auth_summary") or ""),
        tenant_summary=str(d.get("tenant_summary") or ""),
        seed_page_state_id=d.get("seed_page_state_id"),
        seed_structural_state_id=d.get("seed_structural_state_id"),
    )


def start_context_to_dict(sc: StartContext) -> dict[str, Any]:
    return sc.to_run_meta_dict()


def bootstrap_result_from_dict(d: dict[str, Any]) -> BootstrapResult:
    return BootstrapResult(
        ok=bool(d.get("ok")),
        result=d.get("result") or "skipped",
        last_url=str(d.get("last_url") or ""),
        flow_ref=d.get("flow_ref"),
        state_summary=dict(d.get("state_summary") or {}),
        error=d.get("error"),
    )


def bootstrap_result_to_dict(br: BootstrapResult) -> dict[str, Any]:
    return {
        "ok": br.ok,
        "result": br.result,
        "last_url": br.last_url,
        "flow_ref": br.flow_ref,
        "state_summary": dict(br.state_summary),
        "error": br.error,
    }


@dataclass
class CurrentAnchorState:
    raw_url: str
    url_norm: str
    anchor_depth: int
    """``anchor_ok_actions``（与 strict 语义一致）：已成功消费的成功步计数，resume 后经 ``anchor_ok_baseline_*`` 注入。"""
    anchor_ok_actions: int = 0
    """strict 路径断点：`during_phase_a` 仍在阶段 A；`post_phase_a` 已结束阶段 A（未跑或未跑完 composite 种子与 late intent）；`post_intent_late` 已到阶段 B。"""
    strict_resume_phase: str = "during_phase_a"
    action_queue: list[ActionTask] = field(default_factory=list)


@dataclass
class SessionPayload:
    """内存态 ↔ session_state.json。"""

    session_id: str
    run_id: str
    entry_url: str
    status: Literal["running", "paused", "completed", "failed"] = "running"
    status_reason: str = ""
    config_snapshot: dict[str, Any] = field(default_factory=dict)
    start_context: StartContext = field(default_factory=StartContext)
    bootstrap_result: BootstrapResult | None = None
    bootstrap_flow_ref: str | None = None  # 兼容产物路径别名；优先用 bootstrap_result.flow_ref
    pending_urls: list[UrlTask] = field(default_factory=list)
    """URL 队列剩余项（不含当前正在探索的锚点）。"""
    active_url_task: UrlTask | None = None
    """当前正在探索的锚点（若崩溃于锚点中途，恢复时插回队首）。"""
    seen_anchor_urls: list[str] = field(default_factory=list)
    seen_structural_state_ids: list[str] = field(default_factory=list)
    """已探索锚点的页面 structural_state_id 集合，用于「不同 URL/同页面」的内容指纹去重。"""
    dedupe: DedupeStore = field(default_factory=DedupeStore)
    stats: dict[str, Any] = field(default_factory=dict)
    current_anchor: CurrentAnchorState | None = None
    last_success_event_id: str | None = None
    last_error: str | None = None
    replay_bootstrap_done: bool = False
    explorer_seq_cursor: int = 0
    """RecursiveExplorer._seq 快照，resume 后事件 id 单调延续。"""
    updated_at: str = ""

    def touch(self) -> None:
        self.updated_at = _iso_now()


def session_payload_to_doc(payload: SessionPayload) -> dict[str, Any]:
    doc: dict[str, Any] = {
        "schema": SESSION_SCHEMA,
        "session_id": payload.session_id,
        "run_id": payload.run_id,
        "entry_url": payload.entry_url,
        "status": payload.status,
        "status_reason": payload.status_reason,
        "config_snapshot": dict(payload.config_snapshot),
        "start_context": start_context_to_dict(payload.start_context),
        "bootstrap": (
            bootstrap_result_to_dict(payload.bootstrap_result)
            if payload.bootstrap_result
            else {"ok": False, "result": "skipped", "last_url": "", "flow_ref": payload.bootstrap_flow_ref}
        ),
        "bootstrap_flow_ref": payload.bootstrap_flow_ref,
        "pending_urls": [url_task_to_dict(u) for u in payload.pending_urls],
        "active_url_task": url_task_to_dict(payload.active_url_task) if payload.active_url_task else None,
        "seen_anchor_urls": list(payload.seen_anchor_urls),
        "seen_structural_state_ids": list(payload.seen_structural_state_ids),
        "dedupe": dedupe_to_serial(payload.dedupe),
        "stats": dict(payload.stats),
        "current_anchor": None,
        "last_success_event_id": payload.last_success_event_id,
        "last_error": payload.last_error,
        "replay_bootstrap_done": payload.replay_bootstrap_done,
        "explorer_seq_cursor": int(payload.explorer_seq_cursor or 0),
        "updated_at": payload.updated_at or _iso_now(),
    }
    if payload.current_anchor:
        doc["current_anchor"] = {
            "raw_url": payload.current_anchor.raw_url,
            "url_norm": payload.current_anchor.url_norm,
            "anchor_depth": payload.current_anchor.anchor_depth,
            "anchor_ok_actions": int(payload.current_anchor.anchor_ok_actions or 0),
            "strict_resume_phase": payload.current_anchor.strict_resume_phase or "during_phase_a",
            "action_queue": [action_task_to_dict(t) for t in payload.current_anchor.action_queue],
        }
    return doc


def doc_to_session_payload(doc: dict[str, Any]) -> SessionPayload:
    if doc.get("schema") != SESSION_SCHEMA:
        raise ValueError(f"unsupported session schema: {doc.get('schema')}")
    ca_raw = doc.get("current_anchor")
    current: CurrentAnchorState | None = None
    if isinstance(ca_raw, dict) and ca_raw.get("raw_url"):
        current = CurrentAnchorState(
            raw_url=str(ca_raw["raw_url"]),
            url_norm=str(ca_raw["url_norm"]),
            anchor_depth=int(ca_raw.get("anchor_depth") or 0),
            anchor_ok_actions=int(ca_raw.get("anchor_ok_actions") or 0),
            strict_resume_phase=str(ca_raw.get("strict_resume_phase") or "during_phase_a"),
            action_queue=[action_task_from_dict(x) for x in (ca_raw.get("action_queue") or [])],
        )
    br_raw = doc.get("bootstrap") or {}
    br = bootstrap_result_from_dict(br_raw) if br_raw else None
    return SessionPayload(
        session_id=str(doc["session_id"]),
        run_id=str(doc["run_id"]),
        entry_url=str(doc["entry_url"]),
        status=doc.get("status") or "paused",
        status_reason=str(doc.get("status_reason") or ""),
        config_snapshot=dict(doc.get("config_snapshot") or {}),
        start_context=start_context_from_dict(doc.get("start_context") or {}),
        bootstrap_result=br,
        bootstrap_flow_ref=doc.get("bootstrap_flow_ref"),
        pending_urls=[url_task_from_dict(x) for x in (doc.get("pending_urls") or [])],
        active_url_task=(
            url_task_from_dict(doc["active_url_task"])
            if doc.get("active_url_task")
            else None
        ),
        seen_anchor_urls=list(doc.get("seen_anchor_urls") or []),
        seen_structural_state_ids=list(doc.get("seen_structural_state_ids") or []),
        dedupe=dedupe_from_serial(doc.get("dedupe") or {}),
        stats=dict(doc.get("stats") or {}),
        current_anchor=current,
        last_success_event_id=doc.get("last_success_event_id"),
        last_error=doc.get("last_error"),
        replay_bootstrap_done=bool(doc.get("replay_bootstrap_done")),
        explorer_seq_cursor=int(doc.get("explorer_seq_cursor") or 0),
        updated_at=str(doc.get("updated_at") or ""),
    )


def write_session_state(path: Path, payload: SessionPayload) -> Path:
    payload.touch()
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(session_payload_to_doc(payload), ensure_ascii=False, indent=2), encoding="utf-8")
    return path


def read_session_state(path: Path) -> SessionPayload:
    raw = json.loads(Path(path).read_text(encoding="utf-8"))
    return doc_to_session_payload(raw)


def pending_to_deque(urls: list[UrlTask]) -> deque[UrlTask]:
    return deque(urls)


def restore_action_deque(tasks: list[ActionTask]) -> deque[ActionTask]:
    return deque(tasks)
