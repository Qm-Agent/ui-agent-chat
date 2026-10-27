import { execFile, execFileSync, spawn } from "node:child_process";
import path from "node:path";
import readline from "node:readline";
import { promisify } from "node:util";
import { aiworkDistributionForExecutable } from "./depsCheck.js";
import type { ExecutionRuntimeId } from "./types.js";

const execFileAsync = promisify(execFile);

export type ExecutionStreamProtocol = "cfuse-stream-json" | "codex-jsonl" | "dtcoder-stream-json";

export interface NormalizedExecutionEvent {
  sdkSessionId?: string;
  actualModel?: string;
  text?: string;
  tool?: Record<string, unknown>;
  logs?: string[];
  result?: Record<string, unknown>;
}

export interface ExecutionRuntimeCommandInput {
  runtimeId: Exclude<ExecutionRuntimeId, "claude-code">;
  executable: string;
  prompt: string;
  cwd: string;
  resumeSessionId?: string;
  conversationId: string;
  model?: string;
  allowedTools?: string[];
}

export interface RunExecutionRuntimeInput extends ExecutionRuntimeCommandInput {
  env: Record<string, string>;
  abortSignal: AbortSignal;
  startupTimeoutMs?: number;
}

interface ParserState {
  hasAnswer?: boolean;
  hasResult?: boolean;
  semanticError?: string;
  diagnostics?: string[];
}

export interface CfuseCliCapabilities {
  probeStatus?: "ok" | "unavailable";
  print?: string;
  outputFormat?: string;
  model?: string;
  settingSources?: string;
  permissionMode?: string;
  includePartialMessages?: string;
  verbose?: string;
  allowedTools?: string;
  resume?: string;
}

const FULL_CFUSE_CAPABILITIES: CfuseCliCapabilities = {
  probeStatus: "ok",
  print: "-p",
  outputFormat: "--output-format",
  model: "--model",
  settingSources: "--setting-sources",
  permissionMode: "--permission-mode",
  includePartialMessages: "--include-partial-messages",
  verbose: "--verbose",
  allowedTools: "--allowedTools",
  resume: "--resume"
};

const cfuseCapabilityCache = new Map<string, CfuseCliCapabilities>();

export function executionStreamProtocol(runtimeId: Exclude<ExecutionRuntimeId, "claude-code">): ExecutionStreamProtocol {
  if (runtimeId === "codex") return "codex-jsonl";
  if (runtimeId === "dtcoder") return "dtcoder-stream-json";
  return "cfuse-stream-json";
}

export function buildExecutionRuntimeCommand(
  input: ExecutionRuntimeCommandInput,
  cfuseCapabilities: CfuseCliCapabilities = FULL_CFUSE_CAPABILITIES
): string[] {
  const modelArgs = input.model?.trim() ? ["--model", input.model.trim()] : [];
  if (input.runtimeId === "cfuse") {
    const args: string[] = [];
    const outputFormat = cfuseCapabilities.verbose ? "stream-json" : "json";
    if (cfuseCapabilities.settingSources) {
      args.push(cfuseCapabilities.settingSources, "project,local");
    }
    if (cfuseCapabilities.permissionMode) {
      args.push(cfuseCapabilities.permissionMode, "bypassPermissions");
    }
    args.push(cfuseCapabilities.outputFormat || "--output-format", outputFormat);
    if (outputFormat === "stream-json" && cfuseCapabilities.includePartialMessages) {
      args.push(cfuseCapabilities.includePartialMessages);
    }
    if (outputFormat === "stream-json" && cfuseCapabilities.verbose) {
      args.push(cfuseCapabilities.verbose);
    }
    if (input.model?.trim() && cfuseCapabilities.model) {
      args.push(cfuseCapabilities.model, input.model.trim());
    }
    if (input.allowedTools?.length && cfuseCapabilities.allowedTools) {
      args.push(cfuseCapabilities.allowedTools, input.allowedTools.join(","));
    }
    if (input.resumeSessionId && cfuseCapabilities.resume) {
      args.push(cfuseCapabilities.resume, input.resumeSessionId);
    }
    return [input.executable, ...args, cfuseCapabilities.print || "-p", input.prompt];
  }

  if (input.runtimeId === "codex") {
    const common = [
      "--json",
      "--skip-git-repo-check",
      "--dangerously-bypass-approvals-and-sandbox",
      ...modelArgs
    ];
    if (input.resumeSessionId) {
      return [input.executable, "exec", "resume", ...common, input.resumeSessionId, input.prompt];
    }
    return [input.executable, "exec", ...common, "--cd", input.cwd, input.prompt];
  }

  if (input.runtimeId === "dtcoder" && isAiworkExecutable(input.executable)) {
    return [
      input.executable,
      "chat",
      "--agent", "coder",
      "--session", safeSessionLabel(input.conversationId),
      "--message", input.prompt,
      "--json",
      "--dangerously-skip-permissions",
      ...modelArgs
    ];
  }

  const sessionLabel = safeSessionLabel(input.resumeSessionId || input.conversationId);
  return [
    input.executable,
    "-p",
    "--output-format", "stream-json",
    "--permission-mode", "bypassPermissions",
    "--cwd", input.cwd,
    "--session", sessionLabel,
    ...modelArgs,
    "--",
    input.prompt
  ];
}

export function parseExecutionRuntimeLine(
  protocol: ExecutionStreamProtocol,
  line: string,
  state: ParserState = {}
): NormalizedExecutionEvent[] {
  const raw = stripControlSequences(line).trim();
  if (!raw || raw.startsWith("Reading additional input from stdin") || raw.startsWith("[dogfood]")) return [];
  let payload: Record<string, unknown>;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return [];
    payload = parsed as Record<string, unknown>;
  } catch {
    return protocol === "dtcoder-stream-json" ? [] : [{ logs: [raw] }];
  }
  if (protocol === "codex-jsonl") return parseCodexEvent(payload, state);
  if (protocol === "dtcoder-stream-json") return parseDtcoderEvent(payload, state);
  return parseClaudeCompatibleEvent(payload, state);
}

export async function* runExecutionRuntime(
  input: RunExecutionRuntimeInput
): AsyncGenerator<NormalizedExecutionEvent> {
  if (input.runtimeId === "dtcoder" && isAiworkExecutable(input.executable)) {
    try {
      await prepareAiworkSession(input);
    } catch (error) {
      yield {
        result: {
          subtype: "error",
          result: input.abortSignal.aborted
            ? "任务已被中止"
            : `AiWork 会话准备失败：${error instanceof Error ? error.message : String(error)}`
        }
      };
      return;
    }
  }
  const cfuseCapabilities = input.runtimeId === "cfuse"
    ? await detectCfuseCliCapabilities(input.executable, input.env)
    : undefined;
  if (input.runtimeId === "cfuse" && (!cfuseCapabilities?.print || !cfuseCapabilities.outputFormat)) {
    yield {
      result: {
        subtype: "error",
        result: "当前 CFuse CLI 缺少 -p/--print 或 --output-format，不能作为 UIWarden 非交互执行底座。请升级 CFuse。"
      }
    };
    return;
  }
  if (input.runtimeId === "cfuse" && input.model?.trim() && !cfuseCapabilities?.model) {
    yield {
      result: {
        subtype: "error",
        result: "当前 CFuse CLI 不支持 --model，无法应用已选择的模型。请升级 CFuse，或清除 UIWarden 中该底座的模型覆盖。"
      }
    };
    return;
  }
  const command = buildExecutionRuntimeCommand(input, cfuseCapabilities);
  const protocol = executionStreamProtocol(input.runtimeId);
  let cfuseOutputFormat: string | undefined;
  if (input.runtimeId === "cfuse") {
    const outputFormatIndex = command.indexOf(cfuseCapabilities?.outputFormat || "--output-format");
    cfuseOutputFormat = outputFormatIndex >= 0 ? command[outputFormatIndex + 1] : undefined;
    console.log(
      `[execution-runtime] CFuse conversation=${input.conversationId} executable=${input.executable}`
      + ` probe=${cfuseCapabilities?.probeStatus || "unknown"}`
      + ` outputFormat=${cfuseOutputFormat || "unknown"}`
      + ` verbose=${command.includes(cfuseCapabilities?.verbose || "--verbose")}`
    );
  }
  const state: ParserState = {};
  const queue: NormalizedExecutionEvent[] = [];
  let finished = false;
  let wake: (() => void) | undefined;
  let closed = false;
  let startupTimedOut = false;
  let startupTimer: NodeJS.Timeout | undefined;

  const push = (event: NormalizedExecutionEvent) => {
    queue.push(event);
    wake?.();
    wake = undefined;
  };
  const finish = () => {
    finished = true;
    wake?.();
    wake = undefined;
  };
  const markRuntimeResponsive = () => {
    if (startupTimer) clearTimeout(startupTimer);
    startupTimer = undefined;
  };

  const child = spawn(command[0], command.slice(1), {
    cwd: input.cwd,
    env: input.env,
    stdio: ["ignore", "pipe", "pipe"],
    // 在 POSIX 上建立独立进程组。Agent 经 Bash 启动 quick/browser-use 时，
    // 仅终止顶层 CLI 会留下 Python、Playwright 和 Chromium 孤儿进程。
    detached: process.platform !== "win32"
  });
  const configuredStartupTimeoutMs = normalizeStartupTimeout(input.startupTimeoutMs);
  const startupTimeoutMs = cfuseOutputFormat === "json"
    ? Math.max(configuredStartupTimeoutMs || 0, 5 * 60_000)
    : configuredStartupTimeoutMs;
  if (startupTimeoutMs) {
    startupTimer = setTimeout(() => {
      if (closed || child.exitCode != null) return;
      startupTimedOut = true;
      state.semanticError = `执行底座在 ${Math.ceil(startupTimeoutMs / 1000)} 秒内未返回首个事件`;
      const stoppedProcessIds = stopRuntimeProcessTree(child.pid, "SIGTERM");
      setTimeout(() => {
        stopRuntimeProcessIds(stoppedProcessIds, "SIGKILL");
      }, 2_000).unref();
    }, startupTimeoutMs);
    startupTimer.unref();
  }
  if (input.runtimeId === "dtcoder") {
    push({ sdkSessionId: safeSessionLabel(input.conversationId) });
  }
  const stdout = readline.createInterface({ input: child.stdout });
  const stderr = readline.createInterface({ input: child.stderr });
  stdout.on("line", (line) => {
    const events = parseExecutionRuntimeLine(protocol, line, state);
    if (events.length) markRuntimeResponsive();
    for (const event of events) {
      rememberDiagnostics(state, event.logs);
      push(event);
    }
  });
  stderr.on("line", (line) => {
    const text = stripControlSequences(line).trim();
    if (text) {
      rememberDiagnostics(state, [text]);
      push({ logs: [text] });
    }
  });

  const stopChild = () => {
    if (child.exitCode == null) {
      const stoppedProcessIds = stopRuntimeProcessTree(child.pid, "SIGTERM");
      setTimeout(() => {
        // CFuse/Claude can start tool shells in a new process group. The top
        // runtime may exit before those detached descendants, so always reap
        // the process IDs captured at abort time.
        stopRuntimeProcessIds(stoppedProcessIds, "SIGKILL");
      }, 2_000).unref();
    }
  };
  input.abortSignal.addEventListener("abort", stopChild, { once: true });

  child.once("error", (error) => {
    if (closed) return;
    closed = true;
    markRuntimeResponsive();
    state.hasResult = true;
    push({
      result: {
        subtype: "error",
        result: input.runtimeId === "cfuse"
          ? classifyCfuseFailure(error.message, "CFuse 启动失败")
          : `${input.runtimeId} 启动失败：${error.message}`
      }
    });
    finish();
  });
  child.once("close", (code, signal) => {
    if (closed) return;
    closed = true;
    markRuntimeResponsive();
    stdout.close();
    stderr.close();
    if (!state.hasResult) {
      if (startupTimedOut) {
        push({
          result: {
            subtype: "error",
            result: `${state.semanticError}，已停止本轮任务。请检查模型服务、网络、额度或切换执行底座后重试。`
          }
        });
      } else if (input.abortSignal.aborted) {
        push({ result: { subtype: "error", result: "任务已被中止" } });
      } else if (code !== 0) {
        const diagnostic = state.diagnostics?.slice(-4).join("\n");
        const processError = `${input.runtimeId} 进程退出（exit ${code ?? "unknown"}${signal ? `, signal ${signal}` : ""}）`;
        const failure = input.runtimeId === "cfuse"
          ? classifyCfuseFailure(
              [state.semanticError, diagnostic].filter(Boolean).join("\n"),
              processError
            )
          : state.semanticError || (diagnostic ? `${processError}\n${diagnostic}` : processError);
        push({
          result: {
            subtype: "error",
            result: failure
          }
        });
      } else {
        push({ result: { subtype: "success", result: "" } });
      }
    }
    finish();
  });

  try {
    while (!finished || queue.length) {
      if (!queue.length) {
        await new Promise<void>((resolve) => { wake = resolve; });
        continue;
      }
      yield queue.shift()!;
    }
  } finally {
    markRuntimeResponsive();
    input.abortSignal.removeEventListener("abort", stopChild);
    if (!closed) stopChild();
  }
}

function isAiworkExecutable(executable: string): boolean {
  return Boolean(aiworkDistributionForExecutable(executable));
}

async function prepareAiworkSession(input: RunExecutionRuntimeInput): Promise<void> {
  if (input.abortSignal.aborted) throw new Error("任务已被中止");
  const status = await runAiworkJson(input, ["agent", "status", "--json"]);
  const agents = Array.isArray(status.agents) ? status.agents : [];
  const coderRunning = agents.some((item) => {
    const agent = asRecord(item);
    return agent?.id === "coder" && agent.status === "running";
  });
  if (!coderRunning) {
    const started = await runAiworkJson(input, ["agent", "start", "coder", "--json"], 30_000);
    const startError = asRecord(started.error);
    if (started.ok !== true && startError?.code !== "agent_already_running") {
      throw new Error(asString(startError?.message) || "无法启动 coder daemon");
    }
  }
  const created = await runAiworkJson(input, [
    "sessions", "create", "--agent", "coder",
    "--session", safeSessionLabel(input.conversationId),
    "--cwd", input.cwd,
    "--json"
  ]);
  if (created.ok !== true) {
    throw new Error(asString(asRecord(created.error)?.message) || "无法创建 coder 会话");
  }
}

async function runAiworkJson(
  input: RunExecutionRuntimeInput,
  args: string[],
  timeout = 15_000
): Promise<Record<string, unknown>> {
  let stdout = "";
  try {
    const result = await execFileAsync(input.executable, args, {
      cwd: input.cwd,
      env: input.env,
      signal: input.abortSignal,
      timeout
    });
    stdout = result.stdout;
  } catch (error) {
    stdout = String((error as { stdout?: string }).stdout || "");
    if (!stdout) throw error;
  }
  try {
    return asRecord(JSON.parse(stdout)) || {};
  } catch {
    throw new Error(`${path.basename(input.executable)} ${args.slice(0, 2).join(" ")} 未返回有效 JSON`);
  }
}

function stopRuntimeProcessTree(
  pid: number | undefined,
  signal: NodeJS.Signals
): number[] {
  if (!pid) return [];
  if (process.platform === "win32") {
    if (signal === "SIGKILL") {
      const killer = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], {
        detached: false,
        stdio: "ignore",
        windowsHide: true
      });
      killer.unref();
    }
    return [pid];
  }
  const processIds = [pid, ...listDescendantProcessIds(pid)];
  stopRuntimeProcessIds(processIds, signal);
  return processIds;
}

function stopRuntimeProcessIds(processIds: number[], signal: NodeJS.Signals): void {
  for (const pid of [...processIds].reverse()) {
    try {
      // A tool shell may call setsid(2) and become its own process-group
      // leader. Signal its group first, then fall back to the single process.
      process.kill(-pid, signal);
    } catch {
      try {
        process.kill(pid, signal);
      } catch {
        // Process may have exited between discovery and signal delivery.
      }
    }
  }
}

function listDescendantProcessIds(rootPid: number): number[] {
  if (process.platform === "win32") return [];
  try {
    const output = execFileSync("ps", ["-axo", "pid=,ppid="], {
      encoding: "utf8",
      timeout: 1_000,
      maxBuffer: 2 * 1024 * 1024
    });
    const childrenByParent = new Map<number, number[]>();
    for (const line of output.split(/\r?\n/)) {
      const match = line.trim().match(/^(\d+)\s+(\d+)$/);
      if (!match) continue;
      const pid = Number(match[1]);
      const parentPid = Number(match[2]);
      const children = childrenByParent.get(parentPid) ?? [];
      children.push(pid);
      childrenByParent.set(parentPid, children);
    }
    const descendants: number[] = [];
    const pending = [...(childrenByParent.get(rootPid) ?? [])];
    while (pending.length) {
      const pid = pending.shift()!;
      descendants.push(pid);
      pending.push(...(childrenByParent.get(pid) ?? []));
    }
    return descendants;
  } catch {
    return [];
  }
}

export async function detectCfuseCliCapabilities(
  executable: string,
  env: Record<string, string>
): Promise<CfuseCliCapabilities> {
  const cached = cfuseCapabilityCache.get(executable);
  if (cached) return cached;

  let help = "";
  try {
    const result = await execFileAsync(executable, ["--help"], {
      env,
      timeout: 5_000,
      maxBuffer: 2 * 1024 * 1024
    });
    help = stripControlSequences(`${result.stdout || ""}\n${result.stderr || ""}`);
  } catch (error) {
    const output = error as { stdout?: string; stderr?: string };
    help = stripControlSequences(`${output.stdout || ""}\n${output.stderr || ""}`);
  }

  const option = (...names: string[]): string | undefined =>
    names.find((name) => new RegExp(`(^|\\s)${escapeRegExp(name)}(?:[\\s,]|$)`, "m").test(help));
  if (!help.trim()) {
    const fallback: CfuseCliCapabilities = {
      probeStatus: "unavailable",
      print: "-p",
      outputFormat: "--output-format",
      model: "--model"
    };
    cfuseCapabilityCache.set(executable, fallback);
    return fallback;
  }

  const capabilities: CfuseCliCapabilities = {
    probeStatus: "ok",
    print: option("-p", "--print"),
    outputFormat: option("--output-format"),
    model: option("-m", "--model"),
    settingSources: option("--setting-sources"),
    permissionMode: option("--permission-mode"),
    includePartialMessages: option("--include-partial-messages"),
    // Some CFuse/Claude engines omit --verbose from non-TTY help even though
    // stream-json with partial messages requires it at execution time.
    verbose: option("--verbose") || (option("--include-partial-messages") ? "--verbose" : undefined),
    allowedTools: option("--allowedTools", "--allowed-tools"),
    resume: option("--resume")
  };
  cfuseCapabilityCache.set(executable, capabilities);
  return capabilities;
}

export function cfuseCapabilityWarnings(capabilities: CfuseCliCapabilities): string[] {
  if (capabilities.probeStatus === "unavailable") {
    return ["无法读取 CFuse --help，任务将使用基础参数启动；若失败请检查 CLI 完整性和执行权限。"];
  }
  const warnings: string[] = [];
  if (!capabilities.settingSources) {
    warnings.push("当前 CFuse 不支持设置来源参数，项目和本地 Skill 配置只能依赖 CLI 默认加载行为。");
  }
  if (!capabilities.permissionMode) {
    warnings.push("当前 CFuse 不支持权限模式参数，执行期间可能出现额外授权或直接拒绝工具调用。");
  }
  if (!capabilities.allowedTools) {
    warnings.push("当前 CFuse 不支持工具白名单参数，UIWarden 无法在 CLI 层限制可用工具。");
  }
  if (!capabilities.resume) {
    warnings.push("当前 CFuse 不支持会话续接，多轮对话将无法恢复原 CFuse session。");
  }
  if (!capabilities.includePartialMessages) {
    warnings.push("当前 CFuse 不支持增量消息，回答可能只能在步骤或任务结束后集中展示。");
  }
  return warnings;
}

export function classifyCfuseFailure(diagnostic: string, fallback: string): string {
  const text = sanitizeDiagnostic(diagnostic);
  const detail = text ? `\n诊断：${text}` : "";
  if (/output-format=stream-json requires --verbose|stream-json.*--verbose/i.test(text)) {
    return `CFuse 流式参数协商失败，当前任务没有实际开始。请升级 UIWarden；新版本会在能力探测失败时补齐 --verbose，并对旧 CLI 回退为 JSON 输出。${detail}`;
  }
  if (/unknown arguments?|unknown option|unrecognized option/i.test(text)) {
    return `CFuse CLI 参数与当前 UIWarden 不兼容。请升级客户端或 CFuse；配置中心会显示实际支持能力。${detail}`;
  }
  if (/bad cpu type|exec format|wrong architecture|incompatible architecture/i.test(text)) {
    return `CFuse 二进制与当前 CPU 架构不兼容。请安装与本机 arm64/x64 匹配的 UIWarden 客户端。${detail}`;
  }
  if (/incompatiblesystemversion|requires macos|unsupported.*os|cannot run on.*os/i.test(text)) {
    return `CFuse 不支持当前操作系统版本。请升级 macOS，或安装兼容当前系统的客户端版本。${detail}`;
  }
  if (/\b429\b|quota|rate.?limit|用量上限|额度不足|积分不足|insufficient (?:credits?|quota)/i.test(text)) {
    return `CFuse 模型服务额度不足或已触发限流。请在配置中心切换可用模型/底座，或补充额度后重试。${detail}`;
  }
  if (/unauthorized|authentication|not logged in|login required|invalid.*(?:token|key)|\b401\b|\b403\b/i.test(text)) {
    return `CFuse 认证不可用。请在终端完成 CFuse 登录，或在配置中心检查该底座的 Base URL 与认证信息。${detail}`;
  }
  if (/未找到匹配的自定义供应商配置|X-USER-MODEL-PROVIDER-CATEGORY|provider.?category|合法渠道前缀/i.test(text)) {
    return `CFuse 未匹配到所选模型的供应商配置。请在配置中心把裸模型名改为 CFuse 可识别的完整模型 ID，例如将 MiniMax-M2.5 改为 antchat/MiniMax-M2.5；认证和供应商地址由 CFuse 本地配置管理。${detail}`;
  }
  if (/model.*(?:not found|invalid|unsupported|does not exist)|invalid.*model|\b404\b.*model/i.test(text)) {
    return `CFuse 当前服务不支持所选模型。请在配置中心检查模型 ID，或清除模型覆盖后使用 CLI 默认模型。${detail}`;
  }
  if (/session.*(?:not found|invalid|expired|locked)|failed to resume|resume.*failed/i.test(text)) {
    return `CFuse 会话无法续接。请新建 UIWarden 会话；如果反复出现，请检查本地 CFuse session 状态。${detail}`;
  }
  if (/timed? ?out|econnrefused|enotfound|dns|certificate|tls|socket|network|connection/i.test(text)) {
    return `CFuse 无法连接模型服务。请检查网络、代理、DNS、证书和 Base URL。${detail}`;
  }
  if (/e2big|argument list too long/i.test(text)) {
    return `发送给 CFuse 的任务上下文超过系统参数长度限制。请缩短输入、减少附件或新建会话。${detail}`;
  }
  return text ? `${fallback}\n诊断：${text}` : fallback;
}

function normalizeStartupTimeout(value: number | undefined): number | undefined {
  if (!Number.isFinite(value) || Number(value) <= 0) return undefined;
  return Math.min(Math.max(Math.round(Number(value)), 100), 10 * 60_000);
}

function parseClaudeCompatibleEvent(payload: Record<string, unknown>, state: ParserState): NormalizedExecutionEvent[] {
  const type = asString(payload.type);
  if (type === "system" && payload.subtype === "init") {
    const sessionId = asString(payload.session_id) || asString(payload.sessionId);
    const actualModel = asString(payload.model);
    return sessionId || actualModel ? [{ sdkSessionId: sessionId, actualModel }] : [];
  }
  if (type === "stream_event") {
    const event = asRecord(payload.event);
    const eventType = asString(event?.type);
    const delta = asRecord(event?.delta);
    if (eventType === "content_block_delta" && delta?.type === "text_delta") {
      const text = asString(delta.text) || "";
      if (text) state.hasAnswer = true;
      return text ? [{ text }] : [];
    }
    if (eventType === "content_block_delta" && delta?.type === "input_json_delta") {
      return [{ tool: { phase: "input", chunk: asString(delta.partial_json) || "" } }];
    }
    const block = asRecord(event?.content_block);
    if (eventType === "content_block_start" && block?.type === "tool_use") {
      return [{ tool: { phase: "start", name: block.name, id: block.id } }];
    }
    if (eventType === "content_block_stop") return [{ tool: { phase: "stop" } }];
  }
  const logs = extractToolResultLogs(payload);
  if (logs.length) return [{ logs }];
  if (type === "result") {
    state.hasResult = true;
    const result = asString(payload.result) || "";
    const isError = payload.is_error === true || asString(payload.subtype)?.startsWith("error");
    if (isError) state.semanticError = result || asString(payload.subtype) || "CFuse 执行失败";
    const events: NormalizedExecutionEvent[] = [];
    if (!isError && result && !state.hasAnswer) {
      state.hasAnswer = true;
      events.push({ text: result });
    }
    events.push({
      result: {
        subtype: isError ? "error" : asString(payload.subtype) || "success",
        result,
        totalCostUsd: payload.total_cost_usd,
        durationMs: payload.duration_ms
      }
    });
    return events;
  }
  return [];
}

function parseCodexEvent(payload: Record<string, unknown>, state: ParserState): NormalizedExecutionEvent[] {
  const type = asString(payload.type) || "";
  const item = asRecord(payload.item);
  if (type === "thread.started") {
    const sessionId = asString(payload.thread_id) || asString(payload.threadId);
    return sessionId ? [{ sdkSessionId: sessionId }] : [];
  }
  if (type === "item.completed" && item?.type === "agent_message") {
    const text = asString(item.text) || "";
    if (text) state.hasAnswer = true;
    return text ? [{ text }] : [];
  }
  if (type === "error" || type === "turn.failed") {
    const error = asRecord(payload.error);
    const message = asString(payload.message) || asString(error?.message) || asString(payload.error) || "Codex 执行失败";
    state.semanticError = message;
    state.hasResult = true;
    return [{ result: { subtype: "error", result: message } }];
  }
  if (type === "turn.completed") {
    state.hasResult = true;
    return [{ result: { subtype: "success", result: "", usage: payload.usage } }];
  }
  if (type.startsWith("item.")) {
    const runtimeToolName = asString(item?.type) || type;
    return [{
      tool: {
        phase: type.endsWith("completed") ? "stop" : "start",
        id: item?.id,
        name: normalizeCodexToolName(runtimeToolName),
        runtimeToolName,
        item
      }
    }];
  }
  return [];
}

function normalizeCodexToolName(name: string): string {
  if (name === "command_execution") return "Bash";
  if (name === "file_change") return "Edit";
  return name;
}

function parseDtcoderEvent(payload: Record<string, unknown>, state: ParserState): NormalizedExecutionEvent[] {
  const event = asRecord(payload.event);
  const eventName = asString(event?.name) || "";
  const data = asRecord(payload.data) || {};
  if (eventName === "stream.started") return [];
  if (eventName === "stream.text_delta") {
    const text = asString(data.text) || "";
    if (text) state.hasAnswer = true;
    return text ? [{ text }] : [];
  }
  if (eventName === "stream.final_text" || eventName === "stream.completed") {
    const text = asString(data.final_text) || asString(data.text) || asString(data.output_full_text) || "";
    const events: NormalizedExecutionEvent[] = [];
    if (text && !state.hasAnswer) {
      state.hasAnswer = true;
      events.push({ text });
    }
    if (eventName === "stream.completed") {
      state.hasResult = true;
      events.push({ result: { subtype: "success", result: "" } });
    }
    return events;
  }
  if (eventName === "stream.failed") {
    const failure = asRecord(data.failure);
    const diagnostics = asRecord(failure?.diagnostics);
    const providerError = asRecord(data.provider_error);
    const rawError = asString(data.raw_error)
      || asString(providerError?.raw_error)
      || asString(diagnostics?.raw_error);
    const message = rawError?.includes("data_inspection_failed")
      ? "模型服务内容检查拦截了本轮输出（data_inspection_failed），请重试；若重复出现，请检查 Agent 即将生成的命令或切换模型"
      : asString(failure?.summary) || asString(data.message) || rawError || "AiWork 执行失败";
    state.semanticError = message;
    state.hasResult = true;
    return [{ result: { subtype: "error", result: message, code: data.code || failure?.code, rawError } }];
  }
  if (eventName === "stream.tool_call" || eventName === "stream.tool_result") {
    return [{
      tool: {
        phase: eventName === "stream.tool_result" ? "stop" : "start",
        name: asString(data.name) || asString(data.command) || eventName,
        data
      }
    }];
  }
  return [];
}

function extractToolResultLogs(payload: Record<string, unknown>): string[] {
  const message = asRecord(payload.message);
  const content = Array.isArray(message?.content)
    ? message.content
    : Array.isArray(payload.content) ? payload.content : [];
  return content.flatMap((item) => {
    const block = asRecord(item);
    if (block?.type !== "tool_result") return [];
    if (typeof block.content === "string") return [block.content];
    if (!Array.isArray(block.content)) return [];
    return block.content.flatMap((part) => {
      const record = asRecord(part);
      return record?.type === "text" && typeof record.text === "string" ? [record.text] : [];
    });
  });
}

function safeSessionLabel(value: string): string {
  return (value.replace(/[^A-Za-z0-9_.-]+/g, "-").replace(/^[.-]+|[.-]+$/g, "") || "uiwarden-session").slice(0, 96);
}

function rememberDiagnostics(state: ParserState, lines: string[] | undefined): void {
  if (!lines?.length) return;
  const next = [...(state.diagnostics || [])];
  for (const line of lines) {
    const sanitized = sanitizeDiagnostic(line);
    if (sanitized) next.push(sanitized);
  }
  state.diagnostics = next.slice(-8);
}

function sanitizeDiagnostic(value: string): string {
  return value
    .replace(
      /((?:api[_-]?key|auth(?:orization)?|token|password|secret)\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,
      "$1[REDACTED]"
    )
    .replace(/\b(?:sk|sess|pat)-[A-Za-z0-9_-]{8,}\b/g, "[REDACTED]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 600);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function stripControlSequences(value: string): string {
  return value
    .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, "")
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\u001b[()][A-Za-z0-9]/g, "")
    .replace(/\u001b[78]/g, "");
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
