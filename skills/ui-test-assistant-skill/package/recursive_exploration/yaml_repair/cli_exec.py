"""调用 browser_use.cli 执行单个 YAML。"""

from __future__ import annotations

import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path


@dataclass
class CliRunResult:
    returncode: int
    stdout: str
    stderr: str
    log_dir: Path


def cli_execution_ok(rc: int) -> bool:
    """与 bootstrap / SKILL 一致：进程退出码 0 视为执行成功。"""
    return rc == 0


def run_browser_use_cli(
    task_file: Path,
    log_dir: Path,
    *,
    headless: bool = True,
    python_exe: str | None = None,
    disable_browser_cache: bool = False,
) -> CliRunResult:
    py = python_exe or sys.executable
    log_dir = Path(log_dir).expanduser()
    log_dir.mkdir(parents=True, exist_ok=True)
    cfg_tail = ["browser.headless=true"] if headless else ["browser.headless=false"]
    if disable_browser_cache:
        cfg_tail = [*cfg_tail, "cache.enabled=false"]
    proc = subprocess.run(
        [
            py,
            "-m",
            "browser_use.cli",
            "--task-file",
            str(Path(task_file).expanduser().resolve()),
            "--log-dir",
            str(log_dir.resolve()),
            *cfg_tail,
        ],
        capture_output=True,
        text=True,
        timeout=None,
    )
    out = proc.stdout or ""
    err = proc.stderr or ""
    return CliRunResult(returncode=int(proc.returncode), stdout=out, stderr=err, log_dir=log_dir)
