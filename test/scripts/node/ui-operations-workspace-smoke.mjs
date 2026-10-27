import assert from "node:assert/strict";
import fs from "node:fs/promises";
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

const cdpUrl = String(process.argv[2] || "http://127.0.0.1:47971").replace(/\/$/, "");
const appUrl = String(process.argv[3] || "http://127.0.0.1:47970").replace(/\/$/, "");
const screenshotPath = process.argv[4] || "/tmp/uiwarden-ui-operations-workspace.png";
const staleTasks = await (await fetch(`${appUrl}/api/ui-operations`)).json();
const browserTask = staleTasks.find((item) => item.executionTarget?.kind === "browser"
  && item.executionTarget.browserKernel === "uiwarden-embedded"
  && item.runs?.some((run) => run.sessionId));
const nativeTask = staleTasks.find((item) => item.executionTarget?.kind === "native-app" && item.runs?.some((run) => run.sessionId));
assert.ok(browserTask, "UI 操作工作台冒烟需要至少一条已有产物的浏览器操作会话");
const browserSessionId = browserTask.conversationSessionId || browserTask.runs.find((run) => run.sessionId)?.sessionId;
const browserSession = await (await fetch(`${appUrl}/api/sessions/${encodeURIComponent(browserSessionId)}`)).json();
const expectedObservationNames = (browserSession.artifacts || [])
  .filter((artifact) => artifact.kind === "file" && /\.(?:png|jpe?g|webp)$/i.test(artifact.name))
  .sort((a, b) => a.modifiedAt.localeCompare(b.modifiedAt) || a.relativePath.localeCompare(b.relativePath, undefined, { numeric: true }))
  .map((artifact) => artifact.name);
for (const task of staleTasks.filter((item) => item.name === "分页删除冒烟")) {
  await fetch(`${appUrl}/api/ui-operations/${encodeURIComponent(task.id)}`, { method: "DELETE" });
}
const dummyResponse = await fetch(`${appUrl}/api/ui-operations`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ name: "分页删除冒烟", instruction: "仅验证列表删除", executionTarget: { kind: "browser", browserKernel: "playwright" } })
});
const dummyBody = await dummyResponse.json();
assert.equal(dummyResponse.status, 201, JSON.stringify(dummyBody));
const dummyTaskId = dummyBody.id;
assert.ok(dummyTaskId, JSON.stringify(dummyBody));

const targets = await (await fetch(`${cdpUrl}/json/list`)).json();
const renderer = targets.find((target) => {
  const url = String(target.url || "");
  return target.type === "page"
    && String(target.title || "").toLowerCase() === "uiwarden"
    && url.startsWith(appUrl)
    && !url.startsWith(`${appUrl}/api/`);
});
assert.ok(renderer?.webSocketDebuggerUrl, JSON.stringify(targets.map((target) => target.url)));
const cdp = await CdpClient.connect(renderer.webSocketDebuggerUrl);
try {
  await cdp.send("Runtime.enable");
  await cdp.send("Page.enable");
  await evaluate(`Array.from(document.querySelectorAll(".side-menu button")).find((node) => node.textContent.includes("UI 操作"))?.click()`);
  await waitFor(`location.pathname === "/ui-operations"`);
  await evaluate(`Array.from(document.querySelectorAll(".operationPageHeader button")).find((node) => node.textContent.includes("刷新"))?.click()`);
  await evaluate(`Array.from(document.querySelectorAll(".operationPageHeader button")).find((node) => node.textContent.includes("新对话"))?.click()`);
  await waitFor(`Boolean(document.querySelector('[aria-label="执行目标"]'))`);
  await evaluate(`Array.from(document.querySelectorAll('[aria-label="执行目标"] button')).find((node) => node.textContent.includes("浏览器"))?.click()`);
  const operationKernelOptions = await evaluate(`Array.from(document.querySelectorAll(".operationKernelField select option")).map((option) => ({ value: option.value, text: option.textContent.trim() }))`);
  assert.deepEqual(operationKernelOptions, [
    { value: "playwright", text: "Playwright 配套 Chromium（ui-test-assistant-skill）" },
    { value: "uiwarden-embedded", text: "内置 gui-browser（dt-gui-browser-skill）" },
    { value: "external-cdp", text: "用户浏览器桥接（dt-gui-browser-skill）" },
  ]);
  await waitFor(`Boolean(document.querySelector(${JSON.stringify(`[data-task-id="${dummyTaskId}"]`)}))`);
  assert.equal(await evaluate(`document.querySelector(${JSON.stringify(`[data-task-id="${dummyTaskId}"] .operationConversationSelect`)})?.title`), "分页删除冒烟");
  await evaluate(`document.querySelector(${JSON.stringify(`[data-task-id="${dummyTaskId}"] .operationConversationDelete`)})?.click()`);
  await waitFor(`!document.querySelector(${JSON.stringify(`[data-task-id="${dummyTaskId}"]`)})`);
  await evaluate(`(() => { const select = document.querySelector('select[aria-label="每页对话数"]'); select.value = "50"; select.dispatchEvent(new Event("change", { bubbles: true })); })()`);
  await waitFor(`Boolean(document.querySelector(${JSON.stringify(`[data-task-id="${browserTask.id}"]`)}))`);
  await evaluate(`document.querySelector(${JSON.stringify(`[data-task-id="${browserTask.id}"] .operationConversationSelect`)})?.click()`);
  await waitFor(`Boolean(document.querySelector(".operationWorkspaceTabs") && document.querySelector(".operationBrowserInspector"))`);
  await waitFor(`document.querySelector(".operationSessionIdChip code")?.textContent === ${JSON.stringify(browserSessionId)}`);
  assert.equal(await evaluate(`document.querySelector(".operationSessionIdChip code")?.textContent`), browserSessionId);
  assert.match(await evaluate(`document.querySelector(".operationSessionIdChip")?.title || ""`), /复制会话 ID/);

  const controls = await evaluate(`({
    tabs: Array.from(document.querySelectorAll(".operationWorkspaceTabs button")).map((node) => node.textContent.trim()),
    titles: Array.from(document.querySelectorAll(".operationBrowserToolbar button")).map((node) => node.title),
    pagination: Boolean(document.querySelector(".operationConversationPagination")),
    rowDelete: Boolean(document.querySelector(".operationConversationDelete"))
  })`);
  assert.deepEqual(controls.tabs.map((value) => value.replace(/\d+$/, "")), ["对话", "浏览器", "执行观察", "产物与诊断"]);
  assert.equal(controls.pagination, true);
  assert.equal(controls.rowDelete, true);
  assert.ok(controls.titles.includes("清除全部 Cookie"), JSON.stringify(controls.titles));
  assert.ok(controls.titles.includes("开发者工具：请求与控制台（F12）"), JSON.stringify(controls.titles));
  assert.ok(controls.titles.includes("放大"), JSON.stringify(controls.titles));

  await clickWorkspaceTab("执行观察");
  await waitFor(`(() => { const image = document.querySelector(".operationObservationPreview img"); return Boolean(image?.complete && image.naturalWidth > 0); })()`);
  const observationNames = await evaluate(`Array.from(document.querySelectorAll(".operationObservationTimeline button em")).map((node) => node.title)`);
  assert.deepEqual(observationNames, expectedObservationNames, JSON.stringify({ observationNames, expectedObservationNames }));
  const observation = await evaluate(`(() => { const image = document.querySelector(".operationObservationPreview img"); return { naturalWidth: image.naturalWidth, naturalHeight: image.naturalHeight, fit: getComputedStyle(image).objectFit }; })()`);
  assert.ok(observation.naturalWidth > 0 && observation.naturalHeight > 0, JSON.stringify(observation));
  assert.equal(observation.fit, "contain");
  const replayButton = await evaluate(`Array.from(document.querySelectorAll(".operationObservationControls button")).find((node) => node.title === "回放执行过程")?.disabled === false`);
  if (replayButton) {
    await evaluate(`Array.from(document.querySelectorAll(".operationObservationControls button")).find((node) => node.title === "回放执行过程")?.click()`);
    await waitFor(`Boolean(document.querySelector(".operationObservationReplay"))`);
    assert.equal(await evaluate(`window.uiwardenDesktop.embeddedBrowser.getState().then((state) => state.visible)`), false);
    const beforeReplay = await evaluate(`document.querySelector(".operationObservationReplay header em")?.textContent`);
    await new Promise((resolve) => setTimeout(resolve, 1_050));
    const afterReplay = await evaluate(`document.querySelector(".operationObservationReplay header em")?.textContent`);
    assert.notEqual(afterReplay, beforeReplay, JSON.stringify({ beforeReplay, afterReplay }));
    assert.equal(await evaluate(`document.querySelector(".operationObservationTimeline button:first-child strong")?.textContent`), "Step 1");
    await capture(screenshotPath.replace(/\.png$/i, "-replay.png"));
    await evaluate(`document.querySelector(".operationObservationReplay header button[title='关闭']")?.click()`);
    await waitFor(`!document.querySelector(".operationObservationReplay")`);
  }
  await new Promise((resolve) => setTimeout(resolve, 350));
  await capture(screenshotPath.replace(/\.png$/i, "-observation.png"));

  await clickWorkspaceTab("产物与诊断");
  await waitFor(`document.querySelectorAll(".operationArtifactList > div").length > 3`);
  assert.equal(await evaluate("location.pathname"), "/ui-operations");
  const artifactUi = await evaluate(`({ categories: document.querySelectorAll(".operationArtifactTabs button").length, entries: document.querySelectorAll(".operationArtifactList > div").length, core: document.querySelectorAll(".operationArtifactList > div.core").length })`);
  assert.ok(artifactUi.categories >= 4, JSON.stringify(artifactUi));
  assert.ok(artifactUi.entries > 3, JSON.stringify(artifactUi));
  assert.ok(artifactUi.core >= 1, JSON.stringify(artifactUi));
  await evaluate(`Array.from(document.querySelectorAll(".operationArtifactList > div")).find((node) => /\\.png/i.test(node.textContent))?.querySelector("button")?.click()`);
  await waitFor(`(() => { const image = document.querySelector(".operationArtifactPreview > div > img"); return Boolean(image?.complete && image.naturalWidth > 0); })()`);
  assert.equal(await evaluate("location.pathname"), "/ui-operations");
  await evaluate(`document.querySelector(".operationArtifactPreview header button")?.click()`);
  await waitFor(`!document.querySelector(".operationArtifactPreview")`);
  await capture(screenshotPath.replace(/\.png$/i, "-artifacts.png"));

  await clickWorkspaceTab("浏览器");
  await waitFor(`Boolean(document.querySelector(".operationBrowserInspector.fullWidth"))`);
  const beforeZoom = await evaluate(`window.uiwardenDesktop.embeddedBrowser.getState()`);
  await evaluate(`Array.from(document.querySelectorAll(".operationBrowserToolbar button")).find((node) => node.title === "放大")?.click()`);
  await waitFor(`window.uiwardenDesktop.embeddedBrowser.getState().then((state) => state.zoomFactor > ${Number(beforeZoom.zoomFactor || 1)})`);
  await evaluate(`Array.from(document.querySelectorAll(".operationBrowserToolbar button")).find((node) => node.title === "恢复 100%")?.click()`);
  await waitFor(`window.uiwardenDesktop.embeddedBrowser.getState().then((state) => Math.abs(state.zoomFactor - 1) < 0.01)`);
  const browserState = await evaluate(`window.uiwardenDesktop.embeddedBrowser.getState()`);
  const viewport = await evaluate(`({ width: innerWidth, height: innerHeight })`);
  assert.ok(browserState.bounds.x + browserState.bounds.width <= viewport.width, JSON.stringify({ bounds: browserState.bounds, viewport }));
  assert.ok(browserState.bounds.y + browserState.bounds.height <= viewport.height, JSON.stringify({ bounds: browserState.bounds, viewport }));

  await capture(screenshotPath);
  const completedStyle = await evaluate(`(() => {
    const badge = document.querySelector(".qualityStatuscompleted");
    if (!badge) return null;
    const style = getComputedStyle(badge);
    return { color: style.color, backgroundColor: style.backgroundColor };
  })()`);
  assert.ok(completedStyle && completedStyle.color !== "rgb(107, 114, 128)", JSON.stringify(completedStyle));
  const nativeInspectorToggle = nativeTask ? await verifyNativeInspectorToggle(nativeTask.id) : { skipped: true };
  const concurrentConversation = await verifyNewConversationWhilePreviousStreamRuns();
  console.log(JSON.stringify({ ok: true, screenshotPath, controls, observation, artifactUi, browserBounds: browserState.bounds, viewport, completedStyle, nativeInspectorToggle, concurrentConversation }));
} finally {
  cdp.close();
}

async function verifyNativeInspectorToggle(taskId) {
  await evaluate(`document.querySelector(${JSON.stringify(`[data-task-id="${taskId}"] .operationConversationSelect`)})?.click()`);
  await waitFor(`Boolean(document.querySelector(".operationInspectorToggle[title='收起原生控制']") && document.querySelector(".operationInspector"))`);
  await evaluate(`document.querySelector(".operationInspectorToggle[title='收起原生控制']")?.click()`);
  await waitFor(`Boolean(document.querySelector(".operationInspectorToggle[title='展开原生控制']")) && !document.querySelector(".operationInspector")`);
  await evaluate(`document.querySelector(".operationInspectorToggle[title='展开原生控制']")?.click()`);
  await waitFor(`Boolean(document.querySelector(".operationInspectorToggle[title='收起原生控制']") && document.querySelector(".operationInspector"))`);
  return { collapsed: true, restored: true };
}

async function verifyNewConversationWhilePreviousStreamRuns() {
  await evaluate(`(() => {
    window.__uiOperationOriginalFetch = window.fetch;
    window.__uiOperationConcurrentRequests = 0;
    window.fetch = function(input, init) {
      const url = typeof input === "string" ? input : String(input?.url || "");
      let message = "";
      try { message = JSON.parse(String(init?.body || "{}")).message || ""; } catch {}
      if (url.endsWith("/api/ui-operations/messages") && message.startsWith("__uiwarden_concurrency_")) {
        window.__uiOperationConcurrentRequests += 1;
        if (window.__uiOperationConcurrentRequests === 1) {
          return Promise.resolve(new Response(new ReadableStream({
            start(controller) { window.__uiOperationFirstStream = controller; }
          }), { status: 200, headers: { "Content-Type": "text/event-stream" } }));
        }
        return Promise.resolve(new Response('data: {"type":"done"}\\n\\n', {
          status: 200,
          headers: { "Content-Type": "text/event-stream" }
        }));
      }
      return window.__uiOperationOriginalFetch.apply(this, arguments);
    };
  })()`);
  try {
    await evaluate(`Array.from(document.querySelectorAll(".operationPageHeader button")).find((node) => node.textContent.includes("新对话"))?.click()`);
    await setComposerValue("__uiwarden_concurrency_first__");
    await evaluate(`document.querySelector(".operationSendButton")?.click()`);
    await waitFor(`window.__uiOperationConcurrentRequests === 1 && document.querySelector(".operationComposer textarea")?.disabled === true`);

    await evaluate(`Array.from(document.querySelectorAll(".operationPageHeader button")).find((node) => node.textContent.includes("新对话"))?.click()`);
    await waitFor(`document.querySelector(".operationComposer textarea")?.disabled === false`);
    await setComposerValue("__uiwarden_concurrency_second__");
    const enabledAfterNewConversation = await evaluate(`document.querySelector(".operationSendButton")?.disabled === false`);
    assert.equal(enabledAfterNewConversation, true, "new conversation send button stayed disabled by the previous stream");
    await evaluate(`document.querySelector(".operationSendButton")?.click()`);
    await waitFor(`window.__uiOperationConcurrentRequests === 2`);
    await waitFor(`document.querySelector(".operationComposer textarea")?.disabled === false`);
    return { firstStreamStillOpen: true, secondRequestSent: true, sendEnabled: enabledAfterNewConversation };
  } finally {
    await evaluate(`(() => {
      try { window.__uiOperationFirstStream?.close(); } catch {}
      if (window.__uiOperationOriginalFetch) window.fetch = window.__uiOperationOriginalFetch;
      delete window.__uiOperationOriginalFetch;
      delete window.__uiOperationFirstStream;
    })()`);
  }
}

async function setComposerValue(value) {
  await evaluate(`(() => {
    const textarea = document.querySelector(".operationComposer textarea");
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set;
    setter.call(textarea, ${JSON.stringify(value)});
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  })()`);
}

async function clickWorkspaceTab(label) {
  await evaluate(`Array.from(document.querySelectorAll(".operationWorkspaceTabs button")).find((node) => node.textContent.includes(${JSON.stringify(label)}))?.click()`);
}

async function waitFor(expression, timeout = 10_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await evaluate(expression)) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for: ${expression}`);
}

async function evaluate(expression) {
  const result = await cdp.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, userGesture: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
  return result.result?.value;
}

async function capture(filePath) {
  const screenshot = await cdp.send("Page.captureScreenshot", { format: "png", fromSurface: true });
  await fs.writeFile(filePath, Buffer.from(screenshot.data, "base64"));
}
