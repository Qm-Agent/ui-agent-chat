"""执行卡住时：按当前 URL / 图谱相似节点给出候选后继边（规则型）。"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from graph_retrieval.retriever import GraphRetriever
from graph_retrieval.store import load_run_bundle


@dataclass
class RecoveryHint:
    reference_nodes: list[str] = field(default_factory=list)
    candidate_edges: list[dict[str, Any]] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)


class GraphGuidedRecovery:
    def __init__(self, exploration_out_dir: Path | str) -> None:
        self.bundle = load_run_bundle(exploration_out_dir)
        self.retriever = GraphRetriever(self.bundle)

    def hints_for_page(self, *, url_norm: str, title_hint: str = "") -> RecoveryHint:
        nodes = self.retriever.find_nodes_by_url_or_title(url_norm=url_norm, title_substr=title_hint)
        hint = RecoveryHint(reference_nodes=nodes[:5])
        if not nodes:
            hint.warnings.append("no_matching_nodes")
            return hint
        nid = nodes[0]
        hint.candidate_edges = self.retriever.find_actions_for_node(nid, limit=15)
        sim = self.retriever.find_similar_nodes(nid, limit=6)
        if sim:
            hint.warnings.append(f"similar_states={sim}")
        return hint
