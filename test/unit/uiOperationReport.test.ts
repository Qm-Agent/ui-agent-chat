import test from "node:test";
import assert from "node:assert/strict";
import { renderUiOperationHtmlReport } from "../../server/src/uiOperationService.js";
import type { UiOperationRun, UiOperationTask } from "../../server/src/types.js";

test("UI 操作 HTML 报告记录目标、过程、结果和产物并转义内容", () => {
  const task: UiOperationTask = {
    id: "task-1",
    name: "计算 <1+100>",
    instruction: "打开计算器",
    status: "completed",
    executionTarget: { kind: "native-app", providerId: "macos-accessibility", appSelector: "__agent_select__" },
    approvalMode: "manual-finalize",
    runs: [],
    createdAt: "2026-07-13T00:00:00.000Z",
    updatedAt: "2026-07-13T00:01:00.000Z"
  };
  const run: UiOperationRun = {
    id: "run-1",
    taskId: task.id,
    sessionId: "session-1",
    status: "completed",
    instruction: "输入 <script>alert(1)</script>",
    summary: "结果为 101",
    startedAt: "2026-07-13T00:00:00.000Z",
    finishedAt: "2026-07-13T00:01:00.000Z"
  };
  const html = renderUiOperationHtmlReport({
    task,
    run,
    messages: [{ id: "m1", role: "assistant", content: "已点击 =", createdAt: run.finishedAt! }],
    artifacts: [{
      id: "a1",
      name: "final.png",
      relativePath: ".skill-output/native-reps/run-1/final.png",
      size: 123,
      modifiedAt: run.finishedAt!,
      kind: "file"
    }]
  });
  assert.match(html, /电脑桌面 \/ macos-accessibility/);
  assert.match(html, /已完成/);
  assert.match(html, /结果为 101/);
  assert.match(html, /已点击 =/);
  assert.match(html, /final\.png/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/);
});
