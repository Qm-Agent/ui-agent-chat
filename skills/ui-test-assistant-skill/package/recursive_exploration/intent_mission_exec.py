"""在同一 BrowserContext 上执行 intent_mission 的 Tasks YAML（与 bootstrap_agent_replay 对齐）。"""

from __future__ import annotations

import logging
import os
import shutil
import sys
from pathlib import Path
from typing import TYPE_CHECKING, Any

from omegaconf import OmegaConf

if TYPE_CHECKING:
    from browser_use.browser.context import BrowserContext

logger = logging.getLogger(__name__)


def _quick_query_from_intent_steps(*, anchor_url: str, steps: list[str]) -> str:
    lines = [
        f"快速测试 {anchor_url}。",
        "这是深度探索 intent_mission 的 quick 执行，请完成同一个高层业务意图。",
        "从当前入口页面开始，使用 config/.env 账号密码登录（若 CDP 已登录可跳过）。",
        "按以下意图步骤执行；允许根据页面实际文案调整点击、等待、切换 Tab 或返回模块，但不得削弱最终断言：",
    ]
    for idx, step in enumerate(steps, start=1):
        text = str(step or "").strip()
        if text:
            lines.append(f"{idx}. {text}")
    lines.append(
        "只有完成意图且页面可观察结果符合预期时才 done(success=true)；否则 done(success=false) 并说明卡点。"
    )
    return "\n".join(lines)


async def replay_intent_mission_quick_cli(
    *,
    anchor_url: str,
    intent_ai_steps: list[str],
    log_dir: Path,
    max_steps: int,
    no_cdp: bool,
    python_bin: str | None = None,
) -> dict[str, Any]:
    """Run intent mission via browser-use quick as a coarse intent-level fallback."""
    import asyncio

    log_dir = Path(log_dir)
    log_dir.mkdir(parents=True, exist_ok=True)
    query = _quick_query_from_intent_steps(anchor_url=anchor_url, steps=intent_ai_steps)
    query_path = log_dir / "quick_query.txt"
    query_path.write_text(query + "\n", encoding="utf-8")

    py = python_bin or os.environ.get("UI_TEST_PYTHON") or sys.executable
    cmd = [py, "-m", "browser_use.cli", "quick"]
    if no_cdp:
        cmd.append("--no-cdp")
    cmd.extend(["--max-steps", str(max(1, int(max_steps))), query, "--log-dir", str(log_dir)])
    (log_dir / "quick_cmd.txt").write_text(" ".join(cmd) + "\n", encoding="utf-8")
    print(
        f"[explore] intent_mission quick fallback 开始 | log={log_dir} | no_cdp={no_cdp} | max_steps={max_steps}",
        file=sys.stderr,
        flush=True,
    )
    proc = await asyncio.create_subprocess_exec(*cmd)
    rc = await proc.wait()
    print(
        f"[explore] intent_mission quick fallback 结束 | returncode={rc} | log={log_dir}",
        file=sys.stderr,
        flush=True,
    )
    return {
        "returncode": rc,
        "query_path": str(query_path),
        "log_dir": str(log_dir),
        "cmd_path": str(log_dir / "quick_cmd.txt"),
    }


async def replay_intent_mission_yaml_on_context(
    *,
    ctx: "BrowserContext",
    task_yaml: Path,
    headless: bool,
    log_dir: Path,
) -> None:
    """
    在已到达锚点的上下文上执行 intent mission YAML（flow 以 aiWaitFor + 多条 ai 为主）。
    不注入 initial go_to，以免冲掉当前 SPA 状态。
    """
    from browser_use import Agent, project_root
    from browser_use.agent.chat_models import build_models
    from browser_use.agent.tasks import Tasks

    task_yaml = Path(task_yaml).expanduser().resolve()
    log_dir.mkdir(parents=True, exist_ok=True)

    from recursive_exploration.llm_retry import (
        stability_agent_omega_conf,
        wrap_chat_models_with_retries,
    )

    default_cfg = OmegaConf.load(project_root / "static/configs/default.yaml")
    cfg = OmegaConf.merge(
        default_cfg,
        OmegaConf.create(stability_agent_omega_conf()),
        OmegaConf.from_cli(
            [
                f"task_file={task_yaml}",
                f"log_dir={log_dir}",
                f"browser.headless={'true' if headless else 'false'}",
            ]
        ),
    )

    tasks = Tasks(task_yaml_path=str(task_yaml), dump_config_dir=None)
    try:
        shutil.copy2(task_yaml, log_dir / "task_config.yaml")
    except OSError as exc:
        logger.warning("无法写入 task_config.yaml 镜像（不影响执行）: %s", exc)

    actor, planner, asserter, aux_llms = wrap_chat_models_with_retries(
        *build_models(
            actor=cfg.models.actor,
            planner=cfg.models.planner,
            asserter=cfg.models.asserter,
            page_extraction_llm=cfg.models.aux_llms.page_extraction_llm,
            locating_llm=cfg.models.aux_llms.locating_llm,
            coding_llm=cfg.models.aux_llms.coding_llm,
        )
    )

    browser = getattr(ctx, "browser", None)
    initial_actions: list[dict[str, Any]] | None = None

    agent = Agent(
        cfg,
        tasks=tasks,
        llm=actor,
        planner=planner,
        asserter=asserter,
        aux_llms=aux_llms,
        browser=browser,
        browser_context=ctx,
        initial_actions=initial_actions,
        log_dir=str(log_dir),
    )
    print(
        f"[explore] intent_mission 开始 | yaml={task_yaml.name} | log={log_dir}",
        file=sys.stderr,
        flush=True,
    )
    await agent.run()
