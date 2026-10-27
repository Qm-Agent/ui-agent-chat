"""修复自愈运行配置与环境变量映射。"""

from __future__ import annotations

import os
from dataclasses import dataclass, field


def _env_int(key: str, default: int) -> int:
    raw = (os.getenv(key) or "").strip()
    if not raw:
        return default
    try:
        return int(raw)
    except ValueError:
        return default


def _env_bool(key: str, default: bool) -> bool:
    raw = (os.getenv(key) or "").strip().lower()
    if not raw:
        return default
    return raw in ("1", "true", "yes", "on")


@dataclass
class YamlRepairConfig:
    """与 CLI / env 对齐的修复自愈配置。"""

    max_repair_iterations: int = 5
    """允许的总执行轮次上限（含首轮）。达到后停止。"""

    consecutive_failures_for_vision: int = 2
    """连续失败达到该次数后启用阶梯多模态（截图占位由执行层接入）。"""

    merge_bootstrap: bool = True
    """若入口文件同目录存在 bootstrap.yaml，则前置合并。"""

    expand_imports: bool = True
    """展开顶层 import + flow 内 use 为单文件。"""

    interactive_prompts: bool = True
    """信息不足时在终端同步追问（stdin）；False 时仅写入报告。"""

    headless: bool = True

    heuristic_login_wait: bool = True
    """失败后是否启用登录表单「账号密码登录表单」类 aiWaitFor 的启发式修补。"""

    heuristic_login_use_ai_wait_for: bool = True
    """为 True 时用 aiWaitFor（见 heuristic_login_wait_for_text），否则用短 sleep。"""

    heuristic_login_wait_for_text: str = "等待页面加载完成"
    """替换登录表单等待时的 aiWaitFor 文案（长跳转优于固定长 sleep）。"""

    heuristic_login_wait_sleep_ms: int = 1500
    """heuristic_login_use_ai_wait_for=False 时使用的 sleep 毫秒数（不宜过大）。"""

    heuristic_transient_assert: bool = True
    """断言失败时是否启用「瞬时 Toast / 创建成功」类断言删除与提交后 sleep→aiWaitFor。"""

    heuristic_post_submit_upgrade_sleep: bool = True
    """删除瞬时断言后，是否将「创建/提交」后的长 sleep 改为 aiWaitFor「等待页面加载完成」。"""

    heuristic_vague_wait_fallback: bool = True
    """aiWaitFor 已超时且等待目标为「弱页面特征」时，改为 sleep 或备用 aiWaitFor。"""

    heuristic_vague_wait_sleep_ms: int = 5000
    """弱特征 aiWaitFor 替换为 sleep 时的毫秒数。"""

    heuristic_vague_wait_prefer_sleep: bool = True
    """True：弱特征优先改为 sleep；False 时用 heuristic_vague_wait_alternate 文案。"""

    heuristic_vague_wait_alternate: str = ""
    """prefer_sleep=False 时使用的 aiWaitFor 替换文案（需与页面可观测文案一致）。"""

    cli_disable_browser_cache: bool = False
    """为 browser_use.cli 传入 ``cache.enabled=false``（关闭 L1+L2，不走缓存命中）。"""

    console_verbose: bool = True
    """是否在控制台打印每轮失败分析与众修复策略；``YR_REPAIR_QUIET=1`` 可关闭。"""

    python_exe: str | None = None
    """子进程 Python；默认当前解释器。"""

    dotenv_path: str | None = None
    """可选；设置后由调用方 export DOTENV_PATH。"""

    max_log_chars: int = 12000
    failure_preview_chars: int = 8000

    vision_hint_unclear_regex: tuple[str, ...] = field(
        default_factory=lambda: (
            r"timeout",
            r"timed out",
            r"找不到",
            r"not found",
            r"No such element",
            r"selector",
        )
    )

    @classmethod
    def from_env(cls) -> YamlRepairConfig:
        return cls(
            max_repair_iterations=max(1, _env_int("YR_MAX_ITERATIONS", _env_int("YAML_REPAIR_MAX_ITERATIONS", 5))),
            consecutive_failures_for_vision=max(1, _env_int("YR_VISION_AFTER_FAILURES", 2)),
            merge_bootstrap=_env_bool("YR_MERGE_BOOTSTRAP", True),
            expand_imports=_env_bool("YR_EXPAND_IMPORTS", True),
            interactive_prompts=_env_bool("YR_INTERACTIVE", True),
            headless=_env_bool("YR_HEADLESS", True),
            heuristic_login_wait=_env_bool("YR_HEURISTIC_LOGIN_WAIT", True),
            heuristic_login_use_ai_wait_for=_env_bool("YR_HEURISTIC_LOGIN_USE_WAIT", True),
            heuristic_login_wait_for_text=(os.getenv("YR_HEURISTIC_LOGIN_WAIT_TEXT") or "等待页面加载完成").strip(),
            heuristic_login_wait_sleep_ms=max(100, _env_int("YR_HEURISTIC_LOGIN_SLEEP_MS", 1500)),
            heuristic_transient_assert=_env_bool("YR_HEURISTIC_TRANSIENT_ASSERT", True),
            heuristic_post_submit_upgrade_sleep=_env_bool("YR_HEURISTIC_POST_SUBMIT_WAIT", True),
            heuristic_vague_wait_fallback=_env_bool("YR_HEURISTIC_VAGUE_WAIT", True),
            heuristic_vague_wait_sleep_ms=max(300, _env_int("YR_HEURISTIC_VAGUE_WAIT_SLEEP_MS", 5000)),
            heuristic_vague_wait_prefer_sleep=_env_bool("YR_HEURISTIC_VAGUE_WAIT_SLEEP_FIRST", True),
            heuristic_vague_wait_alternate=(os.getenv("YR_HEURISTIC_VAGUE_WAIT_ALT") or "").strip(),
            cli_disable_browser_cache=_env_bool("YR_REPAIR_NO_CACHE", False),
            console_verbose=not _env_bool("YR_REPAIR_QUIET", False),
            max_log_chars=max(1000, _env_int("YR_MAX_LOG_CHARS", 12000)),
            failure_preview_chars=max(500, _env_int("YR_FAILURE_PREVIEW_CHARS", 8000)),
        )
