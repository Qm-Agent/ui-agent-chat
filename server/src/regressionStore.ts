import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { regressionsDir } from "./paths.js";
import { getDatabase } from "./db/index.js";
import { TABLES } from "./db/schema.js";
import type {
  RegressionBatch,
  RegressionCase,
  RegressionModule,
  RegressionRun,
  RegressionRunStatus,
  InspectionNotifyTrigger,
  NotifyStatus,
  PublicRegressionCase,
  TestOutcome
} from "./types.js";

const MODULES_FILE = path.join(regressionsDir, "modules.json");
const CASES_FILE = path.join(regressionsDir, "cases.json");
const BATCHES_DIR = path.join(regressionsDir, "batches");

export async function ensureRegressionStorage(): Promise<void> {
  await fs.mkdir(regressionsDir, { recursive: true });
  await fs.mkdir(BATCHES_DIR, { recursive: true });
}

interface ModuleRow {
  id: string;
  name: string;
  description: string | null;
  created_at: string;
  updated_at: string;
}

interface CaseRow {
  id: string;
  module_id: string;
  name: string;
  description: string | null;
  prompt: string;
  business_id: string | null;
  notify_robot_id: string | null;
  notify_trigger: string | null;
  created_at: string;
  updated_at: string;
}

interface BatchRow {
  id: string;
  name: string;
  status: string;
  trigger: string;
  started_at: string;
  finished_at: string | null;
  total: number;
  completed: number;
  failed: number;
  aborted: number;
  created_at: string;
  updated_at: string;
  notify_robot_id: string | null;
  notify_trigger: string | null;
  passed: number;
  assert_failed: number;
  unknown_count: number;
  notify_status: string | null;
  notify_message: string | null;
}

interface RunRow {
  id: string;
  batch_id: string;
  case_id: string;
  case_name: string;
  session_id: string;
  status: string;
  started_at: string | null;
  finished_at: string | null;
  summary: string | null;
  error: string | null;
  artifacts_count: number | null;
  test_outcome: string | null;
  notify_status: string | null;
  notify_message: string | null;
  seq: number;
}

function moduleRowToModule(row: ModuleRow): RegressionModule {
  return {
    id: row.id,
    name: row.name,
    description: row.description ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function caseRowToCase(row: CaseRow): RegressionCase {
  return {
    id: row.id,
    moduleId: row.module_id,
    name: row.name,
    description: row.description ?? undefined,
    prompt: row.prompt,
    businessId: row.business_id ?? undefined,
    notifyRobotId: row.notify_robot_id ?? undefined,
    notifyTrigger: (row.notify_trigger as InspectionNotifyTrigger | null) ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function runRowToRun(row: RunRow): RegressionRun {
  return {
    id: row.id,
    batchId: row.batch_id,
    caseId: row.case_id,
    caseName: row.case_name,
    sessionId: row.session_id,
    status: row.status as RegressionRunStatus,
    startedAt: row.started_at ?? undefined,
    finishedAt: row.finished_at ?? undefined,
    summary: row.summary ?? undefined,
    error: row.error ?? undefined,
    artifactsCount: row.artifacts_count ?? undefined,
    testOutcome: (row.test_outcome as TestOutcome | null) ?? undefined,
    notifyStatus: (row.notify_status as NotifyStatus | null) ?? undefined,
    notifyMessage: row.notify_message ?? undefined
  };
}

function batchRowToBatch(row: BatchRow, runs: RegressionRun[]): RegressionBatch {
  const passed = runs.filter((r) => r.testOutcome === "pass").length;
  const assertFailed = runs.filter((r) => r.testOutcome === "fail").length;
  const unknown = runs.filter((r) => (r.testOutcome ?? "unknown") === "unknown").length;
  return {
    id: row.id,
    name: row.name,
    status: row.status as RegressionBatch["status"],
    trigger: row.trigger as "manual",
    startedAt: row.started_at,
    finishedAt: row.finished_at ?? undefined,
    total: row.total,
    completed: row.completed,
    failed: row.failed,
    aborted: row.aborted,
    passed,
    assertFailed,
    unknown,
    runs,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    notifyRobotId: row.notify_robot_id ?? undefined,
    notifyTrigger: (row.notify_trigger as InspectionNotifyTrigger | null) ?? undefined,
    notifyStatus: (row.notify_status as NotifyStatus | null) ?? undefined,
    notifyMessage: row.notify_message ?? undefined
  };
}

async function loadRunsForBatch(k: import("knex").Knex, batchId: string): Promise<RegressionRun[]> {
  const rows = await k<RunRow>(TABLES.regressionRuns)
    .where({ batch_id: batchId })
    .orderBy("seq", "asc");
  return rows.map(runRowToRun);
}

/**
 * 批量加载多个批次的 runs，避免 listRegressionBatches 的 N+1 查询：
 * 用一次 whereIn 查询取回所有 runs，再按 batch_id 分组。
 * 返回 Map<batchId, RegressionRun[]>，每个批次内部仍按 seq 升序。
 */
async function loadRunsForBatches(
  k: import("knex").Knex,
  batchIds: string[]
): Promise<Map<string, RegressionRun[]>> {
  const grouped = new Map<string, RegressionRun[]>();
  if (batchIds.length === 0) {
    return grouped;
  }
  const rows = await k<RunRow>(TABLES.regressionRuns)
    .whereIn("batch_id", batchIds)
    .orderBy("seq", "asc");
  for (const row of rows) {
    const list = grouped.get(row.batch_id);
    if (list) {
      list.push(runRowToRun(row));
    } else {
      grouped.set(row.batch_id, [runRowToRun(row)]);
    }
  }
  return grouped;
}

/** 批次列表默认返回条数上限，避免无分页全量扫描 + 序列化。可用环境变量覆盖。 */
const DEFAULT_BATCH_LIST_LIMIT = (() => {
  const raw = Number(process.env.UI_AGENT_REGRESSION_BATCH_LIST_LIMIT);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 200;
})();

/* ─── Modules ─── */

export async function listRegressionModules(): Promise<RegressionModule[]> {
  await ensureRegressionStorage();
  const { knex } = await getDatabase();
  const rows = await knex<ModuleRow>(TABLES.regressionModules)
    .select("*")
    .orderBy("updated_at", "desc");
  return rows.map(moduleRowToModule);
}

export async function upsertRegressionModule(input: {
  id?: string;
  name?: string;
  description?: string;
}): Promise<RegressionModule> {
  await ensureRegressionStorage();
  const { knex } = await getDatabase();
  const now = new Date().toISOString();
  const existing = input.id
    ? await knex<ModuleRow>(TABLES.regressionModules).where({ id: input.id }).first()
    : undefined;
  const name = normalizeText(input.name ?? existing?.name) ?? "未命名模块";
  const module: RegressionModule = {
    id: existing?.id ?? randomUUID(),
    name,
    description: normalizeText(input.description ?? existing?.description ?? undefined),
    createdAt: existing?.created_at ?? now,
    updatedAt: now
  };
  await knex<ModuleRow>(TABLES.regressionModules)
    .insert({
      id: module.id,
      name: module.name,
      description: module.description ?? null,
      created_at: module.createdAt,
      updated_at: module.updatedAt
    })
    .onConflict("id")
    .merge({
      name: module.name,
      description: module.description ?? null,
      updated_at: module.updatedAt
    });
  return module;
}

export async function deleteRegressionModule(id: string): Promise<void> {
  const { knex } = await getDatabase();
  await knex.transaction(async (trx) => {
    await trx<CaseRow>(TABLES.regressionCases).where({ module_id: id }).del();
    await trx<ModuleRow>(TABLES.regressionModules).where({ id }).del();
  });
}

/* ─── Cases ─── */

export async function listRegressionCases(moduleId?: string): Promise<PublicRegressionCase[]> {
  await ensureRegressionStorage();
  const { knex } = await getDatabase();
  let query = knex<CaseRow>(TABLES.regressionCases).select("*");
  if (moduleId) {
    query = query.where({ module_id: moduleId });
  }
  const rows = await query.orderBy("updated_at", "desc");
  return rows.map(caseRowToCase);
}

export async function upsertRegressionCase(input: {
  id?: string;
  moduleId?: string;
  name?: string;
  description?: string;
  prompt?: string;
  businessId?: string;
  notifyRobotId?: string;
  notifyTrigger?: InspectionNotifyTrigger;
}): Promise<PublicRegressionCase> {
  await ensureRegressionStorage();
  const { knex } = await getDatabase();
  const now = new Date().toISOString();
  const existing = input.id
    ? await knex<CaseRow>(TABLES.regressionCases).where({ id: input.id }).first()
    : undefined;
  const moduleId = normalizeText(input.moduleId ?? existing?.module_id);
  if (!moduleId) {
    throw new Error("请选择所属模块");
  }
  const name = normalizeText(input.name ?? existing?.name) ?? "未命名用例";
  const prompt = normalizeText(input.prompt ?? existing?.prompt ?? undefined);
  if (!prompt) {
    throw new Error("请填写执行 Prompt");
  }
  const notifyRobotId = normalizeText(input.notifyRobotId ?? existing?.notify_robot_id ?? undefined);
  const notifyTrigger =
    input.notifyTrigger ??
    ((existing?.notify_trigger as InspectionNotifyTrigger | null) ?? undefined);
  const caseRecord: RegressionCase = {
    id: existing?.id ?? randomUUID(),
    moduleId,
    name,
    description: normalizeText(input.description ?? existing?.description ?? undefined),
    prompt,
    businessId: normalizeText(input.businessId ?? existing?.business_id ?? undefined),
    notifyRobotId,
    notifyTrigger: normalizeNotifyTrigger(notifyTrigger),
    createdAt: existing?.created_at ?? now,
    updatedAt: now
  };
  await knex<CaseRow>(TABLES.regressionCases)
    .insert({
      id: caseRecord.id,
      module_id: caseRecord.moduleId,
      name: caseRecord.name,
      description: caseRecord.description ?? null,
      prompt: caseRecord.prompt,
      business_id: caseRecord.businessId ?? null,
      notify_robot_id: caseRecord.notifyRobotId ?? null,
      notify_trigger: caseRecord.notifyTrigger ?? null,
      created_at: caseRecord.createdAt,
      updated_at: caseRecord.updatedAt
    })
    .onConflict("id")
    .merge({
      module_id: caseRecord.moduleId,
      name: caseRecord.name,
      description: caseRecord.description ?? null,
      prompt: caseRecord.prompt,
      business_id: caseRecord.businessId ?? null,
      notify_robot_id: caseRecord.notifyRobotId ?? null,
      notify_trigger: caseRecord.notifyTrigger ?? null,
      updated_at: caseRecord.updatedAt
    });
  return caseRecord;
}

export async function deleteRegressionCase(id: string): Promise<void> {
  const { knex } = await getDatabase();
  await knex<CaseRow>(TABLES.regressionCases).where({ id }).del();
}

export async function getRegressionCases(ids: string[]): Promise<RegressionCase[]> {
  if (!ids.length) return [];
  const { knex } = await getDatabase();
  const rows = await knex<CaseRow>(TABLES.regressionCases).whereIn("id", ids);
  const byId = new Map(rows.map((r) => [r.id, caseRowToCase(r)]));
  return ids.map((id) => byId.get(id)).filter((c): c is RegressionCase => Boolean(c));
}

/* ─── Batches ─── */

export async function listRegressionBatches(): Promise<RegressionBatch[]> {
  await ensureRegressionStorage();
  const { knex } = await getDatabase();
  const rows = await knex<BatchRow>(TABLES.regressionBatches)
    .select("*")
    .orderBy("created_at", "desc")
    .limit(DEFAULT_BATCH_LIST_LIMIT);
  // 一次性批量取回这些批次的所有 runs，避免逐批次查询造成 N+1。
  const runsByBatch = await loadRunsForBatches(
    knex,
    rows.map((row) => row.id)
  );
  return rows.map((row) => batchRowToBatch(row, runsByBatch.get(row.id) ?? []));
}

export async function loadRegressionBatch(id: string): Promise<RegressionBatch> {
  const { knex } = await getDatabase();
  const row = await knex<BatchRow>(TABLES.regressionBatches).where({ id }).first();
  if (!row) {
    throw new Error(`Regression batch not found: ${id}`);
  }
  const runs = await loadRunsForBatch(knex, id);
  return batchRowToBatch(row, runs);
}

export async function saveRegressionBatch(batch: RegressionBatch): Promise<void> {
  const { knex } = await getDatabase();
  const now = new Date().toISOString();
  batch.updatedAt = now;
  await knex.transaction(async (trx) => {
    await trx<BatchRow>(TABLES.regressionBatches)
      .insert({
        id: batch.id,
        name: batch.name,
        status: batch.status,
        trigger: batch.trigger,
        started_at: batch.startedAt,
        finished_at: batch.finishedAt ?? null,
        total: batch.total,
        completed: batch.completed,
        failed: batch.failed,
        aborted: batch.aborted,
        created_at: batch.createdAt,
        updated_at: batch.updatedAt,
        notify_robot_id: batch.notifyRobotId ?? null,
        notify_trigger: batch.notifyTrigger ?? null,
        passed: batch.passed ?? 0,
        assert_failed: batch.assertFailed ?? 0,
        unknown_count: batch.unknown ?? 0,
        notify_status: batch.notifyStatus ?? null,
        notify_message: batch.notifyMessage ?? null
      })
      .onConflict("id")
      .merge({
        name: batch.name,
        status: batch.status,
        finished_at: batch.finishedAt ?? null,
        total: batch.total,
        completed: batch.completed,
        failed: batch.failed,
        aborted: batch.aborted,
        updated_at: batch.updatedAt,
        notify_robot_id: batch.notifyRobotId ?? null,
        notify_trigger: batch.notifyTrigger ?? null,
        passed: batch.passed ?? 0,
        assert_failed: batch.assertFailed ?? 0,
        unknown_count: batch.unknown ?? 0,
        notify_status: batch.notifyStatus ?? null,
        notify_message: batch.notifyMessage ?? null
      });
    // Upsert all runs in the snapshot (used by legacy callers + migration).
    for (const run of batch.runs) {
      await trx<RunRow>(TABLES.regressionRuns)
        .insert({
          id: run.id,
          batch_id: batch.id,
          case_id: run.caseId,
          case_name: run.caseName,
          session_id: run.sessionId,
          status: run.status,
          started_at: run.startedAt ?? null,
          finished_at: run.finishedAt ?? null,
          summary: run.summary ?? null,
          error: run.error ?? null,
          artifacts_count: run.artifactsCount ?? null,
          test_outcome: run.testOutcome ?? null,
          notify_status: run.notifyStatus ?? null,
          notify_message: run.notifyMessage ?? null,
          seq: 0
        })
        .onConflict("id")
        .merge();
    }
  });
}

export async function createRegressionBatch(
  name: string,
  cases: RegressionCase[],
  options?: { notifyRobotId?: string; notifyTrigger?: InspectionNotifyTrigger }
): Promise<RegressionBatch> {
  await ensureRegressionStorage();
  const now = new Date().toISOString();
  const notifyRobotId = normalizeText(options?.notifyRobotId);
  const notifyTrigger = options?.notifyTrigger;
  const runs: RegressionRun[] = cases.map((c) => ({
    id: randomUUID(),
    batchId: "",
    caseId: c.id,
    caseName: c.name,
    sessionId: "",
    status: "pending"
  }));
  const batch: RegressionBatch = {
    id: randomUUID(),
    name: name || `回归批次 ${now.slice(0, 16).replace("T", " ")}`,
    status: "running",
    trigger: "manual",
    startedAt: now,
    total: cases.length,
    completed: 0,
    failed: 0,
    aborted: 0,
    runs: runs.map((r) => ({ ...r, batchId: "" })),
    createdAt: now,
    updatedAt: now,
    notifyRobotId,
    notifyTrigger
  };
  for (const run of batch.runs) {
    run.batchId = batch.id;
  }
  const { knex } = await getDatabase();
  await knex.transaction(async (trx) => {
    await trx<BatchRow>(TABLES.regressionBatches).insert({
      id: batch.id,
      name: batch.name,
      status: batch.status,
      trigger: batch.trigger,
      started_at: batch.startedAt,
      finished_at: null,
      total: batch.total,
      completed: 0,
      failed: 0,
      aborted: 0,
      created_at: batch.createdAt,
      updated_at: batch.updatedAt,
      notify_robot_id: batch.notifyRobotId ?? null,
      notify_trigger: batch.notifyTrigger ?? null,
      passed: 0,
      assert_failed: 0,
      unknown_count: 0,
      notify_status: null,
      notify_message: null
    });
    let seq = 0;
    for (const run of batch.runs) {
      await trx<RunRow>(TABLES.regressionRuns).insert({
        id: run.id,
        batch_id: batch.id,
        case_id: run.caseId,
        case_name: run.caseName,
        session_id: run.sessionId,
        status: run.status,
        started_at: run.startedAt ?? null,
        finished_at: run.finishedAt ?? null,
        summary: run.summary ?? null,
        error: run.error ?? null,
        artifacts_count: run.artifactsCount ?? null,
        test_outcome: run.testOutcome ?? null,
        notify_status: run.notifyStatus ?? null,
        notify_message: run.notifyMessage ?? null,
        seq: seq++
      });
    }
  });
  return batch;
}

export async function updateRegressionRun(
  batchId: string,
  runId: string,
  patch: Partial<RegressionRun>
): Promise<RegressionBatch> {
  const { knex } = await getDatabase();
  await knex.transaction(async (trx) => {
    const update: Partial<RunRow> = {};
    if (patch.status !== undefined) update.status = patch.status;
    if (patch.startedAt !== undefined) update.started_at = patch.startedAt ?? null;
    if (patch.finishedAt !== undefined) update.finished_at = patch.finishedAt ?? null;
    if (patch.summary !== undefined) update.summary = patch.summary ?? null;
    if (patch.error !== undefined) update.error = patch.error ?? null;
    if (patch.artifactsCount !== undefined) update.artifacts_count = patch.artifactsCount ?? null;
    if (patch.sessionId !== undefined) update.session_id = patch.sessionId;
    if (patch.caseName !== undefined) update.case_name = patch.caseName;
    if (patch.testOutcome !== undefined) update.test_outcome = patch.testOutcome ?? null;
    if (patch.notifyStatus !== undefined) update.notify_status = patch.notifyStatus ?? null;
    if (patch.notifyMessage !== undefined) update.notify_message = patch.notifyMessage ?? null;
    if (Object.keys(update).length) {
      await trx<RunRow>(TABLES.regressionRuns).where({ id: runId }).update(update);
    }
    // Recompute batch counts (trigger-style).
    const runs = await trx<RunRow>(TABLES.regressionRuns).where({ batch_id: batchId });
    const completed = runs.filter((r) => r.status === "completed").length;
    const failed = runs.filter((r) => r.status === "failed").length;
    const aborted = runs.filter((r) => r.status === "aborted").length;
    const allDone = runs.every(
      (r) => r.status === "completed" || r.status === "failed" || r.status === "aborted"
    );
    const passed = runs.filter((r) => r.test_outcome === "pass").length;
    const assertFailed = runs.filter((r) => r.test_outcome === "fail").length;
    const unknownCount = runs.filter(
      (r) => (r.test_outcome ?? "unknown") === "unknown"
    ).length;
    const batchUpdate: Partial<BatchRow> = {
      completed,
      failed,
      aborted,
      passed,
      assert_failed: assertFailed,
      unknown_count: unknownCount,
      updated_at: new Date().toISOString()
    };
    if (allDone) {
      batchUpdate.status = "completed";
      batchUpdate.finished_at = new Date().toISOString();
    }
    await trx<BatchRow>(TABLES.regressionBatches).where({ id: batchId }).update(batchUpdate);
  });
  return loadRegressionBatch(batchId);
}

export async function abortRegressionBatch(batchId: string): Promise<RegressionBatch> {
  const { knex } = await getDatabase();
  const now = new Date().toISOString();
  await knex.transaction(async (trx) => {
    const runs = await trx<RunRow>(TABLES.regressionRuns).where({ batch_id: batchId });
    for (const run of runs) {
      if (run.status === "pending" || run.status === "running") {
        await trx<RunRow>(TABLES.regressionRuns).where({ id: run.id }).update({
          status: "aborted",
          finished_at: run.finished_at ?? now
        });
      }
    }
    const updatedRuns = await trx<RunRow>(TABLES.regressionRuns).where({ batch_id: batchId });
    const aborted = updatedRuns.filter((r) => r.status === "aborted").length;
    await trx<BatchRow>(TABLES.regressionBatches).where({ id: batchId }).update({
      status: "aborted",
      finished_at: now,
      aborted,
      updated_at: now
    });
  });
  return loadRegressionBatch(batchId);
}

export async function deleteRegressionBatch(batchId: string): Promise<void> {
  const { knex } = await getDatabase();
  await knex.transaction(async (trx) => {
    await trx<RunRow>(TABLES.regressionRuns).where({ batch_id: batchId }).del();
    await trx<BatchRow>(TABLES.regressionBatches).where({ id: batchId }).del();
  });
  await fs.rm(path.join(BATCHES_DIR, batchId), { recursive: true, force: true }).catch(() => undefined);
}

export function buildRegressionPrompt(c: RegressionCase): string {
  const lines = [`你是一个 UI 自动化测试执行智能体。请按以下回归用例描述执行测试，并在结束时输出通过/失败结论、主要风险点和产物路径。`, ``];
  lines.push(`用例名称：${c.name}`);
  if (c.description) {
    lines.push(`用例描述：${c.description}`);
  }
  lines.push(``, `执行 Prompt：`, c.prompt);
  lines.push(
    ``,
    `执行要求：`,
    `- 优先使用 ui-test-assistant-skill 完成测试。`,
    `- 如测试失败，请保留截图、日志和错误说明。`,
    `- 结束时明确输出 PASS / FAIL 结论。`
  );
  return lines.join("\n");
}

/* ─── helpers ─── */

function normalizeText(value?: string): string | undefined {
  const text = value?.trim();
  return text ? text : undefined;
}

function normalizeNotifyTrigger(value?: string): InspectionNotifyTrigger | undefined {
  if (value === "always" || value === "failed" || value === "never") {
    return value;
  }
  return undefined;
}

// Exported for migration use only.
export const LEGACY_FILES = { MODULES_FILE, CASES_FILE, BATCHES_DIR };
