import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { BrowserAutomationError } from "./error.mjs";
import {
  activateCdpTarget,
  closeAllTargetConnections,
  closeTargetConnection,
  evaluate,
  listCdpTargets,
  normalizeCdpUrl,
  normalizeNavigationUrl,
  resolvePageTarget,
  withTarget
} from "./cdp.mjs";
import {
  buildDomDragExpression,
  buildDragPointsExpression,
  buildElementActionExpression,
  buildElementObjectExpression,
  buildObserveExpression
} from "./dom.mjs";

export const PROTOCOL_VERSION = 1;
export const RUNTIME_VERSION = "0.6.1";
const SCHEMA_DIR = fileURLToPath(new URL("../schemas", import.meta.url));
const SCHEMA_FILES = ["protocol.schema.json", "session.schema.json", "snapshot.schema.json", "action.schema.json", "manifest.schema.json", "error.schema.json"];

const SESSION_ID_PATTERN = /^browser-[0-9a-f-]{16,}$/i;
const CONTROL_MODES = new Set(["observe", "agent-control", "human-control"]);
const ELEMENT_ACTIONS = new Set(["click", "set-value", "type-text", "select-option", "hover"]);
const MAX_UPLOAD_FILE_BYTES = 50 * 1024 * 1024;
const KEY_ALIASES = new Map([
  ["enter", { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 }],
  ["tab", { key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 }],
  ["escape", { key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 }],
  ["backspace", { key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 }],
  ["delete", { key: "Delete", code: "Delete", windowsVirtualKeyCode: 46 }],
  ["arrowup", { key: "ArrowUp", code: "ArrowUp", windowsVirtualKeyCode: 38 }],
  ["arrowdown", { key: "ArrowDown", code: "ArrowDown", windowsVirtualKeyCode: 40 }],
  ["arrowleft", { key: "ArrowLeft", code: "ArrowLeft", windowsVirtualKeyCode: 37 }],
  ["arrowright", { key: "ArrowRight", code: "ArrowRight", windowsVirtualKeyCode: 39 }],
  ["home", { key: "Home", code: "Home", windowsVirtualKeyCode: 36 }],
  ["end", { key: "End", code: "End", windowsVirtualKeyCode: 35 }],
  ["pageup", { key: "PageUp", code: "PageUp", windowsVirtualKeyCode: 33 }],
  ["pagedown", { key: "PageDown", code: "PageDown", windowsVirtualKeyCode: 34 }],
  ["space", { key: " ", code: "Space", windowsVirtualKeyCode: 32 }]
]);
const KEY_MODIFIERS = new Map([
  ["alt", { key: "Alt", code: "AltLeft", windowsVirtualKeyCode: 18, mask: 1 }],
  ["option", { key: "Alt", code: "AltLeft", windowsVirtualKeyCode: 18, mask: 1 }],
  ["ctrl", { key: "Control", code: "ControlLeft", windowsVirtualKeyCode: 17, mask: 2 }],
  ["control", { key: "Control", code: "ControlLeft", windowsVirtualKeyCode: 17, mask: 2 }],
  ["meta", { key: "Meta", code: "MetaLeft", windowsVirtualKeyCode: 91, mask: 4 }],
  ["cmd", { key: "Meta", code: "MetaLeft", windowsVirtualKeyCode: 91, mask: 4 }],
  ["command", { key: "Meta", code: "MetaLeft", windowsVirtualKeyCode: 91, mask: 4 }],
  ["shift", { key: "Shift", code: "ShiftLeft", windowsVirtualKeyCode: 16, mask: 8 }]
]);

export function runtimeHome() {
  return path.resolve(process.env.DT_GUI_BROWSER_HOME || path.join(os.homedir(), ".dt-gui-browser"));
}

export async function doctor() {
  const home = runtimeHome();
  await ensureRuntimeDirs(home);
  return {
    protocolVersion: PROTOCOL_VERSION,
    runtimeVersion: RUNTIME_VERSION,
    platform: process.platform,
    architecture: process.arch,
    runtimeHome: home,
    status: "ok"
  };
}

export function capabilities() {
  return {
    protocolVersion: PROTOCOL_VERSION,
    runtimeVersion: RUNTIME_VERSION,
    session: ["start", "status", "target", "control", "stop"],
    observation: ["tabs-list", "downloads-list", "observe", "screenshot"],
    navigation: ["navigate", "back", "forward", "reload"],
    actions: [
      "click", "set-value", "type-text", "select-option", "hover", "key", "scroll",
      "dialog-aware-click", "drag", "upload-file"
    ],
    safeguards: [
      "loopback-cdp-only",
      "exact-target-id",
      "snapshot-scoped-elements",
      "password-redaction",
      "human-control-gate",
      "no-arbitrary-javascript"
    ],
    mcp: true
  };
}

export function shutdownPersistentRuntime() {
  closeAllTargetConnections();
}

export async function startSession(input) {
  const cdpUrl = normalizeCdpUrl(input.cdpUrl);
  const targetId = requiredString(input.targetId, "targetId");
  const target = await resolvePageTarget(cdpUrl, targetId);
  const allowTargetSelection = input.allowTargetSelection === true;
  const initialTargets = allowTargetSelection
    ? (await listCdpTargets(cdpUrl)).filter((candidate) => candidate.type === "page" && candidate.webSocketDebuggerUrl)
    : [target];
  const artifactRoot = path.resolve(requiredString(input.artifactRoot, "artifactRoot"));
  const sessionId = `browser-${randomUUID()}`;
  const artifactDir = path.join(artifactRoot, sessionId);
  const now = new Date().toISOString();
  const home = runtimeHome();
  await ensureRuntimeDirs(home);
  await acquireTargetLease(home, cdpUrl, targetId, sessionId);
  try {
    await Promise.all([
      fs.mkdir(path.join(artifactDir, "screenshots"), { recursive: true }),
      fs.mkdir(path.join(artifactDir, "snapshots"), { recursive: true }),
      fs.mkdir(path.join(artifactDir, "streams"), { recursive: true }),
      copySchemas(artifactDir)
    ]);
    await Promise.all([
      createPrivateFile(path.join(artifactDir, "streams", "events.jsonl")),
      createPrivateFile(path.join(artifactDir, "streams", "snapshots.jsonl")),
      createPrivateFile(path.join(artifactDir, "streams", "actions.jsonl")),
      createPrivateFile(path.join(artifactDir, "streams", "capture-gaps.jsonl")),
      createPrivateFile(path.join(artifactDir, "streams", "console.jsonl")),
      createPrivateFile(path.join(artifactDir, "streams", "page-errors.jsonl")),
      createPrivateFile(path.join(artifactDir, "streams", "downloads.jsonl")),
      createPrivateFile(path.join(artifactDir, "streams", "targets.jsonl")),
      createPrivateFile(path.join(artifactDir, "streams", "dialogs.jsonl"))
    ]);
    const session = {
      version: PROTOCOL_VERSION,
      runtimeVersion: RUNTIME_VERSION,
      sessionId,
      runId: String(input.runId || sessionId),
      uiwardenSessionId: input.uiwardenSessionId ? String(input.uiwardenSessionId) : undefined,
      cdpUrl,
      targetId,
      allowedTargetIds: [...new Set(initialTargets.map((candidate) => candidate.targetId))],
      discoveredTargetIds: [],
      targetRelations: {},
      targetSelection: allowTargetSelection ? "agent" : "uiwarden",
      targetTitle: target.title,
      targetUrl: target.url,
      uploadRoots: await normalizeUploadRoots(input.uploadRoots, artifactRoot),
      pendingDialog: null,
      controlMode: normalizeControlMode(input.controlMode || "agent-control"),
      state: "active",
      currentSnapshotId: null,
      currentSnapshot: null,
      lastObservedSnapshot: null,
      artifactDir,
      startedAt: now,
      finishedAt: null,
      stopReason: null,
      eventCount: 0,
      snapshotSequence: 0,
      actionCount: 0,
      screenshotCount: 0,
      captureGapCount: 0,
      consoleCount: 0,
      pageErrorCount: 0,
      downloadCount: 0,
      dialogCount: 0,
      targetCount: initialTargets.length
    };
    await appendEvent(session, "session-started", {
      targetId,
      url: target.url,
      title: target.title
    });
    await writeSession(home, session);
    return publicSession(session);
  } catch (error) {
    await releaseTargetLease(home, cdpUrl, targetId, sessionId);
    throw error;
  }
}

export async function getSession(sessionId) {
  return publicSession(await readSession(runtimeHome(), sessionId));
}

export async function setSessionTarget(sessionId, targetId) {
  return withSessionMutation(sessionId, async (session) => {
    assertActive(session);
    const nextTargetId = requiredString(targetId, "targetId");
    const target = await resolvePageTarget(session.cdpUrl, nextTargetId);
    if (nextTargetId !== session.targetId) {
      const previousTargetId = session.targetId;
      await acquireTargetLease(runtimeHome(), session.cdpUrl, nextTargetId, session.sessionId);
      await releaseTargetLease(runtimeHome(), session.cdpUrl, session.targetId, session.sessionId);
      session.targetId = nextTargetId;
      session.allowedTargetIds = [...new Set([...session.allowedTargetIds, nextTargetId])];
      session.targetTitle = target.title;
      session.targetUrl = target.url;
      invalidateSnapshot(session);
      resetObservationBaseline(session);
      closeTargetConnection(session.cdpUrl, previousTargetId);
      await appendEvent(session, "target-changed", {
        targetId: nextTargetId,
        url: target.url,
        title: target.title
      });
    }
    return publicSession(session);
  });
}

export async function setControlMode(sessionId, mode) {
  return withSessionMutation(sessionId, async (session) => {
    assertActive(session);
    const nextMode = normalizeControlMode(mode);
    session.controlMode = nextMode;
    if (nextMode !== "agent-control") invalidateSnapshot(session);
    await appendEvent(session, "control-mode-changed", { mode: nextMode });
    return publicSession(session);
  });
}

export async function stopSession(sessionId, reason = "completed") {
  return withSessionMutation(sessionId, async (session) => {
    if (session.state !== "active") return publicSession(session);
    const finishedAt = new Date().toISOString();
    if (session.snapshotSequence === 0 || session.screenshotCount === 0) {
      await appendCaptureGap(session, "no-browser-observation", "会话结束前没有可用的语义快照和截图");
    }
    session.state = "stopped";
    session.finishedAt = finishedAt;
    session.stopReason = normalizeReason(reason);
    invalidateSnapshot(session);
    resetObservationBaseline(session);
    closeTargetConnection(session.cdpUrl, session.targetId);
    await appendEvent(session, "session-stopped", { reason: session.stopReason });
    await writeManifest(session);
    await releaseTargetLease(runtimeHome(), session.cdpUrl, session.targetId, session.sessionId);
    return publicSession(session);
  });
}

export async function listTabs(sessionId) {
  return withSessionMutation(sessionId, async (session) => {
    assertActive(session);
    const targets = await listCdpTargets(session.cdpUrl);
    const current = targets.find((target) => target.targetId === session.targetId && target.type === "page");
    if (!current) throw new BrowserAutomationError("TARGET_GONE", `指定浏览器 target 不存在：${session.targetId}`, {}, 3);
    await discoverRelatedTargets(session, targets);
    const visible = targets.filter((target) =>
      target.type === "page" && session.allowedTargetIds.includes(target.targetId)
    );
    return {
      sessionId: session.sessionId,
      activeTargetId: session.targetId,
      tabs: visible.map((target) => ({
        targetId: target.targetId,
        openerTargetId: session.targetRelations?.[target.targetId]?.openerTargetId,
        title: target.title,
        url: target.url,
        active: target.targetId === session.targetId,
        allowed: true,
        discovered: session.discoveredTargetIds.includes(target.targetId)
      })),
      targetPolicy: session.targetSelection === "agent"
        ? "Agent may select an initially authorized tab or a descendant opened by one of those tabs."
        : "The initial UIWarden target and descendant tabs opened by it are authorized; unrelated user tabs stay hidden."
    };
  });
}

export async function listDownloads(sessionId) {
  const session = await readSession(runtimeHome(), sessionId);
  const records = await readJsonLines(path.join(session.artifactDir, "streams", "downloads.jsonl"));
  const byGuid = new Map();
  for (const record of records) {
    const guid = boundedString(record.guid, 200);
    if (!guid) continue;
    const current = byGuid.get(guid) || {
      guid,
      state: "unknown",
      url: "",
      suggestedFilename: "",
      receivedBytes: 0,
      totalBytes: 0,
      startedAt: undefined,
      completedAt: undefined
    };
    const state = boundedString(record.state, 50);
    current.state = state || current.state;
    current.url = boundedString(record.url, 2_000) || current.url;
    current.suggestedFilename = boundedString(record.suggestedFilename, 255) || current.suggestedFilename;
    current.receivedBytes = finiteNumber(record.receivedBytes) ?? current.receivedBytes;
    current.totalBytes = finiteNumber(record.totalBytes) ?? current.totalBytes;
    current.startedAt = current.startedAt || boundedString(record.timestamp, 100);
    if (state === "completed") current.completedAt = boundedString(record.timestamp, 100);
    byGuid.set(guid, current);
  }
  const downloadDir = path.join(session.artifactDir, "downloads");
  const downloads = await Promise.all([...byGuid.values()].map(async (record) => {
    const fileName = path.basename(record.suggestedFilename || "");
    const filePresent = Boolean(fileName) && await fs.stat(path.join(downloadDir, fileName))
      .then((stat) => stat.isFile())
      .catch(() => false);
    return {
      ...record,
      filePresent,
      relativePath: filePresent ? path.posix.join("downloads", fileName) : undefined
    };
  }));
  return {
    sessionId: session.sessionId,
    downloads: downloads.sort((left, right) =>
      String(right.completedAt || right.startedAt).localeCompare(String(left.completedAt || left.startedAt))
    )
  };
}

export async function activateTab(sessionId, targetId) {
  await withSessionMutation(sessionId, async (session) => {
    assertActive(session);
    const requested = requiredString(targetId, "targetId");
    if (requested !== session.targetId && !session.allowedTargetIds.includes(requested)) {
      throw new BrowserAutomationError(
        "TARGET_NOT_ALLOWED",
        "该标签页不在 UIWarden 为本次任务授权的候选范围内",
        { requestedTargetId: requested, activeTargetId: session.targetId }
      );
    }
    const target = await resolvePageTarget(session.cdpUrl, requested);
    await activateCdpTarget(session.cdpUrl, requested);
    if (requested !== session.targetId) {
      const previousTargetId = session.targetId;
      await acquireTargetLease(runtimeHome(), session.cdpUrl, requested, session.sessionId);
      await releaseTargetLease(runtimeHome(), session.cdpUrl, session.targetId, session.sessionId);
      session.targetId = requested;
      session.targetTitle = target.title;
      session.targetUrl = target.url;
      invalidateSnapshot(session);
      resetObservationBaseline(session);
      closeTargetConnection(session.cdpUrl, previousTargetId);
      await appendEvent(session, "target-changed", {
        targetId: requested,
        url: target.url,
        title: target.title,
        actor: "agent"
      });
    }
  });
  return listTabs(sessionId);
}

export async function observe(sessionId, options = {}) {
  return withSessionMutation(sessionId, async (session) => {
    assertActive(session);
    const sequence = session.snapshotSequence + 1;
    const snapshotId = `snapshot-${randomUUID()}`;
    const markerPrefix = `${session.sessionId.slice(-12)}-${sequence}-${randomUUID().slice(0, 8)}`;
    const page = await withTarget(session.cdpUrl, session.targetId, async (client, target, transport) => {
      const observed = await evaluate(client, buildObserveExpression({
        markerPrefix,
        maxElements: clampNumber(options.maxElements, 1, 500, 300),
        maxTextLength: clampNumber(options.maxTextLength, 100, 100_000, 20_000)
      }));
      const screenshot = await captureScreenshot(client, session, session.screenshotCount + 1, options.fullPage === true);
      return { observed, screenshot, target, transport };
    });
    if (!page.observed || typeof page.observed !== "object" || !Array.isArray(page.observed.elements)) {
      throw new BrowserAutomationError("CAPTURE_FAILED", "浏览器页面未返回有效语义快照");
    }
    const capturedAt = new Date().toISOString();
    const internalElements = page.observed.elements.map((element) => ({
      ...element,
      elementId: stableElementId(element.stableKey || element.elementId)
    }));
    const publicElements = internalElements.map(({ locatorId: _locatorId, stableKey: _stableKey, ...element }) => element);
    const previous = session.lastObservedSnapshot;
    const changes = buildObservationChanges(previous, {
      snapshotId,
      targetId: session.targetId,
      text: String(page.observed.text || ""),
      elements: publicElements
    });
    const snapshot = {
      version: PROTOCOL_VERSION,
      snapshotId,
      sessionId: session.sessionId,
      sequence,
      targetId: session.targetId,
      url: String(page.observed.url || page.target.url || ""),
      title: String(page.observed.title || page.target.title || ""),
      readyState: String(page.observed.readyState || ""),
      viewport: page.observed.viewport || {},
      text: String(page.observed.text || ""),
      elements: publicElements,
      screenshotPath: page.screenshot.path,
      screenshotSequence: page.screenshot.sequence,
      screenshotSha256: page.screenshot.sha256,
      transport: {
        kind: "cdp",
        connectionId: page.transport.connectionId,
        connectedAt: page.transport.connectedAt,
        reused: page.transport.reused
      },
      changes: summarizeObservationChanges(changes),
      captureGaps: Array.isArray(page.observed.captureGaps) ? page.observed.captureGaps : [],
      capturedAt
    };
    session.snapshotSequence = sequence;
    session.currentSnapshotId = snapshotId;
    session.currentSnapshot = {
      snapshotId,
      targetId: session.targetId,
      elements: internalElements
    };
    session.lastObservedSnapshot = {
      snapshotId,
      targetId: session.targetId,
      text: snapshot.text,
      elements: publicElements
    };
    session.targetTitle = snapshot.title;
    session.targetUrl = snapshot.url;
    await Promise.all([
      writeJson(path.join(session.artifactDir, "snapshots", "latest.json"), snapshot),
      appendJsonLine(path.join(session.artifactDir, "streams", "snapshots.jsonl"), snapshot)
    ]);
    for (const gap of snapshot.captureGaps) await appendCaptureGap(session, String(gap));
    await appendEvent(session, "snapshot-captured", {
      snapshotId,
      sequence,
      targetId: session.targetId,
      elementCount: publicElements.length,
      screenshotPath: page.screenshot.path,
      screenshotSequence: page.screenshot.sequence,
      screenshotSha256: page.screenshot.sha256,
      cdpConnectionId: page.transport.connectionId,
      cdpConnectionReused: page.transport.reused
    });
    return options.diff === true && previous?.targetId === session.targetId
      ? diffProjection(snapshot, changes, previous.snapshotId)
      : { ...snapshot, projection: "full", baseline: options.diff === true };
  });
}

export async function performElementAction(sessionId, input) {
  return withSessionMutation(sessionId, async (session) => {
    assertAgentControl(session);
    const kind = requiredString(input.kind, "kind");
    if (!ELEMENT_ACTIONS.has(kind)) throw new BrowserAutomationError("UNSUPPORTED_ACTION", `不支持的元素动作：${kind}`);
    const snapshotId = requiredString(input.snapshotId, "snapshotId");
    const elementId = requiredString(input.elementId, "elementId");
    const current = session.currentSnapshot;
    if (!current || session.currentSnapshotId !== snapshotId || current.snapshotId !== snapshotId || current.targetId !== session.targetId) {
      throw new BrowserAutomationError("STALE_SNAPSHOT", "快照已失效，请重新 observe");
    }
    const element = current.elements.find((item) => item.elementId === elementId);
    if (!element) throw new BrowserAutomationError("ELEMENT_NOT_FOUND", `快照中不存在元素：${elementId}`);
    if (!Array.isArray(element.actions) || !element.actions.includes(kind)) {
      throw new BrowserAutomationError("UNSUPPORTED_ACTION", `${elementId} 不支持 ${kind}`);
    }
    if (element.secure && (kind === "set-value" || kind === "type-text")) {
      throw new BrowserAutomationError(
        "HANDOFF_REQUIRED",
        "密码或安全字段必须由用户在可见浏览器中输入",
        { elementId, snapshotId }
      );
    }
    const value = input.value == null ? "" : String(input.value);
    const result = await withTarget(session.cdpUrl, session.targetId, async (client) => {
      const diagnosticEvents = [];
      const diagnostics = await subscribeDiagnostics(client, session, diagnosticEvents);
      try {
        const evaluated = await evaluate(client, buildElementActionExpression({
          kind,
          locatorId: element.locatorId,
          expectedTag: element.tag,
          expectedType: element.type,
          value
        }));
        if (evaluated?.dispatch === "click" || evaluated?.dispatch === "hover") {
          const x = Number(evaluated.x);
          const y = Number(evaluated.y);
          if (!Number.isFinite(x) || !Number.isFinite(y)) {
            throw new BrowserAutomationError("ACTION_FAILED", "元素没有可用的指针位置");
          }
          if (evaluated.dispatch === "click" && evaluated.anchor?.download) {
            await prepareDownloadCapture(client, session);
            await appendDownloadRecord(session, {
              state: "requested",
              url: boundedString(evaluated.anchor.href, 2_000),
              suggestedFilename: boundedString(evaluated.anchor.download, 255),
              source: "semantic-anchor"
            });
          }
          await client.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "none" });
          if (evaluated.dispatch === "click") {
            await client.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
            const release = client.send("Input.dispatchMouseEvent", {
              type: "mouseReleased", x, y, button: "left", clickCount: 1
            });
            const completion = await Promise.race([
              release.then(() => "released"),
              diagnostics.dialogOpened.then(() => "dialog")
            ]);
            if (completion === "dialog") {
              const dialog = session.pendingDialog;
              const dialogAction = String(input.dialogAction || "");
              if (dialogAction !== "accept" && dialogAction !== "dismiss") {
                await client.send("Page.handleJavaScriptDialog", { accept: false });
                session.pendingDialog = null;
                await release.catch(() => undefined);
                await appendDialogRecord(session, {
                  state: "dismissed-for-decision",
                  ...dialog
                });
                throw new BrowserAutomationError(
                  "DIALOG_RESPONSE_REQUIRED",
                  "点击触发了 JavaScript 弹窗；已安全取消，请根据弹窗内容携带 dialogAction 重试该点击",
                  { dialog }
                );
              }
              const promptText = dialogAction === "accept" && input.promptText != null
                ? String(input.promptText).slice(0, 4_000)
                : undefined;
              await client.send("Page.handleJavaScriptDialog", {
                accept: dialogAction === "accept",
                ...(promptText == null ? {} : { promptText })
              });
              session.pendingDialog = null;
              await release.catch(() => undefined);
              await appendDialogRecord(session, {
                state: dialogAction === "accept" ? "accepted" : "dismissed",
                ...dialog,
                promptTextLength: promptText?.length
              });
              return {
                performed: true,
                dispatch: evaluated.dispatch,
                dialog: {
                  type: dialog?.type,
                  message: dialog?.message,
                  response: dialogAction
                }
              };
            } else {
              await sleep(evaluated.anchor?.download ? 350 : 50);
            }
          }
          return { performed: true, dispatch: evaluated.dispatch, diagnosticEventCount: diagnosticEvents.length };
        }
        return evaluated;
      } finally {
        diagnostics.unsubscribe();
      }
    });
    if (result?.error) {
      throw new BrowserAutomationError(
        String(result.error.code || "ACTION_FAILED"),
        String(result.error.message || "浏览器元素动作失败"),
        { elementId, snapshotId }
      );
    }
    const action = await recordAction(session, {
      kind,
      snapshotId,
      elementId,
      targetId: session.targetId,
      targetTag: element.tag,
      targetRole: element.role,
      targetName: element.name,
      targetType: element.type,
      secure: Boolean(element.secure),
      riskLevel: element.riskLevel || "normal",
      valueLength: kind === "set-value" || kind === "type-text" ? value.length : undefined,
      result: sanitizeActionResult(result)
    });
    invalidateSnapshot(session);
    return action;
  });
}

export async function dragElement(sessionId, input) {
  return withSessionMutation(sessionId, async (session) => {
    assertAgentControl(session);
    const snapshotId = requiredString(input.snapshotId, "snapshotId");
    const sourceId = requiredString(input.sourceElementId, "sourceElementId");
    const targetId = requiredString(input.targetElementId, "targetElementId");
    const source = requireSnapshotElement(session, snapshotId, sourceId);
    const target = requireSnapshotElement(session, snapshotId, targetId);
    if (!source.actions?.includes("drag")) {
      throw new BrowserAutomationError("UNSUPPORTED_ACTION", `${sourceId} 不是可拖动元素`);
    }
    if (!target.actions?.includes("drop")) {
      throw new BrowserAutomationError("UNSUPPORTED_ACTION", `${targetId} 不是可放置元素`);
    }
    const result = await withTarget(session.cdpUrl, session.targetId, async (client) => {
      const html5Result = await evaluate(
        client,
        buildDomDragExpression(source.locatorId, target.locatorId)
      );
      if (!html5Result?.error) return html5Result;
      if (html5Result.error.code !== "UNSUPPORTED_ACTION") {
        throw new BrowserAutomationError(
          html5Result.error.code || "ACTION_FAILED",
          html5Result.error.message || "HTML5 拖放失败"
        );
      }
      const points = await evaluate(client, buildDragPointsExpression(source.locatorId, target.locatorId));
      if (points?.error) {
        throw new BrowserAutomationError(points.error.code || "STALE_SNAPSHOT", points.error.message || "拖放元素不可用");
      }
      return dispatchTrustedDrag(client, points.source, points.target);
    });
    const action = await recordAction(session, {
      kind: "drag",
      snapshotId,
      elementId: sourceId,
      targetElementId: targetId,
      targetId: session.targetId,
      targetName: source.name,
      dropTargetName: target.name,
      result: sanitizeActionResult(result)
    });
    invalidateSnapshot(session);
    return action;
  });
}

export async function uploadFile(sessionId, input) {
  return withSessionMutation(sessionId, async (session) => {
    assertAgentControl(session);
    const snapshotId = requiredString(input.snapshotId, "snapshotId");
    const elementId = requiredString(input.elementId, "elementId");
    const element = requireSnapshotElement(session, snapshotId, elementId);
    if (element.tag !== "input" || element.type !== "file" || !element.actions?.includes("upload-file")) {
      throw new BrowserAutomationError("UNSUPPORTED_ACTION", `${elementId} 不是文件上传控件`);
    }
    const requestedPaths = Array.isArray(input.filePaths) ? input.filePaths : [input.filePath];
    if (requestedPaths.length < 1 || requestedPaths.length > 20) {
      throw new BrowserAutomationError("INVALID_ARGUMENT", "单次上传文件数量必须在 1 到 20 之间");
    }
    const files = [];
    for (const requestedPath of requestedPaths) {
      files.push(await resolveAuthorizedUploadFile(session, requestedPath));
    }
    await withTarget(session.cdpUrl, session.targetId, async (client) => {
      const evaluated = await client.send("Runtime.evaluate", {
        expression: buildElementObjectExpression(element.locatorId),
        returnByValue: false,
        userGesture: true
      });
      const objectId = evaluated.result?.objectId;
      if (!objectId) throw new BrowserAutomationError("STALE_SNAPSHOT", "文件上传控件已重渲染，请重新 observe");
      try {
        const described = await client.send("DOM.describeNode", { objectId });
        const backendNodeId = described.node?.backendNodeId;
        if (!backendNodeId) throw new BrowserAutomationError("ACTION_FAILED", "无法定位文件上传控件");
        await client.send("DOM.setFileInputFiles", {
          files: files.map((file) => file.path),
          backendNodeId
        });
      } finally {
        await client.send("Runtime.releaseObject", { objectId }).catch(() => undefined);
      }
    });
    const action = await recordAction(session, {
      kind: "upload-file",
      snapshotId,
      elementId,
      targetId: session.targetId,
      targetName: element.name,
      fileCount: files.length,
      files: files.map((file) => ({ name: file.name, size: file.size })),
      result: { uploaded: true, fileCount: files.length }
    });
    invalidateSnapshot(session);
    return action;
  });
}

export async function navigate(sessionId, rawUrl) {
  return runPageMutation(sessionId, "navigate", { url: normalizeNavigationUrl(rawUrl) }, async (client, session, details) => {
    const result = await client.send("Page.navigate", { url: details.url });
    if (result.errorText) throw new BrowserAutomationError("NAVIGATION_FAILED", result.errorText);
    session.targetUrl = details.url;
    return { url: details.url, frameId: result.frameId };
  });
}

export async function goBack(sessionId) {
  return navigateHistory(sessionId, -1, "back");
}

export async function goForward(sessionId) {
  return navigateHistory(sessionId, 1, "forward");
}

export async function reload(sessionId) {
  return runPageMutation(sessionId, "reload", {}, async (client) => {
    await client.send("Page.reload", { ignoreCache: false });
    return { reloaded: true };
  });
}

export async function sendKey(sessionId, rawKey) {
  const chord = normalizeKeyChord(rawKey);
  return runPageMutation(sessionId, "key", { key: chord.label }, async (client) => {
    let modifiers = 0;
    for (const modifier of chord.modifiers) {
      modifiers |= modifier.mask;
      await client.send("Input.dispatchKeyEvent", {
        type: "keyDown",
        key: modifier.key,
        code: modifier.code,
        modifiers,
        windowsVirtualKeyCode: modifier.windowsVirtualKeyCode,
        nativeVirtualKeyCode: modifier.windowsVirtualKeyCode
      });
    }
    const base = {
      key: chord.key.key,
      code: chord.key.code,
      modifiers,
      windowsVirtualKeyCode: chord.key.windowsVirtualKeyCode,
      nativeVirtualKeyCode: chord.key.windowsVirtualKeyCode
    };
    await client.send("Input.dispatchKeyEvent", { type: "keyDown", ...base });
    if (modifiers === 0 && (chord.key.key.length === 1 || chord.key.key === " ")) {
      await client.send("Input.dispatchKeyEvent", {
        type: "char",
        ...base,
        text: chord.key.key,
        unmodifiedText: chord.key.key
      });
    }
    await client.send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
    for (const modifier of [...chord.modifiers].reverse()) {
      modifiers &= ~modifier.mask;
      await client.send("Input.dispatchKeyEvent", {
        type: "keyUp",
        key: modifier.key,
        code: modifier.code,
        modifiers,
        windowsVirtualKeyCode: modifier.windowsVirtualKeyCode,
        nativeVirtualKeyCode: modifier.windowsVirtualKeyCode
      });
    }
    return { key: chord.key.key, chord: chord.label };
  });
}

export async function scroll(sessionId, input) {
  const direction = String(input.direction || "down").toLowerCase();
  if (!new Set(["up", "down", "left", "right"]).has(direction)) {
    throw new BrowserAutomationError("INVALID_ARGUMENT", "direction 必须是 up/down/left/right");
  }
  const pages = clampNumber(input.pages, 0.1, 20, 1);
  return runPageMutation(sessionId, "scroll", { direction, pages }, async (client) => {
    const result = await evaluate(client, `(() => {
      const direction = ${JSON.stringify(direction)};
      const pages = ${JSON.stringify(pages)};
      const x = direction === "left" ? -innerWidth * pages : direction === "right" ? innerWidth * pages : 0;
      const y = direction === "up" ? -innerHeight * pages : direction === "down" ? innerHeight * pages : 0;
      scrollBy({ left: x, top: y, behavior: "instant" });
      return { scrollX, scrollY, x, y };
    })()`);
    return result;
  });
}

export async function screenshot(sessionId, fullPage = false) {
  return withSessionMutation(sessionId, async (session) => {
    assertActive(session);
    const sequence = session.screenshotCount + 1;
    const captured = await withTarget(session.cdpUrl, session.targetId, async (client, _target, transport) => ({
      screenshot: await captureScreenshot(client, session, sequence, fullPage),
      transport
    }));
    await appendEvent(session, "screenshot-captured", {
      screenshotPath: captured.screenshot.path,
      screenshotSequence: captured.screenshot.sequence,
      screenshotSha256: captured.screenshot.sha256,
      cdpConnectionId: captured.transport.connectionId,
      cdpConnectionReused: captured.transport.reused,
      fullPage: Boolean(fullPage)
    });
    return {
      sessionId: session.sessionId,
      targetId: session.targetId,
      screenshotPath: captured.screenshot.path,
      screenshotSequence: captured.screenshot.sequence,
      screenshotSha256: captured.screenshot.sha256,
      transport: {
        kind: "cdp",
        connectionId: captured.transport.connectionId,
        connectedAt: captured.transport.connectedAt,
        reused: captured.transport.reused
      },
      capturedAt: new Date().toISOString()
    };
  });
}

async function navigateHistory(sessionId, delta, kind) {
  return runPageMutation(sessionId, kind, {}, async (client) => {
    const history = await client.send("Page.getNavigationHistory");
    const entries = Array.isArray(history.entries) ? history.entries : [];
    const nextIndex = Number(history.currentIndex) + delta;
    const entry = entries[nextIndex];
    if (!entry) return { navigated: false, reason: delta < 0 ? "no-back-entry" : "no-forward-entry" };
    await client.send("Page.navigateToHistoryEntry", { entryId: entry.id });
    return { navigated: true, url: entry.url };
  });
}

async function runPageMutation(sessionId, kind, details, operation) {
  return withSessionMutation(sessionId, async (session) => {
    assertAgentControl(session);
    const result = await withTarget(session.cdpUrl, session.targetId, async (client) => operation(client, session, details));
    const action = await recordAction(session, {
      kind,
      targetId: session.targetId,
      ...details,
      result: sanitizeActionResult(result)
    });
    invalidateSnapshot(session);
    return action;
  });
}

async function captureScreenshot(client, session, sequence, fullPage) {
  let clip;
  if (fullPage) {
    const metrics = await client.send("Page.getLayoutMetrics");
    const size = metrics.cssContentSize || metrics.contentSize;
    if (size && Number(size.width) > 0 && Number(size.height) > 0) {
      clip = {
        x: 0,
        y: 0,
        width: Math.min(Number(size.width), 16_384),
        height: Math.min(Number(size.height), 16_384),
        scale: 1
      };
    }
  }
  const result = await client.send("Page.captureScreenshot", {
    format: "png",
    fromSurface: true,
    captureBeyondViewport: Boolean(clip),
    ...(clip ? { clip } : {})
  }, 30_000);
  if (!result.data) throw new BrowserAutomationError("CAPTURE_FAILED", "CDP 未返回截图数据");
  const fileName = `frame_${String(sequence).padStart(4, "0")}.png`;
  const filePath = path.join(session.artifactDir, "screenshots", fileName);
  const bytes = Buffer.from(result.data, "base64");
  await fs.writeFile(filePath, bytes, { mode: 0o600 });
  session.screenshotCount += 1;
  return {
    path: filePath,
    sequence,
    sha256: createHash("sha256").update(bytes).digest("hex")
  };
}

async function recordAction(session, input) {
  const action = {
    version: PROTOCOL_VERSION,
    actionId: `action-${randomUUID()}`,
    sessionId: session.sessionId,
    sequence: session.actionCount + 1,
    performedAt: new Date().toISOString(),
    ...input
  };
  session.actionCount += 1;
  await appendJsonLine(path.join(session.artifactDir, "streams", "actions.jsonl"), action);
  await appendEvent(session, "action-performed", {
    actionId: action.actionId,
    sequence: action.sequence,
    kind: action.kind,
    targetId: action.targetId,
    elementId: action.elementId,
    targetRole: action.targetRole,
    targetName: action.targetName,
    valueLength: action.valueLength
  });
  return action;
}

async function appendEvent(session, type, data = {}) {
  const event = {
    version: PROTOCOL_VERSION,
    sequence: session.eventCount + 1,
    sessionId: session.sessionId,
    type,
    timestamp: new Date().toISOString(),
    ...data
  };
  session.eventCount += 1;
  await appendJsonLine(path.join(session.artifactDir, "streams", "events.jsonl"), event);
  return event;
}

async function appendCaptureGap(session, reason, detail) {
  session.captureGapCount += 1;
  await appendJsonLine(path.join(session.artifactDir, "streams", "capture-gaps.jsonl"), {
    version: PROTOCOL_VERSION,
    sessionId: session.sessionId,
    timestamp: new Date().toISOString(),
    reason,
    detail
  });
}

async function writeManifest(session) {
  const manifest = {
    artifactKind: "browser-rep",
    schemaVersion: 1,
    runId: session.runId,
    browserRunId: session.sessionId,
    uiwardenSessionId: session.uiwardenSessionId,
    runtimeVersion: RUNTIME_VERSION,
    target: {
      cdpUrl: session.cdpUrl,
      targetId: session.targetId,
      title: session.targetTitle,
      url: session.targetUrl
    },
    targets: {
      allowedTargetIds: session.allowedTargetIds,
      discoveredTargetIds: session.discoveredTargetIds,
      relations: session.targetRelations
    },
    startedAt: session.startedAt,
    finishedAt: session.finishedAt,
    stopReason: session.stopReason,
    captureStopReason: session.stopReason,
    eventCount: session.eventCount,
    snapshotCount: session.snapshotSequence,
    actionCount: session.actionCount,
    screenshotCount: session.screenshotCount,
    captureGapCount: session.captureGapCount,
    consoleCount: session.consoleCount,
    pageErrorCount: session.pageErrorCount,
    downloadCount: session.downloadCount,
    dialogCount: session.dialogCount,
    targetCount: session.targetCount,
    captureStatus: session.captureGapCount > 0 ? "incomplete" : "complete"
  };
  await Promise.all([
    writeJson(path.join(session.artifactDir, "manifest.json"), manifest),
    fs.copyFile(path.join(SCHEMA_DIR, "manifest.schema.json"), path.join(session.artifactDir, "manifest.schema.json"))
  ]);
}

async function discoverRelatedTargets(session, targets) {
  session.allowedTargetIds = Array.isArray(session.allowedTargetIds) ? session.allowedTargetIds : [session.targetId];
  session.discoveredTargetIds = Array.isArray(session.discoveredTargetIds) ? session.discoveredTargetIds : [];
  session.targetRelations = session.targetRelations && typeof session.targetRelations === "object"
    ? session.targetRelations
    : {};
  const allowed = new Set(session.allowedTargetIds);
  const discovered = new Set(session.discoveredTargetIds);
  let expanded = true;
  while (expanded) {
    expanded = false;
    for (const target of targets) {
      if (target.type !== "page" || !target.targetId || allowed.has(target.targetId)) continue;
      const openerTargetId = target.openerId || target.parentTargetId;
      if (!openerTargetId || !allowed.has(openerTargetId)) continue;
      allowed.add(target.targetId);
      discovered.add(target.targetId);
      session.targetRelations[target.targetId] = {
        openerTargetId,
        discoveredAt: new Date().toISOString()
      };
      session.targetCount += 1;
      await appendJsonLine(path.join(session.artifactDir, "streams", "targets.jsonl"), {
        version: PROTOCOL_VERSION,
        sessionId: session.sessionId,
        timestamp: new Date().toISOString(),
        targetId: target.targetId,
        openerTargetId,
        title: boundedString(target.title, 500),
        url: boundedString(target.url, 2_000)
      });
      await appendEvent(session, "target-discovered", {
        targetId: target.targetId,
        openerTargetId,
        url: target.url,
        title: target.title
      });
      expanded = true;
    }
  }
  session.allowedTargetIds = [...allowed];
  session.discoveredTargetIds = [...discovered];
}

async function subscribeDiagnostics(client, session, collected) {
  let resolveDialog;
  const dialogOpened = new Promise((resolve) => {
    resolveDialog = resolve;
  });
  const unsubscriptions = [
    client.on("Runtime.consoleAPICalled", (params) => {
      void appendConsoleRecord(session, params)
        .then((record) => collected.push(record))
        .catch(() => undefined);
    }),
    client.on("Runtime.exceptionThrown", (params) => {
      void appendPageErrorRecord(session, params)
        .then((record) => collected.push(record))
        .catch(() => undefined);
    }),
    client.on("Page.javascriptDialogOpening", (params) => {
      const dialog = {
        type: boundedString(params.type, 50) || "alert",
        message: boundedString(params.message, 4_000),
        defaultPrompt: boundedString(params.defaultPrompt, 4_000),
        openedAt: new Date().toISOString()
      };
      session.pendingDialog = dialog;
      void appendDialogRecord(session, {
        state: "opened",
        ...dialog
      }).then((record) => {
        collected.push(record);
        resolveDialog(dialog);
      }).catch(() => resolveDialog(dialog));
    }),
    client.on("Browser.downloadWillBegin", (params) => {
      void appendDownloadRecord(session, {
        state: "will-begin",
        guid: boundedString(params.guid, 200),
        url: boundedString(params.url, 2_000),
        suggestedFilename: boundedString(params.suggestedFilename, 255),
        source: "cdp"
      }).then((record) => collected.push(record)).catch(() => undefined);
    }),
    client.on("Browser.downloadProgress", (params) => {
      void appendDownloadRecord(session, {
        state: boundedString(params.state, 50) || "progress",
        guid: boundedString(params.guid, 200),
        receivedBytes: finiteNumber(params.receivedBytes),
        totalBytes: finiteNumber(params.totalBytes),
        source: "cdp"
      }).then((record) => collected.push(record)).catch(() => undefined);
    })
  ];
  await Promise.all([
    client.send("Runtime.enable").catch(() => undefined),
    client.send("Page.enable").catch(() => undefined)
  ]);
  return {
    dialogOpened,
    unsubscribe: () => {
      for (const unsubscribe of unsubscriptions) unsubscribe();
    }
  };
}

async function prepareDownloadCapture(client, session) {
  const downloadDir = path.join(session.artifactDir, "downloads");
  await fs.mkdir(downloadDir, { recursive: true });
  await client.send("Browser.setDownloadBehavior", {
    behavior: "allow",
    downloadPath: downloadDir,
    eventsEnabled: true
  }).catch(async (error) => {
    await appendCaptureGap(session, "download-events-unavailable", boundedString(error?.message || error, 500));
  });
}

async function appendConsoleRecord(session, params) {
  const callFrame = params.stackTrace?.callFrames?.[0];
  const record = {
    version: PROTOCOL_VERSION,
    sessionId: session.sessionId,
    timestamp: new Date().toISOString(),
    level: boundedString(params.type, 50) || "log",
    text: (Array.isArray(params.args) ? params.args : [])
      .map(sanitizeRemoteObject)
      .filter(Boolean)
      .join(" ")
      .slice(0, 4_000),
    url: boundedString(callFrame?.url, 2_000),
    lineNumber: finiteNumber(callFrame?.lineNumber)
  };
  session.consoleCount += 1;
  await appendJsonLine(path.join(session.artifactDir, "streams", "console.jsonl"), record);
  return record;
}

async function appendPageErrorRecord(session, params) {
  const details = params.exceptionDetails || {};
  const record = {
    version: PROTOCOL_VERSION,
    sessionId: session.sessionId,
    timestamp: new Date().toISOString(),
    text: boundedString(details.exception?.description || details.text || "Page exception", 4_000),
    url: boundedString(details.url, 2_000),
    lineNumber: finiteNumber(details.lineNumber),
    columnNumber: finiteNumber(details.columnNumber)
  };
  session.pageErrorCount += 1;
  await appendJsonLine(path.join(session.artifactDir, "streams", "page-errors.jsonl"), record);
  return record;
}

async function appendDownloadRecord(session, input) {
  const record = {
    version: PROTOCOL_VERSION,
    sessionId: session.sessionId,
    timestamp: new Date().toISOString(),
    ...input
  };
  session.downloadCount += 1;
  await appendJsonLine(path.join(session.artifactDir, "streams", "downloads.jsonl"), record);
  return record;
}

async function appendDialogRecord(session, input) {
  const record = {
    version: PROTOCOL_VERSION,
    sessionId: session.sessionId,
    timestamp: new Date().toISOString(),
    ...input
  };
  if (input.state === "opened") session.dialogCount += 1;
  await appendJsonLine(path.join(session.artifactDir, "streams", "dialogs.jsonl"), record);
  return record;
}

function sanitizeRemoteObject(value) {
  if (!value || typeof value !== "object") return "";
  if (typeof value.value === "string") return boundedString(value.value, 1_000);
  if (["number", "boolean", "bigint"].includes(typeof value.value)) return String(value.value);
  return boundedString(value.description || value.className || value.type, 1_000);
}

function boundedString(value, limit) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, limit);
}

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function copySchemas(artifactDir) {
  const destination = path.join(artifactDir, "schemas");
  await fs.mkdir(destination, { recursive: true });
  await Promise.all(SCHEMA_FILES.map((name) => fs.copyFile(path.join(SCHEMA_DIR, name), path.join(destination, name))));
}

async function withSessionMutation(sessionId, operation) {
  const home = runtimeHome();
  return withFileLock(path.join(home, "locks", `session-${assertSessionId(sessionId)}.lock`), async () => {
    const session = await readSession(home, sessionId);
    const result = await operation(session);
    await writeSession(home, session);
    return result;
  });
}

function normalizeSessionCounters(session) {
  for (const field of [
    "eventCount",
    "snapshotSequence",
    "actionCount",
    "screenshotCount",
    "captureGapCount",
    "consoleCount",
    "pageErrorCount",
    "downloadCount",
    "dialogCount"
  ]) {
    if (!Number.isInteger(session[field]) || session[field] < 0) session[field] = 0;
  }
  if (!Number.isInteger(session.targetCount) || session.targetCount < 1) {
    session.targetCount = Math.max(1, Array.isArray(session.allowedTargetIds) ? session.allowedTargetIds.length : 1);
  }
}

async function readActiveSession(sessionId) {
  const session = await readSession(runtimeHome(), sessionId);
  assertActive(session);
  return session;
}

async function readJsonLines(filePath) {
  const content = await fs.readFile(filePath, "utf8").catch((error) => {
    if (error?.code === "ENOENT") return "";
    throw error;
  });
  return content
    .split(/\r?\n/)
    .filter(Boolean)
    .flatMap((line) => {
      try {
        const value = JSON.parse(line);
        return value && typeof value === "object" ? [value] : [];
      } catch {
        return [];
      }
    });
}

async function readSession(home, sessionId) {
  const safeId = assertSessionId(sessionId);
  let session;
  try {
    session = JSON.parse(await fs.readFile(path.join(home, "sessions", `${safeId}.json`), "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") throw new BrowserAutomationError("SESSION_NOT_FOUND", `浏览器会话不存在：${safeId}`, {}, 3);
    throw new BrowserAutomationError("STORAGE_CORRUPTED", `无法读取浏览器会话：${safeId}`);
  }
  if (session.version !== PROTOCOL_VERSION || session.sessionId !== safeId) {
    throw new BrowserAutomationError("STORAGE_CORRUPTED", `浏览器会话协议无效：${safeId}`);
  }
  normalizeSessionCounters(session);
  return session;
}

async function writeSession(home, session) {
  await ensureRuntimeDirs(home);
  await writeJson(path.join(home, "sessions", `${session.sessionId}.json`), session);
}

async function ensureRuntimeDirs(home) {
  await Promise.all([
    fs.mkdir(path.join(home, "sessions"), { recursive: true, mode: 0o700 }),
    fs.mkdir(path.join(home, "locks"), { recursive: true, mode: 0o700 }),
    fs.mkdir(path.join(home, "target-leases"), { recursive: true, mode: 0o700 })
  ]);
}

async function acquireTargetLease(home, cdpUrl, targetId, sessionId) {
  await ensureRuntimeDirs(home);
  const leasePath = targetLeasePath(home, cdpUrl, targetId);
  await withFileLock(`${leasePath}.lock`, async () => {
    try {
      const existing = JSON.parse(await fs.readFile(leasePath, "utf8"));
      if (existing.sessionId !== sessionId) {
        try {
          const owner = await readSession(home, String(existing.sessionId || ""));
          if (owner.state === "active") {
            throw new BrowserAutomationError("TARGET_BUSY", "该浏览器标签页已被另一个原子会话占用", { ownerSessionId: owner.sessionId });
          }
        } catch (error) {
          if (error instanceof BrowserAutomationError && error.code === "TARGET_BUSY") throw error;
        }
      }
    } catch (error) {
      if (error instanceof BrowserAutomationError) throw error;
      if (error?.code !== "ENOENT" && error instanceof SyntaxError) {
        throw new BrowserAutomationError("STORAGE_CORRUPTED", "浏览器 target 租约文件损坏");
      }
    }
    await writeJson(leasePath, { sessionId, cdpUrl, targetId, acquiredAt: new Date().toISOString() });
  });
}

async function releaseTargetLease(home, cdpUrl, targetId, sessionId) {
  const leasePath = targetLeasePath(home, cdpUrl, targetId);
  await withFileLock(`${leasePath}.lock`, async () => {
    try {
      const lease = JSON.parse(await fs.readFile(leasePath, "utf8"));
      if (lease.sessionId === sessionId) await fs.rm(leasePath, { force: true });
    } catch {
      // A missing lease is safe during idempotent shutdown.
    }
  });
}

function targetLeasePath(home, cdpUrl, targetId) {
  const key = createHash("sha256").update(`${cdpUrl}\n${targetId}`).digest("hex");
  return path.join(home, "target-leases", `${key}.json`);
}

async function withFileLock(lockPath, operation) {
  const deadline = Date.now() + 5_000;
  while (true) {
    try {
      await fs.mkdir(lockPath);
      break;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const stat = await fs.stat(lockPath).catch(() => null);
      if (stat && Date.now() - stat.mtimeMs > 30_000) {
        await fs.rm(lockPath, { recursive: true, force: true });
        continue;
      }
      if (Date.now() >= deadline) throw new BrowserAutomationError("SESSION_BUSY", "浏览器会话正在执行另一个原子命令");
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  try {
    return await operation();
  } finally {
    await fs.rm(lockPath, { recursive: true, force: true });
  }
}

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await fs.rename(temporary, filePath);
  await fs.chmod(filePath, 0o600).catch(() => undefined);
}

async function appendJsonLine(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.appendFile(filePath, `${JSON.stringify(value)}\n`, { encoding: "utf8", mode: 0o600 });
  await fs.chmod(filePath, 0o600).catch(() => undefined);
}

async function createPrivateFile(filePath) {
  await fs.writeFile(filePath, "", { encoding: "utf8", mode: 0o600, flag: "a" });
  await fs.chmod(filePath, 0o600).catch(() => undefined);
}

function publicSession(session) {
  const {
    currentSnapshot: _currentSnapshot,
    lastObservedSnapshot: _lastObservedSnapshot,
    ...publicValue
  } = session;
  return publicValue;
}

function invalidateSnapshot(session) {
  session.currentSnapshotId = null;
  session.currentSnapshot = null;
}

function resetObservationBaseline(session) {
  session.lastObservedSnapshot = null;
}

function stableElementId(stableKey) {
  return `web-${createHash("sha256").update(String(stableKey || "")).digest("hex").slice(0, 16)}`;
}

function buildObservationChanges(previous, current) {
  if (!previous || previous.targetId !== current.targetId) {
    return {
      baseline: true,
      added: current.elements,
      updated: [],
      removedElementIds: [],
      text: { changed: true, addedLines: textLines(current.text), removedLines: [], truncated: false }
    };
  }
  const previousById = new Map(previous.elements.map((element) => [element.elementId, element]));
  const currentById = new Map(current.elements.map((element) => [element.elementId, element]));
  const added = [];
  const updated = [];
  for (const element of current.elements) {
    const before = previousById.get(element.elementId);
    if (!before) {
      added.push(element);
    } else if (elementSemanticSignature(before) !== elementSemanticSignature(element)) {
      updated.push(element);
    }
  }
  const removedElementIds = previous.elements
    .filter((element) => !currentById.has(element.elementId))
    .map((element) => element.elementId);
  return {
    baseline: false,
    added,
    updated,
    removedElementIds,
    text: buildTextChanges(previous.text, current.text)
  };
}

function summarizeObservationChanges(changes) {
  return {
    baseline: changes.baseline,
    addedElementIds: changes.added.map((element) => element.elementId),
    updatedElementIds: changes.updated.map((element) => element.elementId),
    removedElementIds: changes.removedElementIds,
    text: changes.text
  };
}

function elementSemanticSignature(element) {
  const { rect: _rect, ...semantic } = element;
  return JSON.stringify(semantic);
}

function buildTextChanges(previousText, currentText) {
  if (previousText === currentText) {
    return { changed: false, addedLines: [], removedLines: [], truncated: false };
  }
  const previousLines = new Set(textLines(previousText));
  const currentLines = new Set(textLines(currentText));
  const added = [...currentLines].filter((line) => !previousLines.has(line));
  const removed = [...previousLines].filter((line) => !currentLines.has(line));
  const limit = 120;
  return {
    changed: true,
    addedLines: added.slice(0, limit),
    removedLines: removed.slice(0, limit),
    truncated: added.length > limit || removed.length > limit
  };
}

function textLines(value) {
  return String(value || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function diffProjection(snapshot, changes, baselineSnapshotId) {
  const changedElements = [...changes.added, ...changes.updated];
  return {
    ...snapshot,
    projection: "diff",
    baseline: false,
    baselineSnapshotId,
    text: changes.text.addedLines.join("\n"),
    elements: changedElements,
    removedElementIds: changes.removedElementIds,
    diffTruncated: changes.text.truncated
  };
}

function assertActive(session) {
  if (session.state !== "active") {
    throw new BrowserAutomationError("SESSION_STOPPED", `浏览器会话已经结束：${session.sessionId}`, { stopReason: session.stopReason }, 3);
  }
}

function assertAgentControl(session) {
  assertActive(session);
  if (session.controlMode === "human-control") {
    throw new BrowserAutomationError("HUMAN_CONTROL_ACTIVE", "用户正在接管浏览器，Agent 动作已暂停");
  }
  if (session.controlMode !== "agent-control") {
    throw new BrowserAutomationError("OBSERVE_ONLY", "当前浏览器会话仅允许观察");
  }
}

function assertSessionId(value) {
  const sessionId = String(value || "");
  if (!SESSION_ID_PATTERN.test(sessionId)) throw new BrowserAutomationError("INVALID_ARGUMENT", "无效的浏览器会话 ID");
  return sessionId;
}

function requiredString(value, name) {
  const result = String(value || "").trim();
  if (!result) throw new BrowserAutomationError("INVALID_ARGUMENT", `${name} 不能为空`);
  return result;
}

function normalizeControlMode(value) {
  const mode = String(value || "");
  if (!CONTROL_MODES.has(mode)) throw new BrowserAutomationError("INVALID_ARGUMENT", `无效控制模式：${mode}`);
  return mode;
}

function normalizeReason(value) {
  return String(value || "unknown").trim().slice(0, 160) || "unknown";
}

function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

function requireSnapshotElement(session, snapshotId, elementId) {
  const current = session.currentSnapshot;
  if (!current || session.currentSnapshotId !== snapshotId || current.snapshotId !== snapshotId || current.targetId !== session.targetId) {
    throw new BrowserAutomationError("STALE_SNAPSHOT", "快照已失效，请重新 observe");
  }
  const element = current.elements.find((item) => item.elementId === elementId);
  if (!element) throw new BrowserAutomationError("ELEMENT_NOT_FOUND", `快照中不存在元素：${elementId}`);
  return element;
}

async function dispatchTrustedDrag(client, source, target) {
  for (const point of [source, target]) {
    if (!Number.isFinite(Number(point?.x)) || !Number.isFinite(Number(point?.y))) {
      throw new BrowserAutomationError("ACTION_FAILED", "拖放元素没有可用的指针位置");
    }
  }
  let mousePressed = false;
  await client.send("Input.setInterceptDrags", { enabled: true }, 3_000);
  try {
    const intercepted = waitForCdpEvent(client, "Input.dragIntercepted", 3_000);
    await client.send("Input.dispatchMouseEvent", {
      type: "mouseMoved", x: source.x, y: source.y, button: "none"
    });
    await client.send("Input.dispatchMouseEvent", {
      type: "mousePressed", x: source.x, y: source.y, button: "left", buttons: 1, clickCount: 1
    });
    mousePressed = true;
    for (let step = 1; step <= 6; step += 1) {
      const ratio = step / 6;
      await client.send("Input.dispatchMouseEvent", {
        type: "mouseMoved",
        x: source.x + (target.x - source.x) * ratio,
        y: source.y + (target.y - source.y) * ratio,
        button: "left",
        buttons: 1
      });
    }
    const drag = await intercepted;
    if (!drag?.data) throw new BrowserAutomationError("ACTION_FAILED", "CDP 未返回拖放数据");
    for (const type of ["dragEnter", "dragOver", "drop"]) {
      await client.send("Input.dispatchDragEvent", {
        type,
        x: target.x,
        y: target.y,
        data: drag.data
      });
    }
    await client.send("Input.dispatchMouseEvent", {
      type: "mouseReleased", x: target.x, y: target.y, button: "left", buttons: 0, clickCount: 1
    });
    mousePressed = false;
    return { performed: true, dispatch: "trusted-drag" };
  } finally {
    if (mousePressed) {
      await client.send("Input.dispatchMouseEvent", {
        type: "mouseReleased", x: target.x, y: target.y, button: "left", buttons: 0, clickCount: 1
      }).catch(() => undefined);
    }
    await client.send("Input.setInterceptDrags", { enabled: false }, 1_000).catch(() => undefined);
  }
}

function waitForCdpEvent(client, method, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      unsubscribe();
      reject(new BrowserAutomationError("CDP_TIMEOUT", `${method} 超时`));
    }, timeoutMs);
    const unsubscribe = client.on(method, (params) => {
      clearTimeout(timer);
      unsubscribe();
      resolve(params);
    });
  });
}

async function normalizeUploadRoots(rawRoots, artifactRoot) {
  const candidates = [
    ...(Array.isArray(rawRoots) ? rawRoots : rawRoots ? [rawRoots] : []),
    artifactRoot
  ];
  const roots = [];
  for (const candidate of candidates) {
    const resolved = path.resolve(requiredString(candidate, "uploadRoot"));
    const real = await fs.realpath(resolved).catch(() => resolved);
    if (!roots.includes(real)) roots.push(real);
  }
  return roots;
}

async function resolveAuthorizedUploadFile(session, rawPath) {
  const requested = requiredString(rawPath, "filePath");
  if (!path.isAbsolute(requested)) {
    throw new BrowserAutomationError("UPLOAD_PATH_NOT_ALLOWED", "上传文件必须使用绝对路径");
  }
  const directStat = await fs.lstat(requested).catch(() => null);
  if (!directStat) throw new BrowserAutomationError("UPLOAD_FILE_NOT_FOUND", `上传文件不存在：${path.basename(requested)}`);
  if (directStat.isSymbolicLink()) {
    throw new BrowserAutomationError("UPLOAD_PATH_NOT_ALLOWED", "禁止上传符号链接");
  }
  const realPath = await fs.realpath(requested);
  const roots = Array.isArray(session.uploadRoots) ? session.uploadRoots : [session.artifactDir];
  if (!roots.some((root) => isPathInside(root, realPath))) {
    throw new BrowserAutomationError("UPLOAD_PATH_NOT_ALLOWED", "上传文件不在当前任务授权的 workspace 中");
  }
  const stat = await fs.stat(realPath);
  if (!stat.isFile()) throw new BrowserAutomationError("UPLOAD_PATH_NOT_ALLOWED", "上传目标必须是普通文件");
  if (stat.size > MAX_UPLOAD_FILE_BYTES) {
    throw new BrowserAutomationError("UPLOAD_FILE_TOO_LARGE", `单个上传文件不能超过 ${MAX_UPLOAD_FILE_BYTES / 1024 / 1024} MB`);
  }
  return { path: realPath, name: path.basename(realPath), size: stat.size };
}

function isPathInside(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function normalizeKeyChord(rawValue) {
  const raw = requiredString(rawValue, "key");
  const tokens = raw.split("+").map((item) => item.trim()).filter(Boolean);
  if (tokens.length === 0 || tokens.length > 5) {
    throw new BrowserAutomationError("INVALID_ARGUMENT", `不支持的组合键：${raw}`);
  }
  const keyToken = tokens.pop();
  const modifiers = [];
  const seen = new Set();
  for (const token of tokens) {
    const modifier = KEY_MODIFIERS.get(token.toLowerCase());
    if (!modifier) throw new BrowserAutomationError("INVALID_ARGUMENT", `不支持的修饰键：${token}`);
    if (seen.has(modifier.mask)) throw new BrowserAutomationError("INVALID_ARGUMENT", `重复的修饰键：${token}`);
    seen.add(modifier.mask);
    modifiers.push(modifier);
  }
  const key = normalizeKey(keyToken);
  return {
    modifiers,
    key,
    label: [...modifiers.map((modifier) => modifier.key), key.key].join("+")
  };
}

function normalizeKey(rawValue) {
  const raw = requiredString(rawValue, "key");
  const normalized = raw.toLowerCase().replace(/\s+/g, "");
  const alias = KEY_ALIASES.get(normalized);
  if (alias) return alias;
  if ([...raw].length === 1 && !/[\u0000-\u001f\u007f]/.test(raw)) {
    const upper = raw.toUpperCase();
    return { key: raw, code: /^[a-z]$/i.test(raw) ? `Key${upper}` : "", windowsVirtualKeyCode: upper.charCodeAt(0) };
  }
  throw new BrowserAutomationError("INVALID_ARGUMENT", `不支持的按键：${raw}`);
}

function sanitizeActionResult(value) {
  if (!value || typeof value !== "object") return value;
  const copy = { ...value };
  delete copy.value;
  return copy;
}
