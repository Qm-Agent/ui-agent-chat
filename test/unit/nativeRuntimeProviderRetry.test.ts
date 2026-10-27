import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { GuiAutomationError } from "../../native-automation/shared-runtime/index.js";
import { provider } from "../../native-automation/src-ts/providers.js";
import { ComputerRuntime } from "../../native-automation/src-ts/runtime.js";
import type {
  AutomationSession,
  NativeAction,
  NativeProvider
} from "../../native-automation/src-ts/types.js";

test("Provider 动作超时只允许重新观察后重试原动作一次", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "uiwarden-provider-retry-"));
  const runtime = await ComputerRuntime.create(root);
  const mock = provider("mock");
  const originalPerform = mock.perform.bind(mock);
  let calls = 0;
  mock.perform = async (_session: AutomationSession, _action: NativeAction) => {
    calls += 1;
    throw new GuiAutomationError("PROVIDER_UNAVAILABLE", "Mock Provider 30 秒内未返回响应");
  };

  const session = await runtime.startSession({
    providerId: "mock",
    app: { kind: "name", value: "UIWarden Mock Desktop" },
    controlMode: "agent-control",
    approvalPolicy: "none"
  });
  const action: NativeAction = {
    kind: "click",
    elementId: "button-save",
    allowCoordinateFallback: false,
    focused: false
  };

  try {
    const first = await runtime.observe(session.sessionId, false);
    await assert.rejects(
      runtime.performAction(session.sessionId, first.snapshotId, action),
      (error: unknown) => error instanceof GuiAutomationError && error.code === "PROVIDER_UNAVAILABLE"
    );
    await assert.rejects(
      runtime.performAction(session.sessionId, first.snapshotId, action),
      (error: unknown) => error instanceof GuiAutomationError && error.code === "STALE_SNAPSHOT"
    );

    const second = await runtime.observe(session.sessionId, false);
    await assert.rejects(
      runtime.performAction(session.sessionId, second.snapshotId, {
        kind: "key",
        key: "return",
        allowCoordinateFallback: false,
        focused: false
      }),
      (error: unknown) =>
        error instanceof GuiAutomationError
        && error.code === "PROVIDER_UNAVAILABLE"
        && /仅允许重试原动作一次/.test(error.message)
    );
    await assert.rejects(
      runtime.performAction(session.sessionId, second.snapshotId, action),
      (error: unknown) => error instanceof GuiAutomationError && error.code === "PROVIDER_UNAVAILABLE"
    );

    const third = await runtime.observe(session.sessionId, false);
    await assert.rejects(
      runtime.performAction(session.sessionId, third.snapshotId, action),
      (error: unknown) =>
        error instanceof GuiAutomationError
        && error.code === "PROVIDER_UNAVAILABLE"
        && /连续超时两次/.test(error.message)
    );
    assert.equal(calls, 2);

    const events = await fs.readFile(path.join(session.artifactDir, "streams", "events.jsonl"), "utf8");
    assert.equal(events.split(/\r?\n/).filter((line) => line.includes('"action.failed"')).length, 2);
  } finally {
    mock.perform = originalPerform as NativeProvider["perform"];
    await runtime.stopSession(session.sessionId, "test-complete").catch(() => undefined);
  }
});
