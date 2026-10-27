"""从 graph.json 提炼业务骨架（规则启发式）。"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from graph_retrieval.store import RunBundle


@dataclass
class BusinessSkeleton:
    navigation_paths: list[str] = field(default_factory=list)
    """主导航链路边标签摘要。"""
    search_list_detail: list[str] = field(default_factory=list)
    """检索/列表/详情线索。"""
    crud_paths: list[str] = field(default_factory=list)
    """创建/编辑/提交线索。"""
    anomaly_hints: list[str] = field(default_factory=list)
    """错误/校验可见线索。"""
    bootstrap_hint: str = ""
    """来自 run_meta.start_context 的简要提示。"""


class BusinessFlowMiner:
    def __init__(self, bundle: RunBundle) -> None:
        self.bundle = bundle

    def mine(self) -> BusinessSkeleton:
        sk = BusinessSkeleton()
        meta = (self.bundle.graph or {}).get("run_meta") or {}
        sc = meta.get("start_context") or {}
        sk.bootstrap_hint = f"start_kind={sc.get('start_kind')!s},bootstrap_used={sc.get('bootstrap_used')!s}"
        edges = list((self.bundle.graph or {}).get("edges") or [])
        for e in edges[:400]:
            tag = str(e.get("action_tag") or "unknown")
            summary = str((e.get("prefix_steps_summary") or [])[:2])
            line = f"{tag}:{summary}"
            if tag == "nav":
                sk.navigation_paths.append(line)
            elif tag == "search":
                sk.search_list_detail.append(line)
            elif tag in ("create", "submit", "open_detail"):
                sk.crud_paths.append(line)
            elif tag == "unknown":
                sk.anomaly_hints.append(line)
        return sk
