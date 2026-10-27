from __future__ import annotations

import json
from dataclasses import asdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from recursive_exploration.models import GraphEdgeRecord, GraphKind, GraphNodeRecord


GRAPH_SCHEMA_VERSION = 2


def _now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def _empty_indexes() -> dict[str, Any]:
    return {
        "by_url": {},
        "by_structural_state_id": {},
        "by_page_state_id": {},
        "by_action_fingerprint": {},
        "edges_from": {},
        "edges_to": {},
        "cross_page_edge_ids": [],
        "entry_node_ids": [],
        "shortcuts": {},
    }


def rebuild_indexes(nodes: list[dict[str, Any]], edges: list[dict[str, Any]]) -> dict[str, Any]:
    idx = _empty_indexes()
    for n in nodes:
        nid = n["node_id"]
        url = n["url_norm"]
        sid = n["structural_state_id"]
        pid = n["page_state_id"]
        idx["by_url"].setdefault(url, []).append(nid)
        idx["by_structural_state_id"].setdefault(sid, []).append(nid)
        idx["by_page_state_id"].setdefault(pid, []).append(nid)
    for e in edges:
        eid = e["edge_id"]
        fid = e["from_node_id"]
        tid = e["to_node_id"]
        afp = e["action_fingerprint"]
        idx["edges_from"].setdefault(fid, []).append(eid)
        idx["edges_to"].setdefault(tid, []).append(eid)
        idx["by_action_fingerprint"].setdefault(afp, []).append(eid)
        if e.get("url_changed"):
            idx["cross_page_edge_ids"].append(eid)
    return idx


class GraphStore:
    """Run 级图谱：追加事件、upsert 节点/边、重写 graph.json。"""

    def __init__(
        self,
        out_dir: Path,
        *,
        site_key: str,
        run_id: str,
        graph_kind: GraphKind = "run",
    ) -> None:
        self.out_dir = Path(out_dir)
        self.site_key = site_key
        self.run_id = run_id
        self.graph_kind: GraphKind = graph_kind
        self.events_path = self.out_dir / "events.jsonl"
        self.graph_path = self.out_dir / "graph.json"
        self.prefix_dir = self.out_dir / "prefix_steps"
        self.shot_dir = self.out_dir / "assets" / "screenshots"
        self.prefix_dir.mkdir(parents=True, exist_ok=True)
        self.shot_dir.mkdir(parents=True, exist_ok=True)

        self.queues_path = self.out_dir / "queues.jsonl"
        self.enumerations_path = self.out_dir / "enumerations.jsonl"
        self._queue_seq = 0
        self._enum_seq = 0

        self.nodes: dict[str, dict[str, Any]] = {}
        self.edges: dict[str, dict[str, Any]] = {}
        self._entry_nodes: set[str] = set()

    def hydrate_from_existing_graph(self) -> None:
        """若 graph.json 已存在则载入节点/边与入口索引（resume 续写同一 run）。"""
        if not self.graph_path.is_file():
            return
        try:
            doc = json.loads(self.graph_path.read_text(encoding="utf-8"))
        except Exception:
            return
        for n in doc.get("nodes") or []:
            nid = n.get("node_id")
            if nid:
                self.nodes[str(nid)] = dict(n)
        for e in doc.get("edges") or []:
            eid = e.get("edge_id")
            if eid:
                self.edges[str(eid)] = dict(e)
        idx = doc.get("indexes") or {}
        for nid in idx.get("entry_node_ids") or []:
            self._entry_nodes.add(str(nid))

    def restore_sequences_from_audit(self) -> None:
        """从 queues.jsonl / enumerations.jsonl 恢复单调 seq，避免 resume 时序号回卷。"""
        for path_attr, attr in (("queues_path", "_queue_seq"), ("enumerations_path", "_enum_seq")):
            p = getattr(self, path_attr)
            if not p.is_file():
                continue
            last_line = ""
            try:
                for line in p.open(encoding="utf-8"):
                    s = line.strip()
                    if s:
                        last_line = s
            except OSError:
                continue
            if not last_line:
                continue
            try:
                obj = json.loads(last_line)
                seq = int(obj.get("seq") or 0)
                setattr(self, attr, seq)
            except Exception:
                pass

    def register_entry_node(self, node_id: str) -> None:
        self._entry_nodes.add(node_id)

    def append_event(self, obj: dict[str, Any]) -> None:
        self.out_dir.mkdir(parents=True, exist_ok=True)
        line = json.dumps(obj, ensure_ascii=False)
        with self.events_path.open("a", encoding="utf-8") as f:
            f.write(line + "\n")

    def append_queue(self, event_type: str, payload: dict[str, Any]) -> int:
        """追加队列轨迹事件，返回单调 seq。"""
        self.out_dir.mkdir(parents=True, exist_ok=True)
        self._queue_seq += 1
        obj: dict[str, Any] = {
            "schema": "exploration-queue/v1",
            "seq": self._queue_seq,
            "run_id": self.run_id,
            "ts": _now_iso(),
            "type": event_type,
            **payload,
        }
        with self.queues_path.open("a", encoding="utf-8") as f:
            f.write(json.dumps(obj, ensure_ascii=False) + "\n")
        return self._queue_seq

    def append_enumeration(
        self,
        *,
        anchor_url_norm: str,
        anchor_depth: int,
        page_state_id: str,
        source: str,
        viewport_filter: str,
        candidates: list[dict[str, Any]],
    ) -> str:
        """追加一轮 DOM 枚举审计，返回 round_id。"""
        self.out_dir.mkdir(parents=True, exist_ok=True)
        self._enum_seq += 1
        round_id = f"r_{self._enum_seq}"
        obj: dict[str, Any] = {
            "schema": "exploration-enumeration/v1",
            "seq": self._enum_seq,
            "round_id": round_id,
            "run_id": self.run_id,
            "ts": _now_iso(),
            "anchor_url_norm": anchor_url_norm,
            "anchor_depth": anchor_depth,
            "page_state_id": page_state_id,
            "source": source,
            "viewport_filter": viewport_filter,
            "candidates": candidates,
        }
        with self.enumerations_path.open("a", encoding="utf-8") as f:
            f.write(json.dumps(obj, ensure_ascii=False) + "\n")
        return round_id

    def upsert_node(self, rec: GraphNodeRecord) -> None:
        now = _now_iso()
        existing = self.nodes.get(rec.node_id)
        if existing:
            existing["last_seen_at"] = now
            for rid in rec.seen_run_ids:
                if rid not in existing["seen_run_ids"]:
                    existing["seen_run_ids"].append(rid)
            self.nodes[rec.node_id] = existing
        else:
            d = asdict(rec)
            d["first_seen_at"] = d.get("first_seen_at") or now
            d["last_seen_at"] = now
            self.nodes[rec.node_id] = d

    def upsert_edge(self, rec: GraphEdgeRecord) -> None:
        self.edges[rec.edge_id] = asdict(rec)

    def write_graph(self, run_meta: dict[str, Any]) -> Path:
        nodes_list = list(self.nodes.values())
        edges_list = list(self.edges.values())
        idx = rebuild_indexes(nodes_list, edges_list)
        idx["entry_node_ids"] = sorted(self._entry_nodes)
        doc = {
            "schema_version": GRAPH_SCHEMA_VERSION,
            "site_key": self.site_key,
            "graph_kind": self.graph_kind,
            "run_meta": {
                **run_meta,
                "run_id": self.run_id,
                "artifact_schema": "exploration-v2",
                "graph_schema_version": GRAPH_SCHEMA_VERSION,
            },
            "nodes": sorted(nodes_list, key=lambda x: x["node_id"]),
            "edges": sorted(edges_list, key=lambda x: x["edge_id"]),
            "indexes": idx,
        }
        self.graph_path.write_text(json.dumps(doc, ensure_ascii=False, indent=2), encoding="utf-8")
        return self.graph_path

    def prefix_sidecar_path(self, edge_id: str) -> Path:
        return self.prefix_dir / f"{edge_id}.json"

    def maybe_write_prefix_sidecar(self, edge_id: str, steps: list[dict[str, Any]]) -> str | None:
        raw = json.dumps(steps, ensure_ascii=False)
        if len(raw) <= 512 and len(steps) <= 3:
            return None
        p = self.prefix_sidecar_path(edge_id)
        p.write_text(raw, encoding="utf-8")
        try:
            return str(p.relative_to(self.out_dir))
        except ValueError:
            return str(p)


def merge_site_graphs(
    site_key: str,
    run_graph_paths: list[Path],
    output_path: Path,
    *,
    merge_strategy_note: str = "node_merge_key=node_id; edge_merge_key=(from_node_id,action_fingerprint,to_node_id)",
) -> Path:
    """合并多份 run 级 graph.json → site_merged（溯源 merged_from）。"""
    merged_nodes: dict[str, dict[str, Any]] = {}
    merged_edges: dict[str, dict[str, Any]] = {}
    edge_key_to_canonical_id: dict[tuple[str, str, str], str] = {}

    max_schema = GRAPH_SCHEMA_VERSION
    for gp in run_graph_paths:
        data = json.loads(Path(gp).read_text(encoding="utf-8"))
        try:
            max_schema = max(max_schema, int(data.get("schema_version") or 0))
        except (TypeError, ValueError):
            pass
        run_id = (data.get("run_meta") or {}).get("run_id", "")
        for n in data.get("nodes", []):
            nid = n["node_id"]
            prev = merged_nodes.get(nid)
            if not prev:
                n2 = dict(n)
                if run_id and run_id not in n2.get("seen_run_ids", []):
                    n2.setdefault("seen_run_ids", []).append(run_id)
                merged_nodes[nid] = n2
            else:
                prev["last_seen_at"] = max(prev.get("last_seen_at", ""), n.get("last_seen_at", ""))
                for rid in n.get("seen_run_ids", []) or []:
                    if rid not in prev["seen_run_ids"]:
                        prev["seen_run_ids"].append(rid)
                if run_id and run_id not in prev["seen_run_ids"]:
                    prev["seen_run_ids"].append(run_id)
        for e in data.get("edges", []):
            src = dict(e)
            eid = src["edge_id"]
            key = (src["from_node_id"], src["action_fingerprint"], src["to_node_id"])
            mf_entry = {"run_id": run_id, "edge_id": eid}
            canon = edge_key_to_canonical_id.get(key)
            if canon is None:
                new_id = f"m_{src['edge_id']}"
                src["edge_id"] = new_id
                src["merged_from"] = [mf_entry]
                merged_edges[new_id] = src
                edge_key_to_canonical_id[key] = new_id
            else:
                ex = merged_edges[canon]
                ex.setdefault("merged_from", []).append(mf_entry)

    nodes_list = list(merged_nodes.values())
    edges_list = list(merged_edges.values())
    idx = rebuild_indexes(nodes_list, edges_list)
    doc = {
        "schema_version": max_schema,
        "site_key": site_key,
        "graph_kind": "site_merged",
        "run_meta": {
            "merged_at": _now_iso(),
            "source_graphs": [str(p) for p in run_graph_paths],
            "merge_strategy_note": merge_strategy_note,
            "artifact_schema": "exploration-v2",
            "graph_schema_version": max_schema,
        },
        "nodes": sorted(nodes_list, key=lambda x: x["node_id"]),
        "edges": sorted(edges_list, key=lambda x: x["edge_id"]),
        "indexes": idx,
    }
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(doc, ensure_ascii=False, indent=2), encoding="utf-8")
    return output_path
