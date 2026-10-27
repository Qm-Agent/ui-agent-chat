import WebSocket from "ws";
import { randomUUID } from "node:crypto";
import { BrowserAutomationError } from "./error.mjs";

const DEFAULT_TIMEOUT_MS = 12_000;
const persistentTargets = new Map();

export function normalizeCdpUrl(value) {
  let url;
  try {
    url = new URL(String(value || ""));
  } catch {
    throw new BrowserAutomationError("INVALID_ARGUMENT", "cdpUrl 必须是有效 URL");
  }
  if (url.protocol !== "http:" || !isLoopback(url.hostname)) {
    throw new BrowserAutomationError("INVALID_ARGUMENT", "CDP 只能连接 127.0.0.1/localhost HTTP 地址");
  }
  url.pathname = url.pathname.replace(/\/$/, "");
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

export function normalizeNavigationUrl(value) {
  const raw = String(value || "").trim();
  if (raw === "about:blank") return raw;
  let url;
  try {
    url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    throw new BrowserAutomationError("INVALID_ARGUMENT", "导航地址必须是有效 HTTP/HTTPS URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new BrowserAutomationError("NAVIGATION_BLOCKED", `禁止导航到 ${url.protocol} 协议`);
  }
  return url.toString();
}

export async function listCdpTargets(cdpUrl) {
  const base = normalizeCdpUrl(cdpUrl);
  let response;
  try {
    response = await fetch(`${base}/json/list`, { signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS) });
  } catch (error) {
    throw new BrowserAutomationError("CDP_UNAVAILABLE", `无法连接 CDP：${error instanceof Error ? error.message : String(error)}`);
  }
  if (!response.ok) {
    throw new BrowserAutomationError("CDP_UNAVAILABLE", `CDP /json/list 返回 HTTP ${response.status}`);
  }
  const targets = await response.json();
  if (!Array.isArray(targets)) {
    throw new BrowserAutomationError("CDP_INVALID_RESPONSE", "CDP target 列表格式无效");
  }
  const targetInfoById = await listBrowserTargetInfo(base).catch(() => new Map());
  return targets.map((target) => ({
    targetId: String(target.id || target.targetId || ""),
    openerId: String(
      target.openerId
      || target.openerTargetId
      || targetInfoById.get(String(target.id || target.targetId || ""))?.openerId
      || ""
    ),
    parentTargetId: String(
      target.parentId
      || target.parentTargetId
      || targetInfoById.get(String(target.id || target.targetId || ""))?.parentFrameId
      || ""
    ),
    type: String(target.type || ""),
    title: String(target.title || ""),
    url: String(target.url || ""),
    webSocketDebuggerUrl: String(target.webSocketDebuggerUrl || "")
  }));
}

async function listBrowserTargetInfo(base) {
  const response = await fetch(`${base}/json/version`, { signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`CDP /json/version returned HTTP ${response.status}`);
  const version = await response.json();
  const webSocketDebuggerUrl = String(version.webSocketDebuggerUrl || "");
  if (!webSocketDebuggerUrl) return new Map();
  const client = await CdpClient.connect(webSocketDebuggerUrl);
  try {
    const result = await client.send("Target.getTargets");
    return new Map((Array.isArray(result.targetInfos) ? result.targetInfos : []).map((info) => [
      String(info.targetId || ""),
      {
        openerId: String(info.openerId || ""),
        parentFrameId: String(info.parentFrameId || "")
      }
    ]));
  } finally {
    client.close();
  }
}

export async function resolvePageTarget(cdpUrl, targetId) {
  const target = (await listCdpTargets(cdpUrl)).find((item) => item.targetId === targetId);
  if (!target || target.type !== "page" || !target.webSocketDebuggerUrl) {
    throw new BrowserAutomationError(
      "TARGET_GONE",
      `指定浏览器 target 不存在或不可操作：${targetId}`,
      { targetId },
      3
    );
  }
  return target;
}

export async function activateCdpTarget(cdpUrl, targetId) {
  const base = normalizeCdpUrl(cdpUrl);
  const response = await fetch(`${base}/json/activate/${encodeURIComponent(targetId)}`, {
    signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS)
  }).catch((error) => {
    throw new BrowserAutomationError("CDP_UNAVAILABLE", `无法激活浏览器标签页：${error instanceof Error ? error.message : String(error)}`);
  });
  if (!response.ok) {
    throw new BrowserAutomationError("TARGET_GONE", `浏览器标签页激活失败：HTTP ${response.status}`, { targetId }, 3);
  }
}

export async function withTarget(cdpUrl, targetId, operation) {
  if (process.env.DT_GUI_BROWSER_PERSISTENT_CDP === "1") {
    const entry = await persistentTarget(cdpUrl, targetId);
    return operation(entry.client, entry.target, {
      connectionId: entry.client.connectionId,
      connectedAt: entry.connectedAt,
      reused: entry.useCount > 1
    });
  }
  const target = await resolvePageTarget(cdpUrl, targetId);
  const client = await CdpClient.connect(target.webSocketDebuggerUrl);
  try {
    await client.send("Runtime.enable");
    await client.send("Page.enable");
    return await operation(client, target, {
      connectionId: client.connectionId,
      connectedAt: new Date().toISOString(),
      reused: false
    });
  } finally {
    client.close();
  }
}

export function closeTargetConnection(cdpUrl, targetId) {
  const key = targetConnectionKey(cdpUrl, targetId);
  const entry = persistentTargets.get(key);
  if (!entry) return false;
  persistentTargets.delete(key);
  entry.client.close();
  return true;
}

export function closeAllTargetConnections() {
  for (const entry of persistentTargets.values()) entry.client.close();
  persistentTargets.clear();
}

async function persistentTarget(cdpUrl, targetId) {
  const key = targetConnectionKey(cdpUrl, targetId);
  const current = persistentTargets.get(key);
  if (current?.client.isOpen()) {
    current.useCount += 1;
    return current;
  }
  if (current) {
    persistentTargets.delete(key);
    current.client.close();
  }
  const target = await resolvePageTarget(cdpUrl, targetId);
  const client = await CdpClient.connect(target.webSocketDebuggerUrl);
  await client.send("Runtime.enable");
  await client.send("Page.enable");
  const entry = {
    client,
    target,
    connectedAt: new Date().toISOString(),
    useCount: 1
  };
  client.onClosed(() => {
    if (persistentTargets.get(key)?.client === client) persistentTargets.delete(key);
  });
  persistentTargets.set(key, entry);
  return entry;
}

function targetConnectionKey(cdpUrl, targetId) {
  return `${normalizeCdpUrl(cdpUrl)}\n${String(targetId || "")}`;
}

export async function evaluate(client, expression) {
  const result = await client.send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true
  });
  if (result.exceptionDetails) {
    const description = result.exceptionDetails.exception?.description
      || result.exceptionDetails.text
      || "页面 JavaScript 执行失败";
    throw new BrowserAutomationError("PAGE_EVALUATION_FAILED", String(description));
  }
  return result.result?.value;
}

export class CdpClient {
  static async connect(url) {
    const socket = new WebSocket(url, { handshakeTimeout: DEFAULT_TIMEOUT_MS });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("CDP WebSocket 连接超时")), DEFAULT_TIMEOUT_MS);
      socket.once("open", () => {
        clearTimeout(timer);
        resolve();
      });
      socket.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
    }).catch((error) => {
      socket.close();
      throw new BrowserAutomationError("CDP_UNAVAILABLE", error instanceof Error ? error.message : String(error));
    });
    return new CdpClient(socket);
  }

  constructor(socket) {
    this.socket = socket;
    this.connectionId = `cdp-${randomUUID()}`;
    this.sequence = 0;
    this.pending = new Map();
    this.eventHandlers = new Map();
    this.closeHandlers = new Set();
    socket.on("message", (data) => {
      let message;
      try {
        message = JSON.parse(String(data));
      } catch {
        return;
      }
      if (!message.id) {
        const handlers = this.eventHandlers.get(String(message.method || ""));
        if (handlers) {
          for (const handler of handlers) handler(message.params || {});
        }
        return;
      }
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) {
        pending.reject(new BrowserAutomationError("CDP_COMMAND_FAILED", String(message.error.message || "CDP command failed"), message.error));
      } else {
        pending.resolve(message.result || {});
      }
    });
    socket.on("close", () => {
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(new BrowserAutomationError("TARGET_GONE", "CDP target 连接已关闭", {}, 3));
      }
      this.pending.clear();
      for (const handler of this.closeHandlers) handler();
      this.closeHandlers.clear();
    });
  }

  isOpen() {
    return this.socket.readyState === WebSocket.OPEN;
  }

  send(method, params = {}, timeoutMs = DEFAULT_TIMEOUT_MS, sessionId) {
    if (this.socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new BrowserAutomationError("TARGET_GONE", "CDP WebSocket 不可用", {}, 3));
    }
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new BrowserAutomationError("CDP_TIMEOUT", `${method} 超时`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      const message = sessionId ? { id, method, params, sessionId } : { id, method, params };
      this.socket.send(JSON.stringify(message), (error) => {
        if (!error) return;
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new BrowserAutomationError("CDP_UNAVAILABLE", error.message));
      });
    });
  }

  on(method, handler) {
    const handlers = this.eventHandlers.get(method) || new Set();
    handlers.add(handler);
    this.eventHandlers.set(method, handlers);
    return () => {
      handlers.delete(handler);
      if (handlers.size === 0) this.eventHandlers.delete(method);
    };
  }

  onClosed(handler) {
    this.closeHandlers.add(handler);
    return () => this.closeHandlers.delete(handler);
  }

  close() {
    this.eventHandlers.clear();
    if (this.socket.readyState === WebSocket.OPEN || this.socket.readyState === WebSocket.CONNECTING) {
      this.socket.close();
    }
  }
}

function isLoopback(hostname) {
  const normalized = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return normalized === "127.0.0.1" || normalized === "localhost" || normalized === "::1";
}
