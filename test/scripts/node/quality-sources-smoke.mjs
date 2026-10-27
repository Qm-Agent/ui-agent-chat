import assert from "node:assert/strict";

const baseUrl = String(process.argv[2] || "http://127.0.0.1:47906").replace(/\/+$/, "");

async function request(path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, options);
  const text = await response.text();
  const body = text ? JSON.parse(text) : undefined;
  if (!response.ok) throw new Error(`${options.method || "GET"} ${path}: ${response.status} ${body?.error || text}`);
  return body;
}

function json(body) {
  return { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
}

const inspection = await request("/api/inspection-tasks", json({
  name: "统一模型巡检来源",
  url: `${baseUrl}/quality`,
  prompt: "只读取标题"
}));
const inspectionRun = await request(`/api/inspection-tasks/${inspection.id}/runs`, { method: "POST" });
await request(`/api/inspection-tasks/${inspection.id}/runs/${inspectionRun.id}/abort`, { method: "POST" });

const module = await request("/api/regression/modules", json({ name: "统一模型模块" }));
const regressionCase = await request("/api/regression/cases", json({
  moduleId: module.id,
  name: "统一模型回归来源",
  prompt: "打开质量看板并读取标题"
}));
const batch = await request("/api/regression/batches", json({ name: "统一模型批次", caseIds: [regressionCase.id] }));
await request(`/api/regression/batches/${batch.id}/abort`, { method: "POST" });

await new Promise((resolve) => setTimeout(resolve, 4_000));
const qualityRuns = await request("/api/quality/runs?limit=1000");
const projectedInspection = qualityRuns.find((run) => run.sessionId === inspectionRun.sessionId);
assert.equal(projectedInspection?.source, "inspection");
assert.equal(projectedInspection?.sourceName, "统一模型巡检来源");
assert.equal(projectedInspection?.purpose, "test");

const batchAfter = await request(`/api/regression/batches/${batch.id}`);
const regressionSessionId = batchAfter.runs[0]?.sessionId;
assert.ok(regressionSessionId);
const projectedRegression = qualityRuns.find((run) => run.sessionId === regressionSessionId);
assert.equal(projectedRegression?.source, "regression");
assert.equal(projectedRegression?.sourceName, "统一模型回归来源");
assert.equal(projectedRegression?.purpose, "test");

const dashboard = await request("/api/quality/dashboard");
assert.ok(dashboard.bySource.inspection >= 1);
assert.ok(dashboard.bySource.regression >= 1);
console.log(`quality sources smoke: PASS inspection=${projectedInspection.status} regression=${projectedRegression.status}`);
