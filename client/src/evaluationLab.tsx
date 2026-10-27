import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  AppWindow,
  BarChart3,
  CheckCircle2,
  ChevronRight,
  Clock3,
  Download,
  Eye,
  FileJson,
  FileSpreadsheet,
  FlaskConical,
  FolderOpen,
  Gauge,
  Globe2,
  Layers3,
  Loader2,
  Monitor,
  Pencil,
  Play,
  Power,
  RefreshCw,
  RotateCcw,
  Settings2,
  Square,
  Trash2,
  Upload,
  X,
  XCircle
} from "lucide-react";
import { Pagination, usePagination } from "./pagination";
import "./evaluationLab.css";

type OperationType = "browser" | "computer";
type EvaluationRunStatus = "queued" | "running" | "completed" | "failed" | "aborted";
type EvaluationCaseRunStatus =
  | "queued"
  | "running"
  | "pass"
  | "fail"
  | "blocked"
  | "not-run"
  | "unknown"
  | "aborted";
type BrowserKernel = "playwright" | "external-cdp" | "uiwarden-embedded" | "gui-computer";
type NativeProviderId = "mock" | "macos-accessibility" | "windows-ui-automation";
type ExecutionRuntimeId = "cfuse" | "codex" | "dtcoder" | "claude-code";

interface EvaluationAssertionDefinition {
  id: string;
  label: string;
  evaluator: string;
  weight: number;
  required: boolean;
}

interface EvaluationCaseDefinition {
  id: string;
  name: string;
  category: string;
  instruction: string;
  compatibleTargets: OperationType[];
  targetUrl?: string;
  tags: string[];
  timeoutMs: number;
  enabled: boolean;
  passThreshold?: number;
  assertions: EvaluationAssertionDefinition[];
}

interface EvaluationSuite {
  schemaVersion: "1.0";
  id: string;
  name: string;
  description?: string;
  sourceFileName?: string;
  createdAt: string;
  updatedAt: string;
  targetServices?: EvaluationTargetServiceDefinition[];
  cases: EvaluationCaseDefinition[];
}

interface EvaluationTargetServiceDefinition {
  id: string;
  name: string;
  kind: "managed" | "external";
  provider?: string;
  baseUrl?: string;
  healthPath?: string;
}

interface EvaluationTargetServiceStatus {
  id: string;
  name: string;
  kind: EvaluationTargetServiceDefinition["kind"];
  provider?: string;
  status: "stopped" | "ready" | "error";
  startable: boolean;
  baseUrl?: string;
  healthUrl?: string;
  startedAt?: string;
  error?: string;
}

interface EvaluationAssertionResult {
  id: string;
  label: string;
  evaluator: string;
  status: "pass" | "fail" | "unknown";
  score: number;
  maxScore: number;
  reason: string;
  evidencePaths: string[];
}

interface EvaluationCaseRun {
  id: string;
  caseId: string;
  caseName: string;
  category: string;
  repetition: number;
  attemptNumber?: number;
  attemptHistory?: EvaluationCaseAttempt[];
  status: EvaluationCaseRunStatus;
  score?: number;
  reason?: string;
  startedAt?: string;
  finishedAt?: string;
  durationMs?: number;
  taskId?: string;
  operationRunId?: string;
  sessionId?: string;
  artifactsCount: number;
  summary?: string;
  error?: string;
  assertions: EvaluationAssertionResult[];
  observability: {
    eventCount: number;
    tokenUsage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number };
    gaps: string[];
  };
}

interface EvaluationCaseAttempt {
  attemptNumber: number;
  trigger: "checkpoint-resume" | "case-rerun";
  archivedAt: string;
  snapshot: Omit<EvaluationCaseRun, "attemptHistory">;
}

interface EvaluationRunResumeEntry {
  id: string;
  trigger: "checkpoint-resume" | "case-rerun";
  resumedAt: string;
  previousCaseRunIds: string[];
  nextCaseRunIds: string[];
}

interface EvaluationRunSummary {
  total: number;
  completed: number;
  passed: number;
  failed: number;
  blocked: number;
  notRun: number;
  unknown: number;
  aborted: number;
  passRate: number;
  averageScore: number;
  totalDurationMs?: number;
  averageDurationMs: number;
  p95DurationMs: number;
}

interface EvaluationRunConfig {
  operationType: OperationType;
  browserKernel?: BrowserKernel;
  providerId?: NativeProviderId;
  nativeDeliveryMode?: "foreground-compatible" | "background-safe";
  guiRuntimeTransport?: "inherit" | "cli" | "mcp";
  executionRuntimeId?: ExecutionRuntimeId;
  model?: string;
  businessId?: string;
  repetitions: number;
  passThreshold: number;
  concurrency: number;
}

interface EvaluationEnvironment {
  executionRuntimeId: string;
  model?: string;
  selectionSource?: "configured-default" | "plan-override";
  platform: string;
  desktop: boolean;
  executionChain: string[];
  guiRuntimeTransport?: "cli" | "mcp";
  capturedAt: string;
}

interface EvaluationPlan {
  schemaVersion: "1.0";
  id: string;
  name: string;
  description?: string;
  suiteId: string;
  suiteName: string;
  config: EvaluationRunConfig;
  createdAt: string;
  updatedAt: string;
}

interface EvaluationRunListItem {
  id: string;
  planId?: string;
  planName?: string;
  rerunOfRunId?: string;
  rerunOfCaseRunId?: string;
  suiteId: string;
  suiteName: string;
  suiteHash: string;
  status: EvaluationRunStatus;
  config: EvaluationRunConfig;
  environment: EvaluationEnvironment;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  stopReason?: string;
  currentCaseRunId?: string;
  resumeHistory?: EvaluationRunResumeEntry[];
  summary: EvaluationRunSummary;
  reportPaths?: { json: string; html: string };
}

interface EvaluationRun extends EvaluationRunListItem {
  schemaVersion: "1.0";
  planSnapshot?: EvaluationPlan;
  suiteSnapshot: EvaluationSuite;
  caseRuns: EvaluationCaseRun[];
}

interface RunForm {
  operationType: OperationType;
  browserKernel: BrowserKernel;
  providerId: NativeProviderId;
  nativeDeliveryMode: "foreground-compatible" | "background-safe";
  guiRuntimeTransport: "inherit" | "cli" | "mcp";
  executionRuntimeId: ExecutionRuntimeId | "";
  model: string;
  repetitions: number;
  passThreshold: number;
  concurrency: number;
}

interface ExecutionRuntimeStatus {
  id: ExecutionRuntimeId;
  name: string;
  status: "ready" | "missing" | "broken" | "disabled";
  selected: boolean;
  currentModel?: string;
  capabilities: { modelOverride: boolean };
}

interface RuntimeModelCatalog {
  runtimeId: ExecutionRuntimeId;
  currentModel?: string;
  defaultModel?: string;
  models: Array<{ id: string; label: string; description?: string; provider?: string }>;
  warning?: string;
}

interface PlanForm extends RunForm {
  name: string;
  description: string;
  suiteId: string;
}

const IS_DESKTOP = typeof navigator !== "undefined" && navigator.userAgent.includes("Electron");
const IS_MAC = typeof navigator !== "undefined" && /mac/i.test(navigator.platform || navigator.userAgent);
const DEFAULT_FORM: RunForm = {
  operationType: "browser",
  browserKernel: "playwright",
  providerId: IS_DESKTOP ? (IS_MAC ? "macos-accessibility" : "windows-ui-automation") : "mock",
  nativeDeliveryMode: "foreground-compatible",
  guiRuntimeTransport: "inherit",
  executionRuntimeId: "",
  model: "",
  repetitions: 1,
  passThreshold: 70,
  concurrency: 1
};

const DEFAULT_PLAN_FORM: PlanForm = {
  ...DEFAULT_FORM,
  name: "",
  description: "",
  suiteId: ""
};

/** 评测实验室：管理评测集、启动 UI 操作 benchmark 并查看可解释报告。 */
export function EvaluationLabView({ onOpenSession }: { onOpenSession: (sessionId: string) => void }) {
  const [view, setView] = useState<"suites" | "plans" | "runs">("suites");
  const [suites, setSuites] = useState<EvaluationSuite[]>([]);
  const [plans, setPlans] = useState<EvaluationPlan[]>([]);
  const [runs, setRuns] = useState<EvaluationRunListItem[]>([]);
  const [executionRuntimes, setExecutionRuntimes] = useState<ExecutionRuntimeStatus[]>([]);
  const [runtimeModelCatalog, setRuntimeModelCatalog] = useState<RuntimeModelCatalog>();
  const [runtimeModelsLoading, setRuntimeModelsLoading] = useState(false);
  const [selectedSuiteId, setSelectedSuiteId] = useState<string>();
  const [selectedPlanId, setSelectedPlanId] = useState<string>();
  const [selectedRunId, setSelectedRunId] = useState<string>();
  const [selectedRun, setSelectedRun] = useState<EvaluationRun>();
  const [selectedCaseRunId, setSelectedCaseRunId] = useState<string>();
  const [events, setEvents] = useState<Record<string, unknown>[]>([]);
  const [planForm, setPlanForm] = useState<PlanForm>(DEFAULT_PLAN_FORM);
  const [planDialog, setPlanDialog] = useState<"create" | "edit" | "run">();
  const [loading, setLoading] = useState(true);
  const [runningAction, setRunningAction] = useState(false);
  const [error, setError] = useState<string>();
  const [reportPreview, setReportPreview] = useState(false);
  const [targetServiceStatuses, setTargetServiceStatuses] = useState<EvaluationTargetServiceStatus[]>([]);
  const [targetServicesLoading, setTargetServicesLoading] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const selectedSuite = suites.find((item) => item.id === selectedSuiteId) ?? suites[0];
  const selectedPlan = plans.find((item) => item.id === selectedPlanId) ?? plans[0];
  const selectedCaseRun = selectedRun?.caseRuns.find((item) => item.id === selectedCaseRunId);
  const suitePagination = usePagination(suites, 10);
  const planPagination = usePagination(plans, 10);
  const runPagination = usePagination(runs, 10);

  const refresh = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    setError(undefined);
    try {
      const [nextSuites, nextPlans, nextRuns, nextExecutionRuntimes] = await Promise.all([
        requestJson<EvaluationSuite[]>("/api/evaluation-lab/suites"),
        requestJson<EvaluationPlan[]>("/api/evaluation-lab/plans"),
        requestJson<EvaluationRunListItem[]>("/api/evaluation-lab/runs?limit=200"),
        requestJson<ExecutionRuntimeStatus[]>("/api/execution-runtimes")
      ]);
      setSuites(nextSuites);
      setPlans(nextPlans);
      setRuns(nextRuns);
      setExecutionRuntimes(nextExecutionRuntimes);
      setSelectedSuiteId((current) => current && nextSuites.some((item) => item.id === current)
        ? current
        : nextSuites[0]?.id);
      setSelectedPlanId((current) => current && nextPlans.some((item) => item.id === current)
        ? current
        : nextPlans[0]?.id);
      setSelectedRunId((current) => current && nextRuns.some((item) => item.id === current)
        ? current
        : nextRuns[0]?.id);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      if (!silent) setLoading(false);
    }
  }, []);

  const loadRun = useCallback(async (runId: string, silent = false) => {
    if (!silent) setLoading(true);
    try {
      const run = await requestJson<EvaluationRun>(`/api/evaluation-lab/runs/${encodeURIComponent(runId)}`);
      setSelectedRun(run);
      setSelectedCaseRunId((current) => current && run.caseRuns.some((item) => item.id === current)
        ? current
        : run.caseRuns[0]?.id);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      if (!silent) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (selectedRunId) void loadRun(selectedRunId);
    else setSelectedRun(undefined);
  }, [loadRun, selectedRunId]);

  useEffect(() => {
    if (!selectedRun || (selectedRun.status !== "queued" && selectedRun.status !== "running")) return;
    const timer = window.setInterval(() => {
      void Promise.all([loadRun(selectedRun.id, true), refresh(true)]);
    }, 2_000);
    return () => window.clearInterval(timer);
  }, [loadRun, refresh, selectedRun?.id, selectedRun?.status]);

  useEffect(() => {
    if (!selectedRun || !selectedCaseRunId) {
      setEvents([]);
      return;
    }
    void requestJson<Record<string, unknown>[]>(
      `/api/evaluation-lab/runs/${encodeURIComponent(selectedRun.id)}/cases/${encodeURIComponent(selectedCaseRunId)}/events?limit=100`
    ).then(setEvents).catch(() => setEvents([]));
  }, [selectedCaseRunId, selectedRun?.id, selectedCaseRun?.status]);

  useEffect(() => {
    if (!planDialog || !planForm.executionRuntimeId) {
      setRuntimeModelCatalog(undefined);
      setRuntimeModelsLoading(false);
      return;
    }
    let cancelled = false;
    setRuntimeModelsLoading(true);
    void requestJson<RuntimeModelCatalog>(
      `/api/execution-runtimes/${encodeURIComponent(planForm.executionRuntimeId)}/models`
    ).then((catalog) => {
      if (!cancelled) setRuntimeModelCatalog(catalog);
    }).catch((cause) => {
      if (!cancelled) setError(errorMessage(cause));
    }).finally(() => {
      if (!cancelled) setRuntimeModelsLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [planDialog, planForm.executionRuntimeId]);

  const refreshTargetServices = useCallback(async (
    suiteId: string,
    silent = false
  ): Promise<EvaluationTargetServiceStatus[]> => {
    const suite = suites.find((item) => item.id === suiteId);
    if (!suite?.targetServices?.length) {
      setTargetServiceStatuses([]);
      return [];
    }
    if (!silent) setTargetServicesLoading(true);
    try {
      const statuses = await requestJson<EvaluationTargetServiceStatus[]>(
        `/api/evaluation-lab/target-services?suiteId=${encodeURIComponent(suiteId)}`
      );
      setTargetServiceStatuses(statuses);
      return statuses;
    } catch (cause) {
      setError(errorMessage(cause));
      return [];
    } finally {
      if (!silent) setTargetServicesLoading(false);
    }
  }, [suites]);

  useEffect(() => {
    if (!planDialog || planForm.operationType !== "browser" || !planForm.suiteId) {
      setTargetServiceStatuses([]);
      return;
    }
    void refreshTargetServices(planForm.suiteId);
  }, [planDialog, planForm.operationType, planForm.suiteId, refreshTargetServices]);

  const formSuite = suites.find((item) => item.id === planForm.suiteId);
  const compatibleCases = useMemo(
    () => formSuite?.cases.filter((item) => item.enabled && item.compatibleTargets.includes(planForm.operationType)) ?? [],
    [formSuite, planForm.operationType]
  );

  const dashboard = useMemo(() => {
    const completed = runs.filter((item) => item.status === "completed");
    return {
      suites: suites.length,
      plans: plans.length,
      runs: runs.length,
      passRate: completed.length
        ? round(completed.reduce((sum, item) => sum + item.summary.passRate, 0) / completed.length)
        : 0,
      score: completed.length
        ? round(completed.reduce((sum, item) => sum + item.summary.averageScore, 0) / completed.length)
        : 0
    };
  }, [plans.length, runs, suites.length]);

  async function importSuite(file?: File) {
    if (!file) return;
    setRunningAction(true);
    setError(undefined);
    try {
      const body = new FormData();
      body.append("file", file);
      const suite = await requestJson<EvaluationSuite>("/api/evaluation-lab/suites/import", { method: "POST", body });
      await refresh(true);
      setSelectedSuiteId(suite.id);
      setView("suites");
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setRunningAction(false);
      if (fileInput.current) fileInput.current.value = "";
    }
  }

  async function deleteSuite() {
    if (!selectedSuite || !window.confirm(`删除评测集“${selectedSuite.name}”？历史实验报告会保留。`)) return;
    setRunningAction(true);
    try {
      await requestJson(`/api/evaluation-lab/suites/${encodeURIComponent(selectedSuite.id)}`, { method: "DELETE" });
      await refresh(true);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setRunningAction(false);
    }
  }

  function openCreatePlan() {
    if (!selectedSuite) return;
    const target = selectedSuite.cases.some((item) => item.enabled && item.compatibleTargets.includes("browser"))
      ? "browser"
      : "computer";
    setPlanForm({
      ...DEFAULT_PLAN_FORM,
      name: `${selectedSuite.name}方案`,
      suiteId: selectedSuite.id,
      operationType: target
    });
    setPlanDialog("create");
  }

  function openPlanDialog(mode: "edit" | "run") {
    if (!selectedPlan) return;
    setPlanForm({
      name: selectedPlan.name,
      description: selectedPlan.description ?? "",
      suiteId: selectedPlan.suiteId,
      operationType: selectedPlan.config.operationType,
      browserKernel: selectedPlan.config.browserKernel ?? "playwright",
      providerId: IS_DESKTOP
        ? selectedPlan.config.providerId ?? DEFAULT_FORM.providerId
        : "mock",
      nativeDeliveryMode: selectedPlan.config.nativeDeliveryMode ?? "foreground-compatible",
      guiRuntimeTransport: selectedPlan.config.guiRuntimeTransport ?? "inherit",
      executionRuntimeId: selectedPlan.config.executionRuntimeId ?? "",
      model: selectedPlan.config.model ?? "",
      repetitions: selectedPlan.config.repetitions,
      passThreshold: selectedPlan.config.passThreshold,
      concurrency: selectedPlan.config.concurrency
    });
    setPlanDialog(mode);
  }

  async function savePlan() {
    if (!planForm.suiteId || !planForm.name.trim()) return;
    setRunningAction(true);
    setError(undefined);
    try {
      const plan = await requestJson<EvaluationPlan>(
        planDialog === "edit" && selectedPlan
          ? `/api/evaluation-lab/plans/${encodeURIComponent(selectedPlan.id)}`
          : "/api/evaluation-lab/plans",
        {
          method: planDialog === "edit" ? "PUT" : "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(planForm)
        }
      );
      setPlanDialog(undefined);
      await refresh(true);
      setSelectedPlanId(plan.id);
      setView("plans");
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setRunningAction(false);
    }
  }

  async function startPlanRun() {
    if (!selectedPlan) return;
    setRunningAction(true);
    setError(undefined);
    try {
      const statuses = await refreshTargetServices(selectedPlan.suiteId, true);
      const unavailable = statuses.filter((item) => item.status !== "ready");
      if (unavailable.length) {
        const startable = unavailable.filter((item) => item.startable);
        if (
          startable.length !== unavailable.length
          || !window.confirm(`评测依赖 ${unavailable.map((item) => item.name).join("、")}，当前尚未就绪。是否现在启动内置服务后继续？`)
        ) {
          throw new Error(`评测目标服务未就绪：${unavailable.map((item) => item.name).join("、")}`);
        }
        for (const service of startable) {
          await startTargetService(service.id, selectedPlan.suiteId, false);
        }
        const readyStatuses = await refreshTargetServices(selectedPlan.suiteId, true);
        if (readyStatuses.some((item) => item.status !== "ready")) {
          throw new Error("评测目标服务启动后仍未就绪，请查看服务状态后重试");
        }
      }
      const run = await requestJson<EvaluationRun>(
        `/api/evaluation-lab/plans/${encodeURIComponent(selectedPlan.id)}/runs`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(planForm)
        }
      );
      setPlanDialog(undefined);
      setSelectedRunId(run.id);
      setSelectedRun(run);
      setView("runs");
      await refresh(true);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setRunningAction(false);
    }
  }

  async function startTargetService(serviceId: string, suiteId = planForm.suiteId, updateBusy = true) {
    if (!suiteId) return;
    if (updateBusy) setTargetServicesLoading(true);
    setError(undefined);
    try {
      await requestJson<EvaluationTargetServiceStatus>(
        `/api/evaluation-lab/target-services/${encodeURIComponent(serviceId)}/start`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ suiteId })
        }
      );
      await refreshTargetServices(suiteId, true);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      if (updateBusy) setTargetServicesLoading(false);
    }
  }

  async function stopTargetService(serviceId: string, suiteId = planForm.suiteId) {
    if (!suiteId) return;
    setTargetServicesLoading(true);
    setError(undefined);
    try {
      await requestJson<EvaluationTargetServiceStatus>(
        `/api/evaluation-lab/target-services/${encodeURIComponent(serviceId)}/stop`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ suiteId })
        }
      );
      await refreshTargetServices(suiteId, true);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setTargetServicesLoading(false);
    }
  }

  async function prepareRerunTargetServices(run: EvaluationRun) {
    if (run.config.operationType !== "browser" || !run.suiteSnapshot.targetServices?.length) return;
    let statuses = await requestJson<EvaluationTargetServiceStatus[]>(
      `/api/evaluation-lab/target-services?runId=${encodeURIComponent(run.id)}`
    );
    const unavailable = statuses.filter((item) => item.status !== "ready");
    if (!unavailable.length) return;
    const startable = unavailable.filter((item) => item.startable);
    if (
      startable.length !== unavailable.length
      || !window.confirm(`重跑依赖 ${unavailable.map((item) => item.name).join("、")}，当前尚未就绪。是否现在启动内置服务后继续？`)
    ) {
      throw new Error(`评测目标服务未就绪：${unavailable.map((item) => item.name).join("、")}`);
    }
    for (const service of startable) {
      await requestJson(
        `/api/evaluation-lab/target-services/${encodeURIComponent(service.id)}/start`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ runId: run.id })
        }
      );
    }
    statuses = await requestJson<EvaluationTargetServiceStatus[]>(
      `/api/evaluation-lab/target-services?runId=${encodeURIComponent(run.id)}`
    );
    if (statuses.some((item) => item.status !== "ready")) {
      throw new Error("评测目标服务启动后仍未就绪，请重试");
    }
  }

  async function rerun() {
    if (!selectedRun || !window.confirm("按本次评测集、执行链路与参数快照重新运行？原结果会完整保留。")) return;
    setRunningAction(true);
    setError(undefined);
    try {
      await prepareRerunTargetServices(selectedRun);
      const run = await requestJson<EvaluationRun>(
        `/api/evaluation-lab/runs/${encodeURIComponent(selectedRun.id)}/rerun`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({})
        }
      );
      setSelectedRunId(run.id);
      setSelectedRun(run);
      await refresh(true);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setRunningAction(false);
    }
  }

  async function resumeRun() {
    if (
      !selectedRun
      || !selectedRun.summary.notRun
      || !window.confirm(`继续执行剩余 ${selectedRun.summary.notRun} 个未执行样本？已完成结果和产物会保留在当前记录中。`)
    ) return;
    setRunningAction(true);
    setError(undefined);
    try {
      await prepareRerunTargetServices(selectedRun);
      const run = await requestJson<EvaluationRun>(
        `/api/evaluation-lab/runs/${encodeURIComponent(selectedRun.id)}/resume`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({})
        }
      );
      setSelectedRun(run);
      setSelectedCaseRunId(run.caseRuns.find((item) => item.status === "queued")?.id);
      await refresh(true);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setRunningAction(false);
    }
  }

  async function rerunCase(caseRun: EvaluationCaseRun) {
    if (
      !selectedRun
      || !window.confirm(`原位重跑“${caseRun.caseName}”？新结果会覆盖当前展示，旧结果保留在尝试历史中。`)
    ) return;
    setRunningAction(true);
    setError(undefined);
    try {
      await prepareRerunTargetServices(selectedRun);
      const run = await requestJson<EvaluationRun>(
        `/api/evaluation-lab/runs/${encodeURIComponent(selectedRun.id)}/cases/${encodeURIComponent(caseRun.id)}/rerun`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({})
        }
      );
      setSelectedRun(run);
      setSelectedCaseRunId(run.caseRuns.find((item) =>
        item.caseId === caseRun.caseId && item.repetition === caseRun.repetition
      )?.id);
      await refresh(true);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setRunningAction(false);
    }
  }

  async function deleteRun() {
    if (
      !selectedRun
      || ["queued", "running"].includes(selectedRun.status)
      || !window.confirm(`删除评测记录“${selectedRun.suiteName}”？该记录的报告、事件和物化证据会同步删除，原始 UI 操作会话不受影响。`)
    ) return;
    setRunningAction(true);
    setError(undefined);
    try {
      const deletedRunId = selectedRun.id;
      await requestJson(`/api/evaluation-lab/runs/${encodeURIComponent(deletedRunId)}`, {
        method: "DELETE"
      });
      setSelectedRun(undefined);
      setSelectedCaseRunId(undefined);
      setSelectedRunId((current) => current === deletedRunId ? undefined : current);
      await refresh(true);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setRunningAction(false);
    }
  }

  async function deletePlan() {
    if (!selectedPlan || !window.confirm(`删除评测方案“${selectedPlan.name}”？历史结果会保留。`)) return;
    setRunningAction(true);
    try {
      await requestJson(`/api/evaluation-lab/plans/${encodeURIComponent(selectedPlan.id)}`, {
        method: "DELETE"
      });
      await refresh(true);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setRunningAction(false);
    }
  }

  async function abortRun() {
    if (!selectedRun || !["queued", "running"].includes(selectedRun.status)) return;
    setRunningAction(true);
    try {
      const run = await requestJson<EvaluationRun>(`/api/evaluation-lab/runs/${encodeURIComponent(selectedRun.id)}/abort`, {
        method: "POST"
      });
      setSelectedRun(run);
      await refresh(true);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setRunningAction(false);
    }
  }

  async function refreshReport() {
    if (!selectedRun) return;
    setRunningAction(true);
    setError(undefined);
    try {
      const run = await requestJson<EvaluationRun>(
        `/api/evaluation-lab/runs/${encodeURIComponent(selectedRun.id)}/report/refresh`,
        { method: "POST" }
      );
      setSelectedRun(run);
      await refresh(true);
      if (reportPreview) {
        setReportPreview(false);
        window.setTimeout(() => setReportPreview(true), 0);
      }
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setRunningAction(false);
    }
  }

  return (
    <main className="evaluationLab">
      <header className="evaluationHeader">
        <div>
          <h1>评测实验室</h1>
          <p>管理 UI 操作评测集，运行 Browser / Computer benchmark 并沉淀可解释结果。</p>
        </div>
        <div className="evaluationHeaderActions">
          <a className="qualitySecondaryButton" href="/api/evaluation-lab/templates/json"><FileJson size={14} />JSON 模板</a>
          <a className="qualitySecondaryButton" href="/api/evaluation-lab/templates/xlsx"><FileSpreadsheet size={14} />Excel 模板</a>
          <button type="button" className="qualitySecondaryButton" disabled={loading} onClick={() => void refresh()}>
            {loading ? <Loader2 className="spin" size={14} /> : <RefreshCw size={14} />}刷新
          </button>
          <button type="button" className="qualityPrimaryButton" disabled={runningAction} onClick={() => fileInput.current?.click()}>
            {runningAction ? <Loader2 className="spin" size={14} /> : <Upload size={14} />}导入评测集
          </button>
          <input
            ref={fileInput}
            className="evaluationHiddenInput"
            type="file"
            accept=".json,.xlsx,application/json,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            onChange={(event) => void importSuite(event.target.files?.[0])}
          />
        </div>
      </header>

      {error && <div className="qualityBanner qualityBannerError evaluationError"><AlertTriangle size={15} /><span>{error}</span><button type="button" title="关闭" onClick={() => setError(undefined)}><X size={13} /></button></div>}

      <section className="evaluationKpis">
        <EvaluationKpi icon={<FolderOpen size={15} />} label="评测集" value={dashboard.suites} hint="JSON / XLSX" />
        <EvaluationKpi icon={<Layers3 size={15} />} label="评测方案" value={dashboard.plans} hint="评测集 + 运行参数" />
        <EvaluationKpi icon={<FlaskConical size={15} />} label="实验运行" value={dashboard.runs} hint="结果全部保留" />
        <EvaluationKpi icon={<Gauge size={15} />} label="平均得分" value={dashboard.score} hint="已完成实验" tone="score" />
        <EvaluationKpi icon={<CheckCircle2 size={15} />} label="平均通过率" value={`${dashboard.passRate}%`} hint="已完成实验" tone="success" />
      </section>

      <nav className="evaluationTabs" aria-label="评测实验室视图">
        <button type="button" className={view === "suites" ? "active" : ""} onClick={() => setView("suites")}><FolderOpen size={14} />评测集</button>
        <button type="button" className={view === "plans" ? "active" : ""} onClick={() => setView("plans")}><Layers3 size={14} />评测方案</button>
        <button type="button" className={view === "runs" ? "active" : ""} onClick={() => setView("runs")}><BarChart3 size={14} />结果中心</button>
      </nav>

      {view === "suites" ? (
        <section className="evaluationWorkspace">
          <aside className="evaluationList">
            <div className="evaluationListHeading"><strong>评测集</strong><span>{suites.length}</span></div>
            <div className="evaluationListBody">
              {suitePagination.pagedItems.map((suite) => (
                <button
                  type="button"
                  key={suite.id}
                  className={selectedSuite?.id === suite.id ? "active" : ""}
                  onClick={() => setSelectedSuiteId(suite.id)}
                >
                  <FileJson size={15} />
                  <span><strong title={suite.name}>{suite.name}</strong><em>{suite.cases.length} 条用例 · {formatTime(suite.updatedAt)}</em></span>
                  <ChevronRight size={13} />
                </button>
              ))}
              {!suites.length && !loading && <div className="evaluationEmpty"><FileJson size={24} /><strong>还没有评测集</strong><span>下载模板并导入 JSON 或 XLSX。</span></div>}
            </div>
            <Pagination state={suitePagination} />
          </aside>

          <div className="evaluationSuiteDetail">
            {selectedSuite ? (
              <>
                <header className="evaluationDetailHeader">
                  <div>
                    <h2>{selectedSuite.name}</h2>
                    <p>{selectedSuite.description || "未填写评测集说明"}</p>
                    <div className="evaluationMeta">
                      <span>Schema {selectedSuite.schemaVersion}</span>
                      <span>{selectedSuite.sourceFileName || "API 创建"}</span>
                      <span>{selectedSuite.cases.length} 条用例</span>
                      {selectedSuite.targetServices?.length
                        ? <span>{selectedSuite.targetServices.length} 个目标服务</span>
                        : null}
                    </div>
                  </div>
                  <div className="evaluationDetailActions">
                    <button type="button" className="qualityPrimaryButton" disabled={runningAction} onClick={openCreatePlan}><Layers3 size={13} />创建评测方案</button>
                    <button type="button" className="qualityDangerButton" disabled={runningAction} title="删除评测集" onClick={() => void deleteSuite()}><Trash2 size={13} /></button>
                  </div>
                </header>

                <section className="evaluationCases">
                  <div className="evaluationSectionHeading"><div><AppWindow size={14} /><strong>用例定义</strong></div><span>断言与超时均随实验快照保存</span></div>
                  <div className="evaluationCaseTable">
                    <div className="evaluationCaseRow evaluationTableHeader"><span>用例</span><span>类别</span><span>支持目标</span><span>断言</span><span>超时</span></div>
                    {selectedSuite.cases.map((item) => (
                      <div className={!item.enabled ? "evaluationCaseRow disabled" : "evaluationCaseRow"} key={item.id}>
                        <span><strong title={item.name}>{item.name}</strong><em title={item.instruction}>{item.instruction}</em></span>
                        <span>{item.category}</span>
                        <span className="evaluationTargetTags">{item.compatibleTargets.map((target) => <i key={target}>{target === "browser" ? "Browser" : "Computer"}</i>)}</span>
                        <span>{item.assertions.length}</span>
                        <span>{formatDuration(item.timeoutMs)}</span>
                      </div>
                    ))}
                  </div>
                </section>
              </>
            ) : <div className="evaluationEmpty"><FlaskConical size={28} /><strong>选择或导入评测集</strong></div>}
          </div>
        </section>
      ) : view === "plans" ? (
        <section className="evaluationWorkspace">
          <aside className="evaluationList">
            <div className="evaluationListHeading"><strong>评测方案</strong><span>{plans.length}</span></div>
            <div className="evaluationListBody">
              {planPagination.pagedItems.map((plan) => (
                <button
                  type="button"
                  key={plan.id}
                  className={selectedPlan?.id === plan.id ? "active" : ""}
                  onClick={() => setSelectedPlanId(plan.id)}
                >
                  <Layers3 size={15} />
                  <span><strong title={plan.name}>{plan.name}</strong><em>{plan.suiteName} · {formatTime(plan.updatedAt)}</em></span>
                  <ChevronRight size={13} />
                </button>
              ))}
              {!plans.length && !loading && <div className="evaluationEmpty"><Layers3 size={24} /><strong>还没有评测方案</strong><span>从评测集创建方案，执行参数不会写入评测集。</span></div>}
            </div>
            <Pagination state={planPagination} />
          </aside>

          <div className="evaluationSuiteDetail">
            {selectedPlan ? (
              <>
                <header className="evaluationDetailHeader">
                  <div>
                    <h2>{selectedPlan.name}</h2>
                    <p>{selectedPlan.description || "未填写评测方案说明"}</p>
                    <div className="evaluationMeta">
                      <span>{selectedPlan.suiteName}</span>
                      <span>{selectedPlan.config.operationType === "browser" ? "Browser" : "Computer"}</span>
                      <span>{runs.filter((item) => item.planId === selectedPlan.id).length} 次历史运行</span>
                    </div>
                  </div>
                  <div className="evaluationDetailActions">
                    <button type="button" className="qualitySecondaryButton" onClick={() => openPlanDialog("edit")}><Pencil size={13} />编辑</button>
                    <button type="button" className="qualityPrimaryButton" onClick={() => openPlanDialog("run")}><Play size={13} />启动评测</button>
                    <button type="button" className="qualityDangerButton" disabled={runningAction} title="删除评测方案" onClick={() => void deletePlan()}><Trash2 size={13} /></button>
                  </div>
                </header>

                <section className="evaluationPlanOverview">
                  <div className="evaluationSectionHeading"><div><Settings2 size={14} /><strong>默认运行参数</strong></div><span>启动时可临时覆盖，方案本身不会改变</span></div>
                  <dl className="evaluationParameterGrid">
                    <dt>评测集</dt><dd>{selectedPlan.suiteName}</dd>
                    <dt>UI 操作类型</dt><dd>{selectedPlan.config.operationType === "browser" ? "浏览器" : "电脑桌面"}</dd>
                    <dt>执行目标</dt><dd>{evaluationTargetLabel(selectedPlan.config)}</dd>
                    <dt>执行链路</dt><dd>{evaluationChainLabel(selectedPlan.config)}</dd>
                    <dt>执行底座</dt><dd>{selectedPlan.config.executionRuntimeId
                      ? runtimeName(executionRuntimes, selectedPlan.config.executionRuntimeId)
                      : "继承配置中心"}</dd>
                    <dt>模型</dt><dd>{selectedPlan.config.model || "继承所选底座当前模型"}</dd>
                    <dt>重复次数</dt><dd>{selectedPlan.config.repetitions}</dd>
                    <dt>通过阈值</dt><dd>{selectedPlan.config.passThreshold} 分</dd>
                    <dt>并发数</dt><dd>{selectedPlan.config.concurrency}</dd>
                    <dt>动作投递</dt><dd>{selectedPlan.config.nativeDeliveryMode === "background-safe" ? "严格后台" : "前台兼容"}</dd>
                    {selectedPlan.config.operationType === "computer" && <>
                      <dt>Runtime 传输</dt><dd>{selectedPlan.config.guiRuntimeTransport === "cli"
                        ? "兼容 CLI"
                        : selectedPlan.config.guiRuntimeTransport === "mcp"
                          ? "持久 MCP"
                          : "继承配置中心"}</dd>
                    </>}
                  </dl>
                </section>

                <section className="evaluationCases">
                  <div className="evaluationSectionHeading"><div><FlaskConical size={14} /><strong>历史运行</strong></div><span>每次启动产生独立结果</span></div>
                  <div className="evaluationPlanRuns">
                    {runs.filter((item) => item.planId === selectedPlan.id).map((run) => (
                      <button type="button" key={run.id} onClick={() => {
                        setSelectedRunId(run.id);
                        setView("runs");
                      }}>
                        <EvaluationStatus status={run.status} />
                        <span><strong>{formatTime(run.createdAt)}</strong><em>{run.summary.passed}/{run.summary.total} 通过 · {run.summary.averageScore} 分</em></span>
                        <ChevronRight size={13} />
                      </button>
                    ))}
                    {!runs.some((item) => item.planId === selectedPlan.id) && <div className="evaluationEvidenceEmpty">尚未运行此评测方案</div>}
                  </div>
                </section>
              </>
            ) : <div className="evaluationEmpty"><Layers3 size={28} /><strong>从评测集创建评测方案</strong></div>}
          </div>
        </section>
      ) : (
        <section className="evaluationWorkspace">
          <aside className="evaluationList">
            <div className="evaluationListHeading"><strong>实验运行</strong><span>{runs.length}</span></div>
            <div className="evaluationListBody">
              {runPagination.pagedItems.map((run) => (
                <button type="button" key={run.id} className={selectedRunId === run.id ? "active" : ""} onClick={() => setSelectedRunId(run.id)}>
                  {run.status === "running" || run.status === "queued" ? <Loader2 className="spin" size={15} /> : run.status === "completed" ? <CheckCircle2 size={15} /> : <XCircle size={15} />}
                  <span><strong title={run.suiteName}>{run.suiteName}</strong><em>{run.summary.completed}/{run.summary.total} · {formatTime(run.createdAt)}</em></span>
                  <ChevronRight size={13} />
                </button>
              ))}
              {!runs.length && !loading && <div className="evaluationEmpty"><BarChart3 size={24} /><strong>暂无实验结果</strong><span>从评测集启动一次实验。</span></div>}
            </div>
            <Pagination state={runPagination} />
          </aside>

          <div className="evaluationRunDetail">
            {selectedRun ? (
              <>
                <header className="evaluationDetailHeader">
                  <div>
                    <h2>{selectedRun.suiteName}</h2>
                    <div className="evaluationMeta">
                      <EvaluationStatus
                        status={selectedRun.status}
                        partial={selectedRun.status === "completed" && (selectedRun.summary.notRun ?? 0) > 0}
                      />
                      <span>{selectedRun.config.operationType === "browser" ? selectedRun.config.browserKernel : selectedRun.config.providerId}</span>
                      <span>{selectedRun.environment.executionRuntimeId} · {selectedRun.environment.model || "默认模型"}</span>
                      <span title={selectedRun.suiteHash}>输入 {selectedRun.suiteHash.slice(0, 10)}</span>
                    </div>
                  </div>
                  <div className="evaluationDetailActions">
                    {["queued", "running"].includes(selectedRun.status) && <button type="button" className="qualityDangerButton" disabled={runningAction} onClick={() => void abortRun()}><Square size={12} />停止</button>}
                    {!["queued", "running"].includes(selectedRun.status) && selectedRun.summary.notRun > 0 && <button type="button" className="qualityPrimaryButton" disabled={runningAction} onClick={() => void resumeRun()}>{runningAction ? <Loader2 className="spin" size={13} /> : <Play size={13} />}继续未执行</button>}
                    {!["queued", "running"].includes(selectedRun.status) && <button type="button" className="qualitySecondaryButton" disabled={runningAction} onClick={() => void rerun()}>{runningAction ? <Loader2 className="spin" size={13} /> : <RotateCcw size={13} />}完整重跑</button>}
                    {!["queued", "running"].includes(selectedRun.status) && <button type="button" className="qualityDangerButton" disabled={runningAction} onClick={() => void deleteRun()} title="删除评测记录"><Trash2 size={13} /></button>}
                    {selectedRun.reportPaths && <>
                      <button type="button" className="qualitySecondaryButton" disabled={runningAction} onClick={() => void refreshReport()} title="回查任务、事件流和 Rep，重新生成可供 Coder 分析的报告"><RefreshCw className={runningAction ? "spin" : undefined} size={13} />刷新证据</button>
                      <button type="button" className="qualitySecondaryButton" onClick={() => setReportPreview(true)}><Eye size={13} />预览报告</button>
                      <a className="qualitySecondaryButton" href={`/api/evaluation-lab/runs/${encodeURIComponent(selectedRun.id)}/report.json`}><Download size={13} />JSON</a>
                      <a className="qualitySecondaryButton" href={`/api/evaluation-lab/runs/${encodeURIComponent(selectedRun.id)}/report.zip`}><Download size={13} />Evidence Bundle</a>
                      <a className="qualitySecondaryButton evaluationReportPrimary" href={`/api/evaluation-lab/runs/${encodeURIComponent(selectedRun.id)}/report.html`}><Download size={13} />HTML 报告</a>
                    </>}
                  </div>
                </header>

                <section className="evaluationRunKpis">
                  <EvaluationKpi
                    label="终态进度"
                    value={`${selectedRun.summary.completed}/${selectedRun.summary.total}`}
                    hint={selectedRun.status === "running"
                      ? "正在执行"
                      : `${selectedRun.summary.total - (selectedRun.summary.notRun ?? 0)} 已执行 · ${selectedRun.summary.notRun ?? 0} 未执行`}
                  />
                  <EvaluationKpi
                    label="已执行通过率"
                    value={`${selectedRun.summary.passRate}%`}
                    hint={`${selectedRun.summary.passed} 通过`}
                    tone="success"
                  />
                  <EvaluationKpi label="平均得分" value={selectedRun.summary.averageScore} hint={`阈值 ${selectedRun.config.passThreshold}`} tone="score" />
                  <EvaluationKpi label="平均耗时" value={formatDuration(selectedRun.summary.averageDurationMs)} hint={`P95 ${formatDuration(selectedRun.summary.p95DurationMs)}`} />
                  <EvaluationKpi label="总耗时" value={formatDuration(runWallClockDuration(selectedRun))} hint={`样本累计 ${formatDuration(selectedRun.summary.totalDurationMs)}`} />
                  <EvaluationKpi
                    label="失败 / 阻塞"
                    value={`${selectedRun.summary.failed}/${selectedRun.summary.blocked ?? 0}`}
                    hint={`${selectedRun.summary.notRun ?? 0} 未执行 · ${selectedRun.summary.aborted} 中止`}
                    tone={selectedRun.summary.failed || selectedRun.summary.blocked ? "danger" : undefined}
                  />
                </section>

                <div className="evaluationProgress"><span style={{ width: `${selectedRun.summary.total ? (selectedRun.summary.completed / selectedRun.summary.total) * 100 : 0}%` }} /></div>

                <section className="evaluationRunParameters">
                  <div className="evaluationSectionHeading"><div><Settings2 size={14} /><strong>本次运行参数</strong></div><span>创建时已冻结，不受后续方案修改影响</span></div>
                  <dl className="evaluationParameterGrid">
                    <dt>评测方案</dt><dd>{selectedRun.planName || "历史直接运行"}</dd>
                    <dt>评测集</dt><dd>{selectedRun.suiteName} <code>{selectedRun.suiteHash.slice(0, 12)}</code></dd>
                    <dt>执行底座 / 模型</dt><dd>{runtimeName(executionRuntimes, selectedRun.environment.executionRuntimeId)} / {selectedRun.environment.model || "底座默认模型"}</dd>
                    <dt>选择来源</dt><dd>{selectedRun.environment.selectionSource === "plan-override" ? "评测方案指定" : "继承配置中心后冻结"}</dd>
                    <dt>评测链路</dt><dd>{selectedRun.environment.executionChain?.join(" → ") || evaluationChainLabel(selectedRun.config)}</dd>
                    <dt>执行目标</dt><dd>{evaluationTargetLabel(selectedRun.config)}</dd>
                    <dt>传输模式</dt><dd>{selectedRun.environment.guiRuntimeTransport?.toUpperCase() || "进程内 / CDP"}</dd>
                    <dt>重复 / 并发</dt><dd>{selectedRun.config.repetitions} / {selectedRun.config.concurrency}</dd>
                    <dt>通过阈值</dt><dd>{selectedRun.config.passThreshold} 分</dd>
                    <dt>恢复 / 重跑</dt><dd>{selectedRun.resumeHistory?.length
                      ? `${selectedRun.resumeHistory.length} 次 · 最近 ${formatTime(selectedRun.resumeHistory.at(-1)!.resumedAt)}`
                      : "未发生"}</dd>
                    {selectedRun.rerunOfRunId && <><dt>重跑来源</dt><dd><code>{selectedRun.rerunOfRunId}</code></dd></>}
                    {selectedRun.rerunOfCaseRunId && <><dt>单例来源</dt><dd><code>{selectedRun.rerunOfCaseRunId}</code></dd></>}
                  </dl>
                </section>

                <section className="evaluationResultLayout">
                  <div className="evaluationResultTable">
                    <div className="evaluationSectionHeading"><div><BarChart3 size={14} /><strong>样本结果</strong></div><span>点击查看评分与事件</span></div>
                    <div className="evaluationResultRows">
                      <div className="evaluationResultRow evaluationTableHeader"><span>用例</span><span>结果</span><span>得分</span><span>耗时</span><span>原因</span><span>产物</span></div>
                      {selectedRun.caseRuns.map((item) => (
                        <button type="button" className={selectedCaseRunId === item.id ? "evaluationResultRow active" : "evaluationResultRow"} key={item.id} onClick={() => setSelectedCaseRunId(item.id)}>
                          <span><strong title={item.caseName}>{item.caseName}</strong><em>{item.category} · 第 {item.repetition} 轮 · 尝试 {item.attemptNumber ?? 1}</em></span>
                          <EvaluationCaseStatus status={item.status} />
                          <span>{item.score ?? "-"}</span>
                          <span>{formatDuration(item.durationMs)}</span>
                          <span className="evaluationReason" title={item.reason || item.error}>{item.reason || item.error || "等待执行"}</span>
                          <span>{item.artifactsCount}</span>
                        </button>
                      ))}
                    </div>
                  </div>

                  <aside className="evaluationEvidence">
                    {selectedCaseRun ? <>
                      <header>
                        <div className="evaluationEvidenceTitle"><strong>{selectedCaseRun.caseName}</strong><span>{selectedCaseRun.id}</span></div>
                        <div className="evaluationEvidenceActions">
                          {!["queued", "running"].includes(selectedCaseRun.status) && <button type="button" disabled={runningAction} title="仅重跑此样本" onClick={() => void rerunCase(selectedCaseRun)}><RotateCcw size={13} /></button>}
                          {selectedCaseRun.sessionId && <button type="button" title="打开原始 Agent 会话" onClick={() => onOpenSession(selectedCaseRun.sessionId!)}><ChevronRight size={13} /></button>}
                        </div>
                      </header>
                      <div className="evaluationEvidenceBody">
                        <section><h3>结论与原因</h3><p>{selectedCaseRun.reason || selectedCaseRun.error || "等待执行结果"}</p></section>
                        <section><h3>评分明细</h3>{selectedCaseRun.assertions.length ? selectedCaseRun.assertions.map((assertion) => (
                          <div className="evaluationAssertion" key={assertion.id}>
                            {assertion.status === "pass" ? <CheckCircle2 size={13} /> : assertion.status === "fail" ? <XCircle size={13} /> : <Clock3 size={13} />}
                            <span><strong>{assertion.label}</strong><em>{assertion.reason}</em></span>
                            <b>{assertion.score}/{assertion.maxScore}</b>
                          </div>
                        )) : <div className="evaluationEvidenceEmpty">尚无评分明细</div>}</section>
                        <section><h3>可观察性</h3><dl>
                          <dt>事件数</dt><dd>{selectedCaseRun.observability.eventCount}</dd>
                          <dt>Token</dt><dd>{selectedCaseRun.observability.tokenUsage?.totalTokens ?? "未采集"}</dd>
                          <dt>产物数</dt><dd>{selectedCaseRun.artifactsCount}</dd>
                          <dt>观测缺口</dt><dd>{selectedCaseRun.observability.gaps.join("、") || "无"}</dd>
                        </dl></section>
                        <section><h3>尝试历史</h3>{selectedCaseRun.attemptHistory?.length ? (
                          <div className="evaluationAttemptHistory">
                            {[...selectedCaseRun.attemptHistory].reverse().map((attempt) => (
                              <div key={`${attempt.snapshot.id}-${attempt.attemptNumber}`}>
                                <span>尝试 {attempt.attemptNumber} · {attempt.trigger === "case-rerun" ? "单例重跑" : "断点续跑"}</span>
                                <strong>{attempt.snapshot.status} · {attempt.snapshot.score ?? "-"} 分 · {formatDuration(attempt.snapshot.durationMs)}</strong>
                                <em title={attempt.snapshot.reason || attempt.snapshot.error}>{attempt.snapshot.reason || attempt.snapshot.error || "无结果摘要"}</em>
                              </div>
                            ))}
                          </div>
                        ) : <div className="evaluationEvidenceEmpty">当前为首次执行</div>}</section>
                        <section><h3>最近事件</h3><div className="evaluationEvents">{events.slice(-20).reverse().map((event, index) => <div key={`${String(event.timestamp)}-${index}`}><span>{String(event.type ?? "event")}</span><code>{eventSummary(event)}</code></div>)}{!events.length && <div className="evaluationEvidenceEmpty">暂无执行事件</div>}</div></section>
                      </div>
                    </> : <div className="evaluationEmpty"><Eye size={24} /><strong>选择一个样本</strong></div>}
                  </aside>
                </section>
              </>
            ) : <div className="evaluationEmpty"><BarChart3 size={28} /><strong>选择一次实验运行</strong></div>}
          </div>
        </section>
      )}

      {planDialog && (
        <div className="evaluationConfigModal" role="dialog" aria-modal="true" aria-label={planDialog === "run" ? "启动评测" : "评测方案"}>
          <div>
            <header>
              <div><Settings2 size={15} /><strong>{planDialog === "create" ? "创建评测方案" : planDialog === "edit" ? "编辑评测方案" : "启动评测"}</strong></div>
              <button type="button" title="关闭" onClick={() => setPlanDialog(undefined)}><X size={16} /></button>
            </header>
            <div className="evaluationConfigBody">
              {planDialog !== "run" && (
                <div className="evaluationPlanIdentity">
                  <label><span>方案名称</span><input value={planForm.name} maxLength={120} onChange={(event) => setPlanForm((current) => ({ ...current, name: event.target.value }))} /></label>
                  <label><span>评测集</span><select value={planForm.suiteId} onChange={(event) => setPlanForm((current) => ({ ...current, suiteId: event.target.value }))}>
                    {suites.map((suite) => <option key={suite.id} value={suite.id}>{suite.name}</option>)}
                  </select></label>
                  <label className="evaluationPlanDescription"><span>方案说明</span><textarea value={planForm.description} maxLength={1_000} onChange={(event) => setPlanForm((current) => ({ ...current, description: event.target.value }))} /></label>
                </div>
              )}
              {planDialog === "run" && <div className="evaluationRunContext"><strong>{selectedPlan?.name}</strong><span>{selectedPlan?.suiteName}</span></div>}
              <div className="evaluationRunForm">
                <label><span>UI 操作类型</span><div className="evaluationSegment">
                  <button type="button" className={planForm.operationType === "browser" ? "active" : ""} onClick={() => setPlanForm((current) => ({ ...current, operationType: "browser" }))}><Globe2 size={13} />浏览器</button>
                  <button type="button" className={planForm.operationType === "computer" ? "active" : ""} onClick={() => setPlanForm((current) => ({ ...current, operationType: "computer", concurrency: 1 }))}><Monitor size={13} />电脑桌面</button>
                </div></label>
                {planForm.operationType === "browser" ? (
                  <label><span>执行内核</span><select value={planForm.browserKernel} onChange={(event) => {
                    const browserKernel = event.target.value as BrowserKernel;
                    setPlanForm((current) => ({ ...current, browserKernel, concurrency: 1 }));
                  }}>
                    <option value="playwright">Playwright 配套 Chromium（默认）</option>
                    <option value="uiwarden-embedded">{IS_DESKTOP ? "客户端内置 gui-browser" : "服务端托管 gui-browser"}</option>
                    <option value="external-cdp" disabled={!IS_DESKTOP}>用户浏览器桥接</option>
                  </select></label>
                ) : (
                  <label><span>Computer Provider</span><select value={planForm.providerId} onChange={(event) => setPlanForm((current) => ({ ...current, providerId: event.target.value as NativeProviderId }))}>
                    {!IS_DESKTOP && <option value="mock">服务器 Mock Provider</option>}
                    {IS_DESKTOP && IS_MAC && <option value="macos-accessibility">macOS Accessibility</option>}
                    {IS_DESKTOP && !IS_MAC && <option value="windows-ui-automation">Windows UI Automation</option>}
                  </select></label>
                )}
                <label><span>执行底座</span><select value={planForm.executionRuntimeId} onChange={(event) => {
                  const executionRuntimeId = event.target.value as ExecutionRuntimeId | "";
                  setPlanForm((current) => ({ ...current, executionRuntimeId, model: "" }));
                }}>
                  <option value="">继承配置中心（{runtimeName(executionRuntimes, executionRuntimes.find((item) => item.selected)?.id)}）</option>
                  {executionRuntimes.map((runtime) => (
                    <option key={runtime.id} value={runtime.id} disabled={runtime.status !== "ready"}>
                      {runtime.name}{runtime.status === "ready" ? "" : `（${runtime.status}）`}
                    </option>
                  ))}
                </select></label>
                <label><span>执行模型</span><select
                  value={planForm.model}
                  disabled={!planForm.executionRuntimeId || runtimeModelsLoading}
                  onChange={(event) => setPlanForm((current) => ({ ...current, model: event.target.value }))}
                >
                  <option value="">{planForm.executionRuntimeId
                    ? `使用底座当前模型（${runtimeModelCatalog?.currentModel || runtimeName(executionRuntimes, planForm.executionRuntimeId, true)}）`
                    : "随配置中心底座与模型"}</option>
                  {runtimeModelCatalog?.models.map((model) => (
                    <option key={model.id} value={model.id}>
                      {model.label}{model.id !== model.label ? `（${model.provider || model.id.split("/")[0]}）` : ""}
                    </option>
                  ))}
                </select></label>
                <label><span>重复次数</span><input type="number" min={1} max={20} value={planForm.repetitions} onChange={(event) => setPlanForm((current) => ({ ...current, repetitions: clampNumber(event.target.value, 1, 20) }))} /></label>
                <label><span>通过阈值</span><div className="evaluationSuffixInput"><input type="number" min={0} max={100} value={planForm.passThreshold} onChange={(event) => setPlanForm((current) => ({ ...current, passThreshold: clampNumber(event.target.value, 0, 100) }))} /><em>分</em></div></label>
                <label><span>并发数</span><select disabled value={1}>
                  <option value={1}>1（串行）</option>
                </select></label>
                {planForm.operationType === "computer" ? (
                  <>
                    {IS_MAC && IS_DESKTOP && (
                      <label><span>动作投递</span><select value={planForm.nativeDeliveryMode} onChange={(event) => setPlanForm((current) => ({ ...current, nativeDeliveryMode: event.target.value as RunForm["nativeDeliveryMode"] }))}>
                        <option value="foreground-compatible">前台兼容</option>
                        <option value="background-safe">严格后台</option>
                      </select></label>
                    )}
                    <label><span>Runtime 传输</span><select value={planForm.guiRuntimeTransport} onChange={(event) => setPlanForm((current) => ({ ...current, guiRuntimeTransport: event.target.value as RunForm["guiRuntimeTransport"] }))}>
                      <option value="inherit">继承配置中心</option>
                      <option value="cli">兼容 CLI</option>
                      <option value="mcp">持久 MCP</option>
                    </select></label>
                    <div className="evaluationRunNotice">桌面评测强制串行，避免输入和焦点冲突。</div>
                  </>
                ) : <div className="evaluationRunNotice">浏览器原子链路强制串行，确保目标页面和会话证据稳定。</div>}
              </div>
              {planDialog === "run" && planForm.operationType === "browser" && targetServiceStatuses.length > 0 && (
                <section className="evaluationTargetServices">
                  <header>
                    <div><Globe2 size={14} /><strong>评测目标服务</strong></div>
                    <button
                      type="button"
                      title="重新检测"
                      disabled={targetServicesLoading}
                      onClick={() => void refreshTargetServices(planForm.suiteId)}
                    >
                      {targetServicesLoading ? <Loader2 className="spin" size={13} /> : <RefreshCw size={13} />}
                    </button>
                  </header>
                  <div>
                    {targetServiceStatuses.map((service) => (
                      <article key={service.id}>
                        <span className={`evaluationServiceState ${service.status}`} />
                        <div>
                          <strong>{service.name}</strong>
                          <em title={service.error || service.baseUrl}>
                            {service.status === "ready"
                              ? service.baseUrl
                              : service.error || (service.startable ? "等待手动启动" : "等待外部服务就绪")}
                          </em>
                        </div>
                        {service.status === "ready" && service.kind === "managed" ? (
                          <button type="button" disabled={targetServicesLoading} onClick={() => void stopTargetService(service.id)}>
                            <Square size={12} />停止
                          </button>
                        ) : service.startable ? (
                          <button type="button" disabled={targetServicesLoading} onClick={() => void startTargetService(service.id)}>
                            <Power size={12} />启动
                          </button>
                        ) : (
                          <span className="evaluationExternalService">外部管理</span>
                        )}
                      </article>
                    ))}
                  </div>
                </section>
              )}
            </div>
            <footer>
              <span>{compatibleCases.length} 条匹配用例，预计执行 {compatibleCases.length * planForm.repetitions} 次</span>
              <div>
                <button type="button" className="qualitySecondaryButton" onClick={() => setPlanDialog(undefined)}>取消</button>
                <button
                  type="button"
                  className="qualityPrimaryButton"
                  disabled={runningAction || !compatibleCases.length || !planForm.name.trim()}
                  onClick={() => void (planDialog === "run" ? startPlanRun() : savePlan())}
                >
                  {runningAction ? <Loader2 className="spin" size={14} /> : planDialog === "run" ? <Play size={14} /> : <Layers3 size={14} />}
                  {planDialog === "run" ? "启动评测" : "保存方案"}
                </button>
              </div>
            </footer>
          </div>
        </div>
      )}

      {reportPreview && selectedRun?.reportPaths && (
        <div className="evaluationReportModal" role="dialog" aria-modal="true" aria-label="评测 HTML 报告">
          <div>
            <header><div><FileSpreadsheet size={15} /><strong>{selectedRun.suiteName} · HTML 报告</strong></div><button type="button" title="关闭" onClick={() => setReportPreview(false)}><X size={16} /></button></header>
            <iframe title="评测 HTML 报告" src={`/api/evaluation-lab/runs/${encodeURIComponent(selectedRun.id)}/report.html?inline=true`} />
          </div>
        </div>
      )}
    </main>
  );
}

function EvaluationKpi({
  icon,
  label,
  value,
  hint,
  tone
}: {
  icon?: React.ReactNode;
  label: string;
  value: React.ReactNode;
  hint: string;
  tone?: "success" | "danger" | "score";
}) {
  return <div className={`evaluationKpi${tone ? ` ${tone}` : ""}`}><span>{icon}{label}</span><strong>{value}</strong><em>{hint}</em></div>;
}

function EvaluationStatus({ status, partial = false }: { status: EvaluationRunStatus; partial?: boolean }) {
  const labels: Record<EvaluationRunStatus, string> = {
    queued: "排队中", running: "执行中", completed: "已完成", failed: "编排失败", aborted: "已中止"
  };
  return <i className={`evaluationStatus ${status}`}>{partial ? "部分完成" : labels[status]}</i>;
}

function EvaluationCaseStatus({ status }: { status: EvaluationCaseRunStatus }) {
  const labels: Record<EvaluationCaseRunStatus, string> = {
    queued: "排队", running: "执行中", pass: "通过", fail: "失败", blocked: "阻塞",
    "not-run": "未执行", unknown: "未知", aborted: "中止"
  };
  return <span><i className={`evaluationCaseStatus ${status}`}>{labels[status]}</i></span>;
}

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const text = await response.text();
  let payload: unknown;
  try { payload = text ? JSON.parse(text) : undefined; } catch { payload = text; }
  if (!response.ok) {
    const message = payload && typeof payload === "object" && "error" in payload
      ? String((payload as { error: unknown }).error)
      : `HTTP ${response.status}`;
    throw new Error(message);
  }
  return payload as T;
}

function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}

function clampNumber(value: unknown, min: number, max: number): number {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(min, Math.min(max, Math.round(number))) : min;
}

function round(value: number): number {
  return Math.round(value * 10) / 10;
}

function formatTime(value?: string): string {
  return value ? new Date(value).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }) : "-";
}

function formatDuration(value?: number): string {
  if (value == null) return "-";
  if (value < 1_000) return `${value}ms`;
  if (value < 60_000) return `${round(value / 1_000)}s`;
  return `${Math.floor(value / 60_000)}m ${Math.round((value % 60_000) / 1_000)}s`;
}

function runWallClockDuration(run: EvaluationRun): number | undefined {
  const started = Date.parse(run.startedAt ?? run.createdAt);
  const finished = Date.parse(run.finishedAt ?? new Date().toISOString());
  return Number.isFinite(started) && Number.isFinite(finished)
    ? Math.max(0, finished - started)
    : undefined;
}

function runtimeName(
  runtimes: ExecutionRuntimeStatus[],
  runtimeId?: string,
  modelFallback = false
): string {
  const runtime = runtimes.find((item) => item.id === runtimeId);
  if (modelFallback) return runtime?.currentModel || "底座默认模型";
  return runtime?.name || runtimeId || "当前生效底座";
}

function evaluationTargetLabel(config: EvaluationRunConfig): string {
  if (config.operationType === "computer") {
    return `${config.providerId || "mock"} · ${config.nativeDeliveryMode === "background-safe" ? "严格后台" : "前台兼容"}`;
  }
  const labels: Record<BrowserKernel, string> = {
    playwright: "Playwright 配套 Chromium",
    "uiwarden-embedded": "gui-browser 原子链",
    "external-cdp": "用户浏览器桥接",
    "gui-computer": "本机 gui-browser"
  };
  return labels[config.browserKernel ?? "playwright"];
}

function evaluationChainLabel(config: EvaluationRunConfig): string {
  if (config.operationType === "computer") {
    return `主 Agent → dt-gui-computer-skill → dt-gui-computer Runtime → ${config.providerId || "mock"}`;
  }
  return `主 Agent → dt-gui-browser-skill → dt-gui-browser Runtime → ${config.browserKernel || "playwright"}`;
}

function eventSummary(event: Record<string, unknown>): string {
  const value = event.data;
  if (typeof value === "string") return value.slice(0, 160);
  try {
    return JSON.stringify(value ?? {}).slice(0, 160);
  } catch {
    return String(value ?? "");
  }
}
