from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Literal

ActionKind = Literal["click", "input", "scroll", "intent_mission"]

TaskKind = Literal["single", "composite", "intent_mission"]

TaskSource = Literal[
    "single_expand",
    "composite_planner",
    "scroll_heuristic",
    "incremental_composite",
    "graph_guided_composite",
    "intent_mission",
]

GraphKind = Literal["run", "site_merged"]

StartKind = Literal["entry_url", "bootstrap"]


@dataclass
class StartContext:
    """图谱 run 成立前提（写入 graph run_meta / session）。"""

    start_kind: StartKind = "entry_url"
    bootstrap_used: bool = False
    bootstrap_ref: str | None = None
    """产物内 bootstrap YAML 相对路径或描述摘要标识。"""
    bootstrap_last_url: str | None = None
    environment_summary: str = ""
    auth_summary: str = ""
    tenant_summary: str = ""
    seed_page_state_id: str | None = None
    seed_structural_state_id: str | None = None

    def to_run_meta_dict(self) -> dict[str, Any]:
        return {
            "start_kind": self.start_kind,
            "bootstrap_used": self.bootstrap_used,
            "bootstrap_ref": self.bootstrap_ref,
            "bootstrap_last_url": self.bootstrap_last_url,
            "environment_summary": self.environment_summary,
            "auth_summary": self.auth_summary,
            "tenant_summary": self.tenant_summary,
            "seed_page_state_id": self.seed_page_state_id,
            "seed_structural_state_id": self.seed_structural_state_id,
        }


@dataclass
class BootstrapResult:
    """Bootstrap 阶段执行结果（写入 session / 报告侧）。"""

    ok: bool
    result: Literal["ok", "failed", "skipped"]
    last_url: str = ""
    flow_ref: str | None = None
    state_summary: dict[str, Any] = field(default_factory=dict)
    error: str | None = None


@dataclass
class ExplorationStep:
    """可重放一步（优先 branch_path_hash，降级 index）。"""

    element_index: int
    branch_path_hash: str
    tap_description: str
    locate_prompt: str = ""
    """供 YAML 的 aiTap/aiInput locate 使用，避免仅依赖 DOM 索引。"""
    step_kind: Literal["click", "input", "scroll"] = "click"
    input_value: str = ""
    """step_kind=input 时重放写入的文本。"""
    scroll_delta_y: int = 0
    """step_kind=scroll 时纵向滚动像素（向下为正）。"""
    # --- 多信号匹配字段（用于 Tier 3 解析） ---
    attributes_hash: str = ""
    """元素属性哈希，用于 DOM 重排后的属性级匹配。"""
    tag_name: str = ""
    """元素标签名（小写），用于打分匹配。"""
    css_selector_hint: str = ""
    """CSS 选择器（辅助调试和精确定位）。"""
    text_content: str = ""
    """元素可见文本（截断），用于模糊匹配。"""


@dataclass
class ActionTask:
    task_id: str
    run_id: str
    anchor_url: str
    anchor_url_norm: str
    dedupe_path_key: str
    prefix_steps: list[ExplorationStep]
    target_index: int
    target_branch_path_hash: str
    target_description: str
    action_kind: ActionKind = "click"
    """click：点击；input：对 input/textarea 等执行输入（使用 mock_input_text）。"""
    input_mock_value: str = ""
    """input 动作写入值；空串则使用 ExplorationRunConfig.mock_input_text。"""
    locate_prompt: str = ""
    """YAML 与审查用的自然语言定位，优先于带索引的 tap_description。"""
    anchor_depth: int = 0
    """0=用户入口锚点；从该锚点执行中发现的跨页 URL 作为新锚点时为 1，以此类推。"""
    task_kind: TaskKind = "single"
    composite_plan_id: str = ""
    """非空时表示同属一次组合规划（事件 extra 可对齐）。"""
    task_source: TaskSource = "single_expand"
    """队列/报告区分任务来源。"""
    composite_steps: list[ExplorationStep] = field(default_factory=list)
    """task_kind=composite 时按序执行；与单步模式互斥于 target_* 的语义由执行器约定。"""
    scroll_delta_y: int = 0
    """action_kind=scroll 时使用；默认 0 表示由配置 scroll_delta_y_px 决定。"""
    discovered_by_scroll: bool = False
    """为 True 时表示该任务的目标元素由滚动枚举（首轮入队滚动覆盖）发现，执行时需 scrollIntoView。"""
    # --- 多信号匹配字段（用于 Tier 3 解析） ---
    target_attributes_hash: str = ""
    """目标元素属性哈希。"""
    target_tag_name: str = ""
    """目标元素标签名（小写）。"""
    target_css_selector_hint: str = ""
    """目标元素 CSS 选择器（辅助调试）。"""
    target_text_content: str = ""
    """目标元素可见文本（截断）。"""
    intent_ai_steps: list[str] = field(default_factory=list)
    """task_kind=intent_mission 时：按序多条自然语言，对应 YAML 中多条 `ai` 步。"""


@dataclass
class UrlTask:
    """待二次遍历的锚点 URL（受 exploration_depth 约束）。"""

    url_norm: str
    raw_url: str
    anchor_depth: int


@dataclass
class GraphEdgeRecord:
    """写入 graph.json 的边（与 OpenSpec 字段子集对齐）。"""

    edge_id: str
    from_node_id: str
    to_node_id: str
    action_type: str
    action_fingerprint: str
    anchor_url_norm: str
    prefix_steps_ref: str | None
    result: str
    url_changed: bool
    screenshots: dict[str, str]
    run_id: str
    event_id: str
    dedupe_path_key: str
    yaml_ref: str | None = None
    merged_from: list[dict[str, str]] | None = None
    prefix_steps_summary: list[str] = field(default_factory=list)
    target_step: dict[str, Any] = field(default_factory=dict)
    action_tag: str = ""
    """启发式语义标签：login/nav/search/filter/open_detail/create/submit/back/unknown。"""


@dataclass
class GraphNodeRecord:
    node_id: str
    url_norm: str
    raw_url: str
    structural_state_id: str
    page_state_id: str
    title: str
    first_seen_at: str
    last_seen_at: str
    seen_run_ids: list[str] = field(default_factory=list)


@dataclass
class ExplorationEvent:
    """events.jsonl 单行结构。"""

    schema: str = "exploration-event/v1"
    event_id: str = ""
    run_id: str = ""
    ts: str = ""
    kind: str = "action_result"
    anchor_url_norm: str = ""
    anchor_url: str = ""  # 本会话重放根（与 task.anchor_url 一致，报告用）
    dedupe_path_key: str = ""
    from_node_id: str = ""
    to_node_id: str = ""
    edge_id: str = ""
    url_before: str = ""
    url_after: str = ""
    structural_before: str = ""
    structural_after: str = ""
    page_state_before: str = ""
    page_state_after: str = ""
    action_fingerprint: str = ""
    result: str = ""
    skip_reason: str | None = None
    screenshots: dict[str, str] | None = None
    task_id: str | None = None
    target_step: dict[str, Any] | None = None
    queue_seq: int | None = None
    anchor_step_seq: int | None = None
    """当前锚点会话内 action_result 序号（1-based），与 narrative 报告「会话内第 N 步」一致。"""
    anchor_depth: int | None = None
    """当前任务所属 URL 锚点层级（0=入口）。"""
    task_source: str | None = None
    """single_expand / composite_planner / scroll_heuristic / incremental_composite。"""
    composite_plan_id: str | None = None
    action_kind: str | None = None
    """与 target_step.kind 一致时便于过滤；scroll 等可顶格记录。"""
    yaml_flow_total: int | None = None
    """对应 generated_cases YAML 中 tasks[0].flow 的总步数（含 aiWaitFor）。"""
    yaml_flow_target_index: int | None = None
    """本动作为 flow 中第几步（1-based，与 yaml_flow_total 相同表示末步 target）。"""
    step_origin: str | None = None
    """single_native | single_expand | composite · HTML 审查来源标签。"""
    composite_atomic_index: int | None = None
    """组合任务内原子步序号（1-based）；非组合步为 None。"""
    composite_atomic_total: int | None = None
    """组合任务原子步总数；非组合步为 None。"""
    extra: dict[str, Any] = field(default_factory=dict)

    def to_json_obj(self) -> dict[str, Any]:
        d: dict[str, Any] = {
            "schema": self.schema,
            "event_id": self.event_id,
            "run_id": self.run_id,
            "ts": self.ts,
            "kind": self.kind,
            "anchor_url_norm": self.anchor_url_norm,
            "dedupe_path_key": self.dedupe_path_key,
            "from_node_id": self.from_node_id,
            "to_node_id": self.to_node_id,
            "edge_id": self.edge_id,
            "url_before": self.url_before,
            "url_after": self.url_after,
            "structural_before": self.structural_before,
            "structural_after": self.structural_after,
            "page_state_before": self.page_state_before,
            "page_state_after": self.page_state_after,
            "action_fingerprint": self.action_fingerprint,
            "result": self.result,
            "skip_reason": self.skip_reason,
            "screenshots": self.screenshots,
        }
        if self.anchor_url:
            d["anchor_url"] = self.anchor_url
        if self.task_id:
            d["task_id"] = self.task_id
        if self.target_step:
            d["target_step"] = self.target_step
        if self.queue_seq is not None:
            d["queue_seq"] = self.queue_seq
        if self.anchor_step_seq is not None:
            d["anchor_step_seq"] = self.anchor_step_seq
        if self.anchor_depth is not None:
            d["anchor_depth"] = self.anchor_depth
        if self.task_source:
            d["task_source"] = self.task_source
        if self.composite_plan_id:
            d["composite_plan_id"] = self.composite_plan_id
        if self.action_kind:
            d["action_kind"] = self.action_kind
        if self.yaml_flow_total is not None:
            d["yaml_flow_total"] = self.yaml_flow_total
        if self.yaml_flow_target_index is not None:
            d["yaml_flow_target_index"] = self.yaml_flow_target_index
        if self.step_origin:
            d["step_origin"] = self.step_origin
        if self.composite_atomic_index is not None:
            d["composite_atomic_index"] = self.composite_atomic_index
        if self.composite_atomic_total is not None:
            d["composite_atomic_total"] = self.composite_atomic_total
        if self.extra:
            d["extra"] = self.extra
        return d
