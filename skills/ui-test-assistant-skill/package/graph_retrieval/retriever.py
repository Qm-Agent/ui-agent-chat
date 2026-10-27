from __future__ import annotations

import re
from typing import Any, Iterable

from graph_retrieval.store import RunBundle, load_run_bundle


def _norm_text(s: str) -> str:
    return re.sub(r"\s+", " ", (s or "").strip()).lower()


class GraphRetriever:
    """基于 graph.indexes 的规则检索（无向量）。"""

    def __init__(self, bundle: RunBundle) -> None:
        self.bundle = bundle
        g = bundle.graph or {}
        self._nodes: dict[str, dict[str, Any]] = {n["node_id"]: n for n in g.get("nodes") or []}
        self._edges: dict[str, dict[str, Any]] = {e["edge_id"]: e for e in g.get("edges") or []}
        self._idx: dict[str, Any] = dict(g.get("indexes") or {})

    @classmethod
    def from_dir(cls, out_dir: str | Any) -> GraphRetriever:
        return cls(load_run_bundle(out_dir))

    def find_nodes_by_url_or_title(self, *, url_norm: str = "", title_substr: str = "") -> list[str]:
        """返回 node_id 列表。"""
        out: list[str] = []
        by_url = self._idx.get("by_url") or {}
        if url_norm:
            out.extend(by_url.get(url_norm, []))
        tsub = _norm_text(title_substr)
        if tsub:
            for nid, n in self._nodes.items():
                title = _norm_text(str(n.get("title") or ""))
                if tsub in title and nid not in out:
                    out.append(nid)
        return out

    def find_actions_for_node(self, node_id: str, *, limit: int = 50) -> list[dict[str, Any]]:
        """从某节点出发的边（动作）摘要。"""
        eids = list((self._idx.get("edges_from") or {}).get(node_id) or [])
        rows: list[dict[str, Any]] = []
        for eid in eids[:limit]:
            e = self._edges.get(eid)
            if not e:
                continue
            rows.append(
                {
                    "edge_id": eid,
                    "to_node_id": e.get("to_node_id"),
                    "action_fingerprint": e.get("action_fingerprint"),
                    "action_tag": e.get("action_tag") or "",
                    "dedupe_path_key": e.get("dedupe_path_key"),
                    "url_changed": e.get("url_changed"),
                }
            )
        return rows

    def find_candidate_paths(
        self,
        start_node_id: str,
        *,
        max_depth: int = 4,
        max_paths: int = 20,
    ) -> list[list[str]]:
        """浅层路径枚举（node_id 链，含起点）。"""
        paths: list[list[str]] = []

        def dfs(cur: str, depth: int, chain: list[str]) -> None:
            if len(paths) >= max_paths:
                return
            if depth > max_depth:
                return
            nxt_ids = list((self._idx.get("edges_from") or {}).get(cur) or [])
            if not nxt_ids:
                if len(chain) > 1:
                    paths.append(list(chain))
                return
            for eid in nxt_ids:
                e = self._edges.get(eid)
                if not e:
                    continue
                tn = str(e.get("to_node_id") or "")
                if not tn or tn in chain:
                    continue
                chain2 = chain + [tn]
                dfs(tn, depth + 1, chain2)

        dfs(start_node_id, 0, [start_node_id])
        return paths[:max_paths]

    def find_similar_nodes(self, reference_node_id: str, *, limit: int = 8) -> list[str]:
        """同 URL 不同 page_state 的节点（规则「相似」）。"""
        ref = self._nodes.get(reference_node_id)
        if not ref:
            return []
        url = ref.get("url_norm")
        if not url:
            return []
        cand = list((self._idx.get("by_url") or {}).get(url) or [])
        out = [nid for nid in cand if nid != reference_node_id]
        return out[:limit]
