import { createHash, randomUUID } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";

interface BrowserAutomationMcpOptions {
  sessionId: string;
  script: string;
  runtimeHome: string;
  node: string;
}

export interface BrowserAutomationMcpStatus {
  state: "starting" | "ready" | "stopped" | "failed";
  sessionId: string;
  endpoint: string;
  pid?: number;
  lastError?: string;
}

class BrowserAutomationMcpDaemon {
  private child?: ChildProcessWithoutNullStreams;
  private startPromise?: Promise<BrowserAutomationMcpStatus>;
  private endpoint = "";
  private lastError?: string;

  constructor(private readonly sessionId: string) {}

  async ensure(options: BrowserAutomationMcpOptions): Promise<BrowserAutomationMcpStatus> {
    const endpoint = browserAutomationMcpEndpoint(options.runtimeHome, options.sessionId);
    if (this.child && this.endpoint === endpoint && this.child.exitCode == null) {
      try {
        await request(endpoint, "ping", {}, 2_000);
        return this.status("ready");
      } catch {
        await this.stop();
      }
    }
    if (this.startPromise) return this.startPromise;
    this.startPromise = this.start(options, endpoint).finally(() => {
      this.startPromise = undefined;
    });
    return this.startPromise;
  }

  async callCli(args: string[], timeoutMs = 30_000): Promise<unknown> {
    if (!this.endpoint) throw new Error("dt-gui-browser 持久 MCP 尚未启动");
    return callCompatibility(this.endpoint, args, timeoutMs);
  }

  async stop(): Promise<void> {
    const child = this.child;
    const endpoint = this.endpoint;
    this.child = undefined;
    this.endpoint = "";
    if (child && child.exitCode == null) {
      child.kill("SIGTERM");
      await Promise.race([
        new Promise<void>((resolve) => child.once("exit", () => resolve())),
        delay(2_000)
      ]);
      if (child.exitCode == null) child.kill("SIGKILL");
    }
    if (endpoint && process.platform !== "win32") {
      await fs.rm(endpoint, { force: true }).catch(() => undefined);
    }
  }

  private async start(
    options: BrowserAutomationMcpOptions,
    endpoint: string
  ): Promise<BrowserAutomationMcpStatus> {
    await this.stop();
    if (process.platform !== "win32") await fs.rm(endpoint, { force: true });
    const child = spawn(options.node, [
      options.script,
      "mcp",
      "--session", options.sessionId,
      "--socket", endpoint
    ], {
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: process.env.ELECTRON_RUN_AS_NODE || "1",
        DT_GUI_BROWSER_HOME: options.runtimeHome,
        DT_GUI_BROWSER_PARENT_PID: String(process.pid),
        DT_GUI_BROWSER_PERSISTENT_CDP: "1"
      },
      stdio: ["pipe", "pipe", "pipe"]
    });
    this.child = child;
    this.endpoint = endpoint;
    this.lastError = undefined;
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr = `${stderr}${String(chunk)}`.slice(-8_000);
    });
    child.once("exit", (code, signal) => {
      if (this.child !== child) return;
      this.child = undefined;
      this.lastError = stderr.trim()
        || `dt-gui-browser MCP 退出（exit ${code ?? "unknown"}${signal ? `, signal ${signal}` : ""}）`;
    });
    child.once("error", (error) => {
      if (this.child === child) this.lastError = error.message;
    });
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      if (child.exitCode != null) break;
      try {
        await request(endpoint, "ping", {}, 500);
        return this.status("ready");
      } catch {
        await delay(40);
      }
    }
    const detail = stderr.trim() || this.lastError || "本地 MCP endpoint 未在 10 秒内就绪";
    await this.stop();
    this.lastError = detail;
    throw new Error(`dt-gui-browser 持久 MCP 启动失败：${detail}`);
  }

  private status(state: BrowserAutomationMcpStatus["state"]): BrowserAutomationMcpStatus {
    return {
      state,
      sessionId: this.sessionId,
      endpoint: this.endpoint,
      pid: this.child?.pid,
      lastError: this.lastError
    };
  }
}

const daemons = new Map<string, BrowserAutomationMcpDaemon>();

export async function ensureBrowserAutomationMcp(
  options: BrowserAutomationMcpOptions
): Promise<BrowserAutomationMcpStatus> {
  let daemon = daemons.get(options.sessionId);
  if (!daemon) {
    daemon = new BrowserAutomationMcpDaemon(options.sessionId);
    daemons.set(options.sessionId, daemon);
  }
  return daemon.ensure(options);
}

export async function callBrowserAutomationMcpCli<T>(
  sessionId: string,
  args: string[],
  timeoutMs?: number
): Promise<T> {
  const daemon = daemons.get(sessionId);
  if (!daemon) throw new Error(`dt-gui-browser MCP 会话不存在：${sessionId}`);
  return daemon.callCli(args, timeoutMs) as Promise<T>;
}

export async function stopBrowserAutomationMcp(sessionId: string): Promise<void> {
  const daemon = daemons.get(sessionId);
  daemons.delete(sessionId);
  await daemon?.stop();
}

export async function stopAllBrowserAutomationMcp(): Promise<void> {
  const active = [...daemons.values()];
  daemons.clear();
  await Promise.all(active.map((daemon) => daemon.stop()));
}

export function browserAutomationMcpEndpoint(runtimeHome: string, sessionId: string): string {
  const suffix = createHash("sha256")
    .update(`${path.resolve(runtimeHome)}\n${sessionId}`)
    .digest("hex")
    .slice(0, 16);
  return process.platform === "win32"
    ? `\\\\.\\pipe\\uiwarden-dt-gui-browser-${suffix}`
    : path.join("/tmp", `uiw-dt-gui-browser-${suffix}.sock`);
}

async function request(
  endpoint: string,
  method: string,
  params: Record<string, unknown>,
  timeoutMs: number
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(endpoint);
    const id = randomUUID();
    let buffer = "";
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`MCP ${method} 超时（${timeoutMs}ms）`));
    }, timeoutMs);
    const finish = (error?: Error, value?: Record<string, unknown>) => {
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error);
      else if (value) resolve(value);
    };
    socket.setEncoding("utf8");
    socket.once("error", (error) => finish(error));
    socket.on("data", (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      try {
        const response = JSON.parse(buffer.slice(0, newline)) as Record<string, unknown>;
        const protocolError = record(response.error);
        if (protocolError.message) finish(new Error(String(protocolError.message)));
        else finish(undefined, response);
      } catch {
        finish(new Error("浏览器 MCP 返回了无效 JSON"));
      }
    });
    socket.once("connect", () => {
      socket.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  });
}

async function callCompatibility(
  endpoint: string,
  args: string[],
  timeoutMs: number
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(endpoint);
    let buffer = "";
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`浏览器 MCP CLI 请求超时（${timeoutMs}ms）`));
    }, timeoutMs);
    const finish = (error?: Error, value?: unknown) => {
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error);
      else resolve(value);
    };
    socket.setEncoding("utf8");
    socket.once("error", (error) => finish(error));
    socket.on("data", (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      try {
        const envelope = JSON.parse(buffer.slice(0, newline)) as Record<string, unknown>;
        if (envelope.ok === true) finish(undefined, envelope.data);
        else {
          const failure = record(envelope.error);
          finish(Object.assign(
            new Error(String(failure.message || "浏览器 MCP CLI 调用失败")),
            { code: failure.code, details: failure.details }
          ));
        }
      } catch {
        finish(new Error("浏览器 MCP CLI 返回了无效 JSON"));
      }
    });
    socket.once("connect", () => {
      socket.write(Buffer.concat([
        Buffer.from("UIWARDEN_CLI_V1\0"),
        ...args.map((arg) => Buffer.from(`${arg}\0`)),
        Buffer.from("\0")
      ]));
    });
  });
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
