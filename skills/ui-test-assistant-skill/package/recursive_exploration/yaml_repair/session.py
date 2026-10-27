"""修复自愈主循环。"""

from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Awaitable, Callable

import yaml

from recursive_exploration.yaml_repair.cli_exec import CliRunResult, cli_execution_ok, run_browser_use_cli
from recursive_exploration.yaml_repair.config import YamlRepairConfig
from recursive_exploration.yaml_repair.assertion_heuristic import try_transient_assert_repair
from recursive_exploration.yaml_repair.console_diagnosis import (
    print_failure_analysis,
    print_gate_rejected,
    print_llm_repair_planned,
    print_repair_strategy,
    print_round_execution_failed_header,
    print_round_success,
)
from recursive_exploration.yaml_repair.failure_bundle import FailureBundle, clip
from recursive_exploration.yaml_repair.heuristic_repair import try_heuristic_repair
from recursive_exploration.yaml_repair.merge_deps import MergeDepsError, merge_to_single_document, write_merged_yaml
from recursive_exploration.yaml_repair.repair_llm import RepairPromptContext, propose_yaml_repair
from recursive_exploration.yaml_repair.report_md import RepairReportModel, RoundRecord, render_report_md, write_report
from recursive_exploration.yaml_repair.staged_observation import should_attach_vision
from recursive_exploration.yaml_repair.validate_patch import validate_repair_yaml
from recursive_exploration.yaml_repair.vague_wait_heuristic import try_vague_wait_fallback_repair

logger = logging.getLogger(__name__)


def _collect_user_questions(yaml_text: str, stderr: str) -> list[str]:
    qs: list[str] = []
    try:
        d = yaml.safe_load(yaml_text)
    except Exception:
        return ["当前 YAML 无法解析，请检查语法"]
    if not isinstance(d, dict):
        return qs
    t = d.get("target")
    url = ""
    if isinstance(t, dict):
        url = str(t.get("url") or "").strip()
    if not url:
        qs.append("target.url 为空或缺失，请提供入口页面 URL")
    low = (stderr or "").lower()
    if "login" in low or "unauthorized" in low or "401" in low:
        qs.append("日志疑似鉴权/登录问题，请确认账号、Cookie 或环境是否与目标一致")
    return qs


@dataclass
class RepairOutcome:
    verified_success: bool
    """是否在本流程内出现过执行成功的轮次。"""

    deliver_yaml_text: str
    deliver_yaml_path: Path
    report_path: Path
    message: str = ""
    user_prompts_log: list[str] = field(default_factory=list)


CliRunner = Callable[..., CliRunResult]


class YamlRepairSession:
    """编排合并、执行、阶梯观测与可选 LLM 改写。"""

    def __init__(
        self,
        cfg: YamlRepairConfig,
        *,
        entry_yaml: Path,
        work_dir: Path,
        user_intent: str = "",
        bootstrap_path: Path | None = None,
        cli_runner: CliRunner | None = None,
        repair_hook: Callable[[RepairPromptContext], Awaitable[str]] | None = None,
    ) -> None:
        self.cfg = cfg
        self.entry_yaml = Path(entry_yaml).expanduser()
        self.work_dir = Path(work_dir)
        self.user_intent = user_intent
        self.bootstrap_path = bootstrap_path
        self._cli = cli_runner or run_browser_use_cli
        self._repair_hook = repair_hook

    async def run_async(self) -> RepairOutcome:
        self.work_dir.mkdir(parents=True, exist_ok=True)
        merged_path = self.work_dir / "merged.yaml"
        report_path = self.work_dir / "repair_report.md"
        deliver_path = self.work_dir / "repaired.yaml"

        merge_note = ""
        try:
            doc = merge_to_single_document(
                self.entry_yaml,
                merge_bootstrap=self.cfg.merge_bootstrap,
                expand_imports=self.cfg.expand_imports,
                bootstrap_path=self.bootstrap_path,
            )
            write_merged_yaml(doc, merged_path)
        except MergeDepsError as e:
            return RepairOutcome(
                verified_success=False,
                deliver_yaml_text="",
                deliver_yaml_path=deliver_path,
                report_path=report_path,
                message=str(e),
            )

        merge_note = f"入口 `{self.entry_yaml}`；合并选项 merge_bootstrap={self.cfg.merge_bootstrap}, expand_imports={self.cfg.expand_imports}"
        initial_text = merged_path.read_text(encoding="utf-8")
        baseline_for_validate = initial_text
        current_text = initial_text
        last_success_text: str | None = None
        consecutive_failures = 0
        rounds: list[RoundRecord] = []
        user_prompts_log: list[str] = []

        max_rounds = max(1, self.cfg.max_repair_iterations)
        for round_idx in range(1, max_rounds + 1):
            # 长耗时自愈中途目录可能被外部删除，每轮写入前确保存在
            self.work_dir.mkdir(parents=True, exist_ok=True)
            iter_yaml = self.work_dir / f"iter_{round_idx:03d}.yaml"
            iter_yaml.write_text(current_text, encoding="utf-8")
            log_d = self.work_dir / f"logs_round_{round_idx:03d}"
            result = self._cli(
                iter_yaml,
                log_d,
                headless=self.cfg.headless,
                python_exe=self.cfg.python_exe,
                disable_browser_cache=self.cfg.cli_disable_browser_cache,
            )

            vision = should_attach_vision(
                consecutive_failures=consecutive_failures,
                stderr_text=result.stderr,
                cfg=self.cfg,
            )
            bundle = FailureBundle(
                returncode=result.returncode,
                stderr_snippet=clip(result.stderr, self.cfg.failure_preview_chars // 2),
                stdout_snippet=clip(result.stdout, self.cfg.failure_preview_chars // 2),
                log_dir_hint=str(log_d),
                vision_enabled=vision,
            )

            if cli_execution_ok(result.returncode):
                last_success_text = current_text
                consecutive_failures = 0
                rounds.append(
                    RoundRecord(
                        index=round_idx,
                        execution_ok=True,
                        vision_used=vision,
                        repair_note="执行成功",
                    )
                )
                if self.cfg.console_verbose:
                    print_round_success(round_idx)
                break

            consecutive_failures += 1
            rounds.append(
                RoundRecord(
                    index=round_idx,
                    execution_ok=False,
                    vision_used=vision,
                    repair_note="执行失败，准备诊断",
                )
            )

            if self.cfg.console_verbose:
                print_round_execution_failed_header(round_idx, result.returncode or -1)
                print_failure_analysis(
                    stderr=result.stderr or "",
                    stdout=result.stdout or "",
                    log_dir=log_d,
                    vision_next_round=vision,
                )

            a_cand, a_note = try_transient_assert_repair(
                current_text,
                log_dir=log_d,
                stderr=result.stderr or "",
                stdout=result.stdout or "",
                enabled=self.cfg.heuristic_transient_assert,
                upgrade_post_submit_sleep=self.cfg.heuristic_post_submit_upgrade_sleep,
            )
            if a_cand:
                ok_a, verr_a = validate_repair_yaml(baseline_for_validate, a_cand)
                if ok_a:
                    rounds[-1].repair_note = f"断言启发式（跳过 LLM）: {a_note}"
                    user_prompts_log.append(a_note)
                    if self.cfg.console_verbose:
                        print_repair_strategy("断言启发式（跳过 LLM）", a_note)
                    current_text = a_cand
                    continue
                logger.warning("断言启发式 YAML 未通过门禁: %s", verr_a)
                if self.cfg.console_verbose:
                    print_gate_rejected("断言启发式候选 YAML", verr_a)

            h_cand, h_note = try_heuristic_repair(
                current_text,
                log_dir=log_d,
                stderr=result.stderr or "",
                stdout=result.stdout or "",
                enabled=self.cfg.heuristic_login_wait,
                use_ai_wait_for=self.cfg.heuristic_login_use_ai_wait_for,
                sleep_ms=self.cfg.heuristic_login_wait_sleep_ms,
                wait_text=self.cfg.heuristic_login_wait_for_text,
            )
            if h_cand:
                ok_h, verr_h = validate_repair_yaml(baseline_for_validate, h_cand)
                if ok_h:
                    rounds[-1].repair_note = f"登录等待启发式（跳过 LLM）: {h_note}"
                    if self.cfg.console_verbose:
                        print_repair_strategy("登录等待启发式（跳过 LLM）", h_note)
                    current_text = h_cand
                    continue
                logger.warning("启发式 YAML 未通过门禁: %s", verr_h)
                if self.cfg.console_verbose:
                    print_gate_rejected("登录等待启发式候选 YAML", verr_h)

            v_cand, v_note = try_vague_wait_fallback_repair(
                current_text,
                log_dir=log_d,
                stderr=result.stderr or "",
                stdout=result.stdout or "",
                enabled=self.cfg.heuristic_vague_wait_fallback,
                sleep_ms=self.cfg.heuristic_vague_wait_sleep_ms,
                prefer_sleep=self.cfg.heuristic_vague_wait_prefer_sleep,
                alternate_wait=self.cfg.heuristic_vague_wait_alternate,
            )
            if v_cand:
                ok_v, verr_v = validate_repair_yaml(baseline_for_validate, v_cand)
                if ok_v:
                    rounds[-1].repair_note = f"弱特征 aiWaitFor 回退（跳过 LLM）: {v_note}"
                    user_prompts_log.append(v_note)
                    if self.cfg.console_verbose:
                        print_repair_strategy("弱特征 aiWaitFor 回退（跳过 LLM）", v_note)
                    current_text = v_cand
                    continue
                logger.warning("弱特征等待启发式 YAML 未通过门禁: %s", verr_v)
                if self.cfg.console_verbose:
                    print_gate_rejected("弱特征 aiWaitFor 回退候选 YAML", verr_v)

            if self.cfg.console_verbose:
                print_repair_strategy(
                    "启发式未改写本轮 YAML",
                    "断言 / 登录等待 / 弱特征等待启发式均未命中或未通过门禁（若上方已打印「门禁拒绝」见详情）。接下来调用 LLM。",
                )
                print_llm_repair_planned(vision)

            qs = _collect_user_questions(current_text, result.stderr)
            if qs:
                user_prompts_log.extend(qs)
                if self.cfg.interactive_prompts:
                    for q in qs:
                        print(f"[yaml_repair] {q}")
                    try:
                        await asyncio.to_thread(input, "请补充信息后在终端按 Enter 继续… ")
                    except EOFError:
                        logger.warning("stdin 不可用，跳过同步追问")

            fp_ctx = RepairPromptContext(
                user_intent=self.user_intent,
                baseline_yaml=current_text,
                failure_summary=bundle.to_prompt_block(self.cfg.max_log_chars),
                use_vision_hint=vision,
            )
            if self._repair_hook is not None:
                cand = await self._repair_hook(fp_ctx)
            else:
                cand = await propose_yaml_repair(fp_ctx)

            if not (cand or "").strip():
                rounds[-1].repair_note = "LLM 未返回可用 YAML（检查 BU_* 模型与 langchain_core）"
                if self.cfg.console_verbose:
                    print_repair_strategy(
                        "LLM 改写未果",
                        "模型未输出可用 YAML（或无 LANGCHAIN/密钥）；下一轮若仍有额度将沿用当前 YAML。",
                    )
                continue

            ok, verr = validate_repair_yaml(baseline_for_validate, cand)
            if not ok:
                rounds[-1].validation_error = verr
                if self.cfg.console_verbose:
                    print_gate_rejected("LLM 候选 YAML", verr)
                continue

            if self.cfg.console_verbose:
                print_repair_strategy(
                    "已采纳 LLM 改写",
                    "门禁校验通过；下一轮执行将加载改写后的 YAML（iter_XXX.yaml）。",
                )
            current_text = cand

        verified = last_success_text is not None
        if verified:
            deliver_body = last_success_text or ""
            summary = "在本流程内至少一轮执行成功；交付物为**最近一次成功执行时**使用的 YAML。"
            deliver_kind = "verified_success（最近一次成功对应的 YAML）"
        else:
            deliver_body = current_text
            summary = (
                "未达到执行成功：交付 **最后一版改写后的 YAML** 供人工参考；"
                "请勿视为已通过执行验证。"
            )
            deliver_kind = "last_attempt_unverified（最后一版，未验证成功）"

        deliver_path.write_text(deliver_body, encoding="utf-8")
        model = RepairReportModel(
            summary=summary,
            rounds=rounds,
            assert_gate_note="禁止自动新增断言/pyCode/jsCode/aiQuery；校验相对首轮合并基线。",
            deliver_kind=deliver_kind,
            merged_from=merge_note,
            user_prompts=user_prompts_log,
        )
        write_report(report_path, model)

        return RepairOutcome(
            verified_success=verified,
            deliver_yaml_text=deliver_body,
            deliver_yaml_path=deliver_path,
            report_path=report_path,
            message=render_report_md(model),
            user_prompts_log=user_prompts_log,
        )


def run_sync(session: YamlRepairSession) -> RepairOutcome:
    return asyncio.run(session.run_async())
