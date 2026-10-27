import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import knex from "knex";
import { initSchema } from "../../server/src/db/migrate.js";
import { closeDatabase, setDatabaseRuntime } from "../../server/src/db/index.js";
import { TABLES } from "../../server/src/db/schema.js";
import { buildExecutionRuntimeEnvironment } from "../../server/src/executionRuntime.js";
import {
  activateModelProfile,
  getSelectedExecutionRuntimeId,
  getRuntimeModelOverride,
  listModelProfiles,
  selectExecutionRuntime,
  selectRuntimeModel,
  upsertModelProfile
} from "../../server/src/modelStore.js";

test("模型激活采用单例幂等更新并返回明确生效状态", async () => {
  const database = knex({
    client: "better-sqlite3",
    connection: { filename: ":memory:" },
    useNullAsDefault: true
  });
  setDatabaseRuntime({
    knex: database,
    config: { mode: "sqlite", databaseUrl: "sqlite://:memory:", fallbackUrl: "sqlite://:memory:" },
    mode: "sqlite",
    status: "ok",
    fallback: false,
    activeKind: "sqlite",
    activeUrl: "sqlite://:memory:",
    targetUrl: "sqlite://:memory:",
    fallbackUrl: "sqlite://:memory:",
    reason: ""
  });

  try {
    await initSchema(database);
    assert.equal(await getSelectedExecutionRuntimeId(), "dtcoder");
    await selectExecutionRuntime("cfuse");
    assert.equal(await getSelectedExecutionRuntimeId(), "cfuse");
    const profile = await upsertModelProfile({
      runtimeId: "claude-code",
      name: "回归模型",
      baseUrl: "https://example.test/anthropic",
      authToken: "test-token",
      model: "test-model"
    });

    await activateModelProfile(profile.id);
    await activateModelProfile(profile.id);

    const settings = await database(TABLES.modelSettings).select("*");
    assert.equal(settings.length, 1);
    assert.equal(settings[0].id, "singleton");
    assert.equal(settings[0].active_id, profile.id);
    assert.deepEqual(JSON.parse(settings[0].active_profile_ids_json), {
      "claude-code": profile.id
    });

    const profiles = await listModelProfiles();
    assert.equal(profiles.find((item) => item.id === profile.id)?.isActive, true);
  } finally {
    await closeDatabase();
  }
});

test("底座模型覆盖默认不生效，显式选择后可恢复跟随底座默认", async () => {
  const database = knex({
    client: "better-sqlite3",
    connection: { filename: ":memory:" },
    useNullAsDefault: true
  });
  setDatabaseRuntime({
    knex: database,
    config: { mode: "sqlite", databaseUrl: "sqlite://:memory:", fallbackUrl: "sqlite://:memory:" },
    mode: "sqlite",
    status: "ok",
    fallback: false,
    activeKind: "sqlite",
    activeUrl: "sqlite://:memory:",
    targetUrl: "sqlite://:memory:",
    fallbackUrl: "sqlite://:memory:",
    reason: ""
  });

  try {
    await initSchema(database);
    assert.equal(await getRuntimeModelOverride("cfuse"), undefined);

    await selectRuntimeModel("cfuse", "antchat/GLM-5.2");
    assert.equal(await getRuntimeModelOverride("cfuse"), "antchat/GLM-5.2");
    assert.equal(
      (await buildExecutionRuntimeEnvironment("cfuse", {})).model,
      "antchat/GLM-5.2"
    );
    assert.equal(
      (await buildExecutionRuntimeEnvironment("cfuse", {}, {
        modelOverride: "antchat/GLM-5.1-evaluation"
      })).model,
      "antchat/GLM-5.1-evaluation"
    );
    assert.equal(
      await getRuntimeModelOverride("cfuse"),
      "antchat/GLM-5.2",
      "单次评测覆盖不能修改配置中心的全局模型"
    );

    await selectRuntimeModel("cfuse", null);
    assert.equal(await getRuntimeModelOverride("cfuse"), undefined);
    const row = await database(TABLES.modelSettings).where({ id: "singleton" }).first();
    assert.deepEqual(JSON.parse(row.model_overrides_json), {});
    assert.deepEqual(JSON.parse(row.active_profile_ids_json), { cfuse: null });
  } finally {
    await closeDatabase();
  }
});

test("激活模型档案会清除同底座的目录模型覆盖", async () => {
  const database = knex({
    client: "better-sqlite3",
    connection: { filename: ":memory:" },
    useNullAsDefault: true
  });
  setDatabaseRuntime({
    knex: database,
    config: { mode: "sqlite", databaseUrl: "sqlite://:memory:", fallbackUrl: "sqlite://:memory:" },
    mode: "sqlite",
    status: "ok",
    fallback: false,
    activeKind: "sqlite",
    activeUrl: "sqlite://:memory:",
    targetUrl: "sqlite://:memory:",
    fallbackUrl: "sqlite://:memory:",
    reason: ""
  });

  try {
    await initSchema(database);
    await selectRuntimeModel("codex", "gpt-5.6-terra");
    const profile = await upsertModelProfile({
      runtimeId: "codex",
      name: "Codex 自定义配置",
      model: "gpt-5.6-sol"
    });
    await activateModelProfile(profile.id);
    assert.equal(await getRuntimeModelOverride("codex"), undefined);
    assert.equal((await listModelProfiles()).find((item) => item.id === profile.id)?.isActive, true);
  } finally {
    await closeDatabase();
  }
});

test("同一底座可保存多个独立路由且 CFuse 保留各自 URL 和 Token", async () => {
  const database = knex({
    client: "better-sqlite3",
    connection: { filename: ":memory:" },
    useNullAsDefault: true
  });
  setDatabaseRuntime({
    knex: database,
    config: { mode: "sqlite", databaseUrl: "sqlite://:memory:", fallbackUrl: "sqlite://:memory:" },
    mode: "sqlite",
    status: "ok",
    fallback: false,
    activeKind: "sqlite",
    activeUrl: "sqlite://:memory:",
    targetUrl: "sqlite://:memory:",
    fallbackUrl: "sqlite://:memory:",
    reason: ""
  });

  try {
    await initSchema(database);
    const routeA = await upsertModelProfile({
      runtimeId: "cfuse",
      name: "路由 A",
      baseUrl: "https://route-a.example/anthropic",
      authToken: "token-a",
      model: "model-a"
    });
    await upsertModelProfile({
      runtimeId: "cfuse",
      name: "路由 B",
      baseUrl: "https://route-b.example/anthropic",
      authToken: "token-b",
      model: "model-b"
    });

    const rows = await database(TABLES.modelProfiles).where({ runtime_id: "cfuse" }).orderBy("name");
    assert.equal(rows.length, 2);
    assert.deepEqual(
      rows.map((row) => [row.name, row.base_url, row.auth_token]),
      [
        ["路由 A", "https://route-a.example/anthropic", "token-a"],
        ["路由 B", "https://route-b.example/anthropic", "token-b"]
      ]
    );
    await activateModelProfile(routeA.id);
    const runtime = await buildExecutionRuntimeEnvironment("cfuse", {});
    assert.equal(runtime.env.ANTHROPIC_BASE_URL, "https://route-a.example/anthropic");
    assert.equal(runtime.env.ANTHROPIC_AUTH_TOKEN, "token-a");
    assert.equal(runtime.model, "model-a");
  } finally {
    await closeDatabase();
  }
});

test("路由联通失败时拒绝写入模型档案", async () => {
  const database = knex({
    client: "better-sqlite3",
    connection: { filename: ":memory:" },
    useNullAsDefault: true
  });
  setDatabaseRuntime({
    knex: database,
    config: { mode: "sqlite", databaseUrl: "sqlite://:memory:", fallbackUrl: "sqlite://:memory:" },
    mode: "sqlite",
    status: "ok",
    fallback: false,
    activeKind: "sqlite",
    activeUrl: "sqlite://:memory:",
    targetUrl: "sqlite://:memory:",
    fallbackUrl: "sqlite://:memory:",
    reason: ""
  });
  const server = http.createServer((_request, response) => {
    response.writeHead(401, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: { message: "invalid credential" } }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");

  try {
    await initSchema(database);
    await assert.rejects(
      () => upsertModelProfile({
        runtimeId: "cfuse",
        name: "不可用路由",
        baseUrl: `http://127.0.0.1:${address.port}`,
        authToken: "invalid-token",
        model: "test-model"
      }, { testConnection: true }),
      /模型路由联通测试失败.*HTTP 401/
    );
    assert.equal(await database(TABLES.modelProfiles).count({ count: "*" }).first().then((row) => Number(row?.count)), 0);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await closeDatabase();
  }
});
