"""基于 graph.json 的节点级最短路径（用于锚点导航失败时的前缀重放降级）。"""

from __future__ import annotations

import json
from collections import deque
from pathlib import Path
from typing import Any


def shortest_edge_path_between_urls(
    *,
    nodes_by_id: dict[str, dict[str, Any]],
    edges_by_id: dict[str, dict[str, Any]],
    from_url_norm: str,
    to_url_norm: str,
) -> list[dict[str, Any]] | None:
    """
    在已有节点/边上做 BFS，求从任一 from_url_norm 节点到任一 to_url_norm 节点的最少边序列。
    边为有向边 from_node_id -> to_node_id；仅使用 result 为 ok 或缺省且非 skipped 的边。
    """
    start_ids = [nid for nid, n in nodes_by_id.items() if (n.get("url_norm") or "") == from_url_norm]
    goal_ids = {nid for nid, n in nodes_by_id.items() if (n.get("url_norm") or "") == to_url_norm}
    if not start_ids or not goal_ids:
        return None

    adj: dict[str, list[tuple[str, dict[str, Any]]]] = {}
    for e in edges_by_id.values():
        res = str(e.get("result") or "ok")
        if res not in ("ok", ""):
            continue
        fid = str(e.get("from_node_id") or "")
        tid = str(e.get("to_node_id") or "")
        if not fid or not tid:
            continue
        adj.setdefault(fid, []).append((tid, dict(e)))

    q: deque[tuple[str, list[dict[str, Any]]]] = deque()
    visited: set[str] = set()
    for sid in start_ids:
        if sid in goal_ids:
            return []
        q.append((sid, []))
        visited.add(sid)
    while q:
        cur, path = q.popleft()
        for nxt, ed in adj.get(cur, []):
            npath = path + [ed]
            if nxt in goal_ids:
                return npath
            if nxt in visited:
                continue
            visited.add(nxt)
            q.append((nxt, npath))
    return None


def load_graph_doc(graph_path: Path) -> dict[str, Any] | None:
    if not graph_path.is_file():
        return None
    try:
        return json.loads(graph_path.read_text(encoding="utf-8"))
    except Exception:
        return None


def prefix_steps_payload_from_edge(edge: dict[str, Any], out_dir: Path) -> list[dict[str, Any]]:
    """从边或 prefix sidecar 解析与 explorer 写入格式一致的前缀步骤 JSON。"""
    ref = edge.get("prefix_steps_ref")
    if isinstance(ref, str) and ref.strip():
        p = out_dir / ref
        if p.is_file():
            try:
                raw = json.loads(p.read_text(encoding="utf-8"))
                if isinstance(raw, list):
                    return [dict(x) for x in raw if isinstance(x, dict)]
            except Exception:
                pass
    return []
