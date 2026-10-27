"""组合任务执行：逐步写边/事件（惰性 import explorer 工具以避免循环依赖）。"""

from __future__ import annotations

from dataclasses import replace
from typing import Any

from recursive_exploration.dedupe import DedupeStore, SkipReason
from recursive_exploration.fingerprints import dedupe_url_key, element_fingerprint, scroll_fingerprint
from recursive_exploration.graph_store import GraphStore
from recursive_exploration.models import ActionTask, ExplorationEvent, ExplorationStep, GraphEdgeRecord, GraphNodeRecord, UrlTask
from recursive_exploration.task_labels import infer_action_tag, step_origin_code
from recursive_exploration.yaml_render import (
    build_complete_flow,
    flow_core_length,
    generated_cases_yaml_filename,
    write_task_yaml,
    yaml_meta_composite_atomic_step,
)


async def execute_composite_chain(
    explorer: Any,
    ctx: Any,
    graph: GraphStore,
    dedupe: DedupeStore,
    task: ActionTask,
    *,
    new_urls: list[UrlTask],
    stats: dict[str, Any],
    queue_seq: int | None = None,
    prefix_flow_frames: list[dict[str, Any]] | None = None,
) -> str:
    from recursive_exploration.explorer import (
        _atomic_step_result_dict,
        _node_id,
        _observation,
        _prefix_steps_summary,
        _resolve_click_index,
        _ts,
    )
    ex = explorer
    run_id = task.run_id
    pk = task.dedupe_path_key
    plan_id = task.composite_plan_id or ""
    tsrc = task.task_source or "composite_planner"

    if not dedupe.try_path(pk):
        stats["dedupe_composite_skipped"] = stats.get("dedupe_composite_skipped", 0) + 1
        return "skipped"

    def _step_sidecar(s: ExplorationStep) -> dict[str, Any]:
        d: dict[str, Any] = {
            "i": s.element_index,
            "h": s.branch_path_hash,
            "d": s.tap_description,
            "p": s.locate_prompt,
            "k": s.step_kind,
            "v": s.input_value,
        }
        if s.step_kind == "scroll":
            d["sy"] = s.scroll_delta_y
        return d

    any_critical = False
    atomic_total = len(task.composite_steps)
    buffered_events: list[ExplorationEvent] = []
    obs_after: dict[str, Any] = {}
    last_atomic_anchor_step_seq: int | None = None

    bp = getattr(ex, "_bootstrap_flow_prefix", None) or []

    def _flush_buffered(*, use_final_yaml: bool) -> None:
        if not buffered_events:
            return
        if use_final_yaml and obs_after:
            fl = build_complete_flow(
                task,
                default_input_text=ex.config.mock_input_text,
                page_title_after=str(obs_after.get("title") or ""),
                page_url_after=str(obs_after.get("url") or ""),
                bootstrap_flow_prefix=bp,
            )
            yft = len(fl)
        else:
            yft = flow_core_length(
                task,
                default_input_text=ex.config.mock_input_text,
                bootstrap_flow_prefix=bp,
            )
        for ev in buffered_events:
            graph.append_event(replace(ev, yaml_flow_total=yft).to_json_obj())
        buffered_events.clear()

    for si, step in enumerate(task.composite_steps):
        event_id = ex._next_event_id(run_id)
        before = await ctx.get_state()
        obs_before = _observation(before, ex.config)
        from_node_id = _node_id(obs_before["url_norm"], obs_before["structural_state_id"])
        graph.register_entry_node(from_node_id)
        graph.upsert_node(
            GraphNodeRecord(
                node_id=from_node_id,
                url_norm=obs_before["url_norm"],
                raw_url=obs_before["url"],
                structural_state_id=obs_before["structural_state_id"],
                page_state_id=obs_before["page_state_id"],
                title=obs_before["title"],
                first_seen_at=_ts(),
                last_seen_at=_ts(),
                seen_run_ids=[run_id],
            )
        )
        shot_before = await ex._screenshot_rel(ctx, graph, "before")

        input_used = ""
        idx: int | None = None
        afp = ""

        try:
            if step.step_kind == "scroll":
                dy = step.scroll_delta_y or ex.config.scroll_delta_y_px
                afp = scroll_fingerprint(int(dy))
                await ex._perform_scroll(ctx, int(dy))
                tgt_dict = _atomic_step_result_dict(step, None)
            elif step.step_kind == "input":
                st_click = await ctx.get_state()
                idx = _resolve_click_index(st_click, step)
                if idx is None:
                    stats["failed_resolves"] = stats.get("failed_resolves", 0) + 1
                    _flush_buffered(use_final_yaml=False)
                    return "failed"
                el = (st_click.selector_map or {})[idx]
                afp = element_fingerprint(
                    idx,
                    step.branch_path_hash,
                    el.tag_name,
                    el.attributes or {},
                    action_kind="input",
                )
                input_used = await ex._suggest_input_mock_text(
                    page_url=obs_before["url"],
                    page_title=obs_before["title"] or "",
                    locate_prompt=step.locate_prompt,
                    tap_description=step.tap_description,
                )
                eln = await ctx.get_dom_element_by_index(idx)
                await ctx.input_text_element_node(eln, input_used)
                task.composite_steps[si].input_value = input_used
                tgt_dict = _atomic_step_result_dict(step, idx, input_value_used=input_used)
            else:
                st_click = await ctx.get_state()
                idx = _resolve_click_index(st_click, step)
                if idx is None:
                    stats["failed_resolves"] = stats.get("failed_resolves", 0) + 1
                    _flush_buffered(use_final_yaml=False)
                    return "failed"
                el = (st_click.selector_map or {})[idx]
                afp = element_fingerprint(
                    idx,
                    step.branch_path_hash,
                    el.tag_name,
                    el.attributes or {},
                    action_kind="click",
                )
                await ex._perform_click(ctx, idx)
                tgt_dict = _atomic_step_result_dict(step, idx)
        except Exception:
            dedupe.note_hit(SkipReason.REPLAY_FAILED)
            _flush_buffered(use_final_yaml=False)
            return "failed"

        if ex.config.composite_counts_toward_max_actions:
            stats["actions_executed"] = stats.get("actions_executed", 0) + 1
        else:
            stats["composite_internal_actions"] = stats.get("composite_internal_actions", 0) + 1

        await ex._wait_post_action_settled(ctx, task=task)
        after = await ctx.get_state()
        obs_after = _observation(after, ex.config)
        if obs_before["structural_state_id"] != obs_after["structural_state_id"]:
            any_critical = True
        to_node_id = _node_id(obs_after["url_norm"], obs_after["structural_state_id"])
        graph.upsert_node(
            GraphNodeRecord(
                node_id=to_node_id,
                url_norm=obs_after["url_norm"],
                raw_url=obs_after["url"],
                structural_state_id=obs_after["structural_state_id"],
                page_state_id=obs_after["page_state_id"],
                title=obs_after["title"],
                first_seen_at=_ts(),
                last_seen_at=_ts(),
                seen_run_ids=[run_id],
            )
        )
        shot_after = await ex._screenshot_rel(ctx, graph, "after")

        url_before_norm = obs_before["url_norm"]
        url_changed = obs_after["url_norm"] != url_before_norm
        if url_changed:
            any_critical = True

        edge_id = f"e_{event_id}"
        pre_steps = list(task.prefix_steps) + list(task.composite_steps[:si])
        steps_payload = [_step_sidecar(s) for s in pre_steps]
        pref_ref = graph.maybe_write_prefix_sidecar(edge_id, steps_payload)
        pfx_sum = _prefix_steps_summary(pre_steps, ex.config)

        atomic_task = replace(
            task,
            target_description=step.tap_description,
            locate_prompt=step.locate_prompt,
            action_kind=step.step_kind,
        )
        rec = GraphEdgeRecord(
            edge_id=edge_id,
            from_node_id=from_node_id,
            to_node_id=to_node_id,
            action_type=step.step_kind,
            action_fingerprint=afp,
            anchor_url_norm=task.anchor_url_norm,
            prefix_steps_ref=pref_ref,
            prefix_steps_summary=pfx_sum,
            target_step=tgt_dict,
            result="ok",
            url_changed=url_changed,
            screenshots={"before": shot_before, "after": shot_after},
            run_id=run_id,
            event_id=event_id,
            dedupe_path_key=pk,
            yaml_ref=None,
            action_tag=infer_action_tag(
                atomic_task,
                url_before=str(obs_before.get("url") or ""),
                url_after=str(obs_after.get("url") or ""),
            ),
        )
        graph.upsert_edge(rec)

        if url_changed:
            uk = dedupe_url_key(obs_after["url_norm"])
            if dedupe.try_url(uk):
                new_urls.append(
                    UrlTask(
                        url_norm=obs_after["url_norm"],
                        raw_url=obs_after["url"],
                        anchor_depth=task.anchor_depth + 1,
                    )
                )
                graph.append_queue(
                    "url_discovered",
                    {
                        "url_norm": obs_after["url_norm"],
                        "raw_url": obs_after["url"],
                        "from_anchor_depth": task.anchor_depth,
                        "task_id": task.task_id,
                        "event_id": event_id,
                        "edge_id": edge_id,
                    },
                )

        _, yidx = yaml_meta_composite_atomic_step(
            task,
            composite_step_index_zero_based=si,
            default_input_text=ex.config.mock_input_text,
            page_title_after=str(obs_after.get("title") or ""),
            page_url_after=str(obs_after.get("url") or ""),
            bootstrap_flow_prefix=bp,
        )
        extra_ev: dict[str, Any] = {}
        if si == 0 and prefix_flow_frames:
            extra_ev["prefix_flow_frames"] = prefix_flow_frames
        ass_atomic = ex._alloc_anchor_step_seq(task.anchor_url_norm)
        last_atomic_anchor_step_seq = ass_atomic
        buffered_events.append(
            ExplorationEvent(
                event_id=event_id,
                run_id=run_id,
                ts=_ts(),
                anchor_url_norm=task.anchor_url_norm,
                anchor_url=task.anchor_url,
                dedupe_path_key=pk,
                from_node_id=from_node_id,
                to_node_id=to_node_id,
                edge_id=edge_id,
                url_before=obs_before["url"],
                url_after=obs_after["url"],
                structural_before=obs_before["structural_state_id"],
                structural_after=obs_after["structural_state_id"],
                page_state_before=obs_before["page_state_id"],
                page_state_after=obs_after["page_state_id"],
                action_fingerprint=afp,
                result="ok",
                skip_reason=None,
                screenshots={"before": shot_before, "after": shot_after},
                task_id=task.task_id,
                target_step=tgt_dict,
                queue_seq=queue_seq,
                anchor_step_seq=ass_atomic,
                anchor_depth=task.anchor_depth,
                yaml_flow_total=None,
                yaml_flow_target_index=yidx,
                task_source=tsrc,
                composite_plan_id=plan_id or None,
                action_kind=step.step_kind,
                step_origin=step_origin_code(task),
                composite_atomic_index=si + 1,
                composite_atomic_total=atomic_total,
                extra=extra_ev,
            )
        )
        ex._touch_exploration_review(graph, force=False)

    _flush_buffered(use_final_yaml=True)

    if ex.config.yaml_policy == "all" or any_critical:
        fn = generated_cases_yaml_filename(
            task.task_id,
            queue_seq=queue_seq,
            anchor_step_seq=last_atomic_anchor_step_seq,
            include_anchor_step=ex.config.generated_cases_include_anchor_step_seq,
            mode=ex.config.generated_cases_filename_mode,
        )
        ypath = graph.out_dir / "generated_cases" / fn
        ypath.parent.mkdir(parents=True, exist_ok=True)
        write_task_yaml(
            task,
            ypath,
            default_input_text=ex.config.mock_input_text,
            page_title_after=str(obs_after.get("title") or ""),
            page_url_after=str(obs_after.get("url") or ""),
            bootstrap_flow_prefix=bp,
            bootstrap_target_overlay=getattr(ex, "_bootstrap_target_overlay", None),
        )

    stats["composite_tasks_ok"] = stats.get("composite_tasks_ok", 0) + 1
    ex._touch_exploration_review(graph, force=True)
    return "ok"
