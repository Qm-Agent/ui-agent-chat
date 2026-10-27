#!/usr/bin/env python3
"""
探索模式：单 URL 调用 CaseGeneratorAgent 生成 YAML。

browser_use.agent.chat_models 在**首次 import** 时根据当前 os.environ 构建 __factory__；
CaseGeneratorAgent() 无参时会调用上游默认模型，可能与用户配置不一致。本脚本：

1. 先 load_dotenv（优先 DOTENV_PATH，否则 {技能根}/config/.env）
2. 再 import browser_use
3. 用 BU_ACTOR_MODEL 等环境变量显式调用 build_models，再传入 CaseGeneratorAgent

用法（在工作区根）：
  export DOTENV_PATH="/path/to/skills/ui-test-assistant-skill/config/.env"   # 可选
  python /path/to/skills/ui-test-assistant-skill/package/scripts/run_exploration_case_generator.py \\
    --url "https://example.com" \\
    --output-dir ".skill-output/ui-test-assistant-skill-output/<RUN_TS>/exploration/generated_cases" \\
    [--user-input-file /path/to/requirements.md] [--user-input "补充场景导向说明"]
"""
from __future__ import annotations

import argparse
import asyncio
import os
import sys
from pathlib import Path


def _default_model() -> str:
    return "qwen3.7-plus"


def _env_model(key: str, fallback: str) -> str:
    v = (os.getenv(key) or "").strip()
    return v if v else fallback


def _load_env(skill_root: Path) -> Path | None:
    raw = (os.environ.get("DOTENV_PATH") or "").strip()
    if raw:
        p = Path(raw).expanduser()
        if p.is_file():
            from dotenv import load_dotenv

            load_dotenv(p, override=True)
            return p
        print(f"警告: DOTENV_PATH 指向的文件不存在: {p}", file=sys.stderr)
    p = skill_root / "config" / ".env"
    if p.is_file():
        from dotenv import load_dotenv

        load_dotenv(p, override=True)
        return p
    print(
        f"警告: 未找到 {p} 且无有效 DOTENV_PATH，将仅使用当前进程已有环境变量",
        file=sys.stderr,
    )
    return None


def main() -> int:
    parser = argparse.ArgumentParser(description="CaseGeneratorAgent 探索生成（先 load_dotenv 再 import browser_use）")
    parser.add_argument("--url", required=True, help="被测入口 URL")
    parser.add_argument("--output-dir", required=True, help="生成 YAML 目录（须已存在或可创建）")
    parser.add_argument("--project-name", default="uiTest", help="与库内默认路径相关")
    parser.add_argument("--no-headless", action="store_true", help="有头模式（默认无头）")
    parser.add_argument(
        "--user-input",
        default=None,
        help="传给 CaseGeneratorAgent 的补充说明（与页面分析结合，用于场景/用例设计导向）",
    )
    parser.add_argument(
        "--user-input-file",
        type=Path,
        default=None,
        dest="user_input_file",
        help="从 UTF-8 文件读取补充说明并传给 CaseGeneratorAgent（可与 --user-input 合并）",
    )
    parser.add_argument(
        "--skill-root",
        type=Path,
        default=None,
        help="技能根目录（含 config/.env）；默认为本脚本上两级（package/scripts → 技能根）",
    )
    args = parser.parse_args()

    skill_root = (args.skill_root or Path(__file__).resolve().parents[2]).resolve()
    _load_env(skill_root)

    # 必须在 load_dotenv 之后
    from browser_use.agent.chat_models import build_models
    from browser_use.case_generator import CaseGeneratorAgent

    dm = _default_model()
    actor = _env_model("BU_ACTOR_MODEL", dm)
    planner = _env_model("BU_PLANNER_MODEL", dm)
    asserter = _env_model("BU_ASSERTER_MODEL", dm)
    page = _env_model("BU_PAGE_EXTRACTION_LLM", dm)
    locating = _env_model("BU_LOCATING_LLM", page)
    coding = _env_model("BU_CODING_LLM", page)

    try:
        _, _, _, aux = build_models(
            actor=actor,
            planner=planner,
            asserter=asserter,
            page_extraction_llm=page,
            locating_llm=locating,
            coding_llm=coding,
        )
    except Exception as e:
        print(
            "build_models 失败（常见原因：import browser_use 早于 load_dotenv，或缺少 BU_OPENAI_*）：\n"
            f"  {e}",
            file=sys.stderr,
        )
        return 2

    llm = aux.get("page_extraction_llm")
    if llm is None:
        print(
            "page_extraction_llm 为 None：请配置 BU_OPENAI_API_BASE + BU_OPENAI_API_KEY，"
            "并确保在首次 import browser_use 之前已 load_dotenv（见 ui-test-assistant-skill 文档）。",
            file=sys.stderr,
        )
        return 2

    out = Path(args.output_dir).expanduser()
    out.mkdir(parents=True, exist_ok=True)

    user_input_parts: list[str] = []
    if args.user_input_file is not None:
        uf = Path(args.user_input_file).expanduser()
        if not uf.is_file():
            print(f"错误: --user-input-file 不存在或不是文件: {uf}", file=sys.stderr)
            return 2
        user_input_parts.append(uf.read_text(encoding="utf-8"))
    if args.user_input:
        user_input_parts.append(args.user_input.strip())
    merged_user_input = "\n\n".join(p for p in user_input_parts if p) or None

    agent = CaseGeneratorAgent(
        page_analysis_llm=llm,
        case_design_llm=llm,
        yaml_gen_llm=llm,
    )
    headless = not args.no_headless

    try:
        paths = asyncio.run(
            agent.run(
                url=args.url,
                output_dir=str(out),
                project_name=args.project_name,
                headless=headless,
                user_input=merged_user_input,
            )
        )
    except Exception as e:
        print(f"CaseGeneratorAgent.run 失败: {e}", file=sys.stderr)
        return 3

    for p in paths:
        print(p)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
