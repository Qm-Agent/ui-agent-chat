"""
图谱增强任务生成协议（概要）：
- **模糊说明**：用户提供目标描述 → `GraphRetriever` 检索节点/边 → LLM 或模板拼装 `tasks[].flow`。
- **部分 YAML**：已有 YAML 缺少步骤 → 按 anchor URL / title 对齐图谱边，补齐缺口步骤。
- **缺步 YAML**：flow 中存在占位「…」或与图谱 dedupe_path 不一致 → 从候选路径裁剪可得的最短前缀。

实现为轻量占位：传入 bundle 与用户文本，输出结构化草案（便于后续接入 LLM）。
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from graph_retrieval.retriever import GraphRetriever
from graph_retrieval.store import load_run_bundle


@dataclass
class AugmentedYamlDraft:
    target_url: str = ""
    suggested_flow_steps: list[str] = field(default_factory=list)
    evidence_node_ids: list[str] = field(default_factory=list)
    notes: str = ""


class GraphAugmentedPlanner:
    def __init__(self, exploration_out_dir: Path | str) -> None:
        self.bundle = load_run_bundle(exploration_out_dir)
        self.retriever = GraphRetriever(self.bundle)

    def plan_from_text(self, user_text: str, *, seed_url_norm: str = "") -> AugmentedYamlDraft:
        """规则检索 + 占位草案（不接 LLM 亦可回归测试）。"""
        meta = (self.bundle.graph or {}).get("run_meta") or {}
        entry = str(meta.get("entry_url") or "")
        seeds = self.retriever.find_nodes_by_url_or_title(url_norm=seed_url_norm or "")
        draft = AugmentedYamlDraft(target_url=entry, evidence_node_ids=seeds[:10])
        if seeds:
            actions = self.retriever.find_actions_for_node(seeds[0], limit=12)
            draft.suggested_flow_steps = [
                f"# edge {a.get('edge_id')} tag={a.get('action_tag')}" for a in actions[:8]
            ]
        draft.notes = f"user_goal={user_text[:200]}"
        return draft
