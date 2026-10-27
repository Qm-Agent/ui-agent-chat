import { createHash, randomUUID } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";

export interface NativeAutomationMcpStatus {
  mode: "mcp";
  state: "starting" | "ready" | "stopped" | "failed";
  endpoint: string;
  pid?: number;
  lastError?: string;
}

interface NativeAutomationMcpOptions {
  binary: string;
  runtimeHome: string;
  node: string;
}

class NativeAutomationMcpDaemon {
  private child?: ChildProcessWithoutNullStreams;
  private startPromise?: Promise<NativeAutomationMcpStatus>;
  private endpoint?: string;
  private lastError?: string;

  async ensure(options: NativeAutomationMcpOptions): Promise<NativeAutomationMcpStatus> {
    const endpoint = nativeAutomationMcpEndpoint(options.runtimeHome);
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

  async callTool<T>(
    options: NativeAutomationMcpOptions,
    name: string,
    args: Record<string, unknown>,
    timeoutMs = 30_000
  ): Promise<T> {
    const status = await this.ensure(options);
    const response = await request(status.endpoint, "tools/call", {
      name,
      arguments: args
    }, timeoutMs);
    const result = record(response.result);
    const structured = record(result.structuredContent);
    if (structured.ok === false) {
      const failure = record(structured.error);
      throw Object.assign(new Error(String(failure.message || "原生自动化 MCP tool 执行失败")), {
        code: String(failure.code || "NATIVE_AUTOMATION_FAILED"),
        details: failure.details
      });
    }
    if (structured.ok !== true || !Object.hasOwn(structured, "data")) {
      throw new Error("原生自动化 MCP 返回缺少 structuredContent");
    }
    return structured.data as T;
  }

  async stop(): Promise<void> {
    const child = this.child;
    const endpoint = this.endpoint;
    this.child = undefined;
    this.endpoint = undefined;
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

  currentStatus(): NativeAutomationMcpStatus {
    if (this.child && this.child.exitCode == null) return this.status("ready");
    return this.status(this.lastError ? "failed" : "stopped");
  }

  private async start(
    options: NativeAutomationMcpOptions,
    endpoint: string
  ): Promise<NativeAutomationMcpStatus> {
    await this.stop();
    if (process.platform !== "win32") await fs.rm(endpoint, { force: true });
    const executable = process.platform === "win32" && options.binary.toLowerCase().endsWith(".cmd")
      ? options.node
      : options.binary;
    const executableArgs = executable === options.binary
      ? ["--runtime-home", options.runtimeHome, "mcp", "--socket", endpoint]
      : [
          path.join(path.dirname(options.binary), "dist", "cli.js"),
          "--runtime-home", options.runtimeHome,
          "mcp", "--socket", endpoint
        ];
    const child = spawn(executable, executableArgs, {
      env: {
        ...process.env,
        DT_GUI_COMPUTER_HOME: options.runtimeHome,
        DT_GUI_COMPUTER_NODE: options.node,
        DT_GUI_COMPUTER_PARENT_PID: String(process.pid),
        DT_GUI_COMPUTER_PROVIDER_PERSISTENT: "1"
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
        || `dt-gui-computer MCP 退出（exit ${code ?? "unknown"}${signal ? `, signal ${signal}` : ""}）`;
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
    throw new Error(`dt-gui-computer 持久 MCP 启动失败：${detail}`);
  }

  private status(state: NativeAutomationMcpStatus["state"]): NativeAutomationMcpStatus {
    return {
      mode: "mcp",
      state,
      endpoint: this.endpoint || "",
      pid: this.child?.pid,
      lastError: this.lastError
    };
  }
}

const daemon = new NativeAutomationMcpDaemon();

export async function ensureNativeAutomationMcp(
  options: NativeAutomationMcpOptions
): Promise<NativeAutomationMcpStatus> {
  return daemon.ensure(options);
}

export async function callNativeAutomationMcp<T>(
  options: NativeAutomationMcpOptions,
  name: string,
  args: Record<string, unknown>,
  timeoutMs?: number
): Promise<T> {
  return daemon.callTool<T>(options, name, args, timeoutMs);
}

export async function stopNativeAutomationMcp(): Promise<void> {
  await daemon.stop();
}

export function getNativeAutomationMcpStatus(): NativeAutomationMcpStatus {
  return daemon.currentStatus();
}

export async function writeNativeAutomationMcpLauncher(input: NativeAutomationMcpOptions & {
  dataDir: string;
  endpoint: string;
}): Promise<string> {
  const directory = path.join(input.dataDir, "native-automation", "bin");
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const launcher = path.join(
    directory,
    process.platform === "win32" ? "dt-gui-computer-mcp.cmd" : "dt-gui-computer-mcp"
  );
  const content = process.platform === "win32"
    ? [
        "@echo off",
        "setlocal",
        `set "DT_GUI_COMPUTER_MCP_ENDPOINT=${input.endpoint}"`,
        `set "DT_GUI_COMPUTER_HOME=${input.runtimeHome}"`,
        `"${input.binary}" %*`,
        ""
      ].join("\r\n")
    : [
        "#!/bin/sh",
        "set -eu",
        "if [ -x /usr/bin/nc ]; then",
        "  set +e",
        `  RESPONSE=$({ printf 'UIWARDEN_CLI_V1\\0'; printf '%s\\0' "$@"; printf '\\0'; } | /usr/bin/nc -U ${shellQuote(input.endpoint)})`,
        "  STATUS=$?",
        "  set -e",
        "  if [ \"$STATUS\" -ne 0 ] || [ -z \"$RESPONSE\" ]; then",
        `    printf '%s\\n' '{"ok":false,"error":{"code":"MCP_UNAVAILABLE","message":"dt-gui-computer 持久 MCP 连接失败","details":{}}}'`,
        "    exit 2",
        "  fi",
        "  printf '%s\\n' \"$RESPONSE\"",
        "  case \"$RESPONSE\" in",
        "    '{\"ok\":true,'*) exit 0 ;;",
        "    *) exit 2 ;;",
        "  esac",
        "fi",
        `export DT_GUI_COMPUTER_MCP_ENDPOINT=${shellQuote(input.endpoint)}`,
        `export DT_GUI_COMPUTER_HOME=${shellQuote(input.runtimeHome)}`,
        `exec ${shellQuote(input.binary)} "$@"`,
        ""
      ].join("\n");
  const temporary = `${launcher}.${process.pid}.tmp`;
  await fs.writeFile(temporary, content, { encoding: "utf8", mode: 0o700 });
  await fs.rename(temporary, launcher);
  if (process.platform !== "win32") await fs.chmod(launcher, 0o700);
  return launcher;
}

export function nativeAutomationMcpEndpoint(runtimeHome: string): string {
  const suffix = createHash("sha256").update(path.resolve(runtimeHome)).digest("hex").slice(0, 16);
  return process.platform === "win32"
    ? `\\\\.\\pipe\\uiwarden-dt-gui-computer-${suffix}`
    : path.join("/tmp", `uiw-dt-gui-computer-${suffix}.sock`);
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
        if (protocolError.message) {
          finish(new Error(String(protocolError.message)));
          return;
        }
        finish(undefined, response);
      } catch {
        finish(new Error("原生自动化 MCP 返回了无效 JSON"));
      }
    });
    socket.once("connect", () => {
      socket.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  });
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
