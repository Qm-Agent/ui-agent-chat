import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  appendJsonLine,
  atomicWriteFile,
  atomicWriteJson,
  GuiAutomationError,
  readJsonFile
} from "../shared-runtime/index.js";
import { provider } from "./providers.js";
import {
  PROTOCOL_VERSION,
  RUNTIME_VERSION,
  type AppInfo,
  type AppSelector,
  type ApprovalChallenge,
  type ApprovalPolicy,
  type AutomationSession,
  type ControlMode,
  type DeliveryMode,
  type NativeAction,
  type ObservationDelta,
  type ObservationChanges,
  type ProviderId,
  type ProviderSnapshot,
  type UiElement,
  type UiSnapshot
} from "./types.js";

const PROVIDERS: ProviderId[] = ["mock", "macos-accessibility", "windows-ui-automation"];
const CONTROL_MODES: ControlMode[] = ["observe", "agent-control", "human-control"];
const APPROVAL_POLICIES: ApprovalPolicy[] = ["none", "sensitive-actions"];
const DELIVERY_MODES: DeliveryMode[] = ["foreground-compatible", "background-safe"];
const NO_PROGRESS_OBSERVATION_LIMIT = 3;
const EDITABLE_ROLES = new Set([
  "axtextfield",
  "axtextarea",
  "axcombobox",
  "axsearchfield",
  "textfield",
  "textarea",
  "combobox",
  "edit"
]);

export class ComputerRuntime {
  readonly root: string;

  private constructor(root: string) {
    this.root = root;
  }

  static async create(root?: string): Promise<ComputerRuntime> {
    const runtimeRoot = path.resolve(root || process.env.DT_GUI_COMPUTER_HOME || path.join(os.homedir(), ".dt-gui-computer"));
    await Promise.all([
      fs.mkdir(path.join(runtimeRoot, "sessions"), { recursive: true }),
      fs.mkdir(path.join(runtimeRoot, "native-reps"), { recursive: true })
    ]);
    return new ComputerRuntime(runtimeRoot);
  }

  async doctor(): Promise<Record<string, unknown>> {
    const providers = await Promise.all(PROVIDERS.map(async (providerId) => {
      try {
        return { providerId, status: "ok", data: await provider(providerId).probe() };
      } catch (error) {
        const failure = error instanceof GuiAutomationError ? error : new GuiAutomationError("INTERNAL", String(error));
        return { providerId, status: "unavailable", error: { code: failure.code, message: failure.message } };
      }
    }));
    return {
      protocolVersion: PROTOCOL_VERSION,
      runtimeVersion: RUNTIME_VERSION,
      platform: platformName(),
      architecture: architectureName(),
      home: this.root,
      providers
    };
  }

  capabilities(): Record<string, unknown> {
    return {
      protocolVersion: PROTOCOL_VERSION,
      providers: [
        { providerId: "mock", implementation: "available" },
        { providerId: "macos-accessibility", implementation: process.platform === "darwin" ? "available" : "unsupported-platform" },
        { providerId: "windows-ui-automation", implementation: process.platform === "win32" ? "available-unverified" : "unsupported-platform" }
      ],
      actions: ["launch", "click", "visual-click", "set-value", "type-text", "key", "scroll"],
      transports: ["cli-json", "mcp-stdio"],
      deliveryModes: DELIVERY_MODES,
      safety: ["snapshot-scoped-elements", "single-writer-lease", "approval-challenge", "secure-field-handoff", "background-interference-guard"]
    };
  }

  async listApps(providerId: string): Promise<Record<string, unknown>> {
    return { providerId, apps: await provider(providerId).listApps() };
  }

  async startSession(input: {
    providerId: string;
    app: AppSelector;
    controlMode: string;
    deliveryMode?: string;
    approvalPolicy: string;
    artifactRoot?: string;
  }): Promise<AutomationSession> {
    if (!CONTROL_MODES.includes(input.controlMode as ControlMode)) throw new GuiAutomationError("INVALID_ARGUMENT", "无效 control mode");
    if (!APPROVAL_POLICIES.includes(input.approvalPolicy as ApprovalPolicy)) throw new GuiAutomationError("INVALID_ARGUMENT", "无效 approval policy");
    const deliveryMode = input.deliveryMode || "foreground-compatible";
    if (!DELIVERY_MODES.includes(deliveryMode as DeliveryMode)) throw new GuiAutomationError("INVALID_ARGUMENT", "无效 delivery mode");
    validateAppSelector(input.app);
    const providerId = input.providerId as ProviderId;
    await provider(providerId).probe();
    const sessionId = `cua-${randomUUID()}`;
    if (input.controlMode !== "observe") await this.acquireWriteLease(sessionId);
    const artifactDir = path.join(path.resolve(input.artifactRoot || path.join(this.root, "native-reps")), sessionId);
    await Promise.all(["streams", "screenshots", "snapshots", "schemas"].map((dir) => fs.mkdir(path.join(artifactDir, dir), { recursive: true })));
    const session: AutomationSession = {
      version: PROTOCOL_VERSION,
      sessionId,
      providerId,
      app: input.app,
      controlMode: input.controlMode as ControlMode,
      deliveryMode: deliveryMode as DeliveryMode,
      approvalPolicy: input.approvalPolicy as ApprovalPolicy,
      state: "active",
      artifactDir,
      startedAt: now(),
      snapshotSequence: 0,
      lastElements: [],
      pendingApprovals: [],
      providerState: { input: "", deleted: false, scrollPosition: 0, saveCount: 0 },
      eventCount: 0,
      actionCount: 0,
      approvalCount: 0,
      captureGaps: []
    };
    await this.appendEvent(session, "session.started", {
      providerId,
      controlMode: input.controlMode,
      deliveryMode,
      approvalPolicy: input.approvalPolicy
    });
    await this.saveSession(session);
    return session;
  }

  async sessionStatus(sessionId: string): Promise<AutomationSession> {
    return this.loadSession(sessionId);
  }

  async setTarget(sessionId: string, app: AppSelector): Promise<AutomationSession> {
    validateAppSelector(app);
    const session = await this.loadWritableSession(sessionId, "只有持有 Agent 控制权时才能切换目标应用");
    if (sameSelector(session.app, app)) return session;
    const previous = session.app;
    session.app = app;
    invalidateSnapshot(session);
    session.pendingApprovals = [];
    await this.appendEvent(session, "target.changed", { previous, target: app });
    await this.saveSession(session);
    return session;
  }

  async launchTarget(sessionId: string, app: AppSelector): Promise<{ session: AutomationSession; app: AppInfo }> {
    validateAppSelector(app);
    if (app.kind === "process-id") throw new GuiAutomationError("INVALID_ARGUMENT", "不能使用 process-id 启动尚未运行的应用");
    const session = await this.loadWritableSession(sessionId, "只有持有 Agent 控制权时才能启动目标应用");
    const launched = await provider(session.providerId).launchApp(app, session.deliveryMode);
    const previous = session.app;
    session.app = launched.processId
      ? { kind: "process-id", value: String(launched.processId) }
      : { kind: "name", value: launched.displayName };
    invalidateSnapshot(session);
    session.pendingApprovals = [];
    await this.appendEvent(session, "target.launched", { previous, requested: app, launchedApp: launched });
    await this.saveSession(session);
    return { session, app: launched };
  }

  async setControlMode(sessionId: string, controlMode: string): Promise<AutomationSession> {
    if (controlMode !== "agent-control" && controlMode !== "human-control") {
      throw new GuiAutomationError("INVALID_ARGUMENT", "运行中的写会话只能切换为 agent-control 或 human-control");
    }
    const session = await this.loadActiveSession(sessionId);
    if (session.controlMode === "observe") throw new GuiAutomationError("INVALID_ARGUMENT", "只读会话不能切换控制权");
    await this.assertWriteLease(sessionId);
    await this.renewWriteLease(sessionId);
    if (session.controlMode === controlMode) return session;
    const previousMode = session.controlMode;
    session.controlMode = controlMode;
    await this.appendEvent(session, "control.changed", { previousMode, controlMode });
    await this.saveSession(session);
    return session;
  }

  async observe(sessionId: string, full: boolean, includeChanges = false): Promise<UiSnapshot> {
    const session = await this.loadActiveSession(sessionId);
    if (session.controlMode !== "observe") await this.renewWriteLease(sessionId);
    const observed = await provider(session.providerId).observe(session, full);
    const changes = includeChanges
      ? observationChanges(session.lastElements, observed.elements)
      : undefined;
    const fingerprint = observationFingerprint(observed);
    const previousFingerprint = String(session.providerState.lastObservationFingerprint || "");
    const lastObservedActionCount = Number(session.providerState.lastObservedActionCount || 0);
    const actionCountSinceLastObservation = Math.max(0, session.actionCount - lastObservedActionCount);
    const hasNewAction = actionCountSinceLastObservation > 0;
    const noProgressCount = previousFingerprint === fingerprint && hasNewAction
      ? Number(session.providerState.noProgressObservationCount || 0) + 1
      : previousFingerprint !== fingerprint
        ? 0
        : Number(session.providerState.noProgressObservationCount || 0);
    const delta = observationDelta(session, observed, {
      changed: previousFingerprint !== fingerprint,
      actionCountSinceLastObservation,
      noProgressCount
    });
    session.providerState.lastObservationFingerprint = fingerprint;
    session.providerState.noProgressObservationCount = noProgressCount;
    session.providerState.lastObservedActionCount = session.actionCount;
    session.providerState.lastObservationTextHash = observationTextHash(observed);
    session.snapshotSequence += 1;
    const snapshot: UiSnapshot = {
      version: PROTOCOL_VERSION,
      snapshotId: `snapshot-${randomUUID()}`,
      sessionId,
      sequence: session.snapshotSequence,
      app: observed.app,
      text: observed.text,
      elements: observed.elements,
      projection: observed.projection,
      focusedElement: observed.elements.find((element) => element.focused),
      screenshotPath: observed.screenshotPath,
      windowBounds: observed.windowBounds,
      captureGaps: observed.captureGaps || [],
      delta,
      changes,
      capturedAt: now()
    };
    session.currentSnapshotId = snapshot.snapshotId;
    session.lastElements = snapshot.elements;
    session.lastScreenshotPath = snapshot.screenshotPath;
    session.lastWindowBounds = snapshot.windowBounds;
    for (const gap of snapshot.captureGaps) if (!session.captureGaps.includes(gap)) session.captureGaps.push(gap);
    await appendJsonLine(this.streamPath(session, "snapshots.jsonl"), snapshot);
    await atomicWriteJson(path.join(session.artifactDir, "snapshots", "latest.json"), snapshot);
    await this.appendEvent(session, "snapshot.captured", {
      snapshotId: snapshot.snapshotId,
      sequence: snapshot.sequence,
      full,
      elementCount: snapshot.elements.length,
      delta,
      noProgressCount
    });
    const repeatedActionLoop = repeatedIneffectiveActionLoop(session, noProgressCount);
    if (noProgressCount >= NO_PROGRESS_OBSERVATION_LIMIT && repeatedActionLoop) {
      session.state = "failed";
      session.finishedAt = now();
      session.stopReason = "no-progress";
      session.currentSnapshotId = undefined;
      await this.appendEvent(session, "session.failed", {
        reason: "no-progress",
        noProgressCount,
        actionCount: session.actionCount,
        repeatedActionLoop
      });
      await this.writeManifest(session);
      await this.saveSession(session);
      await this.releaseWriteLease(sessionId);
      throw new GuiAutomationError(
        "NO_PROGRESS",
        `连续 ${NO_PROGRESS_OBSERVATION_LIMIT} 次动作后观察未发现有效状态变化，已停止会话以避免旧快照重试循环`,
        { details: { noProgressCount, actionCount: session.actionCount, repeatedActionLoop }, exitCode: 3 }
      );
    }
    await this.saveSession(session);
    return snapshot;
  }

  async performAction(
    sessionId: string,
    snapshotId: string,
    action: NativeAction,
    approvalId?: string,
    actor = "agent"
  ): Promise<Record<string, unknown>> {
    const session = await this.loadActiveSession(sessionId);
    if (actor !== "agent" && actor !== "user") {
      throw new GuiAutomationError("INVALID_ARGUMENT", "动作 actor 只能是 agent 或 user");
    }
    const expectedControlMode = actor === "user" ? "human-control" : "agent-control";
    if (session.controlMode !== expectedControlMode) {
      throw new GuiAutomationError(
        "HUMAN_CONTROL_ACTIVE",
        actor === "user"
          ? "画中画交互需要先切换到人工控制"
          : session.controlMode === "human-control"
            ? "用户正在接管桌面，Agent 动作已暂停"
            : "只读会话不能执行动作",
        { details: { controlMode: session.controlMode, actor }, exitCode: 3 }
      );
    }
    if (session.currentSnapshotId !== snapshotId) {
      throw new GuiAutomationError("STALE_SNAPSHOT", "动作引用的快照已过期，请重新 observe", {
        details: { currentSnapshotId: session.currentSnapshotId }
      });
    }
    await this.assertWriteLease(sessionId);
    await this.renewWriteLease(sessionId);
    if (action.kind === "type-text" && action.focused && !action.elementId && !focusedInputAnchorIsFresh(session)) {
      throw new GuiAutomationError("FOCUS_CONTEXT_MISSING", "活动输入缺少新鲜的语义焦点令牌；请重新点击 UIWardenCenterClick 元素并 observe");
    }
    enforceProviderTimeoutRetryGuard(session, snapshotId, action);
    const element = resolveElement(session, action.elementId);
    if (element?.secure && ["set-value", "type-text"].includes(action.kind)) {
      await this.appendEvent(session, "action.handoff-required", { kind: action.kind, elementId: action.elementId });
      await this.saveSession(session);
      throw new GuiAutomationError("HANDOFF_REQUIRED", "安全输入框必须由用户手动操作", { exitCode: 4 });
    }
    assertActionTargetIsUsable(session, action, element);
    const signature = actionSignature(snapshotId, action);
    if (actor === "agent" && session.approvalPolicy !== "none" && requiresApproval(action, element)) {
      await this.ensureApproval(session, snapshotId, action, signature, approvalId);
    }
    await this.appendEvent(session, "action.requested", {
      ...actionEvent(action),
      actor,
      deliveryMode: session.deliveryMode
    });
    let result: Record<string, unknown>;
    try {
      result = await provider(session.providerId).perform(session, action);
    } catch (error) {
      const failure = error instanceof GuiAutomationError
        ? error
        : new GuiAutomationError("INTERNAL", error instanceof Error ? error.message : String(error));
      if (isProviderTimeoutFailure(failure)) {
        recordProviderTimeoutFailure(session, snapshotId, action);
      }
      await this.appendEvent(session, "action.failed", {
        ...actionEvent(action),
        actor,
        deliveryMode: session.deliveryMode,
        code: failure.code,
        message: failure.message,
        details: failure.details
      });
      await appendJsonLine(this.streamPath(session, "actions.jsonl"), {
        timestamp: now(),
        kind: action.kind,
        elementId: action.elementId,
        targetRole: element?.role,
        targetName: element?.name,
        actor,
        deliveryMode: session.deliveryMode,
        result: "failed",
        error: {
          code: failure.code,
          message: failure.message,
          details: failure.details
        }
      });
      await this.saveSession(session);
      throw error;
    }
    delete session.providerState.providerTimeoutRetryGuard;
    const semanticCenterClick = action.kind === "click" && result.fallback === "semantic-center";
    const addressBarShortcut = action.kind === "key" && ["command+l", "cmd+l"].includes(String(action.key || "").toLowerCase());
    if (semanticCenterClick || addressBarShortcut) {
      session.providerState.focusedInputAnchor = {
        elementId: action.elementId,
        name: element?.name,
        source: addressBarShortcut ? "address-bar-shortcut" : "semantic-center",
        snapshotSequence: session.snapshotSequence
      };
    } else {
      delete session.providerState.focusedInputAnchor;
    }
    session.currentSnapshotId = undefined;
    session.pendingApprovals = session.pendingApprovals.filter((challenge) =>
      challenge.challengeId !== approvalId && challenge.actionSignature !== signature
    );
    await appendJsonLine(this.streamPath(session, "actions.jsonl"), {
      timestamp: now(),
      kind: action.kind,
      elementId: action.elementId,
      targetRole: element?.role,
      targetName: element?.name,
      actor,
      deliveryMode: session.deliveryMode,
      result: "performed",
      providerResult: result
    });
    session.actionCount += 1;
    const recentActionPatterns = Array.isArray(session.providerState.recentActionPatterns)
      ? session.providerState.recentActionPatterns.map(String)
      : [];
    recentActionPatterns.push(actionPattern(action));
    session.providerState.recentActionPatterns = recentActionPatterns.slice(-6);
    await this.appendEvent(session, "action.performed", {
      ...actionEvent(action),
      actor,
      deliveryMode: session.deliveryMode,
      deliveryMethod: result.deliveryMethod
    });
    await this.saveSession(session);
    return {
      performed: true,
      sessionId,
      kind: action.kind,
      actor,
      deliveryMode: session.deliveryMode,
      providerResult: result,
      requiresObserve: true
    };
  }

  async grantApproval(sessionId: string, challengeId: string): Promise<ApprovalChallenge> {
    const session = await this.loadActiveSession(sessionId);
    const challenge = session.pendingApprovals.find((item) => item.challengeId === challengeId);
    if (!challenge) throw new GuiAutomationError("APPROVAL_INVALID", "审批挑战不存在或已失效");
    if (!validFutureDate(challenge.expiresAt)) throw new GuiAutomationError("APPROVAL_INVALID", "审批挑战已过期");
    challenge.granted = true;
    await appendJsonLine(this.streamPath(session, "approvals.jsonl"), {
      timestamp: now(), challengeId, actionSummary: challenge.actionSummary, decision: "granted"
    });
    session.approvalCount += 1;
    await this.appendEvent(session, "approval.granted", { challengeId, actionSummary: challenge.actionSummary });
    await this.saveSession(session);
    return challenge;
  }

  async rejectApproval(sessionId: string, challengeId: string, reason: string): Promise<Record<string, unknown>> {
    const session = await this.loadActiveSession(sessionId);
    const index = session.pendingApprovals.findIndex((item) => item.challengeId === challengeId);
    if (index < 0) throw new GuiAutomationError("APPROVAL_INVALID", "审批挑战不存在或已失效");
    const [challenge] = session.pendingApprovals.splice(index, 1);
    await appendJsonLine(this.streamPath(session, "approvals.jsonl"), {
      timestamp: now(), challengeId, actionSummary: challenge.actionSummary, decision: "rejected", reason
    });
    session.approvalCount += 1;
    await this.appendEvent(session, "approval.rejected", { challengeId, actionSummary: challenge.actionSummary, reason });
    await this.saveSession(session);
    return { challengeId, decision: "rejected", reason };
  }

  async stopSession(sessionId: string, reason: string): Promise<AutomationSession> {
    const session = await this.loadSession(sessionId);
    if (session.state !== "active") return session;
    session.state = "stopped";
    session.finishedAt = now();
    session.stopReason = reason;
    session.currentSnapshotId = undefined;
    await this.appendEvent(session, "session.stopped", { reason });
    await this.writeManifest(session);
    await this.saveSession(session);
    await this.releaseWriteLease(sessionId);
    return session;
  }

  private async ensureApproval(
    session: AutomationSession,
    snapshotId: string,
    action: NativeAction,
    signature: string,
    approvalId?: string
  ): Promise<void> {
    if (approvalId) {
      const valid = session.pendingApprovals.some((challenge) => approvalMatchesAction(
        challenge,
        approvalId,
        snapshotId,
        action,
        signature
      ));
      if (valid) return;
      throw new GuiAutomationError("APPROVAL_INVALID", "审批挑战与当前动作、快照不匹配或已过期", { exitCode: 4 });
    }
    let challenge = session.pendingApprovals.find((item) => item.actionSignature === signature && !item.granted);
    if (!challenge) {
      challenge = {
        challengeId: `approval-${randomUUID()}`,
        actionSignature: signature,
        actionSummary: actionSummary(action),
        snapshotId,
        expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
        granted: false
      };
      session.pendingApprovals.push(challenge);
      await appendJsonLine(this.streamPath(session, "approvals.jsonl"), {
        timestamp: now(), challengeId: challenge.challengeId, actionSummary: challenge.actionSummary, decision: "pending"
      });
      session.approvalCount += 1;
      await this.appendEvent(session, "approval.required", {
        challengeId: challenge.challengeId,
        actionSummary: challenge.actionSummary
      });
      await this.saveSession(session);
    }
    throw new GuiAutomationError("APPROVAL_REQUIRED", "该动作需要用户确认后才能执行", {
      details: { challenge }, exitCode: 4
    });
  }

  private async loadWritableSession(sessionId: string, message: string): Promise<AutomationSession> {
    const session = await this.loadActiveSession(sessionId);
    if (session.controlMode !== "agent-control") {
      throw new GuiAutomationError("HUMAN_CONTROL_ACTIVE", message, {
        details: { controlMode: session.controlMode }, exitCode: 3
      });
    }
    await this.assertWriteLease(sessionId);
    await this.renewWriteLease(sessionId);
    return session;
  }

  private async loadActiveSession(sessionId: string): Promise<AutomationSession> {
    const session = await this.loadSession(sessionId);
    if (session.state !== "active") throw new GuiAutomationError("SESSION_STOPPED", "会话已经结束");
    normalizeLoadedSession(session);
    return session;
  }

  private async loadSession(sessionId: string): Promise<AutomationSession> {
    const session = await readJsonFile<AutomationSession>(this.sessionPath(sessionId), `会话不存在：${sessionId}`);
    normalizeLoadedSession(session);
    return session;
  }

  private async saveSession(session: AutomationSession): Promise<void> {
    await atomicWriteJson(this.sessionPath(session.sessionId), session);
  }

  private sessionPath(sessionId: string): string {
    return path.join(this.root, "sessions", `${sessionId}.json`);
  }

  private streamPath(session: AutomationSession, fileName: string): string {
    return path.join(session.artifactDir, "streams", fileName);
  }

  private async appendEvent(session: AutomationSession, type: string, data: unknown): Promise<void> {
    session.eventCount += 1;
    await appendJsonLine(this.streamPath(session, "events.jsonl"), {
      sequence: session.eventCount,
      timestamp: now(),
      type,
      data
    });
  }

  private async acquireWriteLease(sessionId: string): Promise<void> {
    const leasePath = path.join(this.root, "desktop-write-lease.json");
    const lease = await readOptionalJson<Record<string, unknown>>(leasePath);
    if (lease) {
      const owner = String(lease.sessionId || "");
      const active = validFutureDate(String(lease.expiresAt || ""));
      const ownerActive = owner ? await this.loadSession(owner).then((session) => session.state === "active").catch(() => false) : false;
      if (owner && active && ownerActive) {
        throw new GuiAutomationError("DESKTOP_BUSY", "已有写会话控制当前桌面", {
          details: { ownerSessionId: owner }, exitCode: 3
        });
      }
      await fs.rm(leasePath, { force: true });
    }
    await atomicWriteJson(leasePath, { sessionId, acquiredAt: now(), expiresAt: leaseExpiry() });
  }

  private async renewWriteLease(sessionId: string): Promise<void> {
    await this.assertWriteLease(sessionId);
    await atomicWriteJson(path.join(this.root, "desktop-write-lease.json"), {
      sessionId, renewedAt: now(), expiresAt: leaseExpiry()
    });
  }

  private async assertWriteLease(sessionId: string): Promise<void> {
    const lease = await readOptionalJson<Record<string, unknown>>(path.join(this.root, "desktop-write-lease.json"));
    if (!lease) throw new GuiAutomationError("DESKTOP_BUSY", "当前会话没有桌面写 lease");
    if (lease.sessionId !== sessionId) throw new GuiAutomationError("DESKTOP_BUSY", "桌面写 lease 已被其他会话持有");
  }

  private async releaseWriteLease(sessionId: string): Promise<void> {
    const leasePath = path.join(this.root, "desktop-write-lease.json");
    const lease = await readOptionalJson<Record<string, unknown>>(leasePath);
    if (lease?.sessionId === sessionId) await fs.rm(leasePath, { force: true });
  }

  private async writeManifest(session: AutomationSession): Promise<void> {
    const manifest = {
      artifactKind: "native-rep",
      schemaVersion: PROTOCOL_VERSION,
      runId: session.sessionId,
      nativeRunId: session.sessionId,
      providerId: session.providerId,
      app: session.app,
      controlMode: session.controlMode,
      deliveryMode: session.deliveryMode,
      startedAt: session.startedAt,
      finishedAt: session.finishedAt,
      stopReason: session.stopReason,
      captureStopReason: session.stopReason,
      eventCount: session.eventCount,
      snapshotCount: session.snapshotSequence,
      actionCount: session.actionCount,
      approvalCount: session.approvalCount,
      captureGaps: session.captureGaps
    };
    await atomicWriteJson(path.join(session.artifactDir, "manifest.json"), manifest);
    const schemaDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "schemas");
    for (const name of ["manifest.schema.json", "protocol.schema.json", "session.schema.json", "snapshot.schema.json", "error.schema.json"]) {
      const content = await fs.readFile(path.join(schemaDir, name));
      await atomicWriteFile(path.join(session.artifactDir, "schemas", name), content);
      if (name === "manifest.schema.json") await atomicWriteFile(path.join(session.artifactDir, name), content);
    }
  }
}

function validateAppSelector(app: AppSelector): void {
  if (!["bundle-id", "path", "name", "process-id"].includes(app.kind)) {
    throw new GuiAutomationError("INVALID_ARGUMENT", "无效的应用选择器类型");
  }
  if (!app.value.trim()) throw new GuiAutomationError("INVALID_ARGUMENT", "应用选择器不能为空");
  if (app.kind === "process-id" && (!/^\d+$/.test(app.value) || Number(app.value) < 1)) {
    throw new GuiAutomationError("INVALID_ARGUMENT", "process-id 必须是正整数");
  }
}

export function requiresApproval(action: NativeAction, element?: UiElement): boolean {
  if (action.kind === "key" && ["return", "enter", "space"].includes(String(action.key || "").toLowerCase())) return true;
  const label = String(element?.name || "").toLowerCase();
  return ["delete", "remove", "send", "submit", "pay", "purchase", "install", "uninstall", "删除", "移除", "发送", "提交", "支付", "购买", "安装", "卸载", "系统设置"]
    .some((keyword) => label.includes(keyword));
}

function resolveElement(session: AutomationSession, elementId?: string): UiElement | undefined {
  if (!elementId) return undefined;
  const element = session.lastElements.find((item) => item.elementId === elementId);
  if (!element) throw new GuiAutomationError("ELEMENT_NOT_FOUND", `元素不存在：${elementId}`);
  return element;
}

function assertActionTargetIsUsable(
  session: AutomationSession,
  action: NativeAction,
  element?: UiElement
): void {
  if (session.deliveryMode === "background-safe" && element && action.kind === "click") {
    const role = element.role.toLowerCase().replace(/[^a-z]/g, "");
    const supportsPress = element.actions.some((candidate) => candidate.toLowerCase() === "axpress");
    if (EDITABLE_ROLES.has(role) && !supportsPress) {
      throw new GuiAutomationError(
        "UNSUPPORTED_ACTION",
        `严格后台模式无需点击可编辑元素 ${element.elementId}；请直接使用 set-value 或 type-text --element，动作后 observe 验证值`,
        { details: { elementId: element.elementId, role: element.role, name: element.name, suggestedActions: ["set-value", "type-text"] } }
      );
    }
  }
  if (element && ["set-value", "type-text"].includes(action.kind) && !action.focused) {
    const role = element.role.toLowerCase().replace(/[^a-z]/g, "");
    const advertisesValueInput = element.actions.some((candidate) =>
      ["set-value", "setvalue", "valuepattern.setvalue"].includes(candidate.toLowerCase())
    );
    if (!EDITABLE_ROLES.has(role) && !advertisesValueInput) {
      throw new GuiAutomationError(
        "UNSUPPORTED_ACTION",
        `目标元素 ${element.elementId}（${element.role}）不是可编辑输入控件；自绘输入框请先点击可见锚点、observe，再使用 type-text --focused`,
        { details: { elementId: element.elementId, role: element.role, name: element.name } }
      );
    }
  }
  if (action.kind !== "click" || !action.allowCoordinateFallback || !session.lastWindowBounds) return;
  const point = element?.bounds
    ? {
        x: element.bounds.x + element.bounds.width / 2,
        y: element.bounds.y + element.bounds.height / 2
      }
    : action.x != null && action.y != null
      ? { x: action.x, y: action.y }
      : undefined;
  if (!point || pointInsideBounds(point, session.lastWindowBounds)) return;
  throw new GuiAutomationError(
    "UNSUPPORTED_ACTION",
    element
      ? `目标元素 ${element.elementId} 当前位于目标窗口之外；请滚动到可见区域并重新 observe`
      : "坐标点击必须位于最新观察到的目标窗口内",
    {
      details: {
        point,
        windowBounds: session.lastWindowBounds,
        elementId: element?.elementId
      }
    }
  );
}

function pointInsideBounds(
  point: { x: number; y: number },
  bounds: { x: number; y: number; width: number; height: number }
): boolean {
  return point.x >= bounds.x
    && point.x <= bounds.x + bounds.width
    && point.y >= bounds.y
    && point.y <= bounds.y + bounds.height;
}

function actionSignature(snapshotId: string, action: NativeAction): string {
  const material = [snapshotId, action.kind, action.elementId || "", action.value || "", action.key || "", action.direction || "", action.pages || 0,
    action.allowCoordinateFallback, action.focused, action.visualText || "", action.matchMode || "", action.occurrence || 0].join("|");
  return `action-${createHash("sha256").update(material).digest("hex").slice(0, 16)}`;
}

function actionSummary(action: NativeAction): string {
  return `${action.kind} ${action.elementId || action.visualText || action.key || action.direction || "coordinate"}`;
}

export function approvalMatchesAction(
  challenge: ApprovalChallenge,
  approvalId: string,
  snapshotId: string,
  action: NativeAction,
  signature: string
): boolean {
  const signatureMatches = challenge.actionSignature === signature;
  const legacySummaryMatches = challenge.actionSummary === actionSummary(action);
  return challenge.challengeId === approvalId
    && challenge.snapshotId === snapshotId
    && (signatureMatches || legacySummaryMatches)
    && challenge.granted
    && validFutureDate(challenge.expiresAt);
}

function actionEvent(action: NativeAction): Record<string, unknown> {
  return {
    kind: action.kind,
    elementId: action.elementId,
    hasValue: action.value != null,
    key: action.key,
    direction: action.direction,
    pages: action.pages,
    coordinate: action.x != null && action.y != null ? { x: action.x, y: action.y } : undefined,
    visualText: action.visualText,
    matchMode: action.matchMode,
    occurrence: action.occurrence
  };
}

interface ProviderTimeoutRetryGuard {
  actionKey: string;
  failedSnapshotId: string;
  failures: number;
  blocked: boolean;
}

function enforceProviderTimeoutRetryGuard(
  session: AutomationSession,
  snapshotId: string,
  action: NativeAction
): void {
  const guard = readProviderTimeoutRetryGuard(session);
  if (!guard) return;
  if (guard.blocked) {
    throw new GuiAutomationError(
      "PROVIDER_UNAVAILABLE",
      "Provider 原子动作已连续超时两次，本会话动作通道已阻塞",
      { details: { failures: guard.failures, retryExhausted: true }, exitCode: 3 }
    );
  }
  if (guard.failedSnapshotId === snapshotId) {
    throw new GuiAutomationError(
      "STALE_SNAPSHOT",
      "Provider 超时后必须先重新 observe，再重试原动作",
      { details: { providerTimeoutRetryRequired: true }, exitCode: 3 }
    );
  }
  if (guard.actionKey !== providerRetryActionKey(action)) {
    throw new GuiAutomationError(
      "PROVIDER_UNAVAILABLE",
      "Provider 超时后仅允许重试原动作一次，禁止切换按键、视觉点击或坐标点击",
      { details: { failures: guard.failures, retryOriginalActionOnly: true }, exitCode: 3 }
    );
  }
}

function recordProviderTimeoutFailure(
  session: AutomationSession,
  snapshotId: string,
  action: NativeAction
): void {
  const existing = readProviderTimeoutRetryGuard(session);
  const failures = existing?.actionKey === providerRetryActionKey(action)
    ? existing.failures + 1
    : 1;
  session.providerState.providerTimeoutRetryGuard = {
    actionKey: providerRetryActionKey(action),
    failedSnapshotId: snapshotId,
    failures,
    blocked: failures >= 2
  } satisfies ProviderTimeoutRetryGuard;
}

function readProviderTimeoutRetryGuard(session: AutomationSession): ProviderTimeoutRetryGuard | undefined {
  const value = session.providerState.providerTimeoutRetryGuard;
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const guard = value as Partial<ProviderTimeoutRetryGuard>;
  if (typeof guard.actionKey !== "string" || typeof guard.failedSnapshotId !== "string") return undefined;
  return {
    actionKey: guard.actionKey,
    failedSnapshotId: guard.failedSnapshotId,
    failures: Number(guard.failures || 0),
    blocked: guard.blocked === true
  };
}

function providerRetryActionKey(action: NativeAction): string {
  return createHash("sha256").update(JSON.stringify(actionEvent(action))).digest("hex");
}

function isProviderTimeoutFailure(error: GuiAutomationError): boolean {
  return error.code === "PROVIDER_UNAVAILABLE"
    && /未返回响应|启动器.*未返回|timed?\s*out|timeout|超时/i.test(error.message);
}

function focusedInputAnchorIsFresh(session: AutomationSession): boolean {
  const anchor = session.providerState.focusedInputAnchor as Record<string, unknown> | undefined;
  return Number(anchor?.snapshotSequence) + 1 === session.snapshotSequence;
}

function invalidateSnapshot(session: AutomationSession): void {
  session.currentSnapshotId = undefined;
  session.lastElements = [];
  delete session.providerState.lastObservationFingerprint;
  delete session.providerState.noProgressObservationCount;
  delete session.providerState.lastObservedActionCount;
  delete session.providerState.lastObservationTextHash;
  delete session.providerState.recentActionPatterns;
}

export function observationFingerprint(snapshot: ProviderSnapshot): string {
  const elements = meaningfulObservationElements(snapshot).map((element) => ({
    role: element.role,
    name: element.name,
    value: element.secure ? "<secure>" : element.value,
    enabled: element.enabled,
    focused: element.focused,
    bounds: element.bounds
  }));
  return createHash("sha256").update(JSON.stringify({
    app: snapshot.app.id,
    windowBounds: snapshot.windowBounds,
    elements
  })).digest("hex");
}

function meaningfulObservationElements(snapshot: ProviderSnapshot): UiElement[] {
  const window = snapshot.windowBounds;
  if (!window) return snapshot.elements;
  return snapshot.elements.filter((element) => {
    if (element.focused || !element.bounds) return true;
    const bounds = element.bounds;
    return bounds.width > 0
      && bounds.height > 0
      && bounds.x < window.x + window.width
      && bounds.x + bounds.width > window.x
      && bounds.y < window.y + window.height
      && bounds.y + bounds.height > window.y;
  });
}

function observationTextHash(snapshot: ProviderSnapshot): string {
  return textHash(meaningfulObservationElements(snapshot).map((element) => JSON.stringify({
    role: element.role,
    name: element.name,
    value: element.secure ? "<secure>" : element.value,
    focused: element.focused
  })).join("\n"));
}

function actionPattern(action: NativeAction): string {
  return createHash("sha256").update(JSON.stringify({
    kind: action.kind,
    elementId: action.elementId || "",
    value: action.value || "",
    key: action.key || "",
    direction: action.direction || "",
    pages: action.pages || 0,
    x: action.x,
    y: action.y,
    visualText: action.visualText || "",
    matchMode: action.matchMode || "",
    occurrence: action.occurrence || 0
  })).digest("hex");
}

function repeatedIneffectiveActionLoop(session: AutomationSession, noProgressCount: number): boolean {
  if (noProgressCount < NO_PROGRESS_OBSERVATION_LIMIT) return false;
  const patterns = Array.isArray(session.providerState.recentActionPatterns)
    ? session.providerState.recentActionPatterns.map(String)
    : [];
  const lastThree = patterns.slice(-3);
  if (lastThree.length === 3 && lastThree.every((pattern) => pattern === lastThree[0])) return true;
  const lastFour = patterns.slice(-4);
  return lastFour.length === 4
    && lastFour[0] === lastFour[2]
    && lastFour[1] === lastFour[3];
}

function observationDelta(
  session: AutomationSession,
  snapshot: ProviderSnapshot,
  progress: Pick<ObservationDelta, "changed" | "actionCountSinceLastObservation" | "noProgressCount">
): ObservationDelta {
  const previousByPath = new Map(session.lastElements.map((element) => [element.providerPath || element.elementId, element]));
  const nextByPath = new Map(snapshot.elements.map((element) => [element.providerPath || element.elementId, element]));
  let addedElementCount = 0;
  let removedElementCount = 0;
  let updatedElementCount = 0;
  for (const [key, element] of nextByPath) {
    const previous = previousByPath.get(key);
    if (!previous) {
      addedElementCount += 1;
    } else if (elementFingerprint(previous) !== elementFingerprint(element)) {
      updatedElementCount += 1;
    }
  }
  for (const key of previousByPath.keys()) {
    if (!nextByPath.has(key)) removedElementCount += 1;
  }
  const previousFocused = session.lastElements.find((element) => element.focused);
  const nextFocused = snapshot.elements.find((element) => element.focused);
  return {
    ...progress,
    windowChanged: JSON.stringify(session.lastWindowBounds || null) !== JSON.stringify(snapshot.windowBounds || null),
    focusedElementChanged: (previousFocused?.providerPath || previousFocused?.elementId || "")
      !== (nextFocused?.providerPath || nextFocused?.elementId || ""),
    textChanged: String(session.providerState.lastObservationTextHash || "") !== observationTextHash(snapshot),
    addedElementCount,
    removedElementCount,
    updatedElementCount
  };
}

function observationChanges(
  previousElements: UiElement[],
  nextElements: UiElement[]
): ObservationChanges {
  const previousByPath = new Map(previousElements.map((element) => [
    element.providerPath || element.elementId,
    element
  ]));
  const nextByPath = new Map(nextElements.map((element) => [
    element.providerPath || element.elementId,
    element
  ]));
  const addedElements: UiElement[] = [];
  const updatedElements: UiElement[] = [];
  const removedElementIds: string[] = [];
  for (const [key, element] of nextByPath) {
    const previous = previousByPath.get(key);
    if (!previous) addedElements.push(element);
    else if (elementFingerprint(previous) !== elementFingerprint(element)) updatedElements.push(element);
  }
  for (const [key, element] of previousByPath) {
    if (!nextByPath.has(key)) removedElementIds.push(element.elementId);
  }
  return { addedElements, updatedElements, removedElementIds };
}

function elementFingerprint(element: UiElement): string {
  return createHash("sha256").update(JSON.stringify({
    role: element.role,
    name: element.name,
    value: element.secure ? "<secure>" : element.value,
    enabled: element.enabled,
    focused: element.focused,
    bounds: element.bounds
  })).digest("hex");
}

function textHash(value: string): string {
  return createHash("sha256").update(String(value || "")).digest("hex");
}

function normalizeLoadedSession(session: AutomationSession): void {
  session.approvalPolicy ||= "sensitive-actions";
  session.deliveryMode ||= "foreground-compatible";
  session.lastElements ||= [];
  session.pendingApprovals ||= [];
  session.providerState ||= {};
  session.captureGaps ||= [];
  session.eventCount ||= 0;
  session.actionCount ||= 0;
  session.approvalCount ||= 0;
  session.snapshotSequence ||= 0;
}

function sameSelector(left: AppSelector, right: AppSelector): boolean {
  return left.kind === right.kind && left.value === right.value;
}

function validFutureDate(value: string): boolean {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && timestamp >= Date.now();
}

function leaseExpiry(): string {
  return new Date(Date.now() + 60 * 60_000).toISOString();
}

async function readOptionalJson<T>(filePath: string): Promise<T | undefined> {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    if (error instanceof SyntaxError) throw new GuiAutomationError("STORAGE_CORRUPTED", `桌面 lease 文件损坏：${error.message}`);
    throw error;
  }
}

function now(): string {
  return new Date().toISOString();
}

function platformName(): string {
  return process.platform === "darwin" ? "macos" : process.platform === "win32" ? "windows" : process.platform;
}

function architectureName(): string {
  return process.arch === "x64" ? "x86_64" : process.arch === "arm64" ? "aarch64" : process.arch;
}
