from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import Literal


class SkipReason(str, Enum):
    DEDUPE_ACTION = "dedupe_action"
    DEDUPE_PATH = "dedupe_path"
    DEDUPE_URL = "dedupe_url"
    BUDGET_ACTIONS = "budget_actions"
    BUDGET_URLS = "budget_urls"
    PREFIX_TOO_DEEP = "prefix_too_deep"
    REPLAY_FAILED = "replay_failed"


DedupeHit = Literal[
    "dedupe_action",
    "dedupe_path",
    "dedupe_url",
    "budget_actions",
    "budget_urls",
    "prefix_too_deep",
    "replay_failed",
]


@dataclass
class DedupeStore:
    """内存去重集；可序列化 keys 供报告。"""

    seen_action: set[str] = field(default_factory=set)
    seen_path: set[str] = field(default_factory=set)
    seen_url: set[str] = field(default_factory=set)
    hits: dict[str, int] = field(default_factory=dict)

    def note_hit(self, reason: DedupeHit) -> None:
        self.hits[reason] = self.hits.get(reason, 0) + 1

    def try_action(self, key: str) -> bool:
        if key in self.seen_action:
            self.note_hit(SkipReason.DEDUPE_ACTION)
            return False
        self.seen_action.add(key)
        return True

    def try_path(self, key: str) -> bool:
        if key in self.seen_path:
            self.note_hit(SkipReason.DEDUPE_PATH)
            return False
        self.seen_path.add(key)
        return True

    def try_url(self, key: str) -> bool:
        if key in self.seen_url:
            self.note_hit(SkipReason.DEDUPE_URL)
            return False
        self.seen_url.add(key)
        return True
