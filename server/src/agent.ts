import path from "node:path";
import fs from "node:fs/promises";
import { createHash } from "node:crypto";
import type { Response } from "express";
import type { HookInput, SettingSource } from "@anthropic-ai/claude-agent-sdk";
import { buildClaudeProfileSettings } from "./claudeEnv.js";
import type { AgentSession, BrowserKernel, ExecutionPurpose, ExecutionRuntimeId, ScreenshotEvent, StreamPayload, UploadedFileInfo, TestOutcome } from "./types.js";
import {
  appendMessageContent,
  appendMessage,
  createMessage,
  refreshArtifacts,
  updateMessageMeta,
  updateSessionStatus
} from "./storage.js";
import { prepareWorkspace } from "./workspace.js";
import { isDesktopMode } from "./runtimeMode.js";
import { getSelectedExecutionRuntimeId } from "./modelStore.js";
import { executionRuntimeDisabledDetail, isExecutionRuntimeEnabled } from "./executionRuntimePolicy.js";
import {
  buildExecutionRuntimeEnvironment,
  getExecutionRuntimeDefinition,
  resolveExecutionRuntimeExecutable
} from "./executionRuntime.js";
import {
  runExecutionRuntime,
  type NormalizedExecutionEvent
} from "./executionRuntimeRunner.js";
import { markSessionRunFinished, markSessionRunStarted } from "./sessionRuntime.js";
import { parseTestOutcome } from "./testOutcome.js";
import { getCdpStatus } from "./cdpManager.js";
import {
  finalizeEmbeddedBrowserRun,
  getEmbeddedBrowserRunState,
  startEmbeddedBrowserRun,
  waitForEmbeddedAgentControl,
  type EmbeddedBrowserRunHandle
} from "./embeddedBrowser.js";
import {
  browserAutomationAgentBinPath,
  browserAutomationBinPath,
  browserAutomationCompletionError,
  browserAutomationHomePath,
  getBrowserAutomationSession,
  setBrowserAutomationTarget,
  startBrowserAutomationSession,
  stopBrowserAutomationSession,
  type BrowserAutomationSession
} from "./browserAutomation.js";
import {
  getNativeAutomationSession,
  nativeAutomationAgentBinPath,
  nativeAutomationBinPath,
  nativeAutomationCompletionError,
  nativeAutomationHomePath
} from "./nativeAutomation.js";

type SdkMessage = Record<string, unknown>;

export interface NativeAgentExecutionContext {
  sessionId: string;
  providerId: string;
  deliveryMode: "foreground-compatible" | "background-safe";
  transport?: "cli" | "mcp";
  appDisplayName: string;
  artifactDir: string;
  waitForAgentControl: (abortSignal: AbortSignal) => Promise<void>;
}

export function resolveAgentMaxTurns(mode: "native" | "browser-atomic" | "test"): number {
  if (mode === "native") return 100;
  if (mode === "browser-atomic") return 80;
  return 50;
}

export function resolveAgentBrowserMode(
  purpose: ExecutionPurpose,
  browserKernel: BrowserKernel,
  hasNativeExecution: boolean
): "managed" | "external" | "none" {
  if (hasNativeExecution) return "none";
  if (browserKernel === "uiwarden-embedded" || browserKernel === "gui-computer") return "managed";
  if (purpose !== "operation") return "none";
  if (browserKernel === "playwright") return "managed";
  if (browserKernel === "external-cdp") return "external";
  return "none";
}

export function resolveExecutionRuntimeStartupTimeout(
  purpose: ExecutionPurpose,
  env: NodeJS.ProcessEnv = process.env
): number | undefined {
  if (purpose !== "operation") return undefined;
  const configured = Number(env.UIWARDEN_OPERATION_RUNTIME_STARTUP_TIMEOUT_MS);
  if (Number.isFinite(configured) && configured > 0) {
    return Math.min(Math.max(Math.round(configured), 5_000), 10 * 60_000);
  }
  return 60_000;
}

export const NATIVE_MODEL_IMAGE_READ_LIMIT = 12;
const NATIVE_STALL_FAILURE_LIMIT = 4;
const NATIVE_STALL_ERROR_CODES = [
  "STALE_SNAPSHOT",
  "FOCUS_CONTEXT_MISSING",
  "SCREENSHOT_UNAVAILABLE",
  "UNSUPPORTED_ACTION",
  "BACKGROUND_ACTION_REQUIRES_VISIBLE_WINDOW"
] as const;
const NATIVE_TERMINAL_ERROR_CODES = [
  "BACKGROUND_INTERFERENCE_DETECTED",
  "BACKGROUND_ACTION_UNSUPPORTED"
] as const;

export interface NativeExecutionStallState {
  failures: string[];
}

export function updateNativeExecutionStallState(
  state: NativeExecutionStallState,
  logs: string[]
): { state: NativeExecutionStallState; error?: string } {
  let failures = [...state.failures];
  for (const line of logs) {
    const terminalCode = NATIVE_TERMINAL_ERROR_CODES.find((candidate) =>
      new RegExp(`(?:\\"code\\"\\s*:\\s*\\"|\\b)${candidate}\\b`).test(line)
    );
    if (terminalCode) {
      return {
        state: { failures: [terminalCode] },
        error: terminalCode === "BACKGROUND_INTERFERENCE_DETECTED"
          ? "dt-gui-computer 检测到严格后台动作改变了前台应用或系统鼠标位置，已立即停止，未降级到前台执行"
          : "dt-gui-computer 检测到当前应用不支持无干扰后台动作，已立即停止；可由用户显式关闭“后台执行”后重试"
      };
    }
    if (/"performed"\s*:\s*true/.test(line)) {
      failures = [];
    }
    const code = NATIVE_STALL_ERROR_CODES.find((candidate) =>
      new RegExp(`(?:\\"code\\"\\s*:\\s*\\"|\\b)${candidate}\\b`).test(line)
    );
    if (code) failures.push(code);
  }
  failures = failures.slice(-NATIVE_STALL_FAILURE_LIMIT);
  if (failures.length < NATIVE_STALL_FAILURE_LIMIT) return { state: { failures } };
  return {
    state: { failures },
    error: `dt-gui-computer 连续 ${NATIVE_STALL_FAILURE_LIMIT} 次无法建立有效输入或页面状态，已停止本轮以避免长时间重复操作（${failures.join("、")}）`
  };
}

export function formatAgentResultError(result: string, nativeExecution: boolean, runtimeName = "Agent"): string {
  if (/Reached maximum number of turns/i.test(result)) {
    const scope = nativeExecution ? "原生应用操作" : "Agent 任务";
    return `${scope}达到步骤上限，已停止以避免继续重复操作。请根据最后一帧观察和 Native Rep 检查阻塞位置`;
  }
  if (/num of image is larger than the limit|image(?:s)?\s+(?:count|number).*(?:exceed|limit)|too many images/i.test(result)) {
    const scope = nativeExecution ? "原生应用操作" : "Agent 任务";
    return `${scope}的模型图片上下文已达到上游限制，任务已停止。完整截图仍保存在 Rep 中；请从最后一帧继续，后续执行将优先使用结构化页面证据并限制模型读取截图数量`;
  }
  return `${runtimeName} returned an error result: ${result}`;
}

export function buildAgentFailureMessage(existingText: string, failureText: string): string {
  const existing = existingText.trimEnd();
  const failure = failureText.trim() || "任务执行失败";
  const labeledFailure = /(失败|错误|中止|停止|error)/i.test(failure)
    ? failure
    : `任务执行失败：${failure}`;
  if (!existing) return labeledFailure;
  if (existing.includes(failure) || existing.includes(labeledFailure)) return existing;
  return `${existing}\n\n---\n${labeledFailure}`;
}

export function managedBrowserCommandViolation(command: string): string | undefined {
  const normalized = command.replace(/\\\s*\n/g, " ");
  if (/(?:^|\s)--no-cdp(?:\s|$)/.test(normalized)) {
    return "可控浏览器会话禁止 --no-cdp，不能回退新建 Playwright 浏览器";
  }
  if (/python(?:3(?:\.\d+)?)?\s+-m\s+browser_use\.cli/i.test(normalized)) {
    return "可控浏览器会话禁止直接调用 browser_use.cli；必须通过 run_quick_mode.py 使用锁定的 targetId";
  }
  if (/playwright\s+(?:test|open|codegen)|chromium\.launch\s*\(/i.test(normalized)) {
    return "可控浏览器会话禁止另起 Playwright/Chromium；必须操作 UIWarden 指定 target";
  }
  return undefined;
}

export function nativeAutomationCommandViolation(
  command: string,
  sessionId: string,
  expectedBin = nativeAutomationBinPath(),
  expectedHome = nativeAutomationHomePath()
): string | undefined {
  const normalized = command.replace(/\\\s*\n/g, " ");
  if (containsUnsafeShellSyntax(normalized)) {
    return "电脑桌面任务的 Bash 调用必须是单个 dt-gui-computer 原子命令，禁止拼接、管道、重定向或命令替换";
  }
  if (/run_quick_mode\.py|browser[_-]use|playwright\s+(?:test|open|codegen)|chromium\.launch\s*\(/i.test(normalized)) {
    return "原生应用任务禁止启动 browser-use、Playwright 或 Chromium";
  }
  if (/\bosascript\b|\bopen\s+(?:-a|-b)|\bStart-Process\b|\bexplorer(?:\.exe)?\s+shell:/i.test(normalized)) {
    return "电脑桌面任务禁止绕过 dt-gui-computer 直接启动或控制应用";
  }
  const cliInvocation = parseCliInvocation(normalized);
  if (!cliInvocation || !isExpectedCli(cliInvocation.executable, "DT_GUI_COMPUTER_BIN", expectedBin)) {
    return '电脑桌面任务必须原样使用 UIWarden 注入的可信入口；不要展开、猜测或覆盖路径。命令必须以 "$DT_GUI_COMPUTER_BIN" 开头，例如："$DT_GUI_COMPUTER_BIN" apps list --provider "$DT_GUI_COMPUTER_PROVIDER_ID" --json';
  }
  let cliArgs = cliInvocation.args;
  if (cliArgs.startsWith("--runtime-home")) {
    const runtimeHome = parseCliInvocation(cliArgs.slice("--runtime-home".length));
    if (!runtimeHome || path.resolve(runtimeHome.executable) !== path.resolve(expectedHome)) {
      return "电脑桌面任务使用了无效的 dt-gui-computer Runtime home";
    }
    cliArgs = runtimeHome.args;
  }
  if (/^session\s+(?:start|stop|control)\b|^approval\s+(?:grant|reject)\b/i.test(cliArgs)) {
    return "原生会话生命周期、控制权和审批只能由 UIWarden 控制面板管理";
  }
  if (/(?:^|\s)--actor(?:\s|=)/i.test(cliArgs)) {
    return "动作来源由 UIWarden Runtime 注入，Agent 不能伪造人工画中画操作";
  }
  if (/(?:^|\s)--full(?:\s|$)/i.test(cliArgs) && !/(?:^|\s)--query(?:\s|=)/i.test(cliArgs)) {
    return "完整 AX Tree 只能与 --query 一起定向检索；请先使用紧凑观察，禁止把未过滤的完整树发送给模型";
  }
  if (!/^(?:apps\s+list|session\s+(?:target|launch)|observe|visual-click|click|set-value|type-text|key|scroll)\b/i.test(cliArgs)) {
    return "电脑桌面 Agent 只能调用应用发现、目标绑定、观察和动作原子命令";
  }
  const usesBoundSession = normalized.includes(sessionId)
    || /--session\s+["']?\$\{?DT_GUI_COMPUTER_SESSION_ID\}?/i.test(normalized);
  if (!usesBoundSession && /\b(?:observe|visual-click|click|set-value|type-text|key|scroll|session\s+(?:target|launch))\b/i.test(normalized)) {
    return "原生动作必须显式绑定当前 DT_GUI_COMPUTER_SESSION_ID";
  }
  return undefined;
}

export function nativeAutomationSkillViolation(skillName: string): string | undefined {
  if (!skillName) return "电脑桌面任务必须明确加载 dt-gui-computer-skill";
  return skillName === "dt-gui-computer-skill"
    ? undefined
    : "电脑桌面任务只能加载 dt-gui-computer-skill，禁止切换到浏览器或测试 Skill";
}

export function nativeAutomationReadViolation(
  filePath: string,
  artifactDir: string,
  completedImageReads = 0
): string | undefined {
  const resolved = path.resolve(filePath);
  const screenshotRoot = path.resolve(artifactDir, "screenshots");
  const isInsideScreenshotRoot = resolved.startsWith(`${screenshotRoot}${path.sep}`);
  if (!isInsideScreenshotRoot || !/\.(?:png|jpe?g|webp)$/i.test(resolved)) {
    return "电脑桌面任务的 Read 工具只能读取当前 Native Rep screenshots 目录中的图片；大型 AX Tree 请使用 dt-gui-computer observe --query 结构化过滤，禁止读取 Claude tool-results 文件";
  }
  if (completedImageReads >= NATIVE_MODEL_IMAGE_READ_LIMIT) {
    return `电脑桌面任务的模型截图读取已达到 ${NATIVE_MODEL_IMAGE_READ_LIMIT} 张预算；完整截图仍保存在 Native Rep，请继续使用 AX/observe 证据，确需视觉证据时停止并报告采集缺口`;
  }
  return undefined;
}

export function browserAutomationCommandViolation(
  command: string,
  sessionId: string,
  expectedBin = browserAutomationBinPath(),
  expectedHome = browserAutomationHomePath(),
  expectedNode = process.execPath,
  sessionBound = false
): string | undefined {
  const normalized = command.replace(/\\\s*\n/g, " ");
  if (containsUnsafeShellSyntax(normalized)) {
    return "浏览器任务的 Bash 调用必须是单个 dt-gui-browser 原子命令，禁止拼接、管道、重定向或命令替换";
  }
  if (/run_quick_mode\.py|ui-test-assistant|browser[_-]use|playwright\s+(?:test|open|codegen)|chromium\.launch\s*\(/i.test(normalized)) {
    return "浏览器原子任务禁止启动测试 Skill、browser-use、Playwright 或新的 Chromium";
  }
  const cliInvocation = parseCliInvocation(normalized);
  const trustedEntry = cliInvocation && (sessionBound
    ? path.resolve(cliInvocation.executable) === path.resolve(expectedBin)
    : isExpectedCli(cliInvocation.executable, "DT_GUI_BROWSER_BIN", expectedBin));
  if (!cliInvocation || !trustedEntry) {
    return "浏览器原子任务的 Bash 工具只能调用 dt-gui-browser";
  }
  let cliArgs = cliInvocation.args;
  if (sessionBound && /(?:^|\s)--(?:node|runtime-home|session)\b/i.test(cliArgs)) {
    return "浏览器会话短入口已绑定 Runtime 与 session，禁止重复传入运行时或会话参数";
  }
  if (cliArgs.startsWith("--node")) {
    const nodeInvocation = parseCliInvocation(cliArgs.slice("--node".length));
    if (!nodeInvocation || path.resolve(nodeInvocation.executable) !== path.resolve(expectedNode)) {
      return "浏览器原子任务使用了无效的 Node Runtime";
    }
    cliArgs = nodeInvocation.args;
  }
  if (cliArgs.startsWith("--runtime-home")) {
    const runtimeHome = parseCliInvocation(cliArgs.slice("--runtime-home".length));
    if (!runtimeHome || path.resolve(runtimeHome.executable) !== path.resolve(expectedHome)) {
      return "浏览器原子任务使用了无效的 dt-gui-browser Runtime home";
    }
    cliArgs = runtimeHome.args;
  }
  if (/^session\s+(?:start|stop|target|control)\b|^mcp\b/i.test(cliArgs)) {
    return "浏览器会话生命周期、target 和控制权只能由 UIWarden 管理";
  }
  if (!/^(?:tabs\s+(?:list|activate)|downloads\s+list|observe|navigate|back|forward|reload|click|set-value|type-text|select-option|hover|key|drag|upload-file|scroll|screenshot)\b/i.test(cliArgs)) {
    return "浏览器 Agent 只能调用观察、导航和动作原子命令";
  }
  const usesBoundSession = sessionBound || normalized.includes(sessionId)
    || /--session\s+["']?\$\{?DT_GUI_BROWSER_SESSION_ID\}?/i.test(normalized);
  if (!usesBoundSession) return "浏览器原子命令必须显式绑定当前 DT_GUI_BROWSER_SESSION_ID";
  return undefined;
}

export function browserAutomationSkillViolation(skillName: string): string | undefined {
  if (!skillName) return "浏览器原子任务必须明确加载 dt-gui-browser-skill";
  return skillName === "dt-gui-browser-skill"
    ? undefined
    : "浏览器原子任务只能加载 dt-gui-browser-skill，禁止切换到测试或电脑桌面 Skill";
}

function containsUnsafeShellSyntax(command: string): boolean {
  let quote: "single" | "double" | undefined;
  for (let index = 0; index < command.length; index += 1) {
    const character = command[index];
    if (quote === "single") {
      if (character === "'") quote = undefined;
      continue;
    }
    if (quote === "double") {
      if (character === "\\") {
        index += 1;
        continue;
      }
      if (character === '"') {
        quote = undefined;
        continue;
      }
      if (character === "`" || (character === "$" && command[index + 1] === "(")) return true;
      continue;
    }
    if (character === "'") {
      quote = "single";
      continue;
    }
    if (character === '"') {
      quote = "double";
      continue;
    }
    if ("\r\n;&|<>`()".includes(character)) return true;
    if (character === "$" && command[index + 1] === "(") return true;
  }
  return Boolean(quote);
}

function parseCliInvocation(command: string): { executable: string; args: string } | undefined {
  let index = 0;
  while (/\s/.test(command[index] || "")) index += 1;
  let executable = "";
  let quote: "single" | "double" | undefined;
  for (; index < command.length; index += 1) {
    const character = command[index];
    if (quote === "single") {
      if (character === "'") quote = undefined;
      else executable += character;
      continue;
    }
    if (quote === "double") {
      if (character === '"') {
        quote = undefined;
      } else if (character === "\\" && index + 1 < command.length) {
        executable += command[++index];
      } else {
        executable += character;
      }
      continue;
    }
    if (character === "'") {
      quote = "single";
    } else if (character === '"') {
      quote = "double";
    } else if (character === "\\" && index + 1 < command.length) {
      executable += command[++index];
    } else if (/\s/.test(character)) {
      break;
    } else {
      executable += character;
    }
  }
  if (quote || !executable) return undefined;
  const args = command.slice(index).trim();
  return args ? { executable, args } : undefined;
}

function isExpectedCli(executable: string, variableName: string, expectedBin: string): boolean {
  if (executable === `$${variableName}` || executable === `\${${variableName}}`) return true;
  return path.resolve(executable) === path.resolve(expectedBin);
}

export function sendSse(res: Response, payload: StreamPayload): void {
  if (res.destroyed || res.writableEnded) {
    return;
  }
  try {
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  } catch {
    // The browser may have closed the page while the agent keeps running.
  }
}

export async function runAgentTurn(params: {
  session: AgentSession;
  userText: string;
  files: UploadedFileInfo[];
  res: Response;
}): Promise<void> {
  const { session, userText, files, res } = params;
  await runAgentForSession({
    session,
    userText,
    files,
    onPayload: (payload) => sendSse(res, payload)
  });
}

export async function runAgentForSession(params: {
  session: AgentSession;
  userText: string;
  files?: UploadedFileInfo[];
  onPayload?: (payload: StreamPayload) => void;
  abortSignal?: AbortSignal;
  purpose?: ExecutionPurpose;
  nativeExecution?: NativeAgentExecutionContext;
  uiOperationRunId?: string;
  executionRuntimeIdOverride?: ExecutionRuntimeId;
  modelOverride?: string;
}): Promise<{ assistantText: string; artifacts: AgentSession["artifacts"]; testOutcome: TestOutcome; testSummary?: string }> {
  const {
    session,
    userText,
    files = [],
    onPayload,
    abortSignal,
    purpose = "test",
    nativeExecution,
    uiOperationRunId,
    executionRuntimeIdOverride,
    modelOverride
  } = params;
  // 创建本轮流专用的 AbortController 并注册到 sessionRuntime，
  // 供「停止任务」(POST /api/sessions/:id/stop) 中断；同时转发外部传入的 abortSignal。
  const turnAbortController = new AbortController();
  if (abortSignal) {
    if (abortSignal.aborted) {
      turnAbortController.abort();
    } else {
      abortSignal.addEventListener("abort", () => turnAbortController.abort(), { once: true });
    }
  }
  const earlyAbortResult = () => ({
    assistantText: "任务已被中止",
    artifacts: session.artifacts,
    testOutcome: "unknown" as const
  });
  if (turnAbortController.signal.aborted) return earlyAbortResult();
  const executionRuntimeId: ExecutionRuntimeId = executionRuntimeIdOverride ?? session.executionRuntimeId
    ?? (session.sdkSessionId ? "claude-code" : await getSelectedExecutionRuntimeId());
  if (!isExecutionRuntimeEnabled(executionRuntimeId)) {
    throw new Error(executionRuntimeDisabledDetail(executionRuntimeId) ?? "当前执行底座已禁用");
  }
  const executionRuntime = getExecutionRuntimeDefinition(executionRuntimeId);
  const nativeAgentBin = nativeExecution
    ? await nativeAutomationAgentBinPath(nativeExecution.transport)
    : nativeAutomationBinPath();
  onPayload?.({
    type: "status",
    data: { phase: "preparing", label: "初始化 UI 操作执行环境" }
  });
  await prepareWorkspace(session.workspacePath, {
    browserProfileMode: session.browserKernel === "playwright" ? "bundled" : "skill",
    executionRuntimeId
  });
  if (turnAbortController.signal.aborted) return earlyAbortResult();
  markSessionRunStarted(session.id, turnAbortController);
  await updateSessionStatus(session.id, "running", { lastError: undefined, executionRuntimeId });

  let assistantText = "";
  let assistantMessageId: string | undefined;
  let sdkSessionId = session.sdkSessionId;
  let resultError: string | undefined;
  let aborted = false;
  let embeddedRun: EmbeddedBrowserRunHandle | undefined;
  let browserAutomation: BrowserAutomationSession | undefined;
  let browserAutomationFinalized = false;
  let embeddedFinalized = false;

  const persistAssistantFailure = async (failureText: string) => {
    const failureMessage = buildAgentFailureMessage(assistantText, failureText);
    if (assistantMessageId) {
      const suffix = failureMessage.slice(assistantText.trimEnd().length);
      if (suffix) await appendMessageContent(session.id, assistantMessageId, suffix);
      await updateMessageMeta(session.id, assistantMessageId, { streaming: false, failed: true });
    } else {
      const assistantMessage = createMessage("assistant", failureMessage, { meta: { streaming: false, failed: true } });
      assistantMessageId = assistantMessage.id;
      await appendMessage(session.id, assistantMessage);
    }
    assistantText = failureMessage;
  };

  const finalizeEmbedded = async (stopReason: string, testOutcome: TestOutcome = "unknown", summary?: string) => {
    if (browserAutomation && !browserAutomationFinalized) {
      browserAutomationFinalized = true;
      await stopBrowserAutomationSession(browserAutomation.sessionId, stopReason).catch((error) => {
        console.error(`[agent] Session ${session.id}: dt-gui-browser finalize failed`, error);
      });
    }
    if (!embeddedRun || embeddedFinalized) return;
    embeddedFinalized = true;
    await finalizeEmbeddedBrowserRun(embeddedRun, { stopReason, testOutcome, summary });
  };

  try {
    if (turnAbortController.signal.aborted) throw new Error("任务已被中止");
    const browserMode = resolveAgentBrowserMode(purpose, session.browserKernel, Boolean(nativeExecution));
    if (browserMode === "managed") {
      onPayload?.({
        type: "status",
        data: {
          phase: "connecting-target",
          label: session.browserKernel === "playwright"
            ? "启动 Playwright 配套 Chromium"
            : "连接客户端内置浏览器"
        }
      });
      const initialUrl = extractFirstUrl(userText);
      const manualLogin = requiresManualLogin(userText);
      embeddedRun = await startEmbeddedBrowserRun(session, {
        initialUrl: manualLogin ? initialUrl : undefined,
        initialControlMode: manualLogin ? "human-control" : "agent-control"
      });
      if (purpose === "operation") {
        browserAutomation = await startBrowserAutomationSession({
          cdpUrl: embeddedRun.execution.cdpUrl,
          targetId: embeddedRun.execution.targetId,
          runId: uiOperationRunId || embeddedRun.execution.runId,
          uiwardenSessionId: session.id,
          artifactRoot: path.join(session.workspacePath, ".skill-output", "browser-reps"),
          workspacePath: session.workspacePath
        });
      }
    } else if (browserMode === "external") {
      onPayload?.({
        type: "status",
        data: { phase: "connecting-target", label: "连接已授权的浏览器页面" }
      });
      const cdpStatus = await getCdpStatus();
      if (!cdpStatus.running) {
        throw new Error("外部 CDP 浏览器未启动，请先在 UI 操作页点击“启动 CDP 浏览器”");
      }
      const target = cdpStatus.tabs?.find((tab) => tab.id === cdpStatus.selectedTabId);
      if (!target) {
        throw new Error("外部 CDP 尚未选择受控页面，请先在 UI 操作页新建或选择一个目标标签页");
      }
      browserAutomation = await startBrowserAutomationSession({
        cdpUrl: cdpStatus.cdpUrl,
        targetId: target.id,
        runId: uiOperationRunId || `ui-operation-${session.id}`,
        uiwardenSessionId: session.id,
        artifactRoot: path.join(session.workspacePath, ".skill-output", "browser-reps"),
        workspacePath: session.workspacePath,
        allowTargetSelection: cdpStatus.mode === "extension"
          && !target.url.startsWith("about:blank#uiwarden-task-")
      });
    }
    const prompt = buildPrompt(
      userText,
      files,
      session,
      embeddedRun,
      purpose,
      nativeExecution,
      browserAutomation,
      executionRuntimeId,
      nativeAgentBin
    );
    const stopLogStreaming = await startWorkspaceLogStreaming(
      session.id,
      session.workspacePath,
      (line) => {
        onPayload?.({ type: "log", data: line });
      },
      (screenshot) => {
        onPayload?.({ type: "screenshot", data: screenshot });
      }
    );
    const dotenvPath = path.join(
      session.workspacePath,
      ".claude",
      "skills",
      "ui-test-assistant-skill",
      "config",
      ".env"
    );
    const skillRuntimeEnv: Record<string, string> = nativeExecution || browserAutomation
      ? {}
      : {
          DOTENV_PATH: dotenvPath,
          UIWARDEN_OBSERVATION_DIR: path.join(".skill-output", "uiwarden-observation")
        };
    const runtimeEnvironment = await buildExecutionRuntimeEnvironment(executionRuntimeId, {
        ...skillRuntimeEnv,
        ...(embeddedRun ? {
          UIWARDEN_EMBEDDED_BROWSER_SESSION_FILE: embeddedRun.sessionFile,
          UIWARDEN_EMBEDDED_CAPTURE_DIR: embeddedRun.repDir,
          UIWARDEN_BROWSER_KERNEL: session.browserKernel,
          BU_LOCAL_BROWSER_CDP_URL: embeddedRun.execution.cdpUrl
        } : {}),
        ...(nativeExecution ? {
          DT_GUI_COMPUTER_BIN: nativeAgentBin,
          DT_GUI_COMPUTER_NODE: process.execPath,
          DT_GUI_COMPUTER_HOME: nativeAutomationHomePath(),
          DT_GUI_COMPUTER_SESSION_ID: nativeExecution.sessionId,
          DT_GUI_COMPUTER_PROVIDER_ID: nativeExecution.providerId,
          DT_GUI_COMPUTER_DELIVERY_MODE: nativeExecution.deliveryMode,
          DT_GUI_COMPUTER_ARTIFACT_DIR: nativeExecution.artifactDir
        } : {}),
        ...(browserAutomation ? {
          DT_GUI_BROWSER_BIN: browserAutomation.agentBinPath
            || browserAutomationAgentBinPath(browserAutomation.sessionId),
          DT_GUI_BROWSER_NODE: process.execPath,
          DT_GUI_BROWSER_HOME: browserAutomationHomePath(),
          DT_GUI_BROWSER_SESSION_ID: browserAutomation.sessionId,
          DT_GUI_BROWSER_ARTIFACT_DIR: browserAutomation.artifactDir
        } : {})
      }, { modelOverride });
    const abortController = turnAbortController;
    let nativeSkillLoaded = false;
    let browserSkillLoaded = false;
    let nativeCommandViolationCount = 0;
    let nativeImageReadCount = 0;
    let nativeStallState: NativeExecutionStallState = { failures: [] };
    let automaticAbortError: string | undefined;
    const allowedTools = nativeExecution
      ? ["Bash", "Skill", "Read"]
      : browserAutomation
        ? ["Bash", "Skill"]
        : ["Read", "Write", "Edit", "Bash", "Glob", "Grep", "Skill"];
    const options = {
      cwd: session.workspacePath,
      resume: sdkSessionId,
      model: runtimeEnvironment.model,
      settingSources: ["project", "user"] as SettingSource[],
      skills: "all" as const,
      includePartialMessages: true,
      permissionMode: "acceptEdits" as const,
      maxTurns: resolveAgentMaxTurns(nativeExecution ? "native" : browserAutomation ? "browser-atomic" : "test"),
      allowedTools,
      env: runtimeEnvironment.env,
      ...(executionRuntimeId === "claude-code" && runtimeEnvironment.profile ? {
        settings: buildClaudeProfileSettings(runtimeEnvironment.profile)
      } : {}),
      abortController,
      ...(executionRuntimeId === "claude-code" && (embeddedRun || nativeExecution || browserAutomation) ? {
        hooks: {
          PreToolUse: [{
            timeout: 3600,
            hooks: [async (input: HookInput) => {
              if (embeddedRun) {
                await waitForEmbeddedAgentControl(embeddedRun, turnAbortController.signal);
                if (browserAutomation) {
                  const browserState = await getEmbeddedBrowserRunState(embeddedRun);
                  if (browserState.targetId !== browserAutomation.targetId) {
                    browserAutomation = await setBrowserAutomationTarget(
                      browserAutomation.sessionId,
                      browserState.targetId
                    );
                  }
                }
              }
              if (nativeExecution) {
                await nativeExecution.waitForAgentControl(turnAbortController.signal);
              }
              const rawToolInput = input.hook_event_name === "PreToolUse" ? input.tool_input : undefined;
              const toolInput = rawToolInput && typeof rawToolInput === "object"
                ? rawToolInput as Record<string, unknown>
                : {};
              const command = String(toolInput.command || "");
              const toolName = input.hook_event_name === "PreToolUse" && "tool_name" in input
                ? String(input.tool_name)
                : "";
              const requestedSkill = toolName === "Skill"
                ? String(toolInput.skill || toolInput.name || "")
                : "";
              let violation: string | undefined;
              if (nativeExecution) {
                if (!nativeSkillLoaded) {
                  if (toolName !== "Skill") {
                    violation = "电脑桌面任务的第一项工具调用必须加载 dt-gui-computer-skill";
                  } else {
                    violation = nativeAutomationSkillViolation(requestedSkill);
                    if (!violation) nativeSkillLoaded = true;
                  }
                } else if (toolName === "Skill") {
                  violation = nativeAutomationSkillViolation(requestedSkill);
                } else if (toolName === "Bash") {
                  violation = nativeAutomationCommandViolation(
                    command,
                    nativeExecution.sessionId,
                    nativeAgentBin,
                    nativeAutomationHomePath()
                  );
                  if (violation) {
                    nativeCommandViolationCount += 1;
                    if (nativeCommandViolationCount >= 3) {
                      turnAbortController.abort();
                      violation = `${violation}。连续 3 次违反原子命令协议，本轮已停止；禁止继续探测环境或改用其他工具`;
                    }
                  } else {
                    nativeCommandViolationCount = 0;
                  }
                } else if (toolName === "Read") {
                  violation = nativeAutomationReadViolation(
                    String(toolInput.file_path || ""),
                    nativeExecution.artifactDir,
                    nativeImageReadCount
                  );
                  if (!violation) nativeImageReadCount += 1;
                } else {
                  violation = "电脑桌面任务只允许加载 dt-gui-computer-skill、调用受控 Bash 原子命令和读取当前 Rep 截图";
                }
              } else if (browserAutomation) {
                if (!browserSkillLoaded) {
                  if (toolName !== "Skill") {
                    violation = "浏览器原子任务的第一项工具调用必须加载 dt-gui-browser-skill";
                  } else {
                    violation = browserAutomationSkillViolation(requestedSkill);
                    if (!violation) browserSkillLoaded = true;
                  }
                } else if (toolName === "Skill") {
                  violation = browserAutomationSkillViolation(requestedSkill);
                } else if (toolName === "Bash") {
                  violation = browserAutomationCommandViolation(
                    command,
                    browserAutomation.sessionId,
                    browserAutomation.agentBinPath
                      || browserAutomationAgentBinPath(browserAutomation.sessionId),
                    browserAutomationHomePath(),
                    process.execPath,
                    true
                  );
                } else {
                  violation = "浏览器原子任务只允许加载 dt-gui-browser-skill 和调用受控 Bash 原子命令";
                }
              } else if (embeddedRun && command) {
                violation = managedBrowserCommandViolation(command);
              }
              return violation ? {
                hookSpecificOutput: {
                  hookEventName: "PreToolUse" as const,
                  permissionDecision: "deny" as const,
                  permissionDecisionReason: violation
                }
              } : { continue: true };
            }]
          }]
        }
      } : {})
    };

    try {
      if (turnAbortController.signal.aborted) throw new Error("任务已被中止");
      onPayload?.({
        type: "status",
        data: { phase: "waiting-runtime", label: `等待 ${executionRuntime.name} 响应` }
      });
      let queryResult: AsyncIterable<SdkMessage | NormalizedExecutionEvent>;
      if (executionRuntimeId === "claude-code") {
        console.log(`[agent] Session ${session.id}: importing Claude Agent SDK...`);
        const { query } = await import("@anthropic-ai/claude-agent-sdk");
        queryResult = query({ prompt, options }) as AsyncIterable<SdkMessage>;
      } else {
        const executable = resolveExecutionRuntimeExecutable(executionRuntimeId);
        if (!executable) {
          throw new Error(`${executionRuntime.name} 未安装或不在 PATH 中，请先在配置中心完成执行底座安装`);
        }
        if (embeddedRun) await waitForEmbeddedAgentControl(embeddedRun, turnAbortController.signal);
        if (nativeExecution) await nativeExecution.waitForAgentControl(turnAbortController.signal);
        queryResult = runExecutionRuntime({
          runtimeId: executionRuntimeId,
          executable,
          prompt,
          cwd: session.workspacePath,
          resumeSessionId: sdkSessionId,
          conversationId: session.id,
          model: runtimeEnvironment.model,
          allowedTools,
          env: runtimeEnvironment.env,
          abortSignal: turnAbortController.signal,
          startupTimeoutMs: resolveExecutionRuntimeStartupTimeout(purpose)
        });
      }
      console.log(`[agent] Session ${session.id}: ${executionRuntime.name} started, resume=${!!sdkSessionId}, cwd=${options.cwd}`);
      let msgIndex = 0;
      for await (const message of queryResult) {
        if (turnAbortController.signal.aborted) {
          aborted = true;
          break;
        }
        const normalized = executionRuntimeId === "claude-code"
          ? normalizeSdkMessage(message as SdkMessage)
          : message as NormalizedExecutionEvent;
        if (msgIndex === 0) {
          onPayload?.({
            type: "status",
            data: { phase: "running", label: `${executionRuntime.name} 已开始执行` }
          });
        }
        // Log every message for diagnosis (first 30 only)
        if (msgIndex < 30) {
          const record = message as Record<string, unknown>;
          const keys = Object.keys(record);
          const type = executionRuntimeId === "claude-code" ? String(record.type ?? "") : "normalized";
          const subtype = String(record.subtype ?? "");
          console.log(`[agent] Session ${session.id}: msg[${msgIndex}] type=${type} subtype=${subtype} keys=${keys.join(",")} normalizedKeys=${Object.keys(normalized).join(",")}`);
        }
        if (executionRuntimeId === "claude-code") {
          const record = message as Record<string, unknown>;
          const initModel = record.type === "system" && record.subtype === "init"
            ? asString(record.model)
            : undefined;
          const assistantModel = record.type === "assistant"
            ? asString(asRecord(record.message)?.model)
            : undefined;
          if (initModel || assistantModel) {
            console.log(`[agent] Session ${session.id}: sdk model=${initModel ?? assistantModel} source=${initModel ? "init" : "assistant"}`);
          }
        }
        if (executionRuntimeId !== "claude-code" && normalized.actualModel) {
          console.log(`[agent] Session ${session.id}: runtime model=${normalized.actualModel} source=init`);
        }
        msgIndex++;
        if (!assistantMessageId && (normalized.text || normalized.sdkSessionId)) {
          console.log(`[agent] Session ${session.id}: first message received from ${executionRuntime.name}`);
        }
        if (normalized.sdkSessionId) {
          sdkSessionId = normalized.sdkSessionId;
          await updateSessionStatus(session.id, "running", { sdkSessionId });
          onPayload?.({ type: "session", data: { sdkSessionId } });
        }
        if (normalized.text) {
          assistantText += normalized.text;
          if (!assistantMessageId) {
            const assistantMessage = createMessage("assistant", "", { meta: { streaming: true } });
            assistantMessageId = assistantMessage.id;
            await appendMessage(session.id, assistantMessage);
          }
          await appendMessageContent(session.id, assistantMessageId, normalized.text);
          onPayload?.({ type: "text", data: normalized.text });
        }
        if (normalized.tool) {
          onPayload?.({ type: "tool", data: normalized.tool });
          if (msgIndex < 60) {
            const toolPhase = String((normalized.tool as Record<string, unknown>).phase ?? "");
            const toolName = String((normalized.tool as Record<string, unknown>).name ?? "");
            if (toolPhase === "start" || toolPhase === "stop") {
              console.log(`[agent] Session ${session.id}: tool ${toolPhase} name=${toolName}`);
            }
          }
        }
        if (normalized.logs?.length) {
          for (const line of normalized.logs) {
            onPayload?.({ type: "log", data: line });
          }
          console.log(`[agent] Session ${session.id}: tool_result logs=${normalized.logs.length} first=${normalized.logs[0]?.slice(0, 300)}`);
          if (nativeExecution) {
            const stall = updateNativeExecutionStallState(nativeStallState, normalized.logs);
            nativeStallState = stall.state;
            if (stall.error && !turnAbortController.signal.aborted) {
              automaticAbortError = stall.error;
              console.warn(`[agent] Session ${session.id}: ${stall.error}`);
              turnAbortController.abort();
            }
          }
        }
        if (normalized.result) {
          onPayload?.({ type: "result", data: normalized.result });
          console.log(`[agent] Session ${session.id}: result subtype=${normalized.result.subtype} result=${String(normalized.result.result ?? "").slice(0, 300)}`);
          if (normalized.result.subtype === "error" || normalized.result.subtype === "error_model_not_found") {
            const errMsg = String(normalized.result.result ?? normalized.result.subtype ?? "Unknown error");
            console.error(`[agent] Session ${session.id}: SDK returned error result: ${errMsg}`);
            resultError = errMsg;
          }
        }
      }
      console.log(`[agent] Session ${session.id}: message iteration completed, total=${msgIndex}, assistantText=${assistantText.length}chars, resultError=${resultError ?? "none"}`);
    } finally {
      await stopLogStreaming();
    }

    if (turnAbortController.signal.aborted) {
      aborted = true;
    }
    if (aborted) {
      await finalizeEmbedded("aborted");
      const artifacts = await refreshArtifacts(session.id);
      const abortMsg = automaticAbortError || "任务已被中止";
      await persistAssistantFailure(abortMsg);
      await updateSessionStatus(session.id, "failed", { lastError: abortMsg, sdkSessionId, artifacts });
      onPayload?.({ type: "error", data: abortMsg });
      onPayload?.({ type: "artifacts", data: artifacts });
      onPayload?.({ type: "done" });
      return { assistantText: abortMsg, artifacts, testOutcome: "unknown" };
    }

    if (assistantMessageId) {
      await updateMessageMeta(session.id, assistantMessageId, { streaming: false });
    } else if (assistantText.trim()) {
      await appendMessage(session.id, createMessage("assistant", assistantText.trim()));
    }

    if (!resultError && browserAutomation) {
      try {
        browserAutomation = await getBrowserAutomationSession(browserAutomation.sessionId);
        resultError = browserAutomationCompletionError(browserAutomation);
      } catch (error) {
        resultError = `dt-gui-browser 无法校验任务产物：${error instanceof Error ? error.message : String(error)}`;
      }
    }
    if (!resultError && nativeExecution) {
      try {
        const nativeSession = await getNativeAutomationSession(nativeExecution.sessionId);
        resultError = nativeAutomationCompletionError(nativeSession, assistantText);
      } catch (error) {
        resultError = `dt-gui-computer 无法校验任务产物：${error instanceof Error ? error.message : String(error)}`;
      }
    }

    if (resultError) {
      await finalizeEmbedded("agent-error");
      const artifacts = await refreshArtifacts(session.id);
      const errorMsg = formatAgentResultError(resultError, Boolean(nativeExecution), executionRuntime.name);
      await persistAssistantFailure(errorMsg);
      await updateSessionStatus(session.id, "failed", { lastError: errorMsg, sdkSessionId, artifacts });
      onPayload?.({ type: "error", data: errorMsg });
      onPayload?.({ type: "artifacts", data: artifacts });
      onPayload?.({ type: "done" });
      return { assistantText: errorMsg, artifacts, testOutcome: "unknown" };
    }

    const parsed = purpose === "test"
      ? parseTestOutcome(assistantText)
      : { outcome: "unknown" as const, summary: assistantText.trim().slice(0, 1000) || undefined };
    await finalizeEmbedded("completed", parsed.outcome, parsed.summary);
    const artifacts = await refreshArtifacts(session.id);
    await updateSessionStatus(session.id, "completed", { sdkSessionId, artifacts, testOutcome: parsed.outcome, testSummary: parsed.summary });
    onPayload?.({ type: "artifacts", data: artifacts });
    onPayload?.({ type: "done" });
    return { assistantText: assistantText.trim(), artifacts, testOutcome: parsed.outcome, testSummary: parsed.summary };
  } catch (error) {
    if (turnAbortController.signal.aborted) {
      await finalizeEmbedded("aborted").catch((finalizeError) => {
        console.error(`[agent] Session ${session.id}: embedded browser abort finalize failed`, finalizeError);
      });
      const artifacts = await refreshArtifacts(session.id);
      const abortMsg = "任务已被中止";
      await persistAssistantFailure(abortMsg);
      await updateSessionStatus(session.id, "failed", { lastError: abortMsg, sdkSessionId, artifacts });
      onPayload?.({ type: "error", data: abortMsg });
      onPayload?.({ type: "artifacts", data: artifacts });
      onPayload?.({ type: "done" });
      return { assistantText: abortMsg, artifacts, testOutcome: "unknown" };
    }
    const message = error instanceof Error
      ? `${error.message}\n\n[Stack]\n${error.stack ?? "(no stack)"}`
      : String(error);
    console.error(`[agent] Session ${session.id} failed:`, error);
    await finalizeEmbedded("exception").catch((finalizeError) => {
      console.error(`[agent] Session ${session.id}: embedded browser finalize failed`, finalizeError);
    });
    const bubbleMessage = error instanceof Error ? error.message : String(error);
    await persistAssistantFailure(bubbleMessage);
    await updateSessionStatus(session.id, "failed", { lastError: message, sdkSessionId });
    onPayload?.({ type: "error", data: message });
    onPayload?.({ type: "done" });
    throw error;
  } finally {
    await finalizeEmbedded("process-exit").catch(() => undefined);
    markSessionRunFinished(session.id);
  }
}

async function startWorkspaceLogStreaming(
  sessionId: string,
  workspacePath: string,
  onLine: (line: string) => void,
  onScreenshot?: (screenshot: ScreenshotEvent) => void
): Promise<() => Promise<void>> {
  const offsets = new Map<string, number>();
  const seenScreenshots = new Map<string, number>();
  const quickResultMtimes = new Map<string, number>();
  const observationFrames = new Map<string, ObservationFrameMeta>();
  for (const file of await findStreamingLogFiles(workspacePath)) {
    try {
      offsets.set(file, (await fs.stat(file)).size);
    } catch {
      // File may disappear while the skill rotates output directories.
    }
  }
  for (const file of await findScreenshotFiles(workspacePath)) {
    try {
      seenScreenshots.set(file, (await fs.stat(file)).mtimeMs);
    } catch {
      // File may disappear while the skill rotates output directories.
    }
  }

  const tick = async () => {
    const files = await findStreamingLogFiles(workspacePath);
    for (const file of files) {
      const stat = await fs.stat(file);
      const previous = offsets.get(file) ?? 0;
      if (stat.size <= previous) {
        offsets.set(file, stat.size);
        continue;
      }
      const handle = await fs.open(file, "r");
      try {
        const length = Math.min(stat.size - previous, 32_000);
        const start = stat.size - length;
        const buffer = Buffer.alloc(length);
        await handle.read(buffer, 0, length, start);
        offsets.set(file, stat.size);
        const relative = path.relative(workspacePath, file);
        for (const line of buffer.toString("utf8").split(/\r?\n/)) {
          const text = line.trim();
          if (text) {
            onLine(redactLogLine(`[${relative}] ${text}`));
          }
        }
      } finally {
        await handle.close();
      }
    }
    if (onScreenshot) {
      await loadObservationManifests(workspacePath, observationFrames).catch(() => undefined);
      await extractQuickResultScreenshots(workspacePath, quickResultMtimes).catch(() => undefined);
      for (const file of await findScreenshotFiles(workspacePath)) {
        const stat = await fs.stat(file);
        if (stat.size <= 0) {
          continue;
        }
        const previousMtime = seenScreenshots.get(file);
        if (previousMtime === stat.mtimeMs) {
          continue;
        }
        seenScreenshots.set(file, stat.mtimeMs);
        const relativePath = path.relative(workspacePath, file);
        const version = `${Math.floor(stat.mtimeMs)}-${stat.size}`;
        const meta = observationFrames.get(normalizeRelativePath(relativePath)) ?? observationFrames.get(path.basename(file));
        onScreenshot({
          relativePath,
          url: `/api/sessions/${sessionId}/preview/${encodeURIComponent(relativePath)}?v=${version}`,
          modifiedAt: stat.mtime.toISOString(),
          stepIndex: meta?.stepIndex,
          pageUrl: meta?.pageUrl,
          title: meta?.title,
          actionSummary: meta?.actionSummary,
          source: meta ? "live" : relativePath.includes(".uiwarden-screenshots") ? "result" : "artifact"
        });
      }
    }
  };

  const timer = setInterval(() => {
    void tick().catch(() => {
      // Log streaming is best-effort and must not fail the agent turn.
    });
  }, 700);

  return async () => {
    clearInterval(timer);
    await tick().catch(() => undefined);
  };
}

async function findStreamingLogFiles(workspacePath: string): Promise<string[]> {
  const root = path.join(workspacePath, ".skill-output");
  const result: string[] = [];
  await collectLogFiles(root, result).catch(() => undefined);
  return result.filter((file) => {
    return isStreamingTraceFile(file);
  });
}

async function findScreenshotFiles(workspacePath: string): Promise<string[]> {
  const result: string[] = [];
  await collectLogFiles(path.join(workspacePath, ".skill-output"), result).catch(() => undefined);
  await collectLogFiles(path.join(workspacePath, ".uiwarden-screenshots"), result).catch(() => undefined);
  await collectLogFiles(path.join(workspacePath, "artifacts"), result).catch(() => undefined);
  await collectLogFiles(path.join(workspacePath, "outputs"), result).catch(() => undefined);
  const all = result
    .filter((file) => /\.(png|jpe?g|webp)$/i.test(path.basename(file)) && isObservationScreenshot(file));
  const hasResultFrames = all.some((file) => file.includes(".uiwarden-screenshots"));
  return all
    .filter((file) => !hasResultFrames || !file.includes("uiwarden-observation"))
    .sort((a, b) => a.localeCompare(b));
}

interface ObservationFrameMeta {
  stepIndex?: number;
  pageUrl?: string;
  title?: string;
  actionSummary?: string;
}

async function loadObservationManifests(
  workspacePath: string,
  frames: Map<string, ObservationFrameMeta>
): Promise<void> {
  const result: string[] = [];
  await collectLogFiles(path.join(workspacePath, ".skill-output"), result).catch(() => undefined);
  await collectLogFiles(path.join(workspacePath, ".uiwarden-screenshots"), result).catch(() => undefined);
  for (const file of result.filter((item) => path.basename(item).toLowerCase() === "manifest.ndjson")) {
    const raw = await fs.readFile(file, "utf8");
    for (const line of raw.split(/\r?\n/)) {
      const text = line.trim();
      if (!text) {
        continue;
      }
      const record = parseManifestLine(text);
      if (!record) {
        continue;
      }
      const framePath = asString(record.framePath) ?? asString(record.path) ?? asString(record.relativePath);
      if (!framePath) {
        continue;
      }
      const absolute = path.isAbsolute(framePath) ? framePath : path.resolve(path.dirname(file), framePath);
      const relative = normalizeRelativePath(path.relative(workspacePath, absolute));
      const meta: ObservationFrameMeta = {
        stepIndex: asNumber(record.stepIndex) ?? asNumber(record.step) ?? asNumber(record.index),
        pageUrl: asString(record.pageUrl) ?? asString(record.url),
        title: asString(record.title),
        actionSummary: asString(record.actionSummary) ?? asString(record.action) ?? asString(record.summary)
      };
      frames.set(relative, meta);
      frames.set(path.basename(framePath), meta);
    }
  }
}

function parseManifestLine(text: string): Record<string, unknown> | undefined {
  try {
    return asRecord(JSON.parse(text));
  } catch {
    return undefined;
  }
}

function isObservationScreenshot(filePath: string): boolean {
  const normalized = normalizeRelativePath(filePath).toLowerCase();
  const name = path.basename(normalized);
  if (normalized.includes("uiwarden-observation") || normalized.includes(".uiwarden-screenshots")) {
    return true;
  }
  if (/^frame[_-]?\d+.*\.(png|jpe?g|webp)$/i.test(name)) {
    return true;
  }
  return name.includes("screenshot") || name.includes("observe");
}

async function findQuickResultFiles(workspacePath: string): Promise<string[]> {
  const root = path.join(workspacePath, ".skill-output");
  const result: string[] = [];
  await collectLogFiles(root, result).catch(() => undefined);
  return result.filter((file) => /^quick_task_result.*\.json$/i.test(path.basename(file)));
}

async function extractQuickResultScreenshots(
  workspacePath: string,
  mtimes: Map<string, number>
): Promise<void> {
  const files = await findQuickResultFiles(workspacePath);
  for (const file of files) {
    const stat = await fs.stat(file);
    if (stat.size > 120 * 1024 * 1024 || mtimes.get(file) === stat.mtimeMs) {
      continue;
    }
    mtimes.set(file, stat.mtimeMs);
    const raw = await fs.readFile(file, "utf8");
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }
    const history = asArray(asRecord(parsed)?.history);
    if (!history.length) {
      continue;
    }
    const relativeBase = path.relative(path.join(workspacePath, ".skill-output"), path.dirname(file));
    const targetDir = path.join(workspacePath, ".uiwarden-screenshots", relativeBase);
    await fs.mkdir(targetDir, { recursive: true });
    const manifestLines: string[] = [];
    for (const entry of history) {
      const record = asRecord(entry);
      const state = asRecord(record?.state);
      const base64 = asString(state?.screenshot);
      if (!base64 || base64.length < 2000) {
        continue;
      }
      const metadata = asRecord(record?.metadata);
      const stepNumber = asNumber(metadata?.step_number) ?? asNumber(metadata?.stepNumber);
      const stepLabel = stepNumber != null ? String(stepNumber).padStart(2, "0") : "00";
      const hash = createHash("sha1").update(base64.slice(0, 4096)).digest("hex").slice(0, 12);
      const target = path.join(targetDir, `frame_${stepLabel}_${hash}.png`);
      try {
        await fs.access(target);
      } catch {
        await fs.writeFile(target, Buffer.from(base64, "base64"));
      }
      const actionSummary = summarizeExecutedAction(asArray(record?.executed_actions)?.[0]);
      const frameEntry = {
        framePath: target,
        stepIndex: stepNumber ?? 0,
        pageUrl: asString(state?.url) ?? "",
        title: asString(state?.title) ?? "",
        actionSummary,
        source: path.relative(workspacePath, file)
      };
      manifestLines.push(JSON.stringify(frameEntry));
    }
    if (manifestLines.length) {
      const manifestPath = path.join(targetDir, "manifest.ndjson");
      await fs.writeFile(manifestPath, manifestLines.join("\n") + "\n", "utf8");
    }
  }
}

function summarizeExecutedAction(action: unknown): string {
  const record = asRecord(action);
  if (!record) {
    return "";
  }
  const keys = Object.keys(record).filter((key) => record[key] != null);
  if (!keys.length) {
    return "";
  }
  const key = keys[0];
  const detail = asRecord(record[key]);
  const parts: string[] = [key];
  if (detail) {
    for (const field of ["url", "index", "text", "selector"]) {
      const value = asString(detail[field]);
      if (value) {
        parts.push(`${field}=${value.slice(0, 60)}`);
        break;
      }
    }
  }
  return parts.join(" ");
}

function isStreamingTraceFile(filePath: string): boolean {
  const normalized = filePath.replaceAll("\\", "/");
  const name = path.basename(normalized).toLowerCase();
  if (name.endsWith(".html") || name.endsWith(".png") || name.endsWith(".jpg") || name.endsWith(".jpeg")) {
    return false;
  }
  if (name === "uiwarden-live.log" || name === "log.log" || name === "execution.log" || name === "agent_unified.log") {
    return true;
  }
  if (name.endsWith(".log")) {
    return true;
  }
  if (name === "completion_validation.md" || name === "results.md") {
    return true;
  }
  return false;
}

function redactLogLine(text: string): string {
  return text
    .replace(/((?:password|passwd|pwd|token|api[_-]?key|secret)\s*[:=]\s*)[^\s,;}]+/gi, "$1******")
    .replace(/("(?:password|passwd|pwd|token|api[_-]?key|secret)"\s*:\s*")[^"]+(")/gi, "$1******$2");
}

async function collectLogFiles(current: string, result: string[]): Promise<void> {
  const entries = await fs.readdir(current, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(current, entry.name);
    if (entry.isDirectory()) {
      await collectLogFiles(fullPath, result);
    } else if (entry.isFile()) {
      result.push(fullPath);
    }
  }
}

function buildPrompt(
  userText: string,
  files: UploadedFileInfo[],
  session?: AgentSession,
  embeddedRun?: EmbeddedBrowserRunHandle,
  purpose: ExecutionPurpose = "test",
  nativeExecution?: NativeAgentExecutionContext,
  browserAutomation?: BrowserAutomationSession,
  executionRuntimeId: ExecutionRuntimeId = "dtcoder",
  nativeAgentBin = nativeAutomationBinPath()
): string {
  if (nativeExecution) {
    const daemonBackedRuntime = executionRuntimeId === "dtcoder";
    const cliPrefix = daemonBackedRuntime
      ? `${shellQuote(nativeAgentBin)} --runtime-home ${shellQuote(nativeAutomationHomePath())}`
      : `"$DT_GUI_COMPUTER_BIN"`;
    const providerRef = daemonBackedRuntime ? shellQuote(nativeExecution.providerId) : `"$DT_GUI_COMPUTER_PROVIDER_ID"`;
    const sessionRef = daemonBackedRuntime ? shellQuote(nativeExecution.sessionId) : `"$DT_GUI_COMPUTER_SESSION_ID"`;
    const fileSection = files.length
      ? `\n\n用户上传文件：\n${files.map((file) => `- ${file.originalName}: ${file.path}`).join("\n")}`
      : "";
    return `请作为 UIWarden 原生应用操作智能体执行当前任务。

**执行目标**
- 应用：${nativeExecution.appDisplayName}
- Provider：${nativeExecution.providerId}
- 投递模式：${nativeExecution.deliveryMode}
- dt-gui-computer 会话：${nativeExecution.sessionId}
- Native Rep：${nativeExecution.artifactDir}

**强制执行协议**
1. ${executionRuntimeId === "cfuse" || executionRuntimeId === "claude-code"
      ? "第一项工具调用必须使用 Skill 工具加载 `dt-gui-computer-skill`。"
      : "开始执行前必须加载并遵循 `dt-gui-computer-skill`；当前底座没有独立 Skill 工具时，读取 `.agents/skills/dt-gui-computer-skill/SKILL.md`，不得跳过。"}由当前主 Agent 理解意图、选择应用并规划动作，Skill 只提供原子能力约束。
2. 加载 Skill 后，第一条终端命令必须逐字以 \`${cliPrefix} apps list --provider ${providerRef}\` 开头。用户明确给出应用名时追加 \`--query "<应用名>" --limit 20 --json\` 精确检索；应用不明确时才使用不带 query 的列表。${daemonBackedRuntime
      ? `当前 DTCoder 的 exec 工具由常驻 daemon 执行，不继承本轮进程环境；因此必须始终复用上述绝对 CLI 前缀，并在后续动作中逐字使用会话 ${sessionRef}，禁止改回 \`$DT_GUI_COMPUTER_*\` 变量。`
      : "禁止把变量展开成路径，禁止猜测 Skill 目录下存在 bin，禁止通过 env/export/which/ls/echo 探测或覆盖环境变量。"}若策略拒绝命令，只按上述可信入口修正，不得尝试其他工具。
3. 这不是浏览器任务，也不是测试用例执行。禁止调用 ui-test-assistant-skill、browser-use、Playwright、Chrome 或任何网页执行内核。
4. 先执行 \`apps list\` 读取当前桌面应用；列表同时包含已运行和已安装但未运行的应用。必须按用户给出的应用名称、稳定 ID 或明确别名匹配，不能因为名称相似就选择其他应用。已运行应用使用 \`session target\`；\`isRunning=false\` 的已安装应用必须使用其稳定 ID 执行受控 \`session launch\`。不要让用户手工选择，也不要直接调用 open、osascript、Spotlight 或 Start-Process。
5. 目标绑定后立即使用不带 \`--full\` 的紧凑 observe，从最新 snapshotId 和语义元素规划动作；禁止猜测 elementId。先读取 snapshot.delta：焦点、窗口、文本和元素增删改是动作后进展证据，未执行新动作时禁止把重复 observe 当作等待循环。先把用户指令拆成“应用、操作对象、动作、内容”四部分；应用名称、所有格和介词短语不能并入操作对象。例如“在聊天应用里给测试联系人发送消息”或“给测试联系人的聊天应用发送消息”都应解析为应用=聊天应用、对象=测试联系人、动作=发送，不能搜索“测试联系人的聊天应用”。消息任务优先检查当前聊天列表，再搜索对象短名称；输入后必须先观察到搜索框中完整的目标短名称，常用联系人、消息正文、搜索历史、发送人元数据或无关区域里出现同名文字不算搜索命中。搜索成功必须同时存在已输入查询和由该查询产生的联系人/会话结果项，选中成功必须由当前会话标题或联系人详情再次确认目标。自绘搜索框经一次语义中心点击、一次 observe 和一次 focused 输入后仍为空时，只允许再尝试一次基于最新快照的快捷键聚焦路径；仍为空或结果区不变就停止并报告焦点缺口，禁止点击正文或窗口外的同名元素。发送消息只有在目标会话身份已核对且最终 observe 暴露该会话中的已发送内容时才算完成。紧凑树未暴露目标时先检查 \`projection.truncated\`，为 true 时优先改用 \`observe --query "搜索文本" --limit 60\` 获取结构化子集；仅当紧凑观察和定向查询都不足时才使用 \`--full\`，禁止读取 Claude 内部 tool-results、使用 grep/管道/重定向/ls 或虚构文件命令。动作完成后重新 observe。用户或任务给出的绝对文件路径必须逐字输入，禁止拼接当前工作区、home 或应用默认目录；提交文件选择框前必须重新 observe 核对可见路径。对数字、文本片段或快捷键等精确序列，执行前先拆出完整有序 token，每个 token（包括重复项）都必须对应一次成功的 Runtime 动作，并在结束前核对动作账本。必须逐字保留操作数边界，例如“1 + 100”只能映射为“[1] [加] [1] [0] [0] [等于]”，不能扩写为“100 + 100”或漏写为“1 + 00”。
6. 遇到 STALE_SNAPSHOT 时重新 observe；遇到 APPROVAL_REQUIRED、HANDOFF_REQUIRED 或 HUMAN_CONTROL_ACTIVE 时立即停止后续动作，在结果中原样报告挑战 ID/原因，等待 UIWarden 控制面板处理。遇到 PROVIDER_UNAVAILABLE、Provider 未返回响应或 Provider 超时，只允许在重新 observe 后重试原动作一次；再次出现同类 Provider 故障必须立即报告 blocked。禁止改用 key、visual-click、坐标点击或其他动作类型继续试探，因为这些动作共享同一 Provider 通道。
7. 禁止执行 session start/stop/control 或 approval grant/reject；会话生命周期、控制权和审批由 UIWarden 服务端管理。仅允许 session target/session launch 选择当前会话的目标应用。
8. 默认使用语义元素。${nativeExecution.deliveryMode === "background-safe"
      ? "当前是严格后台模式：Provider 只允许 AX 语义动作或定向发送给目标 PID 的事件，不会激活目标应用、移动系统鼠标、发送全局键盘/滚轮或占用剪贴板。每个动作结果必须检查 `backgroundSafetyVerified=true` 与 `targetApplicationActivated=false`；`frontmostApplicationUnchanged`、`cursorUnchanged` 仅记录动作期间用户是否同时操作电脑，不能单独据此判定 Provider 干扰。对 AXTextField、AXTextArea、AXSearchField 等可编辑元素，直接使用 set-value 或 type-text --element，禁止先 click 聚焦，也禁止退化为 visual-click。遇到 `BACKGROUND_ACTION_REQUIRES_VISIBLE_WINDOW` 时，该动作不可用但会话仍可继续：重新 observe 后只允许尝试一次 AXPress、AXSetValue 等语义替代路径，禁止恢复窗口或切换到前台；没有语义路径时报告 blocked。只有遇到 `BACKGROUND_INTERFERENCE_DETECTED` 或 `BACKGROUND_ACTION_UNSUPPORTED` 才必须立即停止并报告，禁止自行切换为前台兼容路径。"
      : "当前是前台兼容模式：目标应用可能被激活，用户同时操作相同窗口会发生焦点或键鼠冲突。"}元素 actions 包含 \`UIWardenCenterClick\` 时，允许对该元素 ID 使用 \`--allow-coordinate-fallback\`。AX Tree 无可用元素但最新截图存在目标文字时，优先使用 \`visual-click --text <文字> --match exact|contains --occurrence <序号>\`；Runtime 会把 OCR 窗口坐标映射到目标应用并生成动作后截图。只有两者都不可用时才允许显式 \`--x/--y --allow-coordinate-fallback\`，裸坐标无需审批但必须绑定最新 snapshot 并保留 Rep 审计，禁止猜测窗口外坐标。对话框或表单已经打开时必须先完成当前表单，禁止无依据返回首页重新导航。
9. 每个正常动作优先追加 \`--observe --diff\`，直接使用返回的 post-action \`snapshot\` 规划下一步，避免为同一动作再发一次独立 observe；差量响应中的新增/更新元素和删除 ID 应与首个完整观察合并理解，未变化元素可继续使用原 elementId，但必须绑定最新 snapshotId。若返回 \`diffTruncated=true\`，禁止基于不完整变化继续动作，必须补一次定向查询或完整观察。仅在首个动作、差量截断、定向查询/完整投影、人工接管后恢复或旧 Runtime 未返回 snapshot 时单独 observe。优先使用 AX Tree 与 \`observe --query\` 的结构化证据，不要在每次 observe 后自动读取截图。仅当 AX 未暴露下一步所需信息、需要准备/验证 visual-click，或需要一次最终视觉确认时，才允许 Read 最新 screenshotPath；同一路径禁止重复读取，结构化状态已足够时禁止连续读取图片。单次任务最多向模型 Read ${NATIVE_MODEL_IMAGE_READ_LIMIT} 张截图，完整截图仍由 Native Rep 持续保存，不受此预算影响；预算耗尽后改用 AX 证据，确需视觉证据则停止并报告采集缺口。visual-click 返回的 visualChanged 只证明像素发生变化，不证明业务动作成功，动作后的 post-action snapshot 仍必须用于核对目标状态。若连续两次观察的目标窗口、关键文本和可操作元素都没有变化，最多尝试一种基于最新证据的替代动作；仍无变化就停止并报告阻塞点，禁止重复导航直到耗尽 turns。不要输出 PASS/FAIL 或测试覆盖结论。只报告已完成动作、当前应用状态、未执行动作和需要人工处理的风险。必须区分“AX/截图直接观察到的证据”和“预期/推断结果”；最终观察与可用截图未暴露具体值时必须立即标记为未验证并停止，禁止用常识计算结果冒充界面证据，也禁止为抓取不可访问值而虚构 get 命令或继续发送按键、点击和焦点变更。最终一行必须输出 \`[UIWARDEN_NATIVE_RESULT: completed]\` 或 \`[UIWARDEN_NATIVE_RESULT: blocked]\`；只有全部用户目标均有最终证据时才能使用 completed。
10. 禁止只描述计划；加载 Skill 后立即发现应用并执行。当前执行底座为 ${getExecutionRuntimeDefinition(executionRuntimeId).name}。

用户任务：
${userText}${fileSection}`;
  }
  if (purpose === "operation" && browserAutomation) {
    const daemonBackedRuntime = executionRuntimeId === "dtcoder";
    const cliPrefix = daemonBackedRuntime
      ? shellQuote(browserAutomation.agentBinPath || browserAutomationAgentBinPath(browserAutomation.sessionId))
      : `"$DT_GUI_BROWSER_BIN"`;
    const sessionArg = "";
    const fileSection = files.length
      ? `\n\n用户上传文件：\n${files.map((file) => `- ${file.originalName}: ${file.path}`).join("\n")}`
      : "";
    const manualLogin = requiresManualLogin(userText);
    const browserName = session?.browserKernel === "external-cdp"
      ? "用户浏览器桥接"
      : session?.browserKernel === "playwright"
        ? "Playwright 配套 Chromium"
      : session?.browserKernel === "gui-computer"
        ? "本机独立 gui-browser"
        : "客户端内置 gui-browser";
    const agentMaySelectTab = browserAutomation.targetSelection === "agent";
    return `请作为 UIWarden 浏览器页面操作智能体执行当前任务。

**执行目标**
- 浏览器：${browserName}
- CDP target：${browserAutomation.targetId}
- dt-gui-browser 会话：${browserAutomation.sessionId}
- Browser Rep：${browserAutomation.artifactDir}

**强制执行协议**
1. ${executionRuntimeId === "cfuse" || executionRuntimeId === "claude-code"
      ? "第一项工具调用必须使用 Skill 工具加载 `dt-gui-browser-skill`。"
      : "开始执行前必须加载并遵循 `dt-gui-browser-skill`；当前底座没有独立 Skill 工具时，读取 `.agents/skills/dt-gui-browser-skill/SKILL.md`，不得跳过。"}由当前主 Agent 理解用户意图并规划步骤，Skill 只提供浏览器原子能力约束。
2. 这不是 UI 测试、回归或巡检任务。禁止加载 ui-test-assistant-skill，禁止调用 quick、YAML、browser-use、Playwright、任意 JavaScript或另起浏览器；不要输出 PASS/FAIL、断言或覆盖率。
3. 加载 Skill 后第一条终端命令必须逐字使用 \`${cliPrefix} tabs list${sessionArg} --json\`。${agentMaySelectTab
        ? `根据返回候选页的 title 和 URL 判断最匹配页面；需要切换时只允许执行 \`${cliPrefix} tabs activate${sessionArg} --target "<候选 targetId>" --json\`，随后执行 \`observe${sessionArg} --json\`。`
        : `随后使用相同前缀执行 \`observe${sessionArg} --json\`。`}该会话专属入口已经绑定打包 Node、Runtime Home 和当前 session；所有后续动作必须复用该入口，禁止追加 \`--node\`、\`--runtime-home\`、\`--session\`，禁止改回 \`$DT_GUI_BROWSER_*\` 或猜测安装位置。只能使用最新 snapshotId、elementId 和元素声明的 actions。每次只执行一个动作；首个观察使用全量，后续动作完成后使用 \`observe --diff --json\` 获取增量。增量中的 elementId 稳定，必须与首个完整观察合并理解；\`diffTruncated=true\` 时补一次完整 observe。禁止猜测 elementId 或复用旧 snapshotId。
4. ${agentMaySelectTab
      ? "只允许在首次 `tabs list` 返回且标记 allowed 的候选页中选择；禁止扫描、attach 或接管本次授权集合外的页面。"
      : "必须操作 UIWarden 控制面已选定的 target，不得扫描或回退到其他页面；需要切换标签页时由用户在 UI 操作页选择。"}Agent 禁止执行 session start/stop/target/control 或自行 attach 其他 target。
5. 密码和安全字段必须由用户在真实页面输入。遇到 HANDOFF_REQUIRED 或 HUMAN_CONTROL_ACTIVE 时停止动作并等待用户接管；不得索要明文密码或换用其他输入方式绕过。${manualLogin ? "当前登录任务已进入人工控制；等待用户在可见页面完成敏感输入并点击继续，不要提前结束。" : ""}
6. 遇到 STALE_SNAPSHOT 时重新 observe；页面状态、截图或语义树无法证明结果时，明确标记证据缺口，不得推断为已完成。搜索框 value 已更新不代表搜索成功，必须以 URL、页面标题或结果区域变化确认；若提交后仍是旧页面，只允许尝试一种基于最新证据的替代提交动作，第二次观察仍冲突就停止并报告，禁止在 Enter、点击、刷新或导航之间循环。
7. 下载动作后使用 \`${cliPrefix} downloads list${sessionArg} --json\` 读取完成状态、建议文件名和 Rep 文件存在性；禁止猜测 downloads/events/get-attribute 等未定义命令，也不能用点击成功代替下载完成证据。
8. 对提交、发送、删除、支付等不可逆动作，严格遵循用户指令中的审批边界。未明确授权时停在最终动作之前。
9. 禁止只描述计划；加载 Skill 后立即在当前可见浏览器中执行。当前执行底座为 ${getExecutionRuntimeDefinition(executionRuntimeId).name}。结束时只能把当前 dt-gui-browser session 返回成功动作记录的操作称为“本轮已执行”；进入时已存在的页面状态必须写成“初始观察已满足”，不能冒充本轮动作。只报告已完成动作、直接观察到的页面状态、未完成项和产物路径。

用户任务：
${userText}${fileSection}`;
  }
  const targetUrl = extractFirstUrl(userText);
  const isCdpSession = session?.browserKernel === "external-cdp" || session?.kind === "cdp";
  const isEmbeddedSession = session?.browserKernel === "uiwarden-embedded" || session?.browserKernel === "gui-computer";
  // CDP 直连会话：非首轮（已存在 sdkSessionId 说明前面已有执行轮次）默认 --resume 续跑
  const isCdpFollowUp = isCdpSession && Boolean(session?.sdkSessionId);
  const isEmbeddedFollowUp = isEmbeddedSession && Boolean(session?.sdkSessionId);
  const manualLogin = isEmbeddedSession && requiresManualLogin(userText);
  const cdpSection = isCdpSession
    ? `\n\n**CDP 直连会话（当前会话类型）**：本会话附着用户本机 CDP 浏览器（已由客户端托管启动，端口默认 9222），复用浏览器中已有登录态执行页面操作：
   - 任何 \`run_quick_mode.py\` 命令**必须加 \`--cdp\`**，**禁止**加 \`--no-cdp\` 或 \`--headed\`（CDP 模式直接操作用户可见的浏览器窗口）。
   - **CDP 连接或执行失败时，直接在回复中说明失败原因**（如"CDP 浏览器未启动""9222 端口不可达""Browser context management is not supported"等原始报错），**禁止**回退 \`--headed\` 或 \`--no-cdp\` 重试——那会另起一个独立的 Playwright 浏览器实例，不是用户可见的 CDP 窗口，与"复用登录态"目标相悖，会导致页面弹出但实际不在该页面操作。
   - 浏览器中已登录的站点**无需再次登录**，不要因缺少凭据阻断执行；未登录且用户未给凭据时才说明缺失。
   - 操作的是浏览器**当前活动标签页**；用户可能已把目标页面打开在活动标签页上，优先基于当前页面继续操作，而不是强行跳转。${
     isCdpFollowUp
       ? "\n   - 本轮为**续轮**：上一轮执行后用户可能已手动操作了浏览器（人机协同）。执行 quick 时**追加 `--resume`** 接着同一 CDP 标签页当前状态继续，不要重新打开入口 URL。"
       : "\n   - 本轮为该 CDP 会话**首轮**：直接 `--cdp` 执行，不加 `--resume`。"
   }
   - 执行结束后简要说明页面当前停留状态，方便用户接手手动操作后再发起下一轮。`
    : "";
  const embeddedSection = isEmbeddedSession && embeddedRun
    ? `\n\n**UIWarden 可控浏览器执行内核（当前会话）**：
   - 真实浏览器运行在${session?.browserKernel === "gui-computer" ? "独立安装的 gui-computer" : "客户端内置窗口"}，执行会话文件为 \`${embeddedRun.sessionFile}\`，CDP target 为 \`${embeddedRun.execution.targetId}\`。
   - 任何 \`run_quick_mode.py\` 命令必须加 \`--cdp --headed\`，并保留环境变量 \`UIWARDEN_EMBEDDED_BROWSER_SESSION_FILE\`；禁止使用 \`--no-cdp\` 或另起浏览器。headed 仅表示连接当前可见窗口，不得启动新的 Playwright 浏览器。
   - browser-use 必须操作执行会话指定的 targetId，禁止选择 pages[0] 或 UIWarden 自身页面。
   - CDP 连接失败时直接报告协议错误并停止；测试任务禁止回退到 \`dt-gui-browser-skill\` 或原子 UI 操作链，以免掩盖 browser-use 接入失败。
   - 当前锁定的是用户可见活动标签页，启动时 URL 为 \`${embeddedRun.execution.pageUrl || "about:blank"}\`。${
     isEmbeddedFollowUp
       ? "本轮为续轮：如果用户本轮没有明确提供新 URL，必须直接观察并继续操作当前页面；禁止注入 skill `.env` 的 QUICK_URL、禁止新建页面或重开入口。用户可能已手动切换标签或改变页面状态，以本轮锁定 target 的实时状态为准。"
       : "本轮为首轮：也必须在该标签页内导航和操作，不得创建额外页面。"
   }
   - 可控浏览器复用持久登录态。登录任务没有提供凭据时，禁止调用 AskUserQuestion 索要账号或密码；必须先打开登录页面并等待用户在真实页面手动输入敏感信息。${manualLogin ? "当前任务已自动进入 human-control，等待用户完成登录后点击继续；不要提前结束会话。" : ""}
   - 用户可在浏览器窗口点击或通过控制栏接管；处于 human-control 时保持进程和录制连接，恢复 Agent 后再执行下一步。
   - 本轮截图、network、console、page error 和输入事件写入 \`${embeddedRun.repDir}\`。`
    : "";
  const desktopSection = isDesktopMode() && !isCdpSession && !isEmbeddedSession
    ? `\n\n**桌面客户端本地模式（当前运行环境）**：本服务运行在用户本机（桌面客户端），可以直接使用用户本机的浏览器环境：
   - 默认**无头模式**执行（不加 \`--headed\`），避免执行过程中弹出浏览器窗口打扰用户。
   - 用户提到"本地登录态/已登录/我的浏览器/已有 Chrome/CDP"等语义时，追加 \`--cdp\` 附着用户本机 Chrome，复用本机登录态。
   - 只有用户明确要求"有头/可视化/打开浏览器观察"时才追加 \`--headed\`。`
    : "";
  const fileSection = files.length
    ? `\n\n用户上传文件：\n${files
        .map((file) => `- ${file.originalName}: ${path.relative(path.dirname(file.path), file.path)}`)
        .join("\n")}\n\n上传文件绝对路径：\n${files.map((file) => `- ${file.path}`).join("\n")}`
    : "";

  const targetUrlSection = targetUrl
    ? `\n\n识别到用户指定目标 URL：${targetUrl}\n执行 ui-test-assistant-skill 的 quick/巡检/冒烟脚本时，任何 \`run_quick_mode.py\` Bash 命令都必须包含 \`--target-url "${targetUrl}"\`，不能只把 URL 写进 \`--query\` 文本；不得让 skill 的 config/.env QUICK_URL 覆盖用户目标。`
    : "";

  const purposeSection = purpose === "operation"
    ? `\n\n**当前模式：通用 UI 操作**\n- 这不是测试任务，禁止输出 PASS/FAIL，禁止虚构测试断言或测试覆盖率。\n- 只报告已完成动作、当前页面状态、未执行动作和需要人工审批的风险。\n- 最终提交、发送、删除、支付等不可逆动作必须遵守用户指令中的审批边界。`
    : "";

  return `${purpose === "operation" ? "请作为通用 UI 操作智能体处理用户任务。" : "请作为 UI 测试智能体处理用户任务。"}${purposeSection}

要求：
1. 优先使用本工作区的 ui-test-assistant-skill。
2. ${purpose === "operation" ? "如果任务可直接执行，完成用户指定的 UI 操作并记录操作产物；不要生成测试用例或测试结论。" : "如果任务可直接执行，完成 UI 测试、生成/执行用例或巡检，并把产物写入 .skill-output。"}
3. 如果缺少 URL 或必要文件，明确列出缺失项，不要猜测；但 UIWarden 可控浏览器续轮允许直接使用当前可视页面，不视为缺少 URL。对于公开网站（如百度、淘宝首页等无需登录即可访问的页面），不要要求登录凭据，直接执行测试；仅当用户明确要求测试需要登录的功能时才询问账号密码。
4. 用户消息中包含 URL 时，该 URL 优先级高于 skill 内置 config/.env 的 QUICK_URL；调用 quick/巡检/冒烟脚本时，Bash 命令必须显式传 --target-url，不能只把 URL 写进 --query。
5. 运行 ui-test-assistant-skill 的 quick/巡检/冒烟脚本时，Bash 命令必须把 stdout 和 stderr 通过 tee 追加写入 .skill-output/uiwarden-live.log，例如在命令末尾使用 \`2>&1 | tee -a .skill-output/uiwarden-live.log\`；不要只等待命令结束后总结。
6. 执行 browser-use 时必须开启或保留实时观察输出：将逐步截图写入环境变量 \`UIWARDEN_OBSERVATION_DIR\` 指向的目录；如脚本支持 observe/screenshot/trace 参数，优先开启。
7. 每个 browser-use step 后如能获取页面截图，保存为 \`frame_0001.png\` 这类递增文件，并向同目录 \`manifest.ndjson\` 追加一行 JSON，字段包含 \`framePath\`、\`stepIndex\`、\`url\`、\`title\`、\`actionSummary\`、\`timestamp\`。
8. 执行 browser-use 后，如 quick_task_result.json 中包含截图或页面状态，保留该结果文件，不要删除。
9. 结束前简要说明执行结果、关键产物路径和需要人工补充的信息。
10. 执行 Python 脚本时，**必须**使用环境变量 \`$UI_TEST_PYTHON\` 或 \`python3\` 命令，**禁止**使用 \`python3.10\`。skill 文档提到的 "3.10.x" 是最低版本要求，Python 3.11+ 完全兼容。不要在执行前检查 Python 版本或寻找 python3.10，直接用 \`python3\` 或 \`$UI_TEST_PYTHON\` 运行脚本即可。
11. **禁止只描述计划而不执行**。收到任务后必须立即通过 Bash 工具执行命令，不能只输出文字说"我将执行..."或"正在执行..."而不实际调用 Bash。不要分步检查环境再决定是否执行，直接运行命令。

**run_quick_mode.py 参数规则（必须严格遵守，违反会导致命令报错或执行失败）：**

A. **登录凭据**：
   - 用户说"不需要登录/无需登录/公开页面"、测试公开网站，或当前为 UIWarden 可控浏览器且由用户在真实页面手动登录时，**必须加 \`--no-login\`**，不得因缺少 .env 凭据而阻断执行。
   - 用户在对话中提供了账号密码时，**必须加 \`--username <账号> --password <密码>\`**，不得停下来问确认或要求编辑 .env。
   - **禁止**在用户已提供凭据后还提示"缺少登录凭据配置"。

B. **无头/有头模式**：
   - \`--headless\` 是开关标志（store_true），**不加值**。正确：\`--headless\`。错误：\`--headless true\`、\`--headless=false\`。
   - \`--headed\` 也是开关标志，**不加值**。正确：\`--headed\`。错误：\`--headed true\`。
   - **禁止**使用 \`--no-headless\`（该参数不存在）。
   - 默认无头模式，不需要显式传 \`--headless\`。只有用户明确要求"有头/可视化/打开浏览器观察"时才加 \`--headed\`。

C. **命令格式**：
   - \`--query\` 必须包含用户原始任务描述（含"不需要登录"等关键词），脚本会自动从中推断 \`--no-login\` 等意图。
   - \`--target-url\` 传 URL，\`--query\` 传任务描述，两者分开。
   - **禁止**直接调用 \`python3 -m browser_use.cli\`，**必须**通过 \`run_quick_mode.py\` 执行，脚本会自动解析正确的 Python 解释器。
   - **禁止**在命令中使用 \`--no-headless\`、\`--headless true\`、\`--headless=false\` 等无效参数。

D. **标准命令示例**：
   - 公开页面：\`python3 .claude/skills/ui-test-assistant-skill/package/scripts/run_quick_mode.py --query "测试百度首页" --target-url "https://www.baidu.com" --no-login --output-dir .skill-output/quick 2>&1 | tee -a .skill-output/uiwarden-live.log\`
   - 需登录页面：\`python3 .claude/skills/ui-test-assistant-skill/package/scripts/run_quick_mode.py --query "测试数据生成页面" --target-url "https://example.com/app" --username "mingxiong" --password "mingxiong1023" --output-dir .skill-output/quick 2>&1 | tee -a .skill-output/uiwarden-live.log\`

用户任务：
${userText}${targetUrlSection}${fileSection}${desktopSection}${cdpSection}${embeddedSection}`;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

export function extractFirstUrl(text: string): string | undefined {
  const match = text.match(/\bhttps?:\/\/[^\s"'<>，。；、）)]+|\b(?:www\.)[^\s"'<>，。；、）)]+/i);
  if (!match) {
    return undefined;
  }
  const raw = match[0].replace(/[，。,.；;]+$/g, "");
  return /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
}

export function requiresManualLogin(text: string): boolean {
  const loginIntent = /登录|登陆|log\s*in|sign\s*in/i.test(text);
  const hasPassword = /(?:密码|password|passwd|pwd)\s*[:：=]\s*\S+/i.test(text);
  return loginIntent && !hasPassword;
}

function normalizeSdkMessage(message: SdkMessage): {
  sdkSessionId?: string;
  actualModel?: string;
  text?: string;
  tool?: Record<string, unknown>;
  logs?: string[];
  result?: Record<string, unknown>;
} {
  const type = String(message.type ?? "");

  if (type === "system" && message.subtype === "init") {
    return { sdkSessionId: asString(message.session_id) ?? asString(message.sessionId) };
  }

  if (type === "stream_event") {
    const event = asRecord(message.event);
    if (event?.type === "content_block_delta") {
      const delta = asRecord(event.delta);
      if (delta?.type === "text_delta") {
        return { text: asString(delta.text) ?? "" };
      }
      if (delta?.type === "input_json_delta") {
        return {
          tool: {
            phase: "input",
            chunk: asString(delta.partial_json) ?? ""
          }
        };
      }
    }
    if (event?.type === "content_block_start") {
      const block = asRecord(event.content_block);
      if (block?.type === "tool_use") {
        return {
          tool: {
            phase: "start",
            name: block.name,
            id: block.id
          }
        };
      }
    }
    if (event?.type === "content_block_stop") {
      return { tool: { phase: "stop" } };
    }
  }

  if (type === "assistant") {
    const content = Array.isArray(message.message)
      ? message.message
      : Array.isArray(message.content)
        ? message.content
        : [];
    const text = content
      .map((item) => {
        const block = asRecord(item);
        return block?.type === "text" ? asString(block.text) ?? "" : "";
      })
      .join("");
    return text ? { text } : {};
  }

  const toolLogs = extractToolResultLogs(message);
  if (toolLogs.length) {
    return { logs: toolLogs };
  }

  if (type === "result") {
    return {
      result: {
        subtype: message.subtype,
        result: message.result,
        totalCostUsd: message.total_cost_usd,
        durationMs: message.duration_ms
      }
    };
  }

  return {};
}

function extractToolResultLogs(message: SdkMessage): string[] {
  const content = Array.isArray(message.message)
    ? message.message
    : Array.isArray(message.content)
      ? message.content
      : [];
  const lines: string[] = [];
  for (const item of content) {
    const block = asRecord(item);
    if (!block || block.type !== "tool_result") {
      continue;
    }
    const rawContent = block.content;
    const text = Array.isArray(rawContent)
      ? rawContent
          .map((part) => {
            const partRecord = asRecord(part);
            return partRecord?.type === "text" ? asString(partRecord.text) ?? "" : "";
          })
          .join("\n")
      : asString(rawContent) ?? "";
    for (const line of text.split(/\r?\n/).slice(-80)) {
      const trimmed = line.trim();
      if (trimmed) {
        lines.push(redactLogLine(`[tool_result] ${trimmed}`));
      }
    }
  }
  return lines;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}

// 解析逻辑已抽到无副作用的纯模块 ./testOutcome.ts 以便独立单测；此处再导出保持外部调用点不变。
export { parseTestOutcome };
export type { TestResultParse } from "./testOutcome.js";

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function normalizeRelativePath(value: string): string {
  return value.replaceAll("\\", "/");
}
