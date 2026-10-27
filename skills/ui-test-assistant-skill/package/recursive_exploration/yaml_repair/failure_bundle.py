"""失败时可观测摘要（限制体积）。"""

from __future__ import annotations

from dataclasses import dataclass, field


@dataclass
class FailureBundle:
    returncode: int
    stderr_snippet: str
    stdout_snippet: str
    log_dir_hint: str = ""
    vision_enabled: bool = False
    screenshot_paths: list[str] = field(default_factory=list)
    extra_text: str = ""

    def to_prompt_block(self, max_chars: int) -> str:
        parts = [
            f"returncode={self.returncode}",
            "--- stderr ---",
            self.stderr_snippet[: max_chars // 2],
            "--- stdout ---",
            self.stdout_snippet[: max_chars // 2],
        ]
        if self.extra_text:
            parts.extend(["--- extra ---", self.extra_text[:800]])
        if self.screenshot_paths:
            parts.append("screenshots: " + ", ".join(self.screenshot_paths[:5]))
        text = "\n".join(parts)
        return text[:max_chars]


def clip(text: str, n: int) -> str:
    t = text or ""
    if len(t) <= n:
        return t
    return t[: n - 20] + "\n...[truncated]..."
