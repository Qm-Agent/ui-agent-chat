from __future__ import annotations

from pathlib import Path
from typing import Any

from recursive_exploration.config import ExplorationRunConfig


def _count_jsonl_lines(p: Path) -> int:
    if not p.exists():
        return 0
    with p.open(encoding="utf-8") as f:
        return sum(1 for line in f if line.strip())


def write_exploration_report(
    path: Path,
    *,
    config: ExplorationRunConfig,
    entry_url: str,
    run_id: str,
    stats: dict[str, Any],
    audit_paths: dict[str, Path] | None = None,
) -> Path:
    lines = [
        "# 递归探索报告",
        "",
        "## 配置",
        "",
        f"- `run_id`: `{run_id}`",
        f"- `entry_url`: `{entry_url}`",
        f"- `exploration_depth`: {config.exploration_depth}",
        f"- `execution_mode`: {config.execution_mode.value}",
        f"- `yaml_policy`: {config.yaml_policy}",
        f"- `generated_cases_filename_mode`: {config.generated_cases_filename_mode}",
        f"- `generated_cases_include_anchor_step_seq`: {config.generated_cases_include_anchor_step_seq}",
        f"- `max_actions` / `max_total_actions` / `max_new_urls`: {config.max_actions} / {config.max_total_actions} / {config.max_new_urls}",
        f"- `composite_checkpoint_every_single_successes`: {config.composite_checkpoint_every_single_successes}（0=关闭检查点，仅保留队列空时的组合 boost）",
        f"- `composite_enabled` / `graph_guided_composite_enabled` / `incremental_composite_mode`: "
        f"{config.composite_enabled} / {config.graph_guided_composite_enabled} / {config.incremental_composite_mode}",
        f"- `strict_phase_traversal`: {config.strict_phase_traversal}",
        f"- `intent_missions_enabled` / `intent_mission_max_per_anchor` / `intent_mission_phase` / `intent_mission_suppress_dom_expand`: "
        f"{config.intent_missions_enabled} / {config.intent_mission_max_per_anchor} / {config.intent_mission_phase} / {config.intent_mission_suppress_dom_expand}",
        f"- `prior_graph_path`: `{config.prior_graph_path or '(none)'}`",
        f"- `scroll_enabled` / `scroll_max_per_anchor`: {config.scroll_enabled} / {config.scroll_max_per_anchor}",
        "",
        "## 统计",
        "",
    ]
    for k, v in sorted(stats.items()):
        lines.append(f"- `{k}`: {v}")
    if audit_paths:
        lines.extend(["", "## 审计产物", ""])
        for label, p in sorted(audit_paths.items(), key=lambda x: x[0]):
            n = _count_jsonl_lines(p) if p.suffix == ".jsonl" else 0
            if p.suffix == ".jsonl":
                lines.append(f"- **`{label}`** (`{p}`): {n} 行")
            else:
                exists = "存在" if p.exists() else "尚未生成"
                lines.append(f"- **`{label}`** (`{p}`): {exists}")
        lines.append("")
        lines.append(
            "说明：`queues.jsonl` 记录动作/URL 队列的入队、出队与跳过；"
            "`enumerations.jsonl` 记录每轮用于入队决策的可点元素枚举；"
            "`events.jsonl` 与 `graph.json` 中的边可对照 `task_id` / `queue_seq` 对齐审计。"
        )
    lines.extend(
        [
            "",
            "## 可选：批量执行生成的 YAML",
            "",
            "若 `generated_cases/` 下存在 YAML，可按技能包 `references/exploration_mode_guide.md`「五、与任务模式衔接」对每文件执行 `python -m browser_use.cli --task-file …`；本脚本不自动回写 CLI 结果到图谱。",
            "",
        ]
    )
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("\n".join(lines), encoding="utf-8")
    return path
