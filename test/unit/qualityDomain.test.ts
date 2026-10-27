import assert from "node:assert/strict";
import test from "node:test";
import { buildQualityEvidenceProjection, summarizeQualityRuns } from "../../server/src/qualityDomain.js";
import type { UnifiedQualityRun } from "../../server/src/types.js";

function run(patch: Partial<UnifiedQualityRun>): UnifiedQualityRun {
  return {
    id: patch.id ?? "conversation:1", sessionId: patch.sessionId ?? "session-1",
    purpose: patch.purpose ?? "test", source: patch.source ?? "conversation",
    sourceName: patch.sourceName ?? "运行", status: patch.status ?? "completed",
    outcome: patch.outcome ?? "unknown", browserKernel: patch.browserKernel ?? "playwright",
    startedAt: patch.startedAt ?? "2026-07-10T08:00:00.000Z",
    finishedAt: patch.finishedAt ?? "2026-07-10T08:01:00.000Z",
    durationMs: patch.durationMs ?? 60_000, artifactsCount: patch.artifactsCount ?? 1,
    steps: patch.steps ?? [], assertions: patch.assertions ?? [], ...patch
  };
}

test("统一质量投影生成结构化步骤和断言", () => {
  const evidence = buildQualityEvidenceProjection({ purpose: "test", status: "completed", outcome: "pass", artifactsCount: 3 });
  assert.deepEqual(evidence.steps.map((step) => step.status), ["completed", "completed"]);
  assert.deepEqual(evidence.assertions.map((assertion) => assertion.status), ["pass", "pass"]);
});

test("质量看板仅以测试运行计算通过率", () => {
  const dashboard = summarizeQualityRuns([
    run({ id: "test:pass", outcome: "pass" }),
    run({ id: "test:fail", outcome: "fail", artifactsCount: 0 }),
    run({ id: "operation:1", purpose: "operation", source: "ui-operation", outcome: "unknown" })
  ], new Date("2026-07-11T00:00:00.000Z"));
  assert.equal(dashboard.total, 2);
  assert.equal(dashboard.passRate, 50);
  assert.equal(dashboard.artifactCompletenessRate, 50);
  assert.equal(dashboard.bySource["ui-operation"], 1);
});

test("失败状态优先于冲突的 pass 结论", () => {
  const dashboard = summarizeQualityRuns([
    run({ status: "failed", outcome: "pass" }),
    run({ id: "ok", sessionId: "ok", status: "completed", outcome: "pass" })
  ], new Date("2026-07-11T10:00:00+08:00"));
  assert.equal(dashboard.passed, 1);
  assert.equal(dashboard.failed, 1);
});

test("未执行和人工中止保持独立状态", () => {
  const dashboard = summarizeQualityRuns([
    run({ status: "idle", outcome: "unknown" }),
    run({ id: "aborted", sessionId: "aborted", status: "aborted", outcome: "unknown" })
  ], new Date("2026-07-11T10:00:00+08:00"));
  assert.equal(dashboard.running, 0);
  assert.equal(dashboard.aborted, 1);
  assert.equal(dashboard.passed, 0);
});

test("重新运行中的会话不沿用旧 pass", () => {
  const dashboard = summarizeQualityRuns([
    run({ status: "running", outcome: "pass", startedAt: "2026-07-11T01:00:00.000Z" })
  ], new Date("2026-07-11T10:00:00+08:00"));
  assert.equal(dashboard.running, 1);
  assert.equal(dashboard.passed, 0);
});
