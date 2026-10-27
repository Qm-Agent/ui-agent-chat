const BRIDGE_VERSION = "0.9.1";
const STORAGE_KEY = "uiwardenBridgePairing";
const RECONNECT_ALARM = "uiwarden-bridge-reconnect";
const HEARTBEAT_INTERVAL_MS = 20_000;
const ALLOWED_CDP_METHODS = new Set([
  "Runtime.enable",
  "Runtime.evaluate",
  "Runtime.releaseObject",
  "DOM.describeNode",
  "DOM.setFileInputFiles",
  "Page.enable",
  "Page.navigate",
  "Page.reload",
  "Page.getNavigationHistory",
  "Page.navigateToHistoryEntry",
  "Page.getLayoutMetrics",
  "Page.captureScreenshot",
  "Page.handleJavaScriptDialog",
  "Browser.setDownloadBehavior",
  "Input.dispatchMouseEvent",
  "Input.dispatchKeyEvent",
  "Input.setInterceptDrags",
  "Input.dispatchDragEvent"
]);

let bridgeSocket;
let heartbeatTimer;
let reconnectAttempt = 0;
const attachedTabs = new Set();

chrome.runtime.onInstalled.addListener(() => {
  void connectStoredBridge();
});

chrome.runtime.onStartup.addListener(() => {
  void connectStoredBridge();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === RECONNECT_ALARM) void connectStoredBridge();
});

chrome.debugger.onDetach.addListener((source) => {
  if (typeof source.tabId === "number") attachedTabs.delete(source.tabId);
});

chrome.debugger.onEvent.addListener((source, method, params) => {
  if (typeof source.tabId !== "number" || !attachedTabs.has(source.tabId)) return;
  if (bridgeSocket?.readyState !== WebSocket.OPEN) return;
  bridgeSocket.send(JSON.stringify({
    type: "cdp.event",
    tabId: source.tabId,
    method,
    params: isObject(params) ? params : {}
  }));
});

chrome.runtime.onMessageExternal.addListener((message, sender, sendResponse) => {
  if (message?.type !== "uiwarden-pair") return false;
  void pairBridge(message, sender)
    .then(() => sendResponse({ ok: true }))
    .catch((error) => sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) }));
  return true;
});

async function pairBridge(message, sender) {
  if (!isAllowedPairingPage(sender.url)) throw new Error("只允许从本机 UIWarden 配对页连接扩展");
  const token = String(message.token || "");
  const bridgeUrl = String(message.bridgeUrl || "");
  if (token.length < 32) throw new Error("配对令牌无效");
  if (!isAllowedBridgeUrl(bridgeUrl)) throw new Error("扩展桥地址必须是本机 WebSocket");
  await chrome.storage.local.set({ [STORAGE_KEY]: { token, bridgeUrl } });
  await connectBridge({ token, bridgeUrl });
}

async function connectStoredBridge() {
  const stored = await chrome.storage.local.get(STORAGE_KEY);
  const pairing = stored?.[STORAGE_KEY];
  if (!pairing?.token || !pairing?.bridgeUrl) return;
  await connectBridge(pairing).catch(() => scheduleReconnect());
}

async function connectBridge(pairing) {
  if (bridgeSocket?.readyState === WebSocket.OPEN || bridgeSocket?.readyState === WebSocket.CONNECTING) return;
  const socketUrl = new URL(pairing.bridgeUrl);
  socketUrl.searchParams.set("token", pairing.token);
  socketUrl.searchParams.set("extensionId", chrome.runtime.id);
  const socket = new WebSocket(socketUrl.toString());
  bridgeSocket = socket;
  socket.addEventListener("open", () => {
    if (bridgeSocket !== socket) return;
    reconnectAttempt = 0;
    startHeartbeat(socket);
    socket.send(JSON.stringify({
      type: "hello",
      version: BRIDGE_VERSION,
      browserName: navigator.userAgent
    }));
  });
  socket.addEventListener("message", (event) => {
    void handleBridgeMessage(socket, event.data);
  });
  socket.addEventListener("close", () => {
    if (bridgeSocket !== socket) return;
    bridgeSocket = undefined;
    stopHeartbeat();
    void detachAll();
    scheduleReconnect();
  });
  socket.addEventListener("error", () => {
    if (bridgeSocket !== socket) return;
    bridgeSocket = undefined;
    stopHeartbeat();
    socket.close();
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("连接 UIWarden 扩展桥超时")), 5000);
    socket.addEventListener("open", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
    socket.addEventListener("error", () => {
      clearTimeout(timer);
      reject(new Error("无法连接本机 UIWarden 扩展桥"));
    }, { once: true });
  });
}

function startHeartbeat(socket) {
  stopHeartbeat();
  heartbeatTimer = setInterval(() => {
    if (bridgeSocket !== socket || socket.readyState !== WebSocket.OPEN) {
      stopHeartbeat();
      return;
    }
    socket.send(JSON.stringify({ type: "ping", at: Date.now() }));
  }, HEARTBEAT_INTERVAL_MS);
}

function stopHeartbeat() {
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  heartbeatTimer = undefined;
}

function scheduleReconnect() {
  reconnectAttempt += 1;
  const delayMinutes = Math.min(1, Math.max(0.1, reconnectAttempt * 0.1));
  void chrome.alarms.create(RECONNECT_ALARM, { delayInMinutes: delayMinutes });
}

async function handleBridgeMessage(socket, raw) {
  let message;
  try {
    message = JSON.parse(String(raw));
  } catch {
    return;
  }
  if (message?.type !== "command" || !message.id) return;
  try {
    const result = await executeCommand(String(message.method || ""), message.params || {});
    socket.send(JSON.stringify({ type: "response", id: message.id, ok: true, result }));
  } catch (error) {
    socket.send(JSON.stringify({
      type: "response",
      id: message.id,
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    }));
  }
}

async function executeCommand(method, params) {
  if (method === "tabs.list") {
    const tabs = await chrome.tabs.query({});
    return { tabs: tabs.filter(isControllableTab).map(serializeTab) };
  }
  if (method === "tabs.activate") {
    const tab = await requireControllableTab(params.tabId);
    await chrome.tabs.update(tab.id, { active: true });
    await chrome.windows.update(tab.windowId, { focused: true });
    return serializeTab(await chrome.tabs.get(tab.id));
  }
  if (method === "tabs.create") {
    const url = normalizeNewTabUrl(params.url);
    return serializeTab(await chrome.tabs.create({ url, active: true }));
  }
  if (method === "taskGroups.capabilities") {
    return { version: 1, tabs: true, tabGroups: true };
  }
  if (method === "taskGroups.create") {
    return createTaskGroup(params);
  }
  if (method === "cdp.send") {
    const tab = await requireControllableTab(params.tabId);
    const cdpMethod = String(params.method || "");
    if (!ALLOWED_CDP_METHODS.has(cdpMethod)) throw new Error(`不允许的 CDP 命令：${cdpMethod}`);
    await ensureAttached(tab.id);
    return chrome.debugger.sendCommand({ tabId: tab.id }, cdpMethod, isObject(params.params) ? params.params : {});
  }
  if (method === "cdp.detach") {
    const tabId = Number(params.tabId);
    if (!Number.isInteger(tabId) || !attachedTabs.has(tabId)) return { detached: false };
    attachedTabs.delete(tabId);
    await chrome.debugger.detach({ tabId }).catch(() => undefined);
    return { detached: true };
  }
  throw new Error(`不支持的扩展桥命令：${method}`);
}

async function ensureAttached(tabId) {
  if (attachedTabs.has(tabId)) return;
  try {
    await chrome.debugger.attach({ tabId }, "1.3");
    attachedTabs.add(tabId);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!/already attached/i.test(message)) throw error;
    attachedTabs.add(tabId);
  }
}

async function requireControllableTab(value) {
  const tabId = Number(value);
  if (!Number.isInteger(tabId)) throw new Error("标签页 ID 无效");
  const tab = await chrome.tabs.get(tabId);
  if (!isControllableTab(tab)) throw new Error("该标签页不允许被 UIWarden 接管");
  return tab;
}

function isControllableTab(tab) {
  return typeof tab?.id === "number"
    && typeof tab.windowId === "number"
    && isControllableUrl(String(tab.url || ""));
}

function serializeTab(tab) {
  return {
    id: tab.id,
    windowId: tab.windowId,
    title: String(tab.title || tab.url || ""),
    url: String(tab.url || ""),
    active: tab.active === true,
    lastAccessed: tab.lastAccessed
  };
}

function normalizeNewTabUrl(value) {
  const url = String(value || "about:blank").trim() || "about:blank";
  if (url === "about:blank" || /^https?:\/\//i.test(url)) return url;
  throw new Error("只允许新建 about:blank 或 HTTP(S) 页面");
}

function isControllableUrl(value) {
  return /^https?:\/\//i.test(value) || value.startsWith("about:blank#uiwarden-task-");
}

function normalizeTitle(value) {
  return String(value || "UIWarden Task")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 24) || "UIWarden Task";
}

async function createTaskGroup(input) {
  const requestedTabId = Number(input?.tabId);
  const tab = Number.isInteger(requestedTabId)
    ? await requireControllableTab(requestedTabId)
    : await createTaskMarkerTab(input);
  if (typeof tab.id !== "number") throw new Error("Chromium 未返回标签页 ID");
  const groupId = await chrome.tabs.group({ tabIds: [tab.id] });
  await chrome.tabGroups.update(groupId, {
    title: normalizeTitle(input?.title),
    color: input?.color === "blue" ? "blue" : "red",
    collapsed: false
  });
  await chrome.tabs.update(tab.id, { active: true });
  await chrome.windows.update(tab.windowId, { focused: true });
  return {
    version: 1,
    chromeTabId: tab.id,
    groupId,
    markerUrl: String(tab.url || input?.markerUrl || "")
  };
}

async function createTaskMarkerTab(input) {
  const markerUrl = String(input?.markerUrl || "");
  if (!markerUrl.startsWith("about:blank#uiwarden-task-")) throw new Error("任务标签组标记无效");
  return chrome.tabs.create({ url: markerUrl, active: true });
}

async function detachAll() {
  const tabIds = [...attachedTabs];
  attachedTabs.clear();
  await Promise.all(tabIds.map((tabId) => chrome.debugger.detach({ tabId }).catch(() => undefined)));
}

function isAllowedPairingPage(value) {
  try {
    const url = new URL(String(value || ""));
    return url.protocol === "http:"
      && (url.hostname === "127.0.0.1" || url.hostname === "localhost")
      && url.pathname === "/browser-extension-pair";
  } catch {
    return false;
  }
}

function isAllowedBridgeUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "ws:"
      && (url.hostname === "127.0.0.1" || url.hostname === "localhost")
      && url.pathname === "/api/cdp/extension-bridge/socket";
  } catch {
    return false;
  }
}

function isObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

void connectStoredBridge();
