import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import WebSocket from "ws";

class CdpClient {
  static async connect(url) {
    const socket = new WebSocket(url);
    await new Promise((resolve, reject) => {
      socket.addEventListener("open", resolve, { once: true });
      socket.addEventListener("error", reject, { once: true });
    });
    return new CdpClient(socket);
  }

  constructor(socket) {
    this.socket = socket;
    this.sequence = 0;
    this.pending = new Map();
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data));
      if (!message.id) return;
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result || {});
    });
  }

  send(method, params = {}) {
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  close() {
    this.socket.close();
  }
}

const options = parseArgs(process.argv.slice(2));
const discoveryPath = required(options, "discovery");
const screenshotPath = required(options, "screenshot");
const discovery = JSON.parse(await fs.readFile(discoveryPath, "utf8"));

assert.equal(discovery.protocolVersion, 1);
assert.equal(discovery.product, "gui-computer");
assert.ok(discovery.bridgeUrl);
assert.ok(discovery.bridgeToken);
assert.ok(discovery.cdpUrl);

const statusResponse = await fetch(`${discovery.bridgeUrl}/v1/browser/status`, {
  headers: { Authorization: `Bearer ${discovery.bridgeToken}` }
});
assert.equal(statusResponse.status, 200);

const targets = await (await fetch(`${discovery.cdpUrl}/json/list`)).json();
const target = targets.find((item) => String(item.url || "").endsWith("/browser.html"));
assert.ok(target?.webSocketDebuggerUrl, `browser renderer not found: ${targets.map((item) => item.url).join(", ")}`);

const cdp = await CdpClient.connect(target.webSocketDebuggerUrl);
try {
  await cdp.send("Runtime.enable");
  await cdp.send("Page.enable");
  await waitFor(cdp, `(async () => (await window.guiComputer?.getState())?.tabs?.length >= 1)()`);
  const state = await evaluate(cdp, `(async () => ({
    title: document.title,
    brand: document.querySelector(".brand strong")?.textContent?.trim(),
    hasPreloadApi: Boolean(window.guiComputer),
    browserState: await window.guiComputer?.getState()
  }))()`);
  assert.equal(state.title, "gui-computer");
  assert.equal(state.brand, "gui-computer");
  assert.equal(state.hasPreloadApi, true);
  assert.ok(state.browserState?.tabs?.length >= 1);

  const tabLifecycle = await evaluate(cdp, `(async () => {
    const before = await window.guiComputer.getState();
    const created = await window.guiComputer.createTab("about:blank");
    const added = created.tabs.find((tab) => !before.tabs.some((item) => item.id === tab.id));
    if (!added) return { before: before.tabs.length, afterCreate: created.tabs.length, afterClose: -1 };
    await window.guiComputer.activateTab(added.id);
    const closed = await window.guiComputer.closeTab(added.id);
    return { before: before.tabs.length, afterCreate: created.tabs.length, afterClose: closed.tabs.length };
  })()`);
  assert.equal(tabLifecycle.afterCreate, tabLifecycle.before + 1);
  assert.equal(tabLifecycle.afterClose, tabLifecycle.before);

  const runResponse = await fetch(`${discovery.bridgeUrl}/v1/browser/runs`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${discovery.bridgeToken}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ sessionId: "gui-computer-smoke" })
  });
  assert.equal(runResponse.status, 200);
  const run = await runResponse.json();
  assert.equal(run.kernel, "gui-computer");
  assert.equal(run.cdpUrl, discovery.cdpUrl);
  assert.match(run.cdpUrl, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.ok(run.targetId);
  const stopResponse = await fetch(`${discovery.bridgeUrl}/v1/browser/runs/${run.runId}`, {
    method: "DELETE",
    headers: {
      Authorization: `Bearer ${discovery.bridgeToken}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ reason: "smoke-complete" })
  });
  assert.equal(stopResponse.status, 200);

  const screenshot = await cdp.send("Page.captureScreenshot", { format: "png", fromSurface: true });
  await fs.mkdir(path.dirname(screenshotPath), { recursive: true });
  await fs.writeFile(screenshotPath, Buffer.from(screenshot.data, "base64"));
  console.log(`gui-computer smoke: PASS tabs=${state.browserState.tabs.length} screenshot=${screenshotPath}`);
} finally {
  cdp.close();
}

async function evaluate(cdp, expression) {
  const result = await cdp.send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true
  });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || "Runtime.evaluate failed");
  return result.result?.value;
}

async function waitFor(cdp, expression, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await evaluate(cdp, expression)) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for: ${expression}`);
}

function parseArgs(args) {
  const result = new Map();
  for (let index = 0; index < args.length; index += 2) {
    result.set(String(args[index]).replace(/^--/, ""), args[index + 1]);
  }
  return result;
}

function required(args, name) {
  const value = args.get(name);
  if (!value) throw new Error(`Missing --${name}`);
  return value;
}
