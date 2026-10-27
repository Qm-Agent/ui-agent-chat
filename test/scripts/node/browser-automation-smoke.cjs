const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const http = require("node:http");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { execFile, spawn } = require("node:child_process");
const { promisify } = require("node:util");
const { app, BrowserWindow } = require("electron");

const execFileAsync = promisify(execFile);
const cdpPort = 42000 + Math.floor(Math.random() * 4000);
app.commandLine.appendSwitch("remote-debugging-address", "127.0.0.1");
app.commandLine.appendSwitch("remote-debugging-port", String(cdpPort));
app.commandLine.appendSwitch("remote-allow-origins", "*");

const repoRoot = path.resolve(__dirname, "../../..");
const cliPath = path.join(repoRoot, "browser-automation", "cli.mjs");

async function main() {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "dt-gui-browser-smoke-"));
  process.env.DT_GUI_BROWSER_HOME = path.join(temporary, "runtime");
  const server = http.createServer((request, response) => {
    response.setHeader("Content-Type", "text/html; charset=utf-8");
    if (request.url === "/frame") {
      response.end("<!doctype html><label>Frame value<input id='frame-input'></label><button onclick=\"parent.document.querySelector('#status').textContent='frame:'+event.isTrusted+':'+document.querySelector('#frame-input').value\">Frame apply</button>");
      return;
    }
    if (request.url === "/secondary") {
      response.end("<!doctype html><title>UIWarden shell</title><button>Do not control</button>");
      return;
    }
    if (request.url === "/popup") {
      response.end("<!doctype html><title>Authorized child target</title><p>child-ready</p>");
      return;
    }
    response.end(`<!doctype html>
      <title>Atomic browser smoke</title>
      <style>body{font-family:sans-serif;min-height:1800px}button,input,select{margin:8px;padding:8px}</style>
      <label for="name">Name</label><input id="name" value="">
      <label for="secret">Password</label><input id="secret" type="password" value="do-not-read">
      <label for="choice">Choice</label><select id="choice"><option value="a">Alpha</option><option value="b">Beta</option></select>
      <button id="apply" onclick="document.querySelector('#status').textContent='applied:'+event.isTrusted+':'+document.querySelector('#name').value">Apply</button>
      <button id="open-child" onclick="window.open('/popup','_blank')">Open child target</button>
      <div id="drag-source" draggable="true">Drag smoke item</div>
      <div id="drop-target" dropzone="move">Drop smoke target</div>
      <p id="status">idle</p>
      <iframe src="/frame" title="same-origin frame"></iframe>
      <div id="shadow-host"></div>
      <script>
        document.querySelector('#drag-source').addEventListener('dragstart', event => event.dataTransfer.setData('text/plain', 'smoke-item'));
        document.querySelector('#drop-target').addEventListener('dragover', event => event.preventDefault());
        document.querySelector('#drop-target').addEventListener('drop', event => {
          event.preventDefault();
          document.querySelector('#status').textContent = 'dragged:' + event.dataTransfer.getData('text/plain');
        });
        const root = document.querySelector('#shadow-host').attachShadow({mode:'open'});
        root.innerHTML = '<button id="shadow-button">Shadow action</button>';
        root.querySelector('button').onclick = () => document.querySelector('#status').textContent = 'shadow-clicked';
      </script>`);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const targetUrl = `http://127.0.0.1:${port}/`;
  const secondaryUrl = `http://127.0.0.1:${port}/secondary`;
  const targetWindow = new BrowserWindow({ show: false, width: 1000, height: 760, webPreferences: { sandbox: true } });
  const secondaryWindow = new BrowserWindow({ show: false, width: 600, height: 400, webPreferences: { sandbox: true } });
  const popupWindows = [];
  targetWindow.webContents.setWindowOpenHandler(() => ({
    action: "allow",
    overrideBrowserWindowOptions: { show: false, width: 500, height: 320 }
  }));
  app.on("browser-window-created", (_event, createdWindow) => {
    if (createdWindow !== targetWindow && createdWindow !== secondaryWindow) popupWindows.push(createdWindow);
  });
  try {
    await Promise.all([targetWindow.loadURL(targetUrl), secondaryWindow.loadURL(secondaryUrl)]);
    const unknownOption = await runCli(["doctor", "--unknown", "value", "--json"], false);
    assert.equal(unknownOption.error.code, "INVALID_ARGUMENT");
    const targets = await waitForTargets();
    const target = targets.find((item) => item.type === "page" && item.url === targetUrl);
    const secondary = targets.find((item) => item.type === "page" && item.url === secondaryUrl);
    assert.ok(target?.id, "primary target must be discoverable");
    assert.ok(secondary?.id, "secondary target must be discoverable");

    const started = await runCli([
      "session", "start", "--cdp-url", `http://127.0.0.1:${cdpPort}`,
      "--target", target.id, "--artifact-root", path.join(temporary, "artifacts"), "--run-id", "smoke-run", "--json"
    ]);
    const sessionId = started.data.sessionId;
    assert.match(sessionId, /^browser-/);

    const busy = await runCli([
      "session", "start", "--cdp-url", `http://127.0.0.1:${cdpPort}`,
      "--target", target.id, "--artifact-root", path.join(temporary, "artifacts"), "--json"
    ], false);
    assert.equal(busy.error.code, "TARGET_BUSY");

    const tabs = await runCli(["tabs", "list", "--session", sessionId, "--json"]);
    assert.equal(tabs.data.tabs.length, 1);
    assert.equal(tabs.data.tabs[0].targetId, target.id);
    assert.ok(!tabs.data.tabs.some((item) => item.targetId === secondary.id));

    let snapshot = (await runCli(["observe", "--session", sessionId, "--json"])).data;
    const openChild = findElement(snapshot, "Open child target", "button");
    await runCli([
      "click", "--session", sessionId, "--snapshot", snapshot.snapshotId,
      "--element", openChild.elementId, "--json"
    ]);
    const popupUrl = `http://127.0.0.1:${port}/popup`;
    const popup = await waitForTarget(popupUrl);
    const tabsWithChild = await runCli(["tabs", "list", "--session", sessionId, "--json"]);
    assert.equal(tabsWithChild.data.tabs.length, 2);
    assert.ok(!tabsWithChild.data.tabs.some((item) => item.targetId === secondary.id));
    const childTab = tabsWithChild.data.tabs.find((item) => item.targetId === popup.id);
    assert.equal(childTab?.openerTargetId, target.id);
    assert.equal(childTab?.discovered, true);
    await runCli(["tabs", "activate", "--session", sessionId, "--target", popup.id, "--json"]);
    const childSnapshot = await runCli(["observe", "--session", sessionId, "--json"]);
    assert.equal(childSnapshot.data.title, "Authorized child target");
    await runCli(["tabs", "activate", "--session", sessionId, "--target", target.id, "--json"]);
    snapshot = (await runCli(["observe", "--session", sessionId, "--json"])).data;
    const nameInput = findElement(snapshot, "Name", "input");
    const passwordInput = findElement(snapshot, "Password", "input");
    assert.equal(passwordInput.secure, true);
    assert.equal(passwordInput.value, "[REDACTED]");
    const handoff = await runCli([
      "set-value", "--session", sessionId, "--snapshot", snapshot.snapshotId,
      "--element", passwordInput.elementId, "--value", "secret", "--json"
    ], false);
    assert.equal(handoff.error.code, "HANDOFF_REQUIRED");

    await runCli([
      "set-value", "--session", sessionId, "--snapshot", snapshot.snapshotId,
      "--element", nameInput.elementId, "--value=--Ada", "--json"
    ]);
    const stale = await runCli([
      "click", "--session", sessionId, "--snapshot", snapshot.snapshotId,
      "--element", nameInput.elementId, "--json"
    ], false);
    assert.equal(stale.error.code, "STALE_SNAPSHOT");

    snapshot = (await runCli(["observe", "--session", sessionId, "--json"])).data;
    assert.equal(findElement(snapshot, "Name", "input").value, "--Ada");
    await runCli([
      "set-value", "--session", sessionId, "--snapshot", snapshot.snapshotId,
      "--element", findElement(snapshot, "Name", "input").elementId, "--value", "Ada", "--json"
    ]);
    snapshot = (await runCli(["observe", "--session", sessionId, "--json"])).data;
    assert.equal(findElement(snapshot, "Name", "input").value, "Ada");
    const apply = findElement(snapshot, "Apply", "button");
    await runCli(["click", "--session", sessionId, "--snapshot", snapshot.snapshotId, "--element", apply.elementId, "--json"]);
    snapshot = (await runCli(["observe", "--session", sessionId, "--json"])).data;
    assert.match(snapshot.text, /applied:true:Ada/);

    const choice = findElement(snapshot, "Choice", "select");
    await runCli([
      "select-option", "--session", sessionId, "--snapshot", snapshot.snapshotId,
      "--element", choice.elementId, "--value", "Beta", "--json"
    ]);
    snapshot = (await runCli(["observe", "--session", sessionId, "--json"])).data;
    assert.equal(findElement(snapshot, "Choice", "select").value, "b");

    const frameInput = findElement(snapshot, "Frame value", "input");
    await runCli([
      "set-value", "--session", sessionId, "--snapshot", snapshot.snapshotId,
      "--element", frameInput.elementId, "--value", "inside-frame", "--json"
    ]);
    snapshot = (await runCli(["observe", "--session", sessionId, "--json"])).data;
    assert.equal(findElement(snapshot, "Frame value", "input").value, "inside-frame");

    const frameButton = findElement(snapshot, "Frame apply", "button");
    await runCli([
      "click", "--session", sessionId, "--snapshot", snapshot.snapshotId,
      "--element", frameButton.elementId, "--json"
    ]);
    snapshot = (await runCli(["observe", "--session", sessionId, "--json"])).data;
    assert.match(snapshot.text, /frame:true:inside-frame/);

    const shadowButton = findElement(snapshot, "Shadow action", "button");
    await runCli([
      "click", "--session", sessionId, "--snapshot", snapshot.snapshotId,
      "--element", shadowButton.elementId, "--json"
    ]);
    snapshot = (await runCli(["observe", "--session", sessionId, "--json"])).data;
    assert.match(snapshot.text, /shadow-clicked/);

    const dragSource = findElement(snapshot, "Drag smoke item", "div");
    const dropTarget = findElement(snapshot, "Drop smoke target", "div");
    await runCli([
      "drag", "--session", sessionId, "--snapshot", snapshot.snapshotId,
      "--source", dragSource.elementId, "--target", dropTarget.elementId, "--json"
    ]);
    snapshot = (await runCli(["observe", "--session", sessionId, "--json"])).data;
    assert.match(snapshot.text, /dragged:smoke-item/);

    await runCli(["scroll", "--session", sessionId, "--direction", "down", "--pages", "1", "--json"]);
    const shot = await runCli(["screenshot", "--session", sessionId, "--json"]);
    assert.ok((await fs.stat(shot.data.screenshotPath)).size > 1000);

    const tools = await listMcpTools(sessionId);
    const toolNames = tools.map((item) => item.name);
    assert.ok(toolNames.includes("observe") && toolNames.includes("click"));
    for (const name of ["drag", "upload_file"]) assert.ok(toolNames.includes(name));
    const clickTool = tools.find((item) => item.name === "click");
    assert.deepEqual(clickTool.inputSchema.properties.dialogAction.enum, ["accept", "dismiss"]);
    assert.ok(!toolNames.some((name) => /task|query|assert|test|quick/i.test(name)));

    const stopped = await runCli(["session", "stop", "--session", sessionId, "--reason", "smoke-complete", "--json"]);
    assert.equal(stopped.data.state, "stopped");
    const manifest = JSON.parse(await fs.readFile(path.join(stopped.data.artifactDir, "manifest.json"), "utf8"));
    assert.equal(manifest.artifactKind, "browser-rep");
    assert.ok(manifest.snapshotCount >= 6);
    assert.ok(manifest.actionCount >= 8);
    assert.ok(manifest.screenshotCount >= manifest.snapshotCount);
    assert.equal(manifest.targetCount, 2);
    for (const schemaName of ["protocol", "session", "snapshot", "action", "manifest", "error"]) {
      await fs.access(path.join(stopped.data.artifactDir, "schemas", `${schemaName}.schema.json`));
    }
    const manifestSchema = JSON.parse(await fs.readFile(path.join(stopped.data.artifactDir, "manifest.schema.json"), "utf8"));
    assert.equal(manifestSchema.$id, "https://dt-gui-agent.local/schemas/browser/manifest.schema.json");

    const selectable = await runCli([
      "session", "start", "--cdp-url", `http://127.0.0.1:${cdpPort}`,
      "--target", target.id, "--artifact-root", path.join(temporary, "artifacts"),
      "--run-id", "selectable-tabs", "--allow-target-selection", "--json"
    ]);
    const selectableId = selectable.data.sessionId;
    const selectableTabs = await runCli(["tabs", "list", "--session", selectableId, "--json"]);
    assert.ok(selectableTabs.data.tabs.length >= 2);
    assert.ok(selectableTabs.data.tabs.some((item) => item.targetId === target.id));
    assert.ok(selectableTabs.data.tabs.some((item) => item.targetId === secondary.id));
    assert.match(selectableTabs.data.targetPolicy, /Agent may select/);
    const activated = await runCli([
      "tabs", "activate", "--session", selectableId, "--target", secondary.id, "--json"
    ]);
    assert.equal(activated.data.activeTargetId, secondary.id);
    const secondarySnapshot = await runCli(["observe", "--session", selectableId, "--json"]);
    assert.equal(secondarySnapshot.data.title, "UIWarden shell");
    await runCli(["session", "stop", "--session", selectableId, "--reason", "tab-selection-verified", "--json"]);

    const persistent = await verifyPersistentMcp(target.id, temporary);
    const serverPersistent = await verifyServerPersistentMcp(target.id, temporary);
    process.stdout.write(`${JSON.stringify({
      ok: true,
      sessionId,
      artifactDir: stopped.data.artifactDir,
      toolNames,
      persistent,
      serverPersistent
    })}\n`);
  } finally {
    for (const popupWindow of popupWindows) {
      if (!popupWindow.isDestroyed()) popupWindow.destroy();
    }
    targetWindow.destroy();
    secondaryWindow.destroy();
    await new Promise((resolve) => server.close(resolve));
    await app.quit();
  }
}

async function verifyServerPersistentMcp(targetId, temporary) {
  const node = process.env.npm_node_execpath || "node";
  const tsxCli = path.join(repoRoot, "node_modules", "tsx", "dist", "cli.mjs");
  const helper = path.join(repoRoot, "test", "scripts", "node", "browser-automation-server-mcp-smoke.ts");
  const workspace = path.join(temporary, "server-mcp");
  await fs.mkdir(workspace, { recursive: true });
  const result = await execFileAsync(node, [
    tsxCli,
    helper,
    `http://127.0.0.1:${cdpPort}`,
    targetId,
    workspace
  ], {
    encoding: "utf8",
    timeout: 60_000,
    maxBuffer: 10 * 1024 * 1024,
    env: {
      ...process.env,
      UI_AGENT_DATA_DIR: path.join(temporary, "server-data"),
      DT_GUI_BROWSER_HOME: path.join(temporary, "server-runtime")
    }
  });
  const output = result.stdout.trim().split("\n").filter(Boolean).at(-1);
  const parsed = JSON.parse(output);
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.screenshotSequences, [1, 2, 3]);
  return parsed;
}

async function verifyPersistentMcp(targetId, temporary) {
  const started = await runCli([
    "session", "start", "--cdp-url", `http://127.0.0.1:${cdpPort}`,
    "--target", targetId, "--artifact-root", path.join(temporary, "artifacts"),
    "--run-id", "persistent-mcp", "--json"
  ]);
  const sessionId = started.data.sessionId;
  const endpoint = path.join(temporary, `${sessionId}.sock`);
  const daemon = spawn(process.execPath, [
    cliPath, "mcp", "--session", sessionId, "--socket", endpoint
  ], {
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: "1",
      DT_GUI_BROWSER_PARENT_PID: String(process.pid)
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stderr = "";
  daemon.stderr.setEncoding("utf8");
  daemon.stderr.on("data", (chunk) => {
    stderr += String(chunk);
  });
  try {
    await waitForSocket(endpoint, daemon, () => stderr);
    const first = await callCompatibility(endpoint, ["observe", "--diff", "--json"]);
    assert.equal(first.projection, "full");
    assert.equal(first.baseline, true);
    assert.equal(first.transport.reused, false);
    const connectionId = first.transport.connectionId;
    const name = findElement(first, "Name", "input");

    await callCompatibility(endpoint, [
      "set-value", "--snapshot", first.snapshotId,
      "--element", name.elementId, "--value", "Persistent Ada", "--json"
    ]);
    const second = await callCompatibility(endpoint, ["observe", "--diff", "--json"]);
    assert.equal(second.projection, "diff");
    assert.equal(second.transport.connectionId, connectionId);
    assert.equal(second.transport.reused, true);
    assert.equal(findElement(second, "Name", "input").value, "Persistent Ada");
    assert.ok(!second.elements.some((element) => element.name.includes("Password")));
    assert.ok(second.screenshotSequence > first.screenshotSequence);
    assert.notEqual(second.screenshotSha256, first.screenshotSha256);

    const shot = await callCompatibility(endpoint, ["screenshot", "--json"]);
    assert.equal(shot.transport.connectionId, connectionId);
    assert.equal(shot.transport.reused, true);
    assert.ok(shot.screenshotSequence > second.screenshotSequence);
    assert.ok((await fs.stat(shot.screenshotPath)).size > 1000);

    const stopped = await callCompatibility(endpoint, [
      "session", "stop", "--reason", "persistent-mcp-verified", "--json"
    ]);
    assert.equal(stopped.state, "stopped");
    const events = (await fs.readFile(
      path.join(stopped.artifactDir, "streams", "events.jsonl"),
      "utf8"
    )).trim().split("\n").map((line) => JSON.parse(line));
    const connectionIds = new Set(events
      .map((event) => event.cdpConnectionId)
      .filter(Boolean));
    assert.deepEqual([...connectionIds], [connectionId]);
    return {
      sessionId,
      connectionId,
      snapshotSequences: [first.sequence, second.sequence],
      screenshotSequences: [first.screenshotSequence, second.screenshotSequence, shot.screenshotSequence],
      changedElementCount: second.elements.length
    };
  } finally {
    daemon.kill("SIGTERM");
    await Promise.race([
      new Promise((resolve) => daemon.once("exit", resolve)),
      new Promise((resolve) => setTimeout(resolve, 2_000))
    ]);
    if (daemon.exitCode == null) daemon.kill("SIGKILL");
  }
}

async function waitForSocket(endpoint, child, stderr) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (child.exitCode != null) throw new Error(`browser MCP exited: ${stderr()}`);
    try {
      await callJsonRpc(endpoint, "ping", {});
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
  }
  throw new Error(`browser MCP socket was not ready: ${stderr()}`);
}

async function callJsonRpc(endpoint, method, params) {
  return socketRequest(endpoint, `${JSON.stringify({
    jsonrpc: "2.0",
    id: `${process.pid}-${Date.now()}`,
    method,
    params
  })}\n`);
}

async function callCompatibility(endpoint, args) {
  const envelope = await socketRequest(endpoint, Buffer.concat([
    Buffer.from("UIWARDEN_CLI_V1\0"),
    ...args.map((arg) => Buffer.from(`${arg}\0`)),
    Buffer.from("\0")
  ]));
  assert.equal(envelope.ok, true, JSON.stringify(envelope));
  return envelope.data;
}

async function socketRequest(endpoint, payload) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(endpoint);
    let buffer = "";
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("socket request timeout"));
    }, 10_000);
    socket.setEncoding("utf8");
    socket.once("error", reject);
    socket.on("data", (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      clearTimeout(timer);
      socket.destroy();
      resolve(JSON.parse(buffer.slice(0, newline)));
    });
    socket.once("connect", () => socket.write(payload));
  });
}

async function runCli(args, expectSuccess = true) {
  let stdout = "";
  try {
    const result = await execFileAsync(process.execPath, [cliPath, ...args], {
      encoding: "utf8",
      timeout: 30_000,
      maxBuffer: 10 * 1024 * 1024,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }
    });
    stdout = result.stdout;
  } catch (error) {
    stdout = String(error.stdout || "");
    if (!stdout.trim()) throw error;
  }
  const envelope = JSON.parse(stdout.trim());
  assert.equal(envelope.ok, expectSuccess, JSON.stringify(envelope));
  return envelope;
}

async function waitForTargets() {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${cdpPort}/json/list`);
      if (response.ok) return response.json();
    } catch {
      // Chromium remote debugging starts shortly after app ready.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("CDP targets were not available");
}

async function waitForTarget(url) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const targets = await waitForTargets();
    const target = targets.find((item) => item.type === "page" && item.url === url);
    if (target) return target;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`CDP target was not available: ${url}`);
}

function findElement(snapshot, name, tag) {
  const element = snapshot.elements.find((item) => item.name.includes(name) && item.tag === tag);
  assert.ok(element, `element not found: ${name} (${tag})`);
  return element;
}

async function listMcpTools(sessionId) {
  const child = spawn(process.execPath, [cliPath, "mcp", "--session", sessionId], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    stdio: ["pipe", "pipe", "pipe"]
  });
  let buffer = "";
  const responses = new Map();
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";
    for (const line of lines) {
      if (!line.trim()) continue;
      const message = JSON.parse(line);
      responses.set(message.id, message);
    }
  });
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })}\n`);
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} })}\n`);
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} })}\n`);
  const deadline = Date.now() + 10_000;
  while (!responses.has(2) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
  child.stdin.end();
  await new Promise((resolve) => child.once("exit", resolve));
  assert.equal(responses.get(1)?.result?.capabilities?.tools?.listChanged, false);
  const response = responses.get(2);
  assert.ok(response?.result?.tools, "MCP tools/list response missing");
  return response.result.tools;
}

app.whenReady().then(main).catch((error) => {
  console.error(error);
  process.exitCode = 1;
  app.quit();
});
