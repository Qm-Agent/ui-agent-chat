#!/usr/bin/env python3
"""
递归探索（技能包）：DOM 优先枚举 + 双队列/深度闸门 + events.jsonl + graph.json。

须已安装 browser-use==3.1.6；在首次 import browser_use 之前 load_dotenv（与 run_exploration_case_generator.py 一致）。

用法（在工作区根，将技能根加入 PYTHONPATH 或从技能根执行）：
  建议前台执行：export PYTHONUNBUFFERED=1 ，勿默认 nohup，否则长时间意图/LLM 重试时不易察觉仍在运行。

  export DOTENV_PATH="/path/to/skills/ui-test-assistant-skill/config/.env"
  python package/scripts/run_recursive_exploration.py \\
    --url "https://example.com" \\
    --output-dir ".skill-output/ui-test-assistant-skill-output/<RUN_TS>/exploration/recursive"
"""
from __future__ import annotations

import argparse
import asyncio
import os
import sys
from pathlib import Path


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


def _setup_stdio_line_buffering() -> None:
    """尽量行缓冲 stdout/stderr，便于前台 tail/重定向时及时看到 [explore] 行。"""
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(line_buffering=True)  # type: ignore[attr-defined]
        except (AttributeError, OSError, ValueError):
            pass


def _env_bool(name: str, default: bool = False) -> bool:
    raw = (os.environ.get(name) or "").strip().lower()
    if not raw:
        return default
    return raw in {"1", "true", "yes", "y", "on"}


def _env_int(name: str, default: int) -> int:
    raw = (os.environ.get(name) or "").strip()
    if not raw:
        return default
    try:
        return int(raw)
    except ValueError:
        return default


def main() -> int:
    skill_root = Path(__file__).resolve().parents[2]
    pkg_root = skill_root / "package"
    sys.path.insert(0, str(pkg_root))
    _setup_stdio_line_buffering()

    parser = argparse.ArgumentParser(description="递归探索（DOM 优先 + 图谱/事件）")
    parser.add_argument("--url", default="", help="入口 URL（--resume-session 时可省略，将以 session 为准）")
    parser.add_argument("--output-dir", default="", help="产物目录（将创建）；与 --resume-session 二选一或同目录")
    parser.add_argument("--exploration-depth", type=int, default=1, help="URL 递归深度（默认 1）")
    parser.add_argument("--max-actions", type=int, default=50)
    parser.add_argument(
        "--max-total-actions",
        type=int,
        default=200,
        help="整次 run 全局累计成功动作上限（跨所有锚点）；达到后不再执行新的成功步",
    )
    parser.add_argument(
        "--composite-checkpoint-every",
        type=int,
        default=15,
        help="每 N 次非组合单步成功后在本锚点内插入一轮组合规划；0 关闭（仍保留队列空时的组合 boost）",
    )
    parser.add_argument("--max-new-urls", type=int, default=40)
    parser.add_argument(
        "--task-step-post-nav-settle-ms",
        type=int,
        default=None,
        help=(
            "每条队列任务导航到锚点后、采 DOM 前的额外等待（毫秒），减轻 SPA 与首轮枚举 DOM 不一致。"
            "省略则用配置默认（1200）；设为 0 关闭"
        ),
    )
    parser.add_argument(
        "--post-action-paint-delay-ms",
        type=int,
        default=None,
        metavar="MS",
        help=(
            "动作后 URL 已稳定、截 before/after 前追加等待（毫秒）；省略用配置默认。"
            "SPA 易白屏时可酌增（如 400）。"
        ),
    )
    parser.add_argument(
        "--screenshot-try-load-ms",
        type=int,
        default=None,
        metavar="MS",
        help=(
            "写审查 PNG 前尝试 wait_for_load_state(load) 的最长毫秒；0 关闭。"
            "省略用配置默认；从不触发 load 的长连接页会在超时后继续截图。"
        ),
    )
    parser.add_argument(
        "--screenshot-paint-settle-ms",
        type=int,
        default=None,
        metavar="MS",
        help="截图前 requestAnimationFrame 之后的额外休眠毫秒；省略用配置默认。",
    )
    parser.add_argument(
        "--screenshot-remove-highlights",
        action="store_true",
        help=(
            "写入审查 PNG 前移除 browser-use DOM 高亮框（默认保留，与旧产物对齐）。"
        ),
    )
    parser.add_argument(
        "--yaml-policy",
        choices=("all", "critical"),
        default="all",
        help="默认 all：每次成功动作均写可复现 YAML；critical 仅跨页或 structural 变化时写。",
    )
    parser.add_argument("--execution-mode", choices=("fast", "strict"), default="fast")
    parser.add_argument(
        "--disable-llm-input-mock",
        action="store_true",
        help="不调用模型推断 input 占位，始终使用配置中的 mock_input_text（离线/无密钥场景）",
    )
    parser.add_argument("--no-headless", action="store_true")
    parser.add_argument(
        "--composite",
        action="store_true",
        help="开启 strict 下需 composite 的入队（含阶段 B 启发式 composite_seed；默认关）",
    )
    parser.add_argument(
        "--no-composite",
        action="store_true",
        help="显式关闭 composite（与 --composite 互斥时应避免同时传）",
    )
    parser.add_argument(
        "--graph-guided-composite",
        action="store_true",
        help="开启 graph.json 成功边链多步入队（须同时 --composite；默认关）",
    )
    parser.add_argument(
        "--prior-graph",
        type=str,
        default=None,
        help="已有 run 的 graph.json 路径，用于增量组合时跳过 prior 中已有路径键",
    )
    parser.add_argument(
        "--incremental-composite",
        action="store_true",
        help="仅运行增量组合补探（跳过单步扩队；需与 --prior-graph 等配合）",
    )
    spg = parser.add_mutually_exclusive_group()
    spg.add_argument(
        "--strict-phase-traversal",
        action="store_true",
        help="显式启用严格阶段遍历（默认已开启；与 --no-strict-phase-traversal 互斥）",
    )
    spg.add_argument(
        "--no-strict-phase-traversal",
        action="store_true",
        help="关闭严格阶段遍历（旧版 Fast 交错单步/组合语义）",
    )
    parser.add_argument("--merge-site-graph", nargs="*", metavar="GRAPH_JSON", help="合并多份 run 级 graph.json 写出 site_merged（需同时传 --merge-output）")
    parser.add_argument("--merge-output", type=Path, default=None, help="site_merged 输出路径")
    parser.add_argument(
        "--bootstrap-task-file",
        default=None,
        help="探索主循环前先执行的 YAML（browser_use.cli）",
    )
    parser.add_argument("--bootstrap-description", default=None, help="自然语言前置流程（生成短时 YAML 后执行）")
    parser.add_argument(
        "--bootstrap-continue-on-failure",
        action="store_true",
        help="bootstrap CLI 失败时仍继续主探索（适用于环境/账号未就绪时需先看遍历行为）",
    )
    parser.add_argument(
        "--no-embed-bootstrap-in-yaml",
        action="store_true",
        help="不在各 generated_cases 的 flow 中合并 bootstrap.yaml 步骤（默认会合并，便于单文件回放整链）",
    )
    parser.add_argument(
        "--generated-cases-filename",
        choices=("queue_seq_task_id", "task_id"),
        default="queue_seq_task_id",
        metavar="MODE",
        help=(
            "generated_cases 下 YAML 文件名：queue_seq_task_id=与 queues.jsonl 的 seq 一致的前缀 "
            "（默认，便于对照 bootstrap_replay_logs_task/<seq>_<task_id>/）；task_id=仅 {task_id}.yaml"
        ),
    )
    parser.add_argument(
        "--no-anchor-step-in-generated-cases-filename",
        action="store_true",
        help="不在 generated_cases 文件名前加锚点会话内步序（默认会加，与报告「会话内第 N 步」一致）",
    )
    parser.add_argument(
        "--no-bootstrap-same-session",
        action="store_true",
        help="关闭「同会话前置」：在子进程单独跑 bootstrap CLI，主探索再从 --url 冷启动（旧行为）",
    )
    parser.add_argument(
        "--resume-session",
        default=None,
        help="包含 session_state.json 的产物目录，resume-strict 续跑",
    )
    parser.add_argument(
        "--resume-reopen-entry-on-higher-budget",
        action="store_true",
        help="续跑且本次 --max-actions 比上次大时，把入口 URL 重新入队消耗新增预算；默认关闭，"
        "续跑按断点继续，不主动改变参数语义（断网恢复等场景）",
    )
    parser.add_argument(
        "--extended-observation",
        action="store_true",
        help="启用扩展页面观测摘要（面包屑/浮层等启发式）",
    )
    parser.add_argument(
        "--scroll-enumerate",
        action="store_true",
        help="首轮入队枚举时通过多轮滚动覆盖视口外交互元素",
    )
    parser.add_argument(
        "--scroll-enumerate-max-rounds",
        type=int,
        default=5,
        help="滚动枚举最大轮次（默认 5）",
    )
    parser.add_argument(
        "--scroll-enumerate-settle-ms",
        type=int,
        default=500,
        help="滚动枚举每轮滚动后等待稳定毫秒数（默认 500）",
    )
    parser.add_argument(
        "--skill-root",
        type=Path,
        default=None,
        help="技能根（bootstrap 描述转 YAML 时的 dotenv）；默认脚本上级目录",
    )
    parser.add_argument(
        "--no-graph-guided-composite",
        action="store_true",
        help="关闭基于 graph.json 成功边链的多步组合入队（默认关；与 --graph-guided-composite 互斥时应避免同传）",
    )
    parser.add_argument(
        "--graph-guided-max-hops",
        type=int,
        default=3,
        metavar="N",
        help="图谱链最大边数（≥2），默认 3",
    )
    parser.add_argument(
        "--composite-coherence",
        action="store_true",
        help="启用组合链版面连贯性过滤（右上 vs 左栏等启发式）",
    )
    parser.add_argument(
        "--composite-coherence-mode",
        choices=("off", "rank", "strict"),
        default="strict",
        help="连贯性策略：strict 丢弃不协调链；rank 排到队尾；off 关闭过滤（需同时 --composite-coherence）",
    )
    parser.add_argument(
        "--skip-rules",
        type=str,
        default=None,
        help=(
            "黑名单 JSON/YAML 路径（覆盖默认）。默认若省略：使用 "
            "<skill-root>/config/skip_rules.json（存在则加载）。编辑可参考同目录 skip_rules.example.json"
        ),
    )
    parser.add_argument(
        "--semantic-blacklist-uncertain",
        choices=("allow", "skip"),
        default="allow",
        help="语义黑名单 LLM 返回 uncertain 时：allow 放行；skip 保守跳过",
    )
    parser.add_argument(
        "--max-equivalent-siblings",
        type=int,
        default=None,
        help="同一 CSS 骨架的列表行/数据卡片最多入队几个（默认 2；0 不限制）",
    )
    parser.add_argument(
        "--no-url-equivalence",
        action="store_true",
        help="关闭 URL 参数等价去重（默认开启：path+参数名相同仅值不同的 URL 视为等价）",
    )
    parser.add_argument(
        "--no-intent-missions",
        action="store_true",
        help="关闭意图 LLM 任务（默认开启；见 exploration-intent-ai-missions）",
    )
    parser.add_argument(
        "--intent-mission-max-per-anchor",
        type=int,
        default=8,
        metavar="N",
        help="每锚点最多生成的意图任务条数（默认 8；单链 ai 步数上限与 composite_max_step_count 取小）",
    )
    parser.add_argument(
        "--intent-mission-suppress-dom-expand",
        action="store_true",
        help="意图任务成功执行后跳过一次 DOM 扩队入队",
    )
    parser.add_argument(
        "--intent-missions-replace-composite",
        action="store_true",
        help="意图模式取代 strict 中 graph_guided 与 composite_seed 入队（意图默认开启；链/表单信号并入意图 LLM 上下文）",
    )
    parser.add_argument(
        "--intent-missions-only",
        action="store_true",
        help="首轮 DOM 入队后仅保留意图任务（需意图开启；需 prior/单步数据时仍执行 _enqueue_initial）",
    )
    parser.add_argument(
        "--intent-missions-second-round",
        action="store_true",
        help="在已有 session 产物上追加第二轮：不重跑 bootstrap，仅 goto+首轮入队+意图（须 --resume-session，隐式 intent-only）",
    )
    parser.add_argument(
        "--intent-mission-reserved-actions",
        type=int,
        default=10,
        metavar="N",
        help=(
            "单锚点已达 --max-actions 后，仅为 intent_mission 追加的成功步上限（默认 10）；"
            "意图默认开启时生效；--no-intent-missions 关闭意图后无意义；0 关闭"
        ),
    )
    parser.add_argument(
        "--composite-max-step-count",
        type=int,
        default=None,
        metavar="N",
        help=(
            "单条组合链/意图 YAML 内最大原子步数（默认 15）；"
            "意图任务允许的 ai 步数上限与该值取较小值。"
        ),
    )
    parser.add_argument(
        "--intent-mission-max-ai-steps",
        type=int,
        default=None,
        metavar="N",
        help=(
            "单条意图任务内 ai 步数配置上限（默认 24）；"
            "实际上限还与 --composite-max-step-count（或默认值）取小。"
        ),
    )
    parser.add_argument(
        "--intent-mission-executor",
        choices=("default", "quick", "hybrid"),
        default=None,
        help=(
            "意图任务执行器：default=原 YAML Agent；quick=直接 quick；hybrid=原链路失败后 quick fallback。"
            "未指定时读 RECURSIVE_INTENT_EXECUTOR，默认 hybrid"
        ),
    )
    parser.add_argument(
        "--intent-mission-quick-max-steps",
        type=int,
        default=None,
        metavar="N",
        help="intent_mission quick/fallback 的 --max-steps；未指定读 RECURSIVE_INTENT_QUICK_MAX_STEPS 或 QUICK_MAX_STEPS，默认 40",
    )
    parser.add_argument(
        "--intent-mission-quick-no-cdp",
        action="store_true",
        help="intent_mission quick/fallback 追加 --no-cdp；默认复用本地 CDP",
    )
    parser.add_argument(
        "--progress-log-interval-seconds",
        type=float,
        default=None,
        metavar="SEC",
        help="[explore] 进度行最小间隔（秒），默认 12；调小便于观察是否仍在跑",
    )
    parser.add_argument(
        "--progress-log-every-n-actions",
        type=int,
        default=None,
        metavar="N",
        help="全局成功步每增加 N 次至少打一条进度，默认 3",
    )
    args = parser.parse_args()

    _load_env(skill_root)

    if args.merge_site_graph:
        if not args.merge_output:
            print("使用 --merge-site-graph 时必须指定 --merge-output", file=sys.stderr)
            return 2
        from recursive_exploration.graph_store import merge_site_graphs
        from recursive_exploration.fingerprints import site_key_from_url

        paths = [Path(p) for p in args.merge_site_graph]
        if not args.url.strip():
            print("使用 --merge-site-graph 时必须提供 --url 以推导 site_key", file=sys.stderr)
            return 2
        sk = site_key_from_url(args.url)
        outp = merge_site_graphs(sk, paths, args.merge_output.expanduser())
        print(outp)
        return 0

    from recursive_exploration.config import ExecutionMode, ExplorationRunConfig
    from recursive_exploration.explorer import RecursiveExplorer

    if args.resume_session:
        out = Path(args.resume_session).expanduser()
    else:
        if not args.output_dir:
            print("未指定 --output-dir 且未使用 --resume-session", file=sys.stderr)
            return 2
        out = Path(args.output_dir).expanduser()
    if not args.resume_session and not args.url:
        print("新建运行时必须提供 --url", file=sys.stderr)
        return 2

    cfg_kw: dict = {
        "exploration_depth": args.exploration_depth,
        "max_actions": args.max_actions,
        "intent_mission_reserved_actions": max(0, int(args.intent_mission_reserved_actions)),
        "max_total_actions": args.max_total_actions,
        "composite_checkpoint_every_single_successes": args.composite_checkpoint_every,
        "max_new_urls": args.max_new_urls,
        "yaml_policy": args.yaml_policy,
        "generated_cases_filename_mode": args.generated_cases_filename,
        "execution_mode": ExecutionMode.FAST if args.execution_mode == "fast" else ExecutionMode.STRICT,
        "headless": not args.no_headless,
        "graph_guided_composite_max_hops": max(2, int(args.graph_guided_max_hops)),
    }
    if args.no_anchor_step_in_generated_cases_filename:
        cfg_kw["generated_cases_include_anchor_step_seq"] = False
    if args.disable_llm_input_mock:
        cfg_kw["use_llm_for_input_mock"] = False
    if args.composite:
        cfg_kw["composite_enabled"] = True
    if args.no_composite:
        cfg_kw["composite_enabled"] = False
    if args.graph_guided_composite:
        cfg_kw["graph_guided_composite_enabled"] = True
    if args.no_graph_guided_composite:
        cfg_kw["graph_guided_composite_enabled"] = False
    if args.prior_graph:
        cfg_kw["prior_graph_path"] = str(Path(args.prior_graph).expanduser())
    if args.incremental_composite:
        cfg_kw["incremental_composite_mode"] = True
    if args.strict_phase_traversal:
        cfg_kw["strict_phase_traversal"] = True
    elif args.no_strict_phase_traversal:
        cfg_kw["strict_phase_traversal"] = False
    if args.bootstrap_task_file:
        cfg_kw["bootstrap_task_file"] = str(Path(args.bootstrap_task_file).expanduser())
    if args.bootstrap_description:
        cfg_kw["bootstrap_description"] = args.bootstrap_description.strip()
    if args.bootstrap_continue_on_failure:
        cfg_kw["bootstrap_abort_on_failure"] = False
    if args.no_embed_bootstrap_in_yaml:
        cfg_kw["embed_bootstrap_in_generated_yaml"] = False
    if args.no_bootstrap_same_session:
        cfg_kw["bootstrap_same_session"] = False
    if args.extended_observation:
        cfg_kw["extended_observation"] = True
    if args.scroll_enumerate:
        cfg_kw["scroll_enumerate_enabled"] = True
        cfg_kw["scroll_enumerate_max_rounds"] = args.scroll_enumerate_max_rounds
        cfg_kw["scroll_enumerate_settle_ms"] = args.scroll_enumerate_settle_ms
    if args.composite_coherence:
        cfg_kw["composite_coherence_enabled"] = True
    cfg_kw["composite_coherence_mode"] = args.composite_coherence_mode
    if args.skip_rules:
        cfg_kw["skip_rules_path"] = str(Path(args.skip_rules).expanduser())
    cfg_kw["semantic_blacklist_uncertain"] = args.semantic_blacklist_uncertain
    if args.task_step_post_nav_settle_ms is not None:
        cfg_kw["task_step_post_nav_settle_ms"] = args.task_step_post_nav_settle_ms
    if args.post_action_paint_delay_ms is not None:
        cfg_kw["post_action_paint_delay_ms"] = max(0, int(args.post_action_paint_delay_ms))
    if args.screenshot_try_load_ms is not None:
        cfg_kw["screenshot_try_load_timeout_ms"] = max(0, int(args.screenshot_try_load_ms))
    if args.screenshot_paint_settle_ms is not None:
        cfg_kw["screenshot_paint_settle_ms"] = max(0, int(args.screenshot_paint_settle_ms))
    if args.screenshot_remove_highlights:
        cfg_kw["screenshot_remove_highlights_before_capture"] = True
    if args.max_equivalent_siblings is not None:
        cfg_kw["max_equivalent_siblings"] = max(0, int(args.max_equivalent_siblings))
    if args.progress_log_interval_seconds is not None:
        cfg_kw["progress_log_min_interval_seconds"] = max(0.5, float(args.progress_log_interval_seconds))
    if args.progress_log_every_n_actions is not None:
        cfg_kw["progress_log_every_n_global_actions"] = max(1, int(args.progress_log_every_n_actions))
    if args.no_url_equivalence:
        cfg_kw["url_equivalence_enabled"] = False
    if args.no_intent_missions:
        cfg_kw["intent_missions_enabled"] = False
    if args.composite_max_step_count is not None:
        cfg_kw["composite_max_step_count"] = max(2, int(args.composite_max_step_count))
    if args.intent_mission_max_ai_steps is not None:
        cfg_kw["intent_mission_max_ai_steps"] = max(1, int(args.intent_mission_max_ai_steps))
    intent_executor = (
        args.intent_mission_executor
        or (os.environ.get("RECURSIVE_INTENT_EXECUTOR") or "").strip().lower()
        or "hybrid"
    )
    if intent_executor not in {"default", "quick", "hybrid"}:
        print(
            f"非法 RECURSIVE_INTENT_EXECUTOR={intent_executor!r}，仅支持 default|quick|hybrid",
            file=sys.stderr,
        )
        return 2
    cfg_kw["intent_mission_executor"] = intent_executor
    quick_steps_default = _env_int(
        "RECURSIVE_INTENT_QUICK_MAX_STEPS",
        _env_int("QUICK_MAX_STEPS", 40),
    )
    cfg_kw["intent_mission_quick_max_steps"] = max(
        1,
        int(args.intent_mission_quick_max_steps)
        if args.intent_mission_quick_max_steps is not None
        else quick_steps_default,
    )
    cfg_kw["intent_mission_quick_no_cdp"] = bool(
        args.intent_mission_quick_no_cdp
        or _env_bool("RECURSIVE_INTENT_QUICK_NO_CDP", False)
    )
    if (os.environ.get("UI_TEST_PYTHON") or "").strip():
        cfg_kw["intent_mission_quick_python"] = os.environ["UI_TEST_PYTHON"].strip()
    cfg_kw["intent_mission_max_per_anchor"] = max(0, int(args.intent_mission_max_per_anchor))
    if args.intent_mission_suppress_dom_expand:
        cfg_kw["intent_mission_suppress_dom_expand"] = True
    if args.intent_missions_replace_composite:
        cfg_kw["intent_missions_replace_composite_planners"] = True
    if args.intent_missions_only:
        cfg_kw["intent_missions_enabled"] = True
        cfg_kw["intent_missions_execution_only"] = True
    if args.intent_missions_second_round:
        if not args.resume_session:
            print("使用 --intent-missions-second-round 时必须指定 --resume-session", file=sys.stderr)
            return 2
        cfg_kw["intent_missions_second_round"] = True
        cfg_kw["intent_missions_enabled"] = True
        cfg_kw["intent_missions_execution_only"] = True
        cfg_kw["replay_bootstrap_on_resume"] = False
    skill_root = args.skill_root or skill_root
    cfg_kw["skill_root"] = Path(skill_root)
    if args.resume_session:
        cfg_kw["resume_session_dir"] = str(Path(args.resume_session).expanduser())
    if getattr(args, "resume_reopen_entry_on_higher_budget", False):
        cfg_kw["resume_reopen_entry_on_higher_budget"] = True
    cfg = ExplorationRunConfig(**cfg_kw)
    out.mkdir(parents=True, exist_ok=True)

    if sys.stderr.isatty():
        print(
            "提示: 请在前台终端运行并关注 stderr 的 [explore] 行；"
            "可 export PYTHONUNBUFFERED=1。Agent 若用 nohup/后台会不易察觉长时间 LLM/意图任务。",
            file=sys.stderr,
            flush=True,
        )

    entry = args.url.strip() or "https://placeholder.invalid"

    async def _run() -> Path:
        ex = RecursiveExplorer(cfg)
        return await ex.run(entry, out)

    try:
        graph_path = asyncio.run(_run())
    except Exception as e:
        print(f"递归探索失败: {e}", file=sys.stderr)
        # run() 在 re-raise 前会尽力写出 review_timeline.html / exploration_report.md
        try:
            print(
                f"请仍检查产物目录（可能含部分事件与 HTML 报告）: {out.resolve()}",
                file=sys.stderr,
            )
        except Exception:
            pass
        return 3
    print(graph_path)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
