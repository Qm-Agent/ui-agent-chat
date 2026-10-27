import test from "node:test";
import assert from "node:assert/strict";
import { normalizeStoredUiOperationTask } from "../../server/src/uiOperationStore.js";
import { resolveUiOperationExecutionTarget } from "../../server/src/uiOperationService.js";

test("旧 UI 操作任务自动迁移为浏览器执行目标", () => {
  const task = normalizeStoredUiOperationTask({
    id: "legacy",
    name: "旧任务",
    instruction: "打开页面",
    targetUrl: "https://example.com",
    browserKernel: "external-cdp",
    approvalMode: "manual-finalize",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    runs: []
  });
  assert.deepEqual(task.executionTarget, {
    kind: "browser",
    browserKernel: "external-cdp",
    targetUrl: "https://example.com/"
  });
  assert.equal(task.isDraft, false);
  assert.deepEqual(task.experience, {
    presentationMode: "inline",
    browserTaskGroupMode: "off",
    nativeDeliveryMode: "foreground-compatible"
  });
});

test("旧 Skill Profile UI 操作内核归并为 Playwright 配套 Chromium", () => {
  const task = normalizeStoredUiOperationTask({
    id: "legacy-skill-profile",
    name: "旧 Profile 任务",
    instruction: "打开页面",
    browserKernel: "skill-profile",
    executionTarget: { kind: "browser", browserKernel: "skill-profile" },
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    runs: []
  });
  assert.equal(task.browserKernel, "playwright");
  assert.deepEqual(task.executionTarget, {
    kind: "browser",
    browserKernel: "playwright",
    targetUrl: undefined
  });
});

test("UI 操作任务保留画中画与用户浏览器标签组策略", () => {
  const task = normalizeStoredUiOperationTask({
    id: "experience",
    name: "画中画任务",
    instruction: "打开百度",
    browserKernel: "external-cdp",
    executionTarget: { kind: "browser", browserKernel: "external-cdp" },
    experience: {
      presentationMode: "picture-in-picture",
      browserTaskGroupMode: "user-browser",
      nativeDeliveryMode: "background-safe"
    },
    createdAt: "2026-07-23T00:00:00.000Z",
    updatedAt: "2026-07-23T00:00:00.000Z",
    runs: []
  });
  assert.deepEqual(task.experience, {
    presentationMode: "picture-in-picture",
    browserTaskGroupMode: "user-browser",
    nativeDeliveryMode: "background-safe"
  });
});

test("新建 UI 操作草稿在首次发送前保持可持久化状态", () => {
  const task = normalizeStoredUiOperationTask({
    id: "draft",
    name: "新 UI 操作",
    instruction: "新 UI 操作",
    isDraft: true,
    conversationSessionId: "session-draft",
    browserKernel: "playwright",
    executionTarget: {
      kind: "native-app",
      providerId: "macos-accessibility",
      app: { kind: "name", value: "__agent_select__" }
    },
    approvalMode: "none",
    createdAt: "2026-07-17T00:00:00.000Z",
    updatedAt: "2026-07-17T00:00:00.000Z",
    runs: []
  });
  assert.equal(task.isDraft, true);
  assert.equal(task.conversationSessionId, "session-draft");
  assert.deepEqual(task.runs, []);
});

test("原生 UI 操作任务保留 Provider 与应用选择器并默认授权", () => {
  const task = normalizeStoredUiOperationTask({
    id: "native",
    name: "原生任务",
    instruction: "读取窗口",
    browserKernel: "playwright",
    executionTarget: {
      kind: "native-app",
      providerId: "macos-accessibility",
      app: { kind: "process-id", value: "123" },
      displayName: "TextEdit"
    },
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    runs: []
  });
  assert.equal(task.executionTarget.kind, "native-app");
  assert.equal(task.approvalMode, "none");
  assert.equal(task.targetUrl, undefined);
});

test("新式浏览器 UI 操作默认授权且不要求人工审批", () => {
  for (const browserKernel of ["uiwarden-embedded", "external-cdp", "gui-computer"] as const) {
    const task = normalizeStoredUiOperationTask({
      id: `browser-${browserKernel}`,
      name: "浏览器任务",
      instruction: "读取当前页面",
      browserKernel,
      executionTarget: { kind: "browser", browserKernel },
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      runs: []
    });
    assert.equal(task.approvalMode, "none");
  }
});

test("电脑桌面任务缺省应用时由 Agent 自动选择", () => {
  const task = normalizeStoredUiOperationTask({
    id: "native-auto",
    name: "桌面任务",
    instruction: "打开计算器并计算 1+100",
    browserKernel: "playwright",
    executionTarget: {
      kind: "native-app",
      providerId: "macos-accessibility"
    },
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    runs: []
  } as never);
  assert.equal(task.executionTarget.kind, "native-app");
  if (task.executionTarget.kind === "native-app") {
    assert.deepEqual(task.executionTarget.app, { kind: "name", value: "__agent_select__" });
    assert.equal(task.executionTarget.displayName, "Agent 自动选择");
  }
});

test("显式 UIWarden Browser 指令覆盖新对话的电脑桌面默认目标", () => {
  assert.deepEqual(
    resolveUiOperationExecutionTarget(
      "使用 UIWarden-Browser 打开百度并搜索今天台风",
      {
        kind: "native-app",
        providerId: "macos-accessibility",
        app: { kind: "name", value: "__agent_select__" }
      }
    ),
    { kind: "browser", browserKernel: "uiwarden-embedded" }
  );
  assert.equal(
    resolveUiOperationExecutionTarget("使用 Chrome 打开百度", {
      kind: "native-app",
      providerId: "macos-accessibility",
      app: { kind: "name", value: "__agent_select__" }
    })?.kind,
    "native-app"
  );
});
