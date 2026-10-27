import assert from "node:assert/strict";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const repoRoot = path.resolve(import.meta.dirname, "../../..");
const serverEntry = path.join(repoRoot, "dist", "server", "index.js");
const sourceBinary = path.join(repoRoot, "native-automation", process.platform === "win32" ? "dt-gui-computer.cmd" : "dt-gui-computer");
const macProvider = path.join(
  repoRoot,
  "native-automation",
  "target",
  "native-provider",
  "dt-gui-computer Provider.app"
);
const root = await fs.mkdtemp(path.join(os.tmpdir(), "dt-gui-computer-agent-"));
const spacedRuntimeDir = path.join(root, "UIWarden Runtime", "bin");
const spacedBinary = path.join(spacedRuntimeDir, "dt-gui-computer");
const port = await availablePort();
const baseUrl = `http://127.0.0.1:${port}`;
let logs = "";
let server;

try {
  await fs.mkdir(spacedRuntimeDir, { recursive: true });
  await fs.symlink(sourceBinary, spacedBinary);
  const database = path.join(root, "ui-agent-chat.db");
  server = spawn(process.execPath, ["--env-file", path.join(repoRoot, ".env"), serverEntry], {
    cwd: repoRoot,
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(port),
      UI_AGENT_DESKTOP: "true",
      UI_AGENT_DATA_DIR: root,
      UI_AGENT_DB_MODE: "sqlite",
      UI_AGENT_DB_FILE: database,

      UI_AGENT_DISABLE_BACKGROUND_TASKS: "true",
      DT_GUI_COMPUTER_BIN: spacedBinary,
      DT_GUI_COMPUTER_HOME: path.join(root, "native-automation"),
      DT_GUI_COMPUTER_MACOS_PROVIDER: macProvider
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  server.stdout.on("data", (chunk) => { logs += String(chunk); });
  server.stderr.on("data", (chunk) => { logs += String(chunk); });
  await waitForServer();
  if (process.env.GUI_RUNTIME_MODE === "mcp") {
    const transportResponse = await fetch(`${baseUrl}/api/gui-runtime-settings`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cliCompatibilityMode: false })
    });
    const transportText = await transportResponse.text();
    assert.equal(transportResponse.status, 200, transportText);
    const transport = JSON.parse(transportText);
    assert.equal(transport.transport.activeTransport, "mcp");
    assert.equal(transport.transport.mcp.state, "ready");
  }

  const payloads = await sendOperation({
    message: "打开计算器，计算1+100等于多少",
    executionTarget: {
      kind: "native-app",
      providerId: "macos-accessibility",
      app: { kind: "name", value: "__agent_select__" },
      displayName: "Agent 自动选择"
    },
    approvalMode: "manual-finalize"
  });
  const route = routeFrom(payloads);
  assertToolChain(payloads);

  const tasks = await fetchJson(`${baseUrl}/api/ui-operations`);
  const task = tasks.find((item) => item.id === route.operationTaskId);
  assert.ok(task, `operation task not found: ${route.operationTaskId}`);
  const run = task.runs.find((item) => item.id === route.operationRunId);
  assert.ok(run, `operation run not found: ${route.operationRunId}`);
  assert.equal(run.status, "completed", JSON.stringify(run));
  assert.ok(run.nativeArtifactDir, JSON.stringify(run));

  const agentSession = await fetchJson(`${baseUrl}/api/sessions/${encodeURIComponent(route.sessionId)}`);
  assert.notEqual(agentSession.status, "failed", agentSession.lastError || JSON.stringify(agentSession));
  assert.ok(agentSession.sdkSessionId, "Agent SDK session ID was not persisted");
  await fs.access(path.join(agentSession.workspacePath, ".claude", "skills", "dt-gui-computer-skill", "SKILL.md"));

  const manifest = JSON.parse(await fs.readFile(path.join(run.nativeArtifactDir, "manifest.json"), "utf8"));
  const actionText = await fs.readFile(path.join(run.nativeArtifactDir, "streams", "actions.jsonl"), "utf8");
  const actions = actionText.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
  const targetNames = actions.map((action) => String(action.targetName || ""));
  const expectedLedger = ["1", "加", "1", "0", "0", "等于"];
  assert.deepEqual(orderedMatches(targetNames, expectedLedger), expectedLedger, JSON.stringify(targetNames));
  assert.equal(manifest.artifactKind, "native-rep");
  assert.equal(manifest.stopReason, "completed");
  assert.ok(manifest.snapshotCount >= expectedLedger.length, JSON.stringify(manifest));
  assert.ok(manifest.actionCount >= expectedLedger.length, JSON.stringify(manifest));
  await fs.access(path.join(run.nativeArtifactDir, "snapshots", "latest.json"));
  await fs.access(path.join(run.nativeArtifactDir, "schemas", "snapshot.schema.json"));

  const transcript = payloads.map((payload) => JSON.stringify(payload)).join("\n");
  const diagnosticText = `${transcript}\n${logs}`;
  const executedCommands = payloads
    .filter((payload) => payload.type === "tool" && payload.data?.phase === "start")
    .map((payload) => String(payload.data?.item?.command || ""))
    .join("\n");
  assert.doesNotMatch(diagnosticText, /目标应用不存在|TARGET_NOT_FOUND|command is not allowed|不允许调用该命令|受控 Bash 原子命令/i);
  assert.doesNotMatch(executedCommands, /ui-test-assistant-skill|run_quick_mode|browser-use|playwright/i);

  const listedSessions = await fetchJson(`${baseUrl}/api/sessions`);
  assert.equal(
    listedSessions.some((item) => item.id === route.sessionId),
    false,
    "UI 操作 Agent 会话不应混入测试任务列表"
  );

  console.log(JSON.stringify({
    ok: true,
    operationTaskId: route.operationTaskId,
    operationRunId: route.operationRunId,
    sessionId: route.sessionId,
    sdkSessionId: agentSession.sdkSessionId,
    cliPathContainsSpaces: spacedBinary.includes(" "),
    application: manifest.app,
    actionLedger: targetNames,
    snapshotCount: manifest.snapshotCount,
    actionCount: manifest.actionCount,
    captureGaps: manifest.captureGaps,
    transport: process.env.GUI_RUNTIME_MODE === "mcp" ? "mcp" : "cli"
  }));
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n--- server log ---\n${logs.slice(-30_000)}\n`);
  process.exitCode = 1;
} finally {
  if (server) await stopProcess(server);
  if (!process.env.KEEP_SMOKE_DATA) await fs.rm(root, { recursive: true, force: true });
  else process.stderr.write(`smoke data kept at ${root}\n`);
}

async function sendOperation(body) {
  const response = await fetch(`${baseUrl}/api/ui-operations/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(8 * 60_000)
  });
  if (response.status !== 200) {
    throw new Error(`UI operation failed: HTTP ${response.status} ${await response.text()}`);
  }
  assert.ok(response.body, "UI operation stream is missing");
  return readSse(response.body);
}

function routeFrom(payloads) {
  const data = payloads.find((payload) => payload.type === "session")?.data || {};
  const operationTaskId = String(data.operationTaskId || "");
  const operationRunId = String(data.operationRunId || "");
  const sessionId = String(data.sessionId || "");
  assert.ok(operationTaskId && operationRunId && sessionId, JSON.stringify(data));
  return { operationTaskId, operationRunId, sessionId };
}

function assertToolChain(payloads) {
  const toolStarts = payloads
    .filter((payload) => payload.type === "tool" && payload.data?.phase === "start")
    .map((payload) => String(payload.data.name || ""));
  assert.ok(toolStarts.includes("Bash"), JSON.stringify(toolStarts));
  assert.ok(
    toolStarts.every((name) => name === "Skill" || name === "Bash" || name === "Read"),
    JSON.stringify(toolStarts)
  );
}

function orderedMatches(actual, expected) {
  const result = [];
  let expectedIndex = 0;
  for (const item of actual) {
    if (item === expected[expectedIndex]) {
      result.push(item);
      expectedIndex += 1;
    }
  }
  return result;
}

async function readSse(stream) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const payloads = [];
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    const blocks = buffer.split("\n\n");
    buffer = blocks.pop() || "";
    for (const block of blocks) {
      const data = block.split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n");
      if (data) payloads.push(JSON.parse(data));
    }
    if (done) break;
  }
  return payloads;
}

async function fetchJson(url) {
  const response = await fetch(url);
  const text = await response.text();
  assert.equal(response.status, 200, text);
  return JSON.parse(text);
}

async function waitForServer() {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (server.exitCode != null) throw new Error(`server exited ${server.exitCode}`);
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) return;
    } catch {
      // Server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error("server startup timeout");
}

async function availablePort() {
  const listener = net.createServer();
  await new Promise((resolve, reject) => {
    listener.once("error", reject);
    listener.listen(0, "127.0.0.1", resolve);
  });
  const address = listener.address();
  assert.ok(address && typeof address === "object");
  const selected = address.port;
  await new Promise((resolve) => listener.close(resolve));
  return selected;
}

async function stopProcess(child) {
  if (child.exitCode != null) return;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    new Promise((resolve) => setTimeout(resolve, 5_000))
  ]);
  if (child.exitCode == null) child.kill("SIGKILL");
}
