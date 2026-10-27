import { randomBytes, randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { dataDir, projectRoot } from "./paths.js";

const require = createRequire(import.meta.url);
const WebSocket = require("ws") as new (url: string, options?: Record<string, unknown>) => any;

interface CdpTarget {
  id: string;
  type: string;
  title?: string;
  url?: string;
  webSocketDebuggerUrl?: string;
}

interface ManagedRun {
  version: 1;
  kernel: "uiwarden-embedded";
  runId: string;
  sessionId: string;
  cdpUrl: string;
  targetId: string;
  pageUrl?: string;
  controlMode: "agent-control" | "human-control";
  startedAt: string;
}

export interface ServerManagedBrowserBridge {
  url: string;
  token: string;
  cdpUrl: string;
}

class ServerManagedBrowserHost {
  private browser?: ChildProcess;
  private bridge?: http.Server;
  private bridgeToken = randomBytes(32).toString("hex");
  private bridgeUrl = "";
  private cdpUrl = "";
  private activeTargetId = "";
  private activeRun?: ManagedRun;
  private stopping = false;

  async start(): Promise<ServerManagedBrowserBridge> {
    if (this.bridgeUrl && this.cdpUrl && await this.browserAlive()) return this.config();
    await this.startChromium();
    await this.startBridge();
    return this.config();
  }

  async stop(): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    const bridge = this.bridge;
    this.bridge = undefined;
    this.bridgeUrl = "";
    if (bridge) await new Promise<void>((resolve) => bridge.close(() => resolve()));
    const browser = this.browser;
    this.browser = undefined;
    if (browser && browser.exitCode == null) {
      browser.kill("SIGTERM");
      await Promise.race([
        new Promise<void>((resolve) => browser.once("exit", () => resolve())),
        new Promise<void>((resolve) => setTimeout(resolve, 2_000))
      ]);
      if (browser.exitCode == null) browser.kill("SIGKILL");
    }
    this.cdpUrl = "";
    this.activeTargetId = "";
    this.activeRun = undefined;
    this.stopping = false;
  }

  private config(): ServerManagedBrowserBridge {
    return { url: this.bridgeUrl, token: this.bridgeToken, cdpUrl: this.cdpUrl };
  }

  private async startChromium(): Promise<void> {
    const executable = await resolveChromiumExecutable();
    const cdpPort = await availablePort();
    const runtimeDataDir = path.resolve(process.env.UI_AGENT_DATA_DIR?.trim() || dataDir);
    const profileDir = path.join(runtimeDataDir, "server-managed-browser", "profile");
    await fs.mkdir(profileDir, { recursive: true });
    const args = [
      "--headless=new",
      "--remote-debugging-address=127.0.0.1",
      `--remote-debugging-port=${cdpPort}`,
      "--remote-allow-origins=*",
      `--user-data-dir=${profileDir}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-background-networking",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--no-zygote"
    ];
    if (typeof process.getuid === "function" && process.getuid() === 0) args.push("--no-sandbox");
    args.push("about:blank");
    const child = spawn(executable, args, { stdio: ["ignore", "pipe", "pipe"] });
    this.browser = child;
    child.stdout?.on("data", () => undefined);
    child.stderr?.on("data", (chunk) => {
      const message = String(chunk).trim();
      if (message && /error|fatal|failed/i.test(message)) console.warn(`[server-browser] ${message}`);
    });
    child.once("exit", (code, signal) => {
      if (!this.stopping) console.error(`[server-browser] Chromium exited code=${code ?? "unknown"} signal=${signal ?? ""}`);
      this.browser = undefined;
      this.cdpUrl = "";
      this.activeTargetId = "";
      this.activeRun = undefined;
    });
    this.cdpUrl = `http://127.0.0.1:${cdpPort}`;
    await waitForCdp(this.cdpUrl, child);
    this.activeTargetId = (await this.currentTarget()).id;
  }

  private async startBridge(): Promise<void> {
    if (this.bridge) return;
    const server = http.createServer((request, response) => {
      void this.handleBridgeRequest(request, response);
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      server.close();
      throw new Error("服务端 gui-browser 控制桥未取得随机端口");
    }
    this.bridge = server;
    this.bridgeUrl = `http://127.0.0.1:${address.port}`;
  }

  private async handleBridgeRequest(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    try {
      if (request.headers.authorization !== `Bearer ${this.bridgeToken}`) {
        sendJson(response, 401, { error: "Unauthorized" });
        return;
      }
      if (!await this.browserAlive()) throw new Error("服务端托管 Chromium 不可用");
      const requestUrl = new URL(request.url || "/", "http://127.0.0.1");
      if (request.method === "GET" && requestUrl.pathname === "/v1/browser/status") {
        const target = await this.currentTarget();
        sendJson(response, 200, {
          available: true,
          mode: "server-managed-headless",
          cdpUrl: this.cdpUrl,
          activeTargetId: target.id,
          controlMode: this.activeRun?.controlMode || "idle",
          activeRunId: this.activeRun?.runId
        });
        return;
      }
      if (request.method === "POST" && requestUrl.pathname === "/v1/browser/navigate") {
        const body = await readBody(request);
        const target = await this.openTarget(normalizeNavigationUrl(body.url));
        sendJson(response, 200, { targetId: target.id, url: target.url, cdpUrl: this.cdpUrl });
        return;
      }
      if (request.method === "POST" && requestUrl.pathname === "/v1/browser/runs") {
        const body = await readBody(request);
        sendJson(response, 200, await this.startRun(requiredString(body.sessionId, "sessionId")));
        return;
      }
      const runMatch = requestUrl.pathname.match(/^\/v1\/browser\/runs\/([^/]+)$/);
      if (runMatch && request.method === "GET") {
        const run = this.executionSession(runMatch[1]);
        sendJson(response, 200, run);
        return;
      }
      const controlMatch = requestUrl.pathname.match(/^\/v1\/browser\/runs\/([^/]+)\/control$/);
      if (controlMatch && request.method === "POST") {
        const body = await readBody(request);
        const run = this.executionSession(controlMatch[1]);
        if (body.mode !== "agent-control" && body.mode !== "human-control") throw new Error("无效控制模式");
        run.controlMode = body.mode;
        sendJson(response, 200, run);
        return;
      }
      if (runMatch && request.method === "DELETE") {
        const body = await readBody(request);
        const completed = { ...this.executionSession(runMatch[1]), stopReason: String(body.reason || "completed") };
        this.activeRun = undefined;
        sendJson(response, 200, completed);
        return;
      }
      sendJson(response, 404, { error: "Not found" });
    } catch (error) {
      sendJson(response, 400, { error: error instanceof Error ? error.message : String(error) });
    }
  }

  private async startRun(sessionId: string): Promise<ManagedRun> {
    if (this.activeRun && this.activeRun.sessionId !== sessionId) throw new Error("另一个会话正在使用服务端 gui-browser");
    const target = await this.currentTarget();
    this.activeRun = {
      version: 1,
      kernel: "uiwarden-embedded",
      runId: this.activeRun?.runId || randomUUID(),
      sessionId,
      cdpUrl: this.cdpUrl,
      targetId: target.id,
      pageUrl: target.url,
      controlMode: "agent-control",
      startedAt: new Date().toISOString()
    };
    return this.activeRun;
  }

  private executionSession(runId: string): ManagedRun {
    if (!this.activeRun || this.activeRun.runId !== runId) throw new Error("run 不存在");
    return this.activeRun;
  }

  private async currentTarget(): Promise<CdpTarget> {
    const targets = await fetchJson<CdpTarget[]>(`${this.cdpUrl}/json/list`);
    const pages = targets.filter((target) => target.type === "page" && !String(target.url || "").startsWith("devtools://"));
    let target = pages.find((candidate) => candidate.id === this.activeTargetId) || pages[0];
    if (!target) target = await this.openTarget("about:blank", false);
    this.activeTargetId = target.id;
    return target;
  }

  private async openTarget(url: string, closePrevious = true): Promise<CdpTarget> {
    const previous = this.activeTargetId;
    const target = await fetchJson<CdpTarget>(`${this.cdpUrl}/json/new?${encodeURIComponent(url)}`, { method: "PUT" });
    if (!target.id) throw new Error("服务端 gui-browser 未返回 targetId");
    this.activeTargetId = target.id;
    if (url !== "about:blank") await navigateTarget(target, url);
    const readyTarget = url === "about:blank" ? target : await this.waitForTargetNavigation(target.id);
    if (closePrevious && previous && previous !== target.id && !this.activeRun) {
      await fetch(`${this.cdpUrl}/json/close/${encodeURIComponent(previous)}`, { signal: AbortSignal.timeout(2_000) }).catch(() => undefined);
    }
    return readyTarget;
  }

  private async waitForTargetNavigation(targetId: string): Promise<CdpTarget> {
    const deadline = Date.now() + 8_000;
    while (Date.now() < deadline) {
      const targets = await fetchJson<CdpTarget[]>(`${this.cdpUrl}/json/list`);
      const target = targets.find((candidate) => candidate.id === targetId);
      if (target && target.url && target.url !== "about:blank") return target;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error("服务端 gui-browser 页面导航 8 秒内未开始");
  }

  private async browserAlive(): Promise<boolean> {
    if (!this.browser || this.browser.exitCode != null || !this.cdpUrl) return false;
    try {
      const version = await fetchJson<Record<string, unknown>>(`${this.cdpUrl}/json/version`);
      return typeof version.webSocketDebuggerUrl === "string";
    } catch {
      return false;
    }
  }
}

let singleton: Promise<ServerManagedBrowserHost> | undefined;
let hooksRegistered = false;

export async function getServerManagedBrowserBridge(): Promise<ServerManagedBrowserBridge> {
  if (!singleton) {
    singleton = (async () => {
      const host = new ServerManagedBrowserHost();
      try {
        await host.start();
        registerShutdownHooks();
        return host;
      } catch (error) {
        await host.stop().catch(() => undefined);
        throw error;
      }
    })().catch((error) => {
      singleton = undefined;
      throw error;
    });
  }
  return (await singleton).start();
}

export async function stopServerManagedBrowser(): Promise<void> {
  const current = singleton;
  singleton = undefined;
  if (current) await (await current).stop();
}

function registerShutdownHooks(): void {
  if (hooksRegistered) return;
  hooksRegistered = true;
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      void stopServerManagedBrowser().finally(() => process.kill(process.pid, signal));
    });
  }
}

async function resolveChromiumExecutable(): Promise<string> {
  const bundledCandidates = [
    process.env.UIWARDEN_SERVER_BROWSER_EXECUTABLE,
    process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
    "/usr/local/bin/uiwarden-chromium",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser"
  ].filter((value): value is string => Boolean(value?.trim()));
  for (const candidate of bundledCandidates) {
    if (await executableFile(candidate)) return path.resolve(candidate);
  }
  const discoveryRoots = [
    process.env.PLAYWRIGHT_BROWSERS_PATH,
    "/ms-playwright",
    path.join(os.homedir(), "Library", "Caches", "ms-playwright"),
    path.join(os.homedir(), ".cache", "ms-playwright"),
    path.join(os.homedir(), "AppData", "Local", "ms-playwright"),
    path.join(projectRoot, "node_modules", "playwright-core", ".local-browsers")
  ].filter((value): value is string => Boolean(value?.trim()));
  for (const root of [...new Set(discoveryRoots.map((value) => path.resolve(value)))]) {
    const discovered = await findChromium(root, 6);
    if (discovered) return discovered;
  }
  const systemCandidates = [
    "/usr/bin/google-chrome",
    "/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    process.env.PROGRAMFILES ? path.join(process.env.PROGRAMFILES, "Google", "Chrome", "Application", "chrome.exe") : undefined,
    process.env["PROGRAMFILES(X86)"] ? path.join(process.env["PROGRAMFILES(X86)"]!, "Google", "Chrome", "Application", "chrome.exe") : undefined,
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, "Google", "Chrome", "Application", "chrome.exe") : undefined
  ].filter((value): value is string => Boolean(value?.trim()));
  for (const candidate of systemCandidates) {
    if (await executableFile(candidate)) return path.resolve(candidate);
  }
  throw new Error("服务端 gui-browser 找不到 Chromium；请设置 UIWARDEN_SERVER_BROWSER_EXECUTABLE");
}

async function findChromium(root: string, depth: number): Promise<string | undefined> {
  if (depth < 0) return undefined;
  const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const candidate = path.join(root, entry.name);
    if (entry.isFile() && isPlaywrightChromiumExecutable(candidate) && await executableFile(candidate)) return candidate;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || /headless_shell/i.test(entry.name)) continue;
    const found = await findChromium(path.join(root, entry.name), depth - 1);
    if (found) return found;
  }
  return undefined;
}

function isPlaywrightChromiumExecutable(candidate: string): boolean {
  const normalized = candidate.replaceAll("\\", "/");
  if (/\/chrome-linux[^/]*\/chrome$/.test(normalized)) return true;
  if (/\/chrome-mac[^/]*\/Google Chrome for Testing\.app\/Contents\/MacOS\/Google Chrome for Testing$/.test(normalized)) return true;
  return /\/chrome-win[^/]*\/chrome\.exe$/i.test(normalized);
}

async function executableFile(candidate: string): Promise<boolean> {
  try {
    await fs.access(candidate, 1);
    return (await fs.stat(candidate)).isFile();
  } catch {
    return false;
  }
}

async function availablePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("无法分配 Chromium CDP 端口");
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}

async function waitForCdp(cdpUrl: string, child: ChildProcess): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (child.exitCode != null) throw new Error(`服务端 Chromium 启动失败（exit ${child.exitCode}）`);
    try {
      const version = await fetchJson<Record<string, unknown>>(`${cdpUrl}/json/version`);
      if (typeof version.webSocketDebuggerUrl === "string") return;
    } catch {
      // Chromium is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  child.kill("SIGKILL");
  throw new Error("服务端 Chromium CDP 15 秒内未就绪");
}

async function navigateTarget(target: CdpTarget, url: string): Promise<void> {
  if (!target.webSocketDebuggerUrl) throw new Error("服务端 gui-browser target 缺少 CDP WebSocket");
  const socket = new WebSocket(target.webSocketDebuggerUrl, { handshakeTimeout: 5_000 });
  let sequence = 0;
  const pending = new Map<number, {
    resolve: (value: Record<string, unknown>) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
  }>();
  socket.on("message", (data: unknown) => {
    let payload: { id?: number; result?: Record<string, unknown>; error?: { message?: string } };
    try {
      payload = JSON.parse(String(data));
    } catch {
      return;
    }
    if (!payload.id) return;
    const request = pending.get(payload.id);
    if (!request) return;
    pending.delete(payload.id);
    clearTimeout(request.timer);
    if (payload.error) request.reject(new Error(payload.error.message || "CDP command failed"));
    else request.resolve(payload.result || {});
  });
  const opened = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("服务端 gui-browser CDP WebSocket 连接超时")), 5_000);
    socket.once("open", () => { clearTimeout(timer); resolve(); });
    socket.once("error", (error: Error) => { clearTimeout(timer); reject(error); });
  });
  const send = (method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> => {
    const id = ++sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`CDP command ${method} timed out`));
      }, 5_000);
      pending.set(id, { resolve, reject, timer });
      socket.send(JSON.stringify({ id, method, params }), (error?: Error) => {
        if (!error) return;
        const request = pending.get(id);
        if (request) clearTimeout(request.timer);
        pending.delete(id);
        reject(error);
      });
    });
  };
  try {
    await opened;
    await send("Page.enable");
    await send("Runtime.enable");
    await send("Page.navigate", { url });
    const deadline = Date.now() + 8_000;
    while (Date.now() < deadline) {
      const result = await send("Runtime.evaluate", {
        expression: "({url: location.href, readyState: document.readyState})",
        returnByValue: true
      });
      const value = (result.result as { value?: { url?: string; readyState?: string } } | undefined)?.value;
      if (value?.url && value.url !== "about:blank" && value.readyState !== "loading") return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error("服务端 gui-browser 页面 8 秒内未完成导航");
  } finally {
    socket.close();
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(new Error("CDP WebSocket 已关闭"));
    }
    pending.clear();
  }
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { ...init, signal: init?.signal || AbortSignal.timeout(3_000) });
  if (!response.ok) throw new Error(`Chromium CDP HTTP ${response.status}`);
  return response.json() as Promise<T>;
}

function normalizeNavigationUrl(value: unknown): string {
  const raw = String(value || "").trim();
  if (!raw || raw === "about:blank") return "about:blank";
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : `https://${raw}`;
  const parsed = new URL(withScheme);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("服务端 gui-browser 只允许 HTTP/HTTPS 页面");
  return parsed.toString();
}

async function readBody(request: http.IncomingMessage): Promise<Record<string, unknown>> {
  let raw = "";
  for await (const chunk of request) {
    raw += chunk;
    if (raw.length > 1_000_000) throw new Error("请求体过大");
  }
  if (!raw) return {};
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("请求体必须是 JSON 对象");
  return parsed as Record<string, unknown>;
}

function requiredString(value: unknown, field: string): string {
  const normalized = String(value || "").trim();
  if (!normalized) throw new Error(`${field} 不能为空`);
  return normalized;
}

function sendJson(response: http.ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}
