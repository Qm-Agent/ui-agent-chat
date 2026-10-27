from __future__ import annotations

from dataclasses import dataclass
from enum import Enum
from pathlib import Path
from typing import Literal

SkipRulesUncertain = Literal["allow", "skip"]
CompositeCoherenceMode = Literal["off", "rank", "strict"]
IntentMissionExecutor = Literal["default", "quick", "hybrid"]


class ExecutionMode(str, Enum):
    """执行档位：首轮在枚举用 BrowserContext 上到达锚点并入队元素；此后每条队列任务均
    「关闭上下文 → 新开窗口 → 若存在 bootstrap.yaml 则完整 replay 前置 → 再导航并重放前缀与目标动作」。"""

    STRICT = "strict"
    FAST = "fast"


@dataclass
class ExplorationRunConfig:
    """单次探索运行配置（与 OpenSpec design 对齐的子集）。"""

    exploration_depth: int = 1
    """URL 递归队列最大深度：depth=1 仅入口锚点；depth=2 另对入口执行中发现的新 URL 各跑一轮。"""

    execution_mode: ExecutionMode = ExecutionMode.FAST
    yaml_policy: Literal["all", "critical"] = "all"
    """all：每次成功动作均写 YAML，便于复现；critical：仅跨页或 structural 变化时写。"""
    generated_cases_filename_mode: Literal["task_id", "queue_seq_task_id"] = "queue_seq_task_id"
    """``generated_cases/*.yaml`` 命名：task_id=``{task_id}.yaml``；queue_seq_task_id=``{队列审计 seq:06d}_{task_id}.yaml``（与 ``bootstrap_replay_logs_task`` 子目录前缀对齐）。"""
    generated_cases_include_anchor_step_seq: bool = True
    """为 True 且 ``generated_cases_filename_mode=queue_seq_task_id`` 时在文件名前追加 ``{anchor_step_seq:04d}_``，与报告「会话内第 N 步」及 ``events.anchor_step_seq`` 一致。"""

    mock_input_text: str = "exploration_mock_input"
    """input/textarea 占位文本：仅在「未启用 LLM」或「LLM 调用失败」时回退使用，不由 CLI 指定。"""

    use_llm_for_input_mock: bool = True
    """为 True 时由 BU_* 模型根据页面与控件描述生成输入占位；False 时始终用 mock_input_text。"""

    max_actions: int = 50
    """每个 URL 锚点会话内「成功执行」的动作次数上限；各锚点独立计数，互不占额度。"""
    max_total_actions: int = 200
    """整次 run 全局累计成功动作次数上限（跨所有锚点）；达到后不再执行新的成功步。"""
    composite_checkpoint_every_single_successes: int = 15
    """每累计若干次「非组合」单步成功后，在本锚点内插入一轮组合规划入队；0 表示关闭该检查点（仍保留队列空时的组合 boost）。"""
    max_new_urls: int = 40
    """由跨页 discovery 写入 URL 队列的锚点个数上限（不含入口 URL）；达到后跳过并入队审计 `url_skip_budget`。"""
    progress_log_enabled: bool = True
    progress_log_min_interval_seconds: float = 12.0
    progress_log_every_n_global_actions: int = 3
    review_archive_interval_seconds: float = 90.0
    """>0 时在当前锚点探索过程中周期性重写 `review_timeline.html` / `timeline.json`（整 run 结束也会写）；0 表示仅在锚点结束时强制刷新审查产物。"""

    max_prefix_depth: int = 12
    max_initial_candidates: int = 25

    max_equivalent_siblings: int = 2
    """同一 DOM 骨架（CSS selector 去数字后相同）的列表行/数据卡片，只入队前 N 个；
    0 表示不限制。用于避免对 50 行数据列表逐行探索同构详情页。"""

    url_equivalence_enabled: bool = True
    """为 True 时，递归 URL 入队前按「path + 参数名集合」做等价去重：
    仅参数值不同（如 tenantId=A vs tenantId=B）的 URL 视为等价，只保留首次发现的。"""

    url_strip_trailing_slash: bool = True
    url_keep_fragment: bool = False

    site_key: str | None = None
    """为空时由入口 URL 推导（默认 registrable domain 不可得则退回 hostname）。"""

    headless: bool = True

    page_goto_timeout_ms: int = 90_000
    """Playwright page.goto 超时（毫秒）。部分文档站长时间不触发 load，需放宽或与 wait_until 配合。"""
    page_goto_wait_until: Literal["load", "domcontentloaded", "commit"] = "domcontentloaded"

    task_step_post_nav_settle_ms: int = 1200
    """每条队列任务在 bootstrap 后导航到锚点 URL 之后、截取 DOM/重放前缀之前追加等待（毫秒）。
    SPA 首次绘制与首轮枚举会话之间存在时差，易导致 branch_path_hash 与索引不一致；适度增大可提高解析命中率。"""

    page_screenshot_timeout_ms: int = 300_000
    """单次 page.screenshot 超时（毫秒）。Chromium 截图会等字体就绪，可能与 goto 超时分开配置。"""

    screenshot_try_load_timeout_ms: int = 2_500
    """写入审查用 PNG 前，在已有 domcontentloaded 等待之后，再尝试 ``wait_for_load_state(load)`` 的最大毫秒数；0 表示跳过。
    已处于 load 则立即返回；从不触发 load 的长连接 SPA 会在超时后继续截图（可能仍偏早，靠下方 rAF/休眠兜底）。"""
    screenshot_paint_raf_rounds: int = 1
    """截图前执行的「双 requestAnimationFrame」轮数（每轮链式 2 帧）。利于 Vue/React 等提交首帧绘制；0 关闭。"""
    screenshot_paint_settle_ms: int = 180
    """rAF 之后额外休眠毫秒数，给异步组件、骨架撤除与 Web 字体一点时间。"""
    screenshot_remove_highlights_before_capture: bool = False
    """为 False（默认）时，审查 PNG 可能保留 ``get_state()`` 留在页面上的 browser-use DOM 序号框；
    为 True 时在 ``page.screenshot`` 前调用 ``remove_highlights()``，得到无高亮覆盖的页面截图。"""

    post_action_settle_timeout_ms: int = 20_000
    """点击/输入等动作后，等待页面导航与 URL 稳定再采「after」状态与截图的最长时间。"""
    post_action_url_stable_ms: int = 550
    """判定地址栏 URL 不再连续跳转：需保持稳定至少该毫秒数（与轮询配合）。"""
    post_action_poll_interval_ms: int = 120
    """落地等待期间轮询 URL 的间隔。"""
    post_action_try_networkidle_ms: int = 0
    """>0 时在 DOM 就绪后额外尝试 networkidle 的最长毫秒数；长连接站点（如部分搜索页）建议保持 0。"""
    post_action_paint_delay_ms: int = 220
    """URL 稳定后再短暂等待渲染/字体，减少「过程态」截图（毫秒）。SPA 同址跳转时建议不低于约 200。"""
    post_action_new_tab_grace_ms: int = 2_000
    """target=_blank 等会在新标签打开落地页：动作后在该时间窗内等待 ``context.pages`` 稳定并刷新 ``get_current_page``，避免仍在旧标签上判定 URL 已稳定而过早截图。"""
    post_action_new_tab_quiet_ms: int = 200
    """新标签检测阶段：标签数量需连续稳定至少该毫秒后才结束该阶段（与 ``post_action_new_tab_grace_ms`` 配合）。"""
    post_action_heavy_nav_extra_deadline_ms: int = 10_000
    """当控件/链接被判定为登录、跨域导航等「慢加载」场景时，在 post_action_settle 总预算上追加的等待上限（毫秒）。"""
    post_action_heavy_nav_stable_extra_ms: int = 450
    """慢场景下在 URL 稳定判定上追加的连续稳定时长（毫秒），减轻重定向链抖动。"""
    post_action_heavy_nav_load_timeout_ms: int = 22_000
    """慢场景下在 URL 稳定后额外尝试 ``wait_for_load_state(load)`` 的超时（毫秒）；0 表示跳过。"""
    post_action_heavy_nav_after_stable_sleep_ms: int = 650
    """慢场景下 load 尝试之后、截图前追加的短暂睡眠（毫秒），给字体/骨架屏收尾。"""
    post_action_heavy_min_url_phase_ms: int = 2400
    """慢导航启发命中时：即使地址栏长时间不变（同 URL 内嵌切换/SPA），URL 稳定阶段也至少持续该毫秒，避免过早截图。"""
    post_action_heavy_ready_state_complete_timeout_ms: int = 16_000
    """慢导航启发命中时：在 URL 阶段之后额外等待 ``document.readyState === 'complete'`` 的超时（毫秒）；0 表示跳过。"""

    record_offviewport_candidates: bool = False
    """为 true 时枚举审计包含视口外可交互元素（体积更大）。"""

    # --- 滚动枚举（首轮入队阶段，通过滚动覆盖视口外交互元素）---
    scroll_enumerate_enabled: bool = False
    """为 True 时首轮入队枚举阶段通过多轮向下滚动将视口外交互元素纳入候选集。"""
    scroll_enumerate_max_rounds: int = 5
    """滚动枚举最大轮次。"""
    scroll_enumerate_settle_ms: int = 500
    """每次滚动后等待渲染稳定的时间（毫秒）。"""

    prefix_summary_max_step_chars: int = 120
    prefix_summary_max_steps: int = 20

    # --- 组合补探（strict 下 graph_guided / composite_seed 等；默认关，由 CLI --composite 等显式打开）---
    composite_enabled: bool = False
    """为 True 时允许 strict 阶段 B 的启发式 composite_seed 等需 composite 的入队；为 False 时仅单步 + scroll + 意图等。"""
    composite_max_tasks_per_anchor: int = 20
    """每锚点最多入队的组合任务数（启发式生成上限）。"""
    composite_max_step_count: int = 15
    """单条组合任务内最大原子步数；与意图任务单链 `ai` 步数实际上限（取小）共享该预算。"""
    composite_counts_toward_max_actions: bool = True
    """为 True 时组合内每一步成功仍计入 actions_executed（与 max_actions 对齐）；为 False 时可单独扩展计数策略。"""
    prior_graph_path: str | None = None
    """已有 run 的 graph.json 路径，用于增量组合时跳过已在 prior 中出现的路径键。"""
    incremental_composite_mode: bool = False
    """为 True 时跳过单步扩队，仅在启用 composite 时运行组合补探（适合持有一份图谱后的增量跑）。"""
    strict_phase_traversal: bool = True
    """为 True 时单锚点采用「先排空单步扩队 → 再一次组合规划 → 禁二次组合补规划」阶段模型；与交错检查点组合互斥，详见 openspec optimize-traversal-logic。默认 True；CLI 可用 --no-strict-phase-traversal 恢复旧版交错语义。"""
    skip_redundant_single: bool = True
    """增量模式下：规划出的路径若 dedupe_path_key 已在 prior 图谱边中则不入队。"""

    graph_guided_composite_enabled: bool = False
    """为 True 且 ``composite_enabled`` 时，在 strict 阶段 A 队列排空后，按 graph.json 成功边链入队多步组合；默认关。"""
    graph_guided_composite_max_hops: int = 3
    """图谱链最大边数（≥2）：从锚点 URL 对应节点出发，沿成功边 DFS；受 composite_max_step_count 截断。"""

    # --- 组合连贯性（版面分区，降低跨壳层乱序组合）---
    composite_coherence_enabled: bool = False
    """为 True 时按版面方位过滤/重排组合链（见 layout_context）。"""
    composite_coherence_mode: CompositeCoherenceMode = "strict"
    """strict：丢弃不协调链；rank：不协调链排到队尾；off：等价于关闭 coherent 过滤（仍可通过 composite_coherence_enabled=False 总关）。"""
    composite_coherence_llm_enabled: bool = False
    """保留：与组合语义 LLM 打分配合（当前实现以几何启发式为主）。"""
    composite_viewport_fallback_width: int = 1280
    composite_viewport_fallback_height: int = 720
    """无 bootstrap viewport 时用于版面分区的默认视口尺寸。"""

    # --- 意图 LLM 任务（多步 `ai` flow，见 OpenSpec exploration-intent-ai-missions；默认开）---
    intent_missions_enabled: bool = True
    """为 True 时在本锚点首轮 DOM 入队后，由 LLM 依图谱+页面观测生成若干条高价值 `ai` 多步任务并优先入队。"""
    intent_mission_max_per_anchor: int = 8
    """每锚点最多接受的意图任务条数（规划结果截断）；实际条数由模型在上限内决定。"""
    intent_mission_phase: Literal["anchor_start"] = "anchor_start"
    """anchor_start：首轮入队后立刻规划；其他相位保留扩展。"""
    intent_mission_suppress_dom_expand: bool = False
    """为 True 时，一条意图任务成功执行后，跳过后续**一次** DOM 扩队入队（仍保留跨页发现等）。"""
    intent_mission_max_ai_steps: int = 24
    """单条意图任务内 `ai` 步数意图上限；**实际上限**与 ``composite_max_step_count`` 取较小值（与组合任务共享单链步数预算）。"""
    intent_mission_max_step_chars: int = 500
    """单条 `ai` 自然语言步的最大字符数。"""
    intent_missions_replace_composite_planners: bool = False
    """为 True 且 ``intent_missions_enabled`` 时，strict 阶段不再入队图谱链 graph_guided 与 composite_seed 启发式组合；同类信号通过意图规划 LLM 的附加上下文提供。"""
    intent_missions_execution_only: bool = False
    """为 True 且 ``intent_missions_enabled`` 时，在 ``_enqueue_initial`` 与意图入队之后丢弃队列中的单步任务，仅保留 ``intent_mission``（在已有候选/dedupe 数据上只跑意图 YAML）。"""
    intent_missions_second_round: bool = False
    """为 True 时须配合 ``resume_session_dir``：不重跑 bootstrap Agent（含续跑时的子进程前置），首轮枚举与各任务步均跳过 ``replay_bootstrap_agent``；用于在已有产物目录上追加第二轮意图规划与执行。"""
    intent_mission_reserved_actions: int = 10
    """当单锚点「普通」成功步已达 ``max_actions`` 但队列中仍有 ``intent_mission`` 未执行时，仅为意图任务追加的成功步上限；非意图任务此时不再出队。``intent_missions_enabled`` 为 False 或本值为 0 时等效关闭。"""
    intent_mission_synthesize_when_empty: bool = True
    """为 True 时，若 LLM 校验后无任何合法 mission，则基于当前锚点的成功图谱边与页面摘要确定性合成端到端步骤（避免模型过度保守返回空）。"""
    intent_mission_continuation_rounds: int = 1
    """首轮 intent YAML 完成后，在同一浏览器上下文中追加的「深化续写」轮数（每轮先 LLM 再执行一段仅含新 ai 步的 YAML）。0 表示关闭。"""
    intent_mission_continuation_max_steps: int = 12
    """单轮深化续写里允许的 ``ai`` 步数上限（与 ``intent_mission_max_step_chars`` 配合）。"""
    intent_mission_enqueue_discovered_urls: bool = False
    """意图任务成功后，若页面跳转到新 URL，是否按原逻辑将新 URL 入队。False 时更适合「只向纵深挖、不扩站点面」的意图模式。"""
    intent_mission_executor: IntentMissionExecutor = "hybrid"
    """意图任务执行器：default=仅原 YAML Agent；quick=直接 browser-use quick；hybrid=先原链路，失败后 quick fallback。"""
    intent_mission_quick_max_steps: int = 25
    """intent_mission 使用 quick/fallback 时传给 browser-use quick 的 --max-steps。"""
    intent_mission_quick_no_cdp: bool = False
    """为 True 时 intent_mission quick/fallback 追加 --no-cdp；默认 False，复用本地 CDP。"""
    intent_mission_quick_python: str | None = None
    """intent_mission quick/fallback 使用的 Python；为空时读 UI_TEST_PYTHON 或当前解释器。"""

    # --- 探索黑名单（默认文件见技能根 ``config/skip_rules.json``，由 resolve_skip_rules_path 解析）---
    skip_rules_path: str | None = None
    """显式黑名单 YAML/JSON 路径；为 None 时若 ``{skill_root}/config/skip_rules.json`` 存在则自动加载。"""
    semantic_blacklist_uncertain: SkipRulesUncertain = "allow"
    """语义规则 LLM 返回 uncertain 时：allow=放行；skip=保守跳过。"""

    # --- Bootstrap（探索底座：先于主探索执行前置 YAML / 描述）---
    bootstrap_task_file: str | None = None
    """前置流程 YAML 路径（browser_use.cli 可执行）；与 bootstrap_description 二选一或同时给出时优先级见文档。"""
    bootstrap_description: str | None = None
    """自然语言前置描述；运行时生成短时 YAML 再执行。"""
    bootstrap_abort_on_failure: bool = True
    """bootstrap 失败时中止整次探索（默认 True）；False 则记录警告后以入口 URL 裸起探索。"""
    replay_bootstrap_on_resume: bool = True
    """resume 时是否默认重跑 bootstrap（与 OpenSpec 「replay bootstrap then resume」对齐）。"""
    embed_bootstrap_in_generated_yaml: bool = True
    """为 True 且产物目录存在 bootstrap.yaml 时，将其 flow 前置合并进每个 generated_cases YAML（独立回放「前置+探索」）。"""
    bootstrap_same_session: bool = True
    """为 True 时不在子进程单独跑前置 CLI；由探索主体会话内重放 bootstrap.yaml，并以重放结束后的当前 URL/页面状态作为首个锚点（前置仅用于到达该态）。"""
    skill_root: Path | None = None
    """技能根目录（bootstrap 描述转 YAML、load_dotenv）；默认由 CLI 推导。"""

    # --- Session / 观测 ---
    extended_observation: bool = False
    """为 True 时在观测中附带标题层级、面包屑/tab、浮层与表格列头等扩展摘要（启发式）。"""

    resume_session_dir: str | None = None
    """非空时从该目录加载 session_state.json 并 resume-strict 续跑（CLI 写入）。"""
    resume_reopen_entry_on_higher_budget: bool = False
    """续跑默认行为：在断点处继续，不主动改变参数语义。仅当本值为 True 且本次 ``max_actions`` 大于上次快照时，
    才把入口 URL 重新放进 pending 以消耗新增预算；其余情况按 ``pending_urls`` / 状态原样恢复。"""
    # --- 滚动（视口不完整时扩队）---
    scroll_enabled: bool = True
    scroll_max_per_anchor: int = 5
    scroll_delta_y_px: int = 720
    """每次视口滚动像素（向下为正）。"""
    page_scrollable_ratio: float = 1.15
    """documentElement.scrollHeight / clientHeight 超过该值视为可纵向滚动。"""
    scroll_viewport_free_ratio: float = 0.85
    """当 scrollTop + clientHeight < scrollHeight * 该比例时认为仍未触底，可继续滚。"""

    def __post_init__(self) -> None:
        if self.exploration_depth < 1:
            raise ValueError("exploration_depth MUST be >= 1")
        if self.max_actions < 1:
            raise ValueError("max_actions MUST be >= 1")
        if self.max_total_actions < 1:
            raise ValueError("max_total_actions MUST be >= 1")
        if self.composite_max_tasks_per_anchor < 0:
            raise ValueError("composite_max_tasks_per_anchor MUST be >= 0")
        if self.composite_max_step_count < 2:
            raise ValueError("composite_max_step_count MUST be >= 2")
        if self.scroll_max_per_anchor < 0:
            raise ValueError("scroll_max_per_anchor MUST be >= 0")
        if self.strict_phase_traversal and self.incremental_composite_mode:
            raise ValueError("strict_phase_traversal 与 incremental_composite_mode 不能同时为 True")
        if self.max_new_urls < 0:
            raise ValueError("max_new_urls MUST be >= 0")
        if self.graph_guided_composite_max_hops < 2:
            raise ValueError("graph_guided_composite_max_hops MUST be >= 2")
        if self.intent_mission_executor not in ("default", "quick", "hybrid"):
            raise ValueError("intent_mission_executor MUST be default|quick|hybrid")
        if self.intent_mission_quick_max_steps < 1:
            raise ValueError("intent_mission_quick_max_steps MUST be >= 1")
        if self.composite_viewport_fallback_width < 100:
            raise ValueError("composite_viewport_fallback_width MUST be >= 100")
        if self.composite_viewport_fallback_height < 100:
            raise ValueError("composite_viewport_fallback_height MUST be >= 100")
        if self.post_action_heavy_nav_extra_deadline_ms < 0:
            raise ValueError("post_action_heavy_nav_extra_deadline_ms MUST be >= 0")
        if self.post_action_heavy_nav_stable_extra_ms < 0:
            raise ValueError("post_action_heavy_nav_stable_extra_ms MUST be >= 0")
        if self.post_action_heavy_nav_load_timeout_ms < 0:
            raise ValueError("post_action_heavy_nav_load_timeout_ms MUST be >= 0")
        if self.post_action_heavy_nav_after_stable_sleep_ms < 0:
            raise ValueError("post_action_heavy_nav_after_stable_sleep_ms MUST be >= 0")
        if self.post_action_heavy_min_url_phase_ms < 0:
            raise ValueError("post_action_heavy_min_url_phase_ms MUST be >= 0")
        if self.post_action_heavy_ready_state_complete_timeout_ms < 0:
            raise ValueError("post_action_heavy_ready_state_complete_timeout_ms MUST be >= 0")
        if self.post_action_new_tab_grace_ms < 0:
            raise ValueError("post_action_new_tab_grace_ms MUST be >= 0")
        if self.post_action_new_tab_quiet_ms < 0:
            raise ValueError("post_action_new_tab_quiet_ms MUST be >= 0")
        if self.task_step_post_nav_settle_ms < 0:
            raise ValueError("task_step_post_nav_settle_ms MUST be >= 0")
        if self.intent_mission_max_per_anchor < 0:
            raise ValueError("intent_mission_max_per_anchor MUST be >= 0")
        if self.intent_mission_max_ai_steps < 1:
            raise ValueError("intent_mission_max_ai_steps MUST be >= 1")
        if self.intent_mission_max_step_chars < 20:
            raise ValueError("intent_mission_max_step_chars MUST be >= 20")
        if self.intent_mission_continuation_rounds < 0:
            raise ValueError("intent_mission_continuation_rounds MUST be >= 0")
        if self.intent_mission_continuation_max_steps < 2:
            raise ValueError("intent_mission_continuation_max_steps MUST be >= 2")
