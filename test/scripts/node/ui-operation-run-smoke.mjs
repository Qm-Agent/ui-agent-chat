import assert from "node:assert/strict";

const baseUrl = String(process.argv[2] || "http://127.0.0.1:47901").replace(/\/+$/, "");
const targetUrl = `${baseUrl}/quality`;

async function request(path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, options);
  const text = await response.text();
  const body = text ? JSON.parse(text) : undefined;
  if (!response.ok) throw new Error(`${options.method || "GET"} ${path}: ${response.status} ${body?.error || text}`);
  return body;
}

const task = await request("/api/ui-operations", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    name: "只读质量看板检查",
    instruction: "读取质量看板标题和测试运行数量，完成后直接总结，不执行任何修改",
    targetUrl,
    browserKernel: "playwright",
    approvalMode: "none"
  })
});
const started = await request(`/api/ui-operations/${task.id}/runs`, { method: "POST" });
console.log(`started run=${started.id} session=${started.sessionId}`);

let run = started;
const deadline = Date.now() + 8 * 60_000;
while (Date.now() < deadline && run.status === "running") {
  await new Promise((resolve) => setTimeout(resolve, 2_000));
  const tasks = await request("/api/ui-operations");
  run = tasks.find((item) => item.id === task.id)?.runs.find((item) => item.id === started.id);
  assert.ok(run, "operation run disappeared while polling");
  console.log(`status=${run.status}`);
}

assert.notEqual(run.status, "running", "operation did not reach a terminal state within 8 minutes");
if (run.status !== "completed") throw new Error(`operation ended as ${run.status}: ${run.error || run.summary || "unknown"}`);

const qualityRuns = await request("/api/quality/runs?limit=100");
const projected = qualityRuns.find((item) => item.sessionId === started.sessionId);
assert.ok(projected, "operation run missing from unified quality projection");
assert.equal(projected.purpose, "operation");
assert.equal(projected.source, "ui-operation");
assert.equal(projected.outcome, "unknown");

console.log(`ui operation run smoke: PASS summary=${String(run.summary || "").slice(0, 200)}`);
