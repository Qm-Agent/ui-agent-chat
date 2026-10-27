import path from "node:path";
import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { runAgentForSession } from "./agent.js";
import {
  findLatestBrowserAutomationSessionForUiwardenSession,
  forceStopBrowserAutomationSessionsForUiwardenSession,
  readBrowserAutomationSnapshots,
  type BrowserAutomationSession,
  type BrowserAutomationSnapshot
} from "./browserAutomation.js";
import { createCdpTaskGroup } from "./cdpManager.js";
import { buildEnvironmentPrompt, getBusinessEnvironment } from "./configStore.js";
import {
  createMessage,
  createSession,
  appendMessage,
  loadSession,
  refreshArtifacts,
  updateSessionBrowserKernel,
  updateSessionStatus
} from "./storage.js";
import { prepareWorkspace } from "./workspace.js";
import {
  clickNativeAutomationSessionAsUser,
  getNativeAutomationSession,
  grantNativeAutomationApproval,
  observeNativeAutomationSession,
  rejectNativeAutomationApproval,
  setNativeAutomationControl,
  startNativeAutomationSession,
  stopNativeAutomationSession,
  type NativeAutomationSession,
  type NativeAutomationSnapshot
} from "./nativeAutomation.js";
import {
  AGENT_SELECTED_NATIVE_APP,
  appendUiOperationRun,
  deleteUiOperationTask,
  loadUiOperationTask,
  setUiOperationConversationSession,
  upsertUiOperationTask,
  updateUiOperationRun
} from "./uiOperationStore.js";
import type {
  ArtifactInfo,
  ChatMessage,
  NativeControlMode,
  StreamPayload,
  UiOperationApprovalMode,
  UiOperationExperience,
  UiOperationExecutionTarget,
  UiOperationRun,
  UiOperationBrowserTaskGroup,
  UiOperationTask,
  ExecutionRuntimeId
} from "./types.js";

const activeControllers = new Map<string, AbortController>();

interface UiOperationMessageInput {
  taskId?: string;
  message: string;
  name?: string;
  businessId?: string;
  executionTarget?: UiOperationExecutionTarget;
  experience?: Partial<UiOperationExperience>;
  approvalMode?: UiOperationApprovalMode;
  evaluationContext?: {
    caseId: string;
    timeoutMs: number;
    executionRuntimeId?: ExecutionRuntimeId;
    model?: string;
    guiRuntimeTransport?: "cli" | "mcp";
  };
}

interface UiOperationConversationInput {
  businessId?: string;
  executionTarget?: UiOperationExecutionTarget;
  experience?: Partial<UiOperationExperience>;
  approvalMode?: UiOperationApprovalMode;
}

interface ExecuteUiOperationOptions {
  userText: string;
  appendUserMessage: boolean;
  onPayload?: (payload: StreamPayload) => void;
  evaluationContext?: UiOperationMessageInput["evaluationContext"];
}

const EXPLICIT_UIWARDEN_BROWSER = /\buiwarden[\s_-]*browser\b|(?:客户端)?内置\s*(?:gui[\s_-]*browser|浏览器)/i;

/** 新对话默认是电脑桌面时，用户显式指定 UIWarden Browser 应进入浏览器原子链路。 */
export function resolveUiOperationExecutionTarget(
  instruction: string,
  configuredTarget?: UiOperationExecutionTarget
): UiOperationExecutionTarget | undefined {
  if (
    (!configuredTarget || configuredTarget.kind === "native-app")
    && EXPLICIT_UIWARDEN_BROWSER.test(instruction)
  ) {
    return { kind: "browser", browserKernel: "uiwarden-embedded" };
  }
  return configuredTarget;
}

/** 点击新建时立即创建持久化对话和 Agent 会话，首轮发送前不启动执行。 */
export async function createUiOperationConversation(
  input: UiOperationConversationInput
): Promise<UiOperationTask> {
  const executionTarget = input.executionTarget ?? { kind: "browser", browserKernel: "playwright" };
  const task = await upsertUiOperationTask({
    name: "新 UI 操作",
    instruction: "新 UI 操作",
    businessId: input.businessId,
    executionTarget,
    experience: input.experience,
    approvalMode: input.approvalMode,
    isDraft: true
  });
  const browserKernel = executionTarget.kind === "browser" ? executionTarget.browserKernel : "playwright";
  try {
    const session = await createSession(`UI 操作：${task.name}`, browserKernel);
    return await setUiOperationConversationSession(task.id, session.id);
  } catch (error) {
    await deleteUiOperationTask(task.id).catch(() => undefined);
    throw error;
  }
}

/** 创建运行记录并异步执行浏览器或原生应用 UI 操作。 */
export async function startUiOperation(taskId: string): Promise<UiOperationRun> {
  const task = await loadUiOperationTask(taskId);
  const { run } = await createUiOperationRun(task, task.instruction);
  void executeUiOperation(taskId, run.id, false, undefined, {
    userText: task.instruction,
    appendUserMessage: true
  });
  return run;
}

/** 在独立 UI 操作对话中发送一轮消息；首轮自动创建对话和 Agent 会话。 */
export async function sendUiOperationMessage(
  input: UiOperationMessageInput,
  onPayload: (payload: StreamPayload) => void,
  onCreated?: (identifiers: {
    taskId: string;
    operationRunId: string;
    sessionId: string;
  }) => void | Promise<void>
): Promise<UiOperationRun> {
  const message = String(input.message ?? "").trim();
  if (!message) throw new Error("请输入要完成的 UI 操作");
  const existing = input.taskId ? await loadUiOperationTask(input.taskId) : undefined;
  const executionTarget = resolveUiOperationExecutionTarget(
    message,
    existing?.isDraft ? input.executionTarget ?? existing.executionTarget : input.executionTarget
  );
  const task = existing?.isDraft
    ? await promoteUiOperationDraft(existing, message, input, executionTarget)
    : existing ?? await upsertUiOperationTask({
        name: String(input.name ?? "").trim() || message.slice(0, 40),
        instruction: message,
        businessId: input.businessId,
        executionTarget,
        experience: input.experience,
        approvalMode: input.approvalMode
      });
  const { run } = await createUiOperationRun(
    task,
    message,
    input.evaluationContext?.executionRuntimeId
  );
  let preparedRun = run;
  if (
    task.executionTarget.kind === "browser"
    && task.executionTarget.browserKernel === "external-cdp"
    && task.experience.browserTaskGroupMode === "user-browser"
  ) {
    let browserTaskGroup: UiOperationBrowserTaskGroup;
    try {
      const group = await createCdpTaskGroup(message);
      browserTaskGroup = { status: "created", ...group };
      onPayload({
        type: "status",
        data: {
          phase: "browser-task-group",
          label: `已创建浏览器桥接标签组 ${group.title}`
        }
      });
    } catch (error) {
      browserTaskGroup = {
        status: "failed",
        error: error instanceof Error ? error.message : String(error)
      };
      onPayload({
        type: "status",
        data: {
          phase: "browser-task-group",
          label: `浏览器桥接标签组创建失败，本轮继续使用当前页面`
        }
      });
    }
    preparedRun = await updateUiOperationRun(task.id, run.id, { browserTaskGroup });
  }
  await onCreated?.({
    taskId: task.id,
    operationRunId: preparedRun.id,
    sessionId: preparedRun.sessionId
  });
  onPayload({
    type: "session",
    data: { operationTaskId: task.id, operationRunId: preparedRun.id, sessionId: preparedRun.sessionId }
  });
  await executeUiOperation(task.id, preparedRun.id, false, undefined, {
    userText: message,
    appendUserMessage: true,
    onPayload,
    evaluationContext: input.evaluationContext
  });
  return (await loadUiOperationTask(task.id)).runs.find((item) => item.id === preparedRun.id) ?? preparedRun;
}

async function promoteUiOperationDraft(
  task: UiOperationTask,
  message: string,
  input: UiOperationMessageInput,
  executionTarget: UiOperationExecutionTarget | undefined
): Promise<UiOperationTask> {
  const updated = await upsertUiOperationTask({
    id: task.id,
    name: String(input.name ?? "").trim() || message.slice(0, 40),
    instruction: message,
    businessId: input.businessId ?? task.businessId,
    executionTarget: executionTarget ?? task.executionTarget,
    experience: input.experience ?? task.experience,
    approvalMode: input.approvalMode ?? task.approvalMode,
    isDraft: false
  });
  if (updated.conversationSessionId) {
    const browserKernel = updated.executionTarget.kind === "browser"
      ? updated.executionTarget.browserKernel
      : "playwright";
    const session = await updateSessionBrowserKernel(updated.conversationSessionId, browserKernel);
    await updateSessionStatus(session.id, session.status, { title: `UI 操作：${updated.name}` });
  }
  return updated;
}

async function createUiOperationRun(
  task: UiOperationTask,
  instruction: string,
  executionRuntimeId?: ExecutionRuntimeId
): Promise<{ task: UiOperationTask; run: UiOperationRun }> {
  if (task.runs.some((run) => run.status === "running" || run.status === "waiting-approval")) {
    throw new Error("该 UI 操作已有未结束运行");
  }
  const browserKernel = task.executionTarget.kind === "browser"
    ? task.executionTarget.browserKernel
    : "playwright";
  const existingSessionId = task.conversationSessionId ?? task.runs[0]?.sessionId;
  let session = existingSessionId
    ? await loadSession(existingSessionId).catch(() => undefined)
    : undefined;
  if (!session) {
    session = await createSession(
      `UI 操作：${task.name}`,
      browserKernel,
      undefined,
      executionRuntimeId
    );
    task = await setUiOperationConversationSession(task.id, session.id);
  } else if (task.conversationSessionId !== session.id) {
    task = await setUiOperationConversationSession(task.id, session.id);
  }
  await prepareWorkspace(session.workspacePath, { executionRuntimeId: session.executionRuntimeId });
  const run: UiOperationRun = {
    id: randomUUID(),
    taskId: task.id,
    sessionId: session.id,
    instruction,
    status: "running",
    startedAt: new Date().toISOString(),
    artifactsCount: 0
  };
  if (task.executionTarget.kind === "native-app") {
    const nativeSession = await startNativeAutomationSession({
      providerId: task.executionTarget.providerId,
      app: AGENT_SELECTED_NATIVE_APP,
      artifactRoot: path.join(session.workspacePath, ".skill-output", "native-reps"),
      workspacePath: session.workspacePath,
      approvalMode: task.approvalMode,
      deliveryMode: task.experience.nativeDeliveryMode
    });
    run.nativeSessionId = nativeSession.sessionId;
    run.nativeControlMode = nativeSession.controlMode;
    run.nativeArtifactDir = nativeSession.artifactDir;
  }
  await appendUiOperationRun(task.id, run);
  return { task, run };
}

/** 用户确认敏感动作后，从同一 Agent/dt-gui-computer 会话继续执行。 */
export async function approveUiOperation(taskId: string, runId: string): Promise<UiOperationRun> {
  const task = await loadUiOperationTask(taskId);
  const run = task.runs.find((item) => item.id === runId);
  if (!run || run.status !== "waiting-approval") throw new Error("该运行当前不等待审批");
  let approvedChallengeId: string | undefined;
  if (task.executionTarget.kind === "native-app") {
    if (!run.nativeSessionId || !run.pendingApprovalId) throw new Error("原生运行缺少待审批挑战");
    await grantNativeAutomationApproval(run.nativeSessionId, run.pendingApprovalId);
    approvedChallengeId = run.pendingApprovalId;
  }
  const updated = await updateUiOperationRun(taskId, runId, {
    status: "running",
    error: undefined,
    pendingApprovalId: undefined,
    pendingApprovalSummary: undefined
  });
  void executeUiOperation(taskId, runId, true, approvedChallengeId, {
    userText: run.instruction || task.instruction,
    appendUserMessage: false
  });
  return updated;
}

/** 拒绝原生动作审批并结束本次运行。 */
export async function rejectUiOperation(taskId: string, runId: string): Promise<UiOperationRun> {
  const task = await loadUiOperationTask(taskId);
  const run = task.runs.find((item) => item.id === runId);
  if (!run || run.status !== "waiting-approval") throw new Error("该运行当前不等待审批");
  if (task.executionTarget.kind !== "native-app" || !run.nativeSessionId || !run.pendingApprovalId) {
    throw new Error("只有原生应用动作支持显式拒绝审批");
  }
  await rejectNativeAutomationApproval(run.nativeSessionId, run.pendingApprovalId);
  await stopNativeAutomationSession(run.nativeSessionId, "approval-rejected");
  return finalizeUiOperationRun(task, run, {
    status: "aborted",
    finishedAt: new Date().toISOString(),
    error: "用户拒绝了敏感动作",
    pendingApprovalId: undefined,
    pendingApprovalSummary: undefined
  });
}

/** 中止当前 UI 操作并封装已产生的 Native Rep。 */
export async function abortUiOperation(taskId: string, runId: string): Promise<UiOperationRun> {
  activeControllers.get(runId)?.abort();
  activeControllers.delete(runId);
  const task = await loadUiOperationTask(taskId);
  const run = task.runs.find((item) => item.id === runId);
  if (!run) throw new Error(`UI 操作运行不存在：${runId}`);
  if (run.nativeSessionId) {
    await stopNativeAutomationSession(run.nativeSessionId, "user-aborted").catch(() => undefined);
  }
  if (task.executionTarget.kind === "browser") {
    await forceStopBrowserAutomationSessionsForUiwardenSession(
      run.sessionId,
      "user-aborted"
    ).catch(() => undefined);
  }
  return finalizeUiOperationRun(task, run, {
    status: "aborted",
    finishedAt: new Date().toISOString(),
    error: "用户主动中止",
    pendingApprovalId: undefined,
    pendingApprovalSummary: undefined
  });
}

export async function getUiOperationNativeState(
  taskId: string,
  runId: string
): Promise<{ session: NativeAutomationSession; snapshot?: NativeAutomationSnapshot }> {
  const { run } = await requireNativeRun(taskId, runId);
  const agentSession = await loadSession(run.sessionId);
  return {
    session: await getNativeAutomationSession(run.nativeSessionId!),
    snapshot: await loadLatestNativeSnapshot(run.nativeArtifactDir, agentSession.workspacePath)
  };
}

export async function getUiOperationNativeScreenshot(
  taskId: string,
  runId: string
): Promise<{ path: string; sequence: number; capturedAt: string } | undefined> {
  const { run } = await requireNativeRun(taskId, runId);
  const agentSession = await loadSession(run.sessionId);
  const snapshot = await loadLatestNativeSnapshot(run.nativeArtifactDir, agentSession.workspacePath);
  if (!snapshot?.screenshotPath || !run.nativeArtifactDir) return undefined;
  const screenshotPath = await resolveUiOperationNativeScreenshotPath(
    run.nativeArtifactDir,
    snapshot.screenshotPath
  );
  if (!screenshotPath) return undefined;
  return {
    path: screenshotPath,
    sequence: snapshot.sequence,
    capturedAt: snapshot.capturedAt
  };
}

export async function getUiOperationBrowserState(
  taskId: string,
  runId: string
): Promise<{
  session: BrowserAutomationSession;
  snapshots: Array<Pick<BrowserAutomationSnapshot, "snapshotId" | "sequence" | "url" | "title" | "capturedAt">>;
}> {
  const { run, session, snapshots } = await requireBrowserRun(taskId, runId);
  return {
    session,
    snapshots: snapshots.map(({ snapshotId, sequence, url, title, capturedAt }) => ({
      snapshotId,
      sequence,
      url,
      title,
      capturedAt
    }))
  };
}

export async function getUiOperationBrowserScreenshot(
  taskId: string,
  runId: string,
  sequence?: number
): Promise<{ path: string; sequence: number; capturedAt: string } | undefined> {
  const { run, session, snapshots } = await requireBrowserRun(taskId, runId);
  const snapshot = Number.isInteger(sequence)
    ? snapshots.find((candidate) => candidate.sequence === sequence)
    : snapshots.at(-1);
  if (!snapshot?.screenshotPath) return undefined;
  const screenshotPath = await resolveUiOperationBrowserScreenshotPath(
    session.artifactDir,
    snapshot.screenshotPath,
    (await loadSession(run.sessionId)).workspacePath
  );
  return screenshotPath
    ? { path: screenshotPath, sequence: snapshot.sequence, capturedAt: snapshot.capturedAt }
    : undefined;
}

export async function resolveUiOperationBrowserScreenshotPath(
  artifactDir: string,
  value: string,
  workspacePath: string
): Promise<string | undefined> {
  const artifactRoot = path.resolve(artifactDir);
  if (!isInsidePath(workspacePath, artifactRoot)) return undefined;
  const candidate = path.isAbsolute(value) ? path.resolve(value) : path.resolve(artifactRoot, value);
  try {
    const [realWorkspace, realArtifactRoot, realCandidate] = await Promise.all([
      fs.realpath(workspacePath),
      fs.realpath(artifactRoot),
      fs.realpath(candidate)
    ]);
    if (!isInsidePath(realWorkspace, realArtifactRoot) || !isInsidePath(realArtifactRoot, realCandidate)) {
      return undefined;
    }
    return (await fs.stat(realCandidate)).isFile() ? realCandidate : undefined;
  } catch {
    return undefined;
  }
}

export async function resolveUiOperationNativeScreenshotPath(
  artifactDir: string,
  value: string
): Promise<string | undefined> {
  const artifactRoot = path.resolve(artifactDir);
  const screenshotCandidate = path.isAbsolute(value)
    ? path.resolve(value)
    : path.resolve(artifactRoot, value);
  let realArtifactRoot: string;
  let screenshotPath: string;
  try {
    [realArtifactRoot, screenshotPath] = await Promise.all([
      fs.realpath(artifactRoot),
      fs.realpath(screenshotCandidate)
    ]);
    const relative = path.relative(realArtifactRoot, screenshotPath);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return undefined;
    const stat = await fs.stat(screenshotPath);
    if (!stat.isFile()) return undefined;
  } catch {
    return undefined;
  }
  return screenshotPath;
}

export async function observeUiOperationNativeState(
  taskId: string,
  runId: string
): Promise<{ session: NativeAutomationSession; snapshot: NativeAutomationSnapshot }> {
  const { run } = await requireNativeRun(taskId, runId);
  const snapshot = await observeNativeAutomationSession(run.nativeSessionId!);
  return {
    session: await getNativeAutomationSession(run.nativeSessionId!),
    snapshot
  };
}

export async function controlUiOperationNativeRun(
  taskId: string,
  runId: string,
  mode: Extract<NativeControlMode, "agent-control" | "human-control">
): Promise<{ session: NativeAutomationSession; run: UiOperationRun }> {
  const { run } = await requireNativeRun(taskId, runId);
  if (run.status !== "running" && run.status !== "waiting-approval") {
    throw new Error("已结束的原生运行不能切换控制权");
  }
  const session = await setNativeAutomationControl(run.nativeSessionId!, mode);
  const updated = await updateUiOperationRun(taskId, runId, { nativeControlMode: session.controlMode });
  return { session, run: updated };
}

export async function clickUiOperationNativePictureInPicture(
  taskId: string,
  runId: string,
  input: { xRatio: number; yRatio: number }
): Promise<{
  mappedBy: "ax-element" | "window-coordinate";
  point: { x: number; y: number };
  elementId?: string;
  snapshot: NativeAutomationSnapshot;
}> {
  const { run } = await requireNativeRun(taskId, runId);
  if (run.status !== "running" && run.status !== "waiting-approval") {
    throw new Error("已结束的原生运行不能执行画中画操作");
  }
  const xRatio = Number(input.xRatio);
  const yRatio = Number(input.yRatio);
  if (
    !Number.isFinite(xRatio)
    || !Number.isFinite(yRatio)
    || xRatio < 0
    || xRatio > 1
    || yRatio < 0
    || yRatio > 1
  ) {
    throw new Error("画中画点击坐标必须位于 0 到 1 之间");
  }
  const session = await getNativeAutomationSession(run.nativeSessionId!);
  if (session.controlMode !== "human-control") {
    throw new Error("请先开启画中画交互");
  }
  const before = await observeNativeAutomationSession(run.nativeSessionId!);
  if (!before.windowBounds) throw new Error("当前窗口没有可用的坐标映射信息");
  const point = {
    x: before.windowBounds.x + before.windowBounds.width * xRatio,
    y: before.windowBounds.y + before.windowBounds.height * yRatio
  };
  const element = before.elements
    .filter((candidate) =>
      candidate.enabled
      && candidate.bounds
      && point.x >= candidate.bounds.x
      && point.x <= candidate.bounds.x + candidate.bounds.width
      && point.y >= candidate.bounds.y
      && point.y <= candidate.bounds.y + candidate.bounds.height
      && candidate.actions.some((action) => /press|click/i.test(action))
    )
    .sort((left, right) =>
      (left.bounds!.width * left.bounds!.height) - (right.bounds!.width * right.bounds!.height)
    )[0];
  await clickNativeAutomationSessionAsUser({
    sessionId: run.nativeSessionId!,
    snapshotId: before.snapshotId,
    elementId: element?.elementId,
    x: point.x,
    y: point.y
  });
  const snapshot = await observeNativeAutomationSession(run.nativeSessionId!);
  return {
    mappedBy: element ? "ax-element" : "window-coordinate",
    point,
    elementId: element?.elementId,
    snapshot
  };
}

async function executeUiOperation(
  taskId: string,
  runId: string,
  approved: boolean,
  approvedChallengeId: string | undefined,
  options: ExecuteUiOperationOptions
): Promise<void> {
  const controller = new AbortController();
  activeControllers.set(runId, controller);
  let run: UiOperationRun | undefined;
  let task: UiOperationTask | undefined;
  try {
    task = await loadUiOperationTask(taskId);
    run = task.runs.find((item) => item.id === runId);
    if (!run) throw new Error(`UI 操作运行不存在：${runId}`);
    const session = await loadSession(run.sessionId);
    const environment = await getBusinessEnvironment(task.businessId);
    const prompt = buildUiOperationPrompt(
      task,
      options.userText,
      approved,
      approvedChallengeId,
      environment,
      options.evaluationContext
    );
    let updatedSession = session;
    if (options.appendUserMessage) {
      const userMessage = createMessage("user", options.userText, {
        meta: {
          executionPurpose: "operation",
          uiOperationTaskId: taskId,
          uiOperationRunId: runId,
          executionTarget: task.executionTarget.kind,
          approved,
          approvedChallengeId
        }
      });
      updatedSession = await appendMessage(session.id, userMessage);
      options.onPayload?.({ type: "message", data: userMessage });
    }
    const nativeExecution = task.executionTarget.kind === "native-app" && run.nativeSessionId && run.nativeArtifactDir
      ? {
          sessionId: run.nativeSessionId,
          providerId: task.executionTarget.providerId,
          deliveryMode: task.experience.nativeDeliveryMode,
          transport: options.evaluationContext?.guiRuntimeTransport,
          appDisplayName: "Agent 自动选择",
          artifactDir: run.nativeArtifactDir,
          waitForAgentControl: (signal: AbortSignal) => waitForNativeAgentControl(run!.nativeSessionId!, signal)
        }
      : undefined;
    const result = await runAgentForSession({
      session: updatedSession,
      userText: prompt,
      abortSignal: controller.signal,
      purpose: "operation",
      nativeExecution,
      uiOperationRunId: run.id,
      executionRuntimeIdOverride: options.evaluationContext?.executionRuntimeId,
      modelOverride: options.evaluationContext?.model,
      onPayload: options.onPayload
        ? (payload) => {
            if (payload.type !== "done") options.onPayload?.(payload);
          }
        : undefined
    });
    if (controller.signal.aborted) return;
    const completedAgentSession = await loadSession(run.sessionId);
    if (completedAgentSession.status === "failed") {
      throw new Error(completedAgentSession.lastError || "UI 操作 Agent 未完成任务");
    }

    if (nativeExecution) {
      const nativeSession = await getNativeAutomationSession(nativeExecution.sessionId);
      const pending = nativeSession.pendingApprovals.find((challenge) => !challenge.granted);
      if (pending && task.approvalMode === "none") {
        await grantNativeAutomationApproval(nativeExecution.sessionId, pending.challengeId);
        await updateUiOperationRun(taskId, runId, {
          status: "running",
          pendingApprovalId: undefined,
          pendingApprovalSummary: undefined,
          error: undefined
        });
        await executeUiOperation(taskId, runId, true, pending.challengeId, {
          userText: options.userText,
          appendUserMessage: false,
          onPayload: options.onPayload,
          evaluationContext: options.evaluationContext
        });
        return;
      }
      if (pending) {
        const artifacts = await refreshArtifacts(run.sessionId);
        await updateUiOperationRun(taskId, runId, {
          status: "waiting-approval",
          summary: result.assistantText.slice(0, 1200),
          artifactsCount: countFiles(artifacts),
          nativeControlMode: nativeSession.controlMode,
          pendingApprovalId: pending.challengeId,
          pendingApprovalSummary: pending.actionSummary,
          error: undefined
        });
        return;
      }
      await stopNativeAutomationSession(nativeExecution.sessionId, "completed");
      await finalizeUiOperationRun(task, run, {
        status: "completed",
        finishedAt: new Date().toISOString(),
        summary: result.assistantText.slice(0, 1200),
        nativeControlMode: nativeSession.controlMode,
        error: undefined
      });
      return;
    }

    const waitingApproval = task.approvalMode === "manual-finalize" && !approved;
    await finalizeUiOperationRun(task, run, {
      status: waitingApproval ? "waiting-approval" : "completed",
      finishedAt: waitingApproval ? undefined : new Date().toISOString(),
      summary: result.assistantText.slice(0, 1200),
      artifactsCount: countFiles(result.artifacts),
      error: undefined
    });
  } catch (error) {
    if (run?.nativeSessionId) {
      await stopNativeAutomationSession(
        run.nativeSessionId,
        controller.signal.aborted ? "user-aborted" : "agent-error"
      ).catch(() => undefined);
      await refreshArtifacts(run.sessionId).catch(() => undefined);
    }
    if (!controller.signal.aborted) {
      const resolvedTask = task ?? await loadUiOperationTask(taskId).catch(() => undefined);
      if (resolvedTask && run) {
        await finalizeUiOperationRun(resolvedTask, run, {
          status: "failed",
          finishedAt: new Date().toISOString(),
          error: error instanceof Error ? error.message : String(error)
        }).catch(() => undefined);
      }
    }
  } finally {
    if (activeControllers.get(runId) === controller) activeControllers.delete(runId);
    options.onPayload?.({ type: "done", data: { operationTaskId: taskId, operationRunId: runId } });
  }
}

function buildUiOperationPrompt(
  task: UiOperationTask,
  instruction: string,
  approved: boolean,
  approvedChallengeId: string | undefined,
  environment: Awaited<ReturnType<typeof getBusinessEnvironment>>,
  evaluationContext?: UiOperationMessageInput["evaluationContext"]
): string {
  const usesAtomicBrowser = task.executionTarget.kind === "browser";
  const evaluationInstruction = evaluationContext
    ? [
        `这是评测样本 ${evaluationContext.caseId}，总执行预算为 ${Math.max(1, Math.round(evaluationContext.timeoutMs / 1_000))} 秒。`,
        "只允许启动一次完整执行链。工具或 Skill 返回终态后立即基于已有证据总结，不得再启动第二个 runner、追加探索或为了润色结论继续操作。",
        usesAtomicBrowser
          ? "使用 dt-gui-browser 原子命令完成当前样本；禁止调用 quick、browser-use 或 ui-test-assistant-skill。"
          : "",
        "若执行链返回失败或前置条件不满足，原样报告阻塞与最后有效证据并结束；禁止用重复操作消耗剩余预算。"
      ].join("\n")
    : "";
  if (task.executionTarget.kind === "native-app") {
    const approvalInstruction = approved && approvedChallengeId
      ? `用户已批准挑战 ${approvedChallengeId}。从同一 Agent 会话上下文中找到此前被拒绝的原子动作，以原 snapshotId 和 --approval ${approvedChallengeId} 精确重试一次；随后立即重新 observe。`
      : task.approvalMode === "none"
        ? "本次 UI 操作已默认授权，Native Session 使用 approvalPolicy=none；按键、点击和提交动作不会生成审批挑战。仍必须遵守安全输入人工接管与动作后证据校验。"
        : "由 dt-gui-computer Runtime 对删除、发送、提交、支付、安装和坐标点击等高风险动作生成审批挑战；收到挑战后立即停止。";
    return [
      "执行电脑桌面 UI 操作。必须先使用 Skill 工具加载 dt-gui-computer-skill；意图理解和步骤规划由当前主 Agent 完成。",
      "不要使用浏览器、ui-test-assistant-skill、browser-use 或 Playwright。不要要求用户从应用列表中选择应用；先读取应用列表，再由 Agent 选择并绑定目标应用。",
      evaluationContext
        ? "评测模式下，同一 snapshot 上的普通动作失败两次或动作后 delta.changed=false 时，必须重新 observe 并改用不同证据；仍无变化则立即报告阻塞，禁止旧快照循环。PROVIDER_UNAVAILABLE、Provider 未返回响应或 Provider 超时属于执行通道故障，只允许重新 observe 后重试原动作一次；再次失败立即报告 blocked，禁止切换 key、visual-click 或坐标点击继续试探。"
        : "",
      "精确数字或文本序列必须逐 token 建立动作账本并逐项执行，重复项也不能省略或扩写；例如 1 + 100 只能是 [1] [加] [1] [0] [0] [等于]。最终结论必须区分界面证据与推断；最终观察和截图未暴露的值必须标记为未验证并停止，禁止虚构 get 命令或发送额外按键来抓取。",
      `Provider：${task.executionTarget.providerId}`,
      approvalInstruction,
      evaluationInstruction,
      `操作指令：${instruction}`,
      buildEnvironmentPrompt(environment)
    ].filter(Boolean).join("\n\n");
  }
  const approvalInstruction = task.approvalMode === "manual-finalize" && !approved
    ? "执行到最终提交、发送、删除、支付或其他不可逆动作之前停止，不执行最后动作，并明确说明等待用户审批。"
    : "用户已明确批准本次最终动作，可以在再次确认当前页面状态后继续完成。";
  const currentRun = task.runs.find((run) => run.instruction === instruction && run.status === "running")
    ?? task.runs.find((run) => run.status === "running")
    ?? task.runs[0];
  const taskGroupInstruction = buildBrowserTaskGroupInstruction(currentRun?.browserTaskGroup);
  return [
    "你正在执行浏览器 UI 操作任务，而不是测试任务。必须使用 dt-gui-browser-skill 和 dt-gui-browser 原子命令，由当前主 Agent 规划；禁止使用 ui-test-assistant-skill、quick 或 browser-use。Playwright 仅用于提供配套 Chromium，不是任务执行器。",
    taskGroupInstruction,
    approvalInstruction,
    evaluationInstruction,
    task.targetUrl ? `目标页面：${task.targetUrl}` : "从当前活动页面继续操作。",
    `操作指令：${instruction}`,
    buildEnvironmentPrompt(environment)
  ].filter(Boolean).join("\n\n");
}

export function buildBrowserTaskGroupInstruction(
  taskGroup?: UiOperationBrowserTaskGroup
): string {
  if (taskGroup?.status === "created") {
    return [
      "UIWarden 宿主编排已完成浏览器桥接标签组创建，这不是 dt-gui-browser 原子任务，禁止再次查询或尝试创建标签组。",
      `宿主证据：groupId=${taskGroup.groupId}，targetId=${taskGroup.targetId}，title=${taskGroup.title}。`,
      "把用户指令中的“新建分组/创建标签组”视为已完成，只执行剩余网页操作；最终结果必须将标签组列为已完成，并注明证据来自 UIWarden 宿主。"
    ].join("\n");
  }
  if (taskGroup?.status === "failed") {
    return `UIWarden 宿主未能创建浏览器桥接标签组：${taskGroup.error || "未知错误"}。不要用 dt-gui-browser 或直接 CDP 重试宿主动作；继续执行可完成的页面操作，并在最终结果中明确报告该宿主缺口。`;
  }
  return "";
}

async function requireBrowserRun(
  taskId: string,
  runId: string
): Promise<{
  run: UiOperationRun;
  session: BrowserAutomationSession;
  snapshots: BrowserAutomationSnapshot[];
}> {
  const task = await loadUiOperationTask(taskId);
  const run = task.runs.find((item) => item.id === runId);
  if (!run) throw new Error(`UI 操作运行不存在：${runId}`);
  if (task.executionTarget.kind !== "browser") throw new Error("该运行不是浏览器任务");
  const session = await findLatestBrowserAutomationSessionForUiwardenSession(run.sessionId);
  if (!session) throw new Error("当前浏览器运行尚未创建原子执行会话");
  if (Date.parse(session.startedAt) < Date.parse(run.startedAt)) {
    throw new Error("当前浏览器运行尚未创建本轮原子执行会话");
  }
  const agentSession = await loadSession(run.sessionId);
  if (!isInsidePath(agentSession.workspacePath, session.artifactDir)) {
    throw new Error("Browser Rep 不属于当前 UI 操作工作区");
  }
  return { run, session, snapshots: await readBrowserAutomationSnapshots(session) };
}

function isInsidePath(parent: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function requireNativeRun(taskId: string, runId: string): Promise<{ task: UiOperationTask; run: UiOperationRun }> {
  const task = await loadUiOperationTask(taskId);
  const run = task.runs.find((item) => item.id === runId);
  if (!run) throw new Error(`UI 操作运行不存在：${runId}`);
  if (task.executionTarget.kind !== "native-app" || !run.nativeSessionId) {
    throw new Error("该运行不是原生应用任务");
  }
  return { task, run };
}

async function waitForNativeAgentControl(sessionId: string, signal: AbortSignal): Promise<void> {
  while (!signal.aborted) {
    const session = await getNativeAutomationSession(sessionId);
    if (session.state !== "active") throw new Error("原生自动化会话已经结束");
    if (session.controlMode === "agent-control") return;
    await delay(400, signal);
  }
  throw new Error("任务已被中止");
}

function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(resolve, milliseconds);
    signal.addEventListener("abort", () => {
      clearTimeout(timeout);
      reject(new Error("任务已被中止"));
    }, { once: true });
  });
}

function countFiles(artifacts: Array<{ kind: string }>): number {
  return artifacts.filter((artifact) => artifact.kind === "file").length;
}

async function finalizeUiOperationRun(
  task: UiOperationTask,
  run: UiOperationRun,
  patch: Partial<UiOperationRun>
): Promise<UiOperationRun> {
  let updated = await updateUiOperationRun(task.id, run.id, patch);
  await writeUiOperationHtmlReport(task, updated).catch((error) => {
    console.error(`[ui-operation] Failed to write HTML report for ${run.id}`, error);
  });
  const artifacts = await refreshArtifacts(run.sessionId).catch(() => []);
  updated = await updateUiOperationRun(task.id, run.id, { artifactsCount: countFiles(artifacts) });
  return updated;
}

async function writeUiOperationHtmlReport(task: UiOperationTask, run: UiOperationRun): Promise<void> {
  const session = await loadSession(run.sessionId);
  const reportDir = path.join(session.workspacePath, ".skill-output", "ui-operation-reports", run.id);
  const artifacts = await refreshArtifacts(run.sessionId).catch(() => []);
  const html = renderUiOperationHtmlReport({ task, run, messages: session.messages, artifacts });
  await fs.mkdir(reportDir, { recursive: true });
  await fs.writeFile(path.join(reportDir, "report.html"), html, "utf8");
}

export function renderUiOperationHtmlReport(input: {
  task: UiOperationTask;
  run: UiOperationRun;
  messages: ChatMessage[];
  artifacts: ArtifactInfo[];
}): string {
  const { task, run, messages, artifacts } = input;
  const target = task.executionTarget.kind === "native-app"
    ? `电脑桌面 / ${task.executionTarget.providerId}`
    : `浏览器 / ${task.executionTarget.browserKernel}`;
  const statusLabels: Record<UiOperationRun["status"], string> = {
    idle: "未执行",
    running: "运行中",
    "waiting-approval": "等待审批",
    completed: "已完成",
    failed: "失败",
    aborted: "已停止"
  };
  const messageRows = messages.map((message) => `
    <article class="message ${escapeHtml(message.role)}">
      <header><strong>${message.role === "assistant" ? "Agent" : message.role === "user" ? "用户" : "系统"}</strong><time>${escapeHtml(message.createdAt)}</time></header>
      <pre>${escapeHtml(message.content)}</pre>
    </article>`).join("");
  const artifactRows = artifacts
    .filter((artifact) => artifact.kind === "file" && !artifact.relativePath.includes(`/ui-operation-reports/${run.id}/report.html`))
    .map((artifact) => `<li><code>${escapeHtml(artifact.relativePath)}</code><span>${artifact.size} B</span></li>`)
    .join("");
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(task.name)} - UI 操作报告</title>
  <style>
    :root { color: #243247; background: #f4f7fa; font-family: Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    * { box-sizing: border-box; }
    body { margin: 0; }
    main { width: min(1080px, calc(100% - 32px)); margin: 24px auto 48px; }
    h1 { margin: 0; font-size: 24px; letter-spacing: 0; }
    h2 { margin: 0 0 12px; font-size: 16px; }
    .subtitle { margin: 7px 0 0; color: #6c7888; }
    .summary { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 8px; margin: 20px 0; }
    .summary div, section { background: #fff; border: 1px solid #dfe6ee; border-radius: 7px; }
    .summary div { min-height: 68px; padding: 10px 12px; }
    .summary span { display: block; color: #7b8797; font-size: 12px; }
    .summary strong { display: block; margin-top: 7px; overflow-wrap: anywhere; }
    .status { color: ${run.status === "completed" ? "#167047" : run.status === "failed" ? "#a13430" : "#8a5b09"}; }
    section { margin-top: 12px; padding: 16px; }
    .result { margin: 0; color: #34445a; line-height: 1.65; white-space: pre-wrap; }
    .message { margin-top: 10px; padding: 11px 12px; border-left: 3px solid #89a4c7; background: #f8fafc; }
    .message.user { border-left-color: #9aa8b8; }
    .message header { display: flex; justify-content: space-between; color: #627084; font-size: 12px; }
    .message pre { margin: 8px 0 0; overflow-wrap: anywhere; color: #334257; font: inherit; line-height: 1.6; white-space: pre-wrap; }
    ul { margin: 0; padding: 0; list-style: none; }
    li { display: flex; justify-content: space-between; gap: 12px; padding: 7px 0; border-top: 1px solid #edf0f4; }
    li:first-child { border-top: 0; }
    li code { min-width: 0; overflow-wrap: anywhere; }
    li span { flex: 0 0 auto; color: #8490a0; font-size: 12px; }
    @media (max-width: 760px) { .summary { grid-template-columns: 1fr 1fr; } }
  </style>
</head>
<body>
  <main>
    <header><h1>${escapeHtml(task.name)}</h1><p class="subtitle">UI 操作执行报告 · ${escapeHtml(run.id)}</p></header>
    <div class="summary">
      <div><span>执行目标</span><strong>${escapeHtml(target)}</strong></div>
      <div><span>状态</span><strong class="status">${statusLabels[run.status]}</strong></div>
      <div><span>开始时间</span><strong>${escapeHtml(run.startedAt)}</strong></div>
      <div><span>结束时间</span><strong>${escapeHtml(run.finishedAt || "尚未结束")}</strong></div>
    </div>
    <section><h2>操作指令</h2><p class="result">${escapeHtml(run.instruction || task.instruction)}</p></section>
    <section><h2>执行结果</h2><p class="result">${escapeHtml(run.error || run.summary || "当前尚无结果摘要")}</p></section>
    <section><h2>执行过程</h2>${messageRows || '<p class="result">暂无对话记录</p>'}</section>
    <section><h2>产物索引</h2><ul>${artifactRows || "<li>暂无其他产物</li>"}</ul></section>
  </main>
</body>
</html>`;
}

function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

async function loadLatestNativeSnapshot(
  artifactDir: string | undefined,
  workspacePath: string
): Promise<NativeAutomationSnapshot | undefined> {
  if (!artifactDir) return undefined;
  const relative = path.relative(path.resolve(workspacePath), path.resolve(artifactDir));
  if (relative.startsWith("..") || path.isAbsolute(relative)) return undefined;
  try {
    return JSON.parse(
      await fs.readFile(path.join(artifactDir, "snapshots", "latest.json"), "utf8")
    ) as NativeAutomationSnapshot;
  } catch {
    return undefined;
  }
}
