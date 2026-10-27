import readline from "node:readline";
import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { asGuiAutomationError, GuiAutomationError } from "./error.js";

export interface McpServerOptions {
  serverName: string;
  serverVersion: string;
  tools: unknown[];
  toolCapabilities?: Record<string, unknown>;
  parentPid?: number;
  callTool(name: string, args: Record<string, unknown>): Promise<unknown>;
  compatibilityCall?(args: string[]): Promise<unknown>;
}

const CLI_COMPATIBILITY_PREFIX = "UIWARDEN_CLI_V1\0";
const MAX_COMPATIBILITY_PAYLOAD_BYTES = 4 * 1024 * 1024;

export async function runMcpJsonLines(options: McpServerOptions): Promise<void> {
  const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of input) {
    const response = await handleMcpLine(options, line);
    if (response) process.stdout.write(`${response}\n`);
  }
}

/** 在仅本机可访问的 Unix socket / Windows named pipe 上运行常驻 MCP 服务。 */
export async function runMcpSocket(options: McpServerOptions, endpoint: string): Promise<void> {
  await prepareSocketEndpoint(endpoint);
  const sockets = new Set<net.Socket>();
  const server = net.createServer({ allowHalfOpen: true }, (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    routeSocketProtocol(options, socket);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(endpoint, () => {
      server.off("error", reject);
      resolve();
    });
  });
  if (process.platform !== "win32") await fs.chmod(endpoint, 0o600);
  const close = () => {
    for (const socket of sockets) socket.destroy();
    if (server.listening) server.close();
  };
  const parentMonitor = options.parentPid && options.parentPid !== process.pid
    ? setInterval(() => {
        try {
          process.kill(options.parentPid!, 0);
        } catch {
          close();
        }
      }, 1_000)
    : undefined;
  parentMonitor?.unref();
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("close", resolve);
      server.once("error", reject);
    });
  } finally {
    if (parentMonitor) clearInterval(parentMonitor);
    process.off("SIGINT", close);
    process.off("SIGTERM", close);
    if (process.platform !== "win32") await fs.rm(endpoint, { force: true });
  }
}

/** 向常驻 MCP socket 发起一次 JSON-RPC 请求。 */
export async function callMcpSocket(
  endpoint: string,
  request: Record<string, unknown>,
  timeoutMs = 30_000
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(endpoint);
    let buffer = "";
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`MCP 请求超时（${timeoutMs}ms）`));
    }, timeoutMs);
    const finish = (error?: Error, response?: Record<string, unknown>) => {
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error);
      else if (response) resolve(response);
    };
    socket.setEncoding("utf8");
    socket.once("error", (error) => finish(error));
    socket.on("data", (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      try {
        finish(undefined, JSON.parse(buffer.slice(0, newline)) as Record<string, unknown>);
      } catch {
        finish(new Error("MCP socket 返回了无效 JSON"));
      }
    });
    socket.once("connect", () => socket.write(`${JSON.stringify(request)}\n`));
  });
}

/** 调用 MCP tool，并返回 structuredContent 中的业务数据。 */
export async function callMcpToolSocket(
  endpoint: string,
  name: string,
  args: Record<string, unknown>,
  timeoutMs = 30_000
): Promise<unknown> {
  const response = await callMcpSocket(endpoint, {
    jsonrpc: "2.0",
    id: `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    method: "tools/call",
    params: { name, arguments: args }
  }, timeoutMs);
  const protocolError = objectValue(response.error);
  if (protocolError.message) throw new Error(String(protocolError.message));
  const resultValue = objectValue(response.result);
  const structured = objectValue(resultValue.structuredContent);
  if (structured.ok === false) {
    const failure = objectValue(structured.error);
    throw new GuiAutomationError(
      String(failure.code || "MCP_TOOL_FAILED"),
      String(failure.message || "MCP tool 执行失败"),
      { details: failure.details }
    );
  }
  if (structured.ok === true && Object.hasOwn(structured, "data")) return structured.data;
  return resultValue;
}

/** 通过 MCP socket 调用保持 CLI 参数兼容的受限入口。 */
export async function callCliCompatibilitySocket(
  endpoint: string,
  args: string[],
  timeoutMs = 30_000
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(endpoint);
    let buffer = "";
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`MCP CLI 兼容请求超时（${timeoutMs}ms）`));
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
        if (envelope.ok === true) {
          finish(undefined, envelope.data);
          return;
        }
        const failure = objectValue(envelope.error);
        finish(new GuiAutomationError(
          String(failure.code || "MCP_CLI_FAILED"),
          String(failure.message || "MCP CLI 兼容调用失败"),
          { details: failure.details }
        ));
      } catch {
        finish(new Error("MCP CLI 兼容入口返回了无效 JSON"));
      }
    });
    socket.once("connect", () => {
      const payload = Buffer.concat([
        Buffer.from(CLI_COMPATIBILITY_PREFIX),
        ...args.map((arg) => Buffer.from(`${arg}\0`)),
        Buffer.from("\0")
      ]);
      if (payload.length > MAX_COMPATIBILITY_PAYLOAD_BYTES) {
        finish(new Error("MCP CLI 兼容请求超过 4MB"));
        return;
      }
      socket.write(payload);
    });
  });
}

export async function handleMcpRequest(options: McpServerOptions, request: Record<string, unknown>): Promise<unknown> {
  const id = request.id;
  const method = String(request.method || "");
  if (method === "notifications/initialized") return null;
  if (method === "initialize") {
    return result(id, {
      protocolVersion: "2025-03-26",
      capabilities: { tools: options.toolCapabilities || {} },
      serverInfo: { name: options.serverName, version: options.serverVersion }
    });
  }
  if (method === "ping") return result(id, {});
  if (method === "tools/list") return result(id, { tools: options.tools });
  if (method === "tools/call") {
    const params = objectValue(request.params);
    const name = String(params.name || "");
    const args = objectValue(params.arguments);
    try {
      const data = await options.callTool(name, args);
      const payload = { ok: true, data };
      return result(id, {
        content: [{ type: "text", text: JSON.stringify(payload) }],
        structuredContent: payload,
        isError: false
      });
    } catch (error) {
      const failure = asGuiAutomationError(error);
      const payload = failure.envelope();
      return result(id, {
        content: [{ type: "text", text: JSON.stringify(payload) }],
        structuredContent: payload,
        isError: true
      });
    }
  }
  return { jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } };
}

function result(id: unknown, value: unknown): unknown {
  return { jsonrpc: "2.0", id, result: value };
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

async function handleMcpLine(options: McpServerOptions, line: string): Promise<string | undefined> {
  if (!line.trim()) return undefined;
  let request: Record<string, unknown> | undefined;
  try {
    request = JSON.parse(line) as Record<string, unknown>;
    if (!Object.hasOwn(request, "id")) return undefined;
    const response = await handleMcpRequest(options, request);
    return response ? JSON.stringify(response) : undefined;
  } catch (error) {
    const failure = asGuiAutomationError(error);
    return JSON.stringify({
      jsonrpc: "2.0",
      id: request?.id ?? null,
      error: { code: -32000, message: failure.message, data: { code: failure.code, details: failure.details } }
    });
  }
}

async function prepareSocketEndpoint(endpoint: string): Promise<void> {
  if (process.platform === "win32") return;
  await fs.mkdir(path.dirname(endpoint), { recursive: true });
  await fs.rm(endpoint, { force: true });
}

function routeSocketProtocol(options: McpServerOptions, socket: net.Socket): void {
  const prefixBytes = Buffer.byteLength(CLI_COMPATIBILITY_PREFIX);
  const chunks: Buffer[] = [];
  let size = 0;
  const inspect = (chunk: Buffer) => {
    chunks.push(chunk);
    size += chunk.length;
    const buffered = Buffer.concat(chunks, size);
    if (buffered.length < prefixBytes && !buffered.includes(10)) return;
    socket.off("data", inspect);
    if (buffered.subarray(0, prefixBytes).toString() === CLI_COMPATIBILITY_PREFIX) {
      handleCompatibilitySocket(options, socket, buffered);
      return;
    }
    socket.unshift(buffered);
    handleJsonRpcSocket(options, socket);
  };
  socket.on("data", inspect);
}

function handleJsonRpcSocket(options: McpServerOptions, socket: net.Socket): void {
  const input = readline.createInterface({ input: socket, crlfDelay: Infinity });
  void (async () => {
    for await (const line of input) {
      const response = await handleMcpLine(options, line);
      if (response && !socket.destroyed) socket.write(`${response}\n`);
    }
  })().catch(() => socket.destroy());
}

function handleCompatibilitySocket(
  options: McpServerOptions,
  socket: net.Socket,
  firstChunk: Buffer
): void {
  const chunks = [firstChunk];
  let size = firstChunk.length;
  let handled = false;
  const onData = (chunk: Buffer) => {
    size += chunk.length;
    if (size > MAX_COMPATIBILITY_PAYLOAD_BYTES) {
      socket.destroy(new Error("CLI 兼容请求超过 4MB"));
      return;
    }
    chunks.push(chunk);
    consume();
  };
  const consume = () => {
    if (handled) return;
    const payload = Buffer.concat(chunks);
    if (payload.length < 2 || payload[payload.length - 1] !== 0 || payload[payload.length - 2] !== 0) return;
    handled = true;
    socket.off("data", onData);
    void (async () => {
      try {
        if (!options.compatibilityCall) throw new GuiAutomationError("UNSUPPORTED", "当前 MCP 服务未启用 CLI 兼容入口");
        const argumentsPayload = payload.subarray(
          Buffer.byteLength(CLI_COMPATIBILITY_PREFIX),
          payload.length - 1
        );
        const args = argumentsPayload.toString("utf8").split("\0").filter((value, index, items) => {
          return value.length > 0 || index < items.length - 1;
        });
        const data = await options.compatibilityCall(args);
        socket.end(`${JSON.stringify({ ok: true, data })}\n`);
      } catch (error) {
        socket.end(`${JSON.stringify(asGuiAutomationError(error).envelope())}\n`);
      }
    })().catch(() => socket.destroy());
  };
  socket.on("data", onData);
  consume();
}
