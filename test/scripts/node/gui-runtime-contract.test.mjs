import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { parseCliArguments, GuiAutomationError } from "../../../gui-runtime/dist/index.js";
import { buildAction, dispatch, filterApps, filterObservation, validateAction } from "../../../native-automation/dist/cli.js";
import { callComputerTool, computerMcpCall, computerMcpTools } from "../../../native-automation/dist/mcp.js";
import { nativeObservationLimits } from "../../../native-automation/dist/providers.js";
import { approvalMatchesAction, ComputerRuntime, observationFingerprint, requiresApproval } from "../../../native-automation/dist/runtime.js";

test("shared CLI parser is used by browser and computer runtimes", () => {
  assert.deepEqual(parseCliArguments(["observe", "--session", "cua-1", "--full"], new Set(["full"])), {
    command: ["observe"],
    options: { session: "cua-1", full: true }
  });
  assert.throws(
    () => parseCliArguments(["observe", "--session"], new Set()),
    (error) => error instanceof GuiAutomationError && error.code === "INVALID_ARGUMENT"
  );
});

test("computer CLI filtering and action validation preserve the Rust contract", () => {
  const filteredApps = filterApps({
    providerId: "mock",
    apps: [
      { id: "com.example.chat.mac", displayName: "Example Chat", isRunning: true },
      { id: "dd.work.exclusive4antding", displayName: "蚂蚁钉", isRunning: false }
    ]
  }, "蚂蚁钉", 20);
  assert.equal(filteredApps.totalAppCount, 2);
  assert.equal(filteredApps.matchedAppCount, 1);
  assert.equal(filteredApps.fallbackRequired, false);

  const localizedNameMiss = filterApps({
    providerId: "macos-accessibility",
    apps: [{ id: "com.apple.calculator", displayName: "Calculator", isRunning: false }]
  }, "计算器", 20);
  assert.equal(localizedNameMiss.matchedAppCount, 0);
  assert.equal(localizedNameMiss.fallbackRequired, true);
  assert.match(String(localizedNameMiss.fallbackHint), /不带 --query/);

  const filteredSnapshot = filterObservation({
    snapshotId: "snapshot-1",
    text: "ax-1 AXButton 搜索\nax-2 AXTextField 消息",
    elements: [
      { elementId: "ax-1", role: "AXButton", name: "搜索" },
      { elementId: "ax-2", role: "AXTextField", name: "消息" }
    ]
  }, "消息", 20);
  assert.equal(filteredSnapshot.snapshotId, "snapshot-1");
  assert.equal(filteredSnapshot.matchedElementCount, 1);

  const coordinate = buildAction("click", { x: "10", y: "20" });
  assert.throws(() => validateAction(coordinate), /allow-coordinate-fallback/);
  const focused = buildAction("type-text", { value: "hello", focused: true });
  assert.doesNotThrow(() => validateAction(focused));
});

test("computer observation defaults to a compact AX projection", () => {
  assert.deepEqual(nativeObservationLimits(false), { maxDepth: 8, maxElements: 400 });
  assert.deepEqual(nativeObservationLimits(true), { maxDepth: 12, maxElements: 800 });
});

test("observation progress ignores noisy elements outside the target window", () => {
  const base = {
    app: { id: "com.apple.Notes", displayName: "Notes", isRunning: true },
    text: "",
    captureGaps: [],
    windowBounds: { x: 0, y: 0, width: 800, height: 600 },
    elements: [
      { elementId: "visible", providerPath: "0.1", role: "AXTextArea", name: "Editor", value: "stable", secure: false, enabled: true, actions: [], focused: true, bounds: { x: 300, y: 100, width: 400, height: 300 } },
      { elementId: "offscreen", providerPath: "0.2", role: "AXStaticText", name: "Old note", value: "first", secure: false, enabled: true, actions: [], focused: false, bounds: { x: 20, y: 900, width: 200, height: 30 } }
    ]
  };
  const noisy = structuredClone(base);
  noisy.elements[1].value = "second";
  assert.equal(observationFingerprint(base), observationFingerprint(noisy));
  noisy.elements[0].value = "changed";
  assert.notEqual(observationFingerprint(base), observationFingerprint(noisy));
});

test("diff observation returns only changed elements and removed identifiers", () => {
  const diff = filterObservation({
    snapshotId: "snapshot-2",
    text: "full tree",
    elements: [
      { elementId: "unchanged", role: "AXButton", name: "Save" },
      { elementId: "updated", role: "AXTextField", name: "Name", value: "Alice" }
    ],
    changes: {
      addedElements: [{ elementId: "added", role: "AXStaticText", name: "Saved" }],
      updatedElements: [{ elementId: "updated", role: "AXTextField", name: "Name", value: "Alice" }],
      removedElementIds: ["removed"]
    }
  }, undefined, 60, true);
  assert.equal(diff.diff, true);
  assert.equal(diff.diffTruncated, false);
  assert.deepEqual(diff.elements.map((element) => element.elementId), ["added", "updated"]);
  assert.deepEqual(diff.removedElementIds, ["removed"]);
  assert.equal("changes" in diff, false);
  assert.match(diff.text, /Alice/);
});

test("diff observation signals truncation instead of hiding an incomplete decision surface", () => {
  const diff = filterObservation({
    elements: Array.from({ length: 3 }, (_, index) => ({ elementId: `element-${index}` })),
    changes: {
      addedElements: Array.from({ length: 3 }, (_, index) => ({ elementId: `element-${index}` })),
      updatedElements: [],
      removedElementIds: []
    }
  }, undefined, 2, true);
  assert.equal(diff.diff, true);
  assert.equal(diff.diffTruncated, true);
  assert.equal(diff.changedElementCount, 3);
  assert.equal(diff.elements.length, 2);
});

test("targeted observation keeps the compact AX tree unless full is explicitly requested", async () => {
  const fullFlags = [];
  const runtime = {
    async observe(_sessionId, full) {
      fullFlags.push(full);
      return {
        snapshotId: "snapshot-query",
        text: "AXButton shallow\nAXTextField deep target",
        elements: [
          { elementId: "shallow", role: "AXButton", name: "shallow" },
          { elementId: "deep", role: "AXTextField", name: "deep target" }
        ]
      };
    }
  };
  const cliResult = await dispatch(runtime, {
    command: ["observe"],
    options: { session: "cua-query", query: "deep", limit: "20" }
  });
  const mcpResult = await callComputerTool(runtime, "native_observe", {
    sessionId: "cua-query",
    query: "deep",
    limit: 20
  });
  await dispatch(runtime, {
    command: ["observe"],
    options: { session: "cua-query", query: "deep", full: true, limit: "20" }
  });
  assert.deepEqual(fullFlags, [false, false, true]);
  assert.equal(cliResult.matchedElementCount, 1);
  assert.equal(mcpResult.matchedElementCount, 1);
  assert.equal(cliResult.responseTruncated, false);
});

test("compact observation prioritizes actionable elements and reports response truncation", () => {
  const snapshot = filterObservation({
    projection: { mode: "compact", maxDepth: 8, maxElements: 400, truncated: false },
    text: "large provider text",
    elements: [
      { elementId: "generic-group", role: "AXGroup", name: "", enabled: true, actions: ["UIWardenCenterClick"] },
      { elementId: "static-1", role: "AXStaticText", name: "说明" },
      { elementId: "button-save", role: "AXButton", name: "保存", enabled: true, actions: ["AXPress"] },
      { elementId: "input-name", role: "AXTextField", name: "名称", focused: true, enabled: true }
    ]
  }, undefined, 2);
  assert.equal(snapshot.totalElementCount, 4);
  assert.equal(snapshot.responseElementCount, 2);
  assert.equal(snapshot.responseTruncated, true);
  assert.deepEqual(snapshot.elements.map((element) => element.elementId), ["button-save", "input-name"]);
  assert.doesNotMatch(snapshot.text, /static-1/);
});

test("approval policy and MCP atomic surface remain compatible", () => {
  const enter = { kind: "key", key: "Return", allowCoordinateFallback: false, focused: false };
  assert.equal(requiresApproval(enter), true);
  const shortcut = { kind: "key", key: "Command+f", allowCoordinateFallback: false, focused: false };
  assert.equal(requiresApproval(shortcut), false);
  const names = computerMcpTools().map((tool) => tool.name);
  for (const expected of [
    "native_capabilities", "native_apps_list", "native_session_start", "native_session_status",
    "native_session_target", "native_session_launch", "native_session_control", "native_observe",
    "native_action_and_observe",
    "native_click", "native_visual_click", "native_set_value", "native_type_text", "native_key",
    "native_scroll", "native_approval_grant", "native_approval_reject", "native_session_stop"
  ]) assert.equal(names.includes(expected), true, expected);
  assert.equal(names.includes("native_shell"), false);
});

test("compatible CLI commands map to equivalent MCP tools", () => {
  assert.deepEqual(computerMcpCall({
    command: ["apps", "list"],
    options: { provider: "mock", query: "UIWarden", limit: "5" }
  }), {
    name: "native_apps_list",
    args: { provider: "mock", query: "UIWarden", limit: 5 }
  });
  assert.deepEqual(computerMcpCall({
    command: ["click"],
    options: {
      session: "cua-1",
      snapshot: "snapshot-1",
      x: "10",
      y: "20",
      "allow-coordinate-fallback": true,
      actor: "user"
    }
  }), {
    name: "native_click",
    args: {
      sessionId: "cua-1",
      snapshotId: "snapshot-1",
      x: 10,
      y: 20,
      allowCoordinateFallback: true,
      focused: false,
      actor: "user"
    }
  });
  assert.deepEqual(computerMcpCall({
    command: ["set-value"],
    options: {
      session: "cua-1",
      snapshot: "snapshot-1",
      element: "input-name",
      value: "Alice",
      observe: true,
      diff: true
    }
  }), {
    name: "native_action_and_observe",
    args: {
      actionKind: "set-value",
      sessionId: "cua-1",
      snapshotId: "snapshot-1",
      elementId: "input-name",
      value: "Alice",
      allowCoordinateFallback: false,
      focused: false,
      actor: "agent",
      full: false,
      diff: true
    }
  });
});

test("action and observe MCP tool preserves separate action and snapshot semantics", async () => {
  const calls = [];
  const runtime = {
    async performAction(sessionId, snapshotId, action) {
      calls.push(["action", sessionId, snapshotId, action.kind]);
      return { performed: true, kind: action.kind };
    },
    async observe(sessionId, full) {
      calls.push(["observe", sessionId, full]);
      return { snapshotId: "snapshot-2", text: "updated", elements: [] };
    }
  };
  const result = await callComputerTool(runtime, "native_action_and_observe", {
    actionKind: "click",
    sessionId: "cua-1",
    snapshotId: "snapshot-1",
    elementId: "button-save"
  });
  assert.deepEqual(calls, [
    ["action", "cua-1", "snapshot-1", "click"],
    ["observe", "cua-1", false]
  ]);
  assert.equal(result.action.performed, true);
  assert.equal(result.snapshot.snapshotId, "snapshot-2");
});

test("approved actions created by the Rust runtime survive signature migration", () => {
  const action = { kind: "key", key: "Return", allowCoordinateFallback: false, focused: false };
  const challenge = {
    challengeId: "approval-legacy",
    actionSignature: "action-legacy-rust-hash",
    actionSummary: "key Return",
    snapshotId: "snapshot-legacy",
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    granted: true
  };
  assert.equal(approvalMatchesAction(
    challenge,
    "approval-legacy",
    "snapshot-legacy",
    action,
    "action-new-typescript-hash"
  ), true);
  assert.equal(approvalMatchesAction(
    challenge,
    "approval-legacy",
    "snapshot-other",
    action,
    "action-new-typescript-hash"
  ), false);
});

test("TypeScript runtime reads sessions written with the previous Rust schema", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dt-gui-computer-legacy-"));
  try {
    await fs.mkdir(path.join(root, "sessions"), { recursive: true });
    const sessionId = "cua-00000000-0000-4000-8000-000000000001";
    await fs.writeFile(path.join(root, "sessions", `${sessionId}.json`), JSON.stringify({
      version: 1,
      sessionId,
      providerId: "mock",
      app: { kind: "name", value: "mock.demo" },
      controlMode: "observe",
      state: "stopped",
      artifactDir: path.join(root, "native-reps", sessionId),
      startedAt: "2026-07-12T00:00:00.000Z",
      snapshotSequence: 0
    }));
    const runtime = await ComputerRuntime.create(root);
    const session = await runtime.sessionStatus(sessionId);
    assert.equal(session.approvalPolicy, "sensitive-actions");
    assert.deepEqual(session.pendingApprovals, []);
    assert.deepEqual(session.captureGaps, []);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
