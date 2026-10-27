import { initDnsOverride } from "./dnsOverride.js";
initDnsOverride();

let serverStartupComplete = false;

// Keep failures from fire-and-forget inspection/regression work scoped to the
// affected task. Finalization hooks and child processes may fail after the
// primary task error; those failures must not terminate an already-ready server.
process.on("unhandledRejection", (reason) => {
  const err = reason instanceof Error ? reason : new Error(String(reason));
  console.error(`[fatal-guard] unhandledRejection（已捕获，${serverStartupComplete ? "进程继续存活" : "启动失败"}）:`, err.stack || err.message);
  exitOnStartupFailure();
});
process.on("uncaughtException", (error) => {
  console.error(`[fatal-guard] uncaughtException（已捕获，${serverStartupComplete ? "进程继续存活" : "启动失败"}）:`, error.stack || error.message);
  exitOnStartupFailure();
});

function exitOnStartupFailure(): void {
  if (serverStartupComplete) return;
  console.error("[fatal-guard] 服务尚未完成启动，将退出并交由桌面运行时或进程管理器处理");
  process.exitCode = 1;
  setImmediate(() => process.exit(1));
}

import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import express from "express";
import cors from "cors";
import { isAllowedRequestOrigin } from "./requestOrigin.js";
import multer from "multer";
import { c as createTar } from "tar";
import { randomUUID } from "node:crypto";
import { dataDir, projectRoot } from "./paths.js";
import {
  addUploadedFiles,
  appendMessage,
  createMessage,
  createSession,
  deleteSession,
  ensureStorage,
  listSessionSummaries,
  loadSession,
  refreshArtifacts,
  sessionDir,
  updateSessionBrowserKernel,
  uploadsDir
} from "./storage.js";
import { moveUploadedFiles, prepareWorkspace } from "./workspace.js";
import { runAgentForSession, runAgentTurn, sendSse } from "./agent.js";
import { abortSessionRun, isSessionActivelyRunning } from "./sessionRuntime.js";
import { isDesktopMode, webUiOperationTargetError } from "./runtimeMode.js";
import { checkAllDependencies, restorePersistedPython, type DepId } from "./depsCheck.js";
import { repairDependency } from "./depsRepair.js";
import { getSkillEnvView, patchUserSkillEnv, saveUserSkillEnv } from "./skillEnvStore.js";
import { diagnoseLatestBrowserRep, latestBrowserRep } from "./embeddedBrowser.js";
import { getDefectIntegrationCapabilities } from "./defectIntegration.js";
import { getQualityDashboard, getUnifiedQualityRun, listUnifiedQualityRuns } from "./qualityDomain.js";
import {
  createEvaluationTemplateXlsx,
  normalizeEvaluationSuite,
  parseEvaluationSuiteFile
} from "./evaluationLabDomain.js";
import {
  deleteEvaluationSuite,
  ensureEvaluationLabStorage,
  evaluationReportFile,
  listEvaluationRuns,
  listEvaluationSuites,
  loadEvaluationRun,
  loadEvaluationSuite,
  readEvaluationEvents,
  saveEvaluationSuite
} from "./evaluationLabStore.js";
import {
  abortEvaluationExperiment,
  listEvaluationPlans,
  loadEvaluationPlan,
  recoverEvaluationExperiments,
  refreshEvaluationReports,
  removeEvaluationExperiment,
  removeEvaluationPlan,
  resumeEvaluationExperiment,
  rerunEvaluationCase,
  rerunEvaluationExperiment,
  startEvaluationPlan,
  startEvaluationExperiment,
  upsertEvaluationPlan
} from "./evaluationLabService.js";
import {
  getEvaluationTargetServiceStatuses,
  startEvaluationTargetService,
  stopEvaluationTargetService
} from "./evaluationBenchService.js";
import {
  deleteUiOperationTask,
  ensureUiOperationStorage,
  listUiOperationTasks,
  loadUiOperationTask,
  upsertUiOperationTask
} from "./uiOperationStore.js";
import {
  abortUiOperation,
  clickUiOperationNativePictureInPicture,
  approveUiOperation,
  controlUiOperationNativeRun,
  createUiOperationConversation,
  getUiOperationBrowserScreenshot,
  getUiOperationBrowserState,
  getUiOperationNativeScreenshot,
  getUiOperationNativeState,
  observeUiOperationNativeState,
  rejectUiOperation,
  sendUiOperationMessage,
  startUiOperation
} from "./uiOperationService.js";
import {
  applyNativeAutomationTransportSetting,
  getNativeAutomationStatus,
  getNativeAutomationTransportStatus,
  isSupportedNativeProvider,
  listNativeAutomationApps,
  openNativeAutomationPermissionSettings,
  recoverOrphanedNativeAutomationSessions
} from "./nativeAutomation.js";
import { recoverOrphanedBrowserAutomationSessions } from "./browserAutomation.js";
import {
  BROWSER_PROFILES,
  BROWSER_ENV_KEYS,
  detectLocalBrowsers,
  resolveConfiguredSessionKernel,
  validateConfiguredBrowserProfile
} from "./browserProfiles.js";
import {
  activateCdpTab,
  clearSelectedTab,
  createCdpTaskGroup,
  discoverCdpBrowsers,
  getCdpStatus,
  getCdpTaskGroupCapability,
  getSelectedTargetId,
  newCdpTab,
  openCdpTaskGroupExtensionSetup,
  resolveCdpBrowserOption,
  startCdpBrowser,
  stopCdpBrowser
} from "./cdpManager.js";
import {
  createBrowserExtensionPairing,
  EXTENSION_BRIDGE_CDP_PATH,
  getBrowserExtensionBridgeStatus,
  installBrowserExtensionBridge,
  listBrowserExtensionCdpTargets,
  revealBrowserExtensionDir,
  renderBrowserExtensionPairingPage
} from "./browserExtensionBridge.js";
import {
  reconcileStuckRuns,
  registerActiveInspectionRun,
  unregisterActiveInspectionRun,
  registerActiveRegressionBatch,
  unregisterActiveRegressionBatch
} from "./recovery.js";
import {
  buildInspectionPrompt,
  createInspectionRun,
  createInspectionTask,
  deleteInspectionTask,
  ensureInspectionStorage,
  finishInspectionRun,
  getPublicInspectionTask,
  listInspectionTasks,
  loadInspectionTask,
  rescheduleInspectionTask,
  updateInspectionTask
} from "./inspections.js";
import type { ExecutionRuntimeId, InspectionRunTrigger, NotifyStatus } from "./types.js";
import type { RegressionBatch } from "./types.js";
import {
  applyStoredHosts,
  buildEnvironmentPrompt,
  deleteBusinessEnvironment,
  deleteHostEntry,
  ensureConfigStorage,
  getBusinessEnvironment,
  getGuiRuntimeSettings,
  listBusinessEnvironments,
  listHostEntries,
  updateGuiRuntimeSettings,
  upsertBusinessEnvironment,
  upsertHostEntry
} from "./configStore.js";
import {
  activateModelProfile,
  clearActiveModelProfile,
  deleteModelProfile,
  listModelProfiles,
  ModelProfileValidationError,
  selectExecutionRuntime,
  selectRuntimeModel,
  testModelProfileInputConnection,
  upsertModelProfile
} from "./modelStore.js";
import {
  detectRuntimeConfiguredModel,
  invalidateRuntimeModelCatalog,
  listExecutionRuntimeStatuses,
  listRuntimeModelCatalog
} from "./executionRuntime.js";
import {
  abortRegressionBatch,
  buildRegressionPrompt,
  createRegressionBatch,
  deleteRegressionCase,
  deleteRegressionModule,
  deleteRegressionBatch,
  ensureRegressionStorage,
  getRegressionCases,
  listRegressionBatches,
  listRegressionCases,
  listRegressionModules,
  loadRegressionBatch,
  saveRegressionBatch,
  updateRegressionRun,
  upsertRegressionCase,
  upsertRegressionModule
} from "./regressionStore.js";
import { getDatabase, getDatabaseSync, runtimeStatusDict } from "./db/index.js";
import { repairSchema } from "./db/migrate.js";
import { migrateLegacyData } from "./db/migrateLegacy.js";
import { taskLimiter, getConcurrencyStatus } from "./concurrency.js";
import {
  deleteDingtalkRobot,
  listDingtalkRobots,
  testDingtalkRobot,
  upsertDingtalkRobot,
  notifyInspectionResult,
  notifyRegressionResult
} from "./notifyStore.js";
import { resolveSessionUploadLimits } from "./uploadLimits.js";
import { isHtmlPreviewPath, untrustedPreviewHeaders } from "./previewSecurity.js";
import { resolveContainedRegularFile } from "./safeFilePath.js";

const app = express();
const upload = multer({
  dest: path.join(dataDir, "tmp"),
  limits: resolveSessionUploadLimits()
});
const evaluationUpload = multer({
  storage: multer.memoryStorage(),
  limits: { files: 1, fileSize: 5 * 1024 * 1024, fields: 4, fieldSize: 16 * 1024 }
});
const port = Number(process.env.PORT ?? 8787);
const host = process.env.HOST ?? "127.0.0.1";

/**
 * Public base URL used to build shareable links embedded in DingTalk
 * notifications (e.g. "查看详情" pointing at the regression batch detail page).
 *
 * Defaults to http://127.0.0.1:8787 — override with UI_AGENT_PUBLIC_URL when
 * deploying behind a domain/reverse proxy so notification recipients can
 * actually reach the app.
 */
function getPublicBaseUrl(): string {
  const raw = (process.env.UI_AGENT_PUBLIC_URL ?? "").trim().replace(/\/+$/, "");
  if (raw) return raw;
  // Fall back to the loopback address matching the dev server so local runs
  // still produce clickable links.
  return `http://127.0.0.1:${port}`;
}

/** Build a full shareable URL for a regression batch result page. */
function buildBatchResultUrl(batchId: string): string {
  return `${getPublicBaseUrl()}/regression/batches/${encodeURIComponent(batchId)}`;
}

/** Build a full shareable URL for a single regression run (test result) inside a batch. */
function buildRunResultUrl(batchId: string, runId: string): string {
  return `${getPublicBaseUrl()}/regression/batches/${encodeURIComponent(batchId)}/runs/${encodeURIComponent(runId)}`;
}

/** Build a full shareable URL for an inspection task detail page. */
function buildInspectionResultUrl(taskId: string): string {
  return `${getPublicBaseUrl()}/inspections/${encodeURIComponent(taskId)}`;
}

const allowedOrigins = (process.env.UI_AGENT_ALLOWED_ORIGINS ?? "")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);
app.use((req, res, next) => {
  if (isAllowedRequestOrigin(req.get("origin"), req.get("host"), allowedOrigins)) return next();
  res.status(403).json({ error: "Origin is not allowed" });
});
if (allowedOrigins.length) {
  app.use(cors({ origin: allowedOrigins }));
}
app.use(express.json({ limit: "2mb" }));

// server 产物版本（随根 package.json），桌面客户端用它识别端口上的旧版残留 server。
const serverVersion = (() => {
  try {
    return (JSON.parse(fsSync.readFileSync(path.join(projectRoot, "package.json"), "utf8")) as { version?: string }).version ?? "unknown";
  } catch {
    return "unknown";
  }
})();

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, desktop: isDesktopMode(), version: serverVersion });
});

// Expose the configured public base URL so the front-end can build shareable
// links client-side (e.g. copy-to-clipboard buttons) without duplicating the
// UI_AGENT_PUBLIC_URL env logic.
app.get("/api/public-url", (_req, res) => {
  res.json({ baseUrl: getPublicBaseUrl() });
});

// 巡检/回归共享并发限流状态（对话任务不受影响）。
app.get("/api/concurrency-status", (_req, res) => {
  res.json(getConcurrencyStatus());
});

// ---------------------------------------------------------------------------
// 统一质量领域：只做现有数据的应用层投影，不新增或迁移数据库表。
// ---------------------------------------------------------------------------
app.get("/api/quality/dashboard", async (_req, res, next) => {
  try {
    res.json(await getQualityDashboard());
  } catch (error) {
    next(error);
  }
});

app.get("/api/quality/runs", async (req, res, next) => {
  try {
    const limit = Number(req.query.limit) || 300;
    res.json(await listUnifiedQualityRuns(limit));
  } catch (error) {
    next(error);
  }
});

// ---------------------------------------------------------------------------
// 评测实验室：评测集导入、UI 操作跑批、确定性评分和报告中心。
// ---------------------------------------------------------------------------
app.get("/api/evaluation-lab/suites", async (_req, res, next) => {
  try {
    res.json(await listEvaluationSuites());
  } catch (error) {
    next(error);
  }
});

app.get("/api/evaluation-lab/target-services", async (req, res) => {
  try {
    const runId = String(req.query.runId ?? "").trim();
    const suite = runId
      ? (await loadEvaluationRun(runId)).suiteSnapshot
      : await loadEvaluationSuite(String(req.query.suiteId ?? ""));
    res.json(await getEvaluationTargetServiceStatuses(suite));
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.post("/api/evaluation-lab/target-services/:id/start", async (req, res) => {
  try {
    const runId = String(req.body?.runId ?? "").trim();
    const suite = runId
      ? (await loadEvaluationRun(runId)).suiteSnapshot
      : await loadEvaluationSuite(String(req.body?.suiteId ?? ""));
    res.json(await startEvaluationTargetService(suite, req.params.id));
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.post("/api/evaluation-lab/target-services/:id/stop", async (req, res) => {
  try {
    const runId = String(req.body?.runId ?? "").trim();
    const suite = runId
      ? (await loadEvaluationRun(runId)).suiteSnapshot
      : await loadEvaluationSuite(String(req.body?.suiteId ?? ""));
    res.json(await stopEvaluationTargetService(suite, req.params.id));
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.post("/api/evaluation-lab/suites", async (req, res) => {
  try {
    res.status(201).json(await saveEvaluationSuite(normalizeEvaluationSuite(req.body ?? {})));
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.post("/api/evaluation-lab/suites/import", evaluationUpload.single("file"), async (req, res) => {
  try {
    if (!req.file?.buffer) {
      res.status(400).json({ error: "请选择 JSON 或 XLSX 评测集文件" });
      return;
    }
    const suite = parseEvaluationSuiteFile(req.file.buffer, req.file.originalname);
    res.status(201).json(await saveEvaluationSuite(suite));
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.delete("/api/evaluation-lab/suites/:id", async (req, res, next) => {
  try {
    await deleteEvaluationSuite(req.params.id);
    res.status(204).end();
  } catch (error) {
    next(error);
  }
});

app.get("/api/evaluation-lab/templates/:format", (_req, res) => {
  const format = _req.params.format;
  if (format === "xlsx") {
    res.type("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", 'attachment; filename="uiwarden-evaluation-template.xlsx"');
    res.send(createEvaluationTemplateXlsx());
    return;
  }
  if (format === "json") {
    res.type("application/json");
    res.setHeader("Content-Disposition", 'attachment; filename="uiwarden-evaluation-template.json"');
    res.send(JSON.stringify({
      schemaVersion: "1.0",
      name: "UI 操作评测集",
      description: "浏览器与电脑桌面 benchmark 示例",
      cases: [
        {
          id: "browser-search-001",
          name: "百度搜索杭州天气",
          category: "浏览器搜索",
          compatibleTargets: ["browser"],
          instruction: "打开 https://www.baidu.com，搜索杭州今天天气",
          targetUrl: "https://www.baidu.com",
          tags: ["browser", "search", "smoke"],
          timeoutMs: 30 * 60 * 1000,
          enabled: true,
          passThreshold: 70,
          assertions: [
            { id: "completed", label: "执行完成", evaluator: "run-completed", weight: 40, required: true, params: {} },
            { id: "result", label: "结果包含杭州天气", evaluator: "summary-contains", weight: 60, required: true, params: { terms: ["杭州", "天气"], matchMode: "all" } }
          ]
        }
      ]
    }, null, 2));
    return;
  }
  res.status(404).json({ error: "模板仅支持 json 或 xlsx" });
});

app.get("/api/evaluation-lab/plans", async (_req, res, next) => {
  try {
    res.json(await listEvaluationPlans());
  } catch (error) {
    next(error);
  }
});

app.post("/api/evaluation-lab/plans", async (req, res) => {
  try {
    res.status(201).json(await upsertEvaluationPlan(req.body ?? {}));
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.put("/api/evaluation-lab/plans/:id", async (req, res) => {
  try {
    res.json(await upsertEvaluationPlan({ ...(req.body ?? {}), id: req.params.id }));
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.delete("/api/evaluation-lab/plans/:id", async (req, res, next) => {
  try {
    await removeEvaluationPlan(req.params.id);
    res.status(204).end();
  } catch (error) {
    next(error);
  }
});

app.post("/api/evaluation-lab/plans/:id/runs", async (req, res) => {
  try {
    res.status(202).json(await startEvaluationPlan(req.params.id, req.body ?? {}));
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.get("/api/evaluation-lab/runs", async (req, res, next) => {
  try {
    res.json(await listEvaluationRuns(Number(req.query.limit) || 100));
  } catch (error) {
    next(error);
  }
});

app.post("/api/evaluation-lab/runs", async (req, res) => {
  try {
    res.status(202).json(await startEvaluationExperiment(req.body ?? {}));
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.get("/api/evaluation-lab/runs/:id", async (req, res, next) => {
  try {
    res.json(await loadEvaluationRun(req.params.id));
  } catch (error) {
    next(error);
  }
});

app.delete("/api/evaluation-lab/runs/:id", async (req, res) => {
  try {
    await removeEvaluationExperiment(req.params.id);
    res.status(204).end();
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.post("/api/evaluation-lab/runs/:id/abort", async (req, res, next) => {
  try {
    res.json(await abortEvaluationExperiment(req.params.id));
  } catch (error) {
    next(error);
  }
});

app.post("/api/evaluation-lab/runs/:id/rerun", async (req, res) => {
  try {
    res.status(202).json(await rerunEvaluationExperiment(req.params.id));
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.post("/api/evaluation-lab/runs/:id/resume", async (req, res) => {
  try {
    res.status(202).json(await resumeEvaluationExperiment(req.params.id));
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.post("/api/evaluation-lab/runs/:id/cases/:caseRunId/rerun", async (req, res) => {
  try {
    res.status(202).json(await rerunEvaluationCase(req.params.id, req.params.caseRunId));
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.post("/api/evaluation-lab/runs/:id/report/refresh", async (req, res, next) => {
  try {
    res.json(await refreshEvaluationReports(req.params.id));
  } catch (error) {
    next(error);
  }
});

app.get("/api/evaluation-lab/runs/:id/cases/:caseRunId/events", async (req, res, next) => {
  try {
    const run = await loadEvaluationRun(req.params.id);
    if (!run.caseRuns.some((item) => item.id === req.params.caseRunId)) {
      res.status(404).json({ error: "评测样本不存在" });
      return;
    }
    res.json(await readEvaluationEvents(run.id, req.params.caseRunId, Number(req.query.limit) || 500));
  } catch (error) {
    next(error);
  }
});

app.get("/api/evaluation-lab/runs/:id/evidence/*", async (req, res, next) => {
  try {
    const run = await loadEvaluationRun(req.params.id);
    if (!run.reportPaths) {
      res.status(409).json({ error: "评测尚未结束，证据还未生成" });
      return;
    }
    const reportRoot = path.dirname(evaluationReportFile(run.id, "json"));
    const requested = decodeURIComponent(
      req.path.split(`/api/evaluation-lab/runs/${run.id}/`)[1] ?? ""
    );
    const evidencePath = path.resolve(reportRoot, requested);
    if (!requested.startsWith("evidence/") || !isInside(reportRoot, evidencePath)) {
      res.status(403).json({ error: "非法证据路径" });
      return;
    }
    const safeEvidencePath = await resolveContainedRegularFile(reportRoot, evidencePath);
    if (!safeEvidencePath) {
      res.status(404).json({ error: "评测证据不存在" });
      return;
    }
    setPreviewSecurityHeaders(res, isHtmlPreviewPath(safeEvidencePath));
    res.sendFile(safeEvidencePath);
  } catch (error) {
    next(error);
  }
});

app.get("/api/evaluation-lab/runs/:id/report.:format", async (req, res, next) => {
  try {
    const format = req.params.format;
    if (format !== "json" && format !== "html" && format !== "zip") {
      res.status(404).json({ error: "报告仅支持 json、html 或 zip" });
      return;
    }
    const run = await loadEvaluationRun(req.params.id);
    if (!run.reportPaths) {
      res.status(409).json({ error: "评测尚未结束，报告还未生成" });
      return;
    }
    const reportPath = evaluationReportFile(run.id, format);
    if (format === "html" && req.query.inline === "true") {
      setPreviewSecurityHeaders(res, true);
      res.type("text/html").sendFile(reportPath);
      return;
    }
    res.download(reportPath, `${run.suiteName}-${run.id}.${format}`);
  } catch (error) {
    next(error);
  }
});

app.get("/api/integrations/defects/capabilities", (_req, res) => {
  res.json(getDefectIntegrationCapabilities());
});

// ---------------------------------------------------------------------------
// 通用 UI 操作：与测试用例/测试结论隔离，复用浏览器和 Agent 执行基础设施。
// ---------------------------------------------------------------------------
app.get("/api/ui-operations", async (_req, res, next) => {
  try {
    res.json(await listUiOperationTasks());
  } catch (error) {
    next(error);
  }
});

app.post("/api/ui-operations", async (req, res, next) => {
  try {
    if (!uiOperationTargetAllowed(req.body, res)) {
      return;
    }
    res.status(201).json(await upsertUiOperationTask(req.body ?? {}));
  } catch (error) {
    next(error);
  }
});

app.post("/api/ui-operations/conversations", async (req, res, next) => {
  try {
    if (!uiOperationTargetAllowed(req.body, res)) return;
    res.status(201).json(await createUiOperationConversation(req.body ?? {}));
  } catch (error) {
    next(error);
  }
});

app.post("/api/ui-operations/messages", async (req, res) => {
  if (!uiOperationTargetAllowed(req.body, res)) return;
  await streamUiOperationMessage(undefined, req.body, res);
});

app.post("/api/ui-operations/:id/messages", async (req, res) => {
  try {
    const task = await loadUiOperationTask(req.params.id);
    if (!uiOperationTargetAllowed({ executionTarget: task.executionTarget }, res)) return;
    await streamUiOperationMessage(task.id, req.body, res);
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.put("/api/ui-operations/:id", async (req, res, next) => {
  try {
    if (!uiOperationTargetAllowed(req.body, res)) {
      return;
    }
    res.json(await upsertUiOperationTask({ ...(req.body ?? {}), id: req.params.id }));
  } catch (error) {
    next(error);
  }
});

app.delete("/api/ui-operations/:id", async (req, res, next) => {
  try {
    const task = await loadUiOperationTask(req.params.id);
    if (task.runs.some((run) => run.status === "running" || run.status === "waiting-approval")) {
      res.status(409).json({ error: "存在未结束运行，不能删除 UI 操作任务" });
      return;
    }
    const ownedSessionIds = new Set([
      task.conversationSessionId,
      ...task.runs.map((run) => run.sessionId)
    ].filter((sessionId): sessionId is string => Boolean(sessionId)));
    await deleteUiOperationTask(req.params.id);
    for (const sessionId of ownedSessionIds) {
      if (isSessionActivelyRunning(sessionId)) continue;
      await deleteSession(sessionId).catch((error) => {
        console.error(`[ui-operation] Failed to delete owned session ${sessionId}`, error);
      });
    }
    res.status(204).end();
  } catch (error) {
    next(error);
  }
});

app.post("/api/ui-operations/:id/runs", async (req, res, next) => {
  try {
    const task = await loadUiOperationTask(req.params.id);
    if (!uiOperationTargetAllowed({ executionTarget: task.executionTarget }, res)) return;
    res.status(202).json(await startUiOperation(req.params.id));
  } catch (error) {
    next(error);
  }
});

async function streamUiOperationMessage(
  taskId: string | undefined,
  body: Record<string, unknown> | undefined,
  res: express.Response
): Promise<void> {
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();
  try {
    await sendUiOperationMessage(
      {
        ...(body ?? {}),
        taskId,
        message: String(body?.message ?? "")
      },
      (payload) => sendSse(res, payload)
    );
  } catch (error) {
    sendSse(res, { type: "error", data: error instanceof Error ? error.message : String(error) });
    sendSse(res, { type: "done" });
  } finally {
    if (!res.destroyed && !res.writableEnded) res.end();
  }
}

app.post("/api/ui-operations/:id/runs/:runId/approve", async (req, res, next) => {
  try {
    res.status(202).json(await approveUiOperation(req.params.id, req.params.runId));
  } catch (error) {
    next(error);
  }
});

app.post("/api/ui-operations/:id/runs/:runId/reject", async (req, res, next) => {
  try {
    res.json(await rejectUiOperation(req.params.id, req.params.runId));
  } catch (error) {
    next(error);
  }
});

app.post("/api/ui-operations/:id/runs/:runId/abort", async (req, res, next) => {
  try {
    res.json(await abortUiOperation(req.params.id, req.params.runId));
  } catch (error) {
    next(error);
  }
});

app.get("/api/ui-operations/:id/runs/:runId/native", async (req, res, next) => {
  try {
    res.json(await getUiOperationNativeState(req.params.id, req.params.runId));
  } catch (error) {
    next(error);
  }
});

app.get("/api/ui-operations/:id/runs/:runId/browser", async (req, res, next) => {
  try {
    res.json(await getUiOperationBrowserState(req.params.id, req.params.runId));
  } catch (error) {
    next(error);
  }
});

app.get("/api/ui-operations/:id/runs/:runId/browser/screenshot", async (req, res, next) => {
  try {
    const rawSequence = Number(req.query.sequence);
    const screenshot = await getUiOperationBrowserScreenshot(
      req.params.id,
      req.params.runId,
      Number.isInteger(rawSequence) && rawSequence > 0 ? rawSequence : undefined
    );
    if (!screenshot) {
      res.status(404).json({ error: "当前浏览器运行尚未产生页面截图" });
      return;
    }
    res.setHeader("Cache-Control", "no-store");
    setPreviewSecurityHeaders(res, false);
    res.setHeader("X-UIWarden-Snapshot-Sequence", String(screenshot.sequence));
    res.setHeader("X-UIWarden-Snapshot-Captured-At", screenshot.capturedAt);
    res.sendFile(screenshot.path);
  } catch (error) {
    next(error);
  }
});

app.get("/api/ui-operations/:id/runs/:runId/native/screenshot", async (req, res, next) => {
  try {
    const screenshot = await getUiOperationNativeScreenshot(req.params.id, req.params.runId);
    if (!screenshot) {
      res.status(404).json({ error: "当前原生运行尚未产生桌面截图" });
      return;
    }
    res.setHeader("Cache-Control", "no-store");
    setPreviewSecurityHeaders(res, false);
    res.setHeader("X-UIWarden-Snapshot-Sequence", String(screenshot.sequence));
    res.setHeader("X-UIWarden-Snapshot-Captured-At", screenshot.capturedAt);
    res.sendFile(screenshot.path);
  } catch (error) {
    next(error);
  }
});

app.post("/api/ui-operations/:id/runs/:runId/native/observe", async (req, res, next) => {
  try {
    res.json(await observeUiOperationNativeState(req.params.id, req.params.runId));
  } catch (error) {
    next(error);
  }
});

app.post("/api/ui-operations/:id/runs/:runId/native/control", async (req, res, next) => {
  try {
    const mode = req.body?.mode;
    if (mode !== "agent-control" && mode !== "human-control") {
      res.status(400).json({ error: "无效的原生控制模式" });
      return;
    }
    res.json(await controlUiOperationNativeRun(req.params.id, req.params.runId, mode));
  } catch (error) {
    next(error);
  }
});

app.post("/api/ui-operations/:id/runs/:runId/native/pip-click", async (req, res, next) => {
  try {
    res.json(await clickUiOperationNativePictureInPicture(
      req.params.id,
      req.params.runId,
      {
        xRatio: Number(req.body?.xRatio),
        yRatio: Number(req.body?.yRatio)
      }
    ));
  } catch (error) {
    next(error);
  }
});

// 原生桌面自动化作用于当前 server 所在主机；Web 部署应置于认证网关后。
app.get("/api/native-automation/status", async (_req, res, next) => {
  try {
    res.json(await getNativeAutomationStatus());
  } catch (error) {
    next(error);
  }
});

app.get("/api/native-automation/apps", async (req, res, next) => {
  try {
    const providerId = String(req.query.provider || "").trim();
    if (!isSupportedNativeProvider(providerId)) {
      res.status(400).json({ error: "不支持的原生自动化 Provider" });
      return;
    }
    if (!isDesktopMode() && providerId !== "mock") {
      res.status(403).json({ error: "Web 部署只提供服务器 Mock Provider；真实桌面应用发现需要 UIWarden 客户端" });
      return;
    }
    res.json(await listNativeAutomationApps(providerId));
  } catch (error) {
    next(error);
  }
});

app.post("/api/native-automation/permissions/open", async (req, res, next) => {
  try {
    if (!isDesktopMode()) {
      res.status(403).json({ error: "Web 服务器不能打开访问者电脑的系统权限设置" });
      return;
    }
    const permission = req.body?.permission;
    if (permission !== "accessibility" && permission !== "screen-recording") {
      res.status(400).json({ error: "无效的权限类型" });
      return;
    }
    await openNativeAutomationPermissionSettings(permission);
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

app.get("/api/db-status", async (_req, res) => {
  try {
    const runtime = getDatabaseSync();
    res.json(runtimeStatusDict(runtime));
  } catch (error) {
    res.status(500).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
  }
});

// ---------------------------------------------------------------------------
// 桌面客户端：依赖环境检测 / 一键修复（web 部署下修复禁用，仅返回检测结果）
// ---------------------------------------------------------------------------
const DEP_IDS: DepId[] = [
  "cfuse-cli",
  "codex-cli",
  "dtcoder-cli",
  "claude-cli",
  "python",
  "browser-use",
  "playwright-chromium",
  "playwright-firefox",
  "chrome"
];

app.get("/api/deps", async (_req, res, next) => {
  try {
    res.json({ desktop: isDesktopMode(), deps: await checkAllDependencies() });
  } catch (error) {
    next(error);
  }
});

app.post("/api/deps/:id/repair", async (req, res) => {
  const depId = req.params.id as DepId;
  if (!DEP_IDS.includes(depId)) {
    res.status(404).json({ error: `未知依赖项：${req.params.id}` });
    return;
  }
  if (!isDesktopMode()) {
    res.status(403).json({ error: "一键修复仅在桌面客户端本地模式可用" });
    return;
  }
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive"
  });
  try {
    await repairDependency(depId, res);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    res.write(`event: error\ndata: ${JSON.stringify({ message })}\n\n`);
    res.end();
  }
});

// ---------------------------------------------------------------------------
// 桌面客户端：ui-test-assistant-skill config/.env 用户配置（用户覆盖层，
// 保存后下一次 agent 执行（对话/巡检/回归）prepareWorkspace 时生效）
// ---------------------------------------------------------------------------
app.get("/api/skill-env", async (req, res, next) => {
  try {
    const reveal = String(req.query.reveal ?? "") === "1";
    res.json({ entries: await getSkillEnvView(reveal) });
  } catch (error) {
    next(error);
  }
});

app.put("/api/skill-env", async (req, res, next) => {
  try {
    const entries = req.body?.entries;
    if (!Array.isArray(entries)) {
      res.status(400).json({ error: "请求体需要 entries 数组" });
      return;
    }
    const result = await saveUserSkillEnv(entries);
    if (!result.ok) {
      res.status(400).json({ error: result.error });
      return;
    }
    res.json({ ok: true, savedKeys: result.savedKeys });
  } catch (error) {
    next(error);
  }
});

app.get("/api/gui-runtime-settings", async (_req, res, next) => {
  try {
    const [settings, transport] = await Promise.all([
      getGuiRuntimeSettings(),
      getNativeAutomationTransportStatus()
    ]);
    res.json({ ...settings, transport });
  } catch (error) {
    next(error);
  }
});

app.put("/api/gui-runtime-settings", async (req, res, next) => {
  let previous: Awaited<ReturnType<typeof getGuiRuntimeSettings>> | undefined;
  try {
    previous = await getGuiRuntimeSettings();
    const requestedMode = req.body?.cliCompatibilityMode;
    if (
      typeof requestedMode === "boolean"
      && requestedMode !== previous.cliCompatibilityMode
    ) {
      const tasks = await listUiOperationTasks();
      const activeGuiTask = tasks.find((task) => (
        task.runs.some((run) => run.status === "running" || run.status === "waiting-approval")
      ));
      if (activeGuiTask) {
        res.status(409).json({
          error: `UI 操作“${activeGuiTask.name}”正在执行，结束后才能切换 GUI Runtime 传输`
        });
        return;
      }
    }
    const settings = await updateGuiRuntimeSettings({
      cliCompatibilityMode: requestedMode
    });
    const transport = await applyNativeAutomationTransportSetting();
    res.json({ ...settings, transport });
  } catch (error) {
    if (previous) {
      await updateGuiRuntimeSettings({
        cliCompatibilityMode: previous.cliCompatibilityMode
      }).catch(() => undefined);
      await applyNativeAutomationTransportSetting().catch(() => undefined);
    }
    next(error);
  }
});

// ---------------------------------------------------------------------------
// 桌面客户端：browser-use 浏览器配置（内置 profile 枚举 + 本机浏览器探测）。
// 浏览器选择通过 skill-env 的 BU_BROWSER_TYPE / BU_*_PATH 持久化到用户覆盖层。
// ---------------------------------------------------------------------------
app.get("/api/browser-profiles", async (_req, res, next) => {
  try {
    const envView = await getSkillEnvView(false);
    const browserEnv = new Map(envView.map((entry) => [entry.key, entry.value]));
    res.json({
      profiles: BROWSER_PROFILES,
      envKeys: BROWSER_ENV_KEYS,
      detected: await detectLocalBrowsers(),
      configurationError: validateConfiguredBrowserProfile(browserEnv)
    });
  } catch (error) {
    next(error);
  }
});

app.post("/api/browser-profiles/select", async (req, res, next) => {
  try {
    const executablePath = String(req.body?.path || "").trim();
    const browser = (await detectLocalBrowsers()).find((candidate) => candidate.path === executablePath);
    if (!browser) {
      res.status(400).json({ error: "所选浏览器已不可用，请重新检测" });
      return;
    }
    if (browser.kind !== "firefox") {
      res.status(400).json({ error: "该快捷入口仅用于 Firefox Profile" });
      return;
    }
    const result = await patchUserSkillEnv([
      { key: BROWSER_ENV_KEYS.browserType, value: "firefox", description: "browser-use 浏览器 profile" },
      { key: BROWSER_ENV_KEYS.firefoxPath, value: browser.path, description: "Firefox 可执行文件路径" }
    ]);
    if (!result.ok) {
      res.status(400).json({ error: result.error });
      return;
    }
    res.json({ ok: true, browserKernel: "skill-profile", browser });
  } catch (error) {
    next(error);
  }
});

// ---------------------------------------------------------------------------
// 桌面客户端：本地 CDP 浏览器生命周期（启动/关闭/状态/tab 枚举与激活）。
// CDP 会话（kind=cdp）执行时 quick --cdp 附着该浏览器复用登录态。
// ---------------------------------------------------------------------------
function uiOperationTargetAllowed(body: unknown, res: express.Response): boolean {
  if (isDesktopMode()) return true;
  const target = body && typeof body === "object"
    ? (body as { executionTarget?: { kind?: string; browserKernel?: string; providerId?: string } }).executionTarget
    : undefined;
  const error = webUiOperationTargetError(target);
  if (error) {
    res.status(403).json({ error });
    return false;
  }
  return true;
}

app.get("/api/cdp/status", async (_req, res, next) => {
  try {
    res.json(await getCdpStatus());
  } catch (error) {
    next(error);
  }
});

app.get("/api/cdp/browsers", async (_req, res, next) => {
  try {
    res.json(await discoverCdpBrowsers());
  } catch (error) {
    next(error);
  }
});

app.get("/api/cdp/extension-bridge/status", async (_req, res, next) => {
  try {
    if (!isDesktopMode()) {
      res.status(403).json({ error: "用户浏览器扩展桥仅支持 UIWarden 桌面客户端" });
      return;
    }
    res.json(await getBrowserExtensionBridgeStatus());
  } catch (error) {
    next(error);
  }
});

app.post("/api/cdp/extension-bridge/pair", async (req, res, next) => {
  try {
    if (!isDesktopMode()) {
      res.status(403).json({ error: "用户浏览器扩展桥仅支持 UIWarden 桌面客户端" });
      return;
    }
    const origin = `${req.protocol}://${req.get("host")}`;
    res.status(201).json(await createBrowserExtensionPairing(origin));
  } catch (error) {
    next(error);
  }
});

app.post("/api/cdp/extension-bridge/reveal", async (_req, res, next) => {
  try {
    if (!isDesktopMode()) {
      res.status(403).json({ error: "用户浏览器扩展桥仅支持 UIWarden 桌面客户端" });
      return;
    }
    res.json(await revealBrowserExtensionDir());
  } catch (error) {
    next(error);
  }
});

app.get("/browser-extension-pair", async (req, res, next) => {
  try {
    if (!isDesktopMode()) {
      res.status(403).send("用户浏览器扩展桥仅支持 UIWarden 桌面客户端");
      return;
    }
    res.type("html").send(renderBrowserExtensionPairingPage(String(req.query.token || ""), `${req.protocol}://${req.get("host")}`));
  } catch (error) {
    next(error);
  }
});

app.get(`${EXTENSION_BRIDGE_CDP_PATH}/json/list`, async (req, res, next) => {
  try {
    if (!isDesktopMode()) {
      res.status(403).json({ error: "用户浏览器扩展桥仅支持 UIWarden 桌面客户端" });
      return;
    }
    res.json(await listBrowserExtensionCdpTargets(`${req.protocol}://${req.get("host")}`));
  } catch (error) {
    next(error);
  }
});

app.get(`${EXTENSION_BRIDGE_CDP_PATH}/json/activate/:targetId`, async (req, res, next) => {
  try {
    if (!isDesktopMode()) {
      res.status(403).json({ error: "用户浏览器扩展桥仅支持 UIWarden 桌面客户端" });
      return;
    }
    await activateCdpTab(req.params.targetId);
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

app.get("/api/cdp/task-groups/capability", async (_req, res, next) => {
  try {
    res.json(await getCdpTaskGroupCapability());
  } catch (error) {
    next(error);
  }
});

app.post("/api/cdp/task-groups/setup", async (_req, res, next) => {
  try {
    if (!isDesktopMode()) {
      res.status(403).json({ error: "任务标签组扩展安装引导仅支持 UIWarden 桌面客户端" });
      return;
    }
    res.json(await openCdpTaskGroupExtensionSetup());
  } catch (error) {
    next(error);
  }
});

app.post("/api/cdp/task-groups", async (req, res, next) => {
  try {
    if (!isDesktopMode()) {
      res.status(403).json({ error: "用户浏览器任务标签组仅支持 UIWarden 桌面客户端" });
      return;
    }
    res.status(201).json(await createCdpTaskGroup(String(req.body?.title || "UIWarden Task")));
  } catch (error) {
    next(error);
  }
});

app.post("/api/cdp/start", async (req, res, next) => {
  try {
    const requestedBrowserId = typeof req.body?.browserId === "string" ? req.body.browserId.trim() : "";
    let selection = requestedBrowserId ? await resolveCdpBrowserOption(requestedBrowserId) : undefined;
    if (requestedBrowserId && !selection) {
      res.status(400).json({ error: "所选 CDP 浏览器已不可用，请重新检测" });
      return;
    }
    if (selection
      && selection.action !== "launch-cdp"
      && selection.action !== "connect-cdp"
      && selection.action !== "connect-extension") {
      res.status(400).json({ error: "该浏览器需要先切换执行内核，不能作为 Chromium CDP 启动" });
      return;
    }
    let browserPath: string | undefined =
      typeof req.body?.browserPath === "string" && req.body.browserPath ? req.body.browserPath : undefined;
    if (!selection && !browserPath) {
      const discovery = await discoverCdpBrowsers();
      selection = discovery.browsers.find((browser) => browser.id === discovery.defaultBrowserId);
    }
    browserPath = browserPath ?? selection?.path;
    const status = await startCdpBrowser({
      transport: selection?.source === "extension-bridge" ? "extension" : "cdp",
      port: selection?.source === "running-cdp" ? selection.port : undefined,
      browserPath,
      browserName: selection?.name,
      browserId: selection?.id,
      reuseExisting: selection?.source === "running-cdp",
      initialUrl: typeof req.body?.initialUrl === "string" && req.body.initialUrl ? req.body.initialUrl : undefined
    });
    res.status(status.running ? 200 : 502).json(status);
  } catch (error) {
    next(error);
  }
});

// 新建空白标签页（可选指定初始 URL）。返回新 tab 信息，供 UI 标记「当前受控标签页」。
app.post("/api/cdp/tabs", async (req, res, next) => {
  try {
    const url = typeof req.body?.url === "string" && req.body.url ? req.body.url : undefined;
    res.json(await newCdpTab(url));
  } catch (error) {
    next(error);
  }
});

app.post("/api/cdp/stop", async (_req, res, next) => {
  try {
    res.json(await stopCdpBrowser());
  } catch (error) {
    next(error);
  }
});

app.post("/api/cdp/tabs/:targetId/activate", async (req, res, next) => {
  try {
    await activateCdpTab(req.params.targetId);
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

// 中断运行中的 agent run（CDP/普通会话通用）。供客户端「停止任务」按钮调用。
app.post("/api/sessions/:id/stop", async (req, res, next) => {
  try {
    const session = await loadSession(req.params.id);
    const stopped = abortSessionRun(session.id);
    res.json({ stopped, message: stopped ? "已发出停止信号，任务将在当前步骤后退出" : "该会话当前没有运行中的任务" });
  } catch (error) {
    next(error);
  }
});

// 设置/清除 CDP 目标标签页（UI tab 下拉切换时调用，含切回「默认活动标签页」）。
app.post("/api/cdp/selected-tab", async (req, res, next) => {
  try {
    const targetId = typeof req.body?.targetId === "string" && req.body.targetId ? req.body.targetId : "";
    if (targetId) {
      await activateCdpTab(targetId); // activateCdpTab 内部记录 selectedTargetId
    } else {
      clearSelectedTab();
    }
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

// In-memory recent log buffer for debugging without kubectl
const recentLogs: string[] = [];
const MAX_LOGS = 500;
const origConsoleLog = console.log;
const origConsoleError = console.error;
console.log = (...args: unknown[]) => {
  const line = args.map(String).join(" ");
  recentLogs.push(line);
  if (recentLogs.length > MAX_LOGS) recentLogs.shift();
  origConsoleLog(...args);
};
console.error = (...args: unknown[]) => {
  const line = "[ERROR] " + args.map(String).join(" ");
  recentLogs.push(line);
  if (recentLogs.length > MAX_LOGS) recentLogs.shift();
  origConsoleError(...args);
};

app.get("/api/logs", (_req, res) => {
  const tail = Number(_req.query.tail) || 100;
  res.type("text/plain; charset=utf-8").send(recentLogs.slice(-tail).join("\n"));
});

app.get("/api/sessions", async (_req, res, next) => {
  try {
    // P0：列表只返回会话元信息（不含全量 messages/artifacts），正文由 GET :id 按需拉。
    const [sessions, operationTasks] = await Promise.all([
      listSessionSummaries(),
      listUiOperationTasks()
    ]);
    const operationSessionIds = new Set(operationTasks.flatMap((task) => [
      task.conversationSessionId,
      ...task.runs.map((run) => run.sessionId)
    ].filter((sessionId): sessionId is string => Boolean(sessionId))));
    res.json(sessions.filter((session) => !operationSessionIds.has(session.id)));
  } catch (error) {
    next(error);
  }
});

app.post("/api/sessions", async (req, res, next) => {
  try {
    const requestedKernel = req.body?.browserKernel;
    if (requestedKernel != null && !["playwright", "skill-profile", "external-cdp", "uiwarden-embedded"].includes(requestedKernel)) {
      res.status(400).json({ error: "测试任务不支持该浏览器内核" });
      return;
    }
    let browserKernel = requestedKernel === "skill-profile" || requestedKernel === "external-cdp" || requestedKernel === "uiwarden-embedded"
      ? requestedKernel
      : req.body?.kind === "cdp" ? "external-cdp" : undefined;
    if (!browserKernel) {
      const envView = await getSkillEnvView(false);
      browserKernel = resolveConfiguredSessionKernel(Object.fromEntries(envView.map((entry) => [entry.key, entry.value])));
    }
    if (browserKernel === "skill-profile") {
      const envView = await getSkillEnvView(false);
      const profileError = validateConfiguredBrowserProfile(new Map(envView.map((entry) => [entry.key, entry.value])));
      if (profileError) {
        res.status(400).json({ error: profileError });
        return;
      }
    }
    const session = await createSession(req.body?.title, browserKernel, req.body?.kind === "cdp" ? "cdp" : undefined);
    await prepareWorkspace(session.workspacePath, { executionRuntimeId: session.executionRuntimeId });
    res.status(201).json(session);
  } catch (error) {
    next(error);
  }
});

app.patch("/api/sessions/:id/browser-kernel", async (req, res, next) => {
  try {
    const session = await loadSession(req.params.id);
    if (isSessionActivelyRunning(session.id)) {
      res.status(409).json({ error: "任务运行中不能切换浏览器内核" });
      return;
    }
    const browserKernel = req.body?.browserKernel;
    if (browserKernel !== "playwright" && browserKernel !== "skill-profile" && browserKernel !== "external-cdp" && browserKernel !== "uiwarden-embedded") {
      res.status(400).json({ error: "无效的 browserKernel" });
      return;
    }
    if (browserKernel === "skill-profile") {
      const envView = await getSkillEnvView(false);
      const profileError = validateConfiguredBrowserProfile(new Map(envView.map((entry) => [entry.key, entry.value])));
      if (profileError) {
        res.status(400).json({ error: profileError });
        return;
      }
    }
    res.json(await updateSessionBrowserKernel(session.id, browserKernel));
  } catch (error) {
    next(error);
  }
});

app.post("/api/sessions/:id/browser-artifacts/diagnose", async (req, res, next) => {
  try {
    const session = await loadSession(req.params.id);
    const result = await diagnoseLatestBrowserRep(session);
    res.json({ ok: true, ...result, artifacts: await refreshArtifacts(session.id) });
  } catch (error) {
    next(error);
  }
});

app.get("/api/sessions/:id/browser-artifacts/download", async (req, res, next) => {
  try {
    const session = await loadSession(req.params.id);
    const { runId, repDir } = await latestBrowserRep(session);
    const archivePath = path.join(sessionDir(session.id), `browser-rep-${runId}.tgz`);
    const entries = [path.relative(session.workspacePath, repDir)];
    const liveLog = path.join(session.workspacePath, ".skill-output", "uiwarden-live.log");
    if (fsSync.existsSync(liveLog)) entries.push(path.relative(session.workspacePath, liveLog));
    await createTar({ gzip: true, cwd: session.workspacePath, file: archivePath }, entries);
    res.download(archivePath, `${session.title || session.id}-browser-rep-${runId}.tgz`);
  } catch (error) {
    next(error);
  }
});

app.get("/api/sessions/:id", async (req, res, next) => {
  try {
    res.json(await loadSession(req.params.id));
  } catch (error) {
    next(error);
  }
});

app.delete("/api/sessions/:id", async (req, res, next) => {
  try {
    await loadSession(req.params.id);
    if (isSessionActivelyRunning(req.params.id)) {
      res.status(409).json({ error: "当前会话正在运行，不能删除" });
      return;
    }
    await deleteSession(req.params.id);
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

app.get("/api/sessions/:id/artifacts", async (req, res, next) => {
  try {
    res.json(await refreshArtifacts(req.params.id));
  } catch (error) {
    next(error);
  }
});

app.get("/api/sessions/:id/artifacts/download", async (req, res, next) => {
  try {
    const session = await loadSession(req.params.id);
    const archivePath = path.join(sessionDir(session.id), `artifacts-${Date.now()}.tgz`);
    const roots = [".skill-output", "reports", "output", "outputs", "artifacts", "uploads"];
    const existingRoots: string[] = [];
    let hasAnyFile = false;
    for (const root of roots) {
      const rootPath = path.join(session.workspacePath, root);
      if (!fsSync.existsSync(rootPath)) {
        continue;
      }
      existingRoots.push(root);
      // walk to detect at least one real file under this root
      if (!hasAnyFile) {
        const stack = [rootPath];
        while (stack.length) {
          const current = stack.pop()!;
          let entries: fsSync.Dirent[];
          try {
            entries = fsSync.readdirSync(current, { withFileTypes: true });
          } catch {
            entries = [];
          }
          for (const entry of entries) {
            const full = path.join(current, entry.name);
            if (entry.isFile()) {
              hasAnyFile = true;
              break;
            }
            if (entry.isDirectory()) {
              stack.push(full);
            }
          }
          if (hasAnyFile) {
            break;
          }
        }
      }
    }
    if (!existingRoots.length || !hasAnyFile) {
      res.status(404).json({ error: "暂无可下载产物（该执行未生成任何产物文件）" });
      return;
    }
    await createTar(
      {
        gzip: true,
        cwd: session.workspacePath,
        file: archivePath,
        noDirRecurse: false
      },
      existingRoots
    );
    res.download(archivePath, `${session.title || session.id}-artifacts.tgz`);
  } catch (error) {
    next(error);
  }
});

app.get("/api/sessions/:id/preview/*", async (req, res, next) => {
  try {
    const session = await loadSession(req.params.id);
    const requested = decodeURIComponent(
      req.path.split(`/api/sessions/${session.id}/preview/`)[1] ?? ""
    );
    const fullPath = path.resolve(session.workspacePath, requested);
    if (!isInside(session.workspacePath, fullPath)) {
      res.status(403).json({ error: "非法路径" });
      return;
    }
    const safeFullPath = await resolveContainedRegularFile(session.workspacePath, fullPath);
    if (!safeFullPath) {
      res.status(404).json({ error: "该产物不是可预览文件" });
      return;
    }
    const stat = await fs.stat(safeFullPath);
    if (isTextPreviewFile(safeFullPath)) {
      const maxPreviewBytes = 5 * 1024 * 1024;
      const content = stat.size > maxPreviewBytes
        ? `文件大小为 ${stat.size} bytes，超过 5 MB 预览上限，请下载后查看。`
        : await fs.readFile(safeFullPath, "utf8");
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      setPreviewSecurityHeaders(res, true);
      res.send(renderTextPreview(path.basename(safeFullPath), content));
      return;
    }
    setPreviewSecurityHeaders(res, isHtmlPreviewPath(safeFullPath));
    res.setHeader("Content-Type", previewContentType(safeFullPath));
    res.setHeader("Content-Disposition", `inline; filename="${encodeURIComponent(path.basename(safeFullPath))}"`);
    res.sendFile(safeFullPath);
  } catch (error) {
    next(error);
  }
});

app.get("/api/sessions/:id/files/*", async (req, res, next) => {
  try {
    const session = await loadSession(req.params.id);
    const requested = decodeURIComponent(
      req.path.split(`/api/sessions/${session.id}/files/`)[1] ?? ""
    );
    const fullPath = path.resolve(session.workspacePath, requested);
    if (!isInside(session.workspacePath, fullPath)) {
      res.status(403).json({ error: "非法路径" });
      return;
    }
    const safeFullPath = await resolveContainedRegularFile(session.workspacePath, fullPath);
    if (!safeFullPath) {
      res.status(404).json({ error: "该产物不是可下载文件" });
      return;
    }
    res.download(safeFullPath);
  } catch (error) {
    next(error);
  }
});

app.post("/api/sessions/:id/messages", upload.array("files"), async (req, res, next) => {
  try {
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders?.();

    const session = await loadSession(req.params.id);
    if (isSessionActivelyRunning(session.id)) {
      sendSse(res, { type: "error", data: "当前会话已有任务正在运行" });
      sendSse(res, { type: "done" });
      res.end();
      return;
    }

    const envContext = buildEnvironmentPrompt(
      await getBusinessEnvironment(String(req.body?.businessId ?? "")),
      {
        url: String(req.body?.customUrl ?? ""),
        username: String(req.body?.customUsername ?? ""),
        password: String(req.body?.customPassword ?? "")
      }
    );
    const text = `${String(req.body?.message ?? "").trim()}${envContext}`.trim();
    const files = await moveUploadedFiles(
      (req.files as Express.Multer.File[]) ?? [],
      uploadsDir(session.id)
    );
    if (!text && files.length === 0) {
      sendSse(res, { type: "error", data: "请输入任务或上传用例文档" });
      sendSse(res, { type: "done" });
      res.end();
      return;
    }

    if (files.length) {
      await addUploadedFiles(session.id, files);
    }
    const userMessage = createMessage("user", text || "请处理上传的用例文档", { files });
    const updated = await appendMessage(session.id, userMessage);
    sendSse(res, { type: "message", data: userMessage });
    // CDP 会话：每轮 agent run 前重新激活 UI 选中的目标标签页，
    // 保证多轮对话间切换 tab 后实际在选中 tab 执行（用户可能在轮间手动切了 tab）。
    if (updated.kind === "cdp") {
      const targetId = getSelectedTargetId();
      if (targetId) {
        try { await activateCdpTab(targetId); } catch { /* 激活失败不阻断执行 */ }
      }
    }
    await runAgentTurn({ session: updated, userText: userMessage.content, files, res });
    if (!res.destroyed && !res.writableEnded) {
      res.end();
    }
  } catch (error) {
    next(error);
  }
});

app.get("/api/business-environments", async (_req, res, next) => {
  try {
    res.json(await listBusinessEnvironments());
  } catch (error) {
    next(error);
  }
});

app.post("/api/business-environments", async (req, res, next) => {
  try {
    res.status(201).json(await upsertBusinessEnvironment(req.body ?? {}));
  } catch (error) {
    next(error);
  }
});

app.put("/api/business-environments/:id", async (req, res, next) => {
  try {
    res.json(await upsertBusinessEnvironment({ ...(req.body ?? {}), id: req.params.id }));
  } catch (error) {
    next(error);
  }
});

app.delete("/api/business-environments/:id", async (req, res, next) => {
  try {
    await deleteBusinessEnvironment(req.params.id);
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

app.get("/api/models", async (_req, res, next) => {
  try {
    res.json(await listModelProfiles());
  } catch (error) {
    next(error);
  }
});

app.get("/api/execution-runtimes", async (_req, res, next) => {
  try {
    res.json(await listExecutionRuntimeStatuses());
  } catch (error) {
    next(error);
  }
});

app.get("/api/execution-runtimes/:runtimeId/model-info", async (req, res, next) => {
  try {
    const runtimeId = req.params.runtimeId as ExecutionRuntimeId;
    if (!("cfuse codex dtcoder claude-code".split(" ") as string[]).includes(runtimeId)) {
      res.status(400).json({ error: "不支持的执行底座" });
      return;
    }
    const profile = (await listModelProfiles()).find((item) => item.runtimeId === runtimeId && item.isActive);
    const currentModel = profile?.model || await detectRuntimeConfiguredModel(runtimeId, true);
    res.json({
      runtimeId,
      currentModel,
      source: profile?.model ? "profile" : currentModel ? "cli-config" : "runtime-default"
    });
  } catch (error) {
    next(error);
  }
});

app.get("/api/execution-runtimes/:runtimeId/models", async (req, res, next) => {
  try {
    const runtimeId = req.params.runtimeId as ExecutionRuntimeId;
    if (!("cfuse codex dtcoder claude-code".split(" ") as string[]).includes(runtimeId)) {
      res.status(400).json({ error: "不支持的执行底座" });
      return;
    }
    res.json(await listRuntimeModelCatalog(runtimeId, req.query.refresh === "true"));
  } catch (error) {
    next(error);
  }
});

app.put("/api/execution-runtime", async (req, res, next) => {
  try {
    const runtimeId = req.body?.runtimeId as ExecutionRuntimeId;
    if (!(["cfuse", "codex", "dtcoder", "claude-code"] as string[]).includes(runtimeId)) {
      res.status(400).json({ error: "不支持的执行底座" });
      return;
    }
    const currentStatuses = await listExecutionRuntimeStatuses();
    const targetRuntime = currentStatuses.find((runtime) => runtime.id === runtimeId);
    if (!targetRuntime || targetRuntime.status !== "ready") {
      res.status(409).json({ error: targetRuntime?.detail || "执行底座当前不可用" });
      return;
    }
    await selectExecutionRuntime(runtimeId);
    res.json({
      runtimes: await listExecutionRuntimeStatuses(),
      profiles: await listModelProfiles()
    });
  } catch (error) {
    next(error);
  }
});

app.post("/api/models", async (req, res, next) => {
  try {
    const profile = await upsertModelProfile(req.body ?? {}, { testConnection: true });
    invalidateRuntimeModelCatalog(profile.runtimeId);
    res.status(201).json(profile);
  } catch (error) {
    next(error);
  }
});

app.post("/api/models/test-connection", async (req, res, next) => {
  try {
    res.json(await testModelProfileInputConnection(req.body ?? {}));
  } catch (error) {
    next(error);
  }
});

app.put("/api/models/:id", async (req, res, next) => {
  try {
    const profile = await upsertModelProfile(
      { ...(req.body ?? {}), id: req.params.id },
      { testConnection: true }
    );
    invalidateRuntimeModelCatalog(profile.runtimeId);
    res.json(profile);
  } catch (error) {
    next(error);
  }
});

app.delete("/api/models/:id", async (req, res, next) => {
  try {
    await deleteModelProfile(req.params.id);
    res.json(await listModelProfiles());
  } catch (error) {
    next(error);
  }
});

app.post("/api/models/:id/activate", async (req, res, next) => {
  try {
    const profile = (await listModelProfiles()).find((item) => item.id === req.params.id);
    if (!profile) {
      res.status(404).json({ error: "模型档案不存在" });
      return;
    }
    const profiles = await activateModelProfile(req.params.id);
    invalidateRuntimeModelCatalog(profile.runtimeId);
    res.json(profiles);
  } catch (error) {
    next(error);
  }
});

app.put("/api/execution-runtimes/:runtimeId/model-selection", async (req, res, next) => {
  try {
    const runtimeId = req.params.runtimeId as ExecutionRuntimeId;
    if (!("cfuse codex dtcoder claude-code".split(" ") as string[]).includes(runtimeId)) {
      res.status(400).json({ error: "不支持的执行底座" });
      return;
    }
    if (Object.prototype.hasOwnProperty.call(req.body ?? {}, "model")) {
      const model = typeof req.body?.model === "string" ? req.body.model.trim() : "";
      if (model) {
        const catalog = await listRuntimeModelCatalog(runtimeId, true);
        if (!catalog.models.some((item) => item.id === model)) {
          res.status(400).json({ error: "所选模型不在当前底座返回的可用模型目录中，请刷新后重试" });
          return;
        }
      }
      await selectRuntimeModel(runtimeId, model || null);
      invalidateRuntimeModelCatalog(runtimeId);
      res.json({
        profiles: await listModelProfiles(),
        catalog: await listRuntimeModelCatalog(runtimeId, true),
        runtimes: await listExecutionRuntimeStatuses()
      });
      return;
    }
    const profileId = typeof req.body?.profileId === "string" ? req.body.profileId : null;
    if (profileId) {
      const profile = (await listModelProfiles()).find((item) => item.id === profileId && item.runtimeId === runtimeId);
      if (!profile) {
        res.status(404).json({ error: "模型档案不存在或不属于该执行底座" });
        return;
      }
      const profiles = await activateModelProfile(profileId);
      invalidateRuntimeModelCatalog(runtimeId);
      res.json(profiles);
      return;
    }
    const profiles = await clearActiveModelProfile(runtimeId);
    invalidateRuntimeModelCatalog(runtimeId);
    res.json(profiles);
  } catch (error) {
    next(error);
  }
});

app.get("/api/host-entries", async (_req, res, next) => {
  try {
    res.json(await listHostEntries());
  } catch (error) {
    next(error);
  }
});

app.post("/api/host-entries", async (req, res, next) => {
  try {
    res.status(201).json(await upsertHostEntry(req.body ?? {}));
  } catch (error) {
    next(error);
  }
});

app.put("/api/host-entries/:id", async (req, res, next) => {
  try {
    res.json(await upsertHostEntry({ ...(req.body ?? {}), id: req.params.id }));
  } catch (error) {
    next(error);
  }
});

app.delete("/api/host-entries/:id", async (req, res, next) => {
  try {
    res.json(await deleteHostEntry(req.params.id));
  } catch (error) {
    next(error);
  }
});

app.post("/api/host-entries/apply", async (_req, res, next) => {
  try {
    res.json(await applyStoredHosts());
  } catch (error) {
    next(error);
  }
});

app.get("/api/dingtalk-robots", async (_req, res, next) => {
  try {
    res.json(await listDingtalkRobots());
  } catch (error) {
    next(error);
  }
});

app.post("/api/dingtalk-robots", async (req, res, next) => {
  try {
    res.status(201).json(await upsertDingtalkRobot(req.body ?? {}));
  } catch (error) {
    next(error);
  }
});

app.put("/api/dingtalk-robots/:id", async (req, res, next) => {
  try {
    res.json(await upsertDingtalkRobot({ ...(req.body ?? {}), id: req.params.id }));
  } catch (error) {
    next(error);
  }
});

app.delete("/api/dingtalk-robots/:id", async (req, res, next) => {
  try {
    await deleteDingtalkRobot(req.params.id);
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

app.post("/api/dingtalk-robots/:id/test", async (req, res, next) => {
  try {
    res.json(await testDingtalkRobot(req.params.id));
  } catch (error) {
    next(error);
  }
});

app.get("/api/inspection-tasks", async (_req, res, next) => {
  try {
    res.json(await listInspectionTasks());
  } catch (error) {
    next(error);
  }
});

app.post("/api/inspection-tasks", async (req, res, next) => {
  try {
    const task = await createInspectionTask({
      name: req.body?.name,
      url: req.body?.url,
      businessId: req.body?.businessId,
      username: req.body?.username,
      password: req.body?.password,
      prompt: req.body?.prompt,
      scheduleEnabled: req.body?.scheduleEnabled,
      scheduleMode: req.body?.scheduleMode,
      intervalMinutes: req.body?.intervalMinutes,
      cronExpression: req.body?.cronExpression,
      notifyRobotId: req.body?.notifyRobotId,
      notifyTrigger: req.body?.notifyTrigger
    });
    res.status(201).json(task);
  } catch (error) {
    next(error);
  }
});

app.get("/api/inspection-tasks/:id", async (req, res, next) => {
  try {
    res.json(await getPublicInspectionTask(req.params.id));
  } catch (error) {
    next(error);
  }
});

app.put("/api/inspection-tasks/:id", async (req, res, next) => {
  try {
    const task = await updateInspectionTask(req.params.id, {
      name: req.body?.name,
      url: req.body?.url,
      businessId: req.body?.businessId,
      username: req.body?.username,
      password: req.body?.password,
      prompt: req.body?.prompt,
      scheduleEnabled: req.body?.scheduleEnabled,
      scheduleMode: req.body?.scheduleMode,
      intervalMinutes: req.body?.intervalMinutes,
      cronExpression: req.body?.cronExpression,
      notifyRobotId: req.body?.notifyRobotId,
      notifyTrigger: req.body?.notifyTrigger
    });
    res.json(task);
  } catch (error) {
    next(error);
  }
});

app.delete("/api/inspection-tasks/:id", async (req, res, next) => {
  try {
    // 若任务正在执行，先中止其活动控制器，避免删除后仍残留运行进程
    const task = await loadInspectionTask(req.params.id);
    for (const [runId, controller] of activeInspectionControllers) {
      const run = task.runs?.find((r) => r.id === runId);
      if (run && run.status === "running") {
        controller.abort();
        activeInspectionControllers.delete(runId);
      }
    }
    dispatchedInspectionTaskIds.delete(req.params.id);
    await deleteInspectionTask(req.params.id);
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

app.post("/api/inspection-tasks/:id/runs", async (req, res, next) => {
  try {
    const run = await startInspectionRun(req.params.id, "manual");
    res.status(202).json(run);
  } catch (error) {
    next(error);
  }
});

app.post("/api/inspection-tasks/:id/runs/:runId/abort", async (req, res, next) => {
  try {
    const hadController = await abortInspectionRun(req.params.id, req.params.runId);
    res.status(200).json({ ok: true, aborted: hadController });
  } catch (error) {
    next(error);
  }
});

/* ─── 回归任务模块 ─── */

app.get("/api/regression/modules", async (_req, res, next) => {
  try {
    res.json(await listRegressionModules());
  } catch (error) {
    next(error);
  }
});

app.post("/api/regression/modules", async (req, res, next) => {
  try {
    res.status(201).json(await upsertRegressionModule(req.body ?? {}));
  } catch (error) {
    next(error);
  }
});

app.put("/api/regression/modules/:id", async (req, res, next) => {
  try {
    res.json(await upsertRegressionModule({ ...(req.body ?? {}), id: req.params.id }));
  } catch (error) {
    next(error);
  }
});

app.delete("/api/regression/modules/:id", async (req, res, next) => {
  try {
    await deleteRegressionModule(req.params.id);
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

app.get("/api/regression/cases", async (req, res, next) => {
  try {
    const moduleId = typeof req.query.moduleId === "string" ? req.query.moduleId : undefined;
    res.json(await listRegressionCases(moduleId));
  } catch (error) {
    next(error);
  }
});

app.post("/api/regression/cases", async (req, res, next) => {
  try {
    res.status(201).json(await upsertRegressionCase(req.body ?? {}));
  } catch (error) {
    next(error);
  }
});

app.put("/api/regression/cases/:id", async (req, res, next) => {
  try {
    res.json(await upsertRegressionCase({ ...(req.body ?? {}), id: req.params.id }));
  } catch (error) {
    next(error);
  }
});

app.delete("/api/regression/cases/:id", async (req, res, next) => {
  try {
    await deleteRegressionCase(req.params.id);
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

app.get("/api/regression/batches", async (_req, res, next) => {
  try {
    res.json(await listRegressionBatches());
  } catch (error) {
    next(error);
  }
});

app.get("/api/regression/batches/:id", async (req, res, next) => {
  try {
    res.json(await loadRegressionBatch(req.params.id));
  } catch (error) {
    next(error);
  }
});

app.post("/api/regression/batches", async (req, res, next) => {
  try {
    const caseIds: string[] = Array.isArray(req.body?.caseIds)
      ? req.body.caseIds.filter((x: unknown) => typeof x === "string")
      : [];
    const name = typeof req.body?.name === "string" ? req.body.name : "";
    if (!caseIds.length) {
      res.status(400).json({ error: "请至少选择一个用例" });
      return;
    }
    const cases = await getRegressionCases(caseIds);
    if (!cases.length) {
      res.status(404).json({ error: "所选用例不存在" });
      return;
    }
    const batch = await createRegressionBatch(name, cases, {
      notifyRobotId: req.body?.notifyRobotId,
      notifyTrigger: req.body?.notifyTrigger
    });
    void executeRegressionBatch(batch.id, cases);
    res.status(202).json(batch);
  } catch (error) {
    next(error);
  }
});

app.post("/api/regression/batches/:id/abort", async (req, res, next) => {
  try {
    const batch = await abortRegressionBatch(req.params.id);
    const controller = activeRegressionControllers.get(req.params.id);
    if (controller) {
      controller.abort();
    }
    res.json(batch);
  } catch (error) {
    next(error);
  }
});

app.delete("/api/regression/batches/:id", async (req, res, next) => {
  try {
    const controller = activeRegressionControllers.get(req.params.id);
    if (controller) {
      controller.abort();
    }
    activeRegressionControllers.delete(req.params.id);
    await deleteRegressionBatch(req.params.id);
    res.status(204).end();
  } catch (error) {
    next(error);
  }
});

app.delete("/api/regression/batches/:id/runs/:runId", async (req, res, next) => {
  try {
    const batch = await loadRegressionBatch(req.params.id);
    batch.runs = batch.runs.filter((r) => r.id !== req.params.runId);
    batch.total = batch.runs.length;
    batch.completed = batch.runs.filter((r) => r.status === "completed").length;
    batch.failed = batch.runs.filter((r) => r.status === "failed").length;
    batch.aborted = batch.runs.filter((r) => r.status === "aborted").length;
    await saveRegressionBatch(batch);
    res.status(204).end();
  } catch (error) {
    next(error);
  }
});

app.use(express.static(path.join(projectRoot, "dist", "client")));

// 未匹配的 /api/* 一律返回 JSON 404，避免被下方 SPA fallback 兜成 index.html
// （前端 requestJson 收到 "<!doctype ..." 会报 Unexpected token '<' 的困惑性错误）。
app.all("/api/*", (req, res) => {
  res.status(404).json({ error: `Unknown API: ${req.method} ${req.path}`, version: serverVersion });
});

app.get("*", (_req, res) => {
  res.sendFile(path.join(projectRoot, "dist", "client", "index.html"));
});

app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  const rawMessage = error instanceof Error ? error.message : String(error);
  const noSpace = isNoSpaceError(error, rawMessage);
  const message = noSpace
    ? "本地存储空间不足，无法保存数据。请清理磁盘空间后重试。"
    : rawMessage;
  if (res.headersSent) {
    res.write(`data: ${JSON.stringify({ type: "error", data: message })}\n\n`);
    res.end();
    return;
  }
  const statusCode = error instanceof ModelProfileValidationError
    ? error.statusCode
    : error instanceof multer.MulterError
      ? error.code === "LIMIT_FILE_SIZE" ? 413 : 400
      : 500;
  res.status(noSpace ? 507 : statusCode).json({ error: message, traceId: randomUUID() });
});

await fs.mkdir(path.join(dataDir, "tmp"), { recursive: true });
// Bootstrap the local SQLite runtime, repair its schema, and migrate legacy
// local JSON data on first start.
const _dbRuntime = await getDatabase();
const _schemaReport = await repairSchema(_dbRuntime.knex);
console.log(`[db] schema repair: status=${_schemaReport.status} dialect=${_schemaReport.dialect}`);
await migrateLegacyData();
await ensureStorage();
await ensureInspectionStorage();
await ensureConfigStorage();
await applyNativeAutomationTransportSetting().catch((error) => {
  console.error("[native-automation] GUI Runtime 传输初始化失败", error);
});
await ensureRegressionStorage();
await ensureUiOperationStorage();
await ensureEvaluationLabStorage();
await recoverEvaluationExperiments();
await applyStoredHosts();
// 桌面客户端：恢复上次一键修复持久化的 UI_TEST_PYTHON 解释器选择。
await restorePersistedPython().catch((error) => {
  console.error("[deps] 恢复 UI_TEST_PYTHON 失败", error);
});
// 启动时清理进程重启/崩溃残留的孤儿 running 状态（巡检/回归/会话），
// 并推进巡检 nextRunAt，让调度器后续能继续按期发起。必须在调度器启动前执行。
const backgroundTasksDisabled = process.env.UI_AGENT_DISABLE_BACKGROUND_TASKS === "true";
if (backgroundTasksDisabled) {
  console.log("[runtime] background recovery and inspection scheduler disabled");
} else {
  await reconcileStuckRuns("startup").catch((error) => {
    console.error("[recovery] 启动恢复失败", error);
  });
  startInspectionScheduler();
}
const [nativeRecovery, browserRecovery] = await Promise.all([
  recoverOrphanedNativeAutomationSessions(),
  recoverOrphanedBrowserAutomationSessions()
]);
if (nativeRecovery.recovered.length || browserRecovery.recovered.length) {
  console.log(
    `[recovery] GUI Runtime 孤儿会话：computer=${nativeRecovery.recovered.length} browser=${browserRecovery.recovered.length}`
  );
}
for (const failure of [...nativeRecovery.failed, ...browserRecovery.failed]) {
  console.error(`[recovery] GUI Runtime 会话收尾失败 session=${failure.sessionId}: ${failure.error}`);
}
const server = app.listen(port, host, () => {
  serverStartupComplete = true;
  console.log(`UI Agent Chat API listening on http://${host}:${port}`);
});
installBrowserExtensionBridge(server);
server.on("error", (error) => {
  console.error("UI Agent Chat API failed to listen", error);
  process.exit(1);
});

async function startInspectionRun(taskId: string, trigger: InspectionRunTrigger) {
  console.log(`[inspection] startInspectionRun task=${taskId} trigger=${trigger}`);
  const task = await loadInspectionTask(taskId);
  if (task.status === "running") {
    console.warn(`[inspection] task=${taskId} 已在运行，拒绝重复触发`);
    throw new Error("该巡检任务正在运行");
  }

  const session = await createSession(`巡检：${task.name}`);
  await prepareWorkspace(session.workspacePath, { executionRuntimeId: session.executionRuntimeId });
  const prompt = `${buildInspectionPrompt(task)}${buildEnvironmentPrompt(
    await getBusinessEnvironment(task.businessId),
    {
      url: task.url,
      username: task.username,
      password: task.password
    }
  )}`;
  const userMessage = createMessage("user", prompt, {
    meta: {
      inspectionTaskId: task.id,
      trigger
    }
  });
  const updated = await appendMessage(session.id, userMessage);
  const run = await createInspectionRun(task.id, session.id, trigger);
  console.log(
    `[inspection] run created run=${run.id} task=${task.id} session=${session.id} trigger=${trigger}`
  );

  // 占位：防止调度器在 run 还在 running 期间读到旧 nextRunAt<=now 再次触发（双触发）。
  dispatchedInspectionTaskIds.add(task.id);

  // 手动触发后立即推进 nextRunAt，避免调度器 tick 读到旧的 nextRunAt<=now
  // 而再次以 schedule 触发，造成"一次手动触发跑了两次"。
  if (task.scheduleEnabled) {
    await rescheduleInspectionTask(task.id).catch(() => undefined);
  }

  void executeInspectionRun(task.id, run.id, updated, prompt);
  return run;
}

const activeInspectionControllers = new Map<string, AbortController>();

// 进程内"已派发"保护：手动/定时触发在 createInspectionRun 成功后立刻占位，
// 防止调度器 30s tick 读到旧 nextRunAt<=now 又以 schedule 触发一次（双触发）。
const dispatchedInspectionTaskIds = new Set<string>();

const activeRegressionControllers = new Map<string, AbortController>();

async function executeRegressionBatch(
  batchId: string,
  cases: { id: string; name: string; prompt: string; description?: string; businessId?: string }[]
): Promise<void> {
  const controller = new AbortController();
  activeRegressionControllers.set(batchId, controller);
  registerActiveRegressionBatch(batchId);
  let batch = await loadRegressionBatch(batchId);
  try {
    for (const c of cases) {
      if (controller.signal.aborted || batch.status === "aborted") {
        break;
      }
      const run = batch.runs.find((r) => r.caseId === c.id);
      if (!run) {
        continue;
      }
      const nowStart = new Date().toISOString();
      // mark running
      batch = await updateRegressionRun(batchId, run.id, {
        status: "running",
        startedAt: nowStart
      });
      // 回归单用例执行受共享并发限流器约束：排队 + 执行超时（默认 60min）。
      console.log(`[regression] batch=${batchId} case=${c.id} enqueue slot`);
      const slot = await taskLimiter.enqueue(controller);
      console.log(
        `[regression] batch=${batchId} case=${c.id} slot acquired（queued=${slot.queued}, aborted=${slot.signal.aborted}）`
      );
      try {
        if (slot.signal.aborted) {
          batch = await updateRegressionRun(batchId, run.id, {
            status: "aborted",
            finishedAt: new Date().toISOString(),
            error: "批次已被手动中止"
          });
          continue;
        }
        const session = await createSession(`回归：${c.name}`);
        await prepareWorkspace(session.workspacePath, { executionRuntimeId: session.executionRuntimeId });
        const env = await getBusinessEnvironment(c.businessId);
        const prompt = `${buildRegressionPrompt({
          id: c.id,
          moduleId: "",
          name: c.name,
          description: c.description,
          prompt: c.prompt,
          businessId: c.businessId,
          createdAt: "",
          updatedAt: ""
        })}${buildEnvironmentPrompt(env)}`;
        const userMessage = createMessage("user", prompt, {
          meta: { regressionBatchId: batchId, regressionCaseId: c.id }
        });
        const updated = await appendMessage(session.id, userMessage);
        // persist sessionId onto the run
        batch = await updateRegressionRun(batchId, run.id, { sessionId: session.id });
        const result = await runAgentForSession({
          session: updated,
          userText: prompt,
          files: [],
          abortSignal: slot.signal
        });
        const timedOut = slot.signal.aborted && !controller.signal.aborted;
        if (timedOut) {
          batch = await updateRegressionRun(batchId, run.id, {
            status: "failed",
            finishedAt: new Date().toISOString(),
            error: "回归用例执行超时"
          });
        } else if (controller.signal.aborted) {
          batch = await updateRegressionRun(batchId, run.id, {
            status: "aborted",
            finishedAt: new Date().toISOString(),
            error: "批次已被手动中止"
          });
        } else {
          batch = await updateRegressionRun(batchId, run.id, {
            status: "completed",
            finishedAt: new Date().toISOString(),
            summary: result.assistantText.slice(0, 1000),
            artifactsCount: result.artifacts.length,
            testOutcome: result.testOutcome
          });
        }
      } catch (error) {
        const timedOut = slot.signal.aborted && !controller.signal.aborted;
        const message = timedOut
          ? "回归用例执行超时"
          : controller.signal.aborted
            ? "批次已被手动中止"
            : error instanceof Error
              ? error.message
              : String(error);
        batch = await updateRegressionRun(batchId, run.id, {
          status: timedOut ? "failed" : controller.signal.aborted ? "aborted" : "failed",
          finishedAt: new Date().toISOString(),
          error: message
        });
      } finally {
        slot.release();
      }
    }
    // finalize batch if not already aborted
    if (batch.status !== "aborted") {
      batch = await loadRegressionBatch(batchId);
      batch.status = "completed";
      batch.finishedAt = new Date().toISOString();
      await saveRegressionBatch(batch);
    }
    const ns = await maybeNotifyRegression(batch);
    batch.notifyStatus = ns.status;
    batch.notifyMessage = ns.message;
    await saveRegressionBatch(batch);
  } catch (error) {
    // This function runs fire-and-forget. Keep batch-loop and finalization
    // failures local, record them, and make a best effort to avoid a run that
    // remains permanently marked as running.
    console.error(
      `[regression] batch=${batchId} 执行/收尾失败（已吞掉，避免拖垮进程）:`,
      error instanceof Error ? error.stack || error.message : String(error)
    );
    try {
      const finalize = await loadRegressionBatch(batchId);
      if (finalize.status !== "aborted") {
        finalize.status = "completed";
        finalize.finishedAt = new Date().toISOString();
        await saveRegressionBatch(finalize);
      }
    } catch (finalizeError) {
      console.error(
        `[regression] batch=${batchId} 兜底收尾也失败（已吞掉）:`,
        finalizeError instanceof Error ? finalizeError.stack || finalizeError.message : String(finalizeError)
      );
    }
  } finally {
    activeRegressionControllers.delete(batchId);
    unregisterActiveRegressionBatch(batchId);
  }
}

async function maybeNotifyRegression(batch: RegressionBatch): Promise<{ status: NotifyStatus; message: string }> {
  try {
    if (!batch.notifyRobotId || !batch.notifyTrigger || batch.notifyTrigger === "never") {
      return { status: "skipped", message: "未配置通知或触发条件为 never" };
    }
    const hasFailure = batch.failed > 0 || (batch.assertFailed ?? 0) > 0;
    if (batch.notifyTrigger === "failed" && !hasFailure) {
      return { status: "skipped", message: "仅失败通知且本次无失败，未推送" };
    }
    const r = await notifyRegressionResult({
      robotId: batch.notifyRobotId,
      batchName: batch.name,
      batchStatus: batch.status,
      total: batch.total,
      completed: batch.completed,
      failed: batch.failed,
      aborted: batch.aborted,
      passed: batch.passed,
      assertFailed: batch.assertFailed,
      unknown: batch.unknown,
      runs: batch.runs.map((r) => ({
        caseName: r.caseName,
        status: r.status,
        testOutcome: r.testOutcome,
        error: r.error,
        resultUrl: r.id ? buildRunResultUrl(batch.id, r.id) : undefined
      })),
      resultUrl: buildBatchResultUrl(batch.id)
    });
    return r;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[notify] maybeNotifyRegression failed", batch.id, error);
    return { status: "failed", message };
  }
}

async function maybeNotifyInspection(
  taskId: string,
  status: "completed" | "failed",
  testOutcome: "pass" | "fail" | "unknown",
  summary: string | undefined,
  error: string | undefined
): Promise<{ status: NotifyStatus; message: string }> {
  try {
    const task = await loadInspectionTask(taskId);
    if (!task.notifyRobotId || !task.notifyTrigger || task.notifyTrigger === "never") {
      return { status: "skipped", message: "未配置通知或触发条件为 never" };
    }
    // 失败 = 执行失败 OR 测试断言失败
    const isFailed = status === "failed" || testOutcome === "fail";
    if (task.notifyTrigger === "failed" && !isFailed) {
      return { status: "skipped", message: "仅失败通知且本次无失败，未推送" };
    }
    const r = await notifyInspectionResult({
      robotId: task.notifyRobotId,
      taskName: task.name,
      taskUrl: task.url,
      runStatus: status,
      testOutcome,
      summary,
      error,
      trigger: "manual",
      resultUrl: buildInspectionResultUrl(task.id)
    });
    return r;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[notify] maybeNotifyInspection failed", taskId, error);
    return { status: "failed", message };
  }
}

async function executeInspectionRun(
  taskId: string,
  runId: string,
  session: Awaited<ReturnType<typeof createSession>>,
  prompt: string
): Promise<void> {
  const controller = new AbortController();
  activeInspectionControllers.set(runId, controller);
  registerActiveInspectionRun(runId);
  // 巡检执行受共享并发限流器约束：超过上限时排队，单个 run 执行超时（默认 60min）。
  // 诊断日志：区分"卡在排队等槽位"与"卡在 agent 执行"。若只见 enqueue 未见 acquired，
  // 说明并发槽位耗尽/泄漏，run 会停在 running 且无 agent 日志。
  const cc = getConcurrencyStatus();
  console.log(
    `[inspection] run=${runId} task=${taskId} enqueue slot（active=${cc.active}/${cc.maxConcurrent}, queued=${cc.queued}）`
  );
  const slot = await taskLimiter.enqueue(controller);
  console.log(
    `[inspection] run=${runId} task=${taskId} slot acquired（queued=${slot.queued}, aborted=${slot.signal.aborted}）`
  );
  try {
    if (slot.signal.aborted) {
      const ns = await maybeNotifyInspection(taskId, "failed", "unknown", undefined, "巡检执行已被手动中止");
      await finishInspectionRun(taskId, runId, {
        status: "failed",
        error: "巡检执行已被手动中止",
        notifyStatus: ns.status,
        notifyMessage: ns.message
      });
      return;
    }
    const result = await runAgentForSession({
      session,
      userText: prompt,
      files: [],
      abortSignal: slot.signal
    });
    console.log(
      `[inspection] run=${runId} agent 执行结束，testOutcome=${result.testOutcome} aborted=${slot.signal.aborted}`
    );
    const timedOut = slot.signal.aborted && !controller.signal.aborted;
    if (timedOut) {
      const ns = await maybeNotifyInspection(taskId, "failed", "unknown", undefined, "巡检执行超时");
      await finishInspectionRun(taskId, runId, {
        status: "failed",
        error: "巡检执行超时",
        notifyStatus: ns.status,
        notifyMessage: ns.message
      });
      return;
    }
    if (controller.signal.aborted) {
      const ns = await maybeNotifyInspection(taskId, "failed", "unknown", undefined, "巡检执行已被手动中止");
      await finishInspectionRun(taskId, runId, {
        status: "failed",
        error: "巡检执行已被手动中止",
        notifyStatus: ns.status,
        notifyMessage: ns.message
      });
      return;
    }
    const ns = await maybeNotifyInspection(taskId, "completed", result.testOutcome, result.assistantText.slice(0, 1000), undefined);
    await finishInspectionRun(taskId, runId, {
      status: "completed",
      testOutcome: result.testOutcome,
      summary: result.assistantText.slice(0, 1000),
      artifactsCount: result.artifacts.length,
      notifyStatus: ns.status,
      notifyMessage: ns.message
    });
  } catch (error) {
    // Finalization must not throw out of this fire-and-forget execution path.
    try {
      const timedOut = slot.signal.aborted && !controller.signal.aborted;
      const message = timedOut
        ? "巡检执行超时"
        : controller.signal.aborted
          ? "巡检执行已被手动中止"
          : error instanceof Error
            ? error.message
            : String(error);
      const ns = await maybeNotifyInspection(taskId, "failed", "unknown", undefined, message);
      await finishInspectionRun(taskId, runId, {
        status: "failed",
        error: message,
        notifyStatus: ns.status,
        notifyMessage: ns.message
      });
    } catch (finalizeError) {
      console.error(
        `[inspection] run=${runId} task=${taskId} 收尾失败（已吞掉，避免拖垮进程）:`,
        finalizeError instanceof Error ? finalizeError.stack || finalizeError.message : String(finalizeError)
      );
      // 尽最大努力把 run 标记为 failed，避免永久卡在 running；失败也不再抛。
      await finishInspectionRun(taskId, runId, {
        status: "failed",
        error: error instanceof Error ? error.message : String(error)
      }).catch(() => undefined);
    }
  } finally {
    slot.release();
    activeInspectionControllers.delete(runId);
    unregisterActiveInspectionRun(runId);
    dispatchedInspectionTaskIds.delete(taskId);
  }
}

async function abortInspectionRun(taskId: string, runId: string): Promise<boolean> {
  const controller = activeInspectionControllers.get(runId);
  if (!controller) {
    // Fallback: even if no in-process controller exists, mark the run/task as failed
    // so the UI can recover from a stuck "running" state.
    await finishInspectionRun(taskId, runId, {
      status: "failed",
      error: "巡检执行已被手动中止（无活动进程）"
    }).catch(() => undefined);
    dispatchedInspectionTaskIds.delete(taskId);
    return false;
  }
  controller.abort();
  return true;
}

function startInspectionScheduler(): void {
  const tick = async () => {
    // 每次 tick 先做 DB 级僵尸恢复：把卡死超过执行超时阈值（默认 60min）或
    // 本进程无活跃句柄的 running 记录标记失败，避免任务永远卡在 running 阻塞调度。
    await reconcileStuckRuns("sweep").catch((error) => {
      console.error("[recovery] 周期恢复失败", error);
    });
    const tasks = await listInspectionTasks();
    const now = Date.now();
    for (const task of tasks) {
      if (!task.scheduleEnabled || task.status === "running" || !task.nextRunAt) {
        continue;
      }
      if (dispatchedInspectionTaskIds.has(task.id)) {
        continue;
      }
      if (new Date(task.nextRunAt).getTime() > now) {
        continue;
      }
      try {
        await startInspectionRun(task.id, "schedule");
      } catch (error) {
        console.error("Failed to start scheduled inspection", task.id, error);
        await rescheduleInspectionTask(task.id);
      }
    }
  };

  setInterval(() => {
    void tick().catch((error) => {
      console.error("Inspection scheduler tick failed", error);
    });
  }, 30_000);
  void tick().catch((error) => {
    console.error("Inspection scheduler initial tick failed", error);
  });
}

function isInside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function previewContentType(filePath: string): string {
  const name = filePath.toLowerCase();
  if (name.endsWith(".html") || name.endsWith(".htm")) {
    return "text/html; charset=utf-8";
  }
  if (/\.(?:ya?ml|json|jsonl|har|md|log|txt)$/.test(name)) {
    // Chromium 的 JSON viewer 在 sandbox iframe 中可能呈现空白；文本响应可稳定预览，下载接口不受影响。
    return "text/plain; charset=utf-8";
  }
  if (name.endsWith(".png")) {
    return "image/png";
  }
  if (name.endsWith(".jpg") || name.endsWith(".jpeg")) {
    return "image/jpeg";
  }
  if (name.endsWith(".webp")) {
    return "image/webp";
  }
  return "text/plain; charset=utf-8";
}

function setPreviewSecurityHeaders(res: express.Response, html: boolean): void {
  for (const [name, value] of Object.entries(untrustedPreviewHeaders(html))) {
    res.setHeader(name, value);
  }
}

function isTextPreviewFile(filePath: string): boolean {
  return /\.(?:ya?ml|json|jsonl|har|md|log|txt)$/i.test(filePath);
}

function renderTextPreview(fileName: string, content: string): string {
  const escape = (value: string) => value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>${escape(fileName)}</title><style>
html,body{margin:0;min-height:100%;background:#fff;color:#29384c;font:12px/1.65 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
pre{box-sizing:border-box;min-width:100%;margin:0;padding:16px 18px;white-space:pre-wrap;overflow-wrap:anywhere;tab-size:2}
</style></head><body><pre>${escape(content)}</pre></body></html>`;
}

function isNoSpaceError(error: unknown, message: string): boolean {
  return (typeof error === "object" && error !== null && "code" in error && error.code === "ENOSPC")
    || /\bENOSPC\b|no space left on device/i.test(message);
}
