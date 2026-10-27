import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { TASK_GROUP_EXTENSION_ID } from "../../server/src/cdpManager.js";

test("task group extension keeps a narrow permission surface", async () => {
  const manifest = JSON.parse(
    await fs.readFile(path.resolve("browser-task-group-extension/manifest.json"), "utf8")
  ) as {
    permissions?: string[];
    host_permissions?: string[];
    content_scripts?: unknown[];
    background?: { service_worker?: string };
    externally_connectable?: { matches?: string[] };
  };
  assert.deepEqual(manifest.permissions, ["tabs", "tabGroups", "debugger", "storage", "alarms"]);
  assert.equal(manifest.host_permissions, undefined);
  assert.equal(manifest.content_scripts, undefined);
  assert.equal(manifest.background?.service_worker, "background.js");
  assert.deepEqual(manifest.externally_connectable?.matches, [
    "http://127.0.0.1/*",
    "http://localhost/*"
  ]);
  const publicKey = Buffer.from(String((manifest as { key?: string }).key || ""), "base64");
  const derivedId = createHash("sha256")
    .update(publicKey)
    .digest()
    .subarray(0, 16)
    .toString("hex")
    .replace(/[0-9a-f]/g, (value) => String.fromCharCode("a".charCodeAt(0) + Number.parseInt(value, 16)));
  assert.equal(TASK_GROUP_EXTENSION_ID, derivedId);
});

test("browser bridge background limits pairing, page scope, and CDP methods", async () => {
  const source = await fs.readFile(path.resolve("browser-task-group-extension/background.js"), "utf8");
  assert.match(source, /url\.hostname === "127\.0\.0\.1" \|\| url\.hostname === "localhost"/);
  assert.match(source, /url\.pathname === "\/api\/cdp\/extension-bridge\/socket"/);
  assert.match(source, /Runtime\.evaluate/);
  assert.match(source, /Page\.captureScreenshot/);
  assert.match(source, /Input\.dispatchMouseEvent/);
  assert.match(source, /HEARTBEAT_INTERVAL_MS = 20_000/);
  assert.match(source, /type: "ping"/);
  assert.match(source, /if \(bridgeSocket !== socket\) return;/);
  assert.match(source, /\^https\?:\\\/\\\//);
  assert.doesNotMatch(source, /chrome\.scripting/);
  assert.doesNotMatch(source, /chrome\.cookies/);
});

test("task group extension creates only the requested marker tab and group", async () => {
  const calls: Array<{ method: string; value: unknown }> = [];
  const context = vm.createContext({
    chrome: {
      tabs: {
        create: async (value: unknown) => {
          calls.push({ method: "tabs.create", value });
          return { id: 37 };
        },
        group: async (value: unknown) => {
          calls.push({ method: "tabs.group", value });
          return 12;
        }
      },
      tabGroups: {
        update: async (groupId: number, value: unknown) => {
          calls.push({ method: "tabGroups.update", value: { groupId, value } });
        }
      }
    }
  });
  vm.runInContext(
    await fs.readFile(path.resolve("browser-task-group-extension/control.js"), "utf8"),
    context
  );
  const taskGroups = (context as unknown as {
    uiwardenTaskGroups: {
      createTaskGroup(input: Record<string, unknown>): Promise<Record<string, unknown>>;
    };
  }).uiwardenTaskGroups;
  const result = await taskGroups.createTaskGroup({
    markerUrl: "about:blank#uiwarden-task-run-1",
    title: "检查同步任务结果",
    color: "red"
  });
  assert.deepEqual(
    JSON.parse(JSON.stringify(result)),
    {
      version: 1,
      chromeTabId: 37,
      groupId: 12,
      markerUrl: "about:blank#uiwarden-task-run-1"
    }
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(calls)),
    [
      {
        method: "tabs.create",
        value: { url: "about:blank#uiwarden-task-run-1", active: true }
      },
      {
        method: "tabs.group",
        value: { tabIds: [37] }
      },
      {
        method: "tabGroups.update",
        value: {
          groupId: 12,
          value: { title: "检查同步任务结果", color: "red", collapsed: false }
        }
      }
    ]
  );
});

test("task group extension rejects URLs outside the UIWarden marker namespace", async () => {
  const context = vm.createContext({
    chrome: {
      tabs: { create: async () => ({ id: 1 }), group: async () => 1 },
      tabGroups: { update: async () => undefined }
    }
  });
  vm.runInContext(
    await fs.readFile(path.resolve("browser-task-group-extension/control.js"), "utf8"),
    context
  );
  const taskGroups = (context as unknown as {
    uiwardenTaskGroups: {
      createTaskGroup(input: Record<string, unknown>): Promise<Record<string, unknown>>;
    };
  }).uiwardenTaskGroups;
  await assert.rejects(
    taskGroups.createTaskGroup({ markerUrl: "https://example.com", title: "bad" }),
    /Invalid UIWarden task marker/
  );
});
