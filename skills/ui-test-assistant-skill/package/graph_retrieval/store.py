from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any


@dataclass
class RunBundle:
    """单次探索目录内核心只读视图。"""

    out_dir: Path
    graph: dict[str, Any] | None = None
    session: dict[str, Any] | None = None
    session_path: Path | None = None
    graph_path: Path | None = None


def load_run_bundle(out_dir: Path | str) -> RunBundle:
    """加载 graph.json + session_state.json（若存在）。旧 run 可无 session。"""
    root = Path(out_dir).expanduser()
    gp = root / "graph.json"
    sp = root / "session_state.json"
    graph_doc: dict[str, Any] | None = None
    session_doc: dict[str, Any] | None = None
    if gp.is_file():
        graph_doc = json.loads(gp.read_text(encoding="utf-8"))
    if sp.is_file():
        session_doc = json.loads(sp.read_text(encoding="utf-8"))
    return RunBundle(
        out_dir=root,
        graph=graph_doc,
        session=session_doc,
        session_path=sp if sp.is_file() else None,
        graph_path=gp if gp.is_file() else None,
    )


def graph_run_meta(bundle: RunBundle) -> dict[str, Any]:
    if not bundle.graph:
        return {}
    return dict(bundle.graph.get("run_meta") or {})
