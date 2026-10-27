import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { execFile } from "node:child_process";
import type { Server } from "node:http";
import type { IncomingMessage } from "node:http";
import { promisify } from "node:util";
import { dataDir, projectRoot } from "./paths.js";

const require = createRequire(import.meta.url);
const execFileAsync = promisify(execFile);
const { WebSocketServer } = require("ws") as {
  WebSocketServer: new (options: { noServer: true }) => WebSocketServerLike;
};

export const BROWSER_EXTENSION_ID = "ohpncegdnhjblgbapfaepnabaaaffkad";
export const EXTENSION_BRIDGE_CDP_PATH = "/api/cdp/extension-bridge";
const EXTENSION_SOCKET_PATH = `${EXTENSION_BRIDGE_CDP_PATH}/socket`;
const PAIRING_FILE = path.join(dataDir, "browser-extension-bridge.json");
const PROXY_TOKEN = randomBytes(32).toString("hex");
const COMMAND_TIMEOUT_MS = 15_000;
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

interface WebSocketLike {
  readyState: number;
  send(data: string, callback?: (error?: Error) => void): void;
  close(code?: number, reason?: string): void;
  on(event: "message", listener: (data: unknown) => void): void;
  on(event: "close" | "error", listener: () => void): void;
}

interface WebSocketServerLike {
  handleUpgrade(
    request: IncomingMessage,
    socket: unknown,
    head: Buffer,
    callback: (socket: WebSocketLike) => void
  ): void;
}

interface ExtensionBridgeConfig {
  version: 1;
  token: string;
  pairedAt: string;
}

interface PendingCommand {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export interface ExtensionBridgeTab {
  id: string;
  chromeTabId: number;
  windowId: number;
  title: string;
  url: string;
  active: boolean;
}

export interface BrowserExtensionBridgeStatus {
  installed: boolean;
  paired: boolean;
  connected: boolean;
  canGroupExistingTab: boolean;
  extensionId: string;
  version?: string;
  browserName?: string;
  tabs: ExtensionBridgeTab[];
  extensionDir: string;
  reason?: string;
}

export interface BrowserExtensionPairing {
  pairingUrl: string;
  extensionId: string;
  extensionDir: string;
  instruction: string;
}

let extensionSocket: WebSocketLike | undefined;
let extensionVersion: string | undefined;
let extensionBrowserName: string | undefined;
const pendingCommands = new Map<string, PendingCommand>();
const cdpProxySockets = new Map<number, Set<WebSocketLike>>();

/** 将浏览器扩展桥和 CDP 代理挂到 UIWarden 的现有 HTTP Server。 */
export function installBrowserExtensionBridge(server: Server): void {
  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (request, socket, head) => {
    const requestUrl = new URL(request.url || "/", "http://127.0.0.1");
    if (requestUrl.pathname !== EXTENSION_SOCKET_PATH
      && !requestUrl.pathname.startsWith(`${EXTENSION_BRIDGE_CDP_PATH}/devtools/page/`)) {
      return;
    }
    if (!isLoopbackAddress(request.socket.remoteAddress)) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (webSocket) => {
      if (requestUrl.pathname === EXTENSION_SOCKET_PATH) {
        void acceptExtensionSocket(webSocket, request, requestUrl);
        return;
      }
      acceptCdpProxySocket(webSocket, requestUrl);
    });
  });
}

/** 生成一次配对地址；令牌持久化后客户端重启无需重新安装扩展。 */
export async function createBrowserExtensionPairing(baseUrl: string): Promise<BrowserExtensionPairing> {
  const token = randomBytes(32).toString("hex");
  const config: ExtensionBridgeConfig = {
    version: 1,
    token,
    pairedAt: new Date().toISOString()
  };
  await fs.mkdir(path.dirname(PAIRING_FILE), { recursive: true, mode: 0o700 });
  await fs.writeFile(PAIRING_FILE, JSON.stringify(config, null, 2), { mode: 0o600 });
  const url = new URL("/browser-extension-pair", normalizeHttpBase(baseUrl));
  url.searchParams.set("token", token);
  return {
    pairingUrl: url.toString(),
    extensionId: BROWSER_EXTENSION_ID,
    extensionDir: browserExtensionDir(),
    instruction: "请先在 Chrome 扩展管理页加载 UIWarden 扩展，再用用户 Chrome 打开配对页。"
  };
}

/** 返回配对页。页面只把本机持久配对令牌发送给固定 ID 的 UIWarden 扩展。 */
export function renderBrowserExtensionPairingPage(token: string, requestOrigin: string): string {
  const safeToken = JSON.stringify(String(token || ""));
  const safeOrigin = JSON.stringify(normalizeHttpBase(requestOrigin).replace(/\/$/, ""));
  const extensionId = JSON.stringify(BROWSER_EXTENSION_ID);
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>UIWarden 浏览器扩展配对</title>
  <style>
    body{margin:0;background:#f5f7fa;color:#172033;font:14px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
    main{width:min(560px,calc(100% - 40px));margin:12vh auto;background:#fff;border:1px solid #dce2ea;border-radius:8px;padding:28px}
    h1{margin:0 0 8px;font-size:20px}p{margin:8px 0;color:#536174}strong{color:#166534}
    code{display:block;margin-top:14px;padding:10px;background:#f3f5f8;border-radius:6px;overflow-wrap:anywhere}
  </style>
</head>
<body><main><h1>UIWarden 浏览器扩展配对</h1><p id="status">正在连接扩展…</p><code>${BROWSER_EXTENSION_ID}</code></main>
<script>
(() => {
  const status = document.getElementById("status");
  const token = ${safeToken};
  const origin = ${safeOrigin};
  const extensionId = ${extensionId};
  if (!globalThis.chrome?.runtime?.sendMessage) {
    status.textContent = "当前页面不是在 Chromium 中打开，或浏览器不允许网页连接扩展。";
    return;
  }
  chrome.runtime.sendMessage(extensionId, {
    type: "uiwarden-pair",
    token,
    bridgeUrl: origin.replace(/^http/, "ws") + ${JSON.stringify(EXTENSION_SOCKET_PATH)}
  }, (response) => {
    if (chrome.runtime.lastError) {
      status.textContent = "未检测到 UIWarden 浏览器扩展，请先安装或重新加载扩展。";
      return;
    }
    if (!response?.ok) {
      status.textContent = response?.error || "扩展配对失败。";
      return;
    }
    status.innerHTML = "<strong>配对成功。</strong>可以返回 UIWarden 刷新并选择用户 Chrome 的现有页面。";
  });
})();
</script></body></html>`;
}

/** 枚举扩展可操作的用户现有 HTTP(S) 页面。 */
export async function listBrowserExtensionTabs(): Promise<ExtensionBridgeTab[]> {
  const result = await sendExtensionCommand<{ tabs?: Array<Record<string, unknown>> }>("tabs.list");
  return (result.tabs || [])
    .map(normalizeExtensionTab)
    .filter((tab): tab is ExtensionBridgeTab => tab !== undefined && isAllowedPageUrl(tab.url));
}

/** 激活并接管用户已开启的页面。 */
export async function activateBrowserExtensionTab(targetId: string): Promise<void> {
  const tabId = parseTargetId(targetId);
  await sendExtensionCommand("tabs.activate", { tabId });
}

/** 在用户当前浏览器窗口中新建页面。 */
export async function createBrowserExtensionTab(url = "about:blank"): Promise<ExtensionBridgeTab> {
  const result = await sendExtensionCommand<Record<string, unknown>>("tabs.create", { url });
  const tab = normalizeExtensionTab(result);
  if (!tab) throw new Error("浏览器扩展未返回有效标签页");
  return tab;
}

export async function createBrowserExtensionTaskGroup(input: {
  markerUrl: string;
  title: string;
  color: "red" | "blue";
  targetId?: string;
}): Promise<{ version: 1; chromeTabId: number; groupId: number; markerUrl: string }> {
  if (input.targetId && !supportsExistingTabTaskGroup(extensionVersion)) {
    throw new Error("当前 UIWarden Browser Bridge 版本过旧，请在 Chrome 扩展管理页重新加载 0.9.0 或更高版本");
  }
  const result = await sendExtensionCommand<Record<string, unknown>>("taskGroups.create", {
    ...input,
    ...(input.targetId ? { tabId: parseTargetId(input.targetId) } : {})
  });
  const chromeTabId = Number(result.chromeTabId);
  const groupId = Number(result.groupId);
  if (result.version !== 1 || !Number.isInteger(chromeTabId) || !Number.isInteger(groupId)) {
    throw new Error("浏览器扩展返回了不兼容的标签组结果");
  }
  return {
    version: 1,
    chromeTabId,
    groupId,
    markerUrl: String(result.markerUrl || input.markerUrl)
  };
}

/** 获取扩展桥状态，不把配对令牌返回前端。 */
export async function getBrowserExtensionBridgeStatus(): Promise<BrowserExtensionBridgeStatus> {
  const installed = await hasBrowserExtensionFiles();
  const config = await readPairingConfig();
  if (!extensionSocket || extensionSocket.readyState !== 1) {
    return {
      installed,
      paired: Boolean(config),
      connected: false,
      canGroupExistingTab: false,
      extensionId: BROWSER_EXTENSION_ID,
      extensionDir: browserExtensionDir(),
      tabs: [],
      reason: config ? "扩展尚未连接 UIWarden，请在用户 Chrome 中重新加载扩展" : "浏览器扩展尚未配对"
    };
  }
  try {
    const tabs = await listBrowserExtensionTabs();
    return {
      installed,
      paired: true,
      connected: true,
      canGroupExistingTab: supportsExistingTabTaskGroup(extensionVersion),
      extensionId: BROWSER_EXTENSION_ID,
      extensionDir: browserExtensionDir(),
      version: extensionVersion,
      browserName: extensionBrowserName,
      tabs
    };
  } catch (error) {
    return {
      installed,
      paired: true,
      connected: false,
      canGroupExistingTab: false,
      extensionId: BROWSER_EXTENSION_ID,
      extensionDir: browserExtensionDir(),
      tabs: [],
      reason: error instanceof Error ? error.message : String(error)
    };
  }
}

/** dt-gui-browser 使用的本机 CDP 兼容基址。 */
export function browserExtensionCdpUrl(serverBaseUrl: string): string {
  return `${normalizeHttpBase(serverBaseUrl).replace(/\/$/, "")}${EXTENSION_BRIDGE_CDP_PATH}`;
}

/** 返回 CDP /json/list 兼容数据。 */
export async function listBrowserExtensionCdpTargets(serverBaseUrl: string): Promise<Array<Record<string, unknown>>> {
  const wsBase = normalizeHttpBase(serverBaseUrl).replace(/^http/, "ws").replace(/\/$/, "");
  return (await listBrowserExtensionTabs()).map((tab) => ({
    id: tab.id,
    type: "page",
    title: tab.title,
    url: tab.url,
    webSocketDebuggerUrl: `${wsBase}${EXTENSION_BRIDGE_CDP_PATH}/devtools/page/${encodeURIComponent(tab.id)}?token=${PROXY_TOKEN}`
  }));
}

export function browserExtensionDir(): string {
  return path.resolve(
    process.env.UI_AGENT_BROWSER_TASK_GROUP_EXTENSION_DIR?.trim()
      || path.join(projectRoot, "browser-task-group-extension")
  );
}

export async function revealBrowserExtensionDir(): Promise<{ opened: true; extensionDir: string }> {
  const extensionDir = browserExtensionDir();
  if (!await hasBrowserExtensionFiles()) throw new Error("客户端安装包中缺少 UIWarden Browser Bridge");
  if (process.platform === "darwin") {
    await execFileAsync("open", ["-R", path.join(extensionDir, "manifest.json")]);
  } else if (process.platform === "win32") {
    await execFileAsync("explorer.exe", ["/select,", path.join(extensionDir, "manifest.json")]);
  } else {
    await execFileAsync("xdg-open", [extensionDir]);
  }
  return { opened: true, extensionDir };
}

async function acceptExtensionSocket(
  socket: WebSocketLike,
  request: IncomingMessage,
  requestUrl: URL
): Promise<void> {
  const bufferedMessages: unknown[] = [];
  let authenticated = false;
  socket.on("message", (data) => {
    if (authenticated) handleExtensionMessage(data);
    else bufferedMessages.push(data);
  });
  const origin = String(request.headers.origin || "");
  const token = requestUrl.searchParams.get("token") || "";
  const extensionId = requestUrl.searchParams.get("extensionId") || "";
  const config = await readPairingConfig();
  if (origin !== `chrome-extension://${BROWSER_EXTENSION_ID}`
    || extensionId !== BROWSER_EXTENSION_ID
    || !config
    || !safeEqual(token, config.token)) {
    socket.close(1008, "UIWarden extension pairing rejected");
    return;
  }
  extensionSocket?.close(1000, "UIWarden extension reconnected");
  extensionSocket = socket;
  authenticated = true;
  for (const data of bufferedMessages) handleExtensionMessage(data);
  socket.on("close", () => clearExtensionSocket(socket));
  socket.on("error", () => clearExtensionSocket(socket));
  socket.send(JSON.stringify({ type: "bridge.ready", version: 1 }));
}

function acceptCdpProxySocket(socket: WebSocketLike, requestUrl: URL): void {
  if (!safeEqual(requestUrl.searchParams.get("token") || "", PROXY_TOKEN)) {
    socket.close(1008, "UIWarden CDP proxy rejected");
    return;
  }
  const targetId = decodeURIComponent(requestUrl.pathname.slice(requestUrl.pathname.lastIndexOf("/") + 1));
  let tabId: number;
  try {
    tabId = parseTargetId(targetId);
  } catch {
    socket.close(1008, "Invalid browser extension target");
    return;
  }
  const sockets = cdpProxySockets.get(tabId) || new Set<WebSocketLike>();
  sockets.add(socket);
  cdpProxySockets.set(tabId, sockets);
  socket.on("message", (data) => {
    void forwardCdpMessage(socket, tabId, data);
  });
  socket.on("close", () => {
    releaseCdpProxySocket(tabId, socket);
  });
  socket.on("error", () => releaseCdpProxySocket(tabId, socket));
}

async function forwardCdpMessage(socket: WebSocketLike, tabId: number, data: unknown): Promise<void> {
  let input: { id?: unknown; method?: unknown; params?: unknown };
  try {
    input = JSON.parse(String(data)) as typeof input;
  } catch {
    return;
  }
  const id = Number(input.id);
  const method = String(input.method || "");
  if (!Number.isFinite(id)) return;
  if (!ALLOWED_CDP_METHODS.has(method)) {
    socket.send(JSON.stringify({ id, error: { code: -32601, message: `CDP method is not allowed: ${method}` } }));
    return;
  }
  try {
    const result = await sendExtensionCommand("cdp.send", {
      tabId,
      method,
      params: isRecord(input.params) ? input.params : {}
    });
    socket.send(JSON.stringify({ id, result: result || {} }));
  } catch (error) {
    socket.send(JSON.stringify({
      id,
      error: { code: -32000, message: error instanceof Error ? error.message : String(error) }
    }));
  }
}

async function sendExtensionCommand<T = Record<string, unknown>>(
  method: string,
  params: Record<string, unknown> = {}
): Promise<T> {
  const socket = extensionSocket;
  if (!socket || socket.readyState !== 1) throw new Error("UIWarden 浏览器扩展桥未连接");
  const id = randomUUID();
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingCommands.delete(id);
      reject(new Error(`浏览器扩展命令超时：${method}`));
    }, COMMAND_TIMEOUT_MS);
    pendingCommands.set(id, {
      resolve: (value) => resolve(value as T),
      reject,
      timer
    });
    socket.send(JSON.stringify({ type: "command", id, method, params }), (error) => {
      if (!error) return;
      clearTimeout(timer);
      pendingCommands.delete(id);
      reject(error);
    });
  });
}

function handleExtensionMessage(data: unknown): void {
  let message: Record<string, unknown>;
  try {
    message = JSON.parse(String(data)) as Record<string, unknown>;
  } catch {
    return;
  }
  if (message.type === "ping") {
    if (extensionSocket?.readyState === 1) {
      extensionSocket.send(JSON.stringify({ type: "pong", at: Date.now() }));
    }
    return;
  }
  if (message.type === "hello") {
    extensionVersion = String(message.version || "");
    extensionBrowserName = String(message.browserName || "Chromium");
    return;
  }
  if (message.type === "cdp.event") {
    const tabId = Number(message.tabId);
    const method = String(message.method || "");
    if (!Number.isInteger(tabId) || !method) return;
    const payload = JSON.stringify({
      method,
      params: isRecord(message.params) ? message.params : {}
    });
    for (const socket of cdpProxySockets.get(tabId) || []) {
      if (socket.readyState === 1) socket.send(payload);
    }
    return;
  }
  if (message.type !== "response") return;
  const id = String(message.id || "");
  const pending = pendingCommands.get(id);
  if (!pending) return;
  pendingCommands.delete(id);
  clearTimeout(pending.timer);
  if (message.ok === false) {
    pending.reject(new Error(String(message.error || "浏览器扩展命令失败")));
  } else {
    pending.resolve(message.result);
  }
}

function clearExtensionSocket(socket: WebSocketLike): void {
  if (extensionSocket !== socket) return;
  extensionSocket = undefined;
  for (const sockets of cdpProxySockets.values()) {
    for (const proxy of sockets) proxy.close(1011, "UIWarden extension disconnected");
  }
  cdpProxySockets.clear();
  for (const [id, pending] of pendingCommands) {
    clearTimeout(pending.timer);
    pending.reject(new Error("UIWarden 浏览器扩展连接已断开"));
    pendingCommands.delete(id);
  }
}

function releaseCdpProxySocket(tabId: number, socket: WebSocketLike): void {
  const sockets = cdpProxySockets.get(tabId);
  if (!sockets) return;
  sockets.delete(socket);
  if (sockets.size > 0) return;
  cdpProxySockets.delete(tabId);
  void sendExtensionCommand("cdp.detach", { tabId }).catch(() => undefined);
}

function normalizeExtensionTab(value: Record<string, unknown>): ExtensionBridgeTab | undefined {
  const chromeTabId = Number(value.id ?? value.tabId);
  const windowId = Number(value.windowId);
  const url = String(value.url || "");
  if (!Number.isInteger(chromeTabId) || !Number.isInteger(windowId) || !url) return undefined;
  return {
    id: `chrome-tab-${chromeTabId}`,
    chromeTabId,
    windowId,
    title: String(value.title || url),
    url,
    active: value.active === true
  };
}

function parseTargetId(value: string): number {
  const match = /^chrome-tab-(\d+)$/.exec(String(value || ""));
  const tabId = match ? Number(match[1]) : NaN;
  if (!Number.isInteger(tabId) || tabId < 0) throw new Error(`无效的扩展标签页 target：${value}`);
  return tabId;
}

function isAllowedPageUrl(value: string): boolean {
  if (value.startsWith("about:blank#uiwarden-task-")) return true;
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    return url.pathname !== "/browser-extension-pair";
  } catch {
    return false;
  }
}

async function readPairingConfig(): Promise<ExtensionBridgeConfig | undefined> {
  try {
    const parsed = JSON.parse(await fs.readFile(PAIRING_FILE, "utf8")) as Partial<ExtensionBridgeConfig>;
    if (parsed.version !== 1 || typeof parsed.token !== "string" || parsed.token.length < 32) return undefined;
    return parsed as ExtensionBridgeConfig;
  } catch {
    return undefined;
  }
}

async function hasBrowserExtensionFiles(): Promise<boolean> {
  try {
    const manifest = JSON.parse(await fs.readFile(path.join(browserExtensionDir(), "manifest.json"), "utf8")) as {
      key?: unknown;
      background?: unknown;
      permissions?: unknown;
    };
    return typeof manifest.key === "string"
      && isRecord(manifest.background)
      && Array.isArray(manifest.permissions)
      && manifest.permissions.includes("debugger");
  } catch {
    return false;
  }
}

function normalizeHttpBase(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "http:" || !isLoopbackHost(url.hostname)) {
    throw new Error("浏览器扩展桥只允许本机 HTTP 地址");
  }
  url.pathname = "/";
  url.search = "";
  url.hash = "";
  return url.toString();
}

function isLoopbackHost(hostname: string): boolean {
  const value = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return value === "127.0.0.1" || value === "localhost" || value === "::1";
}

function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) return false;
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function supportsExistingTabTaskGroup(version: string | undefined): boolean {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(String(version || ""));
  if (!match) return false;
  const [major, minor] = [Number(match[1]), Number(match[2])];
  return major > 0 || minor >= 9;
}
