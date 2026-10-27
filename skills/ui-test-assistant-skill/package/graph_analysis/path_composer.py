"""多段路径拼装：输出 YAML 草案串与兼容性告警。"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from graph_retrieval.retriever import GraphRetriever
from graph_retrieval.store import RunBundle, load_run_bundle


@dataclass
class ComposedPath:
    steps_outline: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)


def compose_paths(bundle: RunBundle | str, segments: list[list[str]]) -> ComposedPath:
    """segments 为多条 node_id 链；拼接为单一流程大纲。"""
    b = bundle if isinstance(bundle, RunBundle) else load_run_bundle(bundle)
    retriever = GraphRetriever(b)
    out = ComposedPath()
    flat: list[str] = []
    for seg in segments:
        if seg:
            flat.extend(seg)
    seen: set[str] = set()
    for nid in flat:
        if nid in seen:
            out.warnings.append(f"duplicate_node:{nid}")
        seen.add(nid)
    for i in range(len(flat) - 1):
        a, c = flat[i], flat[i + 1]
        edges_a = retriever.find_actions_for_node(a, limit=80)
        ok = any(str(e.get("to_node_id")) == c for e in edges_a)
        if not ok:
            out.warnings.append(f"gap:{a}->{c}")
        out.steps_outline.append(f"{a}->{c}")
    return out


class PathComposer:
    def __init__(self, exploration_out_dir: str | Any) -> None:
        self.bundle = load_run_bundle(exploration_out_dir)

    def compose(self, segments: list[list[str]]) -> ComposedPath:
        return compose_paths(self.bundle, segments)
