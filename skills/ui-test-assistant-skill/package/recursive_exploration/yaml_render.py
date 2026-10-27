from __future__ import annotations

import json
import os
import re
from pathlib import Path
from typing import Any, Literal
from urllib.parse import urlparse

# 与 browser_use aiWaitFor 的 timeout（毫秒）对齐；可用环境变量覆盖（默认 90s）
def _parse_ai_waitfor_timeout_ms() -> int:
    raw = (os.environ.get("BU_AI_WAITFOR_TIMEOUT_MS") or "").strip()
    if not raw:
        return 90_000
    try:
        return max(1000, int(raw))
    except ValueError:
        return 90_000


_DEFAULT_AI_WAITFOR_TIMEOUT_MS = _parse_ai_waitfor_timeout_ms()


def _ai_waitfor_flow_item(message: str) -> dict[str, Any]:
    return {"aiWaitFor": message, "timeout": _DEFAULT_AI_WAITFOR_TIMEOUT_MS}

# 捕获 locate 等字段中「链接→」后的绝对 URL（遇空白、间隔号「·」等截止）
_LINK_ARROW_URL_RE = re.compile(r"链接→(https?://[^\s·]+)", re.IGNORECASE)

from recursive_exploration.models import ActionTask, ExplorationStep

try:
    import yaml
except ImportError as e:  # pragma: no cover
    yaml = None  # type: ignore[assignment]
    _yaml_err = e
else:
    _yaml_err = None

GeneratedCasesFilenameMode = Literal["task_id", "queue_seq_task_id"]


def generated_cases_yaml_filename(
    task_id: str,
    *,
    queue_seq: int | None,
    anchor_step_seq: int | None = None,
    include_anchor_step: bool = True,
    mode: GeneratedCasesFilenameMode = "queue_seq_task_id",
) -> str:
    """
    ``generated_cases/`` 下 YAML 文件名（不含目录）。

    ``queue_seq_task_id``：默认可选 ``{anchor_step_seq:04d}_{queue_seq:06d}_{task_id}.yaml``；
    ``include_anchor_step=False`` 或未提供 ``anchor_step_seq`` 时为 ``{queue_seq:06d}_{task_id}.yaml``。
    与同次 run 中 ``bootstrap_replay_logs_task/<seq>_<task_id>/`` 的 ``seq``（queue）一致。
    ``queue_seq`` 缺失时回退为仅 ``task_id``。
    """
    if mode == "task_id" or queue_seq is None:
        return f"{task_id}.yaml"
    ap = ""
    if include_anchor_step and anchor_step_seq is not None:
        ap = f"{int(anchor_step_seq):04d}_"
    return f"{ap}{int(queue_seq):06d}_{task_id}.yaml"


def parse_bootstrap_yaml_flow_steps(bootstrap_yaml_path: Path) -> list[dict[str, Any]]:
    """
    读取 bootstrap.yaml 中全部 tasks[].flow，按顺序扁平化为步骤列表（深拷贝 dict）。
    文件不存在或解析失败时返回 []。
    """
    if yaml is None:
        return []
    path = Path(bootstrap_yaml_path)
    if not path.is_file():
        return []
    try:
        raw = path.read_text(encoding="utf-8")
        data = yaml.safe_load(raw)
    except Exception:
        return []
    if not isinstance(data, dict):
        return []
    out: list[dict[str, Any]] = []
    for t in data.get("tasks") or []:
        if not isinstance(t, dict):
            continue
        flow = t.get("flow") or []
        if not isinstance(flow, list):
            continue
        for step in flow:
            if isinstance(step, dict):
                out.append(dict(step))
    return out


def read_bootstrap_target_overlay(bootstrap_yaml_path: Path) -> dict[str, Any]:
    """
    读取 bootstrap.yaml 的 target，供 generated_cases 合并（保留 viewport、cookie 等与用户输入一致）。
    url 不写在此（由 write_task_yaml 用锚点覆盖）。
    cookie：YAML 数组、单行/多行 JSON 字符串、或 ``*.json`` 路径均可；输出为 browser_use 可解析的单行 JSON 字符串。
    """
    if yaml is None:
        return {}
    path = Path(bootstrap_yaml_path)
    if not path.is_file():
        return {}
    try:
        raw_text = path.read_text(encoding="utf-8")
        data = yaml.safe_load(raw_text)
    except Exception:
        return {}
    if not isinstance(data, dict):
        return {}
    tgt = data.get("target")
    if not isinstance(tgt, dict):
        return {}
    base_dir = path.parent
    out: dict[str, Any] = {}
    for k, v in tgt.items():
        if k == "url":
            continue
        if k == "cookie":
            out[k] = _normalize_cookie_for_yaml_target(v, base_dir=base_dir)
        else:
            out[k] = v
    return out


def _parse_cookie_json_string(s: str) -> list[Any] | dict[str, Any] | None:
    """解析 target.cookie 的长 JSON 字符串；兼容带换行的合法 JSON。"""
    s = s.strip()
    if not s or s == "[]":
        return []
    for candidate in (s, re.sub(r"[\n\r]+", "", s)):
        try:
            parsed = json.loads(candidate)
            if isinstance(parsed, (list, dict)):
                return parsed
        except json.JSONDecodeError:
            continue
    return None


def _normalize_cookie_for_yaml_target(raw: Any, *, base_dir: Path) -> str:
    """规范为 YAML 中单行字符串（内联 JSON 或 '[]'）。"""
    if raw is None:
        return "[]"
    if isinstance(raw, list):
        if not raw:
            return "[]"
        return json.dumps(raw, ensure_ascii=False, separators=(",", ":"))
    if isinstance(raw, dict):
        return json.dumps(raw, ensure_ascii=False, separators=(",", ":"))
    s = str(raw).strip()
    if not s or s == "[]":
        return "[]"
    loose = _parse_cookie_json_string(s)
    if loose is not None:
        if isinstance(loose, list):
            if not loose:
                return "[]"
            return json.dumps(loose, ensure_ascii=False, separators=(",", ":"))
        return json.dumps(loose, ensure_ascii=False, separators=(",", ":"))
    p = Path(s).expanduser()
    if not p.is_absolute():
        p = base_dir / p
    if p.is_file():
        try:
            txt = p.read_text(encoding="utf-8")
            data = json.loads(txt)
            if isinstance(data, list):
                return json.dumps(data, ensure_ascii=False, separators=(",", ":"))
        except Exception:
            pass
    return s


def _task_heuristic_text(task: ActionTask) -> str:
    parts: list[str] = [
        task.locate_prompt or "",
        task.target_description or "",
    ]
    for st in task.prefix_steps:
        parts.extend([st.locate_prompt or "", st.tap_description or ""])
    return " ".join(parts)


def _extract_arrow_urls(text: str) -> list[str]:
    """从探测文案中提取「链接→」后的 http(s) URL。"""
    out: list[str] = []
    for m in _LINK_ARROW_URL_RE.finditer(text or ""):
        u = m.group(1).strip().rstrip(".,;:\"'」）]")
        if u.startswith("http"):
            out.append(u)
    return out


def _urls_from_task(task: ActionTask) -> list[str]:
    seen: set[str] = set()
    uniq: list[str] = []
    for chunk in (
        [task.locate_prompt or "", task.target_description or ""]
        + [x for st in task.prefix_steps for x in (st.locate_prompt or "", st.tap_description or "")]
    ):
        for u in _extract_arrow_urls(chunk):
            if u not in seen:
                seen.add(u)
                uniq.append(u)
    return uniq


def _normalize_hostname(host: str | None) -> str:
    """比较用：小写、去首尾点、去掉前缀 www.。"""
    if not host:
        return ""
    h = host.lower().strip(".")
    if h.startswith("www."):
        h = h[4:]
    return h


def extra_ai_wait_prompts_before_target(task: ActionTask) -> list[str]:
    """
    在「最终目标动作」前插入的动态 aiWaitFor 文案。
    规则仅依赖 **anchor_url** 与文案中 **链接→URL** 的解析对比，不维护站点白名单。
    """
    blob_lower = _task_heuristic_text(task).lower()
    anchor = urlparse(task.anchor_url or "")
    ah = _normalize_hostname(anchor.hostname)
    apath = (anchor.path or "/").rstrip("/") or "/"
    aquery = anchor.query or ""

    out: list[str] = []
    seen: set[str] = set()

    def add(msg: str) -> None:
        if msg not in seen:
            seen.add(msg)
            out.append(msg)

    urls = _urls_from_task(task)

    # 基于 URL 路径语义的通用提示（任意站点）
    for u in urls:
        try:
            pu = urlparse(u)
        except Exception:
            continue
        pl = (pu.path or "").lower()
        if any(seg in pl for seg in ("/signin", "/login", "/oauth", "/authorize")) or "servicelogin" in pl:
            add("账号或登录流程页面加载完成，主要内容区域可见且可交互")
        if "/products" in pl or pl.rstrip("/").endswith("/products"):
            add("目录或产品介绍区域展开/渲染完成后再操作目标")

    cross_host = False
    intra_site_route = False
    for u in urls:
        try:
            pu = urlparse(u)
        except Exception:
            continue
        nh = _normalize_hostname(pu.hostname)
        if not nh:
            continue
        if ah and nh != ah:
            cross_host = True
            continue
        lpath = (pu.path or "/").rstrip("/") or "/"
        lquery = pu.query or ""
        if lpath != apath or (lquery and lquery != aquery):
            intra_site_route = True

    if cross_host:
        add("目标链接与当前会话锚点主机不一致，等待导航完成后主要内容与可交互控件稳定")
    elif intra_site_route:
        add("当前站点内路径或查询参数将发生变化，等待页面主要内容与交互控件稳定")

    # 无结构化链接时，仅用保守子串兜底（避免强绑定具体域名）
    if not urls:
        if any(
            k in blob_lower
            for k in (
                "/oauth",
                "/signin",
                "/login",
                "servicelogin",
                "authorize?",
            )
        ):
            add("检测到登录或授权相关路径文案，页面主要内容区域加载完成后再操作")

    return out


def post_action_slow_navigation_hint(task: ActionTask) -> bool:
    """与 extra_ai_wait_prompts_before_target 一致的运行时应加强落地等待。"""
    return len(extra_ai_wait_prompts_before_target(task)) > 0


def final_assert_flow_item(page_title_after: str | None, page_url_after: str | None) -> dict[str, Any] | None:
    """动作完成后基于落地页生成一条「软」文本断言；无法构造时返回 None（不写断言步）。"""
    title = (page_title_after or "").strip()
    if len(title) >= 2:
        snip = title[:100].replace('"', "'")
        return {"aiAssert": f'页面可见标题或主要内容区域应出现与「{snip}」语义一致的文案或控件'}
    raw = (page_url_after or "").strip()
    if raw:
        host = urlparse(raw).hostname or ""
        if host:
            return {"aiAssert": f'页面已加载，文档主体区域应包含与站点「{host}」上下文一致的可见内容'}
    return None


def _flow_step_dict_for_tap(step: ExplorationStep) -> dict[str, Any]:
    """aiTap：优先自然语言 locate_prompt；否则去掉 [索引] 前缀后用 DOM 摘要。"""
    lp = (step.locate_prompt or "").strip()
    if lp:
        return {"aiTap": lp[:200]}
    t = (step.tap_description or "").strip()
    if t.startswith("[") and "]" in t:
        t = t.split("]", 1)[-1].strip()
    return {"aiTap": (t[:200] if t else "可点击元素")}


def _flow_step_from_exploration_step(st: ExplorationStep, *, default_input_text: str) -> dict[str, Any]:
    if st.step_kind == "scroll":
        d = int(st.scroll_delta_y or 0) or 720
        return {"aiScroll": f"向下滚动约 {d} 像素"}
    if st.step_kind == "input" and (st.input_value or default_input_text):
        val = (st.input_value or default_input_text).strip()
        loc = (st.locate_prompt or "").strip()
        if loc:
            return {"aiInput": val[:500], "locate": loc[:200]}
        return {"aiInput": val[:500]}
    return _flow_step_dict_for_tap(st)


def _flow_core_for_task(task: ActionTask, *, default_input_text: str) -> list[dict[str, Any]]:
    """不含末尾断言的核心 flow。"""
    if task.task_kind == "intent_mission" and task.intent_ai_steps:
        flow_im: list[dict[str, Any]] = [_ai_waitfor_flow_item("页面加载完成")]
        for s in task.intent_ai_steps:
            t = (s or "").strip()
            if t:
                flow_im.append({"ai": t[:500]})
        if len(flow_im) <= 1:
            flow_im.append({"ai": "在当前页面完成与站点主题一致的核心交互并确认界面有可见反馈"})
        return flow_im

    flow: list[dict[str, Any]] = [_ai_waitfor_flow_item("页面加载完成")]
    for st in task.prefix_steps:
        flow.append(_flow_step_from_exploration_step(st, default_input_text=default_input_text))

    if task.task_kind == "composite" and task.composite_steps:
        for st in task.composite_steps:
            flow.append(_flow_step_from_exploration_step(st, default_input_text=default_input_text))
        return flow

    for msg in extra_ai_wait_prompts_before_target(task):
        flow.append(_ai_waitfor_flow_item(msg))

    input_val = (task.input_mock_value or "").strip() or default_input_text
    if task.action_kind == "input":
        loc = (task.locate_prompt or "").strip()
        if loc:
            flow.append({"aiInput": input_val[:500], "locate": loc[:200]})
        else:
            flow.append({"aiInput": input_val[:500]})
    elif task.action_kind == "scroll":
        d = int(task.scroll_delta_y or 0) or 720
        flow.append({"aiScroll": f"向下滚动约 {d} 像素"})
    else:
        flow.append(_flow_step_dict_for_tap(_synth_target_step(task)))

    return flow


def build_complete_flow(
    task: ActionTask,
    *,
    default_input_text: str,
    page_title_after: str = "",
    page_url_after: str = "",
    bootstrap_flow_prefix: list[dict[str, Any]] | None = None,
) -> list[dict[str, Any]]:
    """完整可执行 flow：可选前置 bootstrap 步骤 + 核心步骤 + 可选落地页断言。"""
    bp = list(bootstrap_flow_prefix or [])
    flow = bp + _flow_core_for_task(task, default_input_text=default_input_text)
    fin = final_assert_flow_item(page_title_after, page_url_after)
    if fin:
        flow.append(fin)
    return flow


def _synth_target_step(task: ActionTask) -> ExplorationStep:
    """用任务的 target 字段合成 ExplorationStep，复用 tap 的 flow 规则。"""
    return ExplorationStep(
        element_index=task.target_index,
        branch_path_hash=task.target_branch_path_hash,
        tap_description=task.target_description,
        locate_prompt=task.locate_prompt,
        step_kind="click",
    )


def yaml_meta_single_success(
    task: ActionTask,
    *,
    default_input_text: str,
    page_title_after: str,
    page_url_after: str,
    bootstrap_flow_prefix: list[dict[str, Any]] | None = None,
) -> tuple[int, int]:
    """单步任务成功：返回 (flow 总长, 本动作在 flow 中的 1-based 步号)。"""
    bp = bootstrap_flow_prefix or []
    flow = build_complete_flow(
        task,
        default_input_text=default_input_text,
        page_title_after=page_title_after,
        page_url_after=page_url_after,
        bootstrap_flow_prefix=bp,
    )
    yft = len(flow)
    if task.task_kind == "intent_mission" and task.intent_ai_steps:
        return yft, yft
    extras = len(extra_ai_wait_prompts_before_target(task))
    yti = len(bp) + 1 + len(task.prefix_steps) + extras + 1
    return yft, yti


def yaml_meta_composite_atomic_step(
    task: ActionTask,
    *,
    composite_step_index_zero_based: int,
    default_input_text: str,
    page_title_after: str,
    page_url_after: str,
    bootstrap_flow_prefix: list[dict[str, Any]] | None = None,
) -> tuple[int, int]:
    """组合任务内某一原子步：yti 对应该原子步在完整 flow 中的位置。"""
    bp = bootstrap_flow_prefix or []
    flow = build_complete_flow(
        task,
        default_input_text=default_input_text,
        page_title_after=page_title_after,
        page_url_after=page_url_after,
        bootstrap_flow_prefix=bp,
    )
    yft = len(flow)
    yti = len(bp) + 1 + len(task.prefix_steps) + composite_step_index_zero_based + 1
    return yft, yti


def yaml_meta_failed_or_skipped(
    task: ActionTask,
    *,
    default_input_text: str = "",
    bootstrap_flow_prefix: list[dict[str, Any]] | None = None,
) -> tuple[int, int]:
    """未写出带落地断言的 YAML 时，仅按核心 flow 长度占位。"""
    bp = bootstrap_flow_prefix or []
    core = bp + _flow_core_for_task(task, default_input_text=default_input_text)
    n = len(core)
    return n, n


def flow_core_length(
    task: ActionTask,
    *,
    default_input_text: str,
    bootstrap_flow_prefix: list[dict[str, Any]] | None = None,
) -> int:
    bp = bootstrap_flow_prefix or []
    return len(bp) + len(_flow_core_for_task(task, default_input_text=default_input_text))


def write_task_yaml(
    task: ActionTask,
    path: Path,
    *,
    default_input_text: str = "",
    page_title_after: str = "",
    page_url_after: str = "",
    bootstrap_flow_prefix: list[dict[str, Any]] | None = None,
    bootstrap_target_overlay: dict[str, Any] | None = None,
) -> Path:
    if yaml is None:
        raise RuntimeError("需要安装 PyYAML 才能写出 YAML：pip install pyyaml") from _yaml_err
    flow = build_complete_flow(
        task,
        default_input_text=default_input_text,
        page_title_after=page_title_after,
        page_url_after=page_url_after,
        bootstrap_flow_prefix=bootstrap_flow_prefix,
    )
    overlay = dict(bootstrap_target_overlay or {})
    overlay.pop("url", None)
    doc: dict[str, Any] = {
        "target": {
            "url": task.anchor_url,
            **overlay,
        },
        "tasks": [
            {
                "name": f"recursive-explore-{task.task_id}",
                "description": (
                    (
                        f"intent_mission ai_steps={len(task.intent_ai_steps)} "
                        f"{('; '.join(task.intent_ai_steps[:3]))[:200]!r} "
                    )
                    if task.task_kind == "intent_mission" and task.intent_ai_steps
                    else (
                        f"run_id={task.run_id} task_kind={task.task_kind} task_source={task.task_source} "
                        f"dedupe_path_key={task.dedupe_path_key} action_kind={task.action_kind} "
                        f"locate={task.locate_prompt[:120]!r} "
                        + (
                            f"css_hint={task.target_css_selector_hint[:80]!r} "
                            if getattr(task, "target_css_selector_hint", "")
                            else ""
                        )
                        + f"bootstrap_prefixed={'yes' if (bootstrap_flow_prefix or []) else 'no'}"
                    )
                ),
                "flow": flow,
            }
        ],
    }
    text = yaml.safe_dump(doc, allow_unicode=True, sort_keys=False, default_flow_style=False)
    head = (
        f"# recursive_exploration run_id={task.run_id} task_id={task.task_id} "
        f"task_kind={task.task_kind} dedupe_path_key={task.dedupe_path_key}\n"
    )
    text = head + text
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")
    return path
