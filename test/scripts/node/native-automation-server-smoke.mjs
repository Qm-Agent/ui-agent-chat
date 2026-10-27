import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const repoRoot = path.resolve(import.meta.dirname, "../../..");
const serverEntry = path.join(repoRoot, "dist", "server", "index.js");
const computerBinary = path.join(repoRoot, "native-automation", process.platform === "win32" ? "dt-gui-computer.cmd" : "dt-gui-computer");
const macProvider = path.join(
  repoRoot,
  "native-automation",
  "target",
  "native-provider",
  "dt-gui-computer Provider.app"
);

async function startServer({ port, desktop }) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `dt-gui-computer-server-${desktop ? "desktop" : "web"}-`));
  const database = path.join(root, "ui-agent-chat.db");
  const child = spawn(process.execPath, [serverEntry], {
    cwd: repoRoot,
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(port),
      UI_AGENT_DESKTOP: desktop ? "true" : "false",
      UI_AGENT_DATA_DIR: root,
      UI_AGENT_DB_MODE: "sqlite",
      UI_AGENT_DB_FILE: database,

      UI_AGENT_DISABLE_BACKGROUND_TASKS: "true",
      DT_GUI_COMPUTER_BIN: computerBinary,
      DT_GUI_COMPUTER_HOME: path.join(root, "native-automation"),
      DT_GUI_COMPUTER_MACOS_PROVIDER: macProvider
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let logs = "";
  child.stdout.on("data", (chunk) => { logs += chunk; });
  child.stderr.on("data", (chunk) => { logs += chunk; });
  const baseUrl = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (child.exitCode != null) throw new Error(`server exited ${child.exitCode}\n${logs}`);
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) return { child, root, baseUrl, logs: () => logs };
    } catch {
      // wait for startup
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  child.kill("SIGTERM");
  throw new Error(`server startup timeout\n${logs}`);
}

async function stopServer(server) {
  server.child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => server.child.once("exit", resolve)),
    new Promise((resolve) => setTimeout(resolve, 3_000))
  ]);
  await fs.rm(server.root, { recursive: true, force: true });
}

let mcpShutdownProbe;
const web = await startServer({ port: 47921, desktop: false });
try {
  const defaultTransportResponse = await fetch(`${web.baseUrl}/api/gui-runtime-settings`);
  assert.equal(defaultTransportResponse.status, 200);
  const defaultTransport = await defaultTransportResponse.json();
  assert.equal(defaultTransport.cliCompatibilityMode, true);
  assert.equal(defaultTransport.transport.activeTransport, "cli");

  const mcpTransportResponse = await fetch(`${web.baseUrl}/api/gui-runtime-settings`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cliCompatibilityMode: false })
  });
  const mcpTransportText = await mcpTransportResponse.text();
  assert.equal(mcpTransportResponse.status, 200, mcpTransportText);
  const mcpTransport = JSON.parse(mcpTransportText);
  assert.equal(mcpTransport.cliCompatibilityMode, false);
  assert.equal(mcpTransport.transport.activeTransport, "mcp");
  assert.equal(mcpTransport.transport.mcp.state, "ready");

  const status = await fetch(`${web.baseUrl}/api/native-automation/status`);
  assert.equal(status.status, 200, web.logs());
  assert.equal((await status.json()).protocolVersion, 1);
  const apps = await fetch(`${web.baseUrl}/api/native-automation/apps?provider=mock`);
  assert.equal(apps.status, 200);
  assert.equal((await apps.json())[0].id, "mock.demo");
  const nativeTask = await fetch(`${web.baseUrl}/api/ui-operations`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      instruction: "读取窗口",
      executionTarget: {
        kind: "native-app",
        providerId: "mock"
      }
    })
  });
  const nativeTaskText = await nativeTask.text();
  assert.equal(nativeTask.status, 201, nativeTaskText);
  assert.equal(JSON.parse(nativeTaskText).executionTarget.kind, "native-app");

  const skillEnv = await fetch(`${web.baseUrl}/api/skill-env`);
  assert.equal(skillEnv.status, 200);
  assert.equal(Array.isArray((await skillEnv.json()).entries), true);
  const browserProfiles = await fetch(`${web.baseUrl}/api/browser-profiles`);
  assert.equal(browserProfiles.status, 200);
  assert.equal(Array.isArray((await browserProfiles.json()).profiles), true);

  const cliTransportResponse = await fetch(`${web.baseUrl}/api/gui-runtime-settings`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cliCompatibilityMode: true })
  });
  assert.equal(cliTransportResponse.status, 200);
  const cliTransport = await cliTransportResponse.json();
  assert.equal(cliTransport.transport.activeTransport, "cli");
  assert.equal(cliTransport.transport.mcp.state, "stopped");

  const restartMcpResponse = await fetch(`${web.baseUrl}/api/gui-runtime-settings`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cliCompatibilityMode: false })
  });
  const restartMcpText = await restartMcpResponse.text();
  assert.equal(restartMcpResponse.status, 200, restartMcpText);
  const restartedMcp = JSON.parse(restartMcpText);
  assert.equal(restartedMcp.transport.mcp.state, "ready");
  mcpShutdownProbe = {
    pid: restartedMcp.transport.mcp.pid,
    endpoint: restartedMcp.transport.mcp.endpoint
  };
} finally {
  await stopServer(web);
}
assert.equal(await waitForProcessExit(mcpShutdownProbe?.pid), true, "MCP daemon did not exit with its parent server");
if (process.platform !== "win32" && mcpShutdownProbe?.endpoint) {
  await assert.rejects(fs.access(mcpShutdownProbe.endpoint));
}

const desktop = await startServer({ port: 47922, desktop: true });
try {
  const statusResponse = await fetch(`${desktop.baseUrl}/api/native-automation/status`);
  assert.equal(statusResponse.status, 200, desktop.logs());
  const status = await statusResponse.json();
  assert.equal(status.protocolVersion, 1);
  assert.equal("home" in status, false);
  assert.equal(status.providers.some((provider) => provider.providerId === "mock" && provider.status === "ok"), true);
  assert.equal(status.providers.some((provider) => provider.providerId === "macos-accessibility" && provider.status === "ok"), true);

  const mockAppsResponse = await fetch(`${desktop.baseUrl}/api/native-automation/apps?provider=mock`);
  assert.equal(mockAppsResponse.status, 200);
  assert.equal((await mockAppsResponse.json())[0].id, "mock.demo");

  const macAppsResponse = await fetch(`${desktop.baseUrl}/api/native-automation/apps?provider=macos-accessibility`);
  const macAppsText = await macAppsResponse.text();
  assert.equal(macAppsResponse.status, 200, macAppsText);
  const macApps = JSON.parse(macAppsText);
  assert.equal(macApps.length > 0, true);

  const invalid = await fetch(`${desktop.baseUrl}/api/native-automation/apps?provider=arbitrary-shell`);
  assert.equal(invalid.status, 400);

  const createTaskResponse = await fetch(`${desktop.baseUrl}/api/ui-operations`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: "Mock 原生操作",
      instruction: "读取窗口标题",
      executionTarget: {
        kind: "native-app",
        providerId: "mock"
      }
    })
  });
  const createdTaskText = await createTaskResponse.text();
  assert.equal(createTaskResponse.status, 201, createdTaskText);
  const createdTask = JSON.parse(createdTaskText);
  assert.equal(createdTask.executionTarget.kind, "native-app");
  assert.deepEqual(createdTask.executionTarget.app, { kind: "name", value: "__agent_select__" });
  assert.equal(createdTask.executionTarget.displayName, "Agent 自动选择");
  assert.equal(createdTask.approvalMode, "none");
  assert.equal(createdTask.targetUrl, undefined);

  const tasksResponse = await fetch(`${desktop.baseUrl}/api/ui-operations`);
  assert.equal(tasksResponse.status, 200);
  assert.equal((await tasksResponse.json())[0].executionTarget.providerId, "mock");
  console.log(`native automation server smoke: PASS macApps=${macApps.length} nativeTask=${createdTask.id}`);
} finally {
  await stopServer(desktop);
}

async function waitForProcessExit(pid) {
  if (!Number.isInteger(pid)) return false;
  const deadline = Date.now() + 4_000;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}
