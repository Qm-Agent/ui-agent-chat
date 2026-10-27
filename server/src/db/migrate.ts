import type { Knex } from "knex";
import { TABLES, SCHEMA, ALL_TABLES } from "./schema.js";

/**
 * Create all tables if they do not exist. Idempotent.
 *
 * Initializes the local SQLite schema.
 */
export async function initSchema(k: Knex): Promise<void> {
  await k.transaction(async (trx) => {
    await createSessionsTable(trx);
    await createChatMessagesTable(trx);
    await createSessionArtifactsTable(trx);
    await createInspectionTasksTable(trx);
    await createInspectionRunsTable(trx);
    await createRegressionModulesTable(trx);
    await createRegressionCasesTable(trx);
    await createRegressionBatchesTable(trx);
    await createRegressionRunsTable(trx);
    await createBusinessEnvironmentsTable(trx);
    await createHostEntriesTable(trx);
    await createHostApplyStatusTable(trx);
    await createModelProfilesTable(trx);
    await createModelSettingsTable(trx);
    await createDingtalkRobotsTable(trx);
  });
}

type Builder = Knex.SchemaBuilder;
type Trx = Knex.Transaction;

function pk(trx: Trx, table: Knex.CreateTableBuilder, col: string, len = 64): void {
  table.string(col, len).primary();
}

async function createSessionsTable(trx: Trx): Promise<void> {
  if (await trx.schema.hasTable(TABLES.sessions)) return;
  await trx.schema.createTable(TABLES.sessions, (t) => {
    pk(trx, t, "id");
    t.string("title", 255).notNullable();
    t.string("status", 32).notNullable();
    t.string("sdk_session_id", 255).nullable();
    t.text("workspace_path").notNullable();
    t.text("files_json").notNullable().defaultTo("[]");
    t.text("last_error").nullable();
    t.string("created_at", 40).notNullable();
    t.string("updated_at", 40).notNullable();
    t.string("execution_runtime_id", 32).nullable();
  });
}

async function createChatMessagesTable(trx: Trx): Promise<void> {
  if (await trx.schema.hasTable(TABLES.chatMessages)) return;
  await trx.schema.createTable(TABLES.chatMessages, (t) => {
    pk(trx, t, "id");
    t.string("session_id", 64).notNullable().index();
    t.string("role", 16).notNullable();
    t.text("content").notNullable();
    t.text("files_json").nullable();
    t.text("meta_json").nullable();
    t.string("created_at", 40).notNullable();
    t.integer("seq").notNullable().defaultTo(0);
  });
}

async function createSessionArtifactsTable(trx: Trx): Promise<void> {
  if (await trx.schema.hasTable(TABLES.sessionArtifacts)) return;
  await trx.schema.createTable(TABLES.sessionArtifacts, (t) => {
    // Composite PK: artifact `id` is encodeURIComponent(relativePath) and is
    // only unique within a session, so (session_id, id) is the true key.
    // Artifact ids are percent-encoded relative paths and are scoped to a
    // session. Keep the indexed value bounded while preserving observed ids.
    t.string("id", 191).notNullable();
    t.string("session_id", 64).notNullable().index();
    t.primary(["session_id", "id"]);
    t.string("name", 255).notNullable();
    t.text("relative_path").notNullable();
    t.integer("size").notNullable().defaultTo(0);
    t.string("modified_at", 40).notNullable();
    t.string("kind", 16).notNullable();
    t.boolean("is_core_report").notNullable().defaultTo(false);
  });
}

async function createInspectionTasksTable(trx: Trx): Promise<void> {
  if (await trx.schema.hasTable(TABLES.inspectionTasks)) return;
  await trx.schema.createTable(TABLES.inspectionTasks, (t) => {
    pk(trx, t, "id");
    t.string("name", 255).notNullable();
    t.text("url").notNullable();
    t.string("business_id", 64).nullable();
    t.string("username", 255).nullable();
    t.string("password", 255).nullable();
    t.text("prompt").nullable();
    t.boolean("schedule_enabled").notNullable().defaultTo(false);
    t.string("schedule_mode", 16).nullable();
    t.integer("interval_minutes").nullable();
    t.string("cron_expression", 64).nullable();
    t.string("next_run_at", 40).nullable();
    t.string("status", 16).notNullable();
    t.string("last_run_at", 40).nullable();
    t.string("last_status", 16).nullable();
    t.text("last_error").nullable();
    t.string("created_at", 40).notNullable();
    t.string("updated_at", 40).notNullable();
    t.string("notify_robot_id", 64).nullable();
    t.string("notify_trigger", 16).nullable();
  });
}

async function createInspectionRunsTable(trx: Trx): Promise<void> {
  if (await trx.schema.hasTable(TABLES.inspectionRuns)) return;
  await trx.schema.createTable(TABLES.inspectionRuns, (t) => {
    pk(trx, t, "id");
    t.string("task_id", 64).notNullable().index();
    t.string("session_id", 64).notNullable();
    t.string("trigger", 16).notNullable();
    t.string("status", 16).notNullable();
    t.string("started_at", 40).notNullable();
    t.string("finished_at", 40).nullable();
    t.text("summary").nullable();
    t.text("error").nullable();
    t.integer("artifacts_count").nullable();
    t.text("logs_json").nullable();
    t.integer("seq").notNullable().defaultTo(0);
  });
}

async function createRegressionModulesTable(trx: Trx): Promise<void> {
  if (await trx.schema.hasTable(TABLES.regressionModules)) return;
  await trx.schema.createTable(TABLES.regressionModules, (t) => {
    pk(trx, t, "id");
    t.string("name", 255).notNullable();
    t.text("description").nullable();
    t.string("created_at", 40).notNullable();
    t.string("updated_at", 40).notNullable();
  });
}

async function createRegressionCasesTable(trx: Trx): Promise<void> {
  if (await trx.schema.hasTable(TABLES.regressionCases)) return;
  await trx.schema.createTable(TABLES.regressionCases, (t) => {
    pk(trx, t, "id");
    t.string("module_id", 64).notNullable().index();
    t.string("name", 255).notNullable();
    t.text("description").nullable();
    t.text("prompt").notNullable();
    t.string("business_id", 64).nullable();
    t.string("notify_robot_id", 64).nullable();
    t.string("notify_trigger", 16).nullable();
    t.string("created_at", 40).notNullable();
    t.string("updated_at", 40).notNullable();
  });
}

async function createRegressionBatchesTable(trx: Trx): Promise<void> {
  if (await trx.schema.hasTable(TABLES.regressionBatches)) return;
  await trx.schema.createTable(TABLES.regressionBatches, (t) => {
    pk(trx, t, "id");
    t.string("name", 255).notNullable();
    t.string("status", 16).notNullable();
    t.string("trigger", 16).notNullable();
    t.string("started_at", 40).notNullable();
    t.string("finished_at", 40).nullable();
    t.integer("total").notNullable().defaultTo(0);
    t.integer("completed").notNullable().defaultTo(0);
    t.integer("failed").notNullable().defaultTo(0);
    t.integer("aborted").notNullable().defaultTo(0);
    t.string("created_at", 40).notNullable();
    t.string("updated_at", 40).notNullable();
    t.string("notify_robot_id", 64).nullable();
    t.string("notify_trigger", 16).nullable();
    t.integer("passed").notNullable().defaultTo(0);
    t.integer("assert_failed").notNullable().defaultTo(0);
    t.integer("unknown_count").notNullable().defaultTo(0);
    t.string("notify_status", 16).nullable();
    t.text("notify_message").nullable();
  });
}

async function createRegressionRunsTable(trx: Trx): Promise<void> {
  if (await trx.schema.hasTable(TABLES.regressionRuns)) return;
  await trx.schema.createTable(TABLES.regressionRuns, (t) => {
    pk(trx, t, "id");
    t.string("batch_id", 64).notNullable().index();
    t.string("case_id", 64).notNullable();
    t.string("case_name", 255).notNullable();
    t.string("session_id", 64).notNullable();
    t.string("status", 16).notNullable();
    t.string("started_at", 40).nullable();
    t.string("finished_at", 40).nullable();
    t.text("summary").nullable();
    t.text("error").nullable();
    t.integer("artifacts_count").nullable();
    t.string("test_outcome", 16).nullable();
    t.string("notify_status", 16).nullable();
    t.text("notify_message").nullable();
    t.integer("seq").notNullable().defaultTo(0);
  });
}

async function createBusinessEnvironmentsTable(trx: Trx): Promise<void> {
  if (await trx.schema.hasTable(TABLES.businessEnvironments)) return;
  await trx.schema.createTable(TABLES.businessEnvironments, (t) => {
    pk(trx, t, "id");
    t.string("name", 255).notNullable();
    t.text("url").notNullable();
    t.string("username", 255).nullable();
    t.string("password", 255).nullable();
    t.text("description").nullable();
    t.string("created_at", 40).notNullable();
    t.string("updated_at", 40).notNullable();
  });
}

async function createHostEntriesTable(trx: Trx): Promise<void> {
  if (await trx.schema.hasTable(TABLES.hostEntries)) return;
  await trx.schema.createTable(TABLES.hostEntries, (t) => {
    pk(trx, t, "id");
    t.string("ip", 64).notNullable();
    t.string("hostname", 255).notNullable();
    t.text("comment").nullable();
    t.boolean("enabled").notNullable().defaultTo(true);
    t.string("created_at", 40).notNullable();
    t.string("updated_at", 40).notNullable();
  });
}

async function createHostApplyStatusTable(trx: Trx): Promise<void> {
  if (await trx.schema.hasTable(TABLES.hostApplyStatus)) return;
  await trx.schema.createTable(TABLES.hostApplyStatus, (t) => {
    pk(trx, t, "id", 32);
    t.boolean("applied").notNullable().defaultTo(false);
    t.text("message").nullable();
    t.string("applied_at", 40).nullable();
    t.string("updated_at", 40).notNullable();
  });
}

async function createModelProfilesTable(trx: Trx): Promise<void> {
  if (await trx.schema.hasTable(TABLES.modelProfiles)) return;
  await trx.schema.createTable(TABLES.modelProfiles, (t) => {
    pk(trx, t, "id");
    t.string("runtime_id", 32).notNullable().defaultTo("claude-code");
    t.string("name", 255).notNullable();
    t.text("base_url").notNullable();
    t.text("auth_token").notNullable();
    t.string("model", 255).notNullable();
    t.string("small_fast_model", 255).nullable();
    t.string("sonnet_model", 255).nullable();
    t.string("haiku_model", 255).nullable();
    t.string("opus_model", 255).nullable();
    t.boolean("is_default").notNullable().defaultTo(false);
    t.string("created_at", 40).notNullable();
    t.string("updated_at", 40).notNullable();
  });
}

async function createModelSettingsTable(trx: Trx): Promise<void> {
  if (await trx.schema.hasTable(TABLES.modelSettings)) return;
  await trx.schema.createTable(TABLES.modelSettings, (t) => {
    pk(trx, t, "id", 32);
    t.string("active_id", 64).notNullable();
    t.text("active_profile_ids_json").notNullable().defaultTo("{}");
    t.text("model_overrides_json").notNullable().defaultTo("{}");
    t.string("execution_runtime_id", 32).notNullable().defaultTo("dtcoder");
    t.string("updated_at", 40).notNullable();
  });
}

async function createDingtalkRobotsTable(trx: Trx): Promise<void> {
  if (await trx.schema.hasTable(TABLES.dingtalkRobots)) return;
  await trx.schema.createTable(TABLES.dingtalkRobots, (t) => {
    pk(trx, t, "id");
    t.string("name", 255).notNullable();
    t.text("webhook_url").notNullable();
    t.text("secret").nullable();
    t.text("description").nullable();
    t.text("inspection_template").nullable();
    t.text("regression_template").nullable();
    t.string("created_at", 40).notNullable();
    t.string("updated_at", 40).notNullable();
  });
}

/**
 * Inspect the live schema against the expected SCHEMA map.
 * Inspects the local SQLite schema.
 */
export interface SchemaInspection {
  status: "ok" | "missing_tables" | "missing_columns";
  expectedTableCount: number;
  existingTableCount: number;
  missingTables: string[];
  missingColumns: Record<string, string[]>;
  tables: string[];
}

export async function inspectSchema(k: Knex): Promise<SchemaInspection> {
  const expected = ALL_TABLES;
  const existingRows = await k.raw("SELECT name FROM sqlite_master WHERE type='table'") as Array<{ name: string }>;
  const existingSet = new Set<string>(
    existingRows.map((row) => row.name)
  );
  const missingTables = expected.filter((t) => !existingSet.has(t));
  const checkedTables = expected.filter((t) => existingSet.has(t));

  const missingColumns: Record<string, string[]> = {};
  for (const table of checkedTables) {
    const expectedCols = SCHEMA[table as keyof typeof SCHEMA].map((c) => c.name);
    const colInfo = await k.raw(`PRAGMA table_info("${table}")`) as Array<{ name: string }>;
    const existingCols = new Set(colInfo.map((c) => c.name));
    const missing = expectedCols.filter((c) => !existingCols.has(c));
    if (missing.length) missingColumns[table] = missing;
  }

  const status: SchemaInspection["status"] = missingTables.length
    ? "missing_tables"
    : Object.keys(missingColumns).length
      ? "missing_columns"
      : "ok";

  return {
    status,
    expectedTableCount: expected.length,
    existingTableCount: checkedTables.length,
    missingTables,
    missingColumns,
    tables: checkedTables
  };
}

/** Parse the declared length from a `string(N)` column type, e.g. "string(255)" -> 255. */
function stringLength(def: { type: string }): number | null {
  const m = /^string\((\d+)\)$/.exec(def.type);
  return m ? Number(m[1]) : null;
}

/**
 * Creates missing tables and adds missing columns.
 * Idempotent — safe to call on every startup.
 */
export async function repairSchema(k: Knex): Promise<{
  status: "ok" | "incomplete";
  dialect: string;
  inspection: SchemaInspection;
}> {
  await initSchema(k);
  const before = await inspectSchema(k);
  // Add missing columns to existing tables.
  for (const [table, cols] of Object.entries(before.missingColumns)) {
    await k.schema.alterTable(table, (t) => {
      for (const colName of cols) {
        const def = SCHEMA[table as keyof typeof SCHEMA].find(
          (c) => c.name === colName
        );
        if (!def) continue;
        const len = stringLength(def);
        const ref =
          def.type === "text"
            ? t.text(colName)
            : def.type === "integer"
              ? t.integer(colName)
              : def.type === "boolean"
                ? t.boolean(colName)
                : len !== null
                  ? t.string(colName, len)
                  : t.specificType(colName, def.type);
        if (def.nullable) {
          ref.nullable();
        } else {
          ref.notNullable().defaultTo(def.default ?? defaultValueForMissingColumn(def.type));
        }
      }
    });
  }
  const after = await inspectSchema(k);
  return {
    status: after.status === "ok" ? "ok" : "incomplete",
    dialect: "better-sqlite3",
    inspection: after
  };
}

function defaultValueForMissingColumn(type: string): string | number | boolean {
  if (type === "integer") return 0;
  if (type === "boolean") return false;
  return "";
}

/**
 * Check whether the database is empty (no domain rows). Used to decide whether
 * to run the legacy JSON migration.
 */
export async function isDatabaseEmpty(k: Knex): Promise<boolean> {
  const count = await k(TABLES.sessions).count("* as c").first();
  const c = (count as { c?: number | string })?.c;
  return Number(c ?? 0) === 0;
}
