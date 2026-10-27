import assert from "node:assert/strict";

const baseUrl = String(process.argv[2] || "http://127.0.0.1:47901").replace(/\/+$/, "");
const desktopMode = process.argv.includes("--desktop");

async function request(path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, options);
  const text = await response.text();
  const body = text ? JSON.parse(text) : undefined;
  return { response, body };
}

function json(method, body) {
  return { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
}

const dashboard = await request("/api/quality/dashboard");
assert.equal(dashboard.response.status, 200);
assert.equal(dashboard.body.total, 0);
assert.equal(dashboard.body.trends.length, 14);

const defects = await request("/api/integrations/defects/capabilities");
assert.equal(defects.response.status, 200);
assert.equal(defects.body.enabled, false);

const initialTasks = await request("/api/ui-operations");
assert.equal(initialTasks.response.status, 200);
const initialIds = new Set(initialTasks.body.map((task) => task.id));

const plain = await request("/api/ui-operations", json("POST", {
  name: "Smoke Playwright",
  instruction: "打开示例页面"
}));
assert.equal(plain.response.status, 201);
assert.equal(plain.body.browserKernel, "playwright");
assert.equal(plain.body.approvalMode, "none");

const embedded = await request("/api/ui-operations", json("POST", {
  name: "Smoke Embedded",
  instruction: "打开示例页面并等待确认",
  browserKernel: "uiwarden-embedded"
}));
if (desktopMode) {
  assert.equal(embedded.response.status, 201);
  assert.equal(embedded.body.approvalMode, "none");
} else {
  assert.equal(embedded.response.status, 403);
  assert.match(embedded.body.error, /客户端可用/);
}

const missingUpdate = await request("/api/ui-operations/not-found", json("PUT", { instruction: "不会被创建" }));
assert.equal(missingUpdate.response.status, 500);
assert.match(missingUpdate.body.error, /不存在/);

const listed = await request("/api/ui-operations");
assert.equal(listed.response.status, 200);
assert.equal(listed.body.length, initialTasks.body.length + (desktopMode ? 2 : 1));

for (const task of listed.body) {
  if (initialIds.has(task.id)) continue;
  const removed = await request(`/api/ui-operations/${task.id}`, { method: "DELETE" });
  assert.equal(removed.response.status, 204);
}

const unknown = await request("/api/quality/not-found");
assert.equal(unknown.response.status, 404);
assert.match(unknown.body.error, /Unknown API/);

console.log("unified quality smoke: PASS");
