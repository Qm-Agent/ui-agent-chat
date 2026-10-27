import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { getServerManagedBrowserBridge, stopServerManagedBrowser } from "../../server/src/serverManagedBrowser.js";

test("server-managed browser exposes the embedded bridge contract", async () => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "uiwarden-server-browser-"));
  const executable = path.join(temporary, "fake-chromium");
  await fs.writeFile(executable, `#!${process.execPath}
const http = require("node:http");
const { WebSocketServer } = require(${JSON.stringify(path.resolve("node_modules/ws"))});
const portArg = process.argv.find((value) => value.startsWith("--remote-debugging-port="));
const port = Number(portArg.split("=")[1]);
let sequence = 1;
let targets = [{ id: "target-1", type: "page", title: "Blank", url: "about:blank", webSocketDebuggerUrl: "ws://127.0.0.1:" + port + "/devtools/page/target-1" }];
const server = http.createServer((request, response) => {
  const url = new URL(request.url, "http://127.0.0.1");
  response.setHeader("Content-Type", "application/json");
  if (url.pathname === "/json/version") return response.end(JSON.stringify({ webSocketDebuggerUrl: "ws://127.0.0.1:" + port + "/devtools/browser/fake" }));
  if (url.pathname === "/json/list") return response.end(JSON.stringify(targets));
  if (url.pathname === "/json/new" && request.method === "PUT") {
    const id = "target-" + (++sequence);
    const targetUrl = decodeURIComponent(url.search.slice(1)) || "about:blank";
    const target = { id, type: "page", title: targetUrl, url: targetUrl, webSocketDebuggerUrl: "ws://127.0.0.1:" + port + "/devtools/page/" + id };
    targets.push(target);
    return response.end(JSON.stringify(target));
  }
  if (url.pathname.startsWith("/json/close/")) {
    const id = url.pathname.split("/").pop();
    targets = targets.filter((target) => target.id !== id);
    return response.end(JSON.stringify(true));
  }
  response.statusCode = 404;
  response.end(JSON.stringify({ error: "not found" }));
});
const websocketServer = new WebSocketServer({ server });
websocketServer.on("connection", (socket, request) => {
  const targetId = request.url.split("/").pop();
  socket.on("message", (raw) => {
    const message = JSON.parse(String(raw));
    const target = targets.find((candidate) => candidate.id === targetId) || targets[targets.length - 1];
    if (message.method === "Page.navigate") target.url = message.params.url;
    const result = message.method === "Runtime.evaluate"
      ? { result: { value: { url: target.url, readyState: "complete" } } }
      : {};
    socket.send(JSON.stringify({ id: message.id, result }));
  });
});
server.listen(port, "127.0.0.1");
process.on("SIGTERM", () => server.close(() => process.exit(0)));
`, { mode: 0o755 });
  const previousExecutable = process.env.UIWARDEN_SERVER_BROWSER_EXECUTABLE;
  const previousDataDir = process.env.UI_AGENT_DATA_DIR;
  process.env.UIWARDEN_SERVER_BROWSER_EXECUTABLE = executable;
  process.env.UI_AGENT_DATA_DIR = path.join(temporary, "data");
  try {
    const bridge = await getServerManagedBrowserBridge();
    assert.match(bridge.url, /^http:\/\/127\.0\.0\.1:\d+$/);
    assert.match(bridge.cdpUrl, /^http:\/\/127\.0\.0\.1:\d+$/);
    const headers = { Authorization: `Bearer ${bridge.token}`, "Content-Type": "application/json" };
    const unauthorized = await fetch(`${bridge.url}/v1/browser/status`);
    assert.equal(unauthorized.status, 401);
    const status = await fetch(`${bridge.url}/v1/browser/status`, { headers });
    assert.equal(status.status, 200);
    assert.equal((await status.json()).mode, "server-managed-headless");

    const navigated = await fetchJson(`${bridge.url}/v1/browser/navigate`, headers, {
      url: "https://example.test/path"
    });
    assert.match(String(navigated.targetId), /^target-/);
    assert.equal(navigated.url, "https://example.test/path");

    const run = await fetchJson(`${bridge.url}/v1/browser/runs`, headers, { sessionId: "session-1" });
    assert.equal(run.version, 1);
    assert.equal(run.kernel, "uiwarden-embedded");
    assert.equal(run.targetId, navigated.targetId);

    const controlled = await fetchJson(`${bridge.url}/v1/browser/runs/${run.runId}/control`, headers, {
      mode: "human-control"
    });
    assert.equal(controlled.controlMode, "human-control");

    const stopped = await fetch(`${bridge.url}/v1/browser/runs/${run.runId}`, {
      method: "DELETE",
      headers,
      body: JSON.stringify({ reason: "test-complete" })
    });
    assert.equal(stopped.status, 200);
    assert.equal((await stopped.json()).stopReason, "test-complete");
  } finally {
    await stopServerManagedBrowser();
    if (previousExecutable == null) delete process.env.UIWARDEN_SERVER_BROWSER_EXECUTABLE;
    else process.env.UIWARDEN_SERVER_BROWSER_EXECUTABLE = previousExecutable;
    if (previousDataDir == null) delete process.env.UI_AGENT_DATA_DIR;
    else process.env.UI_AGENT_DATA_DIR = previousDataDir;
    await fs.rm(temporary, { recursive: true, force: true });
  }
});

async function fetchJson(
  url: string,
  headers: Record<string, string>,
  body: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const response = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
  assert.equal(response.status, 200, await response.clone().text());
  return response.json() as Promise<Record<string, unknown>>;
}
