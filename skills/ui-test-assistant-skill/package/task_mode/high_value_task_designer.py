"""测试说明 + 图谱 → 高价值任务包草案（占位合成）。"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path

from graph_analysis.business_flow_miner import BusinessFlowMiner, BusinessSkeleton
from graph_retrieval.store import load_run_bundle


@dataclass
class HighValueTaskPack:
    """评审友好结构化草案（可序列化为 JSON）。"""

    title: str = ""
    primary_paths: list[str] = field(default_factory=list)
    boundary_paths: list[str] = field(default_factory=list)
    prerequisites: list[str] = field(default_factory=list)
    skeleton: BusinessSkeleton | None = None


class HighValueTaskDesigner:
    def __init__(self, exploration_out_dir: Path | str) -> None:
        self.out_dir = Path(exploration_out_dir)
        self.bundle = load_run_bundle(self.out_dir)

    def design(self, test_intent: str) -> HighValueTaskPack:
        miner = BusinessFlowMiner(self.bundle)
        sk = miner.mine()
        pack = HighValueTaskPack(
            title=test_intent[:120],
            skeleton=sk,
            primary_paths=list(sk.navigation_paths[:5]),
            boundary_paths=list(sk.anomaly_hints[:5]),
            prerequisites=[sk.bootstrap_hint or "unknown_context"],
        )
        return pack
