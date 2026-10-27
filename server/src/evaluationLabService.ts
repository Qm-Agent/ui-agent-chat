import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { strToU8, zipSync } from "fflate";
import { detectRuntimeConfiguredModel } from "./executionRuntime.js";
import { getGuiRuntimeSettings } from "./configStore.js";
import {
  evaluationSuiteHash,
  renderEvaluationHtmlReport,
  scoreEvaluationCaseRun,
  summarizeEvaluationRun
} from "./evaluationLabDomain.js";
import {
  appendEvaluationEvent,
  createEvaluationRun,
  deleteEvaluationPlan,
  deleteEvaluationRun,
  evaluationReportFile,
  listEvaluationPlans,
  listEvaluationRuns,
  loadEvaluationPlan,
  loadEvaluationRun,
  loadEvaluationSuite,
  readEvaluationEvents,
  saveEvaluationPlan,
  updateEvaluationCaseRun,
  updateEvaluationRun
} from "./evaluationLabStore.js";
import { getSelectedExecutionRuntimeId } from "./modelStore.js";
import {
  resolveEvaluationTargetServices,
  resolveEvaluationTargetUrl
} from "./evaluationBenchService.js";
import { getNativeAutomationStatus, type NativeAutomationStatus } from "./nativeAutomation.js";
import { isDesktopMode, webUiOperationTargetError } from "./runtimeMode.js";
import { loadSession } from "./storage.js";
import { loadUiOperationTask } from "./uiOperationStore.js";
import { abortUiOperation, sendUiOperationMessage } from "./uiOperationService.js";
import type {
  BrowserKernel,
  EvaluationCaseDefinition,
  EvaluationCaseDiagnosis,
  EvaluationCaseReportDetail,
  EvaluationCaseRun,
  EvaluationExperimentReport,
  EvaluationPlan,
  EvaluationReportArtifact,
  EvaluationRun,
  EvaluationRunConfig,
  EvaluationRunResumeEntry,
  EvaluationSuite,
  ExecutionRuntimeId,
  GuiRuntimeTransportPreference,
  NativeDeliveryMode,
  NativeProviderId,
  StreamPayload,
  UiOperationExecutionTarget,
  UiOperationRun
} from "./types.js";

const activeRuns = new Map<string, AbortController>();
const AGENT_SELECTED_APP = { kind: "name" as const, value: "__agent_select__" };
const MAX_EVALUATION_ASSISTANT_TEXT = 64_000;

export interface StartEvaluationInput {
  suiteId: string;
  operationType: EvaluationRunConfig["operationType"];
  browserKernel?: BrowserKernel;
  providerId?: NativeProviderId;
  nativeDeliveryMode?: NativeDeliveryMode;
  guiRuntimeTransport?: GuiRuntimeTransportPreference;
  executionRuntimeId?: ExecutionRuntimeId;
  model?: string;
  businessId?: string;
  repetitions?: number;
  passThreshold?: number;
  concurrency?: number;
  planId?: string;
  planName?: string;
  planSnapshot?: EvaluationPlan;
  rerunOfRunId?: string;
  rerunOfCaseRunId?: string;
  selectedCaseIds?: string[];
  suiteSnapshot?: EvaluationSuite;
}

export interface SaveEvaluationPlanInput extends Omit<StartEvaluationInput, "suiteId"> {
  id?: string;
  name: string;
  description?: string;
  suiteId: string;
}

/** 新建或更新评测方案，评测集定义与执行参数保持分离。 */
export async function upsertEvaluationPlan(input: SaveEvaluationPlanInput): Promise<EvaluationPlan> {
  const suite = await loadEvaluationSuite(String(input.suiteId ?? "").trim());
  const name = String(input.name ?? "").trim();
  if (!name) throw new Error("请输入评测方案名称");
  const existing = input.id ? await loadEvaluationPlan(input.id).catch(() => undefined) : undefined;
  const now = new Date().toISOString();
  return saveEvaluationPlan({
    schemaVersion: "1.0",
    id: existing?.id ?? randomUUID(),
    name: name.slice(0, 120),
    description: String(input.description ?? "").trim().slice(0, 1_000) || undefined,
    suiteId: suite.id,
    suiteName: suite.name,
    config: normalizeEvaluationRunConfig({ ...input, suiteId: suite.id }),
    createdAt: existing?.createdAt ?? now,
    updatedAt: now
  });
}

/** 删除评测方案，历史运行及其快照不受影响。 */
export async function removeEvaluationPlan(planId: string): Promise<void> {
  await deleteEvaluationPlan(planId);
}

/** 使用评测方案默认参数或本次覆盖参数创建新运行。 */
export async function startEvaluationPlan(
  planId: string,
  overrides: Partial<StartEvaluationInput> = {}
): Promise<EvaluationRun> {
  const plan = await loadEvaluationPlan(planId);
  return startEvaluationExperiment({
    suiteId: plan.suiteId,
    operationType: overrides.operationType ?? plan.config.operationType,
    browserKernel: overrides.browserKernel ?? plan.config.browserKernel,
    providerId: overrides.providerId ?? plan.config.providerId,
    nativeDeliveryMode: overrides.nativeDeliveryMode ?? plan.config.nativeDeliveryMode,
    guiRuntimeTransport: overrides.guiRuntimeTransport ?? plan.config.guiRuntimeTransport,
    executionRuntimeId: overrides.executionRuntimeId ?? plan.config.executionRuntimeId,
    model: overrides.model ?? plan.config.model,
    businessId: overrides.businessId ?? plan.config.businessId,
    repetitions: overrides.repetitions ?? plan.config.repetitions,
    passThreshold: overrides.passThreshold ?? plan.config.passThreshold,
    concurrency: overrides.concurrency ?? plan.config.concurrency,
    planId: plan.id,
    planName: plan.name,
    planSnapshot: structuredClone(plan)
  });
}

/** 按历史运行的不可变参数快照重新执行，并保留原运行。 */
export async function rerunEvaluationExperiment(runId: string): Promise<EvaluationRun> {
  const previous = await loadEvaluationRun(runId);
  return startEvaluationExperiment({
    suiteId: previous.suiteId,
    ...previous.config,
    executionRuntimeId: previous.environment.executionRuntimeId,
    model: previous.environment.model,
    planId: previous.planId,
    planName: previous.planName,
    planSnapshot: previous.planSnapshot ? structuredClone(previous.planSnapshot) : undefined,
    rerunOfRunId: previous.id,
    suiteSnapshot: structuredClone(previous.suiteSnapshot)
  });
}

/** 在历史运行中原位重跑一个样本，旧结果归档到该样本的尝试历史。 */
export async function rerunEvaluationCase(runId: string, caseRunId: string): Promise<EvaluationRun> {
  const previous = await loadEvaluationRun(runId);
  const previousCaseRun = previous.caseRuns.find((item) => item.id === caseRunId);
  if (!previousCaseRun) throw new Error("评测样本不存在");
  if (activeRuns.has(runId) || ["queued", "running"].includes(previous.status)) {
    throw new Error("评测运行仍在执行，不能启动单例重跑");
  }
  if (["queued", "running"].includes(previousCaseRun.status)) {
    throw new Error("评测样本仍在执行，不能重复启动");
  }
  await ensureEvaluationRetryReady(previous);
  const updated = await updateEvaluationRun(runId, (current) =>
    prepareEvaluationRunRetry(current, [caseRunId], "case-rerun")
  );
  void executeEvaluationExperiment(runId);
  return updated;
}

/** 在原运行记录中继续尚未执行的样本，保留已执行结果与全部尝试历史。 */
export async function resumeEvaluationExperiment(runId: string): Promise<EvaluationRun> {
  const run = await loadEvaluationRun(runId);
  if (activeRuns.has(runId) || ["queued", "running"].includes(run.status)) {
    throw new Error("评测运行仍在执行，无需断点续跑");
  }
  const resumableCaseRunIds = run.caseRuns
    .filter((item) => item.status === "not-run")
    .map((item) => item.id);
  if (!resumableCaseRunIds.length) throw new Error("当前评测没有未执行样本");
  await ensureEvaluationRetryReady(run);
  const updated = await updateEvaluationRun(runId, (current) =>
    prepareEvaluationRunRetry(current, resumableCaseRunIds, "checkpoint-resume")
  );
  void executeEvaluationExperiment(runId);
  return updated;
}

/** 删除终态评测记录及其专属产物；原始 UI 操作会话不受影响。 */
export async function removeEvaluationExperiment(runId: string): Promise<void> {
  const run = await loadEvaluationRun(runId);
  if (activeRuns.has(runId) || ["queued", "running"].includes(run.status)) {
    throw new Error("运行中的评测不能删除，请先停止");
  }
  await deleteEvaluationRun(runId);
}

async function ensureEvaluationRetryReady(run: EvaluationRun): Promise<void> {
  if (run.config.operationType !== "computer" || run.config.providerId === "mock") return;
  const nativeStatus = await getNativeAutomationStatus();
  const readinessError = nativeEvaluationReadinessError(nativeStatus, run.config.providerId);
  if (readinessError) throw new Error(readinessError);
}

/** 创建实验快照并在后台启动跑批。 */
export async function startEvaluationExperiment(input: StartEvaluationInput): Promise<EvaluationRun> {
  const suite = input.suiteSnapshot
    ? structuredClone(input.suiteSnapshot)
    : await loadEvaluationSuite(String(input.suiteId ?? "").trim());
  const config = normalizeEvaluationRunConfig(input);
  const enabledCases = selectEvaluationCasesForRun(
    suite,
    config.operationType,
    input.selectedCaseIds
  );
  if (!enabledCases.length) {
    throw new Error(`评测集中没有支持${config.operationType === "browser" ? "浏览器" : "电脑桌面"}的启用用例`);
  }
  const resolvedTargetServices = config.operationType === "browser"
    ? await resolveEvaluationTargetServices(suite)
    : [];
  const targetError = !isDesktopMode()
    ? webUiOperationTargetError(buildExecutionTarget(config, enabledCases[0], resolvedTargetServices))
    : undefined;
  if (targetError) throw new Error(targetError);
  if (config.operationType === "computer" && config.providerId !== "mock") {
    const nativeStatus = await getNativeAutomationStatus();
    const readinessError = nativeEvaluationReadinessError(nativeStatus, config.providerId);
    if (readinessError) throw new Error(readinessError);
  }
  const configuredExecutionRuntimeId = await getSelectedExecutionRuntimeId();
  const executionRuntimeId = config.executionRuntimeId ?? configuredExecutionRuntimeId;
  const model = config.model
    ?? await detectRuntimeConfiguredModel(executionRuntimeId).catch(() => undefined);
  const guiRuntimeSettings = await getGuiRuntimeSettings().catch(() => undefined);
  const resolvedGuiRuntimeTransport = config.operationType === "computer"
    ? config.guiRuntimeTransport === "cli" || config.guiRuntimeTransport === "mcp"
      ? config.guiRuntimeTransport
      : guiRuntimeSettings?.cliCompatibilityMode
        ? "cli"
        : "mcp"
    : undefined;
  const now = new Date().toISOString();
  const caseRuns = enabledCases.flatMap((definition) =>
    Array.from({ length: config.repetitions }, (_unused, repetition) => createCaseRun(definition, repetition + 1))
  );
  const run: EvaluationRun = {
    schemaVersion: "1.0",
    id: randomUUID(),
    planId: input.planId,
    planName: input.planName,
    planSnapshot: input.planSnapshot ? structuredClone(input.planSnapshot) : undefined,
    rerunOfRunId: input.rerunOfRunId,
    rerunOfCaseRunId: input.rerunOfCaseRunId,
    suiteId: suite.id,
    suiteName: suite.name,
    suiteHash: evaluationSuiteHash(suite),
    suiteSnapshot: structuredClone(suite),
    status: "queued",
    config,
    environment: {
      executionRuntimeId,
      model,
      selectionSource: config.executionRuntimeId || config.model
        ? "plan-override"
        : "configured-default",
      platform: process.platform,
      desktop: isDesktopMode(),
      executionChain: evaluationExecutionChain(config),
      guiRuntimeTransport: config.operationType === "computer"
        ? resolvedGuiRuntimeTransport
        : undefined,
      targetServices: resolvedTargetServices.length ? resolvedTargetServices : undefined,
      capturedAt: now
    },
    createdAt: now,
    caseRuns,
    summary: summarizeEvaluationRun(caseRuns)
  };
  await createEvaluationRun(run);
  void executeEvaluationExperiment(run.id);
  return run;
}

export { listEvaluationPlans, loadEvaluationPlan };

export function selectEvaluationCasesForRun(
  suite: EvaluationSuite,
  operationType: EvaluationRunConfig["operationType"],
  selectedCaseIds?: string[]
): EvaluationSuite["cases"] {
  const selected = selectedCaseIds?.length ? new Set(selectedCaseIds) : undefined;
  return suite.cases.filter((item) =>
    item.enabled
    && item.compatibleTargets.includes(operationType)
    && (!selected || selected.has(item.id))
  );
}

/** 评测必须在完整可观察环境中启动，普通 UI 操作仍可按 AX-only 模式降级。 */
export function nativeEvaluationReadinessError(
  status: NativeAutomationStatus,
  providerId: NativeProviderId | undefined
): string | undefined {
  if (!providerId || providerId === "mock") return undefined;
  const provider = status.providers.find((item) => item.providerId === providerId);
  if (!provider || provider.status !== "ok") {
    return `评测环境无效：${providerId} Provider 不可用。请先在 UI 操作页完成运行时检测`;
  }
  const permission = String(provider.data?.permission || "").toLowerCase();
  if (permission && permission !== "granted") {
    return "评测环境无效：辅助功能权限未授权。请在 macOS 系统设置 > 隐私与安全性 > 辅助功能中授权 UIWarden 和 dt-gui-computer Provider";
  }
  if (providerId === "macos-accessibility") {
    const screenCapturePermission = String(provider.data?.screenCapturePermission || "").toLowerCase();
    if (screenCapturePermission !== "granted") {
      return "评测环境无效：屏幕录制权限未授权。评测需要截图、视觉定位和动作后校验，请在 macOS 系统设置 > 隐私与安全性 > 屏幕录制中授权 UIWarden 和 dt-gui-computer Provider";
    }
  }
  return undefined;
}

/** 中止评测及其当前活动的 UI 操作。 */
export async function abortEvaluationExperiment(runId: string): Promise<EvaluationRun> {
  const run = await loadEvaluationRun(runId);
  if (!["queued", "running"].includes(run.status)) return run;
  activeRuns.get(runId)?.abort();
  const activeCaseRuns = run.caseRuns.filter((item) => item.status === "running" && item.taskId && item.operationRunId);
  await Promise.all(activeCaseRuns.map((item) =>
    abortUiOperation(item.taskId!, item.operationRunId!).catch(() => undefined)
  ));
  const finishedAt = new Date().toISOString();
  const updated = await updateEvaluationRun(runId, (current) => {
    const caseRuns = current.caseRuns.map((item) =>
      item.status === "queued" || item.status === "running"
        ? {
            ...item,
            status: "aborted" as const,
            reason: "用户中止评测",
            error: item.error || "用户中止评测",
            finishedAt,
            durationMs: item.startedAt
              ? Math.max(0, Date.parse(finishedAt) - Date.parse(item.startedAt))
              : undefined
          }
        : item
    );
    return {
      ...current,
      status: "aborted",
      stopReason: "user-aborted",
      currentCaseRunId: undefined,
      finishedAt,
      caseRuns,
      summary: summarizeEvaluationRun(caseRuns)
    };
  });
  return writeEvaluationReports(updated);
}

/** 把服务重启时遗留的运行标记为失败，避免结果中心永久显示执行中。 */
export async function recoverEvaluationExperiments(): Promise<void> {
  const stale = (await listEvaluationRuns(500)).filter((item) => item.status === "queued" || item.status === "running");
  for (const item of stale) {
    const finishedAt = new Date().toISOString();
    const updated = await updateEvaluationRun(item.id, (run) => {
      const caseRuns = run.caseRuns.map((caseRun) =>
        caseRun.status === "queued"
          ? {
              ...caseRun,
              status: "not-run" as const,
              reason: "服务重启前尚未开始执行，可从断点继续",
              error: "evaluation-service-restarted-before-case-start",
              finishedAt
            }
          : caseRun.status === "running"
            ? {
              ...caseRun,
              status: "unknown" as const,
              reason: "服务重启时样本正在执行，结果状态无法确认",
              error: "evaluation-service-restarted-during-case",
              finishedAt
            }
            : caseRun
      );
      return {
        ...run,
        status: "failed",
        stopReason: "service-restarted",
        currentCaseRunId: undefined,
        finishedAt,
        caseRuns,
        summary: summarizeEvaluationRun(caseRuns)
      };
    });
    await writeEvaluationReports(updated);
  }
}

async function executeEvaluationExperiment(runId: string): Promise<void> {
  const controller = new AbortController();
  activeRuns.set(runId, controller);
  try {
    const queuedRun = await loadEvaluationRun(runId);
    if (queuedRun.status !== "queued" || controller.signal.aborted) return;
    let run = await updateEvaluationRun(runId, (current) => ({
      ...(current.status === "queued" ? {
        ...current,
        status: "running" as const,
        startedAt: current.startedAt ?? new Date().toISOString()
      } : current)
    }));
    if (run.status !== "running" || controller.signal.aborted) return;
    let nextIndex = 0;
    const worker = async () => {
      while (!controller.signal.aborted) {
        const index = nextIndex;
        nextIndex += 1;
        if (index >= run.caseRuns.length) return;
        const result = await executeEvaluationCase(runId, run.caseRuns[index].id, controller.signal);
        if (result === "execution-blocked") {
          await markQueuedCasesNotRun(
            runId,
            "基础执行链或目标环境不可用，剩余样本未启动"
          );
          return;
        }
      }
    };
    await Promise.all(Array.from({ length: run.config.concurrency }, () => worker()));
    if (controller.signal.aborted) return;
    run = await updateEvaluationRun(runId, (current) => ({
      ...current,
      status: "completed",
      currentCaseRunId: undefined,
      finishedAt: new Date().toISOString(),
      summary: summarizeEvaluationRun(current.caseRuns)
    }));
    await writeEvaluationReports(run);
  } catch (error) {
    if (!controller.signal.aborted) {
      const message = error instanceof Error ? error.message : String(error);
      const run = await updateEvaluationRun(runId, (current) => ({
        ...current,
        status: "failed",
        currentCaseRunId: undefined,
        stopReason: message,
        finishedAt: new Date().toISOString(),
        summary: summarizeEvaluationRun(current.caseRuns)
      })).catch(() => undefined);
      if (run) await writeEvaluationReports(run).catch(() => undefined);
    }
  } finally {
    if (activeRuns.get(runId) === controller) activeRuns.delete(runId);
  }
}

export function prepareEvaluationRunRetry(
  run: EvaluationRun,
  caseRunIds: string[],
  trigger: EvaluationRunResumeEntry["trigger"],
  resumedAt = new Date().toISOString()
): EvaluationRun {
  const selected = new Set(caseRunIds);
  const previousCaseRunIds: string[] = [];
  const nextCaseRunIds: string[] = [];
  const caseRuns = run.caseRuns.map((caseRun) => {
    if (!selected.has(caseRun.id)) return caseRun;
    const definition = run.suiteSnapshot.cases.find((item) => item.id === caseRun.caseId);
    if (!definition) throw new Error(`评测用例快照不存在：${caseRun.caseId}`);
    previousCaseRunIds.push(caseRun.id);
    const attemptNumber = caseRun.attemptNumber ?? 1;
    const { attemptHistory: _attemptHistory, ...snapshot } = structuredClone(caseRun);
    const replacement = createCaseRun(definition, caseRun.repetition);
    replacement.attemptNumber = attemptNumber + 1;
    replacement.attemptHistory = [
      ...(caseRun.attemptHistory ?? []),
      {
        attemptNumber,
        trigger,
        archivedAt: resumedAt,
        snapshot
      }
    ];
    nextCaseRunIds.push(replacement.id);
    return replacement;
  });
  if (previousCaseRunIds.length !== selected.size) throw new Error("部分评测样本不存在");
  return {
    ...run,
    status: "queued",
    finishedAt: undefined,
    stopReason: undefined,
    currentCaseRunId: undefined,
    reportPaths: undefined,
    caseRuns,
    resumeHistory: [
      ...(run.resumeHistory ?? []),
      {
        id: randomUUID(),
        trigger,
        resumedAt,
        previousCaseRunIds,
        nextCaseRunIds
      }
    ],
    summary: summarizeEvaluationRun(caseRuns)
  };
}

async function executeEvaluationCase(
  runId: string,
  caseRunId: string,
  signal: AbortSignal
): Promise<"continue" | "execution-blocked"> {
  if (signal.aborted) return "continue";
  const run = await loadEvaluationRun(runId);
  const caseRun = run.caseRuns.find((item) => item.id === caseRunId);
  if (!caseRun || caseRun.status !== "queued") return "continue";
  const definition = run.suiteSnapshot.cases.find((item) => item.id === caseRun.caseId);
  if (!definition) throw new Error(`评测用例快照不存在：${caseRun.caseId}`);
  const startedAt = new Date().toISOString();
  await updateEvaluationRun(runId, (current) => ({
    ...current,
    currentCaseRunId: caseRunId,
    caseRuns: current.caseRuns.map((item) => item.id === caseRunId
      ? { ...item, status: "running", startedAt }
      : item)
  }));
  if (signal.aborted) return "continue";
  let eventCount = 0;
  let operationIds: { taskId?: string; operationRunId?: string; sessionId?: string } = {};
  let tokenUsage: EvaluationCaseRun["observability"]["tokenUsage"];
  let evaluationAssistantText = "";
  let timedOut = false;
  let timeout: NodeJS.Timeout | undefined;
  const stopCurrentOperation = async () => {
    if (operationIds.taskId && operationIds.operationRunId) {
      await abortUiOperation(operationIds.taskId, operationIds.operationRunId).catch(() => undefined);
    }
  };
  const abortListener = () => {
    void stopCurrentOperation();
  };
  signal.addEventListener("abort", abortListener, { once: true });
  try {
    if (signal.aborted) return "continue";
    const operationPromise = sendUiOperationMessage(
      {
        message: definition.instruction,
        name: `[评测] ${definition.name}`,
        businessId: run.config.businessId,
        executionTarget: buildExecutionTarget(run.config, definition, run.environment.targetServices),
        experience: {
          presentationMode: "inline",
          browserTaskGroupMode: "off",
          nativeDeliveryMode: run.config.nativeDeliveryMode ?? "foreground-compatible"
        },
        approvalMode: "none",
        evaluationContext: {
          caseId: definition.id,
          timeoutMs: definition.timeoutMs,
          executionRuntimeId: run.environment.executionRuntimeId,
          model: run.environment.model,
          guiRuntimeTransport: run.environment.guiRuntimeTransport
        }
      },
      (payload) => {
        eventCount += 1;
        if (payload.type === "text") {
          evaluationAssistantText = appendEvaluationAssistantText(
            evaluationAssistantText,
            String(payload.data ?? "")
          );
        }
        const identifiers = extractEvaluationOperationIds(payload);
        if (identifiers) {
          operationIds = { ...operationIds, ...identifiers };
          void updateEvaluationCaseRun(runId, caseRunId, operationIds).catch(() => undefined);
          if (timedOut || signal.aborted) stopCurrentOperation();
        }
        tokenUsage = mergeTokenUsage(tokenUsage, extractTokenUsage(payload));
        void appendEvaluationEvent(runId, caseRunId, {
          sequence: eventCount,
          timestamp: new Date().toISOString(),
          ...compactPayload(payload)
        }).catch(() => undefined);
      },
      async (identifiers) => {
        operationIds = { ...operationIds, ...identifiers };
        await updateEvaluationCaseRun(runId, caseRunId, operationIds);
      }
    );
    const operationOutcome = operationPromise.then(
      (value) => ({ kind: "operation" as const, value }),
      (error: unknown) => ({ kind: "error" as const, error })
    );
    const timeoutPromise = new Promise<{ kind: "timeout" }>((resolve) => {
      timeout = setTimeout(() => {
        timedOut = true;
        resolve({ kind: "timeout" });
        void stopCurrentOperation();
      }, definition.timeoutMs);
    });
    const outcome = await Promise.race([operationOutcome, timeoutPromise]);
    if (outcome.kind === "error") throw outcome.error;
    if (outcome.kind === "timeout") {
      await stopCurrentOperation();
      await Promise.race([
        operationOutcome,
        new Promise((resolve) => setTimeout(resolve, 3_000))
      ]);
      const resolvedOperationRun = await waitForRecordedOperationRun(operationIds);
      const finishedAt = new Date().toISOString();
      const durationMs = Math.max(0, Date.parse(finishedAt) - Date.parse(startedAt));
      const scored = resolvedOperationRun
        ? scoreEvaluationCaseRun({
            definition,
            operationRun: withEvaluationAssistantText(resolvedOperationRun, evaluationAssistantText),
            durationMs,
            artifactsCount: resolvedOperationRun.artifactsCount,
            passThreshold: run.config.passThreshold
          })
        : undefined;
      await finishCaseRun(runId, caseRunId, {
        status: "fail",
        score: scored?.score,
        reason: `执行超过用例超时 ${formatMilliseconds(definition.timeoutMs)}`,
        error: "evaluation-case-timeout",
        finishedAt,
        durationMs,
        taskId: operationIds.taskId ?? resolvedOperationRun?.taskId,
        operationRunId: operationIds.operationRunId ?? resolvedOperationRun?.id,
        sessionId: operationIds.sessionId ?? resolvedOperationRun?.sessionId,
        artifactsCount: resolvedOperationRun?.artifactsCount ?? 0,
        summary: evaluationAssistantText || resolvedOperationRun?.summary,
        assertions: scored?.assertions ?? [],
        observability: {
          eventCount,
          tokenUsage,
          gaps: [
            ...(!resolvedOperationRun ? ["execution_result_unavailable"] : []),
            ...(!tokenUsage ? ["token_usage_unavailable"] : []),
            "evaluation_timeout"
          ]
        }
      });
      return "continue";
    }
    const operationRun = outcome.value;
    const resolvedOperationRun = await resolveOperationRun(operationRun, operationIds);
    const finishedAt = new Date().toISOString();
    const durationMs = Math.max(0, Date.parse(finishedAt) - Date.parse(startedAt));
    if (signal.aborted) return "continue";
    const scoredOperationRun = withEvaluationAssistantText(
      resolvedOperationRun,
      evaluationAssistantText
    );
    const scored = scoreEvaluationCaseRun({
      definition,
      operationRun: scoredOperationRun,
      durationMs,
      artifactsCount: resolvedOperationRun.artifactsCount,
      passThreshold: run.config.passThreshold
    });
    await finishCaseRun(runId, caseRunId, {
      status: scored.status,
      score: scored.score,
      reason: scored.reason,
      finishedAt,
      durationMs,
      taskId: operationIds.taskId ?? resolvedOperationRun.taskId,
      operationRunId: operationIds.operationRunId ?? resolvedOperationRun.id,
      sessionId: operationIds.sessionId ?? resolvedOperationRun.sessionId,
      artifactsCount: resolvedOperationRun.artifactsCount,
      summary: scoredOperationRun.summary,
      error: resolvedOperationRun.error,
      assertions: scored.assertions,
      observability: {
        eventCount,
        tokenUsage,
        gaps: [...new Set([
          ...scored.observabilityGaps.filter((gap) => gap !== "token_usage_unavailable" || !tokenUsage)
        ])]
      }
    });
    return evaluationOperationBlocksBatch(scored.status, resolvedOperationRun)
      ? "execution-blocked"
      : "continue";
  } catch (error) {
    if (signal.aborted) return "continue";
    const finishedAt = new Date().toISOString();
    await finishCaseRun(runId, caseRunId, {
      status: timedOut ? "fail" : "unknown",
      reason: timedOut ? `执行超过用例超时 ${formatMilliseconds(definition.timeoutMs)}` : "评测编排异常",
      error: error instanceof Error ? error.message : String(error),
      finishedAt,
      durationMs: Math.max(0, Date.parse(finishedAt) - Date.parse(startedAt)),
      ...operationIds,
      artifactsCount: 0,
      assertions: [],
      observability: {
        eventCount,
        tokenUsage,
        gaps: tokenUsage ? ["execution_result_unavailable"] : ["execution_result_unavailable", "token_usage_unavailable"]
      }
    });
    return providerUnavailableText(error instanceof Error ? error.message : String(error))
      ? "execution-blocked"
      : "continue";
  } finally {
    if (timeout) clearTimeout(timeout);
    signal.removeEventListener("abort", abortListener);
  }
}

async function markQueuedCasesNotRun(runId: string, reason: string): Promise<void> {
  const finishedAt = new Date().toISOString();
  await updateEvaluationRun(runId, (current) => {
    const caseRuns = current.caseRuns.map((item) => item.status === "queued"
      ? {
          ...item,
          status: "not-run" as const,
          reason,
          error: "execution-environment-unavailable-before-start",
          finishedAt,
          assertions: [],
          observability: {
            ...item.observability,
            gaps: [...new Set([...item.observability.gaps, "execution_not_started"])]
          }
        }
      : item);
    return {
      ...current,
      stopReason: "execution-environment-unavailable",
      caseRuns,
      summary: summarizeEvaluationRun(caseRuns)
    };
  });
}

export function evaluationOperationBlocksBatch(
  status: EvaluationCaseRun["status"],
  operationRun: UiOperationRun
): boolean {
  return status === "blocked" || providerUnavailableOperation(operationRun);
}

function providerUnavailableOperation(operationRun: UiOperationRun): boolean {
  if (operationRun.status === "completed") return false;
  return providerUnavailableText(operationRun.error || "");
}

function providerUnavailableText(value: string): boolean {
  return /PROVIDER_UNAVAILABLE|Provider .*(?:未返回响应|不可用|超时)|macOS Provider (?:\d+ 秒内未返回响应|不可用)/i.test(value);
}

async function finishCaseRun(
  runId: string,
  caseRunId: string,
  patch: Partial<EvaluationCaseRun>
): Promise<void> {
  await updateEvaluationRun(runId, (current) => {
    const caseRuns = current.caseRuns.map((item) => item.id === caseRunId ? { ...item, ...patch } : item);
    return {
      ...current,
      currentCaseRunId: current.currentCaseRunId === caseRunId ? undefined : current.currentCaseRunId,
      caseRuns,
      summary: summarizeEvaluationRun(caseRuns)
    };
  });
}

async function resolveOperationRun(
  operationRun: UiOperationRun,
  identifiers: { taskId?: string; operationRunId?: string }
): Promise<UiOperationRun> {
  const taskId = identifiers.taskId ?? operationRun.taskId;
  const runId = identifiers.operationRunId ?? operationRun.id;
  const task = await loadUiOperationTask(taskId).catch(() => undefined);
  return task?.runs.find((item) => item.id === runId) ?? operationRun;
}

async function waitForRecordedOperationRun(
  identifiers: { taskId?: string; operationRunId?: string }
): Promise<UiOperationRun | undefined> {
  if (!identifiers.taskId) return undefined;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const task = await loadUiOperationTask(identifiers.taskId).catch(() => undefined);
    const operationRun = identifiers.operationRunId
      ? task?.runs.find((item) => item.id === identifiers.operationRunId)
      : task?.runs.at(-1);
    if (operationRun && operationRun.status !== "running" && operationRun.status !== "waiting-approval") {
      return operationRun;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const task = await loadUiOperationTask(identifiers.taskId).catch(() => undefined);
  return identifiers.operationRunId
    ? task?.runs.find((item) => item.id === identifiers.operationRunId)
    : task?.runs.at(-1);
}

async function writeEvaluationReports(run: EvaluationRun): Promise<EvaluationRun> {
  const jsonPath = evaluationReportFile(run.id, "json");
  const htmlPath = evaluationReportFile(run.id, "html");
  const bundlePath = evaluationReportFile(run.id, "zip");
  await fs.mkdir(path.dirname(jsonPath), { recursive: true });
  const withPaths: EvaluationRun = {
    ...run,
    reportPaths: { json: "report.json", html: "report.html", bundle: "report.zip" }
  };
  const reconciled = await reconcileEvaluationRunEvidence(withPaths);
  const report = await buildEvaluationReport(reconciled);
  const reportJson = JSON.stringify(report, null, 2);
  const reportHtml = renderEvaluationHtmlReport(report);
  const reportBundle = await createEvaluationReportBundle(report, reportJson, reportHtml);
  await Promise.all([
    fs.writeFile(jsonPath, reportJson, { encoding: "utf8", mode: 0o600 }),
    fs.writeFile(htmlPath, reportHtml, { encoding: "utf8", mode: 0o600 }),
    fs.writeFile(bundlePath, reportBundle, { mode: 0o600 })
  ]);
  return updateEvaluationRun(run.id, () => reconciled);
}

/** 回查 UI 操作与 Native Rep 后重新生成历史运行报告。 */
export async function refreshEvaluationReports(runId: string): Promise<EvaluationRun> {
  return writeEvaluationReports(await loadEvaluationRun(runId));
}

async function reconcileEvaluationRunEvidence(run: EvaluationRun): Promise<EvaluationRun> {
  const caseRuns = await Promise.all(run.caseRuns.map(async (caseRun) => {
    if (!caseRun.taskId) return caseRun;
    const task = await loadUiOperationTask(caseRun.taskId).catch(() => undefined);
    const operationRun = caseRun.operationRunId
      ? task?.runs.find((item) => item.id === caseRun.operationRunId)
      : task?.runs.at(-1);
    if (!operationRun) return caseRun;
    const definition = run.suiteSnapshot.cases.find((item) => item.id === caseRun.caseId);
    const events = await readEvaluationEvents(run.id, caseRun.id, 2_000);
    const evaluationAssistantText = evaluationAssistantTextFromEvents(events);
    const scoredOperationRun = withEvaluationAssistantText(
      operationRun,
      evaluationAssistantText || caseRun.summary
    );
    const scoreResult = definition && ["pass", "fail", "blocked", "unknown", "aborted"].includes(caseRun.status)
      ? scoreEvaluationCaseRun({
          definition,
          operationRun: scoredOperationRun,
          durationMs: caseRun.durationMs ?? 0,
          artifactsCount: operationRun.artifactsCount,
          passThreshold: run.config.passThreshold
        })
      : undefined;
    const rep = await readNativeRepEvidence(operationRun.nativeArtifactDir);
    return {
      ...caseRun,
      taskId: operationRun.taskId,
      operationRunId: operationRun.id,
      sessionId: operationRun.sessionId,
      artifactsCount: operationRun.artifactsCount,
      summary: scoredOperationRun.summary,
      status: scoreResult?.status ?? caseRun.status,
      score: scoreResult?.score,
      reason: scoreResult?.reason ?? caseRun.reason,
      assertions: scoreResult?.assertions ?? caseRun.assertions,
      observability: {
        ...caseRun.observability,
        gaps: [...new Set([
          ...caseRun.observability.gaps.filter((item) => item !== "execution_result_unavailable"),
          ...rep.captureGaps
        ])]
      }
    };
  }));
  return {
    ...run,
    reportPaths: { json: "report.json", html: "report.html", bundle: "report.zip" },
    caseRuns,
    summary: summarizeEvaluationRun(caseRuns)
  };
}

export function evaluationAssistantTextFromEvents(
  events: Record<string, unknown>[]
): string | undefined {
  const text = [...events]
    .sort((left, right) => Number(left.sequence ?? 0) - Number(right.sequence ?? 0))
    .filter((event) => event.type === "text")
    .map((event) => String(event.data ?? ""))
    .join("")
    .trim();
  return text || undefined;
}

function appendEvaluationAssistantText(current: string, chunk: string): string {
  const combined = `${current}${chunk}`;
  return combined.length <= MAX_EVALUATION_ASSISTANT_TEXT
    ? combined
    : combined.slice(-MAX_EVALUATION_ASSISTANT_TEXT);
}

function withEvaluationAssistantText(
  operationRun: UiOperationRun,
  assistantText?: string
): UiOperationRun {
  const summary = assistantText?.trim();
  return summary ? { ...operationRun, summary } : operationRun;
}

async function buildEvaluationReport(run: EvaluationRun): Promise<EvaluationExperimentReport> {
  const caseDetails = await Promise.all(run.caseRuns.map(async (caseRun) => {
    const definition = run.suiteSnapshot.cases.find((item) => item.id === caseRun.caseId);
    if (!definition) throw new Error(`评测用例快照不存在：${caseRun.caseId}`);
    const task = caseRun.taskId
      ? await loadUiOperationTask(caseRun.taskId).catch(() => undefined)
      : undefined;
    const operationRun = caseRun.operationRunId
      ? task?.runs.find((item) => item.id === caseRun.operationRunId)
      : task?.runs.at(-1);
    const events = await readEvaluationEvents(run.id, caseRun.id, 2_000);
    const rep = await readNativeRepEvidence(operationRun?.nativeArtifactDir);
    const browserRep = run.config.operationType === "browser"
      ? await readBrowserRepEvidence(caseRun.sessionId)
      : undefined;
    const visualEvidence = browserRep
      ? await materializeEvaluationVisualEvidence(run.id, caseRun.id, browserRep)
      : undefined;
    const eventKinds = countBy(events.map((item) => String(item.type ?? "unknown")));
    const progressSummary = summarizeProgress(events);
    const eventSignals = analyzeEvaluationEvents(events);
    const metrics: EvaluationCaseReportDetail["metrics"] = {
      timeoutUtilizationPercent: caseRun.durationMs
        ? Math.round((caseRun.durationMs / definition.timeoutMs) * 1_000) / 10
        : undefined,
      evaluationEvents: events.length || caseRun.observability.eventCount,
      toolEvents: eventKinds.tool ?? 0,
      toolCalls: eventSignals.toolCalls,
      textEvents: eventKinds.text ?? 0,
      commandErrors: eventSignals.commandErrors,
      oversizedOutputs: eventSignals.oversizedOutputs,
      providerTimeouts: eventSignals.providerTimeouts,
      staleSnapshots: eventSignals.staleSnapshots,
      focusContextErrors: eventSignals.focusContextErrors,
      maxEventGapMs: eventSignals.maxEventGapMs,
      nativeActions: rep.actionCount,
      nativeSnapshots: rep.snapshotCount,
      nativeEvents: rep.eventCount,
      actionKinds: rep.actionKinds
    };
    const detailBase = {
      caseRunId: caseRun.id,
      caseId: caseRun.caseId,
      instruction: definition.instruction,
      tags: definition.tags,
      timeoutMs: definition.timeoutMs,
      passThreshold: definition.passThreshold ?? run.config.passThreshold,
      expectedAssertions: definition.assertions,
      identifiers: {
        taskId: caseRun.taskId,
        operationRunId: caseRun.operationRunId,
        sessionId: caseRun.sessionId,
        nativeSessionId: operationRun?.nativeSessionId
      },
      operation: {
        status: operationRun?.status,
        error: operationRun?.error,
        artifactsCount: operationRun?.artifactsCount ?? caseRun.artifactsCount,
        nativeArtifactDir: operationRun?.nativeArtifactDir,
        browserArtifactDir: browserRep?.artifactDir
      },
      metrics,
      progressSummary,
      captureGaps: rep.captureGaps,
      eventEvidencePath: `events/${caseRun.id}.jsonl`,
      artifacts: [
        ...rep.artifacts,
        ...(browserRep?.artifacts.map((artifact) => ({
          ...artifact,
          relativePath: `browser-rep/${artifact.relativePath}`
        })) ?? [])
      ],
      visualEvidence
    };
    return {
      ...detailBase,
      diagnosis: diagnoseEvaluationCase(caseRun, definition, detailBase)
    } satisfies EvaluationCaseReportDetail;
  }));
  const scoredCases = run.caseRuns.filter((item) => Number.isFinite(item.score)).length;
  const factorCounts = countBy(caseDetails.flatMap((item) => item.diagnosis.contributingFactors));
  const sharedContributingFactors = Object.entries(factorCounts)
    .filter(([, count]) => count >= 2)
    .sort((left, right) => right[1] - left[1])
    .map(([factor]) => factor);
  const recommendationCounts = countBy(caseDetails.flatMap((item) => item.diagnosis.recommendations));
  return {
    ...run,
    reportSchemaVersion: "2.0",
    generatedAt: new Date().toISOString(),
    scoreCoverage: {
      scoredCases,
      totalCases: run.caseRuns.length,
      percent: run.caseRuns.length ? Math.round((scoredCases / run.caseRuns.length) * 1_000) / 10 : 0,
      note: "平均得分仅基于已有评分的样本；未评分样本不应被视为 0 分或从失败分析中忽略。"
    },
    privacy: {
      rawApplicationContentIncluded: caseDetails.some((item) => item.visualEvidence != null),
      note: caseDetails.some((item) => item.visualEvidence != null)
        ? "报告包含每个 Browser 样本的首帧和末帧原始截图；分享前请检查页面中的账号、业务数据和其他敏感内容。"
        : "报告仅保留脱敏后的 Agent 进度摘要和结构化指标；完整 AX Tree、截图与动作流保留在对应 Rep 中。"
    },
    diagnosisSummary: {
      primaryFailureCategories: countBy(caseDetails.map((item) => item.diagnosis.category)),
      sharedContributingFactors,
      prioritizedRecommendations: Object.entries(recommendationCounts)
        .sort((left, right) => right[1] - left[1])
        .slice(0, 8)
        .map(([recommendation]) => recommendation)
    },
    caseDetails
  };
}

function diagnoseEvaluationCase(
  caseRun: EvaluationCaseRun,
  definition: EvaluationCaseDefinition,
  detail: Omit<EvaluationCaseReportDetail, "diagnosis">
): EvaluationCaseDiagnosis {
  if (caseRun.status === "pass") {
    return {
      category: "passed",
      stage: "completed",
      confidence: "high",
      primaryCause: "用例执行完成且评分断言通过",
      contributingFactors: [],
      evidence: [
        `得分 ${caseRun.score ?? "未评分"}`,
        `Native 动作 ${detail.metrics.nativeActions} 次、快照 ${detail.metrics.nativeSnapshots} 份`
      ],
      recommendations: []
    };
  }
  if (caseRun.status === "not-run") {
    return {
      category: "blocked",
      stage: "unknown",
      confidence: "high",
      primaryCause: caseRun.reason || "前置执行环境阻塞，样本未启动",
      contributingFactors: ["样本未启动，不应进入业务断言评分"],
      evidence: [
        `评测状态=${caseRun.status}`,
        `事件证据=${detail.eventEvidencePath}`
      ],
      recommendations: ["恢复基础执行环境后仅重跑未执行样本"]
    };
  }
  const timedOut = caseRun.error === "evaluation-case-timeout"
    || caseRun.reason?.includes("超时")
    || (caseRun.durationMs != null && caseRun.durationMs >= definition.timeoutMs);
  const progress = detail.progressSummary ?? "";
  const stage: EvaluationCaseDiagnosis["stage"] = /清理|关闭.*不保存|最近删除/.test(progress)
    ? "cleanup"
    : /验证|确认|最新观察|结果/.test(progress)
      ? "verification"
      : detail.metrics.nativeActions > 0
        ? "action"
        : detail.metrics.nativeSnapshots > 0
          ? "discovery"
          : "unknown";
  const contributingFactors: string[] = [];
  const recommendations: string[] = [];
  if (detail.captureGaps.includes("screen-recording-permission-denied")) {
    contributingFactors.push("屏幕录制权限缺失，视觉截图与视觉校验不可用");
    recommendations.push("评测开始前增加屏幕录制权限门禁；复杂 Office 或画布场景缺少截图时直接标记环境无效");
  }
  if (detail.metrics.toolEvents >= 250) {
    contributingFactors.push("工具流事件密度过高，观察与调用开销挤占有效操作时间");
    recommendations.push("使用 AX/DOM diff、稳定快照缓存和批量原子动作，减少无变化观察与流式工具事件");
  }
  if (detail.metrics.oversizedOutputs > 0) {
    contributingFactors.push(`AX 观察输出过大并被持久化 ${detail.metrics.oversizedOutputs} 次，模型需要额外读取和解析`);
    recommendations.push("默认使用目标化 AX 查询和结构化摘要，限制全量 Tree 输出尺寸，避免把几十至上百 KB 快照送回主 Agent");
  }
  if (detail.metrics.commandErrors > 0) {
    contributingFactors.push(`原子命令失败 ${detail.metrics.commandErrors} 次，引发重新观察和恢复路径`);
  }
  if (detail.metrics.focusContextErrors > 0 || detail.metrics.staleSnapshots > 0) {
    contributingFactors.push(`焦点令牌缺失 ${detail.metrics.focusContextErrors} 次、快照过期 ${detail.metrics.staleSnapshots} 次`);
    recommendations.push("动作结果返回可直接复用的新 snapshot/focus token，并允许一次受控自动重绑定，减少 Agent 手工恢复");
  }
  if (detail.metrics.providerTimeouts > 0) {
    contributingFactors.push(`macOS Provider 超时 ${detail.metrics.providerTimeouts} 次`);
    recommendations.push("Provider 调用增加分阶段耗时、心跳和可取消性；单次超时后快速重建连接而不是等待完整调用链");
  }
  if (detail.metrics.maxEventGapMs >= 30_000) {
    contributingFactors.push(`相邻有效事件最大停顿 ${formatMilliseconds(detail.metrics.maxEventGapMs)}`);
    recommendations.push("记录模型首 Token、工具排队、Provider 执行和结果解析耗时，针对超过 10 秒的阶段触发性能告警");
  }
  if (detail.metrics.nativeActions === 0 && detail.metrics.nativeSnapshots > 0) {
    contributingFactors.push("停留在目标发现或菜单探索阶段，未形成有效动作");
    recommendations.push("补齐菜单栏、面板和 Electron 应用的语义发现能力，并对零动作探索设置较短阶段预算");
  }
  if (timedOut) {
    contributingFactors.push("单用例硬超时触发后由评测编排器中止底层任务");
    recommendations.push("为发现、操作、验证、清理设置分阶段预算与检查点，超时前输出部分完成状态");
  }
  if (detail.metrics.nativeActions > 0) {
    recommendations.push("每个关键动作后执行目标化验证，满足断言后立即进入清理或结束，避免重复全量观察");
  }
  const evidence = [
    `评测状态=${caseRun.status}，底层操作状态=${detail.operation.status ?? "unknown"}`,
    `耗时=${caseRun.durationMs ?? 0}ms，用例上限=${definition.timeoutMs}ms`,
    `评测事件=${detail.metrics.evaluationEvents}，工具调用=${detail.metrics.toolCalls}，工具流事件=${detail.metrics.toolEvents}`,
    `命令错误=${detail.metrics.commandErrors}，大输出=${detail.metrics.oversizedOutputs}，最大事件停顿=${detail.metrics.maxEventGapMs}ms`,
    `Native 动作=${detail.metrics.nativeActions}，快照=${detail.metrics.nativeSnapshots}`,
    `产物=${detail.operation.artifactsCount}，Rep 文件=${detail.artifacts.length}`,
    ...(detail.captureGaps.length ? [`采集缺口=${detail.captureGaps.join(",")}`] : []),
    `事件证据=${detail.eventEvidencePath}`
  ];
  return {
    category: detail.metrics.providerTimeouts > 0
      ? "provider"
      : caseRun.status === "blocked"
        ? "blocked"
        : timedOut
      ? "timeout"
      : caseRun.status === "fail" && caseRun.assertions.some((item) => item.status === "fail")
        ? "assertion"
        : caseRun.error
          ? "execution"
          : detail.captureGaps.length
            ? "observability"
            : "unknown",
    stage,
    confidence: timedOut || detail.metrics.providerTimeouts > 0 || caseRun.status === "blocked"
      ? "high"
      : "medium",
    primaryCause: detail.metrics.providerTimeouts > 0
      ? `Provider 写操作通道超时 ${detail.metrics.providerTimeouts} 次，样本未进入可评分状态`
      : timedOut
      ? `用例在 ${formatMilliseconds(definition.timeoutMs)} 内未完成最终验证与清理，评测编排器按上限中止任务`
      : caseRun.reason || caseRun.error || "现有证据不足以归因",
    contributingFactors: [...new Set(contributingFactors)],
    evidence,
    recommendations: [...new Set(recommendations)]
  };
}

async function readNativeRepEvidence(nativeArtifactDir?: string): Promise<{
  captureGaps: string[];
  actionCount: number;
  snapshotCount: number;
  eventCount: number;
  actionKinds: Record<string, number>;
  artifacts: EvaluationReportArtifact[];
}> {
  const empty = {
    captureGaps: [] as string[],
    actionCount: 0,
    snapshotCount: 0,
    eventCount: 0,
    actionKinds: {} as Record<string, number>,
    artifacts: [] as EvaluationReportArtifact[]
  };
  if (!nativeArtifactDir) return empty;
  try {
    const manifest = JSON.parse(await fs.readFile(path.join(nativeArtifactDir, "manifest.json"), "utf8")) as Record<string, unknown>;
    const actions = await readJsonLines(path.join(nativeArtifactDir, "streams", "actions.jsonl"));
    const snapshots = await readJsonLines(path.join(nativeArtifactDir, "streams", "snapshots.jsonl"));
    const events = await readJsonLines(path.join(nativeArtifactDir, "streams", "events.jsonl"));
    const artifacts = await listReportArtifacts(nativeArtifactDir);
    return {
      captureGaps: Array.isArray(manifest.captureGaps)
        ? manifest.captureGaps.map(String)
        : [],
      actionCount: actions.length,
      snapshotCount: snapshots.length,
      eventCount: events.length,
      actionKinds: countBy(actions.map((item) => String(item.kind ?? "unknown"))),
      artifacts
    };
  } catch {
    return empty;
  }
}

async function readBrowserRepEvidence(sessionId?: string): Promise<{
  artifactDir: string;
  artifacts: EvaluationReportArtifact[];
  firstScreenshot?: EvaluationReportArtifact;
  lastScreenshot?: EvaluationReportArtifact;
} | undefined> {
  if (!sessionId) return undefined;
  try {
    const session = await loadSession(sessionId);
    const root = path.join(session.workspacePath, ".skill-output", "browser-reps");
    const candidates = await Promise.all((await fs.readdir(root, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map(async (entry) => {
        const artifactDir = path.join(root, entry.name);
        const stat = await fs.stat(artifactDir);
        return { artifactDir, modifiedAt: stat.mtimeMs };
      }));
    const selected = candidates.sort((left, right) => right.modifiedAt - left.modifiedAt)[0];
    if (!selected) return undefined;
    const artifacts = await listReportArtifacts(selected.artifactDir);
    const screenshots = artifacts
      .filter((artifact) => artifact.kind === "screenshot")
      .sort((left, right) => left.relativePath.localeCompare(right.relativePath));
    return {
      artifactDir: selected.artifactDir,
      artifacts,
      firstScreenshot: screenshots[0],
      lastScreenshot: screenshots.at(-1)
    };
  } catch {
    return undefined;
  }
}

async function materializeEvaluationVisualEvidence(
  runId: string,
  caseRunId: string,
  browserRep: {
    artifactDir: string;
    firstScreenshot?: EvaluationReportArtifact;
    lastScreenshot?: EvaluationReportArtifact;
  }
): Promise<EvaluationCaseReportDetail["visualEvidence"]> {
  const copy = async (
    label: "first" | "last",
    artifact?: EvaluationReportArtifact
  ) => {
    if (!artifact) return undefined;
    const extension = path.extname(artifact.relativePath).toLowerCase() || ".png";
    const reportPath = `evidence/${caseRunId}/${label}${extension}`;
    const destination = path.join(path.dirname(evaluationReportFile(runId, "json")), reportPath);
    await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
    await fs.copyFile(path.join(browserRep.artifactDir, artifact.relativePath), destination);
    return {
      reportPath,
      sourceRelativePath: artifact.relativePath,
      size: artifact.size
    };
  };
  const firstScreenshot = await copy("first", browserRep.firstScreenshot);
  const lastScreenshot = browserRep.lastScreenshot?.relativePath === browserRep.firstScreenshot?.relativePath
    ? firstScreenshot
    : await copy("last", browserRep.lastScreenshot);
  return firstScreenshot || lastScreenshot ? { firstScreenshot, lastScreenshot } : undefined;
}

async function readJsonLines(filePath: string): Promise<Record<string, unknown>[]> {
  try {
    const content = await fs.readFile(filePath, "utf8");
    return content.split(/\r?\n/).filter(Boolean).flatMap((line) => {
      try {
        const parsed = JSON.parse(line) as unknown;
        return parsed && typeof parsed === "object" && !Array.isArray(parsed)
          ? [parsed as Record<string, unknown>]
          : [];
      } catch {
        return [];
      }
    });
  } catch {
    return [];
  }
}

async function listReportArtifacts(root: string): Promise<EvaluationReportArtifact[]> {
  const result: EvaluationReportArtifact[] = [];
  const visit = async (directory: string) => {
    if (result.length >= 200) return;
    const entries = await fs.readdir(directory, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (result.length >= 200) break;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(absolute);
      else if (entry.isFile()) {
        const stat = await fs.stat(absolute).catch(() => undefined);
        const relativePath = path.relative(root, absolute).split(path.sep).join("/");
        result.push({
          name: entry.name,
          relativePath,
          kind: reportArtifactKind(relativePath),
          size: stat?.size ?? 0
        });
      }
    }
  };
  await visit(root);
  return result.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}

function reportArtifactKind(relativePath: string): EvaluationReportArtifact["kind"] {
  if (relativePath === "manifest.json") return "manifest";
  if (relativePath.includes("actions.jsonl")) return "actions";
  if (relativePath.includes("snapshots")) return "snapshots";
  if (relativePath.includes("events.jsonl")) return "events";
  if (/\.(png|jpe?g|webp)$/i.test(relativePath)) return "screenshot";
  if (relativePath.includes("schema")) return "schema";
  if (/\.(html|md)$/i.test(relativePath)) return "report";
  return "other";
}

function summarizeProgress(events: Record<string, unknown>[]): string | undefined {
  const text = events
    .filter((item) => item.type === "text")
    .map((item) => String(item.data ?? ""))
    .join("")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return undefined;
  return redactReportText(text.slice(-1_600));
}

function analyzeEvaluationEvents(events: Record<string, unknown>[]): {
  toolCalls: number;
  commandErrors: number;
  oversizedOutputs: number;
  providerTimeouts: number;
  staleSnapshots: number;
  focusContextErrors: number;
  maxEventGapMs: number;
} {
  const serialized = events.map((item) => eventDataText(item));
  let maxEventGapMs = 0;
  for (let index = 1; index < events.length; index += 1) {
    const previous = Date.parse(String(events[index - 1].timestamp ?? ""));
    const current = Date.parse(String(events[index].timestamp ?? ""));
    if (Number.isFinite(previous) && Number.isFinite(current)) {
      maxEventGapMs = Math.max(maxEventGapMs, current - previous);
    }
  }
  return {
    toolCalls: events.filter((item) =>
      item.type === "tool"
      && item.data != null
      && typeof item.data === "object"
      && !Array.isArray(item.data)
      && (item.data as Record<string, unknown>).phase === "start"
    ).length,
    commandErrors: serialized.filter((value) => /Exit code [1-9]|"ok":false|command failed/i.test(value)).length,
    oversizedOutputs: serialized.filter((value) => /persisted-output|Output too large/i.test(value)).length,
    providerTimeouts: serialized.filter((value) => /PROVIDER_UNAVAILABLE|Provider .*未返回响应|provider.*timed out/i.test(value)).length,
    staleSnapshots: serialized.filter((value) => /STALE_SNAPSHOT|快照.*过期|目标元素已变化/i.test(value)).length,
    focusContextErrors: serialized.filter((value) => /FOCUS_CONTEXT_MISSING|焦点令牌/i.test(value)).length,
    maxEventGapMs
  };
}

function eventDataText(event: Record<string, unknown>): string {
  if (typeof event.data === "string") return event.data;
  try {
    return JSON.stringify(event.data ?? "");
  } catch {
    return "";
  }
}

function redactReportText(value: string): string {
  return value
    .replace(/https?:\/\/\S+/gi, "[URL_REDACTED]")
    .replace(/\b(?:token|secret|password|authorization|cookie|ctoken)\s*[:=]\s*\S+/gi, "$1=[REDACTED]")
    .replace(/\b(?:AK|SK)[A-Za-z0-9_-]{8,}\b/g, "[CREDENTIAL_REDACTED]");
}

function countBy(values: string[]): Record<string, number> {
  return values.reduce<Record<string, number>>((result, value) => {
    result[value] = (result[value] ?? 0) + 1;
    return result;
  }, {});
}

async function createEvaluationReportBundle(
  report: EvaluationExperimentReport,
  reportJson: string,
  reportHtml: string
): Promise<Buffer> {
  const files: Record<string, Uint8Array> = {
    "report.json": strToU8(reportJson),
    "report.html": strToU8(reportHtml),
    "README.md": strToU8([
      `# ${report.suiteName}`,
      "",
      `Run ID: ${report.id}`,
      `Generated at: ${report.generatedAt}`,
      "",
      "- `report.json`: 面向 Coder 的结构化诊断、指标、断言和证据索引。",
      "- `report.html`: 面向用户的可视化报告。",
      "- `events/`: 每个评测样本的原始编排事件流。",
      "- `native-reps/`: 每个电脑操作样本的 Native Rep；可能包含应用可访问性内容，仅限受信环境分析。",
      "",
      "报告默认不把原始应用正文复制到诊断摘要，但 events 与 Native Rep 是原始证据，分享前请按数据安全要求检查。"
    ].join("\n"))
  };
  let totalBytes = Object.values(files).reduce((sum, value) => sum + value.byteLength, 0);
  const maxBundleInputBytes = 100 * 1024 * 1024;
  const maxFileBytes = 25 * 1024 * 1024;
  for (const detail of report.caseDetails) {
    const eventSource = path.join(path.dirname(evaluationReportFile(report.id, "json")), detail.eventEvidencePath);
    const eventContent = await fs.readFile(eventSource).catch(() => undefined);
    if (eventContent && eventContent.byteLength <= maxFileBytes && totalBytes + eventContent.byteLength <= maxBundleInputBytes) {
      files[detail.eventEvidencePath] = eventContent;
      totalBytes += eventContent.byteLength;
    }
    if (!detail.operation.nativeArtifactDir && !detail.operation.browserArtifactDir) continue;
    for (const artifact of detail.artifacts) {
      const browserArtifact = artifact.relativePath.startsWith("browser-rep/");
      const artifactRoot = browserArtifact
        ? detail.operation.browserArtifactDir
        : detail.operation.nativeArtifactDir;
      if (!artifactRoot) continue;
      const sourceRelativePath = browserArtifact
        ? artifact.relativePath.slice("browser-rep/".length)
        : artifact.relativePath;
      const source = path.resolve(artifactRoot, sourceRelativePath);
      if (!source.startsWith(`${path.resolve(artifactRoot)}${path.sep}`)) continue;
      if (artifact.size > maxFileBytes || totalBytes + artifact.size > maxBundleInputBytes) continue;
      const content = await fs.readFile(source).catch(() => undefined);
      if (!content) continue;
      const repPrefix = `${browserArtifact ? "browser-reps" : "native-reps"}/${safeBundleSegment(detail.caseId)}-${safeBundleSegment(detail.caseRunId.slice(0, 8))}`;
      files[`${repPrefix}/${sourceRelativePath}`] = content;
      totalBytes += content.byteLength;
    }
    for (const screenshot of [
      detail.visualEvidence?.firstScreenshot,
      detail.visualEvidence?.lastScreenshot
    ]) {
      if (!screenshot || files[screenshot.reportPath]) continue;
      const source = path.join(path.dirname(evaluationReportFile(report.id, "json")), screenshot.reportPath);
      const content = await fs.readFile(source).catch(() => undefined);
      if (!content || totalBytes + content.byteLength > maxBundleInputBytes) continue;
      files[screenshot.reportPath] = content;
      totalBytes += content.byteLength;
    }
  }
  return Buffer.from(zipSync(files, { level: 6 }));
}

function safeBundleSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 80) || "unknown";
}

export function normalizeEvaluationRunConfig(input: StartEvaluationInput): EvaluationRunConfig {
  if (input.operationType !== "browser" && input.operationType !== "computer") {
    throw new Error("UI 操作类型必须是 browser 或 computer");
  }
  const operationType = input.operationType;
  if (
    operationType === "browser"
    && input.browserKernel != null
    && !["playwright", "uiwarden-embedded", "external-cdp", "gui-computer"].includes(input.browserKernel)
  ) {
    throw new Error(`不支持的浏览器执行内核：${String(input.browserKernel)}`);
  }
  if (
    operationType === "computer"
    && input.providerId != null
    && !["mock", "macos-accessibility", "windows-ui-automation"].includes(input.providerId)
  ) {
    throw new Error(`不支持的 Computer Provider：${String(input.providerId)}`);
  }
  if (
    input.nativeDeliveryMode != null
    && input.nativeDeliveryMode !== "foreground-compatible"
    && input.nativeDeliveryMode !== "background-safe"
  ) {
    throw new Error(`不支持的动作投递模式：${String(input.nativeDeliveryMode)}`);
  }
  if (
    input.guiRuntimeTransport != null
    && !["inherit", "cli", "mcp"].includes(input.guiRuntimeTransport)
  ) {
    throw new Error(`不支持的 GUI Runtime 传输模式：${String(input.guiRuntimeTransport)}`);
  }
  const executionRuntimeIdValue = String(input.executionRuntimeId ?? "").trim();
  if (
    executionRuntimeIdValue
    && !["cfuse", "codex", "dtcoder", "claude-code"].includes(executionRuntimeIdValue)
  ) {
    throw new Error(`不支持的执行底座：${executionRuntimeIdValue}`);
  }
  const model = String(input.model ?? "").trim();
  if (model.length > 300) throw new Error("模型 ID 最多 300 个字符");
  const browserKernel = normalizeBrowserKernel(input.browserKernel);
  const providerId = normalizeProvider(input.providerId);
  const repetitions = boundedInteger(input.repetitions, 1, 1, 20);
  const concurrency = 1;
  return {
    operationType,
    browserKernel: operationType === "browser" ? browserKernel : undefined,
    providerId: operationType === "computer" ? providerId : undefined,
    nativeDeliveryMode: input.nativeDeliveryMode === "background-safe"
      ? "background-safe"
      : "foreground-compatible",
    ...(operationType === "computer"
      ? { guiRuntimeTransport: input.guiRuntimeTransport ?? "inherit" }
      : {}),
    executionRuntimeId: executionRuntimeIdValue
      ? executionRuntimeIdValue as ExecutionRuntimeId
      : undefined,
    model: model || undefined,
    businessId: String(input.businessId ?? "").trim() || undefined,
    repetitions,
    passThreshold: boundedNumber(input.passThreshold, 70, 0, 100),
    concurrency
  };
}

function buildExecutionTarget(
  config: EvaluationRunConfig,
  definition: EvaluationCaseDefinition,
  targetServices?: EvaluationRun["environment"]["targetServices"]
): UiOperationExecutionTarget {
  if (config.operationType === "computer") {
    return {
      kind: "native-app",
      providerId: config.providerId ?? "mock",
      app: AGENT_SELECTED_APP,
      displayName: "Agent 自动选择"
    };
  }
  return {
    kind: "browser",
    browserKernel: config.browserKernel ?? "playwright",
    targetUrl: resolveEvaluationTargetUrl(definition.targetUrl, targetServices)
  };
}

function evaluationExecutionChain(config: EvaluationRunConfig): string[] {
  if (config.operationType === "computer") {
    return [
      "主 Agent",
      "dt-gui-computer-skill",
      "dt-gui-computer Runtime",
      config.providerId ?? "mock"
    ];
  }
  return [
    "主 Agent",
    "dt-gui-browser-skill",
    "dt-gui-browser Runtime",
    config.browserKernel === "playwright"
      ? "Playwright 配套 Chromium"
      : config.browserKernel ?? "Playwright 配套 Chromium"
  ];
}

function createCaseRun(definition: EvaluationCaseDefinition, repetition: number): EvaluationCaseRun {
  return {
    id: randomUUID(),
    caseId: definition.id,
    caseName: definition.name,
    category: definition.category,
    repetition,
    attemptNumber: 1,
    status: "queued",
    artifactsCount: 0,
    assertions: [],
    observability: { eventCount: 0, gaps: [] }
  };
}

export function extractEvaluationOperationIds(payload: StreamPayload): {
  taskId?: string;
  operationRunId?: string;
  sessionId?: string;
} | undefined {
  if (payload.type !== "session" || !payload.data || typeof payload.data !== "object") return undefined;
  const value = payload.data as Record<string, unknown>;
  const taskId = optionalString(value.operationTaskId);
  const operationRunId = optionalString(value.operationRunId);
  if (!taskId && !operationRunId) return undefined;
  const sessionId = optionalString(value.sessionId);
  return {
    ...(taskId ? { taskId } : {}),
    ...(operationRunId ? { operationRunId } : {}),
    ...(sessionId ? { sessionId } : {})
  };
}

function compactPayload(payload: StreamPayload): Record<string, unknown> {
  if (payload.type === "text") {
    return { type: payload.type, data: String(payload.data ?? "").slice(0, 2_000) };
  }
  if (payload.type === "screenshot") {
    const data = payload.data && typeof payload.data === "object"
      ? payload.data as Record<string, unknown>
      : {};
    return {
      type: payload.type,
      data: {
        relativePath: data.relativePath,
        url: data.url,
        stepIndex: data.stepIndex,
        actionSummary: data.actionSummary
      }
    };
  }
  const serialized = JSON.stringify(payload.data ?? null);
  return {
    type: payload.type,
    data: serialized.length > 4_000 ? `${serialized.slice(0, 4_000)}…` : payload.data
  };
}

function extractTokenUsage(payload: StreamPayload): EvaluationCaseRun["observability"]["tokenUsage"] {
  const records: Record<string, unknown>[] = [];
  collectRecords(payload.data, records, 0);
  for (const record of records) {
    const inputTokens = numeric(record.input_tokens ?? record.inputTokens);
    const outputTokens = numeric(record.output_tokens ?? record.outputTokens);
    const totalTokens = numeric(record.total_tokens ?? record.totalTokens);
    if (inputTokens != null || outputTokens != null || totalTokens != null) {
      return {
        inputTokens,
        outputTokens,
        totalTokens: totalTokens ?? ((inputTokens ?? 0) + (outputTokens ?? 0))
      };
    }
  }
  return undefined;
}

function collectRecords(value: unknown, result: Record<string, unknown>[], depth: number): void {
  if (depth > 3 || value == null) return;
  if (Array.isArray(value)) {
    value.slice(0, 20).forEach((item) => collectRecords(item, result, depth + 1));
    return;
  }
  if (typeof value !== "object") return;
  const record = value as Record<string, unknown>;
  result.push(record);
  Object.values(record).slice(0, 30).forEach((item) => collectRecords(item, result, depth + 1));
}

function mergeTokenUsage(
  current: EvaluationCaseRun["observability"]["tokenUsage"],
  next: EvaluationCaseRun["observability"]["tokenUsage"]
): EvaluationCaseRun["observability"]["tokenUsage"] {
  if (!next) return current;
  if (!current) return next;
  return {
    inputTokens: Math.max(current.inputTokens ?? 0, next.inputTokens ?? 0) || undefined,
    outputTokens: Math.max(current.outputTokens ?? 0, next.outputTokens ?? 0) || undefined,
    totalTokens: Math.max(current.totalTokens ?? 0, next.totalTokens ?? 0) || undefined
  };
}

function normalizeBrowserKernel(value: unknown): BrowserKernel {
  if (value === "playwright" || value === "external-cdp" || value === "gui-computer") return value;
  return "playwright";
}

function normalizeProvider(value: unknown): NativeProviderId {
  if (value === "macos-accessibility" || value === "windows-ui-automation" || value === "mock") return value;
  if (process.platform === "darwin" && isDesktopMode()) return "macos-accessibility";
  if (process.platform === "win32" && isDesktopMode()) return "windows-ui-automation";
  return "mock";
}

function boundedInteger(value: unknown, fallback: number, min: number, max: number): number {
  return Math.round(boundedNumber(value, fallback, min, max));
}

function boundedNumber(value: unknown, fallback: number, min: number, max: number): number {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(min, Math.min(max, number)) : fallback;
}

function optionalString(value: unknown): string | undefined {
  const result = String(value ?? "").trim();
  return result || undefined;
}

function numeric(value: unknown): number | undefined {
  const result = Number(value);
  return Number.isFinite(result) && result >= 0 ? result : undefined;
}

function formatMilliseconds(value: number): string {
  return value >= 60_000
    ? `${Math.round(value / 60_000)} 分钟`
    : `${Math.round(value / 1_000)} 秒`;
}
