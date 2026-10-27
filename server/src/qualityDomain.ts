import { listBusinessEnvironments } from "./configStore.js";
import { listInspectionTasks } from "./inspections.js";
import { listRegressionBatches } from "./regressionStore.js";
import { getSessionArtifactCounts, listSessionSummaries } from "./storage.js";
import { listUiOperationTasks } from "./uiOperationStore.js";
import type {
  AgentSession,
  ExecutionPurpose,
  QualityAssertion,
  QualityDashboard,
  QualityRunSource,
  QualityTrendPoint,
  QualityStep,
  TestOutcome,
  UnifiedQualityRun,
  UiOperationRun
} from "./types.js";

interface SourceMetadata {
  source: QualityRunSource;
  purpose: "test" | "operation";
  sourceId?: string;
  sourceName: string;
  environmentId?: string;
  environmentName?: string;
  status?: UnifiedQualityRun["status"];
  outcome?: TestOutcome;
  startedAt?: string;
  finishedAt?: string;
  summary?: string;
  error?: string;
  artifactsCount?: number;
}

/** 将现有会话、巡检、回归和通用操作投影为统一运行模型。 */
export async function listUnifiedQualityRuns(limit = 300): Promise<UnifiedQualityRun[]> {
  const [sessions, inspections, batches, operations, environments] = await Promise.all([
    listSessionSummaries(),
    listInspectionTasks(),
    listRegressionBatches(),
    listUiOperationTasks(),
    listBusinessEnvironments()
  ]);
  const artifactCounts = await getSessionArtifactCounts(sessions.map((session) => session.id));
  const environmentNames = new Map(environments.map((environment) => [environment.id, environment.name]));
  const sourceBySession = new Map<string, SourceMetadata>();
  for (const task of inspections) {
    for (const run of task.runs) {
      sourceBySession.set(run.sessionId, {
        source: "inspection",
        purpose: "test",
        sourceId: task.id,
        sourceName: task.name,
        environmentId: task.businessId,
        environmentName: task.businessId ? environmentNames.get(task.businessId) : undefined,
        status: run.status === "failed" && /手动中止|主动中止/.test(run.error ?? "") ? "aborted" : run.status,
        outcome: run.testOutcome ?? "unknown",
        startedAt: run.startedAt,
        finishedAt: run.finishedAt,
        summary: run.summary,
        error: run.error,
        artifactsCount: run.artifactsCount
      });
    }
  }
  for (const batch of batches) {
    for (const run of batch.runs) {
      sourceBySession.set(run.sessionId, {
        source: "regression",
        purpose: "test",
        sourceId: run.id,
        sourceName: run.caseName,
        status: normalizeStatus(run.status),
        outcome: run.testOutcome ?? "unknown",
        startedAt: run.startedAt,
        finishedAt: run.finishedAt,
        summary: run.summary,
        error: run.error,
        artifactsCount: run.artifactsCount
      });
    }
  }
  for (const task of operations) {
    for (const run of task.runs) {
      sourceBySession.set(run.sessionId, operationMetadata(task.name, task.businessId, environmentNames.get(task.businessId ?? ""), run));
    }
  }
  return sessions.map((session) => toUnifiedRun(
    session,
    sourceBySession.get(session.id),
    artifactCounts.get(session.id) ?? 0
  ))
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
    .slice(0, Math.max(1, Math.min(limit, 1000)));
}

/** 读取单个统一质量运行。 */
export async function getUnifiedQualityRun(idOrSessionId: string): Promise<UnifiedQualityRun> {
  const run = (await listUnifiedQualityRuns(1000)).find((item) => item.id === idOrSessionId || item.sessionId === idOrSessionId);
  if (!run) throw new Error(`统一运行不存在：${idOrSessionId}`);
  return run;
}

/** 生成质量看板指标；通用 UI 操作仅进入来源统计，不参与测试通过率。 */
export async function getQualityDashboard(): Promise<QualityDashboard> {
  const runs = await listUnifiedQualityRuns(1000);
  return summarizeQualityRuns(runs);
}

/** 汇总统一运行指标；通用 UI 操作不会污染测试通过率。 */
export function summarizeQualityRuns(runs: UnifiedQualityRun[], now = new Date()): QualityDashboard {
  const testRuns = runs.filter((run) => run.purpose === "test" && run.status !== "idle");
  const finished = testRuns.filter((run) => ["completed", "failed"].includes(run.status));
  const failed = finished.filter((run) => run.outcome === "fail" || run.status === "failed").length;
  const passed = finished.filter((run) => run.status !== "failed" && run.outcome === "pass").length;
  const unknown = Math.max(0, finished.length - passed - failed);
  const aborted = testRuns.filter((run) => run.status === "aborted").length;
  const durations = finished.map((run) => run.durationMs).filter((value): value is number => value != null && value >= 0);
  const artifactsComplete = finished.filter((run) => run.artifactsCount > 0).length;
  const bySource: Record<QualityRunSource, number> = { conversation: 0, inspection: 0, regression: 0, "ui-operation": 0 };
  for (const run of runs) bySource[run.source] += 1;
  return {
    generatedAt: now.toISOString(),
    total: testRuns.length,
    running: testRuns.filter((run) => run.status === "running" || run.status === "queued").length,
    passed,
    failed,
    unknown,
    aborted,
    passRate: finished.length ? Number(((passed / finished.length) * 100).toFixed(1)) : 0,
    artifactCompletenessRate: finished.length ? Number(((artifactsComplete / finished.length) * 100).toFixed(1)) : 0,
    averageDurationMs: durations.length ? Math.round(durations.reduce((sum, value) => sum + value, 0) / durations.length) : 0,
    bySource,
    trends: buildTrends(testRuns, 14, now),
    recentRuns: runs.slice(0, 20)
  };
}

function toUnifiedRun(
  session: AgentSession,
  metadata?: SourceMetadata,
  sessionArtifactsCount = 0
): UnifiedQualityRun {
  const startedAt = metadata?.startedAt ?? session.createdAt;
  const finishedAt = metadata?.finishedAt ?? (session.status === "completed" || session.status === "failed" ? session.updatedAt : undefined);
  const purpose = metadata?.purpose ?? "test";
  const status = metadata?.status ?? normalizeStatus(session.status);
  const outcome = metadata?.outcome ?? session.testOutcome ?? "unknown";
  const artifactsCount = metadata?.artifactsCount ?? sessionArtifactsCount;
  const evidence = buildQualityEvidenceProjection({ purpose, status, outcome, artifactsCount });
  return {
    id: `${metadata?.source ?? "conversation"}:${metadata?.sourceId ?? session.id}`,
    sessionId: session.id,
    purpose,
    source: metadata?.source ?? "conversation",
    sourceId: metadata?.sourceId,
    sourceName: metadata?.sourceName ?? session.title,
    status,
    outcome,
    browserKernel: session.browserKernel,
    environmentId: metadata?.environmentId,
    environmentName: metadata?.environmentName,
    startedAt,
    finishedAt,
    durationMs: finishedAt ? Math.max(0, new Date(finishedAt).getTime() - new Date(startedAt).getTime()) : undefined,
    summary: metadata?.summary ?? session.testSummary,
    error: metadata?.error ?? session.lastError,
    artifactsCount,
    steps: evidence.steps,
    assertions: evidence.assertions
  };
}

export function buildQualityEvidenceProjection(input: {
  purpose: ExecutionPurpose;
  status: UnifiedQualityRun["status"];
  outcome: TestOutcome;
  artifactsCount: number;
}): { steps: QualityStep[]; assertions: QualityAssertion[] } {
  const executionStatus: QualityStep["status"] = input.status === "idle" || input.status === "queued"
    ? "pending"
    : input.status === "running" || input.status === "waiting-approval"
      ? "running"
      : input.status === "completed"
        ? "completed"
        : input.status === "aborted"
          ? "skipped"
          : "failed";
  const terminal = ["completed", "failed", "aborted"].includes(input.status);
  const steps: QualityStep[] = [
    { id: "execution", title: "执行任务", status: executionStatus, evidencePaths: [] },
    {
      id: "evidence",
      title: "采集执行证据",
      status: !terminal ? "pending" : input.artifactsCount > 0 ? "completed" : "failed",
      evidencePaths: input.artifactsCount > 0 ? ["artifacts://session"] : []
    }
  ];
  const assertions: QualityAssertion[] = [
    {
      id: "execution-completed",
      title: "执行链路完成",
      status: input.status === "completed" ? "pass" : input.status === "failed" ? "fail" : "unknown",
      evidencePaths: []
    }
  ];
  if (input.purpose === "test") {
    assertions.push({
      id: "test-outcome",
      title: "测试结论",
      status: input.outcome,
      evidencePaths: input.artifactsCount > 0 ? ["artifacts://session"] : []
    });
  }
  return { steps, assertions };
}

function operationMetadata(
  taskName: string,
  businessId: string | undefined,
  environmentName: string | undefined,
  run: UiOperationRun
): SourceMetadata {
  return {
    source: "ui-operation",
    purpose: "operation",
    sourceId: run.id,
    sourceName: taskName,
    environmentId: businessId,
    environmentName,
    status: normalizeStatus(run.status),
    outcome: "unknown",
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    summary: run.summary,
    error: run.error,
    artifactsCount: run.artifactsCount
  };
}

function normalizeStatus(status: string): UnifiedQualityRun["status"] {
  if (status === "idle") return "idle";
  if (status === "pending") return "queued";
  if (status === "waiting-approval") return "waiting-approval";
  if (status === "running" || status === "completed" || status === "failed" || status === "aborted") return status;
  return "failed";
}

function buildTrends(runs: UnifiedQualityRun[], days: number, now: Date): QualityTrendPoint[] {
  const points: QualityTrendPoint[] = [];
  for (let offset = days - 1; offset >= 0; offset -= 1) {
    const date = new Date(now);
    date.setHours(0, 0, 0, 0);
    date.setDate(date.getDate() - offset);
    const key = localDateKey(date);
    const daily = runs.filter((run) => localDateKey(new Date(run.startedAt)) === key);
    points.push({
      date: key,
      total: daily.length,
      passed: daily.filter((run) => run.status === "completed" && run.outcome === "pass").length,
      failed: daily.filter((run) => run.status === "failed" || (run.status === "completed" && run.outcome === "fail")).length,
      unknown: daily.filter((run) => run.status === "completed" && run.outcome === "unknown").length,
      aborted: daily.filter((run) => run.status === "aborted").length
    });
  }
  return points;
}

function localDateKey(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}
