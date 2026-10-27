import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { dataDir, projectRoot } from "./paths.js";
import { getGuiRuntimeSettings } from "./configStore.js";
import {
  callNativeAutomationMcp,
  ensureNativeAutomationMcp,
  getNativeAutomationMcpStatus,
  stopNativeAutomationMcp,
  writeNativeAutomationMcpLauncher,
  type NativeAutomationMcpStatus
} from "./nativeAutomationMcp.js";
import type {
  NativeAppSelector,
  NativeControlMode,
  NativeProviderId
} from "./types.js";

const execFileAsync = promisify(execFile);
const ALLOWED_PROVIDERS = new Set<NativeProviderId>([
  "mock",
  "macos-accessibility",
  "windows-ui-automation"
]);
const SESSION_ID = /^cua-[0-9a-f-]{16,}$/i;
const CHALLENGE_ID = /^approval-[0-9a-f-]{16,}$/i;
const NATIVE_AUTOMATION_TOOL_TIMEOUT_MS = 45_000;

interface CliEnvelope<T> {
  ok: boolean;
  data?: T;
  error?: { code?: string; message?: string; details?: unknown };
}

export interface NativeAutomationStatus {
  protocolVersion: number;
  runtimeVersion: string;
  platform: string;
  architecture: string;
  providers: Array<{
    providerId: string;
    status: "ok" | "unavailable";
    data?: Record<string, unknown>;
    error?: { code?: string; message?: string };
  }>;
}

export interface NativeAutomationTransportStatus {
  cliCompatibilityMode: boolean;
  activeTransport: "cli" | "mcp";
  mcp: NativeAutomationMcpStatus;
}

export interface NativeAutomationApp {
  id: string;
  displayName: string;
  isRunning: boolean;
  processId?: number;
}

export interface NativeApprovalChallenge {
  challengeId: string;
  actionSignature: string;
  actionSummary: string;
  snapshotId: string;
  expiresAt: string;
  granted: boolean;
}

export interface NativeAutomationSession {
  version: number;
  sessionId: string;
  providerId: NativeProviderId;
  app: NativeAppSelector;
  controlMode: NativeControlMode;
  deliveryMode: "foreground-compatible" | "background-safe";
  approvalPolicy: "none" | "sensitive-actions";
  state: "active" | "stopped" | "failed";
  currentSnapshotId?: string;
  artifactDir: string;
  startedAt: string;
  finishedAt?: string;
  stopReason?: string;
  snapshotSequence: number;
  eventCount: number;
  pendingApprovals: NativeApprovalChallenge[];
}

export interface NativeUiElement {
  elementId: string;
  providerPath: string;
  role: string;
  name: string;
  value?: string;
  secure: boolean;
  enabled: boolean;
  actions: string[];
  focused: boolean;
  bounds?: { x: number; y: number; width: number; height: number };
}

export interface NativeAutomationSnapshot {
  version: number;
  snapshotId: string;
  sessionId: string;
  sequence: number;
  app: NativeAutomationApp;
  text: string;
  elements: NativeUiElement[];
  screenshotPath?: string;
  windowBounds?: { x: number; y: number; width: number; height: number };
  captureGaps: string[];
  delta: {
    changed: boolean;
    windowChanged: boolean;
    focusedElementChanged: boolean;
    textChanged: boolean;
    addedElementCount: number;
    removedElementCount: number;
    updatedElementCount: number;
    actionCountSinceLastObservation: number;
    noProgressCount: number;
  };
  capturedAt: string;
}

export class NativeAutomationError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly details?: unknown
  ) {
    super(message);
    this.name = "NativeAutomationError";
  }
}

/** 返回注入 Agent 的可信 CLI 路径。 */
export function nativeAutomationBinPath(): string {
  const configured = process.env.DT_GUI_COMPUTER_BIN?.trim();
  if (configured) return path.resolve(configured);
  const executable = process.platform === "win32" ? "dt-gui-computer.cmd" : "dt-gui-computer";
  return path.join(projectRoot, "native-automation", executable);
}

/** Server 与 Agent 共享同一 Runtime home。 */
export function nativeAutomationHomePath(env: NodeJS.ProcessEnv = process.env): string {
  return path.resolve(env.DT_GUI_COMPUTER_HOME?.trim() || path.join(dataDir, "native-automation"));
}

/** 返回当前 Agent 应使用的可信入口；MCP 模式下入口保持原 CLI 参数兼容。 */
export async function nativeAutomationAgentBinPath(
  transportOverride?: "cli" | "mcp"
): Promise<string> {
  const settings = await getGuiRuntimeSettings();
  const transport = transportOverride
    ?? (settings.cliCompatibilityMode ? "cli" : "mcp");
  if (transport === "cli") return nativeAutomationBinPath();
  const options = nativeAutomationMcpOptions();
  const status = await ensureNativeAutomationMcp(options);
  return writeNativeAutomationMcpLauncher({
    ...options,
    dataDir,
    endpoint: status.endpoint
  });
}

/** 应用传输设置并返回实际运行状态。 */
export async function applyNativeAutomationTransportSetting(): Promise<NativeAutomationTransportStatus> {
  const settings = await getGuiRuntimeSettings();
  if (settings.cliCompatibilityMode) {
    await stopNativeAutomationMcp();
  } else {
    await ensureNativeAutomationMcp(nativeAutomationMcpOptions());
  }
  return getNativeAutomationTransportStatus();
}

export async function getNativeAutomationTransportStatus(): Promise<NativeAutomationTransportStatus> {
  const settings = await getGuiRuntimeSettings();
  return {
    cliCompatibilityMode: settings.cliCompatibilityMode,
    activeTransport: settings.cliCompatibilityMode ? "cli" : "mcp",
    mcp: getNativeAutomationMcpStatus()
  };
}

/** 电脑桌面操作必须有真实观察，且 Agent 不能把明确阻塞的结果标记为完成。 */
export function nativeAutomationCompletionError(
  session: NativeAutomationSession,
  assistantText = ""
): string | undefined {
  if (session.snapshotSequence < 1) {
    return "dt-gui-computer 未产生有效桌面观察，任务未实际操作目标应用";
  }
  if (session.state === "failed" && session.stopReason === "no-progress") {
    return "dt-gui-computer 检测到连续动作后页面无有效变化，已熔断旧快照重试循环";
  }
  const result = assistantText.trim();
  if (/\[UIWARDEN_NATIVE_RESULT:\s*blocked\]/i.test(result)) {
    return "dt-gui-computer 报告任务仍有阻塞步骤，未达到用户目标";
  }
  if (
    /(?:当前阻塞点|需要人工协助|未能成功(?:发送|提交|完成)|无法完成当前任务)/.test(result)
  ) {
    return "dt-gui-computer 的执行报告包含未解决阻塞，不能标记为已完成";
  }
  return undefined;
}

/** 返回本机原生自动化 Runtime 状态；只允许调用固定的 doctor 命令。 */
export async function getNativeAutomationStatus(): Promise<NativeAutomationStatus> {
  const status = await runNativeAutomationTool<NativeAutomationStatus>(
    "native_doctor",
    {},
    ["doctor", "--json"]
  );
  return {
    protocolVersion: status.protocolVersion,
    runtimeVersion: status.runtimeVersion,
    platform: status.platform,
    architecture: status.architecture,
    providers: status.providers.map((provider) => ({
      providerId: provider.providerId,
      status: provider.status,
      data: provider.data,
      error: provider.error
    }))
  };
}

/** 返回指定 Provider 可见应用；Provider 使用白名单，禁止透传任意 CLI 参数。 */
export async function listNativeAutomationApps(providerId: string): Promise<NativeAutomationApp[]> {
  if (!isSupportedNativeProvider(providerId)) {
    throw new Error(`不支持的原生自动化 Provider：${providerId}`);
  }
  const result = await runNativeAutomationTool<{ apps?: NativeAutomationApp[] }>(
    "native_apps_list",
    { provider: providerId },
    ["apps", "list", "--provider", providerId, "--json"]
  );
  return Array.isArray(result.apps) ? result.apps : [];
}

export async function startNativeAutomationSession(input: {
  providerId: NativeProviderId;
  app: NativeAppSelector;
  artifactRoot: string;
  workspacePath: string;
  approvalMode: "none" | "manual-finalize";
  deliveryMode: "foreground-compatible" | "background-safe";
}): Promise<NativeAutomationSession> {
  if (!isSupportedNativeProvider(input.providerId)) throw new Error("不支持的原生自动化 Provider");
  const appValue = input.app.value.trim();
  if (!appValue) throw new Error("原生应用选择器不能为空");
  const artifactRoot = path.resolve(input.artifactRoot);
  if (!isInside(input.workspacePath, artifactRoot)) {
    throw new Error("Native Rep 目录必须位于当前任务工作区内");
  }
  await fs.mkdir(artifactRoot, { recursive: true });
  const approvalPolicy = input.approvalMode === "none" ? "none" : "sensitive-actions";
  return runNativeAutomationTool<NativeAutomationSession>(
    "native_session_start",
    {
      provider: input.providerId,
      appKind: input.app.kind,
      app: appValue,
      mode: "agent-control",
      deliveryMode: input.deliveryMode,
      approvalPolicy,
      artifactRoot
    },
    [
      "session", "start",
      "--provider", input.providerId,
      "--app-kind", input.app.kind,
      "--app", appValue,
      "--mode", "agent-control",
      "--delivery-mode", input.deliveryMode,
      "--approval-policy", approvalPolicy,
      "--artifact-root", artifactRoot,
      "--json"
    ],
    NATIVE_AUTOMATION_TOOL_TIMEOUT_MS
  );
}

export async function getNativeAutomationSession(sessionId: string): Promise<NativeAutomationSession> {
  assertSessionId(sessionId);
  return runNativeAutomationTool<NativeAutomationSession>(
    "native_session_status",
    { sessionId },
    ["session", "status", "--session", sessionId, "--json"]
  );
}

export async function observeNativeAutomationSession(sessionId: string): Promise<NativeAutomationSnapshot> {
  assertSessionId(sessionId);
  return runNativeAutomationTool<NativeAutomationSnapshot>(
    "native_observe",
    { sessionId, full: true },
    ["observe", "--session", sessionId, "--full", "--json"],
    NATIVE_AUTOMATION_TOOL_TIMEOUT_MS
  );
}

export async function clickNativeAutomationSessionAsUser(input: {
  sessionId: string;
  snapshotId: string;
  elementId?: string;
  x: number;
  y: number;
}): Promise<Record<string, unknown>> {
  assertSessionId(input.sessionId);
  const args = [
    "click",
    "--session", input.sessionId,
    "--snapshot", input.snapshotId,
  ];
  if (input.elementId) {
    args.push("--element", input.elementId);
  } else {
    args.push(
      "--x", String(input.x),
      "--y", String(input.y),
      "--allow-coordinate-fallback"
    );
  }
  args.push("--actor", "user", "--json");
  return runNativeAutomationTool<Record<string, unknown>>(
    "native_click",
    input.elementId
      ? { sessionId: input.sessionId, snapshotId: input.snapshotId, elementId: input.elementId, actor: "user" }
      : {
          sessionId: input.sessionId,
          snapshotId: input.snapshotId,
          x: input.x,
          y: input.y,
          allowCoordinateFallback: true,
          actor: "user"
        },
    args,
    NATIVE_AUTOMATION_TOOL_TIMEOUT_MS
  );
}

export async function setNativeAutomationControl(
  sessionId: string,
  mode: Extract<NativeControlMode, "agent-control" | "human-control">
): Promise<NativeAutomationSession> {
  assertSessionId(sessionId);
  if (mode !== "agent-control" && mode !== "human-control") throw new Error("无效的原生控制模式");
  return runNativeAutomationTool<NativeAutomationSession>(
    "native_session_control",
    { sessionId, mode },
    ["session", "control", "--session", sessionId, "--mode", mode, "--json"]
  );
}

export async function grantNativeAutomationApproval(
  sessionId: string,
  challengeId: string
): Promise<NativeApprovalChallenge> {
  assertSessionId(sessionId);
  assertChallengeId(challengeId);
  return runNativeAutomationTool<NativeApprovalChallenge>(
    "native_approval_grant",
    { sessionId, challengeId },
    ["approval", "grant", "--session", sessionId, "--challenge", challengeId, "--json"]
  );
}

export async function rejectNativeAutomationApproval(
  sessionId: string,
  challengeId: string,
  reason = "user-rejected"
): Promise<{ challengeId: string; decision: "rejected"; reason: string }> {
  assertSessionId(sessionId);
  assertChallengeId(challengeId);
  const normalizedReason = normalizeReason(reason);
  return runNativeAutomationTool(
    "native_approval_reject",
    { sessionId, challengeId, reason: normalizedReason },
    [
      "approval", "reject", "--session", sessionId, "--challenge", challengeId,
      "--reason", normalizedReason, "--json"
    ]
  );
}

export async function stopNativeAutomationSession(
  sessionId: string,
  reason: string
): Promise<NativeAutomationSession> {
  assertSessionId(sessionId);
  const normalizedReason = normalizeReason(reason);
  return runNativeAutomationTool<NativeAutomationSession>(
    "native_session_stop",
    { sessionId, reason: normalizedReason },
    ["session", "stop", "--session", sessionId, "--reason", normalizedReason, "--json"],
    NATIVE_AUTOMATION_TOOL_TIMEOUT_MS
  );
}

/** 服务重启后收尾没有进程句柄持有的 active 会话，并封装已有 Native Rep。 */
export async function recoverOrphanedNativeAutomationSessions(): Promise<{
  recovered: string[];
  failed: Array<{ sessionId: string; error: string }>;
}> {
  const sessionsDir = path.join(nativeAutomationHomePath(), "sessions");
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
      await stopNativeAutomationSession(sessionId, "server-restarted");
      recovered.push(sessionId);
    } catch (error) {
      failed.push({ sessionId, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return { recovered, failed };
}

export async function openNativeAutomationPermissionSettings(
  permission: "accessibility" | "screen-recording"
): Promise<void> {
  if (process.platform === "darwin") {
    const anchor = permission === "accessibility" ? "Privacy_Accessibility" : "Privacy_ScreenCapture";
    await execFileAsync("/usr/bin/open", [`x-apple.systempreferences:com.apple.preference.security?${anchor}`], {
      timeout: 10_000
    });
    return;
  }
  if (process.platform === "win32") {
    await execFileAsync("cmd.exe", ["/c", "start", "", "ms-settings:privacy"], { timeout: 10_000 });
    return;
  }
  throw new Error("当前平台没有可用的原生自动化权限设置入口");
}

export function isSupportedNativeProvider(providerId: string): providerId is NativeProviderId {
  return ALLOWED_PROVIDERS.has(providerId as NativeProviderId);
}

async function runNativeAutomation<T>(args: string[], timeout = NATIVE_AUTOMATION_TOOL_TIMEOUT_MS): Promise<T> {
  const binary = nativeAutomationBinPath();
  const runtimeHome = nativeAutomationHomePath();
  const executable = process.platform === "win32" && binary.toLowerCase().endsWith(".cmd")
    ? (process.env.DT_GUI_COMPUTER_NODE?.trim() || "node.exe")
    : binary;
  const executableArgs = executable === binary
    ? args
    : [path.join(path.dirname(binary), "dist", "cli.js"), ...args];
  let stdout = "";
  try {
    const result = await execFileAsync(executable, executableArgs, {
      encoding: "utf8",
      timeout,
      maxBuffer: 4 * 1024 * 1024,
      env: {
        ...process.env,
        DT_GUI_COMPUTER_HOME: runtimeHome,
        DT_GUI_COMPUTER_NODE: process.env.DT_GUI_COMPUTER_NODE?.trim() || process.execPath
      }
    });
    stdout = result.stdout;
  } catch (error) {
    const failure = error as { stdout?: string; message?: string };
    stdout = String(failure.stdout || "");
    if (!stdout.trim()) throw new Error(`原生自动化 Runtime 调用失败：${failure.message || String(error)}`);
  }
  let envelope: CliEnvelope<T>;
  try {
    envelope = JSON.parse(stdout.trim()) as CliEnvelope<T>;
  } catch {
    throw new Error("原生自动化 Runtime 返回了无效 JSON");
  }
  if (!envelope.ok || envelope.data == null) {
    throw new NativeAutomationError(
      envelope.error?.code || "NATIVE_AUTOMATION_FAILED",
      envelope.error?.message || "原生自动化 Runtime 执行失败",
      envelope.error?.details
    );
  }
  return envelope.data;
}

async function runNativeAutomationTool<T>(
  name: string,
  mcpArgs: Record<string, unknown>,
  cliArgs: string[],
  timeout = NATIVE_AUTOMATION_TOOL_TIMEOUT_MS
): Promise<T> {
  const settings = await getGuiRuntimeSettings();
  if (settings.cliCompatibilityMode) return runNativeAutomation<T>(cliArgs, timeout);
  try {
    return await callNativeAutomationMcp<T>(
      nativeAutomationMcpOptions(),
      name,
      mcpArgs,
      timeout
    );
  } catch (error) {
    const failure = error as { code?: string; details?: unknown };
    throw new NativeAutomationError(
      failure.code || "NATIVE_AUTOMATION_MCP_FAILED",
      error instanceof Error ? error.message : String(error),
      failure.details
    );
  }
}

function nativeAutomationMcpOptions(): {
  binary: string;
  runtimeHome: string;
  node: string;
} {
  return {
    binary: nativeAutomationBinPath(),
    runtimeHome: nativeAutomationHomePath(),
    node: process.env.DT_GUI_COMPUTER_NODE?.trim() || process.execPath
  };
}

function assertSessionId(value: string): void {
  if (!SESSION_ID.test(value)) throw new Error("无效的原生自动化会话 ID");
}

function assertChallengeId(value: string): void {
  if (!CHALLENGE_ID.test(value)) throw new Error("无效的原生自动化审批 ID");
}

function normalizeReason(value: string): string {
  const reason = String(value || "unknown").trim().slice(0, 160);
  return reason || "unknown";
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}
