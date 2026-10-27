import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import type { Knex } from "knex";
import { getDatabase } from "./index.js";
import { isDatabaseEmpty } from "./migrate.js";
import { TABLES } from "./schema.js";
import {
  sessionsDir,
  inspectionsDir,
  configDir,
  regressionsDir,
  dbMigratedMarker
} from "../paths.js";
import type {
  AgentSession,
  BusinessEnvironment,
  HostApplyStatus,
  HostEntry,
  InspectionTask,
  ModelProfile,
  RegressionBatch,
  RegressionCase,
  RegressionModule
} from "../types.js";

interface LegacyModelsStore {
  customProfiles?: ModelProfile[];
  activeId?: string;
}

/**
 * Migrate legacy JSON files under data/ into the database.
 *
 * Runs only when the database is empty AND the migration marker file is absent.
 * After a successful migration the marker `data/.db-migrated` is written so
 * subsequent startups skip the pass (idempotent).
 */
export async function migrateLegacyData(): Promise<void> {
  const { knex } = await getDatabase();
  if (await fileExists(dbMigratedMarker)) {
    return;
  }
  const empty = await isDatabaseEmpty(knex);
  if (!empty) {
    // Database already has data (e.g. created by the app) — mark migrated.
    await fs.writeFile(dbMigratedMarker, new Date().toISOString(), "utf8");
    return;
  }
  console.log("[db] starting legacy JSON migration …");
  const stats = await knex.transaction(async (trx) => {
    const s = {
      sessions: 0,
      messages: 0,
      artifacts: 0,
      inspectionTasks: 0,
      inspectionRuns: 0,
      regressionModules: 0,
      regressionCases: 0,
      regressionBatches: 0,
      regressionRuns: 0,
      businessEnvs: 0,
      hostEntries: 0,
      modelProfiles: 0
    };
    await migrateSessions(trx, s);
    await migrateInspections(trx, s);
    await migrateRegressions(trx, s);
    await migrateConfig(trx, s);
    await migrateModels(trx, s);
    return s;
  });
  await fs.writeFile(dbMigratedMarker, new Date().toISOString(), "utf8");
  console.log("[db] legacy migration complete:", stats);
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function readJsonOrNull<T>(p: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(p, "utf8")) as T;
  } catch {
    return null;
  }
}

/* ─── Sessions ─── */

async function migrateSessions(
  trx: Knex.Transaction,
  stats: { sessions: number; messages: number; artifacts: number }
): Promise<void> {
  let entries: fsSync.Dirent[];
  try {
    entries = await fs.readdir(sessionsDir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const file = path.join(sessionsDir, entry.name, "session.json");
    const session = await readJsonOrNull<AgentSession>(file);
    if (!session) continue;
    await trx(TABLES.sessions).insert({
      id: session.id,
      title: session.title,
      status: session.status,
      sdk_session_id: session.sdkSessionId ?? null,
      workspace_path: session.workspacePath,
      files_json: JSON.stringify(session.files ?? []),
      last_error: session.lastError ?? null,
      created_at: session.createdAt,
      updated_at: session.updatedAt,
      execution_runtime_id: session.executionRuntimeId ?? null
    });
    let seq = 0;
    for (const msg of session.messages ?? []) {
      await trx(TABLES.chatMessages).insert({
        id: msg.id,
        session_id: session.id,
        role: msg.role,
        content: msg.content,
        files_json: msg.files ? JSON.stringify(msg.files) : null,
        meta_json: msg.meta ? JSON.stringify(msg.meta) : null,
        created_at: msg.createdAt,
        seq: seq++
      });
      stats.messages++;
    }
    for (const art of session.artifacts ?? []) {
      await trx(TABLES.sessionArtifacts).insert({
        id: art.id,
        session_id: session.id,
        name: art.name,
        relative_path: art.relativePath,
        size: art.size,
        modified_at: art.modifiedAt,
        kind: art.kind,
        is_core_report: art.isCoreReport ? 1 : 0
      });
      stats.artifacts++;
    }
    stats.sessions++;
  }
}

/* ─── Inspections ─── */

async function migrateInspections(
  trx: Knex.Transaction,
  stats: { inspectionTasks: number; inspectionRuns: number }
): Promise<void> {
  let entries: fsSync.Dirent[];
  try {
    entries = await fs.readdir(inspectionsDir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const file = path.join(inspectionsDir, entry.name, "task.json");
    const task = await readJsonOrNull<InspectionTask>(file);
    if (!task) continue;
    await trx(TABLES.inspectionTasks).insert({
      id: task.id,
      name: task.name,
      url: task.url,
      business_id: task.businessId ?? null,
      username: task.username ?? null,
      password: task.password ?? null,
      prompt: task.prompt ?? null,
      schedule_enabled: task.scheduleEnabled ? 1 : 0,
      schedule_mode: task.scheduleMode ?? null,
      interval_minutes: task.intervalMinutes ?? null,
      cron_expression: task.cronExpression ?? null,
      next_run_at: task.nextRunAt ?? null,
      status: task.status,
      last_run_at: task.lastRunAt ?? null,
      last_status: task.lastStatus ?? null,
      last_error: task.lastError ?? null,
      created_at: task.createdAt,
      updated_at: task.updatedAt
    });
    let seq = 0;
    for (const run of task.runs ?? []) {
      await trx(TABLES.inspectionRuns).insert({
        id: run.id,
        task_id: task.id,
        session_id: run.sessionId,
        trigger: run.trigger,
        status: run.status,
        started_at: run.startedAt,
        finished_at: run.finishedAt ?? null,
        summary: run.summary ?? null,
        error: run.error ?? null,
        artifacts_count: run.artifactsCount ?? null,
        logs_json: run.logs ? JSON.stringify(run.logs) : null,
        seq: seq++
      });
      stats.inspectionRuns++;
    }
    stats.inspectionTasks++;
  }
}

/* ─── Regressions ─── */

async function migrateRegressions(
  trx: Knex.Transaction,
  stats: {
    regressionModules: number;
    regressionCases: number;
    regressionBatches: number;
    regressionRuns: number;
  }
): Promise<void> {
  const modules = await readJsonOrNull<RegressionModule[]>(
    path.join(regressionsDir, "modules.json")
  );
  if (modules) {
    for (const m of modules) {
      await trx(TABLES.regressionModules).insert({
        id: m.id,
        name: m.name,
        description: m.description ?? null,
        created_at: m.createdAt,
        updated_at: m.updatedAt
      });
      stats.regressionModules++;
    }
  }
  const cases = await readJsonOrNull<RegressionCase[]>(
    path.join(regressionsDir, "cases.json")
  );
  if (cases) {
    for (const c of cases) {
      await trx(TABLES.regressionCases).insert({
        id: c.id,
        module_id: c.moduleId,
        name: c.name,
        description: c.description ?? null,
        prompt: c.prompt,
        business_id: c.businessId ?? null,
        created_at: c.createdAt,
        updated_at: c.updatedAt
      });
      stats.regressionCases++;
    }
  }
  // Batches: one JSON per directory.
  const batchesDir = path.join(regressionsDir, "batches");
  let batchEntries: fsSync.Dirent[];
  try {
    batchEntries = await fs.readdir(batchesDir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of batchEntries) {
    if (!entry.isDirectory()) continue;
    const file = path.join(batchesDir, entry.name, "batch.json");
    const batch = await readJsonOrNull<RegressionBatch>(file);
    if (!batch) continue;
    await trx(TABLES.regressionBatches).insert({
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
      updated_at: batch.updatedAt
    });
    let seq = 0;
    for (const run of batch.runs ?? []) {
      await trx(TABLES.regressionRuns).insert({
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
        seq: seq++
      });
      stats.regressionRuns++;
    }
    stats.regressionBatches++;
  }
}

/* ─── Config (business environments + hosts) ─── */

async function migrateConfig(
  trx: Knex.Transaction,
  stats: { businessEnvs: number; hostEntries: number }
): Promise<void> {
  const envs = await readJsonOrNull<BusinessEnvironment[]>(
    path.join(configDir, "business-environments.json")
  );
  if (envs) {
    for (const e of envs) {
      await trx(TABLES.businessEnvironments).insert({
        id: e.id,
        name: e.name,
        url: e.url,
        username: e.username ?? null,
        password: e.password ?? null,
        description: e.description ?? null,
        created_at: e.createdAt,
        updated_at: e.updatedAt
      });
      stats.businessEnvs++;
    }
  }
  const hosts = await readJsonOrNull<HostEntry[]>(
    path.join(configDir, "host-entries.json")
  );
  if (hosts) {
    for (const h of hosts) {
      await trx(TABLES.hostEntries).insert({
        id: h.id,
        ip: h.ip,
        hostname: h.hostname,
        comment: h.comment ?? null,
        enabled: h.enabled ? 1 : 0,
        created_at: h.createdAt,
        updated_at: h.updatedAt
      });
      stats.hostEntries++;
    }
  }
  const status = await readJsonOrNull<HostApplyStatus>(
    path.join(configDir, "host-apply-status.json")
  );
  if (status) {
    await trx(TABLES.hostApplyStatus).insert({
      id: "singleton",
      applied: status.applied ? 1 : 0,
      message: status.message ?? null,
      applied_at: status.appliedAt ?? null,
      updated_at: new Date().toISOString()
    });
  }
}

/* ─── Models ─── */

async function migrateModels(
  trx: Knex.Transaction,
  stats: { modelProfiles: number }
): Promise<void> {
  const store = await readJsonOrNull<LegacyModelsStore>(
    path.join(configDir, "models.json")
  );
  if (!store) return;
  const profiles = Array.isArray(store.customProfiles) ? store.customProfiles : [];
  for (const p of profiles) {
    await trx(TABLES.modelProfiles).insert({
      id: p.id,
      runtime_id: "claude-code",
      name: p.name,
      base_url: p.baseUrl,
      auth_token: p.authToken,
      model: p.model,
      small_fast_model: p.smallFastModel ?? null,
      sonnet_model: p.sonnetModel ?? null,
      haiku_model: p.haikuModel ?? null,
      opus_model: p.opusModel ?? null,
      is_default: p.isDefault ? 1 : 0,
      created_at: p.createdAt,
      updated_at: p.updatedAt
    });
    stats.modelProfiles++;
  }
  const activeId = store.activeId || "default-minimax-m25";
  await trx(TABLES.modelSettings).insert({
    id: "singleton",
    active_id: activeId,
    active_profile_ids_json: JSON.stringify({ cfuse: activeId }),
    model_overrides_json: "{}",
    execution_runtime_id: "cfuse",
    updated_at: new Date().toISOString()
  });
}
