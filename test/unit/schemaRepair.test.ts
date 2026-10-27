import assert from "node:assert/strict";
import test from "node:test";
import knex from "knex";
import { repairSchema } from "../../server/src/db/migrate.js";
import { TABLES } from "../../server/src/db/schema.js";

test("SQLite 旧表补非空质量统计列时保留旧数据并填充默认值", async () => {
  const database = knex({ client: "better-sqlite3", connection: { filename: ":memory:" }, useNullAsDefault: true });
  try {
    await database.schema.createTable(TABLES.regressionBatches, (table) => {
      table.string("id", 64).primary();
      table.string("name", 255).notNullable();
      table.string("status", 16).notNullable();
      table.string("trigger", 16).notNullable();
      table.string("started_at", 40).notNullable();
      table.string("finished_at", 40).nullable();
      table.integer("total").notNullable().defaultTo(0);
      table.integer("completed").notNullable().defaultTo(0);
      table.integer("failed").notNullable().defaultTo(0);
      table.integer("aborted").notNullable().defaultTo(0);
      table.string("created_at", 40).notNullable();
      table.string("updated_at", 40).notNullable();
      table.string("notify_robot_id", 64).nullable();
      table.string("notify_trigger", 16).nullable();
    });
    await database(TABLES.regressionBatches).insert({
      id: "legacy-batch",
      name: "旧回归批次",
      status: "completed",
      trigger: "manual",
      started_at: "2026-07-11T00:00:00.000Z",
      total: 1,
      completed: 1,
      failed: 0,
      aborted: 0,
      created_at: "2026-07-11T00:00:00.000Z",
      updated_at: "2026-07-11T00:01:00.000Z"
    });

    const report = await repairSchema(database);
    const row = await database(TABLES.regressionBatches).where({ id: "legacy-batch" }).first();

    assert.equal(report.status, "ok");
    assert.equal(row.name, "旧回归批次");
    assert.equal(row.passed, 0);
    assert.equal(row.assert_failed, 0);
    assert.equal(row.unknown_count, 0);
  } finally {
    await database.destroy();
  }
});

test("SQLite 旧模型表补执行底座列时使用兼容默认值", async () => {
  const database = knex({ client: "better-sqlite3", connection: { filename: ":memory:" }, useNullAsDefault: true });
  try {
    await database.schema.createTable(TABLES.modelProfiles, (table) => {
      table.string("id", 64).primary();
      table.string("name", 255).notNullable();
      table.text("base_url").notNullable();
      table.text("auth_token").notNullable();
      table.string("model", 255).notNullable();
      table.string("small_fast_model", 255).nullable();
      table.string("sonnet_model", 255).nullable();
      table.string("haiku_model", 255).nullable();
      table.string("opus_model", 255).nullable();
      table.boolean("is_default").notNullable().defaultTo(false);
      table.string("created_at", 40).notNullable();
      table.string("updated_at", 40).notNullable();
    });
    await database(TABLES.modelProfiles).insert({
      id: "legacy-model",
      name: "旧 Claude 模型",
      base_url: "https://example.test/anthropic",
      auth_token: "token",
      model: "legacy",
      is_default: 0,
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z"
    });

    const report = await repairSchema(database);
    const row = await database(TABLES.modelProfiles).where({ id: "legacy-model" }).first();
    assert.equal(report.status, "ok");
    assert.equal(row.runtime_id, "claude-code");
  } finally {
    await database.destroy();
  }
});

test("SQLite 旧模型设置表补按底座模型映射时使用空对象", async () => {
  const database = knex({ client: "better-sqlite3", connection: { filename: ":memory:" }, useNullAsDefault: true });
  try {
    await database.schema.createTable(TABLES.modelSettings, (table) => {
      table.string("id", 32).primary();
      table.string("active_id", 64).notNullable();
      table.string("execution_runtime_id", 32).notNullable().defaultTo("cfuse");
      table.string("updated_at", 40).notNullable();
    });
    await database(TABLES.modelSettings).insert({
      id: "singleton",
      active_id: "legacy-model",
      execution_runtime_id: "codex",
      updated_at: "2026-07-14T00:00:00.000Z"
    });

    const report = await repairSchema(database);
    const row = await database(TABLES.modelSettings).where({ id: "singleton" }).first();
    assert.equal(report.status, "ok");
    assert.deepEqual(JSON.parse(row.active_profile_ids_json), {});
    assert.deepEqual(JSON.parse(row.model_overrides_json), {});
    assert.equal(row.execution_runtime_id, "codex");
  } finally {
    await database.destroy();
  }
});
