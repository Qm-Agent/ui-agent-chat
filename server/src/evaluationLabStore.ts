import fs from "node:fs/promises";
import path from "node:path";
import { evaluationLabDir } from "./paths.js";
import type {
  EvaluationCaseRun,
  EvaluationPlan,
  EvaluationRun,
  EvaluationRunSummary,
  EvaluationRunStatus,
  EvaluationSuite
} from "./types.js";

let mutationQueue: Promise<void> = Promise.resolve();

export interface EvaluationRunListItem {
  id: string;
  planId?: string;
  planName?: string;
  rerunOfRunId?: string;
  rerunOfCaseRunId?: string;
  suiteId: string;
  suiteName: string;
  suiteHash: string;
  status: EvaluationRunStatus;
  config: EvaluationRun["config"];
  environment: EvaluationRun["environment"];
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  stopReason?: string;
  currentCaseRunId?: string;
  resumeHistory?: EvaluationRun["resumeHistory"];
  summary: EvaluationRunSummary;
  reportPaths?: EvaluationRun["reportPaths"];
}

/** 初始化评测实验室目录化存储。 */
export async function ensureEvaluationLabStorage(): Promise<void> {
  await fs.mkdir(runArtifactsDirectory(), { recursive: true });
  await ensureJsonArrayFile(suitesFile());
  await ensureJsonArrayFile(plansFile());
  await ensureJsonArrayFile(runsFile());
}

/** 返回最近更新的评测集。 */
export async function listEvaluationSuites(): Promise<EvaluationSuite[]> {
  return (await readArray<EvaluationSuite>(suitesFile()))
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

/** 读取指定评测集。 */
export async function loadEvaluationSuite(id: string): Promise<EvaluationSuite> {
  const suite = (await readArray<EvaluationSuite>(suitesFile())).find((item) => item.id === id);
  if (!suite) throw new Error(`评测集不存在：${id}`);
  return structuredClone(suite);
}

/** 新建或覆盖评测集。 */
export async function saveEvaluationSuite(suite: EvaluationSuite): Promise<EvaluationSuite> {
  return withMutation(async () => {
    const suites = await readArray<EvaluationSuite>(suitesFile());
    const existingIndex = suites.findIndex((item) => item.id === suite.id);
    if (existingIndex >= 0) suites[existingIndex] = suite;
    else suites.unshift(suite);
    await writeArray(suitesFile(), suites);
    return structuredClone(suite);
  });
}

/** 删除评测集定义；历史运行保留完整快照，不受影响。 */
export async function deleteEvaluationSuite(id: string): Promise<void> {
  await withMutation(async () => {
    const suites = await readArray<EvaluationSuite>(suitesFile());
    if (!suites.some((item) => item.id === id)) throw new Error(`评测集不存在：${id}`);
    await writeArray(suitesFile(), suites.filter((item) => item.id !== id));
  });
}

/** 返回最近更新的评测方案。 */
export async function listEvaluationPlans(): Promise<EvaluationPlan[]> {
  return (await readArray<EvaluationPlan>(plansFile()))
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

/** 读取指定评测方案。 */
export async function loadEvaluationPlan(id: string): Promise<EvaluationPlan> {
  const plan = (await readArray<EvaluationPlan>(plansFile())).find((item) => item.id === id);
  if (!plan) throw new Error(`评测方案不存在：${id}`);
  return structuredClone(plan);
}

/** 新建或覆盖评测方案。 */
export async function saveEvaluationPlan(plan: EvaluationPlan): Promise<EvaluationPlan> {
  return withMutation(async () => {
    const plans = await readArray<EvaluationPlan>(plansFile());
    const existingIndex = plans.findIndex((item) => item.id === plan.id);
    if (existingIndex >= 0) plans[existingIndex] = plan;
    else plans.unshift(plan);
    await writeArray(plansFile(), plans);
    return structuredClone(plan);
  });
}

/** 删除评测方案；历史运行继续保留方案与评测集快照。 */
export async function deleteEvaluationPlan(id: string): Promise<void> {
  await withMutation(async () => {
    const plans = await readArray<EvaluationPlan>(plansFile());
    if (!plans.some((item) => item.id === id)) throw new Error(`评测方案不存在：${id}`);
    await writeArray(plansFile(), plans.filter((item) => item.id !== id));
  });
}

/** 返回运行列表轻量投影，避免列表接口传输整个评测集快照与用例明细。 */
export async function listEvaluationRuns(limit = 100): Promise<EvaluationRunListItem[]> {
  return (await readArray<EvaluationRun>(runsFile()))
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
    .slice(0, Math.max(1, Math.min(limit, 500)))
    .map(({ suiteSnapshot: _suiteSnapshot, planSnapshot: _planSnapshot, caseRuns: _caseRuns, ...item }) => item);
}

/** 读取完整实验运行。 */
export async function loadEvaluationRun(id: string): Promise<EvaluationRun> {
  const run = (await readArray<EvaluationRun>(runsFile())).find((item) => item.id === id);
  if (!run) throw new Error(`评测运行不存在：${id}`);
  return structuredClone(run);
}

/** 创建实验运行。 */
export async function createEvaluationRun(run: EvaluationRun): Promise<EvaluationRun> {
  return withMutation(async () => {
    const runs = await readArray<EvaluationRun>(runsFile());
    if (runs.some((item) => item.id === run.id)) throw new Error(`评测运行已存在：${run.id}`);
    runs.unshift(run);
    await writeArray(runsFile(), runs);
    return structuredClone(run);
  });
}

/** 删除实验运行索引及其专属报告、事件和物化证据。 */
export async function deleteEvaluationRun(id: string): Promise<void> {
  await withMutation(async () => {
    const runs = await readArray<EvaluationRun>(runsFile());
    if (!runs.some((item) => item.id === id)) throw new Error(`评测运行不存在：${id}`);
    await fs.rm(evaluationRunDirectory(id), { recursive: true, force: true });
    await writeArray(runsFile(), runs.filter((item) => item.id !== id));
  });
}

/** 原子更新实验运行。 */
export async function updateEvaluationRun(
  id: string,
  updater: (run: EvaluationRun) => EvaluationRun
): Promise<EvaluationRun> {
  return withMutation(async () => {
    const runs = await readArray<EvaluationRun>(runsFile());
    const index = runs.findIndex((item) => item.id === id);
    if (index < 0) throw new Error(`评测运行不存在：${id}`);
    const updated = updater(runs[index]);
    runs[index] = updated;
    await writeArray(runsFile(), runs);
    return structuredClone(updated);
  });
}

/** 更新单个评测样本，避免服务层重复实现深层数组替换。 */
export async function updateEvaluationCaseRun(
  runId: string,
  caseRunId: string,
  patch: Partial<EvaluationCaseRun>
): Promise<EvaluationRun> {
  return updateEvaluationRun(runId, (run) => ({
    ...run,
    caseRuns: run.caseRuns.map((item) => item.id === caseRunId ? { ...item, ...patch } : item)
  }));
}

/** 追加 JSONL 事件，保留原始执行可观察性且不放大主索引文件。 */
export async function appendEvaluationEvent(
  runId: string,
  caseRunId: string,
  event: Record<string, unknown>
): Promise<void> {
  const directory = evaluationRunDirectory(runId);
  await fs.mkdir(path.join(directory, "events"), { recursive: true });
  await fs.appendFile(
    path.join(directory, "events", `${safePathSegment(caseRunId)}.jsonl`),
    `${JSON.stringify(event)}\n`,
    { encoding: "utf8", mode: 0o600 }
  );
}

/** 读取指定样本最近的执行事件。 */
export async function readEvaluationEvents(
  runId: string,
  caseRunId: string,
  limit = 500
): Promise<Record<string, unknown>[]> {
  try {
    const raw = await fs.readFile(
      path.join(evaluationRunDirectory(runId), "events", `${safePathSegment(caseRunId)}.jsonl`),
      "utf8"
    );
    return raw.split(/\r?\n/)
      .filter(Boolean)
      .slice(-Math.max(1, Math.min(limit, 2_000)))
      .flatMap((line) => {
        try {
          const value = JSON.parse(line) as unknown;
          return value && typeof value === "object" && !Array.isArray(value)
            ? [value as Record<string, unknown>]
            : [];
        } catch {
          return [];
        }
      });
  } catch (error) {
    if (isFileNotFound(error)) return [];
    throw error;
  }
}

export function evaluationRunDirectory(runId: string): string {
  return path.join(runArtifactsDirectory(), safePathSegment(runId));
}

export function evaluationReportFile(runId: string, format: "json" | "html" | "zip"): string {
  return path.join(evaluationRunDirectory(runId), `report.${format}`);
}

function currentEvaluationLabDirectory(): string {
  const overriddenDataDir = process.env.UI_AGENT_DATA_DIR?.trim();
  return overriddenDataDir
    ? path.join(path.resolve(overriddenDataDir), "evaluation-lab")
    : evaluationLabDir;
}

function suitesFile(): string {
  return path.join(currentEvaluationLabDirectory(), "suites.json");
}

function plansFile(): string {
  return path.join(currentEvaluationLabDirectory(), "plans.json");
}

function runsFile(): string {
  return path.join(currentEvaluationLabDirectory(), "runs.json");
}

function runArtifactsDirectory(): string {
  return path.join(currentEvaluationLabDirectory(), "runs");
}

async function ensureJsonArrayFile(filePath: string): Promise<void> {
  try {
    await fs.access(filePath);
  } catch (error) {
    if (!isFileNotFound(error)) throw error;
    await writeArray(filePath, []);
  }
}

async function readArray<T>(filePath: string): Promise<T[]> {
  await ensureEvaluationLabStorage();
  try {
    const parsed = JSON.parse(await fs.readFile(filePath, "utf8")) as unknown;
    if (!Array.isArray(parsed)) throw new Error("根节点必须是数组");
    return parsed as T[];
  } catch (error) {
    throw new Error(`评测实验室存储损坏，已停止写入以保护原数据：${error instanceof Error ? error.message : String(error)}`);
  }
}

async function writeArray(filePath: string, value: unknown[]): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    await fs.writeFile(temporary, JSON.stringify(value, null, 2), { encoding: "utf8", mode: 0o600 });
    await fs.rename(temporary, filePath);
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => undefined);
  }
}

function withMutation<T>(operation: () => Promise<T>): Promise<T> {
  const result = mutationQueue.then(operation, operation);
  mutationQueue = result.then(() => undefined, () => undefined);
  return result;
}

function safePathSegment(value: string): string {
  const result = String(value).replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 180);
  if (!result || result === "." || result === "..") throw new Error("无效的评测运行 ID");
  return result;
}

function isFileNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
