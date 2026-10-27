"""阶梯多模态：默认文本；连续失败或归因不清时建议启用 vision。"""

from __future__ import annotations

from recursive_exploration.yaml_repair.assertions import unclear_attribution_snippet
from recursive_exploration.yaml_repair.config import YamlRepairConfig


def should_attach_vision(
    *,
    consecutive_failures: int,
    stderr_text: str,
    cfg: YamlRepairConfig,
) -> bool:
    if consecutive_failures >= cfg.consecutive_failures_for_vision:
        return True
    return unclear_attribution_snippet(stderr_text, cfg.vision_hint_unclear_regex)
