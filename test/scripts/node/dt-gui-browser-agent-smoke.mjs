import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import WebSocket from "ws";

class CdpClient {
  static async connect(url) {
    const socket = new WebSocket(url);
    await new Promise((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    });
    return new CdpClient(socket);
  }

  constructor(socket) {
    this.socket = socket;
    this.sequence = 0;
    this.pending = new Map();
    socket.on("message", (data) => {
      const message = JSON.parse(String(data));
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

const baseUrl = String(process.argv[2] || "http://127.0.0.1:47941").replace(/\/$/, "");
const targetUrl = String(process.argv[3] || "http://127.0.0.1:47943/atomic-operation.html");
const cdpUrl = String(process.argv[4] || "http://127.0.0.1:47942").replace(/\/$/, "");
const browserKernel = String(process.argv[5] || "uiwarden-embedded");
assert.ok(browserKernel === "uiwarden-embedded" || browserKernel === "gui-computer", `unsupported kernel: ${browserKernel}`);
const firstUrl = withRunQuery(targetUrl, `first-${Date.now()}`);

const firstPayloads = await sendOperation("/api/ui-operations/messages", {
  message: `打开 ${firstUrl}，在 Name 输入 Ada，点击 Apply，并确认页面显示 Done: Ada`,
  executionTarget: { kind: "browser", browserKernel },
  approvalMode: "none"
});
const firstRoute = routeFrom(firstPayloads);
assertToolChain(firstPayloads);

let tasks = await fetchJson(`${baseUrl}/api/ui-operations`);
let task = tasks.find((item) => item.id === firstRoute.operationTaskId);
assert.ok(task, `operation task not found: ${firstRoute.operationTaskId}`);
assert.equal(task.executionTarget.browserKernel, browserKernel);
assert.equal(task.runs[0].status, "completed", JSON.stringify(task.runs[0]));

let session = await fetchJson(`${baseUrl}/api/sessions/${encodeURIComponent(firstRoute.sessionId)}`);
const firstSdkSessionId = session.sdkSessionId;
assert.ok(firstSdkSessionId, "SDK session ID must be persisted for multi-turn resume");
await fs.access(`${session.workspacePath}/.claude/skills/dt-gui-browser-skill/SKILL.md`);
await fs.access(`${session.workspacePath}/.claude/skills/dt-gui-computer-skill/SKILL.md`);
await fs.access(`${session.workspacePath}/.claude/skills/ui-test-assistant-skill/SKILL.md`);

const firstRep = await latestBrowserRep(session);
assert.equal(firstRep.manifest.artifactKind, "browser-rep");
assert.equal(firstRep.manifest.captureStopReason, "completed");
assert.ok(firstRep.manifest.actionCount >= 3, JSON.stringify(firstRep.manifest));
assert.deepEqual(firstRep.actions.slice(0, 3).map((action) => action.kind), ["navigate", "set-value", "click"]);
assert.ok(firstRep.actions.every((action) => !("value" in action)), JSON.stringify(firstRep.actions));
assert.match(firstRep.snapshot.text, /Done: Ada/);
assert.ok(session.artifacts.some((artifact) =>
  artifact.relativePath.includes(".skill-output/uiwarden-reps/") && artifact.name === "manifest.json"
), "embedded Browser Rep manifest missing");

const secondUrl = withRunQuery(targetUrl, `second-${Date.now()}`);
const switched = await createVisibleTab(secondUrl);
assert.ok(switched.targetId && switched.targetId !== firstRep.manifest.target.targetId, JSON.stringify(switched));
const secondPayloads = await sendOperation(`/api/ui-operations/${encodeURIComponent(firstRoute.operationTaskId)}/messages`, {
  message: "在我刚切换到的当前标签页中，把 Name 输入为 Bob，点击 Apply，并确认页面显示 Done: Bob"
});
const secondRoute = routeFrom(secondPayloads);
assert.equal(secondRoute.operationTaskId, firstRoute.operationTaskId);
assert.equal(secondRoute.sessionId, firstRoute.sessionId);
assertToolChain(secondPayloads);

tasks = await fetchJson(`${baseUrl}/api/ui-operations`);
task = tasks.find((item) => item.id === firstRoute.operationTaskId);
assert.ok(task);
assert.equal(task.runs[0].status, "completed", JSON.stringify(task.runs[0]));
assert.ok(task.runs.length >= 2);
session = await fetchJson(`${baseUrl}/api/sessions/${encodeURIComponent(firstRoute.sessionId)}`);
assert.equal(session.sdkSessionId, firstSdkSessionId, "multi-turn operation must resume the same SDK session");

const secondRep = await latestBrowserRep(session, firstRep.root);
assert.equal(secondRep.manifest.target.targetId, switched.targetId);
assert.match(secondRep.manifest.target.url, /second-/);
assert.deepEqual(secondRep.actions.map((action) => action.kind), ["set-value", "click"]);
assert.match(secondRep.snapshot.text, /Done: Bob/);
assert.ok(secondRep.actions.every((action) => !("value" in action)), JSON.stringify(secondRep.actions));
assert.ok(session.artifacts.filter((artifact) =>
  artifact.relativePath.includes(".skill-output/uiwarden-reps/") && artifact.name === "manifest.json"
).length >= 2, "each turn must produce an embedded Browser Rep");

const browserManifestArtifact = session.artifacts.find((artifact) =>
  artifact.relativePath === `${secondRep.root}/manifest.json`
);
assert.ok(browserManifestArtifact);
const previewResponse = await fetch(
  `${baseUrl}/api/sessions/${encodeURIComponent(firstRoute.sessionId)}/preview/${encodeArtifactPath(browserManifestArtifact.relativePath)}`
);
const previewHtml = await previewResponse.text();
assert.equal(previewResponse.status, 200, previewHtml);
assert.match(previewHtml, /browser-rep/);
const downloadResponse = await fetch(`${baseUrl}/api/sessions/${encodeURIComponent(firstRoute.sessionId)}/artifacts/download`);
const downloadBody = await downloadResponse.arrayBuffer();
assert.equal(downloadResponse.status, 200);
assert.ok(downloadBody.byteLength > 1_000, `artifact archive is too small: ${downloadBody.byteLength}`);

const assistantText = session.messages.filter((message) => message.role === "assistant").map((message) => message.content).join("\n");
assert.match(assistantText, /Done:\s*Ada/i);
assert.match(assistantText, /Done:\s*Bob/i);
console.log(JSON.stringify({
  ok: true,
  browserKernel,
  operationTaskId: firstRoute.operationTaskId,
  sessionId: firstRoute.sessionId,
  sdkSessionId: firstSdkSessionId,
  firstTargetId: firstRep.manifest.target.targetId,
  secondTargetId: secondRep.manifest.target.targetId,
  firstActions: firstRep.actions.map((action) => action.kind),
  secondActions: secondRep.actions.map((action) => action.kind),
  artifactCount: session.artifacts.length,
  downloadBytes: downloadBody.byteLength
}));

async function sendOperation(pathname, body) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  if (response.status !== 200) throw new Error(`UI operation failed: HTTP ${response.status} ${await response.text()}`);
  assert.ok(response.body, "UI operation stream is missing");
  const payloads = await readSse(response.body);
  const errorPayload = payloads.find((payload) => payload.type === "error");
  assert.equal(errorPayload, undefined, JSON.stringify(errorPayload));
  return payloads;
}

function routeFrom(payloads) {
  const data = payloads.find((payload) => payload.type === "session")?.data || {};
  const operationTaskId = String(data.operationTaskId || "");
  const sessionId = String(data.sessionId || "");
  assert.ok(operationTaskId && sessionId, JSON.stringify(data));
  return { operationTaskId, sessionId };
}

function assertToolChain(payloads) {
  const toolStarts = payloads
    .filter((payload) => payload.type === "tool" && payload.data?.phase === "start")
    .map((payload) => String(payload.data.name || ""));
  assert.equal(toolStarts[0], "Skill", JSON.stringify(toolStarts));
  assert.ok(toolStarts.includes("Bash"), JSON.stringify(toolStarts));
  const transcript = payloads.map((payload) => JSON.stringify(payload)).join("\n");
  assert.doesNotMatch(transcript, /run_quick_mode|browser_use|ui-test-assistant-skill|playwright\s+(?:test|open|codegen)/i);
}

async function latestBrowserRep(agentSession, excludedRoot) {
  const roots = agentSession.artifacts
    .filter((artifact) => artifact.name === "manifest.json" && artifact.relativePath.includes(".skill-output/browser-reps/"))
    .map((artifact) => path.posix.dirname(artifact.relativePath))
    .filter((root) => root !== excludedRoot);
  assert.equal(roots.length, 1, JSON.stringify(roots));
  const root = roots[0];
  const manifest = JSON.parse(await artifactText(agentSession, `${root}/manifest.json`));
  assert.ok(manifest.snapshotCount > 0, `Browser Rep did not capture a page observation: ${JSON.stringify(manifest)}`);
  const actionsText = await artifactText(agentSession, `${root}/streams/actions.jsonl`);
  const actions = actionsText.trim() ? actionsText.trim().split("\n").map((line) => JSON.parse(line)) : [];
  const snapshot = JSON.parse(await artifactText(agentSession, `${root}/snapshots/latest.json`));
  return { root, manifest, actions, snapshot };
}

async function createVisibleTab(url) {
  const targets = await (await fetch(`${cdpUrl}/json/list`)).json();
  const renderer = targets.find((target) => target.type === "page" && (
    browserKernel === "gui-computer"
      ? String(target.url || "").endsWith("/browser.html")
      : String(target.url || "").startsWith(baseUrl)
  ));
  assert.ok(renderer?.webSocketDebuggerUrl, JSON.stringify(targets.map((target) => target.url)));
  const cdp = await CdpClient.connect(renderer.webSocketDebuggerUrl);
  try {
    await cdp.send("Runtime.enable");
    const createTabExpression = browserKernel === "gui-computer"
      ? `(async () => window.guiComputer.createTab(${JSON.stringify(url)}))()`
      : `(async () => window.uiwardenDesktop.embeddedBrowser.createTab(${JSON.stringify(url)}))()`;
    const result = await cdp.send("Runtime.evaluate", {
      expression: createTabExpression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true
    });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    const state = result.result?.value;
    const active = state?.tabs?.find((tab) => tab.id === state.activeTabId);
    assert.ok(active?.targetId, JSON.stringify(state));
    return active;
  } finally {
    cdp.close();
  }
}

async function readSse(body) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const payloads = [];
  let buffer = "";
  while (true) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
    const frames = buffer.split("\n\n");
    buffer = frames.pop() || "";
    for (const frame of frames) {
      const data = frame.split("\n").find((line) => line.startsWith("data: "))?.slice(6);
      if (data) payloads.push(JSON.parse(data));
    }
    if (done) break;
  }
  return payloads;
}

async function artifactText(agentSession, relativePath) {
  return fs.readFile(path.join(agentSession.workspacePath, relativePath), "utf8");
}

function encodeArtifactPath(relativePath) {
  return relativePath.split("/").map(encodeURIComponent).join("/");
}

function withRunQuery(url, value) {
  const parsed = new URL(url);
  parsed.searchParams.set("run", value);
  return parsed.toString();
}

async function fetchJson(url) {
  const response = await fetch(url);
  const text = await response.text();
  assert.equal(response.status, 200, text);
  return JSON.parse(text);
}
