import { useCallback, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import {
  Activity,
  AlertTriangle,
  AppWindow,
  Check,
  Clock3,
  Download,
  Eye,
  ExternalLink,
  FileJson,
  Filter,
  Hand,
  ListTree,
  Loader2,
  Play,
  RefreshCw,
  ShieldCheck,
  X
} from "lucide-react";
import { Pagination, usePagination } from "./pagination";
import "./qualityWorkspace.css";

type TestOutcome = "pass" | "fail" | "unknown";
type BrowserKernel = "playwright" | "skill-profile" | "external-cdp" | "uiwarden-embedded" | "gui-computer";
type NativeProviderId = "mock" | "macos-accessibility" | "windows-ui-automation";
type NativeControlMode = "observe" | "agent-control" | "human-control";
type QualityRunSource = "conversation" | "inspection" | "regression" | "ui-operation";

interface UnifiedQualityRun {
  id: string;
  sessionId: string;
  purpose: "test" | "operation";
  source: QualityRunSource;
  sourceName: string;
  status: "idle" | "queued" | "running" | "completed" | "failed" | "aborted" | "waiting-approval";
  outcome: TestOutcome;
  browserKernel: BrowserKernel;
  environmentName?: string;
  startedAt: string;
  finishedAt?: string;
  durationMs?: number;
  summary?: string;
  error?: string;
  artifactsCount: number;
  steps: Array<{ id: string; title: string; status: string; evidencePaths: string[] }>;
  assertions: Array<{ id: string; title: string; status: TestOutcome; evidencePaths: string[] }>;
}

interface QualityDashboard {
  generatedAt: string;
  total: number;
  running: number;
  passed: number;
  failed: number;
  unknown: number;
  aborted: number;
  passRate: number;
  artifactCompletenessRate: number;
  averageDurationMs: number;
  bySource: Record<QualityRunSource, number>;
  trends: Array<{ date: string; total: number; passed: number; failed: number; unknown: number; aborted: number }>;
  recentRuns: UnifiedQualityRun[];
}

interface BusinessEnvironmentOption {
  id: string;
  name: string;
}

interface UiOperationRun {
  id: string;
  taskId: string;
  sessionId: string;
  status: "idle" | "running" | "waiting-approval" | "completed" | "failed" | "aborted";
  startedAt: string;
  finishedAt?: string;
  summary?: string;
  error?: string;
  artifactsCount: number;
  nativeSessionId?: string;
  nativeControlMode?: NativeControlMode;
  nativeArtifactDir?: string;
  pendingApprovalId?: string;
  pendingApprovalSummary?: string;
}

type UiOperationExecutionTarget =
  | { kind: "browser"; browserKernel: BrowserKernel; targetUrl?: string }
  | {
      kind: "native-app";
      providerId: NativeProviderId;
      app: { kind: "bundle-id" | "path" | "name" | "process-id"; value: string };
      displayName?: string;
    };

interface UiOperationTask {
  id: string;
  name: string;
  instruction: string;
  targetUrl?: string;
  businessId?: string;
  browserKernel: BrowserKernel;
  executionTarget: UiOperationExecutionTarget;
  approvalMode: "none" | "manual-finalize";
  createdAt: string;
  updatedAt: string;
  runs: UiOperationRun[];
}

interface NativeAutomationSession {
  sessionId: string;
  providerId: NativeProviderId;
  app: { kind: "bundle-id" | "path" | "name" | "process-id"; value: string };
  controlMode: NativeControlMode;
  state: "active" | "stopped" | "failed";
  artifactDir: string;
  currentSnapshotId?: string;
  snapshotSequence: number;
  eventCount: number;
  stopReason?: string;
  pendingApprovals: Array<{
    challengeId: string;
    actionSummary: string;
    expiresAt: string;
    granted: boolean;
  }>;
}

interface NativeAutomationSnapshot {
  snapshotId: string;
  sequence: number;
  app: { id: string; displayName: string; isRunning: boolean; processId?: number };
  text: string;
  elements: Array<{
    elementId: string;
    role: string;
    name: string;
    value?: string;
    secure: boolean;
    enabled: boolean;
    actions: string[];
  }>;
  captureGaps: string[];
  capturedAt: string;
}

interface NativeRunState {
  session: NativeAutomationSession;
  snapshot?: NativeAutomationSnapshot;
}

interface ArtifactInfo {
  name: string;
  relativePath: string;
  size: number;
  modifiedAt: string;
  kind: "file" | "directory";
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

/** 统一质量看板：聚合现有测试运行。 */
export function QualityDashboardView({ onOpenSession }: {
  onOpenSession: (sessionId: string) => void;
}) {
  const [dashboard, setDashboard] = useState<QualityDashboard>();
  const [runs, setRuns] = useState<UnifiedQualityRun[]>([]);
  const [sourceFilter, setSourceFilter] = useState<QualityRunSource | "">("");
  const [statusFilter, setStatusFilter] = useState<UnifiedQualityRun["status"] | "">("");
  const [outcomeFilter, setOutcomeFilter] = useState<TestOutcome | "operation" | "">("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(undefined);
    try {
      const [nextDashboard, nextRuns] = await Promise.all([
        requestJson<QualityDashboard>("/api/quality/dashboard"),
        requestJson<UnifiedQualityRun[]>("/api/quality/runs?limit=1000")
      ]);
      setDashboard(nextDashboard);
      setRuns(nextRuns);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => {
    if (!dashboard?.running) return;
    const timer = window.setInterval(() => void refresh(), 3000);
    return () => window.clearInterval(timer);
  }, [dashboard?.running, refresh]);

  const maxTrend = Math.max(1, ...(dashboard?.trends.map((point) => point.total) ?? [1]));
  const filteredRuns = useMemo(() => runs.filter((run) => {
    if (sourceFilter && run.source !== sourceFilter) return false;
    if (statusFilter && run.status !== statusFilter) return false;
    if (outcomeFilter === "operation" && run.purpose !== "operation") return false;
    if (outcomeFilter && outcomeFilter !== "operation" && (run.purpose === "operation" || run.outcome !== outcomeFilter)) return false;
    return true;
  }), [outcomeFilter, runs, sourceFilter, statusFilter]);
  const runsPagination = usePagination(filteredRuns, 10);
  return (
    <main className="qualityWorkspace">
      <header className="qualityHeader">
        <div><h1>质量看板</h1><p>统一查看对话、巡检和回归测试的运行质量。</p></div>
        <button type="button" className="qualitySecondaryButton" disabled={loading} onClick={() => void refresh()}>
          {loading ? <Loader2 size={14} className="spin" /> : <RefreshCw size={14} />}刷新
        </button>
      </header>
      {error && <div className="qualityBanner qualityBannerError"><AlertTriangle size={15} />{error}</div>}
      <section className="qualityKpis">
        <QualityKpi label="测试运行" value={dashboard?.total ?? 0} detail={`${dashboard?.running ?? 0} 运行中`} icon={<Activity size={17} />} />
        <QualityKpi label="通过率" value={`${dashboard?.passRate ?? 0}%`} detail={`${dashboard?.passed ?? 0} 通过`} tone="success" icon={<Check size={17} />} />
        <QualityKpi label="失败" value={dashboard?.failed ?? 0} detail={`${dashboard?.unknown ?? 0} 未判定 · ${dashboard?.aborted ?? 0} 中止`} tone="danger" icon={<AlertTriangle size={17} />} />
        <QualityKpi label="证据完整度" value={`${dashboard?.artifactCompletenessRate ?? 0}%`} detail="已完成运行含产物" icon={<ShieldCheck size={17} />} />
        <QualityKpi label="平均耗时" value={formatDuration(dashboard?.averageDurationMs ?? 0)} detail="测试运行" icon={<Clock3 size={17} />} />
      </section>
      <section className="qualityBand">
        <div className="qualitySectionHeading"><div><strong>14 天趋势</strong><span>测试运行量与结果分布</span></div></div>
        <div className="qualityTrend" aria-label="最近十四天质量趋势">
          {(dashboard?.trends ?? []).map((point) => (
            <div className="qualityTrendColumn" key={point.date} title={`${point.date}：${point.total} 次，${point.passed} 通过，${point.failed} 失败，${point.aborted} 中止`}>
              <div className="qualityTrendBar" style={{ height: `${Math.max(5, (point.total / maxTrend) * 100)}%` }}>
                <span className="qualityTrendPass" style={{ height: `${point.total ? (point.passed / point.total) * 100 : 0}%` }} />
                <span className="qualityTrendFail" style={{ height: `${point.total ? (point.failed / point.total) * 100 : 0}%` }} />
              </div>
              <em>{point.date.slice(5)}</em>
            </div>
          ))}
        </div>
      </section>
      <section className="qualityBand qualityRunsBand">
        <div className="qualitySectionHeading qualityRunsHeading">
          <div><strong>最近运行</strong><span>测试与通用操作共享执行视图，但结果语义隔离</span></div>
          <div className="qualityRunFilters" aria-label="运行筛选">
            <Filter size={13} />
            <select aria-label="来源类型" value={sourceFilter} onChange={(event) => { setSourceFilter(event.target.value as QualityRunSource | ""); runsPagination.setPage(1); }}>
              <option value="">全部来源</option>
              <option value="conversation">对话任务</option>
              <option value="inspection">巡检任务</option>
              <option value="regression">回归任务</option>
              <option value="ui-operation">UI 操作</option>
            </select>
            <select aria-label="运行状态" value={statusFilter} onChange={(event) => { setStatusFilter(event.target.value as UnifiedQualityRun["status"] | ""); runsPagination.setPage(1); }}>
              <option value="">全部状态</option>
              <option value="idle">未开始</option><option value="queued">排队中</option><option value="running">运行中</option>
              <option value="waiting-approval">等待审批</option><option value="completed">已完成</option><option value="failed">失败</option><option value="aborted">已中止</option>
            </select>
            <select aria-label="运行结果" value={outcomeFilter} onChange={(event) => { setOutcomeFilter(event.target.value as TestOutcome | "operation" | ""); runsPagination.setPage(1); }}>
              <option value="">全部结果</option>
              <option value="pass">通过</option><option value="fail">不通过</option><option value="unknown">未判定</option><option value="operation">通用操作</option>
            </select>
          </div>
        </div>
        <div className="qualityRunTable">
          <div className="qualityRunRow qualityRunHeader"><span>来源</span><span>任务</span><span>状态</span><span>结果</span><span>环境 / 内核</span><span>耗时</span><span>操作</span></div>
          {runsPagination.pagedItems.map((run) => (
            <div className="qualityRunRow" key={run.id}>
              <span><SourceBadge source={run.source} /></span>
              <span className="qualityRunName"><strong>{run.sourceName}</strong><em>{formatTime(run.startedAt)} · {run.steps?.length ?? 0} 步骤 · {run.assertions?.length ?? 0} 断言</em></span>
              <span><StatusBadge status={run.status} /></span>
              <span><OutcomeBadge purpose={run.purpose} outcome={run.outcome} status={run.status} /></span>
              <span className="qualityRunContext">{run.environmentName || "默认环境"}<em>{kernelLabel(run.browserKernel)}</em></span>
              <span>{formatDuration(run.durationMs ?? 0)}</span>
              <span className="qualityRunActions">
                <button type="button" title="打开运行会话" onClick={() => onOpenSession(run.sessionId)}><ExternalLink size={13} /></button>
              </span>
            </div>
          ))}
          {!filteredRuns.length && <div className="qualityEmpty">没有符合筛选条件的运行</div>}
        </div>
        <Pagination state={runsPagination} />
      </section>
    </main>
  );
}

export function NativeRunPanel({
  task,
  run,
  onChanged,
  onError
}: {
  task: UiOperationTask;
  run: UiOperationRun;
  onChanged: () => Promise<void>;
  onError: (message?: string) => void;
}) {
  const [view, setView] = useState<"tree" | "rep">("tree");
  const [state, setState] = useState<NativeRunState>();
  const [artifacts, setArtifacts] = useState<ArtifactInfo[]>([]);
  const [preview, setPreview] = useState<ArtifactInfo>();
  const [busy, setBusy] = useState(false);

  const load = useCallback(async (observe = false) => {
    if (!run.nativeSessionId) return;
    setBusy(true);
    try {
      const [nativeState, sessionArtifacts] = await Promise.all([
        requestJson<NativeRunState>(`/api/ui-operations/${task.id}/runs/${run.id}/native${observe ? "/observe" : ""}`, observe ? { method: "POST" } : undefined),
        requestJson<ArtifactInfo[]>(`/api/sessions/${run.sessionId}/artifacts`)
      ]);
      setState((current) => ({ ...nativeState, snapshot: nativeState.snapshot ?? current?.snapshot }));
      setArtifacts(sessionArtifacts.filter((artifact) => artifact.kind === "file" && artifact.relativePath.replace(/\\/g, "/").includes(".skill-output/native-reps/")));
      onError(undefined);
    } catch (cause) {
      onError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }, [onError, run.id, run.nativeSessionId, run.sessionId, task.id]);

  // Agent 尚未选定应用时，session.app 是内部占位符。此时 observe 只会产生
  // target-window-not-found；先读取状态，待 Agent 通过 session target/launch 绑定后再观察。
  useEffect(() => { void load(false); }, [load, run.status]);
  useEffect(() => {
    if (run.status !== "running") return;
    const timer = window.setInterval(() => void load(false), 2500);
    return () => window.clearInterval(timer);
  }, [load, run.status]);

  const control = async (mode: "agent-control" | "human-control") => {
    setBusy(true);
    try {
      const result = await requestJson<{ session: NativeAutomationSession }>(`/api/ui-operations/${task.id}/runs/${run.id}/native/control`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode })
      });
      setState((current) => current ? { ...current, session: result.session } : { session: result.session });
      await onChanged();
    } catch (cause) {
      onError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const mutate = async (url: string) => {
    setBusy(true);
    try {
      await requestJson(url, { method: "POST" });
      await onChanged();
      await load(false);
    } catch (cause) {
      onError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const active = run.status === "running" || run.status === "waiting-approval";
  const humanControl = state?.session.controlMode === "human-control" || run.nativeControlMode === "human-control";
  const awaitingAgentTarget = state?.session.app.value === "__agent_select__";
  const snapshot = state?.snapshot;
  const repGroups = groupNativeRepArtifacts(artifacts);

  return (
    <section className="nativeControlPanel">
      <header>
        <div className="nativeControlTitle"><AppWindow size={15} /><strong>原生控制</strong><StatusBadge status={run.status} /><span className={`nativeControlMode ${humanControl ? "human" : "agent"}`}>{humanControl ? "人工控制" : "Agent 控制"}</span></div>
        <div className="qualityHeaderActions">
          {active && <button type="button" className="qualitySecondaryButton" disabled={busy} onClick={() => void control(humanControl ? "agent-control" : "human-control")}>{humanControl ? <Play size={13} /> : <Hand size={13} />}{humanControl ? "继续 Agent" : "接管"}</button>}
          {active && <button type="button" className="qualityDangerButton" disabled={busy} onClick={() => void mutate(`/api/ui-operations/${task.id}/runs/${run.id}/abort`)}><X size={13} />停止</button>}
          <button type="button" className="qualitySecondaryButton" disabled={busy || !active || awaitingAgentTarget} title={awaitingAgentTarget ? "等待 Agent 选择目标应用" : "读取当前可访问性树"} onClick={() => void load(true)}><RefreshCw size={13} />观察</button>
        </div>
      </header>
      <div className="nativeControlSummary">
        <span>会话 <strong>{run.nativeSessionId}</strong></span>
        <span>目标 <strong>{snapshot?.app.displayName || state?.session.app.value || "等待 Agent 选择"}</strong></span>
        <span>快照 <strong>{snapshot?.sequence ?? state?.session.snapshotSequence ?? 0}</strong></span>
        <span>事件 <strong>{state?.session.eventCount ?? 0}</strong></span>
        <span>停止原因 <strong>{state?.session.stopReason || "-"}</strong></span>
      </div>
      {run.pendingApprovalId && <div className="nativeApproval"><ShieldCheck size={14} /><span><strong>{run.pendingApprovalSummary || "敏感动作"}</strong><em>{run.pendingApprovalId}</em></span><button type="button" disabled={busy} onClick={() => void mutate(`/api/ui-operations/${task.id}/runs/${run.id}/approve`)}><Check size={13} />批准</button><button type="button" disabled={busy} onClick={() => void mutate(`/api/ui-operations/${task.id}/runs/${run.id}/reject`)}><X size={13} />拒绝</button></div>}
      <div className="nativePanelTabs" role="tablist" aria-label="原生运行详情">
        <button type="button" className={view === "tree" ? "active" : ""} onClick={() => setView("tree")}><ListTree size={13} />AX Tree<span>{snapshot?.elements.length ?? 0}</span></button>
        <button type="button" className={view === "rep" ? "active" : ""} onClick={() => setView("rep")}><FileJson size={13} />Native Rep<span>{artifacts.length}</span></button>
        <div><a href={`/api/sessions/${run.sessionId}/artifacts/download`} title="下载全部产物"><Download size={13} /></a></div>
      </div>
      {view === "tree" ? (
        <div className="nativeTree">
          {snapshot ? (
            <>
              {snapshot.captureGaps.length > 0 && <div className="nativeCaptureGaps">采集缺口：{snapshot.captureGaps.join("、")}</div>}
              <div className="nativeTreeRows">
                {snapshot.elements.map((element) => (
                  <div className="nativeTreeRow" key={element.elementId}>
                    <span className="nativeTreeRole">{element.role}</span>
                    <span><strong>{element.name || "未命名元素"}</strong><em>{element.value ?? element.elementId}</em></span>
                    <span>{element.secure ? "已脱敏" : element.actions.join(" · ") || "只读"}</span>
                  </div>
                ))}
              </div>
            </>
          ) : <div className="qualityEmpty">{active ? "点击观察读取当前可访问性树" : "该运行结束前未缓存可访问性树"}</div>}
        </div>
      ) : (
        <div className="nativeRepGroups">
          {repGroups.map(([group, entries]) => <section key={group}><h4>{group}</h4>{entries.map((artifact) => <div className={`nativeRepEntry${artifact.name === "manifest.json" ? " core" : ""}`} key={artifact.relativePath}><button type="button" onClick={() => setPreview(artifact)}><Eye size={13} /><span>{artifact.name}</span><em>{formatArtifactSize(artifact.size)}</em></button><a href={`/api/sessions/${run.sessionId}/files/${encodeNativeArtifactPath(artifact.relativePath)}`} download title="下载"><Download size={13} /></a></div>)}</section>)}
          {!artifacts.length && <div className="qualityEmpty">暂无 Native Rep 文件</div>}
        </div>
      )}
      {preview && <div className="nativePreviewModal" role="dialog" aria-modal="true" aria-label={`预览 ${preview.name}`}><div><header><span><FileJson size={14} /><strong>{preview.name === "manifest.json" ? "Native Rep 核心清单" : preview.name}</strong></span><button type="button" title="关闭" onClick={() => setPreview(undefined)}><X size={14} /></button></header><iframe title={preview.name} src={`/api/sessions/${run.sessionId}/preview/${encodeNativeArtifactPath(preview.relativePath)}`} sandbox="allow-scripts" /></div></div>}
    </section>
  );
}

function groupNativeRepArtifacts(artifacts: ArtifactInfo[]): Array<[string, ArtifactInfo[]]> {
  const groups = new Map<string, ArtifactInfo[]>();
  for (const artifact of [...artifacts].sort((a, b) => a.relativePath.localeCompare(b.relativePath))) {
    const normalized = artifact.relativePath.replace(/\\/g, "/").toLowerCase();
    const group = artifact.name === "manifest.json"
      ? "核心清单"
      : normalized.includes("/streams/approvals.")
        ? "审批"
        : normalized.includes("/streams/actions.") || normalized.includes("/streams/events.")
          ? "操作事件"
          : normalized.includes("/streams/snapshots.")
            ? "可访问性快照"
            : normalized.includes("/screenshots/")
              ? "截图"
              : "Schema 与报告";
    groups.set(group, [...(groups.get(group) ?? []), artifact]);
  }
  const order = ["核心清单", "操作事件", "审批", "可访问性快照", "截图", "Schema 与报告"];
  return order.flatMap((group) => groups.has(group) ? [[group, groups.get(group)!] as [string, ArtifactInfo[]]] : []);
}

function formatArtifactSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function encodeNativeArtifactPath(relativePath: string): string {
  return relativePath.replace(/\\/g, "/").split("/").map(encodeURIComponent).join("/");
}

function QualityKpi({ label, value, detail, tone = "default", icon }: { label: string; value: string | number; detail: string; tone?: "default" | "success" | "danger"; icon: ReactNode }) {
  return <div className={`qualityKpi qualityKpi${tone[0].toUpperCase()}${tone.slice(1)}`}><div><span>{icon}{label}</span><strong>{value}</strong><em>{detail}</em></div></div>;
}

function SourceBadge({ source }: { source: QualityRunSource }) {
  const labels: Record<QualityRunSource, string> = { conversation: "对话", inspection: "巡检", regression: "回归", "ui-operation": "UI 操作" };
  return <span className={`qualitySource qualitySource${source.replace("-", "")}`}>{labels[source]}</span>;
}

function StatusBadge({ status }: { status: UnifiedQualityRun["status"] | UiOperationRun["status"] }) {
  const labels: Record<string, string> = { queued: "排队", idle: "未执行", running: "运行中", completed: "已完成", failed: "执行失败", aborted: "已中止", "waiting-approval": "待审批" };
  return <span className={`qualityStatus qualityStatus${status.replace("-", "")}`}>{labels[status] || status}</span>;
}

function OutcomeBadge({ purpose, outcome, status }: { purpose: "test" | "operation"; outcome: TestOutcome; status: UnifiedQualityRun["status"] }) {
  if (purpose === "operation") return <span className="qualityOutcome qualityOutcomeOperation">非测试</span>;
  if (status === "aborted") return <span className="qualityOutcome qualityOutcomeAborted">中止</span>;
  return <span className={`qualityOutcome qualityOutcome${outcome}`}>{outcome === "pass" ? "通过" : outcome === "fail" ? "未通过" : "未判定"}</span>;
}

function kernelLabel(kernel: BrowserKernel): string {
  return ({ playwright: "Playwright Chromium", "skill-profile": "Skill 配置浏览器", "external-cdp": "外部 CDP", "uiwarden-embedded": "内置浏览器", "gui-computer": "本机 gui-browser" } as const)[kernel];
}

function formatDuration(ms: number): string {
  if (!ms) return "-";
  if (ms < 60_000) return `${Math.max(1, Math.round(ms / 1000))} 秒`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)} 分钟`;
  return `${(ms / 3_600_000).toFixed(1)} 小时`;
}

function formatTime(value: string): string {
  return new Date(value).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}
