"""Markdown 结论报告。"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path


@dataclass
class RoundRecord:
    index: int
    execution_ok: bool
    vision_used: bool
    repair_note: str = ""
    validation_error: str = ""


@dataclass
class RepairReportModel:
    summary: str
    rounds: list[RoundRecord] = field(default_factory=list)
    assert_gate_note: str = ""
    deliver_kind: str = ""  # verified_success | last_attempt_unverified | aborted
    merged_from: str = ""
    user_prompts: list[str] = field(default_factory=list)


def render_report_md(m: RepairReportModel) -> str:
    lines = [
        "# YAML 修复自愈报告",
        "",
        "## 摘要",
        m.summary,
        "",
    ]
    if m.merged_from:
        lines.extend(["## 合并来源", m.merged_from, ""])
    if m.assert_gate_note:
        lines.extend(["## 断言与门禁", m.assert_gate_note, ""])
    lines.extend(["## 轮次", ""])
    for r in m.rounds:
        lines.append(f"### 第 {r.index} 轮")
        lines.append(f"- 执行成功: {'是' if r.execution_ok else '否'}")
        lines.append(f"- 阶梯 vision 提示: {'是' if r.vision_used else '否'}")
        if r.validation_error:
            lines.append(f"- 校验: {r.validation_error}")
        if r.repair_note:
            lines.append(f"- 备注: {r.repair_note}")
        lines.append("")
    lines.extend(
        [
            "## 交付说明",
            m.deliver_kind,
            "",
        ]
    )
    if m.user_prompts:
        lines.extend(["## 用户补充追问记录", ""])
        lines.extend(f"- {p}" for p in m.user_prompts)
        lines.append("")
    return "\n".join(lines)


def write_report(path: Path, m: RepairReportModel) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(render_report_md(m), encoding="utf-8")
