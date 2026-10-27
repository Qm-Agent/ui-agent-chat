import assert from "node:assert/strict";

const baseUrl = String(process.argv[2] || "http://127.0.0.1:47902").replace(/\/+$/, "");

async function request(path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, options);
  const text = await response.text();
  const body = text ? JSON.parse(text) : undefined;
  if (!response.ok) throw new Error(`${options.method || "GET"} ${path}: ${response.status} ${body?.error || text}`);
  return body;
}

function json(method, body) {
  return { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
}

if (process.argv[3] === "verify") {
  const persisted = await request("/api/ui-operations");
  assert.equal(persisted.length, 30);
  assert.equal(persisted.every((task) => task.name.startsWith("已更新任务 ")), true);
  console.log("ui operation persistence smoke: PASS count=30");
  process.exit(0);
}

const created = await Promise.all(Array.from({ length: 30 }, (_, index) => request(
  "/api/ui-operations",
  json("POST", { name: `并发任务 ${index + 1}`, instruction: `读取页面 ${index + 1}` })
)));
assert.equal(new Set(created.map((task) => task.id)).size, 30);

await Promise.all(created.map((task, index) => request(
  `/api/ui-operations/${task.id}`,
  json("PUT", { name: `已更新任务 ${index + 1}` })
)));

const listed = await request("/api/ui-operations");
assert.equal(listed.length, 30);
assert.equal(listed.every((task) => task.name.startsWith("已更新任务 ")), true);

console.log("ui operation concurrency smoke: PASS count=30");
