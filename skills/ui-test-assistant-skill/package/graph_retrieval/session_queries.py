from __future__ import annotations

from typing import Any

from graph_retrieval.store import load_run_bundle


def load_session_summary(out_dir: Path | str) -> dict[str, Any]:
    """session_state.json 的高层摘要（无浏览器副作用）。"""
    b = load_run_bundle(out_dir)
    if not b.session:
        return {"available": False, "reason": "no_session_state.json"}
    s = b.session
    return {
        "available": True,
        "schema": s.get("schema"),
        "run_id": s.get("run_id"),
        "entry_url": s.get("entry_url"),
        "status": s.get("status"),
        "updated_at": s.get("updated_at"),
        "replay_bootstrap_done": s.get("replay_bootstrap_done"),
        "start_context": s.get("start_context"),
        "bootstrap": s.get("bootstrap"),
    }


def load_pending_work_summary(out_dir: Path | str) -> dict[str, Any]:
    """未完成 URL 队列与当前锚点任务计数。"""
    b = load_run_bundle(out_dir)
    if not b.session:
        return {"available": False, "pending_url_count": 0, "active_url_task": None}
    s = b.session
    pending = s.get("pending_urls") or []
    active = s.get("active_url_task")
    return {
        "available": True,
        "pending_url_count": len(pending),
        "active_url_task": active,
        "pending_urls_sample": pending[:10],
    }
