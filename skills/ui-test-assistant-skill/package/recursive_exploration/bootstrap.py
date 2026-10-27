"""Bootstrap：主探索前执行 YAML 或由描述生成 YAML。"""

from __future__ import annotations

import asyncio
import logging
import shutil
import sys
from pathlib import Path

from recursive_exploration.config import ExplorationRunConfig
from recursive_exploration.input_mock_llm import try_get_page_extraction_llm
from recursive_exploration.models import BootstrapResult

logger = logging.getLogger(__name__)


async def _generate_yaml_from_description(*, entry_url: str, description: str, out_yaml: Path) -> None:
    llm = try_get_page_extraction_llm()
    if llm is None:
        raise RuntimeError(
            "bootstrap_description 需要可用的 BU_OPENAI_* 模型配置（build_models）；"
            "或改用 bootstrap_task_file 提供 YAML。"
        )
    try:
        from langchain_core.messages import HumanMessage, SystemMessage
    except ImportError as e:
        raise RuntimeError("需要 langchain_core 以由描述生成 bootstrap YAML") from e

    system = (
        "你是 UI 自动化专家。根据用户描述生成**单个** browser-use TasksConfig YAML。\n"
        "必须包含顶层 target.url 与 tasks[0].flow；flow 从 aiWaitFor 页面加载后开始，"
        "不要重复 goTo 到 target.url。\n"
        "只输出 YAML 正文，不要 markdown 围栏。"
    )
    user = f"入口 URL: {entry_url}\n用户前置流程描述:\n{description.strip()}\n"
    msg = await llm.ainvoke([SystemMessage(content=system), HumanMessage(content=user)])
    content = getattr(msg, "content", None)
    text = str(content) if content is not None else ""
    text = text.strip()
    if text.startswith("```"):
        lines = text.splitlines()
        if lines and lines[0].startswith("```"):
            lines = lines[1:]
        if lines and lines[-1].strip() == "```":
            lines = lines[:-1]
        text = "\n".join(lines).strip()
    out_yaml.parent.mkdir(parents=True, exist_ok=True)
    out_yaml.write_text(text, encoding="utf-8")


async def run_bootstrap_cli(
    *,
    yaml_path: Path,
    log_dir: Path,
    headless: bool,
    python_exe: str | None = None,
) -> int:
    py = python_exe or sys.executable
    log_dir.mkdir(parents=True, exist_ok=True)
    # browser_use.cli 外层不会把 --headless 传给内层 OmegaConf；须用 remainder：browser.headless=false
    cfg_tail = ["browser.headless=true"] if headless else ["browser.headless=false"]
    proc = await asyncio.create_subprocess_exec(
        py,
        "-m",
        "browser_use.cli",
        "--task-file",
        str(yaml_path.expanduser()),
        "--log-dir",
        str(log_dir.expanduser()),
        *cfg_tail,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    out_b, err_b = await proc.communicate()
    if proc.returncode != 0:
        logger.warning(
            "bootstrap cli rc=%s stdout=%s stderr=%s",
            proc.returncode,
            (out_b or b"")[:800],
            (err_b or b"")[:800],
        )
    return int(proc.returncode or 0)


async def run_bootstrap_phase(
    cfg: ExplorationRunConfig,
    *,
    entry_url: str,
    out_dir: Path,
    skill_root: Path | None,
    execute_cli: bool = True,
) -> tuple[BootstrapResult, Path | None]:
    """
    返回 BootstrapResult 与实际使用的 YAML 副本路径（写入 out_dir/bootstrap.yaml 便于 resume）。
    若未配置 bootstrap，返回 skipped。
    execute_cli=False 时仅生成/拷贝 YAML，不调用 browser_use.cli（由 explorer 内同会话 Agent 重放）。
    """
    out_dir = Path(out_dir)
    task_file = (cfg.bootstrap_task_file or "").strip()
    desc = (cfg.bootstrap_description or "").strip()
    if not task_file and not desc:
        return (
            BootstrapResult(ok=True, result="skipped", last_url="", flow_ref=None, state_summary={}),
            None,
        )
    if task_file and desc:
        logger.warning("同时提供 bootstrap_task_file 与 bootstrap_description，优先使用 bootstrap_task_file")
    gen_path = out_dir / "bootstrap.yaml"
    src_yaml: Path
    if task_file:
        src_yaml = Path(task_file).expanduser()
        if not src_yaml.is_file():
            br = BootstrapResult(
                ok=False,
                result="failed",
                error=f"bootstrap_task_file 不存在: {src_yaml}",
            )
            return br, None
        if src_yaml.resolve() != gen_path.resolve():
            shutil.copy2(src_yaml, gen_path)
        src_yaml = gen_path
    else:
        await _generate_yaml_from_description(entry_url=entry_url, description=desc, out_yaml=gen_path)
        src_yaml = gen_path

    if not execute_cli:
        try:
            flow_ok = str(gen_path.relative_to(out_dir))
        except ValueError:
            flow_ok = str(gen_path)
        return (
            BootstrapResult(
                ok=True,
                result="ok",
                last_url="",
                flow_ref=flow_ok,
                state_summary={"materialized_only": True},
            ),
            gen_path,
        )

    same_session = bool(getattr(cfg, "bootstrap_same_session", True))
    if same_session:
        try:
            flow_ok = str(gen_path.relative_to(out_dir))
        except ValueError:
            flow_ok = str(gen_path)
        return (
            BootstrapResult(
                ok=True,
                result="ok",
                last_url="",
                flow_ref=flow_ok,
                state_summary={"deferred_same_session_replay": True},
            ),
            gen_path,
        )

    log_dir = out_dir / "bootstrap_logs"
    rc = await run_bootstrap_cli(yaml_path=src_yaml, log_dir=log_dir, headless=cfg.headless)
    ok = rc == 0
    if not ok and cfg.bootstrap_abort_on_failure:
        try:
            flow_ref = str(gen_path.relative_to(out_dir))
        except ValueError:
            flow_ref = str(gen_path)
        return (
            BootstrapResult(
                ok=False,
                result="failed",
                flow_ref=flow_ref,
                error=f"browser_use.cli 退出码 {rc}",
            ),
            gen_path,
        )
    summary: dict[str, object] = {"cli_exit_code": rc, "log_dir": str(log_dir)}
    try:
        flow_ok = str(gen_path.relative_to(out_dir))
    except ValueError:
        flow_ok = str(gen_path)
    last_u = entry_url if ok else ""
    return (
        BootstrapResult(
            ok=True,
            result="ok" if ok else "failed",
            last_url=last_u,
            flow_ref=flow_ok,
            state_summary=summary,
            error=None if ok else f"browser_use.cli 退出码 {rc}",
        ),
        gen_path,
    )
