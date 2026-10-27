import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runAgentForSession } from "../../server/src/agent.js";
import type { AgentSession } from "../../server/src/types.js";

test("启动前已中止的 Agent 不准备 workspace 或调用模型", async () => {
  const workspacePath = path.join(os.tmpdir(), `uiwarden-abort-${Date.now()}`, "workspace");
  const controller = new AbortController();
  controller.abort();
  const session: AgentSession = {
    id: "early-abort-session",
    title: "early abort",
    status: "idle",
    browserKernel: "playwright",
    workspacePath,
    files: [],
    messages: [],
    artifacts: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  const result = await runAgentForSession({
    session,
    userText: "不会执行",
    abortSignal: controller.signal,
    purpose: "operation"
  });

  assert.equal(result.assistantText, "任务已被中止");
  await assert.rejects(fs.access(workspacePath));
});
