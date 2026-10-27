#!/usr/bin/env python3
"""YAML 修复自愈 CLI：合并依赖、执行验证、阶梯观测与 LLM 改写。

用法示例::

  export DOTENV_PATH=\"$(pwd)/config/.env\"
  python package/scripts/run_yaml_repair.py --task-file path/to/case.yaml --work-dir .skill-output/ui-test-assistant-skill-output/RUN_TS/repair/run1

  环境变量（节选）：``YR_HEURISTIC_LOGIN_WAIT``、``YR_HEURISTIC_LOGIN_SLEEP_MS`` 控制登录表单 aiWaitFor→sleep 启发式修补；
  ``YR_REPAIR_NO_CACHE=1`` 或 ``--no-browser-cache`` 关闭 browser-use 命令缓存（``cache.enabled=false``）；
  ``YR_HEURISTIC_*`` 控制断言精简与登录等待策略；
  ``YR_REPAIR_QUIET=1`` 关闭控制台「失败分析 / 修复策略」输出。
  ``YR_HEURISTIC_VAGUE_WAIT`` 等控制「弱特征 aiWaitFor」超时后是否改为 sleep。
合并规则见 recursive_exploration.yaml_repair.merge_deps；产物：
  - merged.yaml：首轮合并后的基线
  - iter_XXX.yaml：每轮执行所用 YAML
  - repaired.yaml：按门禁选择的交付 YAML（成功则有验证；否则末版）
  - repair_report.md：结论报告
"""

from __future__ import annotations

import argparse
import asyncio
import os
import sys
from pathlib import Path


def _skill_root() -> Path:
    return Path(__file__).resolve().parents[2]


def main() -> int:
    root = _skill_root()
    pkg_root = root / "package"
    if str(pkg_root) not in sys.path:
        sys.path.insert(0, str(pkg_root))

    parser = argparse.ArgumentParser(description="YAML 修复自愈（browser_use.cli 闭环）")
    parser.add_argument("--task-file", required=True, help="入口 YAML 路径（单文件）")
    parser.add_argument("--work-dir", required=True, help="产物目录（将写入 merged/repaired/report）")
    parser.add_argument("--intent", default="", help="用户意图或背景说明")
    parser.add_argument("--bootstrap", default="", help="显式 bootstrap.yaml 路径（可选）")
    parser.add_argument("--max-iterations", type=int, default=0, help="最大执行轮次（0=环境变量或默认 5）")
    parser.add_argument("--no-merge-bootstrap", action="store_true", help="不合并同目录 bootstrap.yaml")
    parser.add_argument("--no-expand-imports", action="store_true", help="不展开 import/use")
    parser.add_argument("--no-interactive", action="store_true", help="不进行 stdin 同步追问")
    parser.add_argument("--headed", action="store_true", help="有头模式（等价 skill：末尾 browser.headless false）")
    parser.add_argument("--dotenv", default="", help="覆盖 DOTENV_PATH（默认沿用环境变量）")
    parser.add_argument(
        "--no-browser-cache",
        action="store_true",
        help="关闭 browser-use 缓存（cache.enabled=false；等价 YR_REPAIR_NO_CACHE=1）",
    )
    args = parser.parse_args()

    dotenv = (args.dotenv or os.getenv("DOTENV_PATH") or "").strip()
    if dotenv:
        os.environ["DOTENV_PATH"] = dotenv

    from recursive_exploration.yaml_repair.config import YamlRepairConfig
    from recursive_exploration.yaml_repair.session import YamlRepairSession

    cfg = YamlRepairConfig.from_env()
    if args.max_iterations > 0:
        cfg.max_repair_iterations = args.max_iterations
    if args.no_browser_cache:
        cfg.cli_disable_browser_cache = True
    cfg.merge_bootstrap = not args.no_merge_bootstrap
    cfg.expand_imports = not args.no_expand_imports
    cfg.interactive_prompts = not args.no_interactive
    cfg.headless = not args.headed

    boot = Path(args.bootstrap).expanduser() if args.bootstrap.strip() else None

    session = YamlRepairSession(
        cfg,
        entry_yaml=Path(args.task_file),
        work_dir=Path(args.work_dir),
        user_intent=args.intent.strip(),
        bootstrap_path=boot,
    )
    outcome = asyncio.run(session.run_async())
    print(outcome.message)
    if outcome.verified_success:
        print(f"\n交付 YAML: {outcome.deliver_yaml_path}")
        if outcome.user_prompts_log:
            print("\n--- 自愈说明（含启发式对断言/等待的调整）---")
            for line in outcome.user_prompts_log:
                print(line)
        return 0
    print(f"\n未验证成功；参考 YAML: {outcome.deliver_yaml_path}")
    print(f"报告: {outcome.report_path}")
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
