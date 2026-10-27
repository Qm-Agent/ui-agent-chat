import assert from "node:assert/strict";

const baseUrl = String(process.argv[2] || "http://127.0.0.1:47902").replace(/\/+$/, "");

async function request(path, options = {}, expectedStatus) {
  const response = await fetch(`${baseUrl}${path}`, options);
  const text = await response.text();
  const body = text ? JSON.parse(text) : undefined;
  if (expectedStatus != null) assert.equal(response.status, expectedStatus);
  else if (!response.ok) throw new Error(`${options.method || "GET"} ${path}: ${response.status} ${body?.error || text}`);
  return body;
}

const task = await request("/api/ui-operations", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    name: "中止能力验证",
    instruction: "等待页面稳定后读取质量看板全部信息并详细总结，不执行任何修改",
    targetUrl: `${baseUrl}/quality`,
    browserKernel: "playwright",
    approvalMode: "none"
  })
});
const run = await request(`/api/ui-operations/${task.id}/runs`, { method: "POST" });
const aborted = await request(`/api/ui-operations/${task.id}/runs/${run.id}/abort`, { method: "POST" });
assert.equal(aborted.status, "aborted");

await new Promise((resolve) => setTimeout(resolve, 3_000));
const tasks = await request("/api/ui-operations");
const persisted = tasks.find((item) => item.id === task.id)?.runs.find((item) => item.id === run.id);
assert.equal(persisted?.status, "aborted");

const approvalError = await request(
  `/api/ui-operations/${task.id}/runs/${run.id}/approve`,
  { method: "POST" },
  500
);
assert.match(approvalError.error, /当前不等待审批/);

const qualityRuns = await request("/api/quality/runs?limit=1000");
const projected = qualityRuns.find((item) => item.sessionId === run.sessionId);
assert.equal(projected?.purpose, "operation");
assert.equal(projected?.status, "aborted");
console.log("ui operation abort smoke: PASS");
