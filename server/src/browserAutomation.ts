import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  callBrowserAutomationMcpCli,
  ensureBrowserAutomationMcp,
  stopBrowserAutomationMcp
} from "./browserAutomationMcp.js";
import { getGuiRuntimeSettings } from "./configStore.js";
import { dataDir, projectRoot } from "./paths.js";

const execFileAsync = promisify(execFile);
const SESSION_ID = /^browser-[0-9a-f-]{16,}$/i;
const latestSessionIdByUiwardenSession = new Map<string, string>();

interface CliEnvelope<T> {
  ok: boolean;
  data?: T;
  error?: { code?: string; message?: string; details?: unknown };
}

export interface BrowserAutomationSession {
  version: number;
  runtimeVersion: string;
  sessionId: string;
  runId: string;
  uiwardenSessionId?: string;
  cdpUrl: string;
  targetId: string;
  targetTitle?: string;
  targetUrl?: string;
  controlMode: "observe" | "agent-control" | "human-control";
  state: "active" | "stopped" | "failed";
  currentSnapshotId?: string | null;
  artifactDir: string;
  startedAt: string;
  finishedAt?: string | null;
  stopReason?: string | null;
  eventCount: number;
  snapshotSequence: number;
  actionCount: number;
  screenshotCount: number;
  captureGapCount: number;
  targetSelection?: "uiwarden" | "agent";
  agentBinPath?: string;
}

export interface BrowserAutomationSnapshot {
  snapshotId: string;
  sessionId: string;
  sequence: number;
  targetId: string;
  url: string;
  title: string;
  screenshotPath?: string;
  capturedAt: string;
}

export class BrowserAutomationRuntimeError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly details?: unknown
  ) {
    super(message);
    this.name = "BrowserAutomationRuntimeError";
  }
}

/** 为 UIWarden 已锁定的 CDP target 创建原子浏览器会话。 */
export async function startBrowserAutomationSession(input: {
  cdpUrl: string;
  targetId: string;
  runId: string;
  uiwardenSessionId: string;
  artifactRoot: string;
  workspacePath: string;
  allowTargetSelection?: boolean;
}): Promise<BrowserAutomationSession> {
  const artifactRoot = path.resolve(input.artifactRoot);
  if (!isInside(input.workspacePath, artifactRoot)) {
    throw new Error("Browser Rep 目录必须位于当前任务工作区内");
  }
  await fs.mkdir(artifactRoot, { recursive: true });
  const args = [
    "session", "start",
    "--cdp-url", input.cdpUrl,
    "--target", input.targetId,
    "--artifact-root", artifactRoot,
    "--run-id", input.runId,
    "--uiwarden-session", input.uiwardenSessionId,
    "--mode", "agent-control",
    "--upload-root", path.resolve(input.workspacePath)
  ];
  if (input.allowTargetSelection) args.push("--allow-target-selection");
  args.push("--json");
  const session = await runBrowserAutomation<BrowserAutomationSession>(args, 30_000);
  try {
    const settings = await getGuiRuntimeSettings();
    let endpoint: string | undefined;
    if (!settings.cliCompatibilityMode) {
      const status = await ensureBrowserAutomationMcp(browserAutomationMcpOptions(session.sessionId));
      endpoint = status.endpoint;
    }
    const agentBinPath = await ensureBrowserAutomationAgentLauncher(session.sessionId, process.env, endpoint);
    const enriched = { ...session, agentBinPath };
    latestSessionIdByUiwardenSession.set(input.uiwardenSessionId, enriched.sessionId);
    return enriched;
  } catch (error) {
    await stopBrowserAutomationMcp(session.sessionId).catch(() => undefined);
    await runBrowserAutomation([
      "session", "stop", "--session", session.sessionId,
      "--reason", "mcp-start-failed", "--json"
    ], 30_000).catch(() => undefined);
    await removeBrowserAutomationAgentLauncher(session.sessionId).catch(() => undefined);
    throw error;
  }
}

export async function getBrowserAutomationSession(sessionId: string): Promise<BrowserAutomationSession> {
  assertSessionId(sessionId);
  return enrichBrowserAutomationSession(
    sessionId,
    await runBrowserAutomationSessionCommand(sessionId, ["session", "status", "--json"])
  );
}

/** 仅由 UIWarden 控制桥在人工切换可见标签后同步 target。 */
export async function setBrowserAutomationTarget(
  sessionId: string,
  targetId: string
): Promise<BrowserAutomationSession> {
  assertSessionId(sessionId);
  if (!targetId.trim()) throw new Error("浏览器 targetId 不能为空");
  return enrichBrowserAutomationSession(
    sessionId,
    await runBrowserAutomationSessionCommand(sessionId, [
      "session", "target", "--target", targetId, "--json"
    ])
  );
}

export async function setBrowserAutomationControl(
  sessionId: string,
  mode: "agent-control" | "human-control"
): Promise<BrowserAutomationSession> {
  assertSessionId(sessionId);
  return enrichBrowserAutomationSession(
    sessionId,
    await runBrowserAutomationSessionCommand(sessionId, [
      "session", "control", "--mode", mode, "--json"
    ])
  );
}

export async function stopBrowserAutomationSession(
  sessionId: string,
  reason: string
): Promise<BrowserAutomationSession> {
  assertSessionId(sessionId);
  try {
    return await runBrowserAutomationSessionCommand(sessionId, [
      "session", "stop", "--reason", normalizeReason(reason), "--json"
    ], 30_000);
  } finally {
    await stopBrowserAutomationMcp(sessionId).catch(() => undefined);
    await removeBrowserAutomationAgentLauncher(sessionId).catch(() => undefined);
  }
}

/** 中止 UI 操作时不等待阻塞中的 MCP 命令，直接释放其 Browser session 与 target lease。 */
export async function forceStopBrowserAutomationSessionsForUiwardenSession(
  uiwardenSessionId: string,
  reason: string
): Promise<string[]> {
  const home = browserAutomationHomePath();
  const sessionsDir = path.join(home, "sessions");
  const entries = await fs.readdir(sessionsDir, { withFileTypes: true }).catch(() => []);
  const stopped: string[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const sessionId = entry.name.slice(0, -5);
    if (!SESSION_ID.test(sessionId)) continue;
    const session = await fs.readFile(path.join(sessionsDir, entry.name), "utf8")
      .then((content) => JSON.parse(content) as BrowserAutomationSession)
      .catch(() => undefined);
    if (
      !session
      || session.state !== "active"
      || session.uiwardenSessionId !== uiwardenSessionId
    ) continue;
    await stopBrowserAutomationMcp(sessionId).catch(() => undefined);
    await fs.rm(path.join(home, "locks", `session-${sessionId}.lock`), {
      recursive: true,
      force: true
    });
    await runBrowserAutomation<BrowserAutomationSession>([
      "session", "stop",
      "--session", sessionId,
      "--reason", normalizeReason(reason),
      "--json"
    ], 15_000);
    await removeBrowserAutomationAgentLauncher(sessionId).catch(() => undefined);
    stopped.push(sessionId);
  }
  return stopped;
}

/** 查找 UIWarden 对话最近一次浏览器原子会话，供执行观察与画中画读取。 */
export async function findLatestBrowserAutomationSessionForUiwardenSession(
  uiwardenSessionId: string
): Promise<BrowserAutomationSession | undefined> {
  const sessionsDir = path.join(browserAutomationHomePath(), "sessions");
  const cachedSessionId = latestSessionIdByUiwardenSession.get(uiwardenSessionId);
  if (cachedSessionId) {
    const cached = await fs.readFile(path.join(sessionsDir, `${cachedSessionId}.json`), "utf8")
      .then((content) => JSON.parse(content) as BrowserAutomationSession)
      .catch(() => undefined);
    if (cached?.uiwardenSessionId === uiwardenSessionId) return cached;
    latestSessionIdByUiwardenSession.delete(uiwardenSessionId);
  }
  const entries = await fs.readdir(sessionsDir, { withFileTypes: true }).catch(() => []);
  const sessions = await Promise.all(entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map(async (entry) => fs.readFile(path.join(sessionsDir, entry.name), "utf8")
      .then((content) => JSON.parse(content) as BrowserAutomationSession)
      .catch(() => undefined)));
  const latest = sessions
    .filter((session): session is BrowserAutomationSession =>
      Boolean(session && session.uiwardenSessionId === uiwardenSessionId))
    .sort((left, right) => Date.parse(right.startedAt) - Date.parse(left.startedAt))[0];
  if (latest) latestSessionIdByUiwardenSession.set(uiwardenSessionId, latest.sessionId);
  return latest;
}

export async function readBrowserAutomationSnapshots(
  session: BrowserAutomationSession
): Promise<BrowserAutomationSnapshot[]> {
  const streamPath = path.join(session.artifactDir, "streams", "snapshots.jsonl");
  const content = await fs.readFile(streamPath, "utf8").catch(() => "");
  return content
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line) as BrowserAutomationSnapshot;
      } catch {
        return undefined;
      }
    })
    .filter((snapshot): snapshot is BrowserAutomationSnapshot =>
      Boolean(snapshot && Number.isInteger(snapshot.sequence) && snapshot.sessionId === session.sessionId))
    .sort((left, right) => left.sequence - right.sequence);
}

/** 服务重启后收尾没有进程句柄持有的 active 会话，并释放 CDP target 租约。 */
export async function recoverOrphanedBrowserAutomationSessions(): Promise<{
  recovered: string[];
  failed: Array<{ sessionId: string; error: string }>;
}> {
  const sessionsDir = path.join(browserAutomationHomePath(), "sessions");
  const recovered: string[] = [];
  const failed: Array<{ sessionId: string; error: string }> = [];
  const entries = await fs.readdir(sessionsDir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const sessionId = entry.name.slice(0, -5);
    if (!SESSION_ID.test(sessionId)) continue;
    try {
      const stored = JSON.parse(await fs.readFile(path.join(sessionsDir, entry.name), "utf8")) as {
        state?: string;
      };
      if (stored.state !== "active") continue;
      await stopBrowserAutomationSession(sessionId, "server-restarted");
      recovered.push(sessionId);
    } catch (error) {
      failed.push({ sessionId, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return { recovered, failed };
}

/** 返回注入 Agent 的可信 CLI 启动器路径。 */
export function browserAutomationBinPath(): string {
  const configured = process.env.DT_GUI_BROWSER_BIN?.trim();
  if (configured) return path.resolve(configured);
  return path.join(
    projectRoot,
    "browser-automation",
    "bin",
    process.platform === "win32" ? "dt-gui-browser.cmd" : "dt-gui-browser"
  );
}

/** Server 与 Agent 必须共享同一个 Runtime home，否则 CLI 无法找到已创建的会话。 */
export function browserAutomationHomePath(env: NodeJS.ProcessEnv = process.env): string {
  return path.resolve(env.DT_GUI_BROWSER_HOME?.trim() || path.join(dataDir, "browser-automation"));
}

/** DTCoder 使用的会话专属短入口，内部绑定 Node、Runtime home 与 session。 */
export function browserAutomationAgentBinPath(
  sessionId: string,
  env: NodeJS.ProcessEnv = process.env
): string {
  assertSessionId(sessionId);
  const root = path.resolve(
    env.DT_GUI_BROWSER_AGENT_BIN_DIR?.trim() || path.join(os.homedir(), ".uiwarden", "browser")
  );
  return path.join(root, process.platform === "win32" ? `${sessionId}.cmd` : sessionId);
}

export async function ensureBrowserAutomationAgentLauncher(
  sessionId: string,
  env: NodeJS.ProcessEnv = process.env,
  mcpEndpoint?: string
): Promise<string> {
  const launcher = browserAutomationAgentBinPath(sessionId, env);
  const runtimeHome = browserAutomationHomePath(env);
  const script = browserAutomationCliPath(env);
  await fs.mkdir(path.dirname(launcher), { recursive: true, mode: 0o700 });
  const content = mcpEndpoint
    ? process.platform === "win32"
      ? buildWindowsMcpAgentLauncher(process.execPath, script, runtimeHome, sessionId, mcpEndpoint)
      : buildPosixMcpAgentLauncher(process.execPath, script, runtimeHome, sessionId, mcpEndpoint)
    : process.platform === "win32"
      ? buildWindowsAgentLauncher(process.execPath, script, runtimeHome, sessionId)
      : buildPosixAgentLauncher(process.execPath, script, runtimeHome, sessionId);
  const temporary = `${launcher}.${process.pid}.tmp`;
  await fs.writeFile(temporary, content, { encoding: "utf8", mode: 0o700 });
  await fs.rename(temporary, launcher);
  if (process.platform !== "win32") await fs.chmod(launcher, 0o700);
  return launcher;
}

async function removeBrowserAutomationAgentLauncher(sessionId: string): Promise<void> {
  await fs.rm(browserAutomationAgentBinPath(sessionId), { force: true });
}

/** 浏览器操作必须先观察页面，纯文本解释不能被当作成功执行。 */
export function browserAutomationCompletionError(session: BrowserAutomationSession): string | undefined {
  if (session.snapshotSequence < 1) {
    return "dt-gui-browser 未产生有效页面观察，任务未实际操作目标浏览器";
  }
  return undefined;
}

async function runBrowserAutomation<T>(args: string[], timeout = 15_000): Promise<T> {
  const script = browserAutomationCliPath();
  const runtimeHome = browserAutomationHomePath();
  let stdout = "";
  try {
    const result = await execFileAsync(process.execPath, [script, ...args], {
      encoding: "utf8",
      timeout,
      maxBuffer: 8 * 1024 * 1024,
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: process.env.ELECTRON_RUN_AS_NODE || "1",
        DT_GUI_BROWSER_HOME: runtimeHome
      }
    });
    stdout = result.stdout;
  } catch (error) {
    const failure = error as { stdout?: string; message?: string };
    stdout = String(failure.stdout || "");
    if (!stdout.trim()) throw new Error(`浏览器原子 Runtime 调用失败：${failure.message || String(error)}`);
  }
  let envelope: CliEnvelope<T>;
  try {
    envelope = JSON.parse(stdout.trim()) as CliEnvelope<T>;
  } catch {
    throw new Error("浏览器原子 Runtime 返回了无效 JSON");
  }
  if (!envelope.ok || envelope.data == null) {
    throw new BrowserAutomationRuntimeError(
      envelope.error?.code || "BROWSER_AUTOMATION_FAILED",
      envelope.error?.message || "浏览器原子 Runtime 执行失败",
      envelope.error?.details
    );
  }
  return envelope.data;
}

async function runBrowserAutomationSessionCommand<T>(
  sessionId: string,
  args: string[],
  timeout = 15_000
): Promise<T> {
  const settings = await getGuiRuntimeSettings();
  if (settings.cliCompatibilityMode) {
    return runBrowserAutomation<T>([...args, "--session", sessionId], timeout);
  }
  await ensureBrowserAutomationMcp(browserAutomationMcpOptions(sessionId));
  return callBrowserAutomationMcpCli(sessionId, [...args, "--session", sessionId], timeout) as Promise<T>;
}

async function enrichBrowserAutomationSession(
  sessionId: string,
  session: BrowserAutomationSession
): Promise<BrowserAutomationSession> {
  const settings = await getGuiRuntimeSettings();
  let endpoint: string | undefined;
  if (!settings.cliCompatibilityMode) {
    const status = await ensureBrowserAutomationMcp(browserAutomationMcpOptions(sessionId));
    endpoint = status.endpoint;
  }
  return {
    ...session,
    agentBinPath: await ensureBrowserAutomationAgentLauncher(sessionId, process.env, endpoint)
  };
}

function browserAutomationMcpOptions(sessionId: string): {
  sessionId: string;
  script: string;
  runtimeHome: string;
  node: string;
} {
  return {
    sessionId,
    script: browserAutomationCliPath(),
    runtimeHome: browserAutomationHomePath(),
    node: process.execPath
  };
}

function browserAutomationCliPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.resolve(
    env.DT_GUI_BROWSER_CLI?.trim() || path.join(projectRoot, "browser-automation", "cli.mjs")
  );
}

function buildPosixAgentLauncher(node: string, script: string, runtimeHome: string, sessionId: string): string {
  return `#!/bin/sh\nset -eu\nexport DT_GUI_BROWSER_HOME=${shellQuote(runtimeHome)}\nexport ELECTRON_RUN_AS_NODE=1\nexec ${shellQuote(node)} ${shellQuote(script)} "$@" --session ${shellQuote(sessionId)}\n`;
}

function buildWindowsAgentLauncher(node: string, script: string, runtimeHome: string, sessionId: string): string {
  return `@echo off\r\nsetlocal\r\nset "DT_GUI_BROWSER_HOME=${runtimeHome}"\r\nset "ELECTRON_RUN_AS_NODE=1"\r\n"${node}" "${script}" %* --session "${sessionId}"\r\n`;
}

function buildPosixMcpAgentLauncher(
  node: string,
  script: string,
  runtimeHome: string,
  sessionId: string,
  endpoint: string
): string {
  return `#!/bin/sh
set -eu
if [ -x /usr/bin/nc ]; then
  set +e
  RESPONSE=$({ printf 'UIWARDEN_CLI_V1\\0'; printf '%s\\0' "$@"; printf '%s\\0' '--session' ${shellQuote(sessionId)}; printf '\\0'; } | /usr/bin/nc -U ${shellQuote(endpoint)})
  STATUS=$?
  set -e
  if [ "$STATUS" -ne 0 ] || [ -z "$RESPONSE" ]; then
    printf '%s\\n' '{"ok":false,"error":{"code":"MCP_UNAVAILABLE","message":"dt-gui-browser 持久 MCP 连接失败","details":{}}}'
    exit 2
  fi
  printf '%s\\n' "$RESPONSE"
  case "$RESPONSE" in
    '{"ok":true,'*) exit 0 ;;
    *) exit 2 ;;
  esac
fi
export DT_GUI_BROWSER_MCP_ENDPOINT=${shellQuote(endpoint)}
export DT_GUI_BROWSER_HOME=${shellQuote(runtimeHome)}
export ELECTRON_RUN_AS_NODE=1
exec ${shellQuote(node)} ${shellQuote(script)} "$@" --session ${shellQuote(sessionId)}
`;
}

function buildWindowsMcpAgentLauncher(
  node: string,
  script: string,
  runtimeHome: string,
  sessionId: string,
  endpoint: string
): string {
  return `@echo off\r\nsetlocal\r\nset "DT_GUI_BROWSER_MCP_ENDPOINT=${endpoint}"\r\nset "DT_GUI_BROWSER_HOME=${runtimeHome}"\r\nset "ELECTRON_RUN_AS_NODE=1"\r\n"${node}" "${script}" %* --session "${sessionId}"\r\n`;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function assertSessionId(value: string): void {
  if (!SESSION_ID.test(value)) throw new Error("无效的浏览器原子会话 ID");
}

function normalizeReason(value: string): string {
  return String(value || "unknown").trim().slice(0, 160) || "unknown";
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}
