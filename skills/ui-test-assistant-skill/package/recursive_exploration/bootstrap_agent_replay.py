"""在同一 BrowserContext 内用 browser_use Agent 重放 bootstrap.yaml（与 explorer 会话一致）。"""

from __future__ import annotations

import logging
import shutil
from pathlib import Path
from typing import TYPE_CHECKING

from omegaconf import OmegaConf

if TYPE_CHECKING:
    from browser_use.browser.context import BrowserContext

logger = logging.getLogger(__name__)


async def replay_bootstrap_agent_on_context(
    *,
    ctx: "BrowserContext",
    bootstrap_yaml: Path,
    headless: bool,
    log_dir: Path,
) -> bool:
    """
    加载 bootstrap TasksConfig 并在已注入的 browser_context 上执行 Agent.run()。
    返回是否未抛异常完成（不代表业务断言一定通过）。
    """
    from browser_use import Agent, project_root
    from browser_use.agent.chat_models import build_models
    from browser_use.agent.tasks import Tasks

    from recursive_exploration.llm_retry import (
        stability_agent_omega_conf,
        wrap_chat_models_with_retries,
    )

    bootstrap_yaml = Path(bootstrap_yaml).expanduser().resolve()
    log_dir.mkdir(parents=True, exist_ok=True)

    default_cfg = OmegaConf.load(project_root / "static/configs/default.yaml")
    cfg = OmegaConf.merge(
        default_cfg,
        OmegaConf.create(stability_agent_omega_conf()),
        OmegaConf.from_cli(
            [
                f"task_file={bootstrap_yaml}",
                f"log_dir={log_dir}",
                f"browser.headless={'true' if headless else 'false'}",
            ]
        ),
    )

    # browser_use Tasks 在 dump_config_dir 下用 model_dump() 写 task_config.yaml；
    # flow 中多项 BaseCommandConfig 会被序列化为 {}（含 sleep/aiWaitFor），易误判「前置为空」。
    tasks = Tasks(task_yaml_path=str(bootstrap_yaml), dump_config_dir=None)
    try:
        shutil.copy2(bootstrap_yaml, log_dir / "task_config.yaml")
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

    entry_url = str(getattr(getattr(tasks.tasks_config, "target", None), "url", "") or "")
    initial_actions = [{"go_to_url": {"url": entry_url}}] if entry_url else None

    browser = getattr(ctx, "browser", None)
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
    await agent.run()
    return True
