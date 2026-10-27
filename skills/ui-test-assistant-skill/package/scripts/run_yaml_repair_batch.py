#!/usr/bin/env python3
"""批量逐个执行 YAML 自愈（无外层单文件超时）。

默认行为：
- 顺序逐个执行 run_yaml_repair.py；
- 不设置 subprocess timeout；
- 某个文件失败不影响后续文件继续；
- 仅当 --overwrite-success 时，用 repaired.yaml 回写原 YAML。
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import time
from pathlib import Path
from typing import Iterable, List


def _skill_root() -> Path:
    return Path(__file__).resolve().parents[2]


def _collect_yaml(input_path: Path, pattern: str) -> List[Path]:
    if input_path.is_file():
        return [input_path]
    return sorted(p for p in input_path.glob(pattern) if p.is_file())


def _derive_run_dir(output_root: Path, source: Path) -> Path:
    ts = time.strftime("%Y%m%d-%H%M%S")
    name = source.name if source.is_dir() else source.stem
    return output_root / ts / "repair" / name


def _run_one(
    py: str,
    root: Path,
    task_file: Path,
    work_dir: Path,
    passthrough_args: Iterable[str],
) -> subprocess.CompletedProcess[str]:
    cmd = [
        py,
        "package/scripts/run_yaml_repair.py",
        "--task-file",
        str(task_file),
        "--work-dir",
        str(work_dir),
        *passthrough_args,
    ]
    return subprocess.run(
        cmd,
        cwd=str(root),
        env=os.environ.copy(),
        capture_output=True,
        text=True,
    )


def main() -> int:
    parser = argparse.ArgumentParser(description="批量逐个 YAML 自愈（不设置单文件超时）")
    parser.add_argument("--input", required=True, help="YAML 文件或目录路径")
    parser.add_argument(
        "--glob",
        default="*.yaml",
        help="当 input 为目录时使用的 glob（默认 *.yaml）",
    )
    parser.add_argument(
        "--output-root",
        default=".skill-output/ui-test-assistant-skill-output",
        help="输出根目录（默认 .skill-output/ui-test-assistant-skill-output）",
    )
    parser.add_argument(
        "--overwrite-success",
        action="store_true",
        help="当单文件修复成功时，用 repaired.yaml 回写原始 YAML",
    )
    parser.add_argument(
        "--repair-args",
        default="",
        help="透传给 run_yaml_repair.py 的额外参数（字符串形式）",
    )
    args = parser.parse_args()

    root = _skill_root()
    source = Path(args.input).expanduser()
    if not source.is_absolute():
        source = (Path.cwd() / source).resolve()
    if not source.exists():
        print(f"输入路径不存在: {source}", file=sys.stderr)
        return 2

    output_root = Path(args.output_root).expanduser()
    if not output_root.is_absolute():
        output_root = (root / output_root).resolve()
    run_dir = _derive_run_dir(output_root, source)
    run_dir.mkdir(parents=True, exist_ok=True)

    files = _collect_yaml(source, args.glob)
    if not files:
        print("未找到 YAML 文件")
        return 0

    py = os.environ.get("UI_TEST_PYTHON", "python3")
    passthrough = args.repair_args.split() if args.repair_args.strip() else []

    print(f"START total={len(files)} run_dir={run_dir}")
    results = []
    for idx, task_file in enumerate(files, start=1):
        work_dir = run_dir / f"{idx:02d}"
        work_dir.mkdir(parents=True, exist_ok=True)
        print(f"RUN [{idx}/{len(files)}] {task_file}")
        start = time.time()
        cp = _run_one(py, root, task_file, work_dir, passthrough)
        elapsed = round(time.time() - start, 1)

        status = "failed"
        repaired = work_dir / "repaired.yaml"
        if cp.returncode == 0:
            status = "repaired"
            if args.overwrite_success and repaired.exists() and repaired.stat().st_size > 0:
                task_file.write_text(repaired.read_text(encoding="utf-8"), encoding="utf-8")
                status = "repaired_and_overwritten"
        print(f"DONE [{idx}/{len(files)}] {task_file.name} -> {status} ({elapsed}s)")

        results.append(
            {
                "file": str(task_file),
                "status": status,
                "returncode": cp.returncode,
                "elapsed_sec": elapsed,
                "work_dir": str(work_dir),
                "stdout_tail": cp.stdout[-1200:],
                "stderr_tail": cp.stderr[-1200:],
            }
        )

    summary = {
        "source": str(source),
        "total": len(files),
        "repaired": sum(1 for r in results if r["status"] in {"repaired", "repaired_and_overwritten"}),
        "overwritten": sum(1 for r in results if r["status"] == "repaired_and_overwritten"),
        "failed": sum(1 for r in results if r["status"] == "failed"),
        "run_dir": str(run_dir),
        "results": results,
    }
    summary_path = run_dir / "batch_summary.json"
    summary_path.write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
    print("SUMMARY=" + json.dumps({k: summary[k] for k in ["total", "repaired", "overwritten", "failed"]}, ensure_ascii=False))
    print(f"BATCH_SUMMARY={summary_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
