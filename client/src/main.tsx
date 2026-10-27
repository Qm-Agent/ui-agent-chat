import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  AlertTriangle,
  ArrowLeft,
  Bell,
  Bot,
  CalendarClock,
  Check,
  CheckSquare,
  ChevronLeft,
  ChevronRight,
  Chrome,
  Clock3,
  Copy,
  Download,
  Edit2,
  FileText,
  FlaskConical,
  HelpCircle,
  History,
  Image,
  KeyRound,
  Link2,
  List,
  LayoutDashboard,
  Loader2,
  Maximize2,
  Minimize2,
  MousePointerClick,
  Pause,
  Pencil,
  Paperclip,
  Play,
  Plus,
  RefreshCw,
  Search,
  Send,
  Server,
  Settings,
  ShieldCheck,
  Square,
  Star,
  Cookie,
  Terminal,
  Trash2,
  User,
  Wrench,
  ZoomIn,
  ZoomOut,
  X
} from "lucide-react";
import uiwardenIcon from "./assets/uiwarden-icon.svg";
import { EvaluationLabView } from "./evaluationLab";
import { Pagination, usePagination } from "./pagination";
import { shouldLoadRegressionData, shouldPollView } from "./pollingPolicy";
import { QualityDashboardView } from "./qualityWorkspace";
import { filterRegressionCasesByModule, REGRESSION_CASES_API_PATH } from "./regressionCaseScope";
import { UiOperationsView } from "./uiOperationsChat";
import "./styles.css";

function Modal({
  open,
  title,
  onClose,
  children,
  footer
}: {
  open: boolean;
  title: React.ReactNode;
  onClose: () => void;
  children: React.ReactNode;
  footer?: React.ReactNode;
}) {
  if (!open) {
    return null;
  }
  return (
    <div className="modal-overlay" role="dialog" aria-modal="true" onClick={onClose}>
      <div className="modal-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <div className="modal-title">{title}</div>
          <button className="modal-close" type="button" onClick={onClose} aria-label="关闭">
            <X size={18} />
          </button>
        </div>
        <div className="modal-body">{children}</div>
        {footer ? <div className="modal-footer">{footer}</div> : null}
      </div>
    </div>
  );
}

function RefreshIconButton({
  onRefresh,
  title = "刷新",
  size = 16,
  disabled = false
}: {
  onRefresh: () => void | Promise<void>;
  title?: string;
  size?: number;
  disabled?: boolean;
}) {
  const [refreshing, setRefreshing] = useState(false);
  const handleRefresh = async () => {
    if (refreshing || disabled) return;
    setRefreshing(true);
    try {
      await onRefresh();
    } finally {
      setRefreshing(false);
    }
  };
  return (
    <button
      className="icon-button"
      type="button"
      data-tooltip={refreshing ? "刷新中" : title}
      aria-label={refreshing ? "刷新中" : title}
      aria-busy={refreshing}
      disabled={disabled || refreshing}
      onClick={() => void handleRefresh()}
    >
      {refreshing ? <Loader2 size={size} className="spin" /> : <RefreshCw size={size} />}
    </button>
  );
}

type SessionStatus = "idle" | "running" | "failed" | "completed";
type TestOutcome = "pass" | "fail" | "unknown";

interface UploadedFileInfo {
  id: string;
  originalName: string;
  filename: string;
  path: string;
  size: number;
  mimeType: string;
  createdAt: string;
}

interface ArtifactInfo {
  id: string;
  name: string;
  relativePath: string;
  size: number;
  modifiedAt: string;
  kind: "file" | "directory";
  isCoreReport?: boolean;
}

type ArtifactCategory = "全部" | "Browser Rep" | "Native Rep" | "截图" | "报告" | "操作" | "网络" | "控制台" | "Trace";

interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  createdAt: string;
  files?: UploadedFileInfo[];
  meta?: Record<string, unknown>;
}

interface AgentSession {
  id: string;
  title: string;
  status: SessionStatus;
  /** chat=普通会话（默认）；cdp=CDP 直连会话（桌面客户端，复用本机浏览器登录态多轮协同） */
  kind?: "chat" | "cdp";
  browserKernel: BrowserKernel;
  executionRuntimeId?: ExecutionRuntimeId;
  sdkSessionId?: string;
  createdAt: string;
  updatedAt: string;
  workspacePath: string;
  messages: ChatMessage[];
  files: UploadedFileInfo[];
  artifacts: ArtifactInfo[];
  lastError?: string;
  testOutcome?: TestOutcome;
  testSummary?: string;
}

type BrowserKernel = "playwright" | "skill-profile" | "external-cdp" | "uiwarden-embedded" | "gui-computer";

interface EmbeddedBrowserTab {
  id: string;
  targetId?: string;
  title: string;
  url: string;
  loading: boolean;
  crashed: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
}

interface EmbeddedBrowserDownload {
  id: string;
  filename: string;
  path: string;
  status: string;
  receivedBytes: number;
  totalBytes: number;
}

interface EmbeddedBrowserLibraryEntry {
  id: string;
  title: string;
  url: string;
  createdAt?: string;
  visitedAt?: string;
}

interface EmbeddedBrowserState {
  available: boolean;
  visible: boolean;
  activeTabId: string | null;
  cdpUrl: string;
  controlMode: "idle" | "agent-control" | "human-control";
  activeRunId?: string;
  controlledTargetId?: string;
  downloadDirectory: string;
  downloads: EmbeddedBrowserDownload[];
  bookmarks: EmbeddedBrowserLibraryEntry[];
  history: EmbeddedBrowserLibraryEntry[];
  activeBookmarked: boolean;
  zoomFactor: number;
  tabs: EmbeddedBrowserTab[];
}

interface EmbeddedBrowserApi {
  getState: () => Promise<EmbeddedBrowserState>;
  setVisible: (visible: boolean) => Promise<EmbeddedBrowserState>;
  setBounds: (bounds: { x: number; y: number; width: number; height: number }) => Promise<EmbeddedBrowserState>;
  navigate: (url: string) => Promise<EmbeddedBrowserState>;
  createTab: (url?: string) => Promise<EmbeddedBrowserState>;
  activateTab: (tabId: string) => Promise<EmbeddedBrowserState>;
  closeTab: (tabId: string) => Promise<EmbeddedBrowserState>;
  command: (command: "back" | "forward" | "reload") => Promise<EmbeddedBrowserState>;
  find: (query: string, forward: boolean) => Promise<EmbeddedBrowserState>;
  stopFind: () => Promise<EmbeddedBrowserState>;
  openDownloads: () => Promise<EmbeddedBrowserState>;
  toggleBookmark: () => Promise<EmbeddedBrowserState>;
  removeBookmark: (id: string) => Promise<EmbeddedBrowserState>;
  clearHistory: () => Promise<EmbeddedBrowserState>;
  clearCookies: () => Promise<EmbeddedBrowserState>;
  setZoomFactor: (factor: number) => Promise<EmbeddedBrowserState>;
  openDevTools: () => Promise<EmbeddedBrowserState>;
  setControlMode: (mode: "agent-control" | "human-control") => Promise<EmbeddedBrowserState>;
  onStateChanged: (listener: (state: EmbeddedBrowserState) => void) => () => void;
}

declare global {
  interface Window {
    uiwardenDesktop?: { embeddedBrowser: EmbeddedBrowserApi };
  }
}

type AppView = "dashboard" | "evaluation" | "chat" | "operations" | "inspections" | "environments" | "hosts" | "models" | "regression" | "notify" | "deps" | "skillenv";
type ConfigSection = "browser-skill" | "gui-runtime" | "environments" | "hosts" | "models" | "notify" | "deps";

/* ─── 桌面客户端：依赖环境 / Skill 配置 ─── */
type DepStatus = "ok" | "missing" | "broken";
interface DepCheckResult {
  id: string;
  name: string;
  required: boolean;
  status: DepStatus;
  version?: string;
  detail: string;
  fixable: boolean;
  manualCommand?: string;
}

interface SkillEnvEntry {
  key: string;
  value: string;
  source: "base" | "user";
  sensitive: boolean;
  maskedValue?: string;
  description?: string;
}

/* ─── 桌面客户端：browser-use 浏览器配置 / CDP 直连 ─── */
interface BrowserProfileInfo {
  key: string;
  displayName: string;
  vendor: string;
  version?: string;
  pathEnvKey?: string;
  defaultPath?: string;
  requiresPath: boolean;
}

interface DetectedBrowser {
  vendor: string;
  name: string;
  path: string;
  kind: "chromium" | "firefox" | "standalone";
  profileCompatible: boolean;
  compatibilityNote?: string;
  recommendedKernel?: "gui-computer";
}

interface CdpTab {
  id: string;
  title: string;
  url: string;
  type: string;
}

interface CdpStatus {
  running: boolean;
  mode?: "managed" | "external";
  port: number;
  cdpUrl: string;
  browserVersion?: string;
  browserPath?: string;
  browserName?: string;
  selectedBrowserId?: string;
  tabs?: CdpTab[];
  selectedTabId?: string;
  error?: string;
}

interface CdpBrowserOption {
  id: string;
  name: string;
  vendor: string;
  source: "installed" | "running-cdp" | "firefox-profile" | "embedded-kernel";
  action: "launch-cdp" | "connect-cdp" | "use-firefox-profile" | "use-embedded-kernel";
  path?: string;
  running: boolean;
  connectable: boolean;
  cdpUrl?: string;
  port?: number;
  browserVersion?: string;
  tabsCount?: number;
  note: string;
}

interface CdpBrowserDiscovery {
  browsers: CdpBrowserOption[];
  defaultBrowserId?: string;
  limitation: string;
}

function cdpBrowserOptionLabel(browser: CdpBrowserOption): string {
  if (browser.action === "use-firefox-profile") {
    return `${browser.name} · 已安装（切换 Firefox Profile）`;
  }
  if (browser.action === "use-embedded-kernel") {
    return `${browser.name} · 已安装（切换内置内核）`;
  }
  if (browser.connectable) {
    return `${browser.name} · 可连接 ${browser.tabsCount ?? 0} 个页面`;
  }
  return `${browser.name}${browser.running ? " · 已开启（使用独立 Profile 启动）" : " · 已安装"}`;
}
type InspectionNotifyTrigger = "always" | "failed" | "never";
type InspectionTaskStatus = "idle" | "running" | "disabled";
type InspectionRunStatus = "running" | "completed" | "failed";
type NotifyStatus = "skipped" | "sent" | "failed";

interface InspectionRun {
  id: string;
  taskId: string;
  sessionId: string;
  trigger: "manual" | "schedule";
  status: InspectionRunStatus;
  startedAt: string;
  finishedAt?: string;
  summary?: string;
  error?: string;
  artifactsCount?: number;
  testOutcome?: TestOutcome;
  notifyStatus?: NotifyStatus;
  notifyMessage?: string;
}

interface InspectionTask {
  id: string;
  name: string;
  url: string;
  businessId?: string;
  username?: string;
  prompt?: string;
  scheduleEnabled: boolean;
  scheduleMode?: "interval" | "cron";
  intervalMinutes?: number;
  cronExpression?: string;
  nextRunAt?: string;
  status: InspectionTaskStatus;
  createdAt: string;
  updatedAt: string;
  lastRunAt?: string;
  lastStatus?: InspectionRunStatus;
  lastError?: string;
  runs: InspectionRun[];
  hasPassword: boolean;
  passwordMasked?: string;
  activeRunId?: string;
  notifyRobotId?: string;
  notifyTrigger?: InspectionNotifyTrigger;
}

interface InspectionForm {
  name: string;
  url: string;
  businessId: string;
  username: string;
  password: string;
  prompt: string;
  scheduleEnabled: boolean;
  scheduleMode: "interval" | "cron";
  intervalMinutes: number;
  cronExpression: string;
  notifyRobotId: string;
  notifyTrigger: InspectionNotifyTrigger;
}

interface BusinessEnvironment {
  id: string;
  name: string;
  url: string;
  username?: string;
  description?: string;
  hasPassword: boolean;
  passwordMasked?: string;
}

interface HostEntry {
  id: string;
  ip: string;
  hostname: string;
  comment?: string;
  enabled: boolean;
  updatedAt: string;
}

interface HostApplyStatus {
  applied: boolean;
  message?: string;
  appliedAt?: string;
}

interface ModelProfile {
  id: string;
  runtimeId: ExecutionRuntimeId;
  name: string;
  baseUrl: string;
  model: string;
  smallFastModel?: string;
  sonnetModel?: string;
  haikuModel?: string;
  opusModel?: string;
  isDefault?: boolean;
  isActive?: boolean;
  hasToken: boolean;
  tokenMasked?: string;
  createdAt: string;
  updatedAt: string;
}

interface ModelForm {
  runtimeId: ExecutionRuntimeId;
  name: string;
  baseUrl: string;
  authToken: string;
  model: string;
  smallFastModel: string;
  sonnetModel: string;
  haikuModel: string;
  opusModel: string;
}

type ExecutionRuntimeId = "cfuse" | "codex" | "dtcoder" | "claude-code";

interface ExecutionRuntimeStatus {
  id: ExecutionRuntimeId;
  name: string;
  description: string;
  command: string;
  executable?: string;
  version?: string;
  status: "ready" | "missing" | "broken" | "disabled";
  detail: string;
  selected: boolean;
  default: boolean;
  modelProfile?: ModelProfile;
  currentModel?: string;
  modelSource?: "profile" | "runtime-override" | "cli-config" | "service-env" | "runtime-default" | "unavailable";
  compatibility?: "full" | "compatible" | "unknown";
  warnings?: string[];
  capabilities: {
    stream: boolean;
    resume: boolean;
    modelOverride: boolean;
    sdkHooks: boolean;
    cliToolPolicy: boolean;
  };
}

interface RuntimeModelOption {
  id: string;
  label: string;
  description?: string;
  provider?: string;
  source: "runtime-api" | "local-cache" | "local-config" | "fallback";
}

interface RuntimeModelCatalog {
  runtimeId: ExecutionRuntimeId;
  currentModel?: string;
  defaultModel?: string;
  selectedModel?: string;
  selectionMode: "runtime-default" | "runtime-override" | "profile";
  source: "runtime-api" | "local-cache" | "local-config" | "fallback";
  models: RuntimeModelOption[];
  refreshable: boolean;
  warning?: string;
}

interface RegressionModule {
  id: string;
  name: string;
  description?: string;
  createdAt: string;
  updatedAt: string;
}

interface RegressionCase {
  id: string;
  moduleId: string;
  name: string;
  description?: string;
  prompt: string;
  businessId?: string;
  notifyRobotId?: string;
  notifyTrigger?: InspectionNotifyTrigger;
  createdAt: string;
  updatedAt: string;
}

interface RegressionRun {
  id: string;
  batchId: string;
  caseId: string;
  caseName: string;
  sessionId: string;
  status: "pending" | "running" | "completed" | "failed" | "aborted";
  startedAt?: string;
  finishedAt?: string;
  summary?: string;
  error?: string;
  artifactsCount?: number;
  testOutcome?: TestOutcome;
  notifyStatus?: NotifyStatus;
  notifyMessage?: string;
}

interface RegressionBatch {
  id: string;
  name: string;
  status: "running" | "completed" | "aborted";
  trigger: "manual";
  startedAt: string;
  finishedAt?: string;
  total: number;
  completed: number;
  failed: number;
  aborted: number;
  passed?: number;
  assertFailed?: number;
  unknown?: number;
  runs: RegressionRun[];
  createdAt: string;
  updatedAt: string;
  notifyRobotId?: string;
  notifyTrigger?: InspectionNotifyTrigger;
  notifyStatus?: NotifyStatus;
  notifyMessage?: string;
}

interface RegressionCaseForm {
  moduleId: string;
  name: string;
  description: string;
  prompt: string;
  businessId: string;
  notifyRobotId: string;
  notifyTrigger: InspectionNotifyTrigger;
}

interface DingtalkRobot {
  id: string;
  name: string;
  webhookUrl?: string;
  webhookUrlMasked?: string;
  hasSecret: boolean;
  secretMasked?: string;
  description?: string;
  inspectionTemplate?: string;
  regressionTemplate?: string;
  createdAt: string;
  updatedAt: string;
}

interface DingtalkRobotForm {
  name: string;
  webhookUrl: string;
  secret: string;
  description: string;
  inspectionTemplate: string;
  regressionTemplate: string;
}

interface EnvironmentSelection {
  businessId: string;
  customUrl: string;
  customUsername: string;
  customPassword: string;
}

interface ScreenshotFrame {
  relativePath: string;
  url: string;
  modifiedAt: string;
  stepIndex?: number;
  pageUrl?: string;
  title?: string;
  actionSummary?: string;
  source?: "live" | "result" | "artifact";
}

interface ChatRuntimeState {
  streamingText: string;
  toolEvents: string[];
  processLogs: string[];
  screenshots: ScreenshotFrame[];
  statusLabel?: string;
}

interface StreamPayload {
  type: "session" | "message" | "text" | "tool" | "log" | "screenshot" | "status" | "result" | "artifacts" | "error" | "done";
  data?: unknown;
}

const API = "";
const EMPTY_CHAT_RUNTIME: ChatRuntimeState = {
  streamingText: "",
  toolEvents: [],
  processLogs: [],
  screenshots: []
};

/* ─── 轻量 path 路由（可分享链接） ─── */

interface ParsedRoute {
  view: AppView;
  configSection?: ConfigSection;
  sessionId?: string;
  taskId?: string;
  moduleId?: string;
  batchId?: string;
  runId?: string;
}

/**
 * Parse the current URL into a view + optional entity id.
 *
 * Supported paths:
 *   /                                  -> chat
 *   /sessions/:id                      -> chat with session
 *   /sessions/:id/artifacts            -> chat with session (artifact panel)
 *   /inspections                       -> inspections
 *   /inspections/:taskId               -> inspections with task selected
 *   /regression                        -> regression
 *   /regression/modules/:moduleId      -> regression with module selected
 *   /regression/batches/:batchId       -> regression with batch selected
 *   /regression/batches/:batchId/runs/:runId -> regression batch detail with run selected
 *   /environments                      -> environments
 *   /hosts                             -> hosts
 *   /models                            -> models
 *   /notify                            -> notify
 *
 * Legacy fallbacks (?session= and #/sessions/:id) are honored when the path
 * is "/" so old DingTalk notification links keep working.
 */
function parseRoute(): ParsedRoute {
  if (typeof window === "undefined") return { view: "chat" };
  const path = window.location.pathname.replace(/\/+$/, "") || "/";
  const segments = path.split("/").filter(Boolean);

  // Legacy: bare "/" with ?session= or #/sessions/:id
  if (segments.length === 0) {
    const sessionParam = new URLSearchParams(window.location.search).get("session");
    if (sessionParam) return { view: "chat", sessionId: sessionParam };
    const hashMatch = window.location.hash.match(/^#\/sessions\/([^/]+)/);
    if (hashMatch) return { view: "chat", sessionId: hashMatch[1] };
    return { view: "chat" };
  }

  const [head, ...rest] = segments;
  switch (head) {
    case "sessions":
      if (rest[0]) return { view: "chat", sessionId: decodeURIComponent(rest[0]) };
      return { view: "chat" };
    case "quality":
      return { view: "dashboard" };
    case "evaluation-lab":
      return { view: "evaluation" };
    case "ui-operations":
      return { view: "operations" };
    case "inspections":
      if (rest[0]) return { view: "inspections", taskId: decodeURIComponent(rest[0]) };
      return { view: "inspections" };
    case "regression":
      if (rest[0] === "modules" && rest[1]) {
        return { view: "regression", moduleId: decodeURIComponent(rest[1]) };
      }
      if (rest[0] === "batches" && rest[1]) {
        const runId = rest[2] === "runs" && rest[3] ? decodeURIComponent(rest[3]) : undefined;
        return { view: "regression", batchId: decodeURIComponent(rest[1]), runId };
      }
      return { view: "regression" };
    case "config-center": {
      const section = rest[0] as ConfigSection | undefined;
      const supported: ConfigSection[] = ["browser-skill", "gui-runtime", "environments", "hosts", "models", "notify", "deps"];
      return { view: "skillenv", configSection: section && supported.includes(section) ? section : undefined };
    }
    case "environments":
      return { view: "skillenv", configSection: "environments" };
    case "hosts":
      return { view: "skillenv", configSection: "hosts" };
    case "models":
      return { view: "skillenv", configSection: "models" };
    case "deps":
      return { view: "skillenv", configSection: "deps" };
    case "skill-config":
      return { view: "skillenv", configSection: "browser-skill" };
    case "notify":
      return { view: "skillenv", configSection: "notify" };
    default:
      return { view: "chat" };
  }
}

/** Push a new path onto history without a full page reload. */
function navigate(path: string): void {
  if (typeof window === "undefined") return;
  if (window.location.pathname === path) return;
  window.history.pushState({}, "", path);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

/** 是否运行在 Electron 桌面客户端内。 */
const IS_DESKTOP_APP = typeof navigator !== "undefined" && navigator.userAgent.includes("Electron");

/** 打开会话页：桌面客户端内做应用内 SPA 跳转（window.open 会被主进程
 * setWindowOpenHandler 拦截并抛到外部浏览器）；web 部署保持新标签页行为。 */
function openSessionPage(sessionId: string): void {
  if (IS_DESKTOP_APP) {
    navigate(`/sessions/${sessionId}`);
  } else {
    window.open(`/sessions/${sessionId}`, "_blank");
  }
}

/** Build the canonical shareable path for a given view + entity id.
 *
 * For regression, pass `sub` to target a module ("modules") or batch ("batches")
 * detail page; omit it for the regression root. For a specific run inside a
 * batch, pass `sub="batches"` plus `runId` to produce
 * /regression/batches/:batchId/runs/:runId.
 */
function buildPath(view: AppView, id?: string, sub?: "modules" | "batches", runId?: string): string {
  switch (view) {
    case "dashboard":
      return "/quality";
    case "chat":
      return id ? `/sessions/${encodeURIComponent(id)}` : "/";
    case "evaluation":
      return "/evaluation-lab";
    case "inspections":
      return id ? `/inspections/${encodeURIComponent(id)}` : "/inspections";
    case "operations":
      return "/ui-operations";
    case "regression":
      if (id && sub === "modules") return `/regression/modules/${encodeURIComponent(id)}`;
      if (id && sub === "batches") {
        const base = `/regression/batches/${encodeURIComponent(id)}`;
        return runId ? `${base}/runs/${encodeURIComponent(runId)}` : base;
      }
      return "/regression";
    case "environments":
      return "/environments";
    case "hosts":
      return "/hosts";
    case "models":
      return "/models";
    case "deps":
      return "/deps";
    case "skillenv":
      return "/config-center";
    case "notify":
      return "/notify";
    default:
      return "/";
  }
}

/** Copy the current entity's shareable URL to the clipboard.
 *
 * Uses `buildPath` + `window.location.origin` so the link is absolute and can
 * be pasted into DingTalk / wiki pages. Falls back to a legacy
 * `document.execCommand("copy")` when the async Clipboard API is unavailable
 * (older browsers / non-secure contexts).
 */
async function copyShareLink(view: AppView, id: string, sub?: "modules" | "batches", runId?: string): Promise<boolean> {
  if (!id) return false;
  const path = buildPath(view, id, sub, runId);
  const url = `${window.location.origin}${path}`;
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(url);
      return true;
    }
  } catch {
    // fall through to legacy path
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = url;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

function App() {
  // 从 URL path 解析初始视图与实体 id，替代旧的 ?session= / #/sessions/:id 解析。
  const initialRoute = useMemo(() => parseRoute(), []);
  const [view, setView] = useState<AppView>(initialRoute.view);
  const [configSection, setConfigSection] = useState<ConfigSection>(() => {
    const requested = initialRoute.configSection;
    if (!IS_DESKTOP_APP && requested === "deps") return "environments";
    return requested ?? "browser-skill";
  });
  const [sessions, setSessions] = useState<AgentSession[]>([]);
  const [activeId, setActiveId] = useState<string | undefined>(initialRoute.sessionId);
  const [active, setActive] = useState<AgentSession>();
  const [inspectionTasks, setInspectionTasks] = useState<InspectionTask[]>([]);
  const [activeTaskId, setActiveTaskId] = useState<string | undefined>(initialRoute.taskId);
  const [businessEnvironments, setBusinessEnvironments] = useState<BusinessEnvironment[]>([]);
  const [hostEntries, setHostEntries] = useState<HostEntry[]>([]);
  const [hostStatus, setHostStatus] = useState<HostApplyStatus>({ applied: false });
  const [modelProfiles, setModelProfiles] = useState<ModelProfile[]>([]);
  const [executionRuntimes, setExecutionRuntimes] = useState<ExecutionRuntimeStatus[]>([]);
  const [dingtalkRobots, setDingtalkRobots] = useState<DingtalkRobot[]>([]);
  const [robotForm, setRobotForm] = useState<DingtalkRobotForm>({ name: "", webhookUrl: "", secret: "", description: "", inspectionTemplate: "", regressionTemplate: "" });
  const [editingRobotId, setEditingRobotId] = useState<string | undefined>();
  const [regressionModules, setRegressionModules] = useState<RegressionModule[]>([]);
  const [regressionCases, setRegressionCases] = useState<RegressionCase[]>([]);
  const [regressionBatches, setRegressionBatches] = useState<RegressionBatch[]>([]);
  const [regressionModuleForm, setRegressionModuleForm] = useState<{ name: string; description: string }>({ name: "", description: "" });
  const [regressionCaseForm, setRegressionCaseForm] = useState<RegressionCaseForm>({ moduleId: "", name: "", description: "", prompt: "", businessId: "", notifyRobotId: "", notifyTrigger: "failed" });
  const [activeRegressionModuleId, setActiveRegressionModuleId] = useState<string | undefined>(initialRoute.moduleId);
  const [activeRegressionBatchId, setActiveRegressionBatchId] = useState<string | undefined>(initialRoute.batchId);
  const [activeRegressionBatch, setActiveRegressionBatch] = useState<RegressionBatch>();
  const [activeRegressionRunId, setActiveRegressionRunId] = useState<string | undefined>(initialRoute.runId);
  const [selectedRegressionCaseIds, setSelectedRegressionCaseIds] = useState<Set<string>>(new Set());
  const [copiedLink, setCopiedLink] = useState<string | null>(null);
  // 桌面客户端：启动时检测依赖环境，存在缺失的必需依赖时在侧边栏/横幅提示。
  const [depsAlert, setDepsAlert] = useState(false);
  const [depsBannerDismissed, setDepsBannerDismissed] = useState(false);
  const [environmentSelection, setEnvironmentSelection] = useState<EnvironmentSelection>({
    businessId: "",
    customUrl: "",
    customUsername: "",
    customPassword: ""
  });
  const [inspectionForm, setInspectionForm] = useState<InspectionForm>({
    name: "",
    url: "",
    businessId: "",
    username: "",
    password: "",
    prompt: "",
    scheduleEnabled: false,
    scheduleMode: "cron",
    intervalMinutes: 180,
    cronExpression: "0 */3 * * *",
    notifyRobotId: "",
    notifyTrigger: "failed"
  });
  const [draft, setDraft] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [chatRuntime, setChatRuntime] = useState<Record<string, ChatRuntimeState>>({});
  const [selectedScreenshotIndex, setSelectedScreenshotIndex] = useState(0);
  const [autoFollowScreenshots, setAutoFollowScreenshots] = useState(true);
  const [isPlayingScreenshots, setIsPlayingScreenshots] = useState(false);
  const [isScreenshotViewerOpen, setIsScreenshotViewerOpen] = useState(false);
  const [previewArtifact, setPreviewArtifact] = useState<ArtifactInfo>();
  const [pendingDeleteSession, setPendingDeleteSession] = useState<{ id: string; title: string }>();
  const [deletingSessionId, setDeletingSessionId] = useState<string>();
  const [artifactCategory, setArtifactCategory] = useState<ArtifactCategory>("全部");
  const [historyPaneWidth, setHistoryPaneWidth] = useState(() => {
    const stored = Number(window.localStorage.getItem("uiwarden-chat-history-width"));
    return Number.isFinite(stored) && stored >= 196 && stored <= 420 ? stored : 218;
  });
  const [artifactPanelWidth, setArtifactPanelWidth] = useState(() => {
    const stored = Number(window.localStorage.getItem("uiwarden-artifact-panel-width"));
    return Number.isFinite(stored) && stored >= 260 && stored <= 520 ? stored : 286;
  });
  const [embeddedPaneWidth, setEmbeddedPaneWidth] = useState(58);
  const [embeddedExpanded, setEmbeddedExpanded] = useState(false);
  const [runningSessionIds, setRunningSessionIds] = useState<string[]>([]);
  const [stoppingSessionIds, setStoppingSessionIds] = useState<string[]>([]);
  const [inspectionBusy, setInspectionBusy] = useState(false);
  // 记录“立即执行”正在提交（点击后到服务端返回 run 之前）的任务 id，
  // 用于给对应按钮精确显示 loading，避免用户误以为没点中而重复点击。
  const [triggeringTaskId, setTriggeringTaskId] = useState<string>();
  const [error, setError] = useState<string>();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const chatWorkspaceRef = useRef<HTMLElement>(null);
  const messagesRef = useRef<HTMLElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const activeIdRef = useRef<string>();
  const activeRuntime = activeId ? chatRuntime[activeId] ?? EMPTY_CHAT_RUNTIME : EMPTY_CHAT_RUNTIME;
  const streamingText = activeRuntime.streamingText;
  const toolEvents = activeRuntime.toolEvents;
  const processLogs = activeRuntime.processLogs;

  const updateHistoryPaneWidth = useCallback((width: number) => {
    const workspaceWidth = chatWorkspaceRef.current?.clientWidth ?? 960;
    const maxWidth = Math.max(260, Math.min(420, workspaceWidth - 560));
    const nextWidth = Math.round(Math.min(maxWidth, Math.max(196, width)));
    setHistoryPaneWidth(nextWidth);
    return nextWidth;
  }, []);

  const startHistoryPaneResize = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = historyPaneWidth;
    let latestWidth = startWidth;
    const previousCursor = document.body.style.cursor;
    const previousUserSelect = document.body.style.userSelect;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    const onPointerMove = (moveEvent: PointerEvent) => {
      latestWidth = updateHistoryPaneWidth(startWidth + moveEvent.clientX - startX);
    };
    const onPointerUp = () => {
      window.removeEventListener("pointermove", onPointerMove);
      document.body.style.cursor = previousCursor;
      document.body.style.userSelect = previousUserSelect;
      window.localStorage.setItem("uiwarden-chat-history-width", String(latestWidth));
    };
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp, { once: true });
  }, [historyPaneWidth, updateHistoryPaneWidth]);

  const updateArtifactPanelWidth = useCallback((width: number) => {
    const maxWidth = Math.max(320, Math.min(520, window.innerWidth - 796));
    const nextWidth = Math.round(Math.min(maxWidth, Math.max(260, width)));
    setArtifactPanelWidth(nextWidth);
    return nextWidth;
  }, []);

  const startArtifactPanelResize = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = artifactPanelWidth;
    let latestWidth = startWidth;
    const previousCursor = document.body.style.cursor;
    const previousUserSelect = document.body.style.userSelect;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    const onPointerMove = (moveEvent: PointerEvent) => {
      latestWidth = updateArtifactPanelWidth(startWidth + startX - moveEvent.clientX);
    };
    const onPointerUp = () => {
      window.removeEventListener("pointermove", onPointerMove);
      document.body.style.cursor = previousCursor;
      document.body.style.userSelect = previousUserSelect;
      window.localStorage.setItem("uiwarden-artifact-panel-width", String(latestWidth));
    };
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp, { once: true });
  }, [artifactPanelWidth, updateArtifactPanelWidth]);
  const screenshots = activeRuntime.screenshots;
  const activeBusy = Boolean(activeId && runningSessionIds.includes(activeId));
  const activeObserving = activeBusy || active?.status === "running";

  function updateRuntime(sessionId: string, updater: (current: ChatRuntimeState) => ChatRuntimeState) {
    setChatRuntime((prev) => ({
      ...prev,
      [sessionId]: updater(prev[sessionId] ?? EMPTY_CHAT_RUNTIME)
    }));
  }

  function resetRuntime(sessionId: string, screenshots: ScreenshotFrame[] = []) {
    setChatRuntime((prev) => ({
      ...prev,
      [sessionId]: {
        streamingText: "",
        toolEvents: [],
        processLogs: [],
        screenshots,
        statusLabel: undefined
      }
    }));
  }

  async function stopTestSession(sessionId: string) {
    if (stoppingSessionIds.includes(sessionId)) return;
    setStoppingSessionIds((current) => [...current, sessionId]);
    setError(undefined);
    try {
      const result = await requestJson<{ stopped: boolean; message: string }>(
        `/api/sessions/${encodeURIComponent(sessionId)}/stop`,
        { method: "POST" }
      );
      updateRuntime(sessionId, (current) => ({
        ...current,
        statusLabel: result.stopped ? "正在停止任务并封装已有产物" : current.statusLabel
      }));
      if (!result.stopped) setError(result.message);
    } catch (stopError) {
      setError(stopError instanceof Error ? stopError.message : String(stopError));
    } finally {
      setStoppingSessionIds((current) => current.filter((id) => id !== sessionId));
    }
  }

  useEffect(() => {
    void loadSessions();
    void loadInspectionTasks();
    void loadBusinessEnvironments();
    void loadHostEntries();
    void loadModelProfiles();
    void loadExecutionRuntimes();
    void loadDingtalkRobots();
    // 路由带来的初始实体：按需拉取对应详情
    if (initialRoute.sessionId) {
      void loadSession(initialRoute.sessionId);
    }
    if (initialRoute.taskId) {
      setActiveTaskId(initialRoute.taskId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!shouldLoadRegressionData(view)) return;
    void loadRegressionModules();
    void loadRegressionCases();
    void loadRegressionBatches();
    if (activeRegressionBatchId) {
      void loadRegressionBatch(activeRegressionBatchId);
    }
    // 进入回归工作区时统一刷新；实体切换由导航和操作处理器自行更新。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view]);

  // 浏览器前进/后退时重新解析 path 路由，同步当前视图与实体 id
  useEffect(() => {
    const onPop = () => {
      const route = parseRoute();
      setView(route.view);
      if (route.configSection) {
        setConfigSection(!IS_DESKTOP_APP && route.configSection === "deps"
          ? "environments"
          : route.configSection);
      }
      if (route.sessionId) setActiveId(route.sessionId);
      if (route.taskId) setActiveTaskId(route.taskId);
      if (route.moduleId) {
        setActiveRegressionModuleId(route.moduleId);
      }
      if (route.batchId) {
        setActiveRegressionBatchId(route.batchId);
        void loadRegressionBatch(route.batchId);
      }
      if (route.runId) {
        setActiveRegressionRunId(route.runId);
      } else {
        setActiveRegressionRunId(undefined);
      }
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 桌面客户端：启动时检测一次依赖环境，必需依赖缺失时点亮侧边栏红点 + 对话页横幅。
  useEffect(() => {
    if (!IS_DESKTOP_APP) return;
    void (async () => {
      try {
        const data = await requestJson<{ desktop: boolean; deps: DepCheckResult[] }>("/api/deps");
        setDepsAlert(data.deps.some((dep) => dep.required && dep.status !== "ok"));
      } catch {
        // 检测失败不阻塞主界面
      }
    })();
  }, []);

  useEffect(() => {
    activeIdRef.current = activeId;
    if (activeId) {
      void loadSession(activeId);
      setAutoFollowScreenshots(true);
      setArtifactCategory("全部");
      setPreviewArtifact(undefined);
    }
  }, [activeId]);

  useEffect(() => {
    const container = messagesRef.current;
    if (!container) {
      return;
    }
    container.scrollTo({ top: container.scrollHeight, behavior: "smooth" });
  }, [active?.messages.length, streamingText, toolEvents.length, processLogs.length]);

  useEffect(() => {
    if (!screenshots.length) {
      setSelectedScreenshotIndex(0);
      setIsPlayingScreenshots(false);
      return;
    }
    setSelectedScreenshotIndex((prev) => Math.min(prev, screenshots.length - 1));
    if (activeBusy && autoFollowScreenshots) {
      setSelectedScreenshotIndex(screenshots.length - 1);
    }
  }, [activeBusy, autoFollowScreenshots, screenshots.length]);

  useEffect(() => {
    if (!isScreenshotViewerOpen || !isPlayingScreenshots || screenshots.length < 2) {
      return;
    }
    const timer = setInterval(() => {
      setSelectedScreenshotIndex((prev) => (prev + 1) % screenshots.length);
    }, 900);
    return () => clearInterval(timer);
  }, [isPlayingScreenshots, isScreenshotViewerOpen, screenshots.length]);

  useEffect(() => {
    if (!shouldPollView(view, "chat", activeObserving) || !activeId) {
      return;
    }
    let stopped = false;
    const pollSessionId = activeId;
    const refreshLiveArtifacts = async () => {
      try {
        const artifacts = await requestJson<ArtifactInfo[]>(`/api/sessions/${pollSessionId}/artifacts`);
        if (stopped) {
          return;
        }
        setActive((prev) => (prev && prev.id === pollSessionId ? { ...prev, artifacts } : prev));
        updateRuntime(pollSessionId, (current) => ({
          ...current,
          screenshots: mergeScreenshotFrames(current.screenshots, screenshotArtifacts(pollSessionId, artifacts))
        }));
      } catch {
        // SSE remains the primary channel; polling is a best-effort live screenshot fallback.
      }
    };
    void refreshLiveArtifacts();
    const timer = window.setInterval(refreshLiveArtifacts, 1500);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [activeObserving, activeId, view]);

  useEffect(() => {
    if (!activeId || !shouldPollView(view, "chat", !activeBusy && active?.status === "running")) {
      return;
    }
    let stopped = false;
    const pollSessionId = activeId;
    const refreshRunningSession = async () => {
      try {
        // P0：只刷新当前运行会话详情；侧栏元信息由 loadSession 内就地合并，
        // 不再每 2s 调 loadSessions() 全表拉取所有会话的全量 messages/artifacts。
        await loadSession(pollSessionId);
      } catch {
        // A running session may have been deleted or completed between polls.
      }
    };
    const timer = window.setInterval(() => {
      if (!stopped) {
        void refreshRunningSession();
      }
    }, 2000);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [active?.status, activeBusy, activeId, view]);

  // 巡检任务运行中轮询：后端 executeInspectionRun 是 fire-and-forget，需前端轮询才能感知完成。
  // P2：依赖改为稳定布尔 hasRunningInspection，而非整个 inspectionTasks 数组。
  // 否则每次轮询 setInspectionTasks 都会让 useEffect teardown/重建 interval（抖动），
  // 产生瞬时多余请求。interval 只在"是否有运行中任务"翻转时重建。
  const hasRunningInspection = inspectionTasks.some((task) => task.status === "running");
  useEffect(() => {
    if (!shouldPollView(view, "inspections", hasRunningInspection)) {
      return;
    }
    let stopped = false;
    const timer = window.setInterval(() => {
      if (!stopped) {
        void loadInspectionTasks();
      }
    }, 2000);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [hasRunningInspection, view]);

  const activeTask = useMemo(
    () => inspectionTasks.find((task) => task.id === activeTaskId),
    [activeTaskId, inspectionTasks]
  );

  // ─── 分页 Hooks ───
  const sessionsPagination = usePagination(sessions, 30);
  const visibleArtifacts = useMemo(() => {
    const entries = active ? downloadableArtifacts(active.artifacts) : [];
    return artifactCategory === "全部"
      ? entries
      : entries.filter((artifact) => artifactMatchesCategory(artifact, artifactCategory));
  }, [active, artifactCategory]);
  const artifactsPagination = usePagination(visibleArtifacts, 30);

  // 历史消息：流式消息始终展示在底部以保留实时滚动体验；消息区不做分页，完整展示
  const historicalMessages = active?.messages ?? [];
  const showStreamingBubble = Boolean(streamingText || toolEvents.length);

  async function loadSessions() {
    const data = await requestJson<AgentSession[]>("/api/sessions");
    setSessions(data);
    if (!activeId && data[0]) {
      setActiveId(data[0].id);
    }
  }

  async function loadSession(id: string) {
    const data = await requestJson<AgentSession>(`/api/sessions/${id}`);
    if (activeIdRef.current === id) {
      setActive(data);
    }
    // P0：运行中轮询只刷新当前会话详情即可，无需再全表拉 /api/sessions。
    // 把侧栏列表里该会话的元信息（status/title/updatedAt/testOutcome）就地合并，
    // 保持侧栏与详情一致，且不产生额外网络请求。
    // 注意：巡检/回归等服务端后台创建的会话可能不在已加载的列表里
    //（列表只在进入页面时拉一次），此时必须插入到列表头部，否则会出现
    //"跳转能打开、但会话列表里看不到记录"的不一致。
    setSessions((prev) => {
      if (!prev.some((s) => s.id === id)) {
        const summary: AgentSession = { ...data, messages: [], artifacts: [] };
        return [summary, ...prev];
      }
      return prev.map((s) =>
        s.id === id
          ? {
              ...s,
              title: data.title,
              status: data.status,
              updatedAt: data.updatedAt,
              testOutcome: data.testOutcome,
              testSummary: data.testSummary,
              lastError: data.lastError
            }
          : s
      );
    });
    updateRuntime(id, (current) => ({
      ...current,
      screenshots: mergeScreenshotFrames(screenshotArtifacts(id, data.artifacts), current.screenshots)
    }));
  }

  async function loadInspectionTasks() {
    const data = await requestJson<InspectionTask[]>("/api/inspection-tasks");
    setInspectionTasks(data);
    // 列表优先：不再自动选中第一个任务，避免删除/回退后误跳进详情页。
    // 若当前 activeTaskId 已不在列表中（被删除），则清空回到列表视图。
    if (activeTaskId && !data.some((t) => t.id === activeTaskId)) {
      setActiveTaskId("");
    }
  }

  async function loadBusinessEnvironments() {
    setBusinessEnvironments(await requestJson<BusinessEnvironment[]>("/api/business-environments"));
  }

  async function loadHostEntries() {
    const data = await requestJson<{ entries: HostEntry[]; status: HostApplyStatus }>("/api/host-entries");
    setHostEntries(data.entries);
    setHostStatus(data.status);
  }

  async function loadModelProfiles() {
    setModelProfiles(await requestJson<ModelProfile[]>("/api/models"));
  }

  async function loadExecutionRuntimes() {
    setExecutionRuntimes(await requestJson<ExecutionRuntimeStatus[]>("/api/execution-runtimes"));
  }

  async function selectExecutionRuntime(runtimeId: ExecutionRuntimeId) {
    const data = await requestJson<{ runtimes: ExecutionRuntimeStatus[]; profiles: ModelProfile[] }>(
      "/api/execution-runtime",
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ runtimeId })
      }
    );
    setExecutionRuntimes(data.runtimes);
    setModelProfiles(data.profiles);
  }

  async function saveModelProfile(input: ModelForm & { id?: string }) {
    await requestJson<ModelProfile>(input.id ? `/api/models/${input.id}` : "/api/models", {
      method: input.id ? "PUT" : "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input)
    });
    await loadModelProfiles();
  }

  async function deleteModelProfile(id: string) {
    setModelProfiles(await requestJson<ModelProfile[]>(`/api/models/${id}`, { method: "DELETE" }));
  }

  async function activateModelProfile(id: string) {
    await requestJson<ModelProfile[]>(`/api/models/${id}/activate`, { method: "POST" });
    await Promise.all([loadModelProfiles(), loadExecutionRuntimes()]);
  }

  async function selectRuntimeCatalogModel(
    runtimeId: ExecutionRuntimeId,
    model?: string
  ): Promise<RuntimeModelCatalog> {
    const data = await requestJson<{
      profiles: ModelProfile[];
      catalog: RuntimeModelCatalog;
      runtimes: ExecutionRuntimeStatus[];
    }>(`/api/execution-runtimes/${runtimeId}/model-selection`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: model || null })
    });
    setModelProfiles(data.profiles);
    setExecutionRuntimes(data.runtimes);
    return data.catalog;
  }

  async function loadDingtalkRobots() {
    setDingtalkRobots(await requestJson<DingtalkRobot[]>("/api/dingtalk-robots"));
  }

  async function saveDingtalkRobot(input: DingtalkRobotForm & { id?: string }) {
    await requestJson<DingtalkRobot>(input.id ? `/api/dingtalk-robots/${input.id}` : "/api/dingtalk-robots", {
      method: input.id ? "PUT" : "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input)
    });
    await loadDingtalkRobots();
  }

  async function deleteDingtalkRobot(id: string) {
    await requestJson(`/api/dingtalk-robots/${id}`, { method: "DELETE" });
    await loadDingtalkRobots();
  }

  async function testDingtalkRobot(id: string) {
    const res = await requestJson<{ ok: boolean; errmsg?: string }>(`/api/dingtalk-robots/${id}/test`, { method: "POST" });
    if (res.ok) {
      alert("测试消息已发送，请到钉钉群查收");
    } else {
      alert(`测试失败：${res.errmsg ?? "未知错误"}`);
    }
  }

  async function loadRegressionModules() {
    setRegressionModules(await requestJson<RegressionModule[]>("/api/regression/modules"));
  }

  async function loadRegressionCases() {
    setRegressionCases(await requestJson<RegressionCase[]>(REGRESSION_CASES_API_PATH));
  }

  async function loadRegressionBatches() {
    setRegressionBatches(await requestJson<RegressionBatch[]>("/api/regression/batches"));
  }

  async function loadRegressionBatch(id: string) {
    setActiveRegressionBatch(await requestJson<RegressionBatch>(`/api/regression/batches/${id}`));
  }

  async function saveRegressionModule(input: { id?: string; name: string; description: string }) {
    const url = input.id ? `/api/regression/modules/${input.id}` : "/api/regression/modules";
    await requestJson<RegressionModule>(url, {
      method: input.id ? "PUT" : "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: input.name, description: input.description })
    });
    await loadRegressionModules();
    setRegressionModuleForm({ name: "", description: "" });
  }

  async function deleteRegressionModule(id: string) {
    await requestJson(`/api/regression/modules/${id}`, { method: "DELETE" });
    await loadRegressionModules();
    await loadRegressionCases();
    if (activeRegressionModuleId === id) {
      setActiveRegressionModuleId(undefined);
    }
  }

  async function saveRegressionCase(input: RegressionCaseForm & { id?: string }) {
    const url = input.id ? `/api/regression/cases/${input.id}` : "/api/regression/cases";
    await requestJson<RegressionCase>(url, {
      method: input.id ? "PUT" : "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input)
    });
    await loadRegressionCases();
    setRegressionCaseForm({ moduleId: "", name: "", description: "", prompt: "", businessId: "", notifyRobotId: "", notifyTrigger: "failed" });
  }

  async function deleteRegressionCase(id: string) {
    await requestJson(`/api/regression/cases/${id}`, { method: "DELETE" });
    await loadRegressionCases();
  }

  async function runRegressionBatch(
    caseIds: string[],
    name: string,
    options?: { notifyRobotId?: string; notifyTrigger?: InspectionNotifyTrigger }
  ) {
    const batch = await requestJson<RegressionBatch>(`/api/regression/batches`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ caseIds, name, notifyRobotId: options?.notifyRobotId, notifyTrigger: options?.notifyTrigger })
    });
    await loadRegressionBatches();
    setActiveRegressionBatchId(batch.id);
    setActiveRegressionBatch(batch);
    setSelectedRegressionCaseIds(new Set());
  }

  async function abortRegressionBatch(id: string) {
    await requestJson<RegressionBatch>(`/api/regression/batches/${id}/abort`, { method: "POST" });
    await loadRegressionBatches();
    if (activeRegressionBatchId === id) {
      await loadRegressionBatch(id);
    }
  }

  async function deleteRegressionBatch(id: string) {
    await requestJson(`/api/regression/batches/${id}`, { method: "DELETE" });
    await loadRegressionBatches();
    if (activeRegressionBatchId === id) {
      setActiveRegressionBatchId(undefined);
      setActiveRegressionBatch(undefined);
    }
  }

  async function deleteRegressionRun(batchId: string, runId: string) {
    await requestJson(`/api/regression/batches/${batchId}/runs/${runId}`, { method: "DELETE" });
    await loadRegressionBatches();
    if (activeRegressionBatchId === batchId) {
      await loadRegressionBatch(batchId);
    }
  }

  // 回归批次运行中轮询
  // P2：回归批次轮询同样避免依赖整个 regressionBatches 数组导致 interval 抖动。
  // 依赖改为稳定布尔 hasRunningRegression；activeRegressionBatchId 通过 ref 读最新值，
  // interval 只在"是否有运行中批次/用例"翻转时重建。
  const hasRunningRegression =
    regressionBatches.some((b) => b.status === "running") ||
    Boolean(activeRegressionBatch?.runs.some((r) => r.status === "running"));
  const activeRegressionBatchIdRef = useRef(activeRegressionBatchId);
  activeRegressionBatchIdRef.current = activeRegressionBatchId;
  useEffect(() => {
    if (!shouldPollView(view, "regression", hasRunningRegression)) {
      return;
    }
    let stopped = false;
    const timer = window.setInterval(() => {
      if (!stopped) {
        void loadRegressionBatches();
        const currentId = activeRegressionBatchIdRef.current;
        if (currentId) {
          void loadRegressionBatch(currentId);
        }
      }
    }, 2500);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [hasRunningRegression, view]);

  async function newSession(browserKernel?: BrowserKernel) {
    const payload = browserKernel ? {
      title: browserKernel === "external-cdp"
        ? "CDP 直连会话"
        : browserKernel === "uiwarden-embedded"
          ? "内置浏览器会话"
        : browserKernel === "gui-computer" ? "本机 gui-browser 会话" : "新的 UI 测试会话",
      browserKernel
    } : {};
    const session = await requestJson<AgentSession>("/api/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    setSessions((prev) => [session, ...prev]);
    setActiveId(session.id);
    setActive(session);
    resetRuntime(session.id);
    setError(undefined);
    navigate(buildPath("chat", session.id));
  }

  async function changeBrowserKernel(browserKernel: BrowserKernel) {
    if (!active || activeBusy) return;
    const updated = await requestJson<AgentSession>(`/api/sessions/${active.id}/browser-kernel`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ browserKernel })
    });
    setActive(updated);
    setSessions((prev) => prev.map((item) => item.id === updated.id ? { ...item, ...updated } : item));
    setEmbeddedExpanded(false);
  }

  async function useDetectedFirefox(executablePath: string) {
    await requestJson("/api/browser-profiles/select", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: executablePath })
    });
    await changeBrowserKernel("skill-profile");
  }

  async function diagnoseBrowserArtifacts() {
    if (!active) return;
    try {
      const result = await requestJson<{ artifacts: ArtifactInfo[] }>(`/api/sessions/${active.id}/browser-artifacts/diagnose`, {
        method: "POST"
      });
      setActive((prev) => prev ? { ...prev, artifacts: result.artifacts } : prev);
      const diagnosis = result.artifacts.find((artifact) => artifact.relativePath.endsWith("/diagnosis.md"))
        ?? result.artifacts.find((artifact) => artifact.relativePath.endsWith("/diagnosis.json"));
      setArtifactCategory("报告");
      if (diagnosis) setPreviewArtifact(diagnosis);
      setError(undefined);
    } catch (diagnoseError) {
      setError(diagnoseError instanceof Error ? diagnoseError.message : String(diagnoseError));
    }
  }

  async function deleteChatSession(id: string) {
    const session = sessions.find((item) => item.id === id);
    if (!session || runningSessionIds.includes(id)) {
      setError("运行中的会话不能删除");
      return;
    }
    await requestJson(`/api/sessions/${id}`, { method: "DELETE" });
    const nextSessions = sessions.filter((item) => item.id !== id);
    setSessions(nextSessions);
    setChatRuntime((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
    if (activeId === id) {
      const next = nextSessions[0];
      setActiveId(next?.id);
      setActive(next);
      if (next) {
        resetRuntime(next.id, screenshotArtifacts(next.id, next.artifacts));
      }
    }
  }

  async function confirmDeleteChatSession() {
    if (!pendingDeleteSession || deletingSessionId) return;
    setDeletingSessionId(pendingDeleteSession.id);
    try {
      await deleteChatSession(pendingDeleteSession.id);
      setPendingDeleteSession(undefined);
      setError(undefined);
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : String(deleteError));
    } finally {
      setDeletingSessionId(undefined);
    }
  }

  async function sendMessage() {
    if (!active || runningSessionIds.includes(active.id) || (!draft.trim() && !files.length)) {
      return;
    }
    const runSessionId = active.id;
    setRunningSessionIds((prev) => (prev.includes(runSessionId) ? prev : [...prev, runSessionId]));
    setError(undefined);
    resetRuntime(runSessionId);
    setSelectedScreenshotIndex(0);
    setAutoFollowScreenshots(true);

    const form = new FormData();
    form.append("message", draft.trim());
    form.append("businessId", environmentSelection.businessId);
    form.append("customUrl", environmentSelection.customUrl);
    form.append("customUsername", environmentSelection.customUsername);
    form.append("customPassword", environmentSelection.customPassword);
    for (const file of files) {
      form.append("files", file);
    }
    setDraft("");
    setFiles([]);

    // Optimistic update: show user message immediately
    const optimisticMessage: ChatMessage = {
      id: `optimistic-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
      role: "user",
      content: draft.trim(),
      createdAt: new Date().toISOString(),
      files: files.length ? files.map((f) => ({ id: f.name, originalName: f.name, filename: f.name, path: f.name, size: f.size, mimeType: f.type, createdAt: new Date().toISOString() })) : []
    };
    setActive((prev) =>
      prev && prev.id === runSessionId
        ? { ...prev, messages: [...prev.messages, optimisticMessage], status: "running" }
        : prev
    );

    try {
      const response = await fetch(`${API}/api/sessions/${runSessionId}/messages`, {
        method: "POST",
        body: form
      });
      if (!response.ok || !response.body) {
        throw new Error(await response.text());
      }
      await readSse(response.body, (payload) => {
        if (payload.type === "message") {
          const serverMsg = payload.data as ChatMessage;
          // Replace optimistic user message with server-confirmed one (same role, similar content)
          setActive((prev) => {
            if (!prev || prev.id !== runSessionId) return prev;
            const hasOptimistic = prev.messages.some(
              (m) => m.role === serverMsg.role && m.id === optimisticMessage.id
            );
            if (hasOptimistic && serverMsg.role === "user") {
              // Replace optimistic message with server version
              return {
                ...prev,
                messages: prev.messages.map((m) =>
                  m.id === optimisticMessage.id ? serverMsg : m
                ),
                status: "running"
              };
            }
            // New message from server (e.g. assistant), append it
            return { ...prev, messages: [...prev.messages, serverMsg], status: "running" };
          });
          setSessions((prev) =>
            prev.map((session) =>
              session.id === runSessionId ? { ...session, status: "running", updatedAt: new Date().toISOString() } : session
            )
          );
        }
        if (payload.type === "text") {
          updateRuntime(runSessionId, (current) => ({
            ...current,
            streamingText: current.streamingText + String(payload.data ?? "")
          }));
        }
        if (payload.type === "tool") {
          const tool = payload.data as Record<string, unknown>;
          const phase = String(tool.phase ?? "");
          const name = tool.name ? ` ${String(tool.name)}` : "";
          if (phase === "start" || phase === "stop") {
            updateRuntime(runSessionId, (current) => ({
              ...current,
              toolEvents: [...current.toolEvents.slice(-8), `${phase}${name}`]
            }));
          }
        }
        if (payload.type === "log") {
          updateRuntime(runSessionId, (current) => ({
            ...current,
            processLogs: [...current.processLogs.slice(-160), String(payload.data ?? "")]
          }));
        }
        if (payload.type === "status") {
          const status = payload.data as { label?: string };
          if (status.label) {
            updateRuntime(runSessionId, (current) => ({
              ...current,
              statusLabel: status.label
            }));
          }
        }
        if (payload.type === "screenshot") {
          const frame = payload.data as ScreenshotFrame;
          updateRuntime(runSessionId, (current) => {
            if (!frame?.relativePath) {
              return current;
            }
            return {
              ...current,
              screenshots: mergeScreenshotFrames(current.screenshots, [frame])
            };
          });
        }
        if (payload.type === "artifacts") {
          setActive((prev) =>
            prev && prev.id === runSessionId ? { ...prev, artifacts: payload.data as ArtifactInfo[] } : prev
          );
          updateRuntime(runSessionId, (current) => ({
            ...current,
            screenshots: mergeScreenshotFrames(current.screenshots, screenshotArtifacts(runSessionId, payload.data as ArtifactInfo[]))
          }));
        }
        if (payload.type === "error") {
          if (activeIdRef.current === runSessionId) {
            setError(String(payload.data ?? "执行失败"));
          }
        }
      });
      if (activeIdRef.current === runSessionId) {
        await loadSession(runSessionId);
      }
      await loadSessions();
    } catch (err) {
      if (activeIdRef.current === runSessionId) {
        setError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      setRunningSessionIds((prev) => prev.filter((id) => id !== runSessionId));
      updateRuntime(runSessionId, (current) => ({
        ...current,
        streamingText: "",
        toolEvents: []
      }));
    }
  }

  async function createInspectionTask() {
    if (!inspectionForm.url.trim() || inspectionBusy) {
      setError("请填写巡检 URL");
      return;
    }
    setInspectionBusy(true);
    setError(undefined);
    try {
      const task = await requestJson<InspectionTask>("/api/inspection-tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(inspectionForm)
      });
      setInspectionTasks((prev) => [task, ...prev]);
      setActiveTaskId(task.id);
      setInspectionForm({
        name: "",
        url: "",
        businessId: "",
        username: "",
        password: "",
        prompt: "",
        scheduleEnabled: false,
        scheduleMode: "cron",
        intervalMinutes: 180,
        cronExpression: "0 */3 * * *",
        notifyRobotId: "",
        notifyTrigger: "failed"
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setInspectionBusy(false);
    }
  }

  async function updateInspectionTask(taskId: string, form: InspectionForm) {
    if (!form.url.trim() || inspectionBusy) {
      setError("请填写巡检 URL");
      return false;
    }
    setInspectionBusy(true);
    setError(undefined);
    try {
      const task = await requestJson<InspectionTask>(`/api/inspection-tasks/${taskId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form)
      });
      setInspectionTasks((prev) => prev.map((item) => (item.id === taskId ? task : item)));
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return false;
    } finally {
      setInspectionBusy(false);
    }
  }

  async function triggerInspectionTask(taskId: string) {
    if (inspectionBusy) {
      return;
    }
    setInspectionBusy(true);
    setTriggeringTaskId(taskId);
    setError(undefined);
    try {
      const run = await requestJson<InspectionRun>(`/api/inspection-tasks/${taskId}/runs`, {
        method: "POST"
      });
      setActiveTaskId(taskId);
      await loadInspectionTasks();
      // Activate the just-triggered run so the detail panel reflects it.
      // loadInspectionTasks() 已经从服务端拉回该 run，这里按 id 去重后再前置，
      // 避免短暂出现两条相同执行记录。
      if (run?.id) {
        setInspectionTasks((prev) =>
          prev.map((task) =>
            task.id === taskId
              ? {
                  ...task,
                  activeRunId: run.id,
                  status: "running",
                  lastStatus: "running",
                  lastRunAt: run.startedAt,
                  runs: [run, ...task.runs.filter((r) => r.id !== run.id)]
                }
              : task
          )
        );
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setInspectionBusy(false);
      setTriggeringTaskId(undefined);
    }
  }

  async function abortInspectionTask(taskId: string) {
    const task = inspectionTasks.find((item) => item.id === taskId);
    const latestRun = task?.runs?.[0];
    if (!latestRun || latestRun.status !== "running") {
      setError("当前任务没有正在执行的巡检");
      return;
    }
    setInspectionBusy(true);
    setError(undefined);
    try {
      await requestJson<{ ok: boolean; aborted: boolean }>(
        `/api/inspection-tasks/${taskId}/runs/${latestRun.id}/abort`,
        { method: "POST" }
      );
      await loadInspectionTasks();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setInspectionBusy(false);
    }
  }

  async function deleteInspectionTask(taskId: string) {
    setInspectionBusy(true);
    setError(undefined);
    try {
      await requestJson<{ ok: boolean }>(`/api/inspection-tasks/${taskId}`, {
        method: "DELETE"
      });
      await loadInspectionTasks();
      // 删除后回到列表视图，不再自动跳进其他任务详情。
      if (activeTaskId === taskId) {
        setActiveTaskId("");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setInspectionBusy(false);
    }
  }

  async function saveBusinessEnvironment(input: {
    id?: string;
    name: string;
    url: string;
    username: string;
    password: string;
    description: string;
  }) {
    const url = input.id ? `/api/business-environments/${input.id}` : "/api/business-environments";
    await requestJson<BusinessEnvironment>(url, {
      method: input.id ? "PUT" : "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input)
    });
    await loadBusinessEnvironments();
  }

  async function deleteBusiness(id: string) {
    await requestJson<{ ok: boolean }>(`/api/business-environments/${id}`, { method: "DELETE" });
    if (environmentSelection.businessId === id) {
      setEnvironmentSelection((prev) => ({ ...prev, businessId: "" }));
    }
    await loadBusinessEnvironments();
  }

  async function saveHostEntry(input: {
    id?: string;
    ip: string;
    hostname: string;
    comment: string;
    enabled: boolean;
  }) {
    const url = input.id ? `/api/host-entries/${input.id}` : "/api/host-entries";
    const data = await requestJson<{ entry: HostEntry; status: HostApplyStatus }>(url, {
      method: input.id ? "PUT" : "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input)
    });
    setHostStatus(data.status);
    await loadHostEntries();
  }

  async function deleteHost(id: string) {
    const status = await requestJson<HostApplyStatus>(`/api/host-entries/${id}`, { method: "DELETE" });
    setHostStatus(status);
    await loadHostEntries();
  }

  return (
    <div
      className={`app-shell ${active?.browserKernel === "uiwarden-embedded" && view === "chat" ? "embedded-browser-active" : ""}`}
      style={{ "--artifact-panel-width": `${artifactPanelWidth}px` } as React.CSSProperties}
    >
      <header className="topbar">
        <div className="brand">
          <img className="brand-icon" src={uiwardenIcon} alt="UIWarden" />
          <div>
            <div className="brand-title">UIWarden</div>
            <div className="brand-subtitle">UI 自动化测试与操作平台</div>
          </div>
        </div>
      </header>

      <aside className="sidebar">
        <nav className="side-menu">
          <button
            className={view === "dashboard" ? "active" : ""}
            onClick={() => {
              setView("dashboard");
              navigate("/quality");
            }}
          >
            <LayoutDashboard size={15} />
            质量看板
          </button>
          <button
            className={view === "chat" ? "active" : ""}
            onClick={() => {
              setView("chat");
              navigate("/");
              // 巡检/回归可能在后台创建了新会话，切回对话页时刷新列表
              void loadSessions();
            }}
          >
            <Bot size={15} />
            测试任务
          </button>
          <button
            className={view === "operations" ? "active" : ""}
            onClick={() => {
              setView("operations");
              navigate("/ui-operations");
            }}
          >
            <MousePointerClick size={15} />
            UI 操作
          </button>
          <button
            className={view === "evaluation" ? "active" : ""}
            onClick={() => {
              setView("evaluation");
              navigate("/evaluation-lab");
            }}
          >
            <FlaskConical size={15} />
            评测实验室
          </button>
          <button
            className={view === "regression" ? "active" : ""}
            onClick={() => {
              setView("regression");
              navigate("/regression");
            }}
          >
            <CheckSquare size={15} />
            回归任务
          </button>
          <button
            className={view === "inspections" ? "active" : ""}
            onClick={() => {
              setView("inspections");
              navigate("/inspections");
            }}
          >
            <ShieldCheck size={15} />
            巡检任务
          </button>
          <button
            className={["environments", "hosts", "models", "notify", "deps", "skillenv"].includes(view) ? "active" : ""}
            onClick={() => {
              setView("skillenv");
              navigate(`/config-center/${configSection}`);
            }}
          >
            <Settings size={15} />
            配置中心
            {IS_DESKTOP_APP && depsAlert && <span className="nav-dot" title="存在缺失的必需依赖" />}
          </button>
        </nav>
      </aside>

      {view === "dashboard" ? (
        <QualityDashboardView onOpenSession={openSessionPage} />
      ) : view === "evaluation" ? (
        <EvaluationLabView onOpenSession={openSessionPage} />
      ) : view === "operations" ? (
        <UiOperationsView environments={businessEnvironments} />
      ) : view === "chat" ? (
        <>
          <main className="chat-area">
            {IS_DESKTOP_APP && depsAlert && !depsBannerDismissed && (
              <div className="banner banner-warn deps-banner">
                <Wrench size={14} />
                <span>检测到必需依赖缺失，agent 任务可能无法执行。</span>
                <button
                  className="ghost-button"
                  onClick={() => {
                    setView("skillenv");
                    setConfigSection("deps");
                    navigate("/config-center/deps");
                  }}
                >
                  前往依赖环境
                </button>
                <button
                  className="deps-banner-close"
                  type="button"
                  title="关闭依赖提示"
                  aria-label="关闭依赖提示"
                  onClick={() => setDepsBannerDismissed(true)}
                >
                  <X size={14} />
                </button>
              </div>
            )}
            <header className="chat-header">
              <div>
                <h1>测试任务</h1>
                <p>{active ? `当前会话：${active.title}` : "创建会话后开始任务"}</p>
                {active && (
                  <button
                    className="session-id-chip"
                    type="button"
                    title="复制会话 ID（用于问题排查）"
                    onClick={async () => {
                      try {
                        await navigator.clipboard.writeText(active.id);
                      } catch {
                        // 剪贴板不可用时退化为选中提示
                        window.prompt("手动复制会话 ID：", active.id);
                        return;
                      }
                      setCopiedLink("session-id");
                      setTimeout(() => setCopiedLink((c) => (c === "session-id" ? null : c)), 1500);
                    }}
                  >
                    {copiedLink === "session-id" ? <Check size={12} /> : <Copy size={12} />}
                    <code>{active.id}</code>
                  </button>
                )}
              </div>
              <div className="header-actions">
                {active?.executionRuntimeId && (
                  <span className="execution-runtime-chip" title="该会话创建时固定的 Agent 执行底座">
                    <Terminal size={14} />
                    {executionRuntimes.find((runtime) => runtime.id === active.executionRuntimeId)?.name ?? active.executionRuntimeId}
                  </span>
                )}
                {active && (
                  <label className="kernel-picker" title="切换 browser-use 执行内核">
                    <Chrome size={14} />
                    <select
                      value={active.browserKernel ?? (active.kind === "cdp" ? "external-cdp" : "playwright")}
                      disabled={activeBusy}
                      onChange={(event) => void changeBrowserKernel(event.target.value as BrowserKernel)}
                    >
                      <option value="playwright">Playwright 配套 Chromium（默认）</option>
                      <option value="skill-profile">Skill 配置浏览器（Chromium 系）</option>
                      <option value="external-cdp">外部 CDP</option>
                      <option value="uiwarden-embedded">客户端内置 gui-browser</option>
                    </select>
                  </label>
                )}
                {activeId && (
                  <button
                    className="icon-button"
                    type="button"
                    title="复制当前会话链接"
                    onClick={async () => {
                      const ok = await copyShareLink("chat", activeId);
                      if (ok) {
                        setCopiedLink("chat");
                        setTimeout(() => setCopiedLink((c) => (c === "chat" ? null : c)), 1500);
                      }
                    }}
                  >
                    {copiedLink === "chat" ? <Check size={16} /> : <Link2 size={16} />}
                  </button>
                )}
                <RefreshIconButton
                  title="刷新当前会话"
                  disabled={!activeId}
                  onRefresh={() => activeId ? loadSession(activeId) : undefined}
                />
              </div>
            </header>

            <section
              className="chat-workspace"
              ref={chatWorkspaceRef}
              style={{ "--chat-history-width": `${historyPaneWidth}px` } as React.CSSProperties}
            >
              <aside className="chat-history-panel">
                <div className="panel-title">
                  <History size={15} />
                  对话历史
                </div>
                <button className="new-button history-create" title="创建会话；未选择自定义配置时使用 Playwright 配套 Chromium" onClick={() => void newSession()}>
                  <Plus size={15} />
                  新对话
                </button>
                {IS_DESKTOP_APP && (
                  <button
                    className="new-button history-create cdp-create"
                    title="创建 CDP 直连会话：附着本机浏览器复用登录态，支持多轮人机协同操作"
                    onClick={() => void newSession("external-cdp")}
                  >
                    <Chrome size={15} />
                    新 CDP 直连会话
                  </button>
                )}
                {IS_DESKTOP_APP && (
                  <button
                    className="new-button history-create embedded-create"
                    title="创建客户端内置可交互浏览器会话"
                    onClick={() => void newSession("uiwarden-embedded")}
                  >
                    <Chrome size={15} />
                    新内置浏览器会话
                  </button>
                )}
                <div className="history-list">
                  {sessionsPagination.pagedItems.map((session) => {
                    const isRunningHere = runningSessionIds.includes(session.id);
                    return (
                    <div
                      key={session.id}
                      className={`history-item ${session.id === activeId ? "active" : ""}`}
                    >
                      <button className="history-select" type="button" onClick={() => {
                        setActiveId(session.id);
                        navigate(buildPath("chat", session.id));
                      }}>
                        <span className={`status-dot ${runningSessionIds.includes(session.id) ? "running" : session.status}`} />
                        <span title={session.title}>
                          <strong>{session.title}</strong>
                          <em>{formatTime(session.updatedAt)}</em>
                        </span>
                      </button>
                      <span className="history-actions">
                        <button
                          className="history-copy-id"
                          type="button"
                          title={`复制会话 ID：${session.id}`}
                          onClick={async (event) => {
                            event.stopPropagation();
                            try {
                              await navigator.clipboard.writeText(session.id);
                            } catch {
                              window.prompt("手动复制会话 ID：", session.id);
                              return;
                            }
                            setCopiedLink(`sid-${session.id}`);
                            setTimeout(
                              () => setCopiedLink((c) => (c === `sid-${session.id}` ? null : c)),
                              1500
                            );
                          }}
                        >
                          {copiedLink === `sid-${session.id}` ? <Check size={13} /> : <Copy size={13} />}
                        </button>
                        <button
                          className="history-delete"
                          type="button"
                          disabled={isRunningHere}
                          title={isRunningHere ? "运行中不可删除" : "删除会话"}
                          onClick={(event) => {
                            event.stopPropagation();
                            setPendingDeleteSession({ id: session.id, title: session.title });
                          }}
                        >
                          <Trash2 size={13} />
                        </button>
                      </span>
                    </div>
                    );
                  })}
                  {!sessions.length && <div className="empty-artifacts">暂无历史会话</div>}
                  <Pagination state={sessionsPagination} />
                </div>
              </aside>

              <div
                className="chat-history-splitter"
                role="separator"
                aria-label="调整对话历史栏宽度"
                aria-orientation="vertical"
                aria-valuemin={196}
                aria-valuemax={420}
                aria-valuenow={historyPaneWidth}
                tabIndex={0}
                onPointerDown={startHistoryPaneResize}
                onKeyDown={(event) => {
                  if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
                  event.preventDefault();
                  const nextWidth = updateHistoryPaneWidth(historyPaneWidth + (event.key === "ArrowRight" ? 16 : -16));
                  window.localStorage.setItem("uiwarden-chat-history-width", String(nextWidth));
                }}
              >
                <span />
              </div>

              <div className={`chat-main-panel ${active?.browserKernel === "uiwarden-embedded" ? "chat-main-panel-embedded" : ""} ${embeddedExpanded ? "browser-expanded" : ""}`}>
                <div className="chat-conversation-pane">
                {(active?.browserKernel === "external-cdp" || active?.kind === "cdp") && (
                  <CdpControlPanel
                    sessionId={active.id}
                    sessionRunning={activeBusy}
                    onUseEmbedded={() => void changeBrowserKernel("uiwarden-embedded")}
                    onUseFirefox={useDetectedFirefox}
                  />
                )}
                <section className="messages" ref={messagesRef}>
                  {!active && (
                    <div className="empty-state">
                      <Bot size={30} />
                      <span>创建一个会话，输入 UI 测试任务或上传用例文档。</span>
                    </div>
                  )}
                  {historicalMessages.map((message) => (
                    <MessageBubble key={message.id} message={message} />
                  ))}
                  {showStreamingBubble && (
                    <MessageBubble
                      message={{
                        id: "streaming",
                        role: "assistant",
                        content: streamingText,
                        createdAt: new Date().toISOString(),
                        meta: { streaming: true, tools: toolEvents }
                      }}
                    />
                  )}
                  {activeObserving && !streamingText && (
                    <div className="thinking">
                      <Loader2 size={16} className="spin" />
                      {activeBusy ? "正在启动 UIWarden 会话" : "任务执行中…"}
                    </div>
                  )}
                  {processLogs.length ? <ProcessLogs logs={processLogs} /> : null}
                  {error && <div className="error-banner">{error}</div>}
                  <div ref={bottomRef} />
                </section>

                <footer className="composer">
                  <EnvironmentPicker
                    environments={businessEnvironments}
                    value={environmentSelection}
                    onChange={setEnvironmentSelection}
                  />
                  {files.length > 0 && (
                    <div className="file-chips">
                      {files.map((file) => (
                        <span key={file.name} className="file-chip">
                          <FileText size={13} />
                          {file.name}
                        </span>
                      ))}
                    </div>
                  )}
                  <div className="input-row">
                    <button className="icon-button" title="上传附件" aria-label="上传附件" onClick={() => fileInputRef.current?.click()}>
                      <Paperclip size={18} />
                    </button>
                    <textarea
                      value={draft}
                      onChange={(event) => setDraft(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                          void sendMessage();
                        }
                      }}
                      placeholder={
                        active?.browserKernel === "external-cdp" || active?.kind === "cdp"
                          ? "输入 CDP 页面操作任务；执行间隙可直接在本机浏览器手动操作，下一轮会接着当前页面继续"
                          : active?.browserKernel === "uiwarden-embedded"
                            ? "输入页面任务；执行过程会显示在右侧浏览器，可随时接管操作"
                          : "输入一句话任务，例如：对 https://example.com 做页面巡检，或上传用例文档后要求快速执行"
                      }
                      disabled={!active || activeBusy}
                    />
                    {active && activeBusy ? (
                      <button
                        className="stop-task-button"
                        type="button"
                        title="停止当前测试任务"
                        aria-label="停止当前测试任务"
                        disabled={stoppingSessionIds.includes(active.id)}
                        onClick={() => void stopTestSession(active.id)}
                      >
                        {stoppingSessionIds.includes(active.id) ? <Loader2 size={16} className="spin" /> : <Square size={15} />}
                      </button>
                    ) : (
                      <button className="send-button" disabled={!active} onClick={sendMessage}>
                        <Send size={18} />
                      </button>
                    )}
                    <input
                      ref={fileInputRef}
                      type="file"
                      multiple
                      hidden
                      onChange={(event) => setFiles(Array.from(event.target.files ?? []))}
                    />
                  </div>
                </footer>
                </div>
                {active?.browserKernel === "uiwarden-embedded" && IS_DESKTOP_APP && (
                  <EmbeddedBrowserPane
                    width={embeddedPaneWidth}
                    expanded={embeddedExpanded}
                    sessionRunning={activeBusy}
                    sessionId={active.id}
                    screenshots={screenshots}
                    artifacts={active.artifacts}
                    activeObserving={activeObserving}
                    selectedScreenshotIndex={selectedScreenshotIndex}
                    autoFollowScreenshots={autoFollowScreenshots}
                    onWidthChange={setEmbeddedPaneWidth}
                    onExpandedChange={setEmbeddedExpanded}
                    onSelectedScreenshotChange={setSelectedScreenshotIndex}
                    onAutoFollowChange={setAutoFollowScreenshots}
                    onOpenScreenshotViewer={(playing) => {
                      setIsScreenshotViewerOpen(true);
                      setIsPlayingScreenshots(playing);
                    }}
                    onPreviewArtifact={setPreviewArtifact}
                    onDiagnose={diagnoseBrowserArtifacts}
                    onStop={async () => {
                      await stopTestSession(active.id);
                    }}
                  />
                )}
              </div>
            </section>
          </main>

          <aside className="artifact-panel">
            <div
              className="artifact-panel-splitter"
              role="separator"
              aria-label="调整结果产物栏宽度"
              aria-orientation="vertical"
              aria-valuemin={260}
              aria-valuemax={520}
              aria-valuenow={artifactPanelWidth}
              tabIndex={0}
              onPointerDown={startArtifactPanelResize}
              onKeyDown={(event) => {
                if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
                event.preventDefault();
                const nextWidth = updateArtifactPanelWidth(artifactPanelWidth + (event.key === "ArrowLeft" ? 16 : -16));
                window.localStorage.setItem("uiwarden-artifact-panel-width", String(nextWidth));
              }}
            >
              <span />
            </div>
            <section className="timeline-panel">
              <div className="panel-title">
                <Image size={16} />
                执行观察
              </div>
              {screenshots.length ? (
                <>
                  <div className="timeline-toolbar">
                    <span>
                      {selectedScreenshotIndex + 1} / {screenshots.length}
                      {autoFollowScreenshots && activeObserving ? " · 实时跟随" : ""}
                    </span>
                    {!autoFollowScreenshots && activeObserving ? (
                      <button
                        className="ghost-button timeline-play"
                        type="button"
                        onClick={() => {
                          setAutoFollowScreenshots(true);
                          setSelectedScreenshotIndex(Math.max(screenshots.length - 1, 0));
                        }}
                      >
                        <RefreshCw size={13} />
                        回到实时
                      </button>
                    ) : null}
                    <button
                      className="ghost-button timeline-play"
                      type="button"
                      onClick={() => {
                        setIsScreenshotViewerOpen(true);
                        setIsPlayingScreenshots(true);
                      }}
                    >
                      <Play size={13} />
                      播放
                    </button>
                  </div>
                  <button
                    className="screenshot-preview"
                    type="button"
                    onClick={() => {
                      setIsScreenshotViewerOpen(true);
                      setIsPlayingScreenshots(false);
                    }}
                  >
                    <img src={screenshots[selectedScreenshotIndex]?.url} alt="当前执行页面截图" />
                  </button>
                  <div className="screenshot-timeline">
                    {screenshots.map((frame, index) => (
                      <button
                        key={`${frame.relativePath}-${frame.modifiedAt}`}
                        className={`screenshot-frame ${index === selectedScreenshotIndex ? "active" : ""}`}
                        type="button"
                        onClick={() => {
                          setSelectedScreenshotIndex(index);
                          setIsPlayingScreenshots(false);
                          setAutoFollowScreenshots(false);
                        }}
                      >
                        <img src={frame.url} alt={frame.relativePath} />
                        <span>
                          <strong>{frame.stepIndex ? `Step ${frame.stepIndex}` : `Step ${index + 1}`}</strong>
                          <em>{frame.actionSummary || frame.title || frame.pageUrl || formatTime(frame.modifiedAt)}</em>
                        </span>
                      </button>
                    ))}
                  </div>
                </>
              ) : (
                <div className="empty-artifacts">
                  {activeObserving
                    ? `${activeRuntime.statusLabel || "等待 browser-use 首帧截图"}；日志会先实时出现，截图生成后将立即追加到这里。`
                    : error
                      ? `本次未生成执行截图：${error}`
                      : "暂无执行观察截图。发起任务后会形成可播放时间轴。"}
                </div>
              )}
            </section>

            <section className="artifact-section">
              <div className="panel-title">
                <Download size={16} />
                结果产物
                {active?.browserKernel === "uiwarden-embedded" && (
                  <button className="ghost-button artifact-diagnose" type="button" onClick={() => void diagnoseBrowserArtifacts()}>
                    <Wrench size={13} />
                    分析问题
                  </button>
                )}
                {active && active.artifacts.some((artifact) => artifact.kind === "file") && (
                  <a className="ghost-button artifact-download-all" href={`/api/sessions/${active.id}/artifacts/download`} title="下载当前会话全部产物">
                    <Download size={13} />
                    下载全部
                  </a>
                )}
              </div>
              {active && downloadableArtifacts(active.artifacts).length ? (
                <>
                  <div className="artifact-category-tabs" role="tablist" aria-label="结果产物分类">
                    {availableArtifactCategories(downloadableArtifacts(active.artifacts)).map((category) => (
                      <button
                        key={category}
                        type="button"
                        className={artifactCategory === category ? "active" : ""}
                        onClick={() => setArtifactCategory(category)}
                      >
                        {category}
                        <span>{category === "全部"
                          ? downloadableArtifacts(active.artifacts).length
                          : downloadableArtifacts(active.artifacts).filter((artifact) => artifactMatchesCategory(artifact, category)).length}</span>
                      </button>
                    ))}
                  </div>
                  <div className="artifact-list">
                  {groupArtifacts(artifactsPagination.pagedItems).map(([group, artifacts]) => (
                    <div className="artifact-group" key={group}>
                      <div className="artifact-group-title">{group}</div>
                      {artifacts.map((artifact) => (
                        <div key={artifact.relativePath} className={`artifact-item${isHighlightedArtifact(artifact) ? " core-report" : ""}`} title={artifact.relativePath}>
                          {canPreviewArtifact(artifact) ? (
                            <button className="artifact-preview-link" type="button" onClick={() => setPreviewArtifact(artifact)}>
                              <FileText size={14} />
                              <span>{artifact.relativePath}</span>
                              <em>{artifactLabel(artifact)}</em>
                            </button>
                          ) : (
                            <span className="artifact-preview-link artifact-preview-disabled">
                              <FileText size={14} />
                              <span>{artifact.relativePath}</span>
                              <em>{artifactLabel(artifact)}</em>
                            </span>
                          )}
                          <a className="artifact-download-button" href={artifactDownloadHref(active.id, artifact)} download title="下载产物">
                            <Download size={14} />
                          </a>
                        </div>
                      ))}
                    </div>
                  ))}
                  <Pagination state={artifactsPagination} />
                </div>
                </>
              ) : (
                <div className="empty-artifacts">暂无可预览产物</div>
              )}
            </section>
          </aside>
        </>
      ) : view === "inspections" ? (
        <InspectionView
          form={inspectionForm}
          setForm={setInspectionForm}
          tasks={inspectionTasks}
          activeTask={activeTask}
          environments={businessEnvironments}
          busy={inspectionBusy}
          triggeringTaskId={triggeringTaskId}
          error={error}
          onCreate={createInspectionTask}
          onUpdate={updateInspectionTask}
          onRefresh={loadInspectionTasks}
          onSelect={(id) => {
            setActiveTaskId(id);
            navigate(id ? buildPath("inspections", id) : "/inspections");
          }}
          onTrigger={triggerInspectionTask}
          onAbort={abortInspectionTask}
          onDelete={deleteInspectionTask}
          robots={dingtalkRobots}
        />
      ) : view === "environments" ? (
        <EnvironmentCenter
          environments={businessEnvironments}
          onSave={saveBusinessEnvironment}
          onDelete={deleteBusiness}
          onRefresh={loadBusinessEnvironments}
        />
      ) : view === "hosts" ? (
        <HostCenter
          entries={hostEntries}
          status={hostStatus}
          onSave={saveHostEntry}
          onDelete={deleteHost}
          onRefresh={loadHostEntries}
        />
      ) : view === "models" ? (
        <ModelCenter
          profiles={modelProfiles}
          runtimes={executionRuntimes}
          onSave={saveModelProfile}
          onDelete={deleteModelProfile}
          onActivate={activateModelProfile}
          onSelectCatalogModel={selectRuntimeCatalogModel}
          onSelectRuntime={selectExecutionRuntime}
          onRefresh={async () => { await Promise.all([loadModelProfiles(), loadExecutionRuntimes()]); }}
        />
      ) : view === "notify" ? (
        <NotifyCenter
          robots={dingtalkRobots}
          form={robotForm}
          setForm={setRobotForm}
          editingId={editingRobotId}
          setEditingId={setEditingRobotId}
          onSave={saveDingtalkRobot}
          onDelete={deleteDingtalkRobot}
          onTest={testDingtalkRobot}
          onRefresh={loadDingtalkRobots}
        />
      ) : view === "deps" ? (
        <DepsCenter onAlertChange={setDepsAlert} />
      ) : view === "skillenv" ? (
        <ConfigCenter
          section={configSection}
          desktop={IS_DESKTOP_APP}
          depsAlert={depsAlert}
          onSectionChange={(section) => {
            setConfigSection(section);
            navigate(`/config-center/${section}`);
          }}
        >
          {configSection === "gui-runtime" ? (
            <GuiRuntimeCenter />
          ) : configSection === "environments" ? (
            <EnvironmentCenter
              environments={businessEnvironments}
              onSave={saveBusinessEnvironment}
              onDelete={deleteBusiness}
              onRefresh={loadBusinessEnvironments}
            />
          ) : configSection === "hosts" ? (
            <HostCenter
              entries={hostEntries}
              status={hostStatus}
              onSave={saveHostEntry}
              onDelete={deleteHost}
              onRefresh={loadHostEntries}
            />
          ) : configSection === "models" ? (
            <ModelCenter
              profiles={modelProfiles}
              runtimes={executionRuntimes}
              onSave={saveModelProfile}
              onDelete={deleteModelProfile}
              onActivate={activateModelProfile}
              onSelectCatalogModel={selectRuntimeCatalogModel}
              onSelectRuntime={selectExecutionRuntime}
              onRefresh={async () => { await Promise.all([loadModelProfiles(), loadExecutionRuntimes()]); }}
            />
          ) : configSection === "notify" ? (
            <NotifyCenter
              robots={dingtalkRobots}
              form={robotForm}
              setForm={setRobotForm}
              editingId={editingRobotId}
              setEditingId={setEditingRobotId}
              onSave={saveDingtalkRobot}
              onDelete={deleteDingtalkRobot}
              onTest={testDingtalkRobot}
              onRefresh={loadDingtalkRobots}
            />
          ) : configSection === "deps" ? (
            <DepsCenter onAlertChange={setDepsAlert} />
          ) : (
            <SkillEnvCenter />
          )}
        </ConfigCenter>
      ) : view === "regression" ? (
        <RegressionCenter
          modules={regressionModules}
          cases={regressionCases}
          batches={regressionBatches}
          activeBatch={activeRegressionBatch}
          activeRunId={activeRegressionRunId}
          environments={businessEnvironments}
          moduleForm={regressionModuleForm}
          setModuleForm={setRegressionModuleForm}
          caseForm={regressionCaseForm}
          setCaseForm={setRegressionCaseForm}
          activeModuleId={activeRegressionModuleId}
          selectedCaseIds={selectedRegressionCaseIds}
          onSaveModule={saveRegressionModule}
          onDeleteModule={deleteRegressionModule}
          onSaveCase={saveRegressionCase}
          onDeleteCase={deleteRegressionCase}
          onSelectModule={(id) => {
            setActiveRegressionModuleId(id);
            setRegressionCaseForm((prev) => ({ ...prev, moduleId: id }));
            navigate(buildPath("regression", id, "modules"));
          }}
          onShowAllCases={() => {
            setActiveRegressionModuleId(undefined);
            setRegressionCaseForm((prev) => ({ ...prev, moduleId: "" }));
            navigate("/regression");
          }}
          onToggleCase={(id) => {
            setSelectedRegressionCaseIds((prev) => {
              const next = new Set(prev);
              if (next.has(id)) {
                next.delete(id);
              } else {
                next.add(id);
              }
              return next;
            });
          }}
          onToggleAllCases={(ids) => {
            setSelectedRegressionCaseIds((prev) => {
              if (ids.every((id) => prev.has(id)) && ids.length) {
                return new Set();
              }
              return new Set(ids);
            });
          }}
          onRunBatch={runRegressionBatch}
          onAbortBatch={abortRegressionBatch}
          onDeleteBatch={deleteRegressionBatch}
          onDeleteRun={deleteRegressionRun}
          onRefreshBatches={loadRegressionBatches}
          onSelectBatch={(id) => {
            setActiveRegressionBatchId(id);
            setActiveRegressionRunId(undefined);
            void loadRegressionBatch(id);
            navigate(buildPath("regression", id, "batches"));
          }}
          onSelectRun={(batchId, runId) => {
            setActiveRegressionRunId(runId);
            navigate(buildPath("regression", batchId, "batches", runId));
          }}
          robots={dingtalkRobots}
        />
      ) : null}

      {isScreenshotViewerOpen && screenshots.length ? (
        <div className="screenshot-viewer" role="dialog" aria-modal="true">
          <div className="screenshot-viewer-head">
            <div>
              <strong>执行流程预览</strong>
              <span>Step {selectedScreenshotIndex + 1} / {screenshots.length}</span>
            </div>
            <div className="button-row">
              <button
                className="ghost-button"
                type="button"
                onClick={() => setIsPlayingScreenshots((prev) => !prev)}
              >
                {isPlayingScreenshots ? <Pause size={14} /> : <Play size={14} />}
                {isPlayingScreenshots ? "暂停" : "播放"}
              </button>
              <button
                className="icon-button"
                type="button"
                title="关闭执行流程预览"
                aria-label="关闭执行流程预览"
                onClick={() => {
                  setIsScreenshotViewerOpen(false);
                  setIsPlayingScreenshots(false);
                }}
              >
                <X size={16} />
              </button>
            </div>
          </div>
          <div className="screenshot-viewer-body">
            <button
              className="viewer-nav"
              type="button"
              onClick={() => {
                setIsPlayingScreenshots(false);
                setSelectedScreenshotIndex((prev) => (prev - 1 + screenshots.length) % screenshots.length);
              }}
            >
              <ChevronLeft size={24} />
            </button>
            <img src={screenshots[selectedScreenshotIndex].url} alt="执行流程大图预览" />
            <button
              className="viewer-nav"
              type="button"
              onClick={() => {
                setIsPlayingScreenshots(false);
                setSelectedScreenshotIndex((prev) => (prev + 1) % screenshots.length);
              }}
            >
              <ChevronRight size={24} />
            </button>
          </div>
          <div className="screenshot-viewer-strip">
            {screenshots.map((frame, index) => (
              <button
                key={`${frame.relativePath}-${frame.modifiedAt}-viewer`}
                className={index === selectedScreenshotIndex ? "active" : ""}
                type="button"
                onClick={() => {
                  setSelectedScreenshotIndex(index);
                  setIsPlayingScreenshots(false);
                }}
              >
                <img src={frame.url} alt={`Step ${index + 1}`} />
              </button>
            ))}
          </div>
        </div>
      ) : null}
      {previewArtifact && active ? (
        <div className="artifact-preview-modal" role="dialog" aria-modal="true" aria-label={`预览 ${previewArtifact.name}`}>
          <div className="artifact-preview-modal-head">
            <div>
              <strong>{previewArtifact.isCoreReport ? "核心 HTML 报告" : isBrowserRepManifest(previewArtifact) ? "Browser Rep 核心清单" : isNativeRepManifest(previewArtifact) ? "Native Rep 核心清单" : previewArtifact.name}</strong>
              <span title={previewArtifact.relativePath}>{previewArtifact.relativePath}</span>
            </div>
            <div className="button-row">
              <a className="ghost-button" href={artifactDownloadHref(active.id, previewArtifact)} download>
                <Download size={14} />下载
              </a>
              <button className="icon-button" type="button" title="关闭预览" onClick={() => setPreviewArtifact(undefined)}>
                <X size={16} />
              </button>
            </div>
          </div>
          <div className={`artifact-preview-modal-body${isImageArtifact(previewArtifact) ? " image" : ""}`}>
            {isImageArtifact(previewArtifact) ? (
              <img src={artifactPreviewHref(active.id, previewArtifact)} alt={previewArtifact.name} />
            ) : (
              <iframe
                title={previewArtifact.name}
                src={artifactPreviewHref(active.id, previewArtifact)}
                sandbox="allow-scripts"
              />
            )}
          </div>
        </div>
      ) : null}
      <Modal
        open={Boolean(pendingDeleteSession)}
        title={
          <div className="modal-title-inner">
            <Trash2 size={17} />
            确认删除会话
          </div>
        }
        onClose={() => {
          if (!deletingSessionId) setPendingDeleteSession(undefined);
        }}
        footer={
          <>
            <button
              className="ghost-button"
              type="button"
              disabled={Boolean(deletingSessionId)}
              onClick={() => setPendingDeleteSession(undefined)}
            >
              取消
            </button>
            <button
              className="danger-button"
              type="button"
              disabled={Boolean(deletingSessionId)}
              onClick={() => void confirmDeleteChatSession()}
            >
              {deletingSessionId ? <Loader2 size={14} className="spin" /> : <Trash2 size={14} />}
              {deletingSessionId ? "删除中" : "确认删除"}
            </button>
          </>
        }
      >
        <div className="delete-session-confirmation">
          <p>确定删除会话“<strong>{pendingDeleteSession?.title}</strong>”吗？</p>
          <span>该会话的对话记录和本地产物将被永久删除，此操作不可恢复。</span>
        </div>
      </Modal>
    </div>
  );
}

function InspectionView({
  form,
  setForm,
  tasks,
  activeTask,
  environments,
  busy,
  triggeringTaskId,
  error,
  onCreate,
  onUpdate,
  onRefresh,
  onSelect,
  onTrigger,
  onAbort,
  onDelete,
  robots
}: {
  form: InspectionForm;
  setForm: React.Dispatch<React.SetStateAction<InspectionForm>>;
  tasks: InspectionTask[];
  activeTask?: InspectionTask;
  environments: BusinessEnvironment[];
  busy: boolean;
  triggeringTaskId?: string;
  error?: string;
  onCreate: () => Promise<void>;
  onUpdate: (taskId: string, form: InspectionForm) => Promise<boolean>;
  onRefresh: () => Promise<void>;
  onSelect: (id: string) => void;
  onTrigger: (id: string) => Promise<void>;
  onAbort: (id: string) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
  robots?: DingtalkRobot[];
}) {
  const tasksPagination = usePagination(tasks, 30);
  const runs = activeTask?.runs ?? [];
  const runsPagination = usePagination(runs, 30);
  const robotList = robots ?? [];
  const [createOpen, setCreateOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [editForm, setEditForm] = useState<InspectionForm>(form);
  const [activeRunDetail, setActiveRunDetail] = useState<InspectionRun>();
  const [copiedLink, setCopiedLink] = useState<string | null>(null);
  const isEditing = Boolean(activeTask);
  const openEdit = (task: InspectionTask) => {
    setEditForm({
      name: task.name,
      url: task.url,
      businessId: task.businessId ?? "",
      username: task.username ?? "",
      password: "",
      prompt: task.prompt ?? "",
      scheduleEnabled: task.scheduleEnabled,
      scheduleMode: (task.scheduleMode ?? "cron") as "interval" | "cron",
      intervalMinutes: task.intervalMinutes ?? 180,
      cronExpression: task.cronExpression ?? "0 */3 * * *",
      notifyRobotId: task.notifyRobotId ?? "",
      notifyTrigger: (task.notifyTrigger ?? "failed") as InspectionNotifyTrigger
    });
    setEditOpen(true);
  };
  const submitEdit = async () => {
    if (!activeTask) return;
    const ok = await onUpdate(activeTask.id, editForm);
    if (ok) setEditOpen(false);
  };
  return (
    <main className="inspection-area">
      <header className="chat-header">
        <div>
          <h1>巡检任务</h1>
          <p>创建页面巡检任务，支持手动触发和固定间隔定时触发。</p>
        </div>
        <div className="header-actions">
          <button className="new-button" onClick={() => setCreateOpen(true)}>
            <Plus size={16} />
            新建巡检
          </button>
          <RefreshIconButton title="刷新巡检任务" onRefresh={onRefresh} />
        </div>
      </header>

      <section className="inspection-content">
        {activeTask ? (
          <div className="inspection-detail subpage full">
            <button
              className="ghost-button back-button"
              type="button"
              onClick={() => onSelect("")}
            >
              <ArrowLeft size={16} />
              返回列表
            </button>
            <div className="detail-head">
              <div>
                <h2>{activeTask.name}</h2>
                <p>{activeTask.url}</p>
              </div>
              <div className="header-actions">
                <button
                  className="icon-button"
                  type="button"
                  title="复制当前巡检任务链接"
                  onClick={async () => {
                    const ok = await copyShareLink("inspections", activeTask.id);
                    if (ok) {
                      setCopiedLink(`inspection:${activeTask.id}`);
                      setTimeout(
                        () => setCopiedLink((c) => (c === `inspection:${activeTask.id}` ? null : c)),
                        1500
                      );
                    }
                  }}
                >
                  {copiedLink === `inspection:${activeTask.id}` ? (
                    <Check size={16} />
                  ) : (
                    <Link2 size={16} />
                  )}
                </button>
                <button
                  className="ghost-button wide"
                  type="button"
                  disabled={busy}
                  onClick={() => openEdit(activeTask)}
                >
                  <Edit2 size={16} />
                  编辑
                </button>
                <button
                  className="send-button wide"
                  disabled={busy || activeTask.status === "running"}
                  onClick={() => void onTrigger(activeTask.id)}
                >
                  {triggeringTaskId === activeTask.id || activeTask.status === "running" ? (
                    <Loader2 size={17} className="spin" />
                  ) : (
                    <Play size={17} />
                  )}
                  {triggeringTaskId === activeTask.id && activeTask.status !== "running"
                    ? "提交中…"
                    : activeTask.status === "running"
                      ? "执行中…"
                      : "立即执行"}
                </button>
                {activeTask.status === "running" ? (
                  <button
                    className="send-button wide danger-button"
                    disabled={busy}
                    onClick={() => void onAbort(activeTask.id)}
                  >
                    <Pause size={17} />
                    中止执行
                  </button>
                ) : null}
              </div>
            </div>
            <div className="detail-grid">
              <InfoTile icon={<User size={15} />} label="账号" value={activeTask.username ?? "未设置"} />
              <InfoTile
                icon={<KeyRound size={15} />}
                label="密码"
                value={activeTask.hasPassword ? activeTask.passwordMasked ?? "******" : "未设置"}
              />
              <InfoTile
                icon={<CalendarClock size={15} />}
                label="定时"
                value={
                  activeTask.scheduleEnabled ? formatSchedule(activeTask) : "未开启"
                }
              />
              <InfoTile
                icon={<Clock3 size={15} />}
                label="下次执行"
                value={activeTask.nextRunAt ? formatTime(activeTask.nextRunAt) : "无"}
              />
            </div>
            <div className="run-history">
              <div className="panel-title">
                <History size={16} />
                执行记录
                <span className="muted">共 {runs.length} 条</span>
              </div>
              {runsPagination.pagedItems.length ? (
                runsPagination.pagedItems.map((run) => (
                  <button
                    key={run.id}
                    className={`run-item ${run.status} run-clickable`}
                    onClick={() => setActiveRunDetail(run)}
                  >
                    <span className={`status-dot ${run.status}`} />
                    <div className="run-item-main">
                      <strong>
                        {run.trigger === "manual" ? "手动触发" : "定时触发"}
                        <span className={`badge ${run.status === "completed" ? "badge-active" : run.status === "failed" ? "badge-failed" : "badge-default"}`}>
                          {run.status === "running" ? "执行中" : run.status === "completed" ? "完成" : run.status === "failed" ? "失败" : run.status === "aborted" ? "中止" : run.status}
                        </span>
                        {run.testOutcome && (
                          <span className={`badge ${run.testOutcome === "pass" ? "badge-active" : run.testOutcome === "fail" ? "badge-failed" : "badge-default"}`}>
                            {run.testOutcome === "pass" ? "PASS" : run.testOutcome === "fail" ? "FAIL" : "未知"}
                          </span>
                        )}
                        {run.notifyStatus && (
                          <NotifyStatusBadge status={run.notifyStatus} message={run.notifyMessage} />
                        )}
                      </strong>
                      <p>{run.error || run.summary || (run.status === "running" ? "执行中…" : "—")}</p>
                    </div>
                    <div className="run-actions">
                      <em>{formatTime(run.startedAt)}</em>
                      <a href={`/api/sessions/${run.sessionId}/artifacts/download`} onClick={(e) => e.stopPropagation()}>
                        <Download size={14} />
                        产物
                      </a>
                    </div>
                  </button>
                ))
              ) : (
                <div className="empty-artifacts">暂无执行记录</div>
              )}
              <Pagination state={runsPagination} />
            </div>
          </div>
        ) : (
          <div className="inspection-list full">
            <div className="panel-title">
              <ShieldCheck size={16} />
              任务列表
              <span className="muted">共 {tasks.length} 个</span>
            </div>
            {tasks.length ? (
              tasksPagination.pagedItems.map((task) => (
                <div
                  key={task.id}
                  className={`inspection-item ${task.status === "running" ? "running" : ""}`}
                >
                  <button
                    className="inspection-item-main-button"
                    type="button"
                    onClick={() => onSelect(task.id)}
                  >
                    <span className={`status-dot ${task.lastStatus ?? task.status}`} />
                    <span className="inspection-item-main">
                      <strong>{task.name}</strong>
                      <em>{task.url}</em>
                    </span>
                    <span className="inspection-item-meta">
                      <span className={`badge ${task.scheduleEnabled ? "badge-active" : "badge-default"}`}>
                        {task.scheduleEnabled ? "定时" : "手动"}
                      </span>
                      <span className="inspection-item-schedule">
                        {task.scheduleEnabled ? formatSchedule(task) : "仅手动触发"}
                      </span>
                      <span className={`badge ${task.status === "running" ? "badge-active" : task.lastStatus === "completed" ? "badge-active" : task.lastStatus === "failed" ? "badge-failed" : "badge-default"}`}>
                        {task.status === "running" ? "执行中" : task.lastStatus === "completed" ? "上次成功" : task.lastStatus === "failed" ? "上次失败" : "未执行"}
                      </span>
                      <small>{task.lastRunAt ? formatTime(task.lastRunAt) : "—"}</small>
                    </span>
                  </button>
                  <div className="inspection-item-actions">
                    <button
                      className="icon-button"
                      type="button"
                      title="编辑"
                      disabled={busy}
                      onClick={() => onSelect(task.id)}
                    >
                      <Edit2 size={15} />
                    </button>
                    <button
                      className="icon-button danger-icon"
                      type="button"
                      title={task.status === "running" ? "运行中不可删除" : "删除"}
                      disabled={busy || task.status === "running"}
                      onClick={() => {
                        if (window.confirm(`确认删除巡检任务"${task.name}"？该操作不可恢复。`)) {
                          void onDelete(task.id);
                        }
                      }}
                    >
                      <Trash2 size={15} />
                    </button>
                  </div>
                </div>
              ))
            ) : (
              <div className="empty-state">
                <ShieldCheck size={24} />
                <span>暂无巡检任务，点击右上角"新建巡检"创建</span>
              </div>
            )}
            <Pagination state={tasksPagination} />
          </div>
        )}
      </section>

      <Modal
        open={createOpen}
        title={
          <div className="modal-title-inner">
            <Plus size={18} />
            新建巡检任务
          </div>
        }
        onClose={() => setCreateOpen(false)}
      >
        <form
          className="inspection-form modal-form"
          onSubmit={(event) => {
            event.preventDefault();
            void onCreate().then(() => setCreateOpen(false));
          }}
        >
          <label>
            <span>任务名称</span>
            <input
              value={form.name}
              onChange={(event) => setForm((prev) => ({ ...prev, name: event.target.value }))}
              placeholder="默认使用 URL 域名"
            />
          </label>
          <label>
            <span>业务环境</span>
            <select
              value={form.businessId}
              onChange={(event) => {
                const env = environments.find((item) => item.id === event.target.value);
                setForm((prev) => ({
                  ...prev,
                  businessId: event.target.value,
                  url: env?.url ?? prev.url,
                  username: env?.username ?? prev.username
                }));
              }}
            >
              <option value="">自定义 / 不选择</option>
              {environments.map((env) => (
                <option key={env.id} value={env.id}>
                  {env.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>URL</span>
            <input
              required
              value={form.url}
              onChange={(event) => setForm((prev) => ({ ...prev, url: event.target.value }))}
              placeholder="https://example.com"
            />
          </label>
          <div className="form-grid">
            <label>
              <span>账号</span>
              <input
                value={form.username}
                onChange={(event) => setForm((prev) => ({ ...prev, username: event.target.value }))}
                placeholder="可选"
              />
            </label>
            <label>
              <span>密码</span>
              <input
                type="password"
                value={form.password}
                onChange={(event) => setForm((prev) => ({ ...prev, password: event.target.value }))}
                placeholder="可选"
                autoComplete="new-password"
              />
            </label>
          </div>
          <label>
            <span>巡检 Prompt</span>
            <textarea
              value={form.prompt}
              onChange={(event) => setForm((prev) => ({ ...prev, prompt: event.target.value }))}
              placeholder="不填则使用通用页面巡检策略"
            />
          </label>
          <div className="form-section schedule-section">
            <div className="form-section-head">
              <span>调度设置</span>
              <label className="switch-toggle">
                <input
                  type="checkbox"
                  checked={form.scheduleEnabled}
                  onChange={(event) =>
                    setForm((prev) => ({ ...prev, scheduleEnabled: event.target.checked }))
                  }
                />
                <span className="switch-track">
                  <span className="switch-thumb" />
                </span>
                <em>{form.scheduleEnabled ? "已开启" : "未开启"}</em>
              </label>
            </div>
            <div className="schedule-mode-group">
              {(["cron", "interval"] as const).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  className={`seg-button ${form.scheduleMode === mode ? "active" : ""}`}
                  disabled={!form.scheduleEnabled}
                  onClick={() =>
                    setForm((prev) => ({ ...prev, scheduleMode: mode }))
                  }
                >
                  {mode === "cron" ? "Cron 定时" : "间隔定时"}
                </button>
              ))}
            </div>
            {form.scheduleEnabled && form.scheduleMode === "cron" ? (
              <label>
                <span>Cron 表达式</span>
                <input
                  value={form.cronExpression}
                  onChange={(event) =>
                    setForm((prev) => ({ ...prev, cronExpression: event.target.value }))
                  }
                  placeholder="0 */3 * * *"
                />
                <span className="field-hint">标准 5 段式 cron，如 0 */3 * * * 表示每 3 小时执行一次</span>
              </label>
            ) : null}
            {form.scheduleEnabled && form.scheduleMode === "interval" ? (
              <label>
                <span>间隔分钟</span>
                <input
                  type="number"
                  min={5}
                  value={form.intervalMinutes}
                  onChange={(event) =>
                    setForm((prev) => ({ ...prev, intervalMinutes: Number(event.target.value) }))
                  }
                />
                <span className="field-hint">最小 5 分钟，每过该间隔触发一次</span>
              </label>
            ) : null}
          </div>
          <NotifyFields form={form} setForm={setForm} robots={robotList} />
          {error && <div className="error-banner">{error}</div>}
          <div className="modal-form-actions">
            <button className="primary-button" type="submit" disabled={busy}>
              {busy ? <Loader2 size={16} className="spin" /> : <Plus size={16} />}
              创建任务
            </button>
            <button className="ghost-button" type="button" onClick={() => setCreateOpen(false)}>
              取消
            </button>
          </div>
        </form>
      </Modal>

      <Modal
        open={editOpen}
        title={
          <div className="modal-title-inner">
            <Edit2 size={18} />
            编辑巡检任务
          </div>
        }
        onClose={() => setEditOpen(false)}
      >
        <form
          className="inspection-form modal-form"
          onSubmit={(event) => {
            event.preventDefault();
            void submitEdit();
          }}
        >
          <label>
            <span>任务名称</span>
            <input
              value={editForm.name}
              onChange={(event) => setEditForm((prev) => ({ ...prev, name: event.target.value }))}
              placeholder="默认使用 URL 域名"
            />
          </label>
          <label>
            <span>业务环境</span>
            <select
              value={editForm.businessId}
              onChange={(event) => {
                const env = environments.find((item) => item.id === event.target.value);
                setEditForm((prev) => ({
                  ...prev,
                  businessId: event.target.value,
                  url: env?.url ?? prev.url,
                  username: env?.username ?? prev.username
                }));
              }}
            >
              <option value="">自定义 / 不选择</option>
              {environments.map((env) => (
                <option key={env.id} value={env.id}>
                  {env.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>URL</span>
            <input
              required
              value={editForm.url}
              onChange={(event) => setEditForm((prev) => ({ ...prev, url: event.target.value }))}
              placeholder="https://example.com"
            />
          </label>
          <div className="form-grid">
            <label>
              <span>账号</span>
              <input
                value={editForm.username}
                onChange={(event) => setEditForm((prev) => ({ ...prev, username: event.target.value }))}
                placeholder="可选"
              />
            </label>
            <label>
              <span>密码</span>
              <input
                type="password"
                value={editForm.password}
                onChange={(event) => setEditForm((prev) => ({ ...prev, password: event.target.value }))}
                placeholder="留空则保持原密码"
                autoComplete="new-password"
              />
            </label>
          </div>
          <label>
            <span>巡检 Prompt</span>
            <textarea
              value={editForm.prompt}
              onChange={(event) => setEditForm((prev) => ({ ...prev, prompt: event.target.value }))}
              placeholder="不填则使用通用页面巡检策略"
            />
          </label>
          <div className="form-section schedule-section">
            <div className="form-section-head">
              <span>调度设置</span>
              <label className="switch-toggle">
                <input
                  type="checkbox"
                  checked={editForm.scheduleEnabled}
                  onChange={(event) =>
                    setEditForm((prev) => ({ ...prev, scheduleEnabled: event.target.checked }))
                  }
                />
                <span className="switch-track">
                  <span className="switch-thumb" />
                </span>
                <em>{editForm.scheduleEnabled ? "已开启" : "未开启"}</em>
              </label>
            </div>
            <div className="schedule-mode-group">
              {(["cron", "interval"] as const).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  className={`seg-button ${editForm.scheduleMode === mode ? "active" : ""}`}
                  disabled={!editForm.scheduleEnabled}
                  onClick={() => setEditForm((prev) => ({ ...prev, scheduleMode: mode }))}
                >
                  {mode === "cron" ? "Cron 定时" : "间隔定时"}
                </button>
              ))}
            </div>
            {editForm.scheduleEnabled && editForm.scheduleMode === "cron" ? (
              <label>
                <span>Cron 表达式</span>
                <input
                  value={editForm.cronExpression}
                  onChange={(event) =>
                    setEditForm((prev) => ({ ...prev, cronExpression: event.target.value }))
                  }
                  placeholder="0 */3 * * *"
                />
                <span className="field-hint">标准 5 段式 cron，如 0 */3 * * * 表示每 3 小时执行一次</span>
              </label>
            ) : null}
            {editForm.scheduleEnabled && editForm.scheduleMode === "interval" ? (
              <label>
                <span>间隔分钟</span>
                <input
                  type="number"
                  min={5}
                  value={editForm.intervalMinutes}
                  onChange={(event) =>
                    setEditForm((prev) => ({ ...prev, intervalMinutes: Number(event.target.value) }))
                  }
                />
                <span className="field-hint">最小 5 分钟，每过该间隔触发一次</span>
              </label>
            ) : null}
          </div>
          <NotifyFields form={editForm} setForm={setEditForm} robots={robotList} />
          {error && <div className="error-banner">{error}</div>}
          <div className="modal-form-actions">
            <button className="primary-button" type="submit" disabled={busy}>
              {busy ? <Loader2 size={16} className="spin" /> : <Edit2 size={16} />}
              保存修改
            </button>
            <button className="ghost-button" type="button" onClick={() => setEditOpen(false)}>
              取消
            </button>
          </div>
        </form>
      </Modal>

      <Modal
        open={Boolean(activeRunDetail)}
        title={
          <div className="modal-title-inner">
            <History size={18} />
            执行记录详情
          </div>
        }
        onClose={() => setActiveRunDetail(undefined)}
        footer={
          activeRunDetail?.sessionId ? (
            <div className="modal-run-detail-footer">
              <a
                className="primary-button"
                href={`/api/sessions/${activeRunDetail.sessionId}/artifacts/download`}
              >
                <Download size={14} />
                下载产物
              </a>
              <button
                className="ghost-button"
                onClick={() => openSessionPage(activeRunDetail.sessionId!)}
              >
                打开会话
              </button>
              <button className="ghost-button" type="button" onClick={() => setActiveRunDetail(undefined)}>
                关闭
              </button>
            </div>
          ) : undefined
        }
      >
        {activeRunDetail && activeTask ? (
          <div className="run-detail-body">
            <div className="detail-grid">
              <InfoTile
                icon={<History size={15} />}
                label="状态"
                value={
                  activeRunDetail.status === "running"
                    ? "执行中"
                    : activeRunDetail.status === "completed"
                      ? "完成"
                      : activeRunDetail.status === "failed"
                        ? "失败"
                        : activeRunDetail.status === "aborted"
                          ? "中止"
                          : activeRunDetail.status
                }
              />
              <InfoTile
                icon={<CalendarClock size={15} />}
                label="触发方式"
                value={activeRunDetail.trigger === "manual" ? "手动触发" : "定时触发"}
              />
              <InfoTile
                icon={<Clock3 size={15} />}
                label="开始时间"
                value={formatTime(activeRunDetail.startedAt)}
              />
              <InfoTile
                icon={<Clock3 size={15} />}
                label="结束时间"
                value={activeRunDetail.finishedAt ? formatTime(activeRunDetail.finishedAt) : "—"}
              />
              <InfoTile icon={<User size={15} />} label="账号" value={activeTask.username ?? "未设置"} />
              <InfoTile icon={<FileText size={15} />} label="页面 URL" value={activeTask.url} />
              {activeRunDetail.notifyStatus ? (
                <InfoTile
                  icon={<Bell size={15} />}
                  label="通知状态"
                  value={
                    activeRunDetail.notifyStatus === "sent"
                      ? "已推送"
                      : activeRunDetail.notifyStatus === "failed"
                        ? `失败：${activeRunDetail.notifyMessage ?? ""}`
                        : `未推送：${activeRunDetail.notifyMessage ?? ""}`
                  }
                />
              ) : null}
            </div>
            <div className="run-detail-block">
              <div className="run-detail-label">巡检 Prompt</div>
              <pre className="run-detail-pre">{activeTask.prompt || "（未自定义，使用通用页面巡检策略）"}</pre>
            </div>
            <div className="run-detail-block">
              <div className="run-detail-label">执行结果</div>
              <pre className="run-detail-pre">{activeRunDetail.error || activeRunDetail.summary || (activeRunDetail.status === "running" ? "执行中…" : "—")}</pre>
            </div>
            {activeRunDetail.sessionId ? (
              <div className="run-detail-block">
                <div className="run-detail-label">会话 / 产物</div>
                <div className="run-detail-session">
                  <code>{activeRunDetail.sessionId}</code>
                  {activeRunDetail.artifactsCount ? <span className="muted">产物 {activeRunDetail.artifactsCount} 个</span> : null}
                </div>
              </div>
            ) : null}
          </div>
        ) : null}
      </Modal>
    </main>
  );
}

function InfoTile({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <div className="info-tile">
      {icon}
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function NotifyStatusBadge({ status, message }: { status?: NotifyStatus; message?: string }) {
  if (!status) return null;
  const label = status === "sent" ? "通知已推送" : status === "failed" ? "通知失败" : "未推送";
  const cls = status === "sent" ? "badge-active" : status === "failed" ? "badge-failed" : "badge-default";
  const title = message || label;
  return (
    <span className={`badge ${cls}`} title={title}>
      {label}
    </span>
  );
}

function EnvironmentPicker({
  environments,
  value,
  onChange
}: {
  environments: BusinessEnvironment[];
  value: EnvironmentSelection;
  onChange: React.Dispatch<React.SetStateAction<EnvironmentSelection>>;
}) {
  return (
    <div className={`environment-picker ${value.businessId ? "is-business" : ""}`}>
      <label>
        <span>业务环境</span>
        <select
          value={value.businessId}
          onChange={(event) =>
            onChange((prev) => ({
              ...prev,
              businessId: event.target.value,
              customUrl: "",
              customUsername: "",
              customPassword: ""
            }))
          }
        >
          <option value="">自定义 / 不选择</option>
          {environments.map((env) => (
            <option key={env.id} value={env.id}>
              {env.name}
            </option>
          ))}
        </select>
      </label>
      {!value.businessId && (
        <>
          <label>
            <span>URL</span>
            <input
              value={value.customUrl}
              onChange={(event) => onChange((prev) => ({ ...prev, customUrl: event.target.value }))}
              placeholder="可选"
            />
          </label>
          <label>
            <span>账号</span>
            <input
              value={value.customUsername}
              onChange={(event) => onChange((prev) => ({ ...prev, customUsername: event.target.value }))}
              placeholder="可选"
            />
          </label>
          <label>
            <span>密码</span>
            <input
              type="password"
              value={value.customPassword}
              onChange={(event) => onChange((prev) => ({ ...prev, customPassword: event.target.value }))}
              placeholder="可选"
            />
          </label>
        </>
      )}
    </div>
  );
}

function downloadableArtifacts(artifacts: ArtifactInfo[]): ArtifactInfo[] {
  return artifacts.filter((artifact) => artifact.kind === "file" && (
    artifact.isCoreReport
    || isYamlArtifact(artifact)
    || isBrowserRepArtifact(artifact)
    || isNativeRepArtifact(artifact)
    || isScreenshotArtifact(artifact)
    || canPreviewArtifact(artifact)
    || artifact.relativePath.toLowerCase().endsWith(".zip")
  ));
}

function canPreviewArtifact(artifact: ArtifactInfo): boolean {
  const name = artifact.relativePath.toLowerCase();
  return isScreenshotArtifact(artifact)
    || /\.(html?|md|txt|log|json|jsonl|har|ya?ml)$/.test(name);
}

function isBrowserRepArtifact(artifact: ArtifactInfo): boolean {
  const relativePath = artifact.relativePath.replace(/\\/g, "/");
  return relativePath.includes(".skill-output/uiwarden-reps/")
    || relativePath.includes(".skill-output/browser-reps/");
}

function isNativeRepArtifact(artifact: ArtifactInfo): boolean {
  return artifact.relativePath.replace(/\\/g, "/").includes(".skill-output/native-reps/");
}

function isNativeRepManifest(artifact: ArtifactInfo): boolean {
  return isNativeRepArtifact(artifact) && artifact.name.toLowerCase() === "manifest.json";
}

function isBrowserRepManifest(artifact: ArtifactInfo): boolean {
  return isBrowserRepArtifact(artifact) && artifact.name.toLowerCase() === "manifest.json";
}

function isHighlightedArtifact(artifact: ArtifactInfo): boolean {
  return Boolean(artifact.isCoreReport) || isBrowserRepManifest(artifact) || isNativeRepManifest(artifact);
}

function artifactGroup(artifact: ArtifactInfo): string {
  const name = artifact.relativePath.toLowerCase();
  if (isScreenshotArtifact(artifact)) return "截图";
  if (name.includes("/streams/network.jsonl")) return "网络";
  if (name.endsWith("/network.har")) return "网络";
  if (name.includes("/streams/console.jsonl") || name.includes("/streams/page-errors.jsonl")) return "控制台";
  if (name.includes("/trace/") || name.endsWith(".zip")) return "Trace";
  if (name.includes("/streams/events.jsonl")) return "操作";
  return "报告";
}

function artifactMatchesCategory(artifact: ArtifactInfo, category: ArtifactCategory): boolean {
  if (category === "全部") return true;
  if (category === "Browser Rep") return isBrowserRepArtifact(artifact);
  if (category === "Native Rep") return isNativeRepArtifact(artifact);
  return artifactGroup(artifact) === category;
}

function groupArtifacts(artifacts: ArtifactInfo[]): Array<[string, ArtifactInfo[]]> {
  const order = ["截图", "网络", "控制台", "Trace", "操作", "报告"];
  const groups = new Map<string, ArtifactInfo[]>();
  for (const artifact of artifacts) {
    const group = artifactGroup(artifact);
    groups.set(group, [...(groups.get(group) ?? []), artifact]);
  }
  return order.flatMap((group) => groups.has(group) ? [[group, groups.get(group)!] as [string, ArtifactInfo[]]] : []);
}

function availableArtifactCategories(artifacts: ArtifactInfo[]): ArtifactCategory[] {
  const order: ArtifactCategory[] = ["全部", "Browser Rep", "Native Rep", "截图", "报告", "操作", "网络", "控制台", "Trace"];
  return order.filter((category) => category === "全部" || artifacts.some((artifact) => artifactMatchesCategory(artifact, category)));
}

function screenshotArtifacts(sessionId: string, artifacts: ArtifactInfo[]): ScreenshotFrame[] {
  const screenshotArtifacts = artifacts.filter(
    (artifact) => artifact.kind === "file" && isScreenshotArtifact(artifact)
  );
  const hasResultFrames = screenshotArtifacts.some((artifact) =>
    artifact.relativePath.includes(".uiwarden-screenshots")
  );
  return screenshotArtifacts
    .filter((artifact) => !hasResultFrames || !artifact.relativePath.includes("uiwarden-observation"))
    .sort((a, b) => a.modifiedAt.localeCompare(b.modifiedAt))
    .map((artifact) => {
      const match = artifact.relativePath.match(/frame_(\d+)_/);
      const stepIndex = match ? parseInt(match[1], 10) : undefined;
      return {
        relativePath: artifact.relativePath,
        url: `/api/sessions/${sessionId}/preview/${encodeArtifactPath(artifact.relativePath)}?v=${encodeURIComponent(artifact.modifiedAt)}`,
        modifiedAt: artifact.modifiedAt,
        stepIndex: stepIndex != null && Number.isFinite(stepIndex) ? stepIndex : undefined,
        source: artifact.relativePath.includes("uiwarden-observation") ? "live" : "artifact"
      };
    });
}

function mergeScreenshotFrames(current: ScreenshotFrame[], incoming: ScreenshotFrame[]): ScreenshotFrame[] {
  const incomingHasResult = incoming.some(
    (frame) => frame.relativePath?.includes(".uiwarden-screenshots")
  );
  const incomingHasLive = incoming.some(
    (frame) => frame.relativePath?.includes("uiwarden-observation")
  );
  const shouldPruneLive = incomingHasResult && !incomingHasLive;
  const byPath = new Map<string, ScreenshotFrame>();
  for (const frame of current) {
    if (!frame.relativePath) {
      continue;
    }
    if (shouldPruneLive && frame.relativePath.includes("uiwarden-observation")) {
      continue;
    }
    byPath.set(frame.relativePath, frame);
  }
  for (const frame of incoming) {
    if (!frame.relativePath) {
      continue;
    }
    const previous = byPath.get(frame.relativePath);
    byPath.set(frame.relativePath, {
      ...previous,
      ...frame
    });
  }
  return [...byPath.values()].sort((a, b) => {
    if (a.stepIndex != null && b.stepIndex != null) {
      return a.stepIndex - b.stepIndex;
    }
    if (a.stepIndex != null) {
      return -1;
    }
    if (b.stepIndex != null) {
      return 1;
    }
    return a.modifiedAt.localeCompare(b.modifiedAt);
  });
}

function artifactPreviewHref(sessionId: string, artifact: ArtifactInfo): string {
  return `/api/sessions/${sessionId}/preview/${encodeArtifactPath(artifact.relativePath)}`;
}

function artifactDownloadHref(sessionId: string, artifact: ArtifactInfo): string {
  return `/api/sessions/${sessionId}/files/${encodeArtifactPath(artifact.relativePath)}`;
}

function encodeArtifactPath(relativePath: string): string {
  return relativePath.replace(/\\/g, "/").split("/").map(encodeURIComponent).join("/");
}

function artifactLabel(artifact: ArtifactInfo): string {
  if (artifact.isCoreReport) {
    return "HTML 报告";
  }
  if (isNativeRepManifest(artifact)) {
    return "Native Rep 清单";
  }
  if (isBrowserRepManifest(artifact)) {
    return "Browser Rep 清单";
  }
  if (isYamlArtifact(artifact)) {
    return "YAML";
  }
  return formatSize(artifact.size);
}

function isYamlArtifact(artifact: ArtifactInfo): boolean {
  const name = artifact.relativePath.toLowerCase();
  return name.endsWith(".yaml") || name.endsWith(".yml");
}

function isScreenshotArtifact(artifact: ArtifactInfo): boolean {
  const name = artifact.relativePath.toLowerCase();
  return name.endsWith(".png") || name.endsWith(".jpg") || name.endsWith(".jpeg") || name.endsWith(".webp");
}

function isImageArtifact(artifact: ArtifactInfo): boolean {
  return isScreenshotArtifact(artifact);
}

function EnvironmentCenter({
  environments,
  onSave,
  onDelete,
  onRefresh
}: {
  environments: BusinessEnvironment[];
  onSave: (input: {
    id?: string;
    name: string;
    url: string;
    username: string;
    password: string;
    description: string;
  }) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
  onRefresh: () => Promise<void>;
}) {
  const [editing, setEditing] = useState<BusinessEnvironment>();
  const [detailId, setDetailId] = useState<string>();
  const [form, setForm] = useState({ name: "", url: "", username: "", password: "", description: "" });
  const [modalOpen, setModalOpen] = useState(false);
  const envPagination = usePagination(environments, 30);
  const detailEnv = environments.find((e) => e.id === detailId);
  const fill = (env?: BusinessEnvironment) => {
    setEditing(env);
    setForm({
      name: env?.name ?? "",
      url: env?.url ?? "",
      username: env?.username ?? "",
      password: "",
      description: env?.description ?? ""
    });
  };
  const openCreate = () => {
    fill();
    setModalOpen(true);
  };
  const openEdit = (env: BusinessEnvironment) => {
    fill(env);
    setModalOpen(true);
  };
  const closeModal = () => {
    setModalOpen(false);
    fill();
  };
  return (
    <main className="config-area">
      <header className="chat-header">
        <div>
          <h1>业务测试环境</h1>
          <p>维护业务 URL、账号和密码，供对话与巡检任务直接选择。</p>
        </div>
        <div className="header-actions">
          <button className="new-button" onClick={openCreate}>
            <Plus size={16} />
            新增环境
          </button>
          <RefreshIconButton title="刷新业务环境" onRefresh={onRefresh} />
        </div>
      </header>
      <section className="config-content">
        <div className="config-list full">
            <div className="panel-title">
              <Settings size={16} />
              环境列表
              <span className="muted">共 {environments.length} 个</span>
            </div>
            {envPagination.pagedItems.length ? (
              envPagination.pagedItems.map((env) => (
                <div
                  key={env.id}
                  className={`config-item ${detailId === env.id ? "selected-row" : ""}`}
                  onClick={() => setDetailId(env.id)}
                >
                  <div className="config-item-main clickable">
                    <strong>{env.name}</strong>
                    <span>{env.url}</span>
                    <em>{env.username ?? "无账号"} · {env.hasPassword ? "密码已保存" : "无密码"}</em>
                  </div>
                  <div className="config-item-actions" onClick={(e) => e.stopPropagation()}>
                    <button className="ghost-button" onClick={() => openEdit(env)}>
                      <Pencil size={14} />
                      编辑
                    </button>
                    <button className="danger-button" onClick={() => void onDelete(env.id)}>删除</button>
                  </div>
                </div>
              ))
            ) : (
              <div className="empty-state">
                <Settings size={24} />
                <span>暂无业务环境，点击右上角"新增环境"创建</span>
              </div>
            )}
            <Pagination state={envPagination} />
          </div>

        <Modal
          open={!!detailEnv}
          title={
            <div className="modal-title-inner">
              <Server size={18} />
              {detailEnv?.name ?? "环境详情"}
            </div>
          }
          onClose={() => setDetailId(undefined)}
          footer={
            detailEnv ? (
              <div className="header-actions">
                <button className="ghost-button" onClick={() => openEdit(detailEnv)}>
                  <Pencil size={14} />
                  编辑
                </button>
                <button className="danger-button" onClick={() => void onDelete(detailEnv.id).then(() => setDetailId(undefined))}>
                  删除
                </button>
              </div>
            ) : null
          }
        >
          {detailEnv ? (
            <div className="detail-modal-body">
              <div className="detail-field-row">
                <span className="detail-field-label"><Server size={14} /> 业务 URL</span>
                <strong className="detail-field-value">{detailEnv.url}</strong>
              </div>
              <div className="detail-field-row">
                <span className="detail-field-label"><User size={14} /> 账号</span>
                <strong className="detail-field-value">{detailEnv.username ?? "未设置"}</strong>
              </div>
              <div className="detail-field-row">
                <span className="detail-field-label"><KeyRound size={14} /> 密码</span>
                <strong className="detail-field-value">{detailEnv.hasPassword ? detailEnv.passwordMasked ?? "******" : "未设置"}</strong>
              </div>
              {detailEnv.description ? (
                <div className="detail-field-row">
                  <span className="detail-field-label"><FileText size={14} /> 描述</span>
                  <p className="detail-field-value detail-field-text">{detailEnv.description}</p>
                </div>
              ) : null}
            </div>
          ) : null}
        </Modal>
      </section>

      <Modal
        open={modalOpen}
        title={
          <div className="modal-title-inner">
            {editing ? <Pencil size={18} /> : <Plus size={18} />}
            {editing ? "编辑业务环境" : "新增业务环境"}
          </div>
        }
        onClose={closeModal}
      >
        <form
          className="config-form modal-form"
          onSubmit={(event) => {
            event.preventDefault();
            void onSave({ id: editing?.id, ...form }).then(() => closeModal());
          }}
        >
          <label><span>业务名称</span><input required value={form.name} onChange={(e) => setForm((p) => ({ ...p, name: e.target.value }))} /></label>
          <label><span>业务 URL</span><input required value={form.url} onChange={(e) => setForm((p) => ({ ...p, url: e.target.value }))} /></label>
          <label><span>账号</span><input value={form.username} onChange={(e) => setForm((p) => ({ ...p, username: e.target.value }))} /></label>
          <label><span>密码</span><input type="password" placeholder={editing?.hasPassword ? "留空则保持原密码" : ""} value={form.password} onChange={(e) => setForm((p) => ({ ...p, password: e.target.value }))} /></label>
          <label><span>描述</span><textarea value={form.description} onChange={(e) => setForm((p) => ({ ...p, description: e.target.value }))} /></label>
          <div className="modal-form-actions">
            <button className="primary-button" type="submit">{editing ? "保存" : "新增"}</button>
            <button className="ghost-button" type="button" onClick={closeModal}>取消</button>
          </div>
        </form>
      </Modal>
    </main>
  );
}

function HostCenter({
  entries,
  status,
  onSave,
  onDelete,
  onRefresh
}: {
  entries: HostEntry[];
  status: HostApplyStatus;
  onSave: (input: { id?: string; ip: string; hostname: string; comment: string; enabled: boolean }) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
  onRefresh: () => Promise<void>;
}) {
  const [editing, setEditing] = useState<HostEntry>();
  const [detailId, setDetailId] = useState<string>();
  const [form, setForm] = useState({ ip: "", hostname: "", comment: "", enabled: true });
  const [modalOpen, setModalOpen] = useState(false);
  const hostPagination = usePagination(entries, 30);
  const detailEntry = entries.find((e) => e.id === detailId);
  const fill = (entry?: HostEntry) => {
    setEditing(entry);
    setForm({
      ip: entry?.ip ?? "",
      hostname: entry?.hostname ?? "",
      comment: entry?.comment ?? "",
      enabled: entry?.enabled ?? true
    });
  };
  const openCreate = () => {
    fill();
    setModalOpen(true);
  };
  const openEdit = (entry: HostEntry) => {
    fill(entry);
    setModalOpen(true);
  };
  const closeModal = () => {
    setModalOpen(false);
    fill();
  };
  return (
    <main className="config-area">
      <header className="chat-header">
        <div>
          <h1>Host 管理</h1>
          <p>{status.message ?? "新增、编辑或删除后会实时尝试写入执行系统 hosts。"}</p>
        </div>
        <div className="header-actions">
          <button className="new-button" onClick={openCreate}>
            <Plus size={16} />
            新增 Host
          </button>
          <RefreshIconButton title="刷新 Host 列表" onRefresh={onRefresh} />
        </div>
      </header>
      <section className="config-content">
        <div className="config-list full">
            <div className="panel-title">
              <Server size={16} />
              Host 列表
              <span className="muted">共 {entries.length} 条</span>
            </div>
            {status.message && (
              <div className={`host-status ${status.applied ? "success" : "warning"}`}>
                {status.message}
              </div>
            )}
            {hostPagination.pagedItems.length ? (
              hostPagination.pagedItems.map((entry) => (
                <div
                  key={entry.id}
                  className={`config-item ${detailId === entry.id ? "selected-row" : ""}`}
                  onClick={() => setDetailId(entry.id)}
                >
                  <div className="config-item-main clickable">
                    <strong>
                      {entry.hostname}
                      <span className={`badge ${entry.enabled ? "badge-active" : "badge-default"}`}>
                        {entry.enabled ? "启用" : "停用"}
                      </span>
                    </strong>
                    <span>{entry.ip}</span>
                    <em>{entry.comment ?? "无备注"}</em>
                  </div>
                  <div className="config-item-actions" onClick={(e) => e.stopPropagation()}>
                    <button
                      className="ghost-button"
                      onClick={() =>
                        void onSave({
                          id: entry.id,
                          ip: entry.ip,
                          hostname: entry.hostname,
                          comment: entry.comment ?? "",
                          enabled: !entry.enabled
                        })
                      }
                    >
                      {entry.enabled ? "下线" : "启用"}
                    </button>
                    <button className="ghost-button" onClick={() => openEdit(entry)}>
                      <Pencil size={14} />
                      编辑
                    </button>
                    <button className="danger-button" onClick={() => void onDelete(entry.id)}>删除</button>
                  </div>
                </div>
              ))
            ) : (
              <div className="empty-state">
                <Server size={24} />
                <span>暂无 Host 条目，点击右上角"新增 Host"创建</span>
              </div>
            )}
            <Pagination state={hostPagination} />
          </div>

        <Modal
          open={!!detailEntry}
          title={
            <div className="modal-title-inner">
              <Server size={18} />
              {detailEntry?.hostname ?? "Host 详情"}
            </div>
          }
          onClose={() => setDetailId(undefined)}
          footer={
            detailEntry ? (
              <div className="header-actions">
                <button
                  className="ghost-button"
                  onClick={() =>
                    void onSave({
                      id: detailEntry.id,
                      ip: detailEntry.ip,
                      hostname: detailEntry.hostname,
                      comment: detailEntry.comment ?? "",
                      enabled: !detailEntry.enabled
                    })
                  }
                >
                  {detailEntry.enabled ? "下线" : "启用"}
                </button>
                <button className="ghost-button" onClick={() => openEdit(detailEntry)}>
                  <Pencil size={14} />
                  编辑
                </button>
                <button className="danger-button" onClick={() => void onDelete(detailEntry.id).then(() => setDetailId(undefined))}>
                  删除
                </button>
              </div>
            ) : null
          }
        >
          {detailEntry ? (
            <div className="detail-modal-body">
              <div className="detail-field-row">
                <span className="detail-field-label"><Server size={14} /> IP</span>
                <strong className="detail-field-value">{detailEntry.ip}</strong>
              </div>
              <div className="detail-field-row">
                <span className="detail-field-label"><Terminal size={14} /> Hostname</span>
                <strong className="detail-field-value">{detailEntry.hostname}</strong>
              </div>
              <div className="detail-field-row">
                <span className="detail-field-label"><KeyRound size={14} /> 状态</span>
                <strong className="detail-field-value">
                  <span className={`badge ${detailEntry.enabled ? "badge-active" : "badge-default"}`}>
                    {detailEntry.enabled ? "启用" : "停用"}
                  </span>
                </strong>
              </div>
              <div className="detail-field-row">
                <span className="detail-field-label"><Clock3 size={14} /> 更新时间</span>
                <strong className="detail-field-value">{formatTime(detailEntry.updatedAt)}</strong>
              </div>
              {detailEntry.comment ? (
                <div className="detail-field-row">
                  <span className="detail-field-label"><FileText size={14} /> 备注</span>
                  <p className="detail-field-value detail-field-text">{detailEntry.comment}</p>
                </div>
              ) : null}
            </div>
          ) : null}
        </Modal>
      </section>

      <Modal
        open={modalOpen}
        title={
          <div className="modal-title-inner">
            {editing ? <Pencil size={18} /> : <Plus size={18} />}
            {editing ? "编辑 Host" : "新增 Host"}
          </div>
        }
        onClose={closeModal}
      >
        <form
          className="config-form modal-form"
          onSubmit={(event) => {
            event.preventDefault();
            void onSave({ id: editing?.id, ...form }).then(() => closeModal());
          }}
        >
          <label><span>IP</span><input required value={form.ip} onChange={(e) => setForm((p) => ({ ...p, ip: e.target.value }))} placeholder="127.0.0.1" /></label>
          <label><span>Hostname</span><input required value={form.hostname} onChange={(e) => setForm((p) => ({ ...p, hostname: e.target.value }))} placeholder="example.test" /></label>
          <label><span>备注</span><input value={form.comment} onChange={(e) => setForm((p) => ({ ...p, comment: e.target.value }))} /></label>
          <label className="check-row"><input type="checkbox" checked={form.enabled} onChange={(e) => setForm((p) => ({ ...p, enabled: e.target.checked }))} />启用</label>
          <div className="modal-form-actions">
            <button className="primary-button" type="submit">{editing ? "保存并应用" : "新增并应用"}</button>
            <button className="ghost-button" type="button" onClick={closeModal}>取消</button>
          </div>
        </form>
      </Modal>
    </main>
  );
}

function NotifyFields({
  form,
  setForm,
  robots
}: {
  form: InspectionForm;
  setForm: React.Dispatch<React.SetStateAction<InspectionForm>>;
  robots: DingtalkRobot[];
}) {
  return (
    <div className="form-row">
      <label>
        <span>通知机器人</span>
        <select
          value={form.notifyRobotId}
          onChange={(e) => setForm((prev) => ({ ...prev, notifyRobotId: e.target.value }))}
        >
          <option value="">不通知</option>
          {robots.map((r) => (
            <option key={r.id} value={r.id}>{r.name}</option>
          ))}
        </select>
      </label>
      <label>
        <span>触发条件</span>
        <select
          value={form.notifyTrigger}
          onChange={(e) => setForm((prev) => ({ ...prev, notifyTrigger: e.target.value as InspectionNotifyTrigger }))}
        >
          <option value="always">执行完就通知</option>
          <option value="failed">仅失败通知</option>
          <option value="never">不通知</option>
        </select>
      </label>
    </div>
  );
}

function NotifyCenter({
  robots,
  form,
  setForm,
  editingId,
  setEditingId,
  onSave,
  onDelete,
  onTest,
  onRefresh
}: {
  robots: DingtalkRobot[];
  form: DingtalkRobotForm;
  setForm: React.Dispatch<React.SetStateAction<DingtalkRobotForm>>;
  editingId?: string;
  setEditingId: React.Dispatch<React.SetStateAction<string | undefined>>;
  onSave: (input: DingtalkRobotForm & { id?: string }) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
  onTest: (id: string) => Promise<void>;
  onRefresh: () => Promise<void>;
}) {
  const [modalOpen, setModalOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const openCreate = () => {
    setEditingId(undefined);
    setForm({ name: "", webhookUrl: "", secret: "", description: "", inspectionTemplate: "", regressionTemplate: "" });
    setModalOpen(true);
  };
  const openEdit = (robot: DingtalkRobot) => {
    setEditingId(robot.id);
    setForm({
      name: robot.name,
      // Show the masked webhookUrl (token replaced with ******) so the secret
      // is never echoed back in plaintext. Submitting the masked value means
      // "keep the original" — the backend treats masked/empty as unchanged.
      webhookUrl: robot.webhookUrlMasked ?? "",
      secret: "",
      description: robot.description ?? "",
      inspectionTemplate: robot.inspectionTemplate ?? "",
      regressionTemplate: robot.regressionTemplate ?? ""
    });
    setModalOpen(true);
  };
  const closeModal = () => {
    setModalOpen(false);
    setEditingId(undefined);
  };
  const handleSubmit = async () => {
    setBusy(true);
    try {
      await onSave({ ...form, id: editingId });
      closeModal();
    } catch (e) {
      alert(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const handleDelete = async (id: string) => {
    if (!confirm("确认删除该机器人？")) return;
    try {
      await onDelete(id);
    } catch (e) {
      alert(e instanceof Error ? e.message : String(e));
    }
  };
  const [templateHelpOpen, setTemplateHelpOpen] = useState(false);

  return (
    <main className="config-area">
      <header className="chat-header">
        <div>
          <h1>通知管理</h1>
          <p>配置钉钉群机器人 Webhook，支持在巡检/回归任务中选择机器人并设置触发条件（执行完就通知 / 仅失败通知）。</p>
        </div>
        <div className="header-actions">
          <button className="new-button" onClick={openCreate}>
            <Plus size={16} />
            新增机器人
          </button>
          <RefreshIconButton title="刷新通知配置" onRefresh={onRefresh} />
        </div>
      </header>
      <section className="config-content">
        <div className="config-list full">
          <div className="panel-title">
            <Bell size={15} />
            钉钉群机器人
            <span className="muted">共 {robots.length} 个</span>
          </div>
          {robots.length ? (
            robots.map((robot) => (
              <div key={robot.id} className="config-item">
                <div className="config-item-main">
                  <div className="config-item-title">{robot.name}</div>
                  <div className="config-item-sub muted">
                    {robot.webhookUrlMasked ?? robot.webhookUrl ?? "—"}
                  </div>
                  <div className="config-item-sub muted">
                    {robot.hasSecret ? `密钥：${robot.secretMasked}` : "未设置加签密钥"}
                    {robot.description ? ` · ${robot.description}` : ""}
                  </div>
                  <div className="config-item-sub muted">
                    {robot.inspectionTemplate ? "巡检模板：已自定义" : "巡检模板：默认"}
                    {" · "}
                    {robot.regressionTemplate ? "回归模板：已自定义" : "回归模板：默认"}
                  </div>
                </div>
                <div className="config-item-actions">
                  <button className="icon-button" title="测试推送" onClick={() => void onTest(robot.id)}>
                    <Send size={15} />
                  </button>
                  <button className="icon-button" title="编辑" onClick={() => openEdit(robot)}>
                    <Edit2 size={15} />
                  </button>
                  <button className="icon-button danger-icon" title="删除" onClick={() => void handleDelete(robot.id)}>
                    <Trash2 size={15} />
                  </button>
                </div>
              </div>
            ))
          ) : (
            <div className="empty-hint">暂无机器人，点击「新增机器人」配置钉钉群 Webhook。</div>
          )}
        </div>
      </section>
      {modalOpen && (
        <div className="modal-overlay" onClick={closeModal}>
          <div className="modal-dialog" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <div className="modal-title">
                {editingId ? "编辑机器人" : "新增机器人"}
                <button
                  type="button"
                  className="icon-button"
                  title="查看自定义模板示例"
                  onClick={() => setTemplateHelpOpen(true)}
                  style={{ marginLeft: 6, verticalAlign: "middle" }}
                >
                  <HelpCircle size={16} />
                </button>
              </div>
              <button className="modal-close" type="button" onClick={closeModal} aria-label="关闭">
                <X size={18} />
              </button>
            </div>
            <div className="modal-body">
              <div className="form-row">
                <label>名称</label>
                <input
                  value={form.name}
                  onChange={(e) => setForm((p) => ({ ...p, name: e.target.value }))}
                  placeholder="如：UI 测试告警群"
                />
              </div>
              <div className="form-row">
                <label>Webhook URL</label>
                <input
                  value={form.webhookUrl}
                  onChange={(e) => setForm((p) => ({ ...p, webhookUrl: e.target.value }))}
                  placeholder="https://oapi.dingtalk.com/robot/send?access_token=..."
                />
              </div>
              <div className="form-row">
                <label>加签密钥（可选）</label>
                <input
                  value={form.secret}
                  onChange={(e) => setForm((p) => ({ ...p, secret: e.target.value }))}
                  placeholder="启用「加签」安全设置时填写"
                />
              </div>
              <div className="form-row">
                <label>描述（可选）</label>
                <input
                  value={form.description}
                  onChange={(e) => setForm((p) => ({ ...p, description: e.target.value }))}
                  placeholder="群名称或用途说明"
                />
              </div>
              <div className="form-row">
                <label>巡检通知模板（可选）</label>
                <textarea
                  rows={6}
                  value={form.inspectionTemplate}
                  onChange={(e) => setForm((p) => ({ ...p, inspectionTemplate: e.target.value }))}
                  placeholder="留空使用默认模板。支持变量：{{taskName}} {{taskUrl}} {{statusLabel}} {{trigger}} {{summary}} {{error}} {{time}} {{resultLink}}"
                />
                <button
                  type="button"
                  className="ghost-button small-button"
                  onClick={() => setForm((p) => ({ ...p, inspectionTemplate: "" }))}
                >
                  恢复默认
                </button>
              </div>
              <div className="form-row">
                <label>回归通知模板（可选）</label>
                <textarea
                  rows={6}
                  value={form.regressionTemplate}
                  onChange={(e) => setForm((p) => ({ ...p, regressionTemplate: e.target.value }))}
                  placeholder="留空使用默认模板。支持变量：{{batchName}} {{statusLabel}} {{total}} {{completed}} {{failed}} {{aborted}} {{failedListBlock}} {{time}} {{resultLink}}"
                />
                <button
                  type="button"
                  className="ghost-button small-button"
                  onClick={() => setForm((p) => ({ ...p, regressionTemplate: "" }))}
                >
                  恢复默认
                </button>
              </div>
            </div>
            <div className="modal-footer">
              <button className="ghost-button" onClick={closeModal} disabled={busy}>
                取消
              </button>
              <button className="primary-button" onClick={handleSubmit} disabled={busy}>
                {busy ? "保存中…" : "保存"}
              </button>
            </div>
          </div>
        </div>
      )}
      {templateHelpOpen && (
        <div className="modal-overlay" onClick={() => setTemplateHelpOpen(false)}>
          <div className="modal-dialog" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <div className="modal-title">自定义通知模板示例</div>
              <button
                className="modal-close"
                type="button"
                onClick={() => setTemplateHelpOpen(false)}
                aria-label="关闭"
              >
                <X size={18} />
              </button>
            </div>
            <div className="modal-body">
              <p className="muted" style={{ marginBottom: 10 }}>
                留空使用默认模板。模板为 Markdown 文本，使用
                <code>{"{{变量名}}"}</code> 占位符注入运行时数据。支持变量见下表。
              </p>
              <div className="form-row">
                <label>巡检通知可用变量</label>
                <ul className="template-vars">
                  <li><code>{"{{taskName}}"}</code> — 巡检任务名称</li>
                  <li><code>{"{{taskUrl}}"}</code> — 巡检目标 URL</li>
                  <li><code>{"{{statusLabel}}"}</code> — 结果状态（✅ 通过 / ❌ 失败）</li>
                  <li><code>{"{{trigger}}"}</code> — 触发方式（定时调度 / 手动触发）</li>
                  <li><code>{"{{summary}}"}</code> — 巡检摘要（截断 400 字）</li>
                  <li><code>{"{{error}}"}</code> — 错误信息（截断 400 字）</li>
                  <li><code>{"{{time}}"}</code> — 通知时间 ISO</li>
                  <li><code>{"{{resultLink}}"}</code> — 结果详情页链接（用于「查看详情」）</li>
                </ul>
              </div>
              <div className="form-row">
                <label>巡检模板示例</label>
                <pre className="template-example">{"### {{taskName}} 巡检结果：{{statusLabel}}\n\n- 触发：{{trigger}}\n- 目标：{{taskUrl}}\n- 时间：{{time}}\n- 摘要：{{summary}}\n- [查看详情]({{resultLink}})"}</pre>
              </div>
              <div className="form-row">
                <label>回归通知可用变量</label>
                <ul className="template-vars">
                  <li><code>{"{{batchName}}"}</code> — 批次名称</li>
                  <li><code>{"{{statusLabel}}"}</code> — 批次状态（✅ 全部通过 / ❌ 存在失败）</li>
                  <li><code>{"{{total}}"}</code> — 用例总数</li>
                  <li><code>{"{{completed}}"}</code> — 通过数</li>
                  <li><code>{"{{failed}}"}</code> — 失败数</li>
                  <li><code>{"{{aborted}}"}</code> — 中止数</li>
                  <li><code>{"{{failedListBlock}}"}</code> — 失败用例清单（多行）</li>
                  <li><code>{"{{time}}"}</code> — 通知时间 ISO</li>
                  <li><code>{"{{resultLink}}"}</code> — 批次结果页链接</li>
                </ul>
              </div>
              <div className="form-row">
                <label>回归模板示例</label>
                <pre className="template-example">{"### 回归批次 {{batchName}}：{{statusLabel}}\n\n- 通过 {{completed}}/{{total}}，失败 {{failed}}，中止 {{aborted}}\n- 时间：{{time}}\n{{failedListBlock}}\n- [查看批次详情]({{resultLink}})"}</pre>
              </div>
            </div>
            <div className="modal-footer">
              <button className="primary-button" onClick={() => setTemplateHelpOpen(false)}>
                知道了
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}

function ModelCenter({
  profiles,
  runtimes,
  onSave,
  onDelete,
  onActivate,
  onSelectCatalogModel,
  onSelectRuntime,
  onRefresh
}: {
  profiles: ModelProfile[];
  runtimes: ExecutionRuntimeStatus[];
  onSave: (input: ModelForm & { id?: string }) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
  onActivate: (id: string) => Promise<void>;
  onSelectCatalogModel: (runtimeId: ExecutionRuntimeId, model?: string) => Promise<RuntimeModelCatalog>;
  onSelectRuntime: (runtimeId: ExecutionRuntimeId) => Promise<void>;
  onRefresh: () => Promise<void>;
}) {
  const selectedRuntime = runtimes.find((runtime) => runtime.selected);
  const selectedRuntimeId = selectedRuntime?.id ?? "cfuse";
  const [editing, setEditing] = useState<ModelProfile>();
  const [managingRuntimeId, setManagingRuntimeId] = useState<ExecutionRuntimeId>();
  const [activatingId, setActivatingId] = useState<string>();
  const [switchingRuntimeId, setSwitchingRuntimeId] = useState<ExecutionRuntimeId>();
  const [switchFeedback, setSwitchFeedback] = useState<{ kind: "success" | "error"; text: string }>();
  const [runtimeModelInfo, setRuntimeModelInfo] = useState<Partial<Record<ExecutionRuntimeId, RuntimeModelCatalog>>>({});
  const [loadingModelInfo, setLoadingModelInfo] = useState<ExecutionRuntimeId>();
  const [selectingModel, setSelectingModel] = useState(false);
  const [modelFeedback, setModelFeedback] = useState<{ kind: "success" | "error"; text: string }>();
  const [savingProfile, setSavingProfile] = useState(false);
  const [profileSaveError, setProfileSaveError] = useState<string>();
  const [form, setForm] = useState<ModelForm>({
    runtimeId: selectedRuntimeId,
    name: "",
    baseUrl: "",
    authToken: "",
    model: "",
    smallFastModel: "",
    sonnetModel: "",
    haikuModel: "",
    opusModel: ""
  });
  const [modalOpen, setModalOpen] = useState(false);
  const managingRuntime = runtimes.find((runtime) => runtime.id === managingRuntimeId);
  const managedProfiles = profiles.filter((profile) => profile.runtimeId === managingRuntimeId);
  const preservesEditingToken = Boolean(editing?.hasToken && editing.runtimeId === form.runtimeId);
  const fill = (profile?: ModelProfile) => {
    setEditing(profile);
    setForm({
      runtimeId: profile?.runtimeId ?? selectedRuntimeId,
      name: profile?.name ?? "",
      baseUrl: profile?.baseUrl ?? "",
      authToken: "",
      model: profile?.model ?? "",
      smallFastModel: profile?.runtimeId === "cfuse" ? "" : profile?.smallFastModel ?? "",
      sonnetModel: profile?.runtimeId === "cfuse" ? "" : profile?.sonnetModel ?? "",
      haikuModel: profile?.runtimeId === "cfuse" ? "" : profile?.haikuModel ?? "",
      opusModel: profile?.runtimeId === "cfuse" ? "" : profile?.opusModel ?? ""
    });
  };
  const openCreate = (runtimeId: ExecutionRuntimeId) => {
    setEditing(undefined);
    setForm({
      runtimeId,
      name: "",
      baseUrl: "",
      authToken: "",
      model: "",
      smallFastModel: "",
      sonnetModel: "",
      haikuModel: "",
      opusModel: ""
    });
    setProfileSaveError(undefined);
    setModalOpen(true);
  };
  const openEdit = (profile: ModelProfile) => {
    fill(profile);
    setProfileSaveError(undefined);
    setModalOpen(true);
  };
  const closeModal = () => {
    if (savingProfile) return;
    setModalOpen(false);
    setProfileSaveError(undefined);
    fill();
  };
  const handleActivate = async (id: string) => {
    setActivatingId(id);
    try {
      await onActivate(id);
      const runtimeId = profiles.find((profile) => profile.id === id)?.runtimeId;
      if (runtimeId) setRuntimeModelInfo((current) => ({ ...current, [runtimeId]: undefined }));
    } finally {
      setActivatingId(undefined);
    }
  };
  const loadRuntimeModelCatalog = async (runtime: ExecutionRuntimeStatus, refresh = false) => {
    setManagingRuntimeId(runtime.id);
    setLoadingModelInfo(runtime.id);
    setModelFeedback(undefined);
    try {
      const info = await requestJson<RuntimeModelCatalog>(
        `/api/execution-runtimes/${runtime.id}/models${refresh ? "?refresh=true" : ""}`
      );
      setRuntimeModelInfo((current) => ({ ...current, [runtime.id]: info }));
    } catch (cause) {
      setRuntimeModelInfo((current) => ({
        ...current, [runtime.id]: {
          runtimeId: runtime.id,
          currentModel: runtime.currentModel,
          defaultModel: runtime.currentModel,
          selectionMode: runtime.modelSource === "profile" ? "profile" : "runtime-default",
          source: "fallback",
          models: runtime.currentModel
            ? [{ id: runtime.currentModel, label: runtime.currentModel, source: "fallback" }]
            : [],
          refreshable: true,
          warning: cause instanceof Error ? cause.message : String(cause)
        }
      }));
    } finally {
      setLoadingModelInfo(undefined);
    }
  };
  const openModelManager = async (runtime: ExecutionRuntimeStatus) => {
    await loadRuntimeModelCatalog(runtime);
  };
  const handleCatalogModelSelect = async (runtime: ExecutionRuntimeStatus, value: string) => {
    if (value === "__profile__") return;
    setSelectingModel(true);
    setModelFeedback(undefined);
    try {
      const catalog = await onSelectCatalogModel(runtime.id, value || undefined);
      setRuntimeModelInfo((current) => ({ ...current, [runtime.id]: catalog }));
      setModelFeedback({
        kind: "success",
        text: value ? `已选择 ${value}，新任务将使用该模型。` : "已恢复跟随底座默认模型。"
      });
    } catch (cause) {
      setModelFeedback({ kind: "error", text: cause instanceof Error ? cause.message : String(cause) });
    } finally {
      setSelectingModel(false);
    }
  };
  const handleRuntimeSwitch = async (runtime: ExecutionRuntimeStatus) => {
    setSwitchingRuntimeId(runtime.id);
    setSwitchFeedback(undefined);
    const startedAt = Date.now();
    try {
      await onSelectRuntime(runtime.id);
      await new Promise((resolve) => setTimeout(resolve, Math.max(0, 450 - (Date.now() - startedAt))));
      setSwitchFeedback({ kind: "success", text: `已切换到 ${runtime.name}，新建会话将使用该执行底座。` });
      window.setTimeout(() => setSwitchFeedback(undefined), 1800);
    } catch (cause) {
      setSwitchFeedback({ kind: "error", text: cause instanceof Error ? cause.message : String(cause) });
    } finally {
      setSwitchingRuntimeId(undefined);
    }
  };
  return (
    <main className="config-area">
      <header className="chat-header">
        <div>
          <h1>模型与执行底座</h1>
          <p>新会话固定使用当前执行底座；新安装默认 AiWork CLI，其他底座可按环境切换。</p>
        </div>
        <div className="header-actions">
          <RefreshIconButton title="刷新执行底座" onRefresh={onRefresh} />
        </div>
      </header>
      <section className="config-content">
        <div className="config-list full">
          <div className="panel-title">
            <Terminal size={15} />
            执行底座
            <span className="muted">选择后仅影响新建会话</span>
          </div>
          {switchingRuntimeId && (
            <div className="runtime-switch-feedback loading" role="status">
              <Loader2 size={15} className="spin" />正在切换执行底座并校验配置…
            </div>
          )}
          {switchFeedback && (
            <div className={`runtime-switch-feedback ${switchFeedback.kind}`} role="status">
              {switchFeedback.kind === "success" ? <Check size={15} /> : <AlertTriangle size={15} />}{switchFeedback.text}
            </div>
          )}
          {!runtimes.length && <div className="runtime-switch-feedback loading"><Loader2 size={15} className="spin" />正在检测本机执行底座…</div>}
          {runtimes.map((runtime) => (
            <div key={runtime.id} className={`config-item runtime-item ${runtime.selected ? "runtime-selected" : ""}`}>
              <div className="config-item-main">
                <strong>
                  {runtime.name}
                  {runtime.default && <span className="badge badge-default">默认</span>}
                  {runtime.selected && <span className="badge badge-active">当前底座</span>}
                  <span className={`badge runtime-status ${runtime.status}`}>{runtime.status === "ready" ? "可用" : runtime.status === "missing" ? "未安装" : runtime.status === "disabled" ? "已禁用" : "异常"}</span>
                  {runtime.compatibility === "compatible" && <span className="badge runtime-compatibility compatible">兼容模式</span>}
                  {runtime.compatibility === "unknown" && <span className="badge runtime-compatibility unknown">能力待确认</span>}
                </strong>
                <em>{runtime.description}</em>
                <div className="runtime-capabilities" aria-label={`${runtime.name} 能力`}>
                  {runtime.capabilities.stream && <span className="badge badge-default">流式输出</span>}
                  {runtime.capabilities.resume && <span className="badge badge-default">多轮续接</span>}
                  {runtime.capabilities.modelOverride && <span className="badge badge-default">模型覆盖</span>}
                  <span className={`badge ${runtime.capabilities.sdkHooks ? "badge-active" : "badge-muted"}`}>
                    {runtime.capabilities.sdkHooks ? "运行时 Hook" : "无 SDK Hook"}
                  </span>
                  <span className={`badge ${runtime.capabilities.cliToolPolicy ? "badge-active" : "badge-muted"}`}>
                    {runtime.capabilities.cliToolPolicy ? "CLI 工具策略" : "工作区工具策略"}
                  </span>
                </div>
                <span className="muted">{runtime.version || runtime.detail}{runtime.executable ? ` · ${runtime.executable}` : ""}</span>
                <span className="runtime-model-summary">
                  当前模型：<strong>{runtime.currentModel || runtime.modelProfile?.model || "由 CLI / 底座决定"}</strong>
                </span>
                {Boolean(runtime.warnings?.length) && (
                  <details className="runtime-warning-list">
                    <summary><AlertTriangle size={13} />检测到 {runtime.warnings!.length} 项兼容性限制</summary>
                    <div role="note">
                      {runtime.warnings!.map((warning) => <span key={warning}>{warning}</span>)}
                    </div>
                  </details>
                )}
              </div>
              <div className="config-item-actions">
                <button className="ghost-button" disabled={runtime.status === "disabled"} title={runtime.status === "disabled" ? runtime.detail : "管理模型"} onClick={() => void openModelManager(runtime)}>
                  <Settings size={14} />模型管理
                </button>
                {!runtime.selected && (
                  <button
                    className="ghost-button"
                    disabled={runtime.status !== "ready" || Boolean(switchingRuntimeId)}
                    title={runtime.status === "ready" ? `切换到 ${runtime.name}` : runtime.detail}
                    onClick={() => void handleRuntimeSwitch(runtime)}
                  >
                    {switchingRuntimeId === runtime.id ? <Loader2 size={14} className="spin" /> : null}
                    {switchingRuntimeId === runtime.id ? "切换中…" : "设为执行底座"}
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
        <Modal
          open={Boolean(managingRuntime)}
          title={
            <div className="modal-title-inner">
              <Settings size={18} />
              {managingRuntime?.name ?? "执行底座"}模型管理
            </div>
          }
          onClose={() => setManagingRuntimeId(undefined)}
          footer={
            managingRuntime ? (
              <div className="header-actions">
                <button className="primary-button" onClick={() => openCreate(managingRuntime.id)}>
                  <Plus size={14} />新增自定义路由
                </button>
              </div>
            ) : null
          }
        >
          {managingRuntime ? (
            <div className="runtime-model-manager">
              <div className="runtime-current-model">
                <div className="runtime-model-picker-header">
                  <span>底座可选模型</span>
                  <RefreshIconButton
                    title="刷新模型目录"
                    size={14}
                    disabled={loadingModelInfo === managingRuntime.id || selectingModel}
                    onRefresh={() => loadRuntimeModelCatalog(managingRuntime, true)}
                  />
                </div>
                <select
                  aria-label={`${managingRuntime.name} 模型`}
                  disabled={loadingModelInfo === managingRuntime.id || selectingModel}
                  value={runtimeModelInfo[managingRuntime.id]?.selectionMode === "profile"
                    ? "__profile__"
                    : runtimeModelInfo[managingRuntime.id]?.selectedModel || ""}
                  onChange={(event) => void handleCatalogModelSelect(managingRuntime, event.target.value)}
                >
                  {runtimeModelInfo[managingRuntime.id]?.selectionMode === "profile" && (
                    <option value="__profile__">
                      当前模型档案：{runtimeModelInfo[managingRuntime.id]?.currentModel || "自定义配置"}
                    </option>
                  )}
                  <option value="">
                    跟随底座默认{runtimeModelInfo[managingRuntime.id]?.defaultModel
                      ? `（${runtimeModelInfo[managingRuntime.id]?.defaultModel}）`
                      : ""}
                  </option>
                  {(runtimeModelInfo[managingRuntime.id]?.models ?? []).map((model) => (
                    <option key={model.id} value={model.id} title={model.description}>
                      {model.label}{model.provider ? ` · ${model.provider}` : ""}{model.label !== model.id ? `（${model.id}）` : ""}
                    </option>
                  ))}
                </select>
                <strong>
                  {loadingModelInfo === managingRuntime.id
                    ? <><Loader2 size={14} className="spin" />正在读取模型目录…</>
                    : `当前生效：${runtimeModelInfo[managingRuntime.id]?.currentModel || managingRuntime.currentModel || managingRuntime.modelProfile?.model || "由底座决定"}`}
                </strong>
                <em>
                  {runtimeModelInfo[managingRuntime.id]?.source === "runtime-api"
                    ? "模型目录来自当前底座；选择只影响新任务"
                    : runtimeModelInfo[managingRuntime.id]?.source === "local-cache"
                      ? "模型目录来自本地缓存；选择只影响新任务"
                      : "默认不覆盖用户的底座配置"}
                </em>
                {runtimeModelInfo[managingRuntime.id]?.warning && (
                  <span className="runtime-model-warning">
                    <AlertTriangle size={13} />{runtimeModelInfo[managingRuntime.id]?.warning}
                  </span>
                )}
                {modelFeedback && (
                  <span className={`runtime-model-feedback ${modelFeedback.kind}`} role="status">
                    {modelFeedback.kind === "success" ? <Check size={13} /> : <AlertTriangle size={13} />}
                    {modelFeedback.text}
                  </span>
                )}
              </div>
              {managedProfiles.length ? managedProfiles.map((profile) => (
                <div className={`runtime-model-option ${profile.isActive ? "active" : ""}`} key={profile.id}>
                  <div>
                    <strong>{profile.name}{profile.isActive && <span className="badge badge-active">当前模型</span>}</strong>
                    <span>
                      {profile.model || "CLI 默认模型"} · {profile.baseUrl || `${managingRuntime.name} 本地配置`}
                      {profile.hasToken ? ` · ${profile.tokenMasked}` : ""}
                    </span>
                  </div>
                  <div className="config-item-actions">
                    {!profile.isActive && <button className="ghost-button" disabled={activatingId === profile.id} onClick={() => void handleActivate(profile.id)}>{activatingId === profile.id ? <Loader2 size={14} className="spin" /> : <Check size={14} />}使用</button>}
                    {!profile.isDefault && <button className="icon-button" title="编辑自定义路由" onClick={() => openEdit(profile)}><Pencil size={14} /></button>}
                    {!profile.isDefault && <button className="icon-button danger-icon" title="删除自定义路由" onClick={() => void onDelete(profile.id)}><Trash2 size={14} /></button>}
                  </div>
                </div>
              )) : <div className="empty-state"><Bot size={24} /><span>暂无自定义路由，当前由底座管理认证和模型。</span></div>}
            </div>
          ) : null}
        </Modal>
      </section>

      <Modal
        open={modalOpen}
        title={
          <div className="modal-title-inner">
            {editing ? <Pencil size={18} /> : <Plus size={18} />}
            {editing ? "编辑自定义路由" : "新增自定义路由"}
          </div>
        }
        onClose={closeModal}
      >
        <form
          className="config-form modal-form"
          onSubmit={async (event) => {
            event.preventDefault();
            setSavingProfile(true);
            setProfileSaveError(undefined);
            try {
              await onSave({ ...form, id: editing?.id });
              setModalOpen(false);
              fill();
              setModelFeedback({ kind: "success", text: `${form.name} 联通测试通过并已保存。` });
            } catch (cause) {
              setProfileSaveError(cause instanceof Error ? cause.message : String(cause));
            } finally {
              setSavingProfile(false);
            }
          }}
        >
          <label>
            执行底座
            <select
              value={form.runtimeId}
              disabled
            >
              {runtimes.map((runtime) => (
                <option key={runtime.id} value={runtime.id}>{runtime.name}</option>
              ))}
            </select>
          </label>
          <label>
            名称
            <input
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              placeholder="例如：MiniMax 2.5"
              required
            />
          </label>
          <label>
            API Base URL
            <input
              value={form.baseUrl}
              onChange={(e) => setForm({ ...form, baseUrl: e.target.value })}
              placeholder={form.runtimeId === "codex" ? "https://api.example.com/v1" : "https://api.example.com/anthropic"}
              required={form.runtimeId === "claude-code" || Boolean(form.authToken)}
            />
          </label>
          <label>
            API Token{editing ? "（留空则保持不变）" : ""}
            <input
              type="password"
              value={form.authToken}
              onChange={(e) => setForm({ ...form, authToken: e.target.value })}
              placeholder={preservesEditingToken ? "已保存，留空保持不变" : "sk-..."}
              required={(form.runtimeId === "claude-code" || Boolean(form.baseUrl)) && !preservesEditingToken}
            />
          </label>
          <label>
            主模型
            <input
              value={form.model}
              onChange={(e) => setForm({ ...form, model: e.target.value })}
              placeholder={
                form.runtimeId === "cfuse"
                  ? "例如 antchat/MiniMax-M2.5"
                  : form.runtimeId === "dtcoder"
                    ? "例如 maas/claude-opus-4-8"
                    : "MiniMax-M2.5"
              }
              required={form.runtimeId === "claude-code" || form.runtimeId === "cfuse" || Boolean(form.baseUrl || form.authToken)}
            />
          </label>
          {form.runtimeId === "cfuse" && (
            <div className="model-profile-protocol-hint">
              填写 Base URL、Token 和模型可建立独立的 Anthropic 兼容路由，并覆盖 CFuse
              本地供应商配置；三项留空时继续使用 CFuse 本地路由，本地模型需填写完整 ID，
              例如 <code>antchat/MiniMax-M2.5</code>。
            </div>
          )}
          {form.runtimeId === "dtcoder" && (
            <div className="model-profile-protocol-hint">
              AiWork CLI 使用 provider/model 锁定供应商，例如 <code>maas/claude-opus-4-8</code>；
              联通测试会自动向目标服务发送裸模型名。
            </div>
          )}
          {form.runtimeId === "claude-code" && (
            <>
              <label>
                Small Fast 模型（留空则同主模型）
                <input value={form.smallFastModel} onChange={(e) => setForm({ ...form, smallFastModel: e.target.value })} placeholder="MiniMax-M2.5" />
              </label>
              <label>
                Sonnet 模型（留空则同主模型）
                <input value={form.sonnetModel} onChange={(e) => setForm({ ...form, sonnetModel: e.target.value })} placeholder="MiniMax-M2.5" />
              </label>
              <label>
                Haiku 模型（留空则同主模型）
                <input value={form.haikuModel} onChange={(e) => setForm({ ...form, haikuModel: e.target.value })} placeholder="MiniMax-M2.5" />
              </label>
              <label>
                Opus 模型（留空则同主模型）
                <input value={form.opusModel} onChange={(e) => setForm({ ...form, opusModel: e.target.value })} placeholder="MiniMax-M2.7" />
              </label>
            </>
          )}
          {profileSaveError && (
            <div className="model-profile-save-error" role="alert">
              <AlertTriangle size={14} />{profileSaveError}
            </div>
          )}
          <div className="modal-form-actions">
            <button className="primary-button" type="submit" disabled={savingProfile}>
              {savingProfile
                ? <><Loader2 size={14} className="spin" />正在测试连接…</>
                : editing ? "测试并保存" : "测试并新增"}
            </button>
            <button className="ghost-button" type="button" disabled={savingProfile} onClick={closeModal}>
              取消
            </button>
          </div>
        </form>
      </Modal>
    </main>
  );
}

function ProcessLogs({ logs }: { logs: string[] }) {
  return (
    <section className="process-logs">
      <div className="process-logs-title">
        <Terminal size={14} />
        browser-use 过程日志
      </div>
      <pre>{logs.slice(-80).join("\n")}</pre>
    </section>
  );
}

function MessageBubble({ message }: { message: ChatMessage }) {
  const tools = (message.meta?.tools as string[] | undefined) ?? [];
  const isUser = message.role === "user";
  return (
    <article className={`message ${isUser ? "user" : "assistant"}`}>
      <div className="avatar">{isUser ? <User size={17} /> : <Bot size={17} />}</div>
      <div className="bubble">
        <div className="message-meta">{formatTime(message.createdAt)}</div>
        {message.content ? (
          <pre>{message.content}</pre>
        ) : (
          <span className="muted">等待流式输出</span>
        )}
        {message.files?.length ? (
          <div className="attached-files">
            {message.files.map((file) => (
              <span key={file.id}>
                <Paperclip size={12} />
                {file.originalName}
              </span>
            ))}
          </div>
        ) : null}
        {tools.length ? (
          <div className="tool-events">
            <Terminal size={13} />
            {tools.join(" / ")}
          </div>
        ) : null}
      </div>
    </article>
  );
}

/* ─── 桌面客户端：依赖环境页 ─── */
function DepsCenter({ onAlertChange }: { onAlertChange: (alert: boolean) => void }) {
  const [deps, setDeps] = useState<DepCheckResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [repairingId, setRepairingId] = useState<string>();
  const [repairLogs, setRepairLogs] = useState<string[]>([]);
  const [repairError, setRepairError] = useState<string>();
  const [copiedCmd, setCopiedCmd] = useState<string>();
  const logsRef = useRef<HTMLPreElement>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const data = await requestJson<{ desktop: boolean; deps: DepCheckResult[] }>("/api/deps");
      setDeps(data.deps);
      onAlertChange(data.deps.some((dep) => dep.required && dep.status !== "ok"));
    } catch (error) {
      setRepairError(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  }, [onAlertChange]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    logsRef.current?.scrollTo({ top: logsRef.current.scrollHeight });
  }, [repairLogs.length]);

  const repair = async (dep: DepCheckResult) => {
    if (repairingId) return;
    setRepairingId(dep.id);
    setRepairLogs([]);
    setRepairError(undefined);
    try {
      const response = await fetch(`${API}/api/deps/${encodeURIComponent(dep.id)}/repair`, { method: "POST" });
      if (!response.ok || !response.body) {
        throw new Error(await response.text());
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let failed = false;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const chunks = buffer.split("\n\n");
        buffer = chunks.pop() ?? "";
        for (const chunk of chunks) {
          let event = "message";
          let data = "";
          for (const line of chunk.split("\n")) {
            if (line.startsWith("event:")) event = line.slice(6).trim();
            if (line.startsWith("data:")) data = line.slice(5).trim();
          }
          if (!data) continue;
          try {
            const payload = JSON.parse(data) as { label?: string; command?: string; line?: string; message?: string };
            if (event === "step") {
              setRepairLogs((prev) => [...prev, `▶ ${payload.label}`, `$ ${payload.command}`]);
            } else if (event === "log") {
              setRepairLogs((prev) => [...prev, payload.line ?? ""]);
            } else if (event === "error") {
              failed = true;
              setRepairError(payload.message);
            } else if (event === "done") {
              setRepairLogs((prev) => [...prev, "✔ 修复完成"]);
            }
          } catch {
            // 忽略无法解析的 SSE 块
          }
        }
      }
      if (!failed) {
        await refresh();
      }
    } catch (error) {
      setRepairError(error instanceof Error ? error.message : String(error));
    } finally {
      setRepairingId(undefined);
    }
  };

  const copyCommand = async (dep: DepCheckResult) => {
    if (!dep.manualCommand) return;
    try {
      await navigator.clipboard.writeText(dep.manualCommand);
      setCopiedCmd(dep.id);
      setTimeout(() => setCopiedCmd((c) => (c === dep.id ? undefined : c)), 1500);
    } catch {
      // clipboard 不可用时忽略
    }
  };

  const statusBadge = (dep: DepCheckResult) => {
    if (dep.status === "ok") return <span className="badge badge-active">正常</span>;
    if (dep.status === "broken") return <span className="badge badge-broken">异常</span>;
    return <span className="badge badge-missing">{dep.required ? "缺失" : "未安装（可选）"}</span>;
  };

  return (
    <main className="config-area">
      <header className="chat-header">
        <div>
          <h1>依赖环境</h1>
          <p>agent 执行链依赖本机环境：检测状态、一键修复或按手动指引安装。</p>
        </div>
        <div className="header-actions">
          <button className="ghost-button" disabled={loading || Boolean(repairingId)} onClick={() => void refresh()}>
            <RefreshCw size={14} />
            重新检测
          </button>
        </div>
      </header>
      <section className="config-content">
        <div className="config-list full">
          <div className="panel-title">
            <Wrench size={15} />
            依赖项
            <span className="muted">共 {deps.length} 项</span>
          </div>
          {deps.length ? (
            deps.map((dep) => (
              <div key={dep.id} className="config-item">
                <div className="config-item-main">
                  <strong>
                    {dep.name}
                    {statusBadge(dep)}
                    {!dep.required && <span className="badge">可选</span>}
                  </strong>
                  <em>
                    {dep.version ? `${dep.version} · ` : ""}
                    {dep.detail}
                  </em>
                  {dep.status !== "ok" && dep.manualCommand && (
                    <code className="manual-command">{dep.manualCommand}</code>
                  )}
                </div>
                <div className="config-item-actions">
                  {dep.status !== "ok" && dep.fixable && (
                    <button
                      className="primary-button"
                      disabled={Boolean(repairingId)}
                      onClick={() => void repair(dep)}
                    >
                      {repairingId === dep.id ? <Loader2 size={14} className="spin" /> : <Wrench size={14} />}
                      {repairingId === dep.id ? "修复中…" : "一键修复"}
                    </button>
                  )}
                  {dep.status !== "ok" && dep.manualCommand && (
                    <button className="ghost-button" onClick={() => void copyCommand(dep)}>
                      {copiedCmd === dep.id ? <Check size={14} /> : <Terminal size={14} />}
                      复制命令
                    </button>
                  )}
                </div>
              </div>
            ))
          ) : (
            <p className="muted">{loading ? "检测中…" : "暂无检测结果"}</p>
          )}
          {repairError && <div className="banner banner-error">{repairError}</div>}
          {(repairingId || repairLogs.length > 0) && (
            <pre className="repair-logs" ref={logsRef}>
              {repairLogs.join("\n")}
            </pre>
          )}
        </div>
      </section>
    </main>
  );
}

/* ─── 桌面客户端：Skill 配置页 ─── */

/** 单条 env 草稿：编辑态、原始值（用于变更 diff）与可选描述。 */
interface SkillEnvDraft {
  key: string;
  value: string;
  source: "base" | "user";
  sensitive: boolean;
  maskedValue?: string;
  description?: string;
  /** 原始 value（refresh 时快照），用于保存前变更预览 */
  originalValue: string;
  /** 本条是否开启编辑 */
  editing: boolean;
  /** value 是否被用户修改过 */
  dirty: boolean;
  /** 本次会话新增的条目 */
  isNew?: boolean;
}

/** 保存前变更预览条目。 */
interface SkillEnvChange {
  key: string;
  kind: "added" | "modified" | "removed";
  before?: string;
  after?: string;
  sensitive: boolean;
}

function maskForDisplay(value: string, sensitive: boolean, masked?: string): string {
  if (!sensitive) return value;
  return masked || (value ? "******" : "（未设置）");
}

interface EmbeddedBrowserPaneProps {
  width: number;
  expanded: boolean;
  sessionRunning: boolean;
  sessionId: string;
  screenshots: ScreenshotFrame[];
  artifacts: ArtifactInfo[];
  activeObserving: boolean;
  selectedScreenshotIndex: number;
  autoFollowScreenshots: boolean;
  onWidthChange: (width: number) => void;
  onExpandedChange: (expanded: boolean) => void;
  onSelectedScreenshotChange: (index: number) => void;
  onAutoFollowChange: (enabled: boolean) => void;
  onOpenScreenshotViewer: (playing: boolean) => void;
  onPreviewArtifact: (artifact: ArtifactInfo) => void;
  onDiagnose: () => Promise<void>;
  onStop: () => Promise<void>;
}

function EmbeddedBrowserPane({
  width,
  expanded,
  sessionRunning,
  sessionId,
  screenshots,
  artifacts,
  activeObserving,
  selectedScreenshotIndex,
  autoFollowScreenshots,
  onWidthChange,
  onExpandedChange,
  onSelectedScreenshotChange,
  onAutoFollowChange,
  onOpenScreenshotViewer,
  onPreviewArtifact,
  onDiagnose,
  onStop
}: EmbeddedBrowserPaneProps) {
  const api = window.uiwardenDesktop?.embeddedBrowser;
  const slotRef = useRef<HTMLDivElement>(null);
  const tabsRef = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<EmbeddedBrowserState>();
  const [address, setAddress] = useState("about:blank");
  const [browserError, setBrowserError] = useState<string>();
  const [findVisible, setFindVisible] = useState(false);
  const [findQuery, setFindQuery] = useState("");
  const [libraryMode, setLibraryMode] = useState<"tabs" | "bookmarks" | "history" | null>(null);
  const [paneMode, setPaneMode] = useState<"browser" | "observation" | "artifacts">("browser");
  const [artifactCategory, setArtifactCategory] = useState<ArtifactCategory>("全部");
  const [diagnosing, setDiagnosing] = useState(false);
  const [stoppingTask, setStoppingTask] = useState(false);

  useEffect(() => {
    if (!api) return;
    let disposed = false;
    const applyState = (next: EmbeddedBrowserState) => {
      if (disposed) return;
      setState(next);
      const activeTab = next.tabs.find((tab) => tab.id === next.activeTabId);
      if (activeTab) setAddress(activeTab.url);
    };
    void api.getState().then(applyState).catch((cause) => setBrowserError(String(cause)));
    const unsubscribe = api.onStateChanged(applyState);
    return () => {
      disposed = true;
      unsubscribe();
    };
  }, [api]);

  useEffect(() => {
    const active = tabsRef.current?.querySelector<HTMLElement>(`[data-tab-id="${state?.activeTabId || ""}"]`);
    active?.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "smooth" });
  }, [state?.activeTabId]);

  useEffect(() => {
    if (!api || !slotRef.current) return;
    if (paneMode !== "browser") {
      void api.setVisible(false);
      return;
    }
    const slot = slotRef.current;
    const syncBounds = () => {
      const rect = slot.getBoundingClientRect();
      if (rect.width < 1 || rect.height < 1) return;
      void api.setBounds({ x: rect.x, y: rect.y, width: rect.width, height: rect.height })
        .then(() => api.setVisible(true))
        .catch((cause) => setBrowserError(String(cause)));
    };
    const observer = new ResizeObserver(syncBounds);
    observer.observe(slot);
    window.addEventListener("resize", syncBounds);
    syncBounds();
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", syncBounds);
      void api.setVisible(false);
    };
  }, [api, expanded, paneMode, width]);

  const beginResize = (event: React.PointerEvent<HTMLDivElement>) => {
    if (expanded) return;
    const parent = event.currentTarget.parentElement;
    if (!parent) return;
    const startX = event.clientX;
    const startWidth = width;
    const parentWidth = parent.getBoundingClientRect().width;
    const handleMove = (moveEvent: PointerEvent) => {
      const deltaPercent = ((startX - moveEvent.clientX) / parentWidth) * 100;
      onWidthChange(Math.min(72, Math.max(42, startWidth + deltaPercent)));
    };
    const stop = () => {
      window.removeEventListener("pointermove", handleMove);
      window.removeEventListener("pointerup", stop);
    };
    window.addEventListener("pointermove", handleMove);
    window.addEventListener("pointerup", stop, { once: true });
  };

  const invoke = async (operation: () => Promise<EmbeddedBrowserState>) => {
    setBrowserError(undefined);
    try {
      setState(await operation());
    } catch (cause) {
      setBrowserError(cause instanceof Error ? cause.message : String(cause));
    }
  };
  const activeTab = state?.tabs.find((tab) => tab.id === state.activeTabId);
  const humanControl = state?.controlMode === "human-control";
  const browserArtifacts = downloadableArtifacts(artifacts);
  const artifactCategories = availableArtifactCategories(browserArtifacts);
  const effectiveArtifactCategory = artifactCategories.includes(artifactCategory) ? artifactCategory : "全部";
  const visibleBrowserArtifacts = effectiveArtifactCategory === "全部"
    ? browserArtifacts
    : browserArtifacts.filter((artifact) => artifactMatchesCategory(artifact, effectiveArtifactCategory));

  return (
    <>
      <div className="browser-splitter" role="separator" aria-orientation="vertical" onPointerDown={beginResize} />
      <section className={`embedded-browser-pane ${paneMode !== "browser" ? "embedded-pane-alt" : ""}`} style={{ flexBasis: expanded ? "100%" : `${width}%` }}>
        <div className="embedded-workspace-tabs" role="tablist" aria-label="内置浏览器工作区">
          <button type="button" className={paneMode === "browser" ? "active" : ""} onClick={() => setPaneMode("browser")}><Chrome size={13} />浏览器</button>
          <button type="button" className={paneMode === "observation" ? "active" : ""} onClick={() => setPaneMode("observation")}><Image size={13} />执行观察{screenshots.length ? <span>{screenshots.length}</span> : null}</button>
          <button type="button" className={paneMode === "artifacts" ? "active" : ""} onClick={() => setPaneMode("artifacts")}><Download size={13} />产物与诊断{browserArtifacts.length ? <span>{browserArtifacts.length}</span> : null}</button>
          <div className="embedded-workspace-actions">
            {state?.activeRunId && (
              <button
                type="button"
                className={humanControl ? "resume" : "pause"}
                title={humanControl ? "继续 Agent，并使用当前选择的标签页" : "暂停 Agent，允许人工操作或切换目标标签页"}
                onClick={() => api && void invoke(() => api.setControlMode(humanControl ? "agent-control" : "human-control"))}
              >{humanControl ? <Play size={13} /> : <Pause size={13} />}{humanControl ? "继续" : "暂停"}</button>
            )}
            {state?.activeRunId && (
              <button type="button" className="stop" disabled={stoppingTask} title="主动结束当前任务并封装已有产物" onClick={() => {
                setStoppingTask(true);
                void onStop().finally(() => setStoppingTask(false));
              }}>{stoppingTask ? <Loader2 size={13} className="spin" /> : <X size={13} />}停止</button>
            )}
          </div>
        </div>
        <div className="embedded-tab-strip">
          <div className="embedded-tabs-scroll" ref={tabsRef} onWheel={(event) => {
            if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
            event.preventDefault();
            event.currentTarget.scrollLeft += event.deltaY;
          }}>
            {(state?.tabs ?? []).map((tab) => (
              <button
                key={tab.id}
                data-tab-id={tab.id}
                type="button"
                className={`${tab.id === state?.activeTabId ? "active" : ""}${tab.targetId === state?.controlledTargetId ? " controlled" : ""}`}
                title={`${tab.url}${tab.targetId === state?.controlledTargetId ? "（当前任务受控标签页）" : ""}`}
                onClick={() => api && void invoke(() => api.activateTab(tab.id))}
              >
                {tab.loading ? <Loader2 size={12} className="spin" /> : <Chrome size={12} />}
                <span>{tab.crashed ? "页面已崩溃" : tab.title || "新标签页"}</span>
                <X
                  size={12}
                  onClick={(event) => {
                    event.stopPropagation();
                    if (api) void invoke(() => api.closeTab(tab.id));
                  }}
                />
              </button>
            ))}
          </div>
          <button className="embedded-all-tabs" type="button" title={`查看所有标签页（${state?.tabs.length || 0}）`} onClick={() => setLibraryMode("tabs")}>
            <List size={14} />
          </button>
          <button className="embedded-new-tab" type="button" title="新建标签页" onClick={() => api && void invoke(() => api.createTab())}>
            <Plus size={14} />
          </button>
        </div>
        <div className="embedded-browser-toolbar">
          <button type="button" title="后退" disabled={!activeTab?.canGoBack} onClick={() => api && void invoke(() => api.command("back"))}><ChevronLeft size={16} /></button>
          <button type="button" title="前进" disabled={!activeTab?.canGoForward} onClick={() => api && void invoke(() => api.command("forward"))}><ChevronRight size={16} /></button>
          <button type="button" title="刷新" onClick={() => api && void invoke(() => api.command("reload"))}><RefreshCw size={14} /></button>
          <input
            value={address}
            aria-label="内置浏览器地址"
            onChange={(event) => setAddress(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && api) void invoke(() => api.navigate(address));
            }}
          />
          <button type="button" title={state?.activeBookmarked ? "移除书签" : "添加书签"} onClick={() => api && void invoke(() => api.toggleBookmark())}>
            <Star size={14} fill={state?.activeBookmarked ? "currentColor" : "none"} />
          </button>
          <button
            type="button"
            title="书签与历史记录"
            onClick={() => setLibraryMode((mode) => mode ? null : "bookmarks")}
          ><History size={14} /></button>
          {findVisible && (
            <input
              className="embedded-find-input"
              value={findQuery}
              autoFocus
              aria-label="页内查找"
              placeholder="页内查找"
              onChange={(event) => setFindQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && api) void invoke(() => api.find(findQuery, !event.shiftKey));
                if (event.key === "Escape" && api) {
                  setFindVisible(false);
                  void invoke(() => api.stopFind());
                }
              }}
            />
          )}
          <button
            type="button"
            title={findVisible ? "关闭页内查找" : "页内查找"}
            onClick={() => {
              setFindVisible((visible) => !visible);
              if (findVisible && api) void invoke(() => api.stopFind());
            }}
          ><Search size={14} /></button>
          <button type="button" title={`打开下载目录${state?.downloads?.length ? `（${state.downloads.length}）` : ""}`} onClick={() => api && void invoke(() => api.openDownloads())}>
            <Download size={14} />
          </button>
          <div className="embedded-zoom-controls" aria-label="页面缩放">
            <button type="button" title="缩小页面" onClick={() => api && void invoke(() => api.setZoomFactor((state?.zoomFactor || 1) - 0.1))}><ZoomOut size={13} /></button>
            <button type="button" title="恢复 100%" onClick={() => api && void invoke(() => api.setZoomFactor(1))}>{Math.round((state?.zoomFactor || 1) * 100)}%</button>
            <button type="button" title="放大页面" onClick={() => api && void invoke(() => api.setZoomFactor((state?.zoomFactor || 1) + 0.1))}><ZoomIn size={13} /></button>
          </div>
          <button type="button" title="清除全部 Cookie" onClick={() => api && void invoke(() => api.clearCookies())}>
            <Cookie size={14} />
          </button>
          <button type="button" title="开发者工具：请求与控制台（F12）" onClick={() => api && void invoke(() => api.openDevTools())}>
            <Terminal size={14} />
          </button>
          {state?.activeRunId && (
            <button
              type="button"
              className={humanControl ? "control-resume" : "control-takeover"}
              title={humanControl ? "交还控制权并继续 Agent" : "当前步骤完成后暂停 Agent"}
              onClick={() => api && void invoke(() => api.setControlMode(humanControl ? "agent-control" : "human-control"))}
            >
              {humanControl ? <Play size={13} /> : <Pause size={13} />}
              {humanControl ? "继续 Agent" : "接管"}
            </button>
          )}
          <span className={`embedded-control-state ${humanControl ? "human" : sessionRunning ? "agent" : "idle"}`}>
            {humanControl ? "人工控制" : sessionRunning ? "Agent 控制" : "就绪"}
          </span>
          <button type="button" title={expanded ? "恢复分栏" : "最大化浏览器"} onClick={() => onExpandedChange(!expanded)}>
            {expanded ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
          </button>
        </div>
        {(browserError || libraryMode) && (
          <div className="embedded-browser-messages">
            {browserError && <div className="embedded-browser-error">{browserError}</div>}
            {libraryMode && (
              <section className="embedded-browser-library">
                <header>
                  <div role="tablist">
                    <button type="button" className={libraryMode === "tabs" ? "active" : ""} onClick={() => setLibraryMode("tabs")}>标签页</button>
                    <button type="button" className={libraryMode === "bookmarks" ? "active" : ""} onClick={() => setLibraryMode("bookmarks")}>书签</button>
                    <button type="button" className={libraryMode === "history" ? "active" : ""} onClick={() => setLibraryMode("history")}>历史记录</button>
                  </div>
                  {libraryMode === "history" && <button type="button" onClick={() => api && void invoke(() => api.clearHistory())}>清除历史</button>}
                  <button type="button" title="关闭" aria-label="关闭" onClick={() => setLibraryMode(null)}><X size={14} /></button>
                </header>
                <div className="embedded-browser-library-list">
                  {(state?.[libraryMode] ?? []).map((entry) => (
                    <div className="embedded-browser-library-entry" key={entry.id}>
                      <button type="button" title={entry.url} onClick={() => {
                        if (api) void invoke(() => libraryMode === "tabs" ? api.activateTab(entry.id) : api.navigate(entry.url));
                        setLibraryMode(null);
                      }}>
                        <strong>{entry.title || entry.url}</strong>
                        <span>{entry.url}</span>
                      </button>
                      {(libraryMode === "bookmarks" || libraryMode === "tabs") && (
                        <button type="button" title={libraryMode === "tabs" ? "关闭标签页" : "移除书签"} aria-label={libraryMode === "tabs" ? "关闭标签页" : "移除书签"} onClick={() => api && void invoke(() => libraryMode === "tabs" ? api.closeTab(entry.id) : api.removeBookmark(entry.id))}><X size={13} /></button>
                      )}
                    </div>
                  ))}
                  {(state?.[libraryMode] ?? []).length === 0 && <div className="embedded-browser-library-empty">暂无{libraryMode === "bookmarks" ? "书签" : libraryMode === "history" ? "历史记录" : "标签页"}</div>}
                </div>
              </section>
            )}
          </div>
        )}
        <div className="embedded-browser-slot" ref={slotRef}>
          {!activeTab && <Loader2 size={20} className="spin" />}
        </div>
        {paneMode === "observation" && (
          <section className="embedded-alt-panel embedded-observation-panel">
            <header>
              <div><Image size={15} /><strong>执行观察</strong></div>
              <span>{screenshots.length ? `${selectedScreenshotIndex + 1} / ${screenshots.length}` : activeObserving ? "等待首帧" : "暂无截图"}</span>
              {activeObserving && !autoFollowScreenshots && screenshots.length > 0 && (
                <button type="button" onClick={() => {
                  onAutoFollowChange(true);
                  onSelectedScreenshotChange(screenshots.length - 1);
                }}><RefreshCw size={13} />回到实时</button>
              )}
              {screenshots.length > 0 && <button type="button" onClick={() => onOpenScreenshotViewer(true)}><Play size={13} />播放</button>}
            </header>
            {screenshots.length > 0 ? (
              <div className="embedded-observation-content">
                <button className="embedded-observation-preview" type="button" onClick={() => onOpenScreenshotViewer(false)}>
                  <img src={screenshots[selectedScreenshotIndex]?.url} alt="当前执行页面截图" />
                </button>
                <div className="embedded-observation-timeline">
                  {screenshots.map((frame, index) => (
                    <button key={`${frame.relativePath}-${frame.modifiedAt}`} type="button" className={index === selectedScreenshotIndex ? "active" : ""} onClick={() => {
                      onSelectedScreenshotChange(index);
                      onAutoFollowChange(false);
                    }}>
                      <img src={frame.url} alt="" />
                      <span><strong>{frame.stepIndex ? `Step ${frame.stepIndex}` : `Step ${index + 1}`}</strong><em>{frame.actionSummary || frame.title || frame.pageUrl || formatTime(frame.modifiedAt)}</em></span>
                    </button>
                  ))}
                </div>
              </div>
            ) : <div className="embedded-alt-empty">{activeObserving ? "browser-use 执行后，逐步截图会实时显示在这里。" : "当前会话尚未生成执行观察截图。"}</div>}
          </section>
        )}
        {paneMode === "artifacts" && (
          <section className="embedded-alt-panel embedded-artifacts-panel">
            <header>
              <div><Download size={15} /><strong>产物与诊断</strong></div>
              <button type="button" disabled={diagnosing} onClick={() => {
                setDiagnosing(true);
                void onDiagnose().finally(() => setDiagnosing(false));
              }}>{diagnosing ? <Loader2 size={13} className="spin" /> : <Wrench size={13} />}分析问题</button>
              <a href={`/api/sessions/${sessionId}/browser-artifacts/download`}><Download size={13} />下载诊断包</a>
              {artifacts.some((artifact) => artifact.kind === "file") && <a href={`/api/sessions/${sessionId}/artifacts/download`}><Download size={13} />下载全部</a>}
            </header>
            <div className="embedded-artifact-tabs" role="tablist" aria-label="产物分类">
              {artifactCategories.map((category) => (
                <button
                  key={category}
                  type="button"
                  className={effectiveArtifactCategory === category ? "active" : ""}
                  onClick={() => setArtifactCategory(category)}
                >
                  {category}
                  <span>{category === "全部" ? browserArtifacts.length : browserArtifacts.filter((artifact) => artifactMatchesCategory(artifact, category)).length}</span>
                </button>
              ))}
            </div>
            {browserArtifacts.length ? (
              <div className="embedded-artifact-groups">
                {groupArtifacts(visibleBrowserArtifacts).map(([group, entries]) => (
                  <section key={group}>
                    <h4>{group}</h4>
                    {entries.map((artifact) => (
                      <div className={`embedded-artifact-entry${isHighlightedArtifact(artifact) ? " core-report" : ""}`} key={artifact.relativePath}>
                        <button type="button" onClick={() => onPreviewArtifact(artifact)}><FileText size={14} /><span>{artifact.relativePath}</span><em>{artifactLabel(artifact)}</em></button>
                        <a href={artifactDownloadHref(sessionId, artifact)} download title="下载"><Download size={14} /></a>
                      </div>
                    ))}
                  </section>
                ))}
              </div>
            ) : <div className="embedded-alt-empty">任务完成后可在这里下载截图、网络、控制台、Trace、操作事件和诊断报告。</div>}
          </section>
        )}
      </section>
    </>
  );
}

/* ─── 桌面客户端：CDP 直连控制面板 ─── */
function CdpControlPanel({
  sessionId,
  sessionRunning,
  onUseEmbedded,
  onUseFirefox
}: {
  sessionId: string;
  sessionRunning: boolean;
  onUseEmbedded: () => void;
  onUseFirefox: (executablePath: string) => Promise<void>;
}) {
  const [status, setStatus] = useState<CdpStatus>();
  const [discovery, setDiscovery] = useState<CdpBrowserDiscovery>();
  const [selectedBrowserId, setSelectedBrowserId] = useState("");
  const [busy, setBusy] = useState(false);
  const [panelError, setPanelError] = useState<string>();
  const [selectedTabId, setSelectedTabId] = useState<string>("");
  const [activating, setActivating] = useState(false);
  const [stoppingTask, setStoppingTask] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const [data, detected] = await Promise.all([
        requestJson<CdpStatus>("/api/cdp/status"),
        requestJson<CdpBrowserDiscovery>("/api/cdp/browsers")
      ]);
      setStatus(data);
      setDiscovery(detected);
      setSelectedBrowserId((current) => {
        if (current && detected.browsers.some((browser) => browser.id === current)) return current;
        const requested = data.selectedBrowserId;
        if (requested && detected.browsers.some((browser) => browser.id === requested)) return requested;
        return detected.defaultBrowserId ?? "";
      });
      // 同步服务端记录的 selectedTabId（多轮切换 tab 后回显）；已选 tab 被关闭时回退默认。
      const serverSelected = data.selectedTabId ?? "";
      if (serverSelected !== selectedTabId) {
        setSelectedTabId(serverSelected);
      }
      if (serverSelected && data.tabs && !data.tabs.some((t) => t.id === serverSelected)) {
        setSelectedTabId("");
      }
    } catch (error) {
      setPanelError(error instanceof Error ? error.message : String(error));
    }
  }, [selectedTabId]);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 4000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const startBrowser = async () => {
    setBusy(true);
    setPanelError(undefined);
    try {
      if (!selectedBrowserId) throw new Error("未检测到可用的 Chromium 浏览器");
      if (status?.running) {
        if (selectedBrowserId === status.selectedBrowserId) return;
        const stopped = await requestJson<{ stopped: boolean; message: string }>("/api/cdp/stop", {
          method: "POST"
        });
        if (!stopped.stopped) throw new Error(stopped.message);
      }
      const data = await requestJson<CdpStatus>("/api/cdp/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ browserId: selectedBrowserId })
      });
      setStatus(data);
      if (!data.running && data.error) {
        setPanelError(data.error);
      }
    } catch (error) {
      setPanelError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const selectBrowser = async (browserId: string) => {
    const browser = discovery?.browsers.find((candidate) => candidate.id === browserId);
    if (!browser) {
      setSelectedBrowserId(browserId);
      return;
    }
    if (browser.action === "use-embedded-kernel") {
      onUseEmbedded();
      return;
    }
    if (browser.action === "use-firefox-profile") {
      if (!browser.path) {
        setPanelError("Firefox 可执行路径不可用，请重新检测");
        return;
      }
      setBusy(true);
      setPanelError(undefined);
      try {
        await onUseFirefox(browser.path);
      } catch (error) {
        setPanelError(error instanceof Error ? error.message : String(error));
      } finally {
        setBusy(false);
      }
      return;
    }
    setSelectedBrowserId(browserId);
  };

  const stopBrowser = async () => {
    setBusy(true);
    setPanelError(undefined);
    try {
      const result = await requestJson<{ stopped: boolean; message: string }>("/api/cdp/stop", {
        method: "POST"
      });
      if (!result.stopped) {
        setPanelError(result.message);
      }
      await refresh();
    } catch (error) {
      setPanelError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const stopTask = async () => {
    setStoppingTask(true);
    setPanelError(undefined);
    try {
      const result = await requestJson<{ stopped: boolean; message: string }>(
        `/api/sessions/${encodeURIComponent(sessionId)}/stop`,
        { method: "POST" }
      );
      if (!result.stopped) {
        setPanelError(result.message);
      }
    } catch (error) {
      setPanelError(error instanceof Error ? error.message : String(error));
    } finally {
      setStoppingTask(false);
    }
  };

  // 统一通过 /api/cdp/selected-tab 设置/清除目标标签页（服务端记录 + 激活）。
  // 特殊值 "__new__" 表示新开一个空白标签页并选为目标。
  const selectTab = async (value: string) => {
    if (value === "__new__") {
      setBusy(true);
      setPanelError(undefined);
      try {
        const tab = await requestJson<{ id: string; title: string; url: string; type: string }>("/api/cdp/tabs", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({})
        });
        setSelectedTabId(tab.id);
        await requestJson("/api/cdp/selected-tab", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ targetId: tab.id })
        });
        await refresh();
      } catch (error) {
        setPanelError(error instanceof Error ? error.message : String(error));
      } finally {
        setBusy(false);
      }
      return;
    }
    setSelectedTabId(value);
    setPanelError(undefined);
    try {
      await requestJson("/api/cdp/selected-tab", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ targetId: value })
      });
    } catch (error) {
      setPanelError(error instanceof Error ? error.message : String(error));
    } finally {
      setActivating(false);
    }
  };

  const running = status?.running ?? false;
  const selectedBrowser = discovery?.browsers.find((browser) => browser.id === selectedBrowserId);
  const selectedUsesCdp = selectedBrowser?.action === "launch-cdp" || selectedBrowser?.action === "connect-cdp";
  const browserChanged = running && selectedUsesCdp && Boolean(selectedBrowserId) && selectedBrowserId !== status?.selectedBrowserId;
  return (
    <div className="cdp-panel">
      <div className="cdp-panel-row">
        <span className={`status-dot ${running ? "completed" : "failed"}`} />
        <strong>CDP 浏览器</strong>
        <span className="muted">
          {running
            ? `${status?.browserName ?? status?.browserVersion ?? "已连接"}（${status?.mode === "managed" ? "托管" : "外部"} · ${status?.cdpUrl}）`
            : "未连接——默认选择本机 Google Chrome"}
        </span>
        {status?.browserPath && (
          <span className="muted" title={status.browserPath}>
            浏览器：{status.browserPath}
          </span>
        )}
        <span style={{ marginLeft: "auto", display: "inline-flex", gap: 8 }}>
          {sessionRunning && (
            <button
              className="ghost-button"
              disabled={stoppingTask}
              title="中断当前正在执行的 CDP 任务（当前步骤后退出）"
              onClick={() => void stopTask()}
            >
              {stoppingTask ? <Loader2 size={13} className="spin" /> : <X size={13} />}
              停止任务
            </button>
          )}
          {browserChanged && (
            <button className="primary-button" disabled={busy || sessionRunning} onClick={() => void startBrowser()}>
              {busy ? <Loader2 size={13} className="spin" /> : <RefreshCw size={13} />}
              切换浏览器
            </button>
          )}
          {running ? (
            <button
              className="ghost-button"
              disabled={busy || sessionRunning}
              title={sessionRunning ? "任务执行中不能断开浏览器" : status?.mode === "external" ? "断开连接，不关闭用户浏览器" : "关闭托管的 CDP 浏览器"}
              onClick={() => void stopBrowser()}
            >
              {busy ? <Loader2 size={13} className="spin" /> : <X size={13} />}
              {status?.mode === "external" ? "断开浏览器" : "关闭浏览器"}
            </button>
          ) : !browserChanged ? (
            <button className="primary-button" disabled={busy || !selectedBrowserId} onClick={() => void startBrowser()}>
              {busy ? <Loader2 size={13} className="spin" /> : <Play size={13} />}
              {selectedBrowser?.connectable ? "连接已开启浏览器" : "启动所选浏览器"}
            </button>
          ) : null}
        </span>
      </div>
      <div className="cdp-panel-row cdp-browser-row">
        <span className="muted">浏览器</span>
        <select
          className="cdp-tab-select cdp-browser-select"
          value={selectedBrowserId}
          disabled={busy || sessionRunning}
          onChange={(event) => void selectBrowser(event.target.value)}
        >
          {!discovery?.browsers.length && <option value="">未检测到本机浏览器</option>}
          {(discovery?.browsers ?? []).map((browser) => (
            <option key={browser.id} value={browser.id}>
              {cdpBrowserOptionLabel(browser)}
            </option>
          ))}
        </select>
        {selectedBrowser && <span className="muted cdp-browser-note" title={selectedBrowser.note}>{selectedBrowser.note}</span>}
      </div>
      {running && (
        <div className="cdp-panel-row">
          <span className="muted">目标标签页</span>
          <select
            className="cdp-tab-select"
            value={selectedTabId}
            disabled={activating || busy || sessionRunning}
            onChange={(e) => void selectTab(e.target.value)}
          >
            <option value="">（默认）当前活动标签页</option>
            <option value="__new__">＋ 新开空白标签页</option>
            {(status?.tabs ?? []).map((tab) => (
              <option key={tab.id} value={tab.id}>
                {(tab.title || tab.url).slice(0, 60)}
              </option>
            ))}
          </select>
          {activating && <Loader2 size={13} className="spin" />}
          <span className="muted" title={selectedTabId ? `targetId: ${selectedTabId}` : undefined}>
            {selectedTabId
              ? `当前受控：${(status?.tabs ?? []).find((t) => t.id === selectedTabId)?.title || (status?.tabs ?? []).find((t) => t.id === selectedTabId)?.url || selectedTabId}`.slice(0, 56)
              : "选择后该标签页会被置为活动页，任务在其上执行；执行间隙可手动操作浏览器，下一轮接续当前状态。"}
          </span>
        </div>
      )}
      {panelError && <div className="banner banner-error">{panelError}</div>}
    </div>
  );
}

function ConfigCenter({
  section,
  desktop,
  depsAlert,
  onSectionChange,
  children
}: {
  section: ConfigSection;
  desktop: boolean;
  depsAlert: boolean;
  onSectionChange: (section: ConfigSection) => void;
  children: React.ReactNode;
}) {
  const sections: Array<{ id: ConfigSection; label: string; icon: React.ReactNode; desktopOnly?: boolean }> = [
    { id: "browser-skill", label: "浏览器与 Skill", icon: <KeyRound size={14} /> },
    { id: "gui-runtime", label: "GUI Runtime", icon: <Terminal size={14} /> },
    { id: "environments", label: "环境配置", icon: <Settings size={14} /> },
    { id: "hosts", label: "Host 管理", icon: <Server size={14} /> },
    { id: "models", label: "模型与执行底座", icon: <Bot size={14} /> },
    { id: "notify", label: "通知管理", icon: <Bell size={14} /> },
    { id: "deps", label: "依赖环境", icon: <Wrench size={14} />, desktopOnly: true }
  ];
  const visibleSections = sections.filter((entry) => !entry.desktopOnly || desktop);

  return (
    <section className="config-center-shell">
      <header className="config-center-header">
        <div>
          <h1>配置中心</h1>
          <p>按模块管理浏览器、GUI Runtime、环境、Host、模型与执行底座、通知和本地依赖。</p>
        </div>
      </header>
      <nav className="config-center-tabs" aria-label="配置中心模块">
        {visibleSections.map((entry) => (
          <button
            key={entry.id}
            type="button"
            className={entry.id === section ? "active" : ""}
            onClick={() => onSectionChange(entry.id)}
          >
            {entry.icon}
            {entry.label}
            {entry.id === "deps" && depsAlert && <span className="nav-dot" title="存在缺失的必需依赖" />}
          </button>
        ))}
      </nav>
      <div className="config-center-content">{children}</div>
    </section>
  );
}

interface GuiRuntimeSettingsView {
  cliCompatibilityMode: boolean;
  updatedAt?: string;
  transport: {
    activeTransport: "cli" | "mcp";
    mcp: {
      state: "starting" | "ready" | "stopped" | "failed";
      pid?: number;
      lastError?: string;
    };
  };
}

function GuiRuntimeCenter() {
  const [settings, setSettings] = useState<GuiRuntimeSettingsView>();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string }>();

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setSettings(await requestJson<GuiRuntimeSettingsView>("/api/gui-runtime-settings"));
      setMessage(undefined);
    } catch (error) {
      setMessage({ kind: "error", text: error instanceof Error ? error.message : String(error) });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const handleModeChange = async (cliCompatibilityMode: boolean) => {
    if (saving || !settings) return;
    const previous = settings;
    setSaving(true);
    setSettings({ ...settings, cliCompatibilityMode });
    setMessage(undefined);
    try {
      const updated = await requestJson<GuiRuntimeSettingsView>("/api/gui-runtime-settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cliCompatibilityMode })
      });
      setSettings(updated);
      setMessage({
        kind: "ok",
        text: cliCompatibilityMode
          ? "已切换到兼容 CLI 模式，新任务继续使用原有逐命令执行链。"
          : "持久 MCP Runtime 已就绪，新任务将复用常驻连接。"
      });
    } catch (error) {
      setSettings(previous);
      setMessage({ kind: "error", text: error instanceof Error ? error.message : String(error) });
    } finally {
      setSaving(false);
    }
  };

  const mcpReady = settings?.transport.activeTransport === "mcp"
    && settings.transport.mcp.state === "ready";

  return (
    <main className="config-area gui-runtime-center">
      <header className="chat-header">
        <div>
          <h1>GUI Runtime</h1>
          <p>统一切换电脑桌面与浏览器原子命令的传输方式；测试任务配置不受影响。</p>
        </div>
        <div className="header-actions">
          <button className="ghost-button" disabled={loading || saving} onClick={() => void refresh()}>
            <RefreshCw size={14} />
            刷新
          </button>
        </div>
      </header>
      <section className="config-content">
        <div className="config-list full">
          <div className="panel-title">
            <Terminal size={15} />
            GUI 原子执行传输
            <span className={`badge ${mcpReady ? "badge-active" : "badge-default"}`}>
              {settings?.transport.activeTransport === "mcp" ? "持久 MCP" : "兼容 CLI"}
            </span>
          </div>
          <div className="config-item gui-runtime-mode-row">
            <div className="config-item-main gui-runtime-mode-main">
              <strong>兼容 CLI 模式</strong>
              <span className="muted">
                开启时沿用当前逐命令 CLI；关闭后由本地常驻 MCP Runtime 执行，命令、审批和 Rep 协议保持兼容。
              </span>
              {!settings?.cliCompatibilityMode && settings?.transport.mcp.pid && (
                <span className="muted">MCP 进程 PID：{settings.transport.mcp.pid}</span>
              )}
              {settings?.transport.mcp.lastError && (
                <span className="gui-runtime-error">MCP：{settings.transport.mcp.lastError}</span>
              )}
            </div>
            <label className="switch-toggle gui-runtime-mode-switch">
              <input
                type="checkbox"
                checked={settings?.cliCompatibilityMode ?? true}
                disabled={loading || saving || !settings}
                onChange={(event) => void handleModeChange(event.target.checked)}
              />
              <span className="switch-track">
                <span className="switch-thumb" />
              </span>
              <em>{saving ? "切换中…" : settings?.cliCompatibilityMode === false ? "持久 MCP" : "兼容 CLI"}</em>
            </label>
          </div>
          <div className="browser-config-note">
            该设置同时作用于 dt-gui-computer 和 dt-gui-browser。关闭兼容模式后，UIWarden
            控制面和 Agent 仍使用相同原子命令；电脑桌面复用 Runtime 与 Provider，浏览器任务
            在会话内复用 MCP、CDP target、DOM 增量基线和截图序列。
          </div>
          {loading && <div className="runtime-switch-feedback loading"><Loader2 size={15} className="spin" />正在读取 GUI Runtime 状态…</div>}
          {message && (
            <div className={`runtime-switch-feedback ${message.kind === "ok" ? "success" : "error"}`}>
              {message.kind === "ok" ? <Check size={15} /> : <AlertTriangle size={15} />}
              {message.text}
            </div>
          )}
        </div>
      </section>
    </main>
  );
}

function SkillEnvCenter() {
  const [drafts, setDrafts] = useState<SkillEnvDraft[]>([]);
  const [removedKeys, setRemovedKeys] = useState<Array<{ key: string; before: string; sensitive: boolean }>>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string }>();
  const [addOpen, setAddOpen] = useState(false);
  const [addForm, setAddForm] = useState({ key: "", value: "", description: "" });
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [helpKey, setHelpKey] = useState<string>();
  // 浏览器配置（browser-use profile 切换 + 本机路径覆盖）
  const [browserProfiles, setBrowserProfiles] = useState<BrowserProfileInfo[]>([]);
  const [detectedBrowsers, setDetectedBrowsers] = useState<DetectedBrowser[]>([]);
  const [browserConfigError, setBrowserConfigError] = useState<string>();

  const refresh = useCallback(async () => {
    setLoading(true);
    setMessage(undefined);
    try {
      const data = await requestJson<{ entries: SkillEnvEntry[] }>("/api/skill-env");
      setDrafts(
        data.entries.map((entry) => ({
          ...entry,
          originalValue: entry.value,
          editing: false,
          dirty: false
        }))
      );
      setRemovedKeys([]);
      // 浏览器配置元数据（profile 枚举 + 本机探测），失败不阻塞 env 列表
      try {
        const bp = await requestJson<{
          profiles: BrowserProfileInfo[];
          detected: DetectedBrowser[];
          configurationError?: string;
        }>("/api/browser-profiles");
        setBrowserProfiles(bp.profiles);
        setDetectedBrowsers(bp.detected);
        setBrowserConfigError(bp.configurationError);
      } catch {
        // 非桌面模式或接口不可用时隐藏浏览器区块
        setBrowserProfiles([]);
        setBrowserConfigError(undefined);
      }
    } catch (error) {
      setMessage({ kind: "error", text: error instanceof Error ? error.message : String(error) });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const toggleEditing = (index: number) => {
    setDrafts((prev) =>
      prev.map((item, i) => {
        if (i !== index) return item;
        if (item.editing) {
          // 关闭编辑：还原为原始值
          return { ...item, editing: false, dirty: false, value: item.originalValue };
        }
        return { ...item, editing: true };
      })
    );
  };

  const updateValue = (index: number, value: string) => {
    setDrafts((prev) => prev.map((item, i) => (i === index ? { ...item, value, dirty: true } : item)));
  };

  const removeEntry = (index: number) => {
    setDrafts((prev) => {
      const target = prev[index];
      if (target && target.source === "user" && !target.isNew) {
        setRemovedKeys((old) =>
          old.some((r) => r.key === target.key)
            ? old
            : [...old, { key: target.key, before: target.originalValue, sensitive: target.sensitive }]
        );
      }
      return prev.filter((_, i) => i !== index);
    });
  };

  const submitAdd = () => {
    const key = addForm.key.trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      setMessage({ kind: "error", text: `非法的变量名：${key || "（空）"}（仅限字母/数字/下划线，不能以数字开头）` });
      return;
    }
    if (drafts.some((item) => item.key === key)) {
      setMessage({ kind: "error", text: `变量 ${key} 已存在，请直接编辑对应条目` });
      return;
    }
    const sensitive = /(TOKEN|KEY|PASSWORD|SECRET|CREDENTIAL)/i.test(key);
    setDrafts((prev) => [
      ...prev,
      {
        key,
        value: addForm.value,
        source: "user",
        sensitive,
        description: addForm.description.trim() || undefined,
        originalValue: "",
        editing: false,
        dirty: true,
        isNew: true
      }
    ]);
    setRemovedKeys((prev) => prev.filter((r) => r.key !== key));
    setAddForm({ key: "", value: "", description: "" });
    setAddOpen(false);
    setMessage(undefined);
  };

  // ── 浏览器配置区块：读写 drafts 中的 BU_BROWSER_TYPE / BU_*_PATH ──
  const envValue = (key: string): string => drafts.find((d) => d.key === key)?.value ?? "";
  const setEnvValue = (key: string, value: string, description?: string, sensitive = false) => {
    setDrafts((prev) => {
      const index = prev.findIndex((d) => d.key === key);
      if (index >= 0) {
        return prev.map((item, i) => (i === index ? { ...item, value, dirty: true, sensitive: item.sensitive || sensitive } : item));
      }
      return [
        ...prev,
        {
          key,
          value,
          source: "user" as const,
          sensitive,
          description,
          originalValue: "",
          editing: false,
          dirty: true,
          isNew: true
        }
      ];
    });
  };
  const selectedBrowserKey = envValue("BU_BROWSER_TYPE") || "chrome";
  const selectedProfile = browserProfiles.find((p) => p.key === selectedBrowserKey);

  const changes = useMemo<SkillEnvChange[]>(() => {
    const list: SkillEnvChange[] = [];
    for (const item of drafts) {
      if (item.isNew) {
        list.push({ key: item.key, kind: "added", after: item.value, sensitive: item.sensitive });
      } else if (item.dirty && item.value !== item.originalValue) {
        list.push({
          key: item.key,
          kind: "modified",
          before: item.originalValue,
          after: item.value,
          sensitive: item.sensitive
        });
      }
    }
    for (const removed of removedKeys) {
      list.push({ key: removed.key, kind: "removed", before: removed.before, sensitive: removed.sensitive });
    }
    return list;
  }, [drafts, removedKeys]);

  const save = async () => {
    setSaving(true);
    setMessage(undefined);
    try {
      // 整体替换语义：提交全部条目作为用户覆盖层。
      // 敏感项未修改时提交空串，服务端会保留旧值；base 项未修改则跳过（保持 base 默认）。
      const payload = drafts
        .filter((item) => item.key.trim())
        .filter((item) => item.source === "user" || item.dirty)
        .map((item) => ({
          key: item.key.trim(),
          value: item.value,
          description: item.description
        }));
      const result = await requestJson<{ ok: boolean; savedKeys: number }>("/api/skill-env", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ entries: payload })
      });
      setMessage({ kind: "ok", text: `已保存 ${result.savedKeys} 项，下次任务执行时生效` });
      setConfirmOpen(false);
      await refresh();
    } catch (error) {
      setMessage({ kind: "error", text: error instanceof Error ? error.message : String(error) });
      setConfirmOpen(false);
    } finally {
      setSaving(false);
    }
  };

  return (
    <main className="config-area">
      <header className="chat-header">
        <div>
          <h1>浏览器与 Skill</h1>
          <p>管理浏览器 Profile、本地 Skill 环境变量和独立浏览器路径。</p>
        </div>
        <div className="header-actions">
          <button className="ghost-button" disabled={loading || saving} onClick={() => void refresh()}>
            <RefreshCw size={14} />
            刷新
          </button>
          <button
            className="primary-button"
            disabled={saving || loading || changes.length === 0}
            title={changes.length === 0 ? "暂无变更" : `${changes.length} 项变更待保存`}
            onClick={() => setConfirmOpen(true)}
          >
            {saving ? <Loader2 size={14} className="spin" /> : <Check size={14} />}
            保存{changes.length > 0 ? `（${changes.length}）` : ""}
          </button>
        </div>
      </header>
      <section className="config-content">
        {browserProfiles.length > 0 && (
          <div className="config-list full browser-config-block">
            <div className="panel-title">
              <Chrome size={15} />
              browser-use 测试浏览器
              <span className="muted">仅“Skill 配置浏览器”会话、quick、巡检和回归读取此配置</span>
            </div>
            <div className="config-item">
              <div className="config-item-main">
                <label className="browser-config-row">
                  <span>浏览器 Profile</span>
                  <select
                    value={selectedBrowserKey}
                    onChange={(e) =>
                      setEnvValue(
                        "BU_BROWSER_TYPE",
                        e.target.value,
                        "browser-use 浏览器 profile（chrome=Playwright 内置内核；其余需配置可执行路径）"
                      )
                    }
                  >
                    {browserProfiles.map((profile) => (
                      <option key={profile.key} value={profile.key}>
                        {profile.displayName}
                        {profile.requiresPath ? "（需指定路径）" : ""}
                      </option>
                    ))}
                  </select>
                </label>
                {selectedProfile?.pathEnvKey && (
                  <label className="browser-config-row">
                    <span>{selectedProfile.key === "firefox" ? "本机检测路径" : "可执行文件路径"}（{selectedProfile.pathEnvKey}）</span>
                    <input
                      className="text-input"
                      placeholder={selectedProfile.defaultPath || "浏览器可执行文件绝对路径"}
                      value={envValue(selectedProfile.pathEnvKey)}
                      onChange={(e) =>
                        setEnvValue(
                          selectedProfile.pathEnvKey!,
                          e.target.value,
                          `${selectedProfile.displayName} 可执行文件路径`
                        )
                      }
                    />
                  </label>
                )}
                <label className="browser-config-row">
                  <span>UI 操作独立浏览器路径</span>
                  <input
                    className="text-input"
                    placeholder="/Applications/UIWarden-Browser.app/Contents/MacOS/UIWarden-Browser"
                    value={envValue("UIWARDEN_STANDALONE_BROWSER_PATH")}
                    onChange={(event) =>
                      setEnvValue(
                        "UIWARDEN_STANDALONE_BROWSER_PATH",
                        event.target.value,
                        "UI 操作使用的本机独立 UIWarden-Browser 路径"
                      )
                    }
                  />
                </label>
                {detectedBrowsers.length > 0 && (
                  <div className="browser-detected">
                    <span className="muted">本机检测到：</span>
                    {detectedBrowsers.map((browser) => (
                      <button
                        key={browser.path}
                        className={`ghost-button${browser.recommendedKernel === "gui-computer" ? " browser-install-status" : ""}`}
                        title={browser.compatibilityNote || `使用 ${browser.path}`}
                        disabled={!browser.profileCompatible && browser.recommendedKernel !== "gui-computer"}
                        onClick={() => {
                          if (browser.recommendedKernel === "gui-computer") {
                            setEnvValue(
                              "UIWARDEN_STANDALONE_BROWSER_PATH",
                              browser.path,
                              "UI 操作使用的本机独立 UIWarden-Browser 路径"
                            );
                            return;
                          }
                          if (browser.kind === "firefox") {
                            setEnvValue("BU_BROWSER_TYPE", "firefox", "browser-use 浏览器 profile");
                            setEnvValue("BU_FIREFOX_PATH", browser.path, `${browser.name} 可执行文件路径（本机探测）`);
                            return;
                          }
                          setEnvValue("BU_BROWSER_TYPE", "custom", "browser-use 浏览器 profile");
                          setEnvValue("BU_CUSTOM_BROWSER_PATH", browser.path, `${browser.name} 可执行文件路径（本机探测）`);
                        }}
                      >
                        {browser.name}
                        {browser.recommendedKernel === "gui-computer" ? "（UI 操作专用）" : !browser.profileCompatible ? "（仅检测）" : ""}
                      </button>
                    ))}
                    {!selectedProfile?.pathEnvKey && (
                      <span className="muted">（当前 profile 使用内置内核，无需路径）</span>
                    )}
                  </div>
                )}
                <div className="browser-config-note">
                  测试任务默认使用 Playwright 配套 Chromium；选择“Skill 配置浏览器”后才读取 browser-use Profile。360 和指定版本 Edge 使用对应 Chromium 可执行文件；Firefox 使用 Playwright 配套引擎，本机路径仅用于检测。UIWarden-Browser 路径用于独立浏览器的检测与启动，与测试任务隔离。
                </div>
                {browserConfigError && <div className="banner banner-warn">当前浏览器配置未生效：{browserConfigError}</div>}
                {detectedBrowsers.some((browser) => browser.compatibilityNote) && (
                  <div className="browser-config-note">
                    {detectedBrowsers.filter((browser) => browser.compatibilityNote).map((browser) => `${browser.name}：${browser.compatibilityNote}`).join("；")}
                  </div>
                )}
              </div>
            </div>
          </div>
        )}
        <div className="config-list full">
          <div className="panel-title">
            <KeyRound size={15} />
            环境变量
            <span className="muted">共 {drafts.length} 项</span>
            <button className="ghost-button" style={{ marginLeft: "auto" }} onClick={() => setAddOpen(true)}>
              <Plus size={14} />
              新增
            </button>
          </div>
          {message && (
            <div className={`banner ${message.kind === "ok" ? "banner-ok" : "banner-error"}`}>{message.text}</div>
          )}
          {drafts.length ? (
            drafts.map((entry, index) => (
              <div key={`${entry.key}-${index}`} className={`config-item skill-env-row${entry.editing ? " editing" : ""}`}>
                <div className="config-item-main">
                  <div className="skill-env-keyline">
                    <code className="skill-env-key">{entry.key}</code>
                    <span
                      className="skill-env-help"
                      title={entry.description || "暂无参数说明"}
                      onClick={() => setHelpKey((prev) => (prev === entry.key ? undefined : entry.key))}
                    >
                      <HelpCircle size={13} />
                    </span>
                    {entry.isNew ? (
                      <span className="badge badge-active">新增</span>
                    ) : entry.source === "user" ? (
                      <span className="badge badge-active">已覆盖</span>
                    ) : (
                      <span className="badge">内置默认</span>
                    )}
                    {entry.sensitive && <span className="badge badge-sensitive">敏感</span>}
                    {entry.dirty && !entry.isNew && <span className="badge badge-dirty">未保存</span>}
                  </div>
                  {helpKey === entry.key && (
                    <div className="skill-env-desc">{entry.description || "暂无参数说明。新增参数时可填写描述以便后续查看。"}</div>
                  )}
                  {entry.editing ? (
                    <input
                      className="text-input"
                      type={entry.sensitive ? "password" : "text"}
                      placeholder={entry.sensitive && !entry.dirty ? entry.maskedValue || "（未设置）" : "值"}
                      value={entry.value}
                      autoFocus
                      onChange={(e) => updateValue(index, e.target.value)}
                    />
                  ) : (
                    <div className="skill-env-value" title={entry.sensitive ? undefined : entry.value}>
                      {maskForDisplay(entry.dirty ? entry.value : entry.originalValue, entry.sensitive, entry.maskedValue) ||
                        "（空）"}
                    </div>
                  )}
                </div>
                <div className="config-item-actions">
                  <button
                    className={`ghost-button${entry.editing ? " active" : ""}`}
                    title={entry.editing ? "取消编辑（还原本条修改）" : "编辑该项"}
                    onClick={() => toggleEditing(index)}
                  >
                    {entry.editing ? <X size={14} /> : <Pencil size={14} />}
                  </button>
                  {entry.source === "user" && (
                    <button className="ghost-button" title="删除该覆盖项（恢复内置默认）" onClick={() => removeEntry(index)}>
                      <Trash2 size={14} />
                    </button>
                  )}
                </div>
              </div>
            ))
          ) : (
            <p className="muted">{loading ? "加载中…" : "暂无配置项"}</p>
          )}
        </div>
      </section>

      <Modal
        open={addOpen}
        title="新增环境变量"
        onClose={() => setAddOpen(false)}
        footer={
          <div className="modal-form-actions">
            <button className="ghost-button" onClick={() => setAddOpen(false)}>
              取消
            </button>
            <button className="primary-button" onClick={submitAdd}>
              <Plus size={14} />
              添加
            </button>
          </div>
        }
      >
        <div className="skill-env-add-form">
          <label>
            <span>变量名 *</span>
            <input
              className="text-input"
              placeholder="如 TARGET_URL（字母/数字/下划线）"
              value={addForm.key}
              autoFocus
              onChange={(e) => setAddForm((prev) => ({ ...prev, key: e.target.value }))}
            />
          </label>
          <label>
            <span>值 *</span>
            <input
              className="text-input"
              placeholder="变量值"
              value={addForm.value}
              onChange={(e) => setAddForm((prev) => ({ ...prev, value: e.target.value }))}
            />
          </label>
          <label>
            <span>描述（可选）</span>
            <input
              className="text-input"
              placeholder="参数用途说明，展示在 key 旁的问号提示中"
              value={addForm.description}
              onChange={(e) => setAddForm((prev) => ({ ...prev, description: e.target.value }))}
            />
          </label>
        </div>
      </Modal>

      <Modal
        open={confirmOpen}
        title={`确认保存（${changes.length} 项变更）`}
        onClose={() => setConfirmOpen(false)}
        footer={
          <div className="modal-form-actions">
            <button className="ghost-button" disabled={saving} onClick={() => setConfirmOpen(false)}>
              取消
            </button>
            <button className="primary-button" disabled={saving} onClick={() => void save()}>
              {saving ? <Loader2 size={14} className="spin" /> : <Check size={14} />}
              确认保存
            </button>
          </div>
        }
      >
        <div className="skill-env-diff">
          {changes.length === 0 && <p className="muted">暂无变更</p>}
          {changes.map((change) => (
            <div key={change.key} className={`skill-env-diff-row ${change.kind}`}>
              <span className={`badge ${change.kind === "added" ? "badge-active" : change.kind === "removed" ? "badge-sensitive" : "badge-dirty"}`}>
                {change.kind === "added" ? "新增" : change.kind === "removed" ? "删除" : "修改"}
              </span>
              <code className="skill-env-key">{change.key}</code>
              <span className="skill-env-diff-values">
                {change.kind !== "added" && (
                  <em className="before">{change.sensitive ? "******" : change.before || "（空）"}</em>
                )}
                {change.kind === "modified" && <span className="arrow">→</span>}
                {change.kind !== "removed" && (
                  <em className="after">{change.sensitive ? "******" : change.after || "（空）"}</em>
                )}
              </span>
            </div>
          ))}
          <p className="muted" style={{ marginTop: 8 }}>
            保存后写入用户覆盖层（dataDir/config/skill.env），下次任务执行时生效。
          </p>
        </div>
      </Modal>
    </main>
  );
}

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API}${url}`, init);
  if (!response.ok) {
    const text = await response.text();
    let message = text;
    try {
      const payload = JSON.parse(text) as { error?: unknown };
      if (typeof payload.error === "string" && payload.error.trim()) {
        message = payload.error;
      }
    } catch {
      // Non-JSON endpoints keep their original response text.
    }
    throw new Error(message || `请求失败（HTTP ${response.status}）`);
  }
  return (await response.json()) as T;
}

async function readSse(body: ReadableStream<Uint8Array>, onPayload: (payload: StreamPayload) => void) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    buffer += decoder.decode(value, { stream: true });
    const chunks = buffer.split("\n\n");
    buffer = chunks.pop() ?? "";
    for (const chunk of chunks) {
      const line = chunk
        .split("\n")
        .find((item) => item.startsWith("data:"));
      if (!line) {
        continue;
      }
      onPayload(JSON.parse(line.slice(5).trim()) as StreamPayload);
    }
  }
}

function formatTime(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(value));
}

function formatSize(value: number): string {
  if (value < 1024) {
    return `${value} B`;
  }
  if (value < 1024 * 1024) {
    return `${(value / 1024).toFixed(1)} KB`;
  }
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

function formatSchedule(task: InspectionTask): string {
  if (!task.scheduleEnabled) {
    return "手动";
  }
  if (task.scheduleMode === "cron") {
    return task.cronExpression ?? "0 */3 * * *";
  }
  return `${task.intervalMinutes ?? 180} 分钟`;
}

/* ─── 回归任务模块 ─── */

type RegressionSubView = "modules" | "moduleDetail" | "cases" | "batches" | "batchDetail";

function RegressionCenter({
  modules,
  cases,
  batches,
  activeBatch,
  activeRunId,
  environments,
  moduleForm,
  setModuleForm,
  caseForm,
  setCaseForm,
  activeModuleId,
  selectedCaseIds,
  onSaveModule,
  onDeleteModule,
  onSaveCase,
  onDeleteCase,
  onSelectModule,
  onShowAllCases,
  onToggleCase,
  onToggleAllCases,
  onRunBatch,
  onAbortBatch,
  onDeleteBatch,
  onDeleteRun,
  onRefreshBatches,
  onSelectBatch,
  onSelectRun,
  robots
}: {
  modules: RegressionModule[];
  cases: RegressionCase[];
  batches: RegressionBatch[];
  activeBatch?: RegressionBatch;
  activeRunId?: string;
  environments: BusinessEnvironment[];
  moduleForm: { name: string; description: string };
  setModuleForm: React.Dispatch<React.SetStateAction<{ name: string; description: string }>>;
  caseForm: RegressionCaseForm;
  setCaseForm: React.Dispatch<React.SetStateAction<RegressionCaseForm>>;
  activeModuleId?: string;
  selectedCaseIds: Set<string>;
  onSaveModule: (input: { id?: string; name: string; description: string }) => Promise<void>;
  onDeleteModule: (id: string) => Promise<void>;
  onSaveCase: (input: RegressionCaseForm & { id?: string }) => Promise<void>;
  onDeleteCase: (id: string) => Promise<void>;
  onSelectModule: (id: string) => void;
  onShowAllCases: () => void;
  onToggleCase: (id: string) => void;
  onToggleAllCases: (ids: string[]) => void;
  onRunBatch: (
    caseIds: string[],
    name: string,
    options?: { notifyRobotId?: string; notifyTrigger?: InspectionNotifyTrigger }
  ) => Promise<void>;
  onAbortBatch: (id: string) => Promise<void>;
  onDeleteBatch: (id: string) => Promise<void>;
  onDeleteRun: (batchId: string, runId: string) => Promise<void>;
  onRefreshBatches: () => Promise<void>;
  onSelectBatch: (id: string) => void;
  onSelectRun: (batchId: string, runId: string) => void;
  robots?: DingtalkRobot[];
}) {
  const [subView, setSubView] = useState<RegressionSubView>("modules");
  const robotOptions = robots ?? [];
  const [editingModuleId, setEditingModuleId] = useState<string>();
  const [moduleModalOpen, setModuleModalOpen] = useState(false);
  const [editingCaseId, setEditingCaseId] = useState<string>();
  const [caseModalOpen, setCaseModalOpen] = useState(false);
  const [batchName, setBatchName] = useState("");
  const [activeRunDetail, setActiveRunDetail] = useState<RegressionRun>();
  // 通知选取弹窗：所有跑批入口先弹窗选机器人+触发条件，确认后再执行
  const [notifyModalOpen, setNotifyModalOpen] = useState(false);
  const [notifyRobotId, setNotifyRobotId] = useState("");
  const [notifyTrigger, setNotifyTrigger] = useState<InspectionNotifyTrigger>("failed");
  const [pendingBatchCaseIds, setPendingBatchCaseIds] = useState<string[]>([]);
  const [pendingBatchName, setPendingBatchName] = useState("");
  // 模块管理页多选 + 批量执行
  const [selectedModuleIds, setSelectedModuleIds] = useState<Set<string>>(new Set());
  // 当前可分享实体的链接复制反馈
  const [copiedLink, setCopiedLink] = useState<string | null>(null);

  // 当批次被选中（无论是从 URL 深链直达、浏览器前进/后退还是点击「查看详情」），
  // 自动切到批次详情子视图，让 /regression/batches/:batchId 直接落到执行记录
  // 详情页，而不是停在 modules 默认页。返回批次列表时 activeBatch 会被上层
  // 清空为 undefined，此 effect 不再触发，subView 保持 batches。
  useEffect(() => {
    if (activeBatch?.id) setSubView("batchDetail");
  }, [activeBatch?.id]);

  // 当批次数据加载完成后，若 URL 携带 runId（来自钉钉深链），自动打开对应
  // 执行记录详情弹窗；若该 run 不存在则静默忽略。
  //
  // 注意：自动打开只在 activeRunId「首次出现或发生变化」时触发一次（深链/前进后退
  // 场景）。用户手动关闭弹窗后不清空 activeRunId，若把 activeBatch.runs 放进依赖，
  // 运行中批次的轮询刷新会让此 effect 反复触发、把已关闭的弹窗又自动打开。这里用
  // ref 记录已消费过的 runId，确保「关闭后不再主动开启」，仅用户点击才打开。
  const consumedRunIdRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!activeRunId) {
      // URL 清掉 runId（返回列表/切换）时同步关闭并重置消费标记。
      consumedRunIdRef.current = undefined;
      setActiveRunDetail(undefined);
      return;
    }
    // 已经为该 runId 打开过一次，则不再因批次数据刷新而重开。
    if (consumedRunIdRef.current === activeRunId) return;
    if (activeBatch?.id) {
      const target = activeBatch.runs.find((r) => r.id === activeRunId);
      if (target) {
        consumedRunIdRef.current = activeRunId;
        setActiveRunDetail(target);
      }
    }
  }, [activeBatch?.id, activeBatch?.runs, activeRunId]);

  // 统一的关闭处理：关闭执行记录详情弹窗时，同时清掉 URL 上的 runId 深链，
  // 并把已消费标记指向当前 runId，确保关闭后不会因批次轮询刷新或页面刷新而重开。
  const closeRunDetail = useCallback(() => {
    consumedRunIdRef.current = activeRunId;
    setActiveRunDetail(undefined);
    if (activeRunId && activeBatch?.id) {
      navigate(buildPath("regression", activeBatch.id, "batches"));
    }
  }, [activeRunId, activeBatch?.id]);

  const modulesPagination = usePagination(modules, 30);
  const casesPagination = usePagination(cases, 30);
  const batchesPagination = usePagination(batches, 30);
  const runsPagination = usePagination(activeBatch?.runs ?? [], 30);

  const moduleCases = filterRegressionCasesByModule(cases, activeModuleId);
  const moduleCasesPagination = usePagination(moduleCases, 30);
  const visibleCases = subView === "moduleDetail" ? moduleCasesPagination.pagedItems : casesPagination.pagedItems;
  const allVisibleSelected =
    visibleCases.length > 0 && visibleCases.every((c) => selectedCaseIds.has(c.id));
  const allModulesSelected =
    modulesPagination.pagedItems.length > 0 &&
    modulesPagination.pagedItems.every((m) => selectedModuleIds.has(m.id));
  const envName = (id?: string) =>
    id ? environments.find((e) => e.id === id)?.name ?? id : "未选择";
  const activeModule = modules.find((m) => m.id === activeModuleId);

  // 打开通知选取弹窗，暂存待执行用例与批次名
  const openNotifyModal = (caseIds: string[], name: string) => {
    if (!caseIds.length) return;
    setPendingBatchCaseIds(caseIds);
    setPendingBatchName(name);
    setNotifyRobotId("");
    setNotifyTrigger("failed");
    setNotifyModalOpen(true);
  };

  const closeNotifyModal = () => {
    setNotifyModalOpen(false);
    setPendingBatchCaseIds([]);
    setPendingBatchName("");
  };

  const confirmRunBatch = async () => {
    const opts =
      notifyRobotId && notifyTrigger !== "never"
        ? { notifyRobotId, notifyTrigger }
        : notifyRobotId
          ? { notifyRobotId, notifyTrigger }
          : undefined;
    await onRunBatch(pendingBatchCaseIds, pendingBatchName, opts);
    closeNotifyModal();
    setSubView("batchDetail");
  };

  const toggleModule = (id: string) => {
    setSelectedModuleIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleAllModules = (ids: string[]) => {
    setSelectedModuleIds((prev) => {
      if (ids.length && ids.every((id) => prev.has(id))) return new Set();
      return new Set(ids);
    });
  };

  // 跑批后自动跳转到批次详情，展示每条用例的执行状态
  const handleRunBatch = async (
    caseIds: string[],
    name: string,
    options?: { notifyRobotId?: string; notifyTrigger?: InspectionNotifyTrigger }
  ) => {
    await onRunBatch(caseIds, name, options);
    setSubView("batchDetail");
  };

  const openCreateModule = () => {
    setEditingModuleId(undefined);
    setModuleForm({ name: "", description: "" });
    setModuleModalOpen(true);
  };
  const openEditModule = (m: RegressionModule) => {
    setEditingModuleId(m.id);
    setModuleForm({ name: m.name ?? "", description: m.description ?? "" });
    setModuleModalOpen(true);
  };
  const closeModuleModal = () => {
    setModuleModalOpen(false);
    setEditingModuleId(undefined);
    setModuleForm({ name: "", description: "" });
  };

  const openCreateCase = () => {
    setEditingCaseId(undefined);
    setCaseForm({ moduleId: activeModuleId ?? "", name: "", description: "", prompt: "", businessId: "", notifyRobotId: "", notifyTrigger: "failed" });
    setCaseModalOpen(true);
  };
  const openEditCase = (c: RegressionCase) => {
    setEditingCaseId(c.id);
    setCaseForm({
      moduleId: c.moduleId,
      name: c.name ?? "",
      description: c.description ?? "",
      prompt: c.prompt ?? "",
      businessId: c.businessId ?? "",
      notifyRobotId: c.notifyRobotId ?? "",
      notifyTrigger: (c.notifyTrigger ?? "failed") as InspectionNotifyTrigger
    });
    setCaseModalOpen(true);
  };
  const closeCaseModal = () => {
    setCaseModalOpen(false);
    setEditingCaseId(undefined);
  };

  return (
    <main className="regression-area">
      <header className="chat-header">
        <div>
          <h1>回归任务</h1>
          <p>分模块维护自动化用例库，批量执行并查看执行记录、产物与成功率。</p>
        </div>
        <div className="header-actions regression-subnav">
          <button
            className={`ghost-button ${subView === "modules" || subView === "moduleDetail" ? "active" : ""}`}
            onClick={() => setSubView("modules")}
          >
            模块管理
          </button>
          <button
            className={`ghost-button ${subView === "cases" ? "active" : ""}`}
            onClick={() => {
              onShowAllCases();
              setSubView("cases");
            }}
          >
            用例库
          </button>
          <button
            className={`ghost-button ${subView === "batches" || subView === "batchDetail" ? "active" : ""}`}
            onClick={() => setSubView("batches")}
          >
            执行记录
          </button>
        </div>
      </header>

      {subView === "modules" ? (
        <section className="regression-section">
          <div className="panel-title list-head">
            <ShieldCheck size={15} />
            模块列表
            <span className="muted">共 {modules.length} 个</span>
            <div className="header-actions">
              <button className="new-button" onClick={openCreateModule}>
                <Plus size={16} />
                新建模块
              </button>
            </div>
          </div>
          <div className="regression-batch-bar">
            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={allModulesSelected}
                onChange={() => toggleAllModules(modulesPagination.pagedItems.map((m) => m.id))}
              />
              全选当前页
            </label>
            <button
              className="primary-button"
              disabled={!selectedModuleIds.size}
              onClick={() => {
                // 聚合所选模块下的全部用例，走统一通知选取弹窗
                const selectedIds = [...selectedModuleIds];
                const aggregated = cases
                  .filter((c) => selectedIds.includes(c.moduleId))
                  .map((c) => c.id);
                if (!aggregated.length) {
                  alert("所选模块下暂无用例");
                  return;
                }
                openNotifyModal(aggregated, `批量执行 ${selectedIds.length} 个模块`);
              }}
            >
              <Play size={14} />
              批量执行所选模块 ({selectedModuleIds.size})
            </button>
          </div>
          {modulesPagination.pagedItems.length ? (
            modulesPagination.pagedItems.map((m) => (
              <div
                key={m.id}
                className={`config-item config-item-clickable ${selectedModuleIds.has(m.id) ? "active-model" : ""}`}
                onClick={() => {
                  onSelectModule(m.id);
                  setSubView("moduleDetail");
                }}
              >
                <div className="config-item-main">
                  <label className="checkbox-label inline" onClick={(e) => e.stopPropagation()}>
                    <input
                      type="checkbox"
                      checked={selectedModuleIds.has(m.id)}
                      onChange={() => toggleModule(m.id)}
                    />
                    <strong>{m.name}</strong>
                  </label>
                  <em>{m.description || "无描述"}</em>
                  <span className="muted">{formatTime(m.updatedAt)}</span>
                </div>
                <div className="config-item-actions">
                  <button
                    className="ghost-button"
                    onClick={(e) => {
                      e.stopPropagation();
                      openEditModule(m);
                    }}
                  >
                    <Pencil size={14} />
                    编辑
                  </button>
                  <button
                    className="danger-button"
                    onClick={(e) => {
                      e.stopPropagation();
                      void onDeleteModule(m.id);
                    }}
                  >
                    删除
                  </button>
                </div>
              </div>
            ))
          ) : (
            <div className="empty-state">
              <ShieldCheck size={24} />
              <span>暂无模块，点击右上角"新建模块"创建</span>
            </div>
          )}
          <Pagination state={modulesPagination} />
        </section>
      ) : null}

      {subView === "moduleDetail" && activeModule ? (
        <section className="regression-section">
          <div className="panel-title list-head">
            <button
              className="ghost-button back-button"
              type="button"
              onClick={() => {
                setSubView("modules");
                navigate("/regression");
              }}
            >
              <ArrowLeft size={16} />
              返回模块
            </button>
            <FileText size={15} />
            {activeModule.name} · 用例列表
            <span className="muted">共 {moduleCases.length} 条</span>
            <div className="header-actions">
              <button
                className="icon-button"
                type="button"
                title="复制当前模块链接"
                onClick={async () => {
                  const ok = await copyShareLink("regression", activeModule.id, "modules");
                  if (ok) {
                    setCopiedLink(`module:${activeModule.id}`);
                    setTimeout(
                      () => setCopiedLink((c) => (c === `module:${activeModule.id}` ? null : c)),
                      1500
                    );
                  }
                }}
              >
                {copiedLink === `module:${activeModule.id}` ? (
                  <Check size={16} />
                ) : (
                  <Link2 size={16} />
                )}
              </button>
              <button className="new-button" onClick={openCreateCase}>
                <Plus size={16} />
                新建用例
              </button>
            </div>
          </div>
          <div className="regression-batch-bar">
            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={allVisibleSelected}
                onChange={() => onToggleAllCases(visibleCases.map((c) => c.id))}
              />
              全选当前页
            </label>
            <input
              className="batch-name-input"
              value={batchName}
              onChange={(e) => setBatchName(e.target.value)}
              placeholder="批次名称（可选）"
            />
            <button
              className="primary-button"
              disabled={!selectedCaseIds.size}
              onClick={() => openNotifyModal([...selectedCaseIds], batchName)}
            >
              <Play size={14} />
              跑批执行 ({selectedCaseIds.size})
            </button>
          </div>
          {moduleCasesPagination.pagedItems.length ? (
            moduleCasesPagination.pagedItems.map((c) => (
              <div key={c.id} className={`config-item ${selectedCaseIds.has(c.id) ? "active-model" : ""}`}>
                <div className="config-item-main">
                  <label className="checkbox-label inline">
                    <input
                      type="checkbox"
                      checked={selectedCaseIds.has(c.id)}
                      onChange={() => onToggleCase(c.id)}
                    />
                    <strong>{c.name}</strong>
                  </label>
                  <em>{c.description || "无描述"}</em>
                  <span className="muted">环境：{envName(c.businessId)}</span>
                  <span className="case-prompt-preview" title={c.prompt}>指令：{c.prompt}</span>
                </div>
                <div className="config-item-actions">
                  <button className="ghost-button" onClick={() => openEditCase(c)}>
                    <Pencil size={14} />
                    编辑
                  </button>
                  <button className="danger-button" onClick={() => void onDeleteCase(c.id)}>
                    删除
                  </button>
                </div>
              </div>
            ))
          ) : (
            <div className="empty-state">
              <FileText size={24} />
              <span>该模块暂无用例，点击右上角"新建用例"创建</span>
            </div>
          )}
          <Pagination state={moduleCasesPagination} />
        </section>
      ) : null}

      {subView === "cases" ? (
        <section className="regression-section">
          <div className="panel-title list-head">
            <FileText size={15} />
            用例库
            <span className="muted">共 {cases.length} 条</span>
            <div className="header-actions">
              <button className="new-button" onClick={openCreateCase}>
                <Plus size={16} />
                新建用例
              </button>
            </div>
          </div>
          <div className="regression-batch-bar">
            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={allVisibleSelected}
                onChange={() => onToggleAllCases(visibleCases.map((c) => c.id))}
              />
              全选当前页
            </label>
            <input
              className="batch-name-input"
              value={batchName}
              onChange={(e) => setBatchName(e.target.value)}
              placeholder="批次名称（可选）"
            />
            <button
              className="primary-button"
              disabled={!selectedCaseIds.size}
              onClick={() => openNotifyModal([...selectedCaseIds], batchName)}
            >
              <Play size={14} />
              跑批执行 ({selectedCaseIds.size})
            </button>
          </div>
          {casesPagination.pagedItems.length ? (
            casesPagination.pagedItems.map((c) => (
              <div key={c.id} className={`config-item ${selectedCaseIds.has(c.id) ? "active-model" : ""}`}>
                <div className="config-item-main">
                  <label className="checkbox-label inline">
                    <input
                      type="checkbox"
                      checked={selectedCaseIds.has(c.id)}
                      onChange={() => onToggleCase(c.id)}
                    />
                    <strong>{c.name}</strong>
                  </label>
                  <em>{c.description || "无描述"}</em>
                  <span className="muted">
                    模块：{modules.find((m) => m.id === c.moduleId)?.name ?? c.moduleId} · 环境：{envName(c.businessId)}
                  </span>
                  <span className="case-prompt-preview" title={c.prompt}>指令：{c.prompt}</span>
                </div>
                <div className="config-item-actions">
                  <button className="ghost-button" onClick={() => openEditCase(c)}>
                    <Pencil size={14} />
                    编辑
                  </button>
                  <button className="danger-button" onClick={() => void onDeleteCase(c.id)}>
                    删除
                  </button>
                </div>
              </div>
            ))
          ) : (
            <div className="empty-state">
              <FileText size={24} />
              <span>暂无用例，点击右上角"新建用例"创建</span>
            </div>
          )}
          <Pagination state={casesPagination} />
        </section>
      ) : null}

      {subView === "batches" ? (
        <section className="regression-section">
          <div className="panel-title list-head">
            <History size={15} />
            批次列表
            <span className="muted">共 {batches.length} 个</span>
            <RefreshIconButton title="刷新批次列表" size={14} onRefresh={onRefreshBatches} />
          </div>
          {batchesPagination.pagedItems.length ? (
            batchesPagination.pagedItems.map((b) => {
              return (
                <div key={b.id} className="config-item">
                  <div className="config-item-main">
                    <strong>
                      {b.name}
                      <span className={`badge ${b.status === "running" ? "badge-active" : "badge-default"}`}>
                        {b.status}
                      </span>
                    </strong>
                    <em>
                      {(() => {
                        const hasTest = b.passed !== undefined || b.assertFailed !== undefined;
                        const testPass = b.passed ?? 0;
                        const testFail = b.assertFailed ?? 0;
                        const testRate = b.total ? Math.round((testPass / b.total) * 100) : 0;
                        const rateClass = testRate >= 100 ? "rate-pass" : testRate <= 0 ? "rate-fail" : "rate-mixed";
                        return (
                          <>
                            {hasTest ? (
                              <span className={`test-rate ${rateClass}`}>
                                测试 PASS {testPass} / FAIL {testFail}（成功率 {testRate}%）
                              </span>
                            ) : (
                              <span className="muted">测试结果统计中</span>
                            )}
                            <span className="muted"> · 执行通过 {b.completed}/{b.total}{b.failed ? ` 失败 ${b.failed}` : ""}{b.aborted ? ` 中止 ${b.aborted}` : ""}{hasTest && b.unknown ? ` 未知 ${b.unknown}` : ""}</span>
                          </>
                        );
                      })()}
                    </em>
                    <span className="muted">{formatTime(b.startedAt)}</span>
                  </div>
                  <div className="config-item-actions">
                    {b.status === "running" && (
                      <button className="danger-button" onClick={() => void onAbortBatch(b.id)}>
                        中止
                      </button>
                    )}
                    <button
                      className="ghost-button"
                      onClick={() => {
                        onSelectBatch(b.id);
                        setSubView("batchDetail");
                      }}
                    >
                      查看详情
                    </button>
                    {b.status !== "running" && (
                      <button className="danger-button" onClick={() => void onDeleteBatch(b.id)}>
                        删除
                      </button>
                    )}
                  </div>
                </div>
              );
            })
          ) : (
            <div className="empty-state">
              <History size={24} />
              <span>暂无执行批次</span>
            </div>
          )}
          <Pagination state={batchesPagination} />
        </section>
      ) : null}

      {subView === "batchDetail" && activeBatch ? (
        <section className="regression-section">
          <div className="panel-title list-head">
            <button
              className="ghost-button back-button"
              type="button"
              onClick={() => {
                setSubView("batches");
                navigate("/regression");
              }}
            >
              <ArrowLeft size={16} />
              返回批次列表
            </button>
            <History size={15} />
            {activeBatch.name} · 测试成功率 {activeBatch.total ? Math.round(((activeBatch.passed ?? 0) / activeBatch.total) * 100) : 0}%
            <div className="header-actions">
              <button
                className="icon-button"
                type="button"
                title="复制当前批次链接"
                onClick={async () => {
                  const ok = await copyShareLink("regression", activeBatch.id, "batches");
                  if (ok) {
                    setCopiedLink(`batch:${activeBatch.id}`);
                    setTimeout(
                      () => setCopiedLink((c) => (c === `batch:${activeBatch.id}` ? null : c)),
                      1500
                    );
                  }
                }}
              >
                {copiedLink === `batch:${activeBatch.id}` ? (
                  <Check size={16} />
                ) : (
                  <Link2 size={16} />
                )}
              </button>
              {activeBatch.status === "running" && (
                <button className="danger-button" onClick={() => void onAbortBatch(activeBatch.id)}>
                  中止批次
                </button>
              )}
            </div>
          </div>
          {runsPagination.pagedItems.length ? (
            runsPagination.pagedItems.map((r) => (
              <div key={r.id} className="config-item run-clickable" onClick={() => { setActiveRunDetail(r); onSelectRun(activeBatch.id, r.id); }}>
                <span className={`status-dot ${r.status}`} />
                <div className="config-item-main">
                  <strong>
                    {r.caseName}
                    <span className={`badge ${r.status === "completed" ? "badge-active" : r.status === "failed" ? "badge-failed" : "badge-default"}`}>
                      {r.status === "pending" ? "等待中" : r.status === "running" ? "执行中" : r.status === "completed" ? "完成" : r.status === "failed" ? "失败" : "中止"}
                    </span>
                    {r.testOutcome && (
                      <span className={`badge ${r.testOutcome === "pass" ? "badge-active" : r.testOutcome === "fail" ? "badge-failed" : "badge-default"}`}>
                        {r.testOutcome === "pass" ? "PASS" : r.testOutcome === "fail" ? "FAIL" : "未知"}
                      </span>
                    )}
                    {r.notifyStatus && (
                      <NotifyStatusBadge status={r.notifyStatus} message={r.notifyMessage} />
                    )}
                  </strong>
                  <em>{r.summary || r.error || (r.status === "running" ? "执行中…" : r.status === "pending" ? "排队等待" : "—")}</em>
                  <span className="muted">
                    {r.startedAt ? `开始 ${formatTime(r.startedAt)}` : ""}
                    {r.finishedAt ? ` · 结束 ${formatTime(r.finishedAt)}` : ""}
                    {r.sessionId && (
                      <>
                        {" · 产物："}
                        <a href={`/sessions/${r.sessionId}/artifacts`} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>
                          查看
                        </a>
                        {r.artifactsCount ? `（${r.artifactsCount}）` : ""}
                      </>
                    )}
                  </span>
                </div>
                <div className="config-item-actions">
                  {r.sessionId && (
                    <button
                      className="icon-button"
                      type="button"
                      title="复制执行记录链接"
                      onClick={async (e) => {
                        e.stopPropagation();
                        const ok = await copyShareLink("regression", activeBatch.id, "batches", r.id);
                        if (ok) {
                          setCopiedLink(`run:${r.id}`);
                          setTimeout(() => setCopiedLink((c) => (c === `run:${r.id}` ? null : c)), 1500);
                        }
                      }}
                    >
                      {copiedLink === `run:${r.id}` ? <Check size={14} /> : <Link2 size={14} />}
                    </button>
                  )}
                  {r.sessionId && (
                    <button
                      className="primary-button small-button"
                      onClick={(e) => {
                        e.stopPropagation();
                        openSessionPage(r.sessionId!);
                      }}
                    >
                      <FileText size={14} />
                      打开会话
                    </button>
                  )}
                  {r.status !== "running" && r.status !== "pending" && (
                    <button
                      className="danger-button"
                      onClick={(e) => {
                        e.stopPropagation();
                        void onDeleteRun(activeBatch.id, r.id);
                      }}
                    >
                      <Trash2 size={14} />
                      删除
                    </button>
                  )}
                </div>
              </div>
            ))
          ) : (
            <div className="empty-state">
              <History size={24} />
              <span>该批次无执行记录</span>
            </div>
          )}
          <Pagination state={runsPagination} />
        </section>
      ) : null}

      <Modal
        open={Boolean(activeRunDetail)}
        title={
          <div className="modal-title-inner">
            <History size={18} />
            执行记录详情
          </div>
        }
        onClose={closeRunDetail}
        footer={(() => {
          if (!activeRunDetail?.sessionId) return undefined;
          return (
            <div className="modal-run-detail-footer">
              <a
                className="primary-button small-button"
                href={`/sessions/${activeRunDetail.sessionId}/artifacts`}
                target="_blank"
                rel="noreferrer"
              >
                <Download size={14} />
                查看产物
              </a>
              <button
                className="primary-button small-button"
                onClick={() => openSessionPage(activeRunDetail.sessionId!)}
              >
                <FileText size={14} />
                打开会话
              </button>
              <button
                className="ghost-button"
                type="button"
                title="复制执行记录链接"
                onClick={async () => {
                  if (!activeBatch || !activeRunDetail) return;
                  const ok = await copyShareLink("regression", activeBatch.id, "batches", activeRunDetail.id);
                  if (ok) {
                    setCopiedLink(`modal:${activeRunDetail.id}`);
                    setTimeout(() => setCopiedLink((c) => (c === `modal:${activeRunDetail.id}` ? null : c)), 1500);
                  }
                }}
              >
                {copiedLink === `modal:${activeRunDetail.id}` ? <Check size={14} /> : <Link2 size={14} />}
                复制链接
              </button>
              <button className="ghost-button" type="button" onClick={closeRunDetail}>
                关闭
              </button>
            </div>
          );
        })()}
      >
        {activeRunDetail && activeBatch ? (
          <div className="run-detail-body">
            <div className="detail-grid">
              <InfoTile
                icon={<History size={15} />}
                label="状态"
                value={
                  activeRunDetail.status === "pending"
                    ? "等待中"
                    : activeRunDetail.status === "running"
                      ? "执行中"
                      : activeRunDetail.status === "completed"
                        ? "通过"
                        : activeRunDetail.status === "failed"
                          ? "失败"
                          : "中止"
                }
              />
              <InfoTile icon={<FileText size={15} />} label="用例名称" value={activeRunDetail.caseName} />
              <InfoTile
                icon={<Clock3 size={15} />}
                label="开始时间"
                value={activeRunDetail.startedAt ? formatTime(activeRunDetail.startedAt) : "—"}
              />
              <InfoTile
                icon={<Clock3 size={15} />}
                label="结束时间"
                value={activeRunDetail.finishedAt ? formatTime(activeRunDetail.finishedAt) : "—"}
              />
              {activeRunDetail.notifyStatus ? (
                <InfoTile
                  icon={<Bell size={15} />}
                  label="通知状态"
                  value={
                    activeRunDetail.notifyStatus === "sent"
                      ? "已推送"
                      : activeRunDetail.notifyStatus === "failed"
                        ? `失败：${activeRunDetail.notifyMessage ?? ""}`
                        : `未推送：${activeRunDetail.notifyMessage ?? ""}`
                  }
                />
              ) : null}
            </div>
            <div className="run-detail-block">
              <div className="run-detail-label">执行结果</div>
              <pre className="run-detail-pre">{activeRunDetail.summary || activeRunDetail.error || (activeRunDetail.status === "running" ? "执行中…" : activeRunDetail.status === "pending" ? "排队等待" : "—")}</pre>
            </div>
            {activeRunDetail.sessionId ? (
              <div className="run-detail-block">
                <div className="run-detail-label">会话 / 产物</div>
                <div className="run-detail-session">
                  <code>{activeRunDetail.sessionId}</code>
                  {activeRunDetail.artifactsCount ? <span className="muted">产物 {activeRunDetail.artifactsCount} 个</span> : null}
                </div>
              </div>
            ) : null}
          </div>
        ) : null}
      </Modal>

      <Modal
        open={moduleModalOpen}
        title={
          <div className="modal-title-inner">
            {editingModuleId ? <Pencil size={18} /> : <Plus size={18} />}
            {editingModuleId ? "编辑模块" : "新建模块"}
          </div>
        }
        onClose={closeModuleModal}
      >
        <form
          className="regression-form modal-form"
          onSubmit={(e) => {
            e.preventDefault();
            void onSaveModule({ id: editingModuleId, name: moduleForm.name, description: moduleForm.description }).then(() => closeModuleModal());
          }}
        >
          <label>
            <span>模块名称</span>
            <input
              required
              value={moduleForm.name}
              onChange={(e) => setModuleForm((p) => ({ ...p, name: e.target.value }))}
              placeholder="例如：登录模块"
            />
          </label>
          <label>
            <span>模块描述</span>
            <textarea
              value={moduleForm.description}
              onChange={(e) => setModuleForm((p) => ({ ...p, description: e.target.value }))}
              placeholder="可选"
            />
          </label>
          <div className="modal-form-actions">
            <button className="primary-button" type="submit">
              {editingModuleId ? "保存" : "创建模块"}
            </button>
            <button className="ghost-button" type="button" onClick={closeModuleModal}>
              取消
            </button>
          </div>
        </form>
      </Modal>

      <Modal
        open={caseModalOpen}
        title={
          <div className="modal-title-inner">
            {editingCaseId ? <Pencil size={18} /> : <Plus size={18} />}
            {editingCaseId ? "编辑用例" : "新建用例"}
          </div>
        }
        onClose={closeCaseModal}
      >
        <form
          className="regression-form modal-form"
          onSubmit={(e) => {
            e.preventDefault();
            const moduleId = caseForm.moduleId || activeModuleId || "";
            if (!moduleId) {
              return;
            }
            void onSaveCase({ id: editingCaseId, ...caseForm, moduleId }).then(() => closeCaseModal());
          }}
        >
          <label>
            <span>所属模块</span>
            <select
              required
              value={caseForm.moduleId || activeModuleId || ""}
              onChange={(e) => setCaseForm((p) => ({ ...p, moduleId: e.target.value }))}
            >
              <option value="">请选择模块</option>
              {modules.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </select>
          </label>
          <div className="form-row">
            <label>
              <span>用例名称</span>
              <input
                required
                value={caseForm.name}
                onChange={(e) => setCaseForm((p) => ({ ...p, name: e.target.value }))}
                placeholder="例如：登录成功用例"
              />
            </label>
            <label>
              <span>业务环境（可选）</span>
              <select
                value={caseForm.businessId}
                onChange={(e) => setCaseForm((p) => ({ ...p, businessId: e.target.value }))}
              >
                <option value="">不指定</option>
                {environments.map((env) => (
                  <option key={env.id} value={env.id}>
                    {env.name}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <label>
            <span>用例描述</span>
            <textarea
              value={caseForm.description}
              onChange={(e) => setCaseForm((p) => ({ ...p, description: e.target.value }))}
              placeholder="可选，简要说明该用例验证的场景"
            />
          </label>
          <label>
            <span>执行 Prompt</span>
            <textarea
              required
              rows={6}
              value={caseForm.prompt}
              onChange={(e) => setCaseForm((p) => ({ ...p, prompt: e.target.value }))}
              placeholder="发给智能体的执行指令，例如：打开登录页，输入账号密码，点击登录按钮，验证跳转到首页"
            />
            <span className="field-hint">这是发给 UI 测试智能体的具体指令，会作为会话的第一条消息发送</span>
          </label>
          <div className="form-row">
            <label>
              <span>通知机器人</span>
              <select
                value={caseForm.notifyRobotId}
                onChange={(e) => setCaseForm((p) => ({ ...p, notifyRobotId: e.target.value }))}
              >
                <option value="">不通知</option>
                {robotOptions.map((r: DingtalkRobot) => (
                  <option key={r.id} value={r.id}>{r.name}</option>
                ))}
              </select>
            </label>
            <label>
              <span>触发条件</span>
              <select
                value={caseForm.notifyTrigger}
                onChange={(e) => setCaseForm((p) => ({ ...p, notifyTrigger: e.target.value as InspectionNotifyTrigger }))}
              >
                <option value="always">执行完就通知</option>
                <option value="failed">仅失败通知</option>
                <option value="never">不通知</option>
              </select>
            </label>
          </div>
          <div className="modal-form-actions">
            <button className="primary-button" type="submit">
              {editingCaseId ? "保存" : "创建用例"}
            </button>
            <button className="ghost-button" type="button" onClick={closeCaseModal}>
              取消
            </button>
          </div>
        </form>
      </Modal>

      {notifyModalOpen && (
        <div className="modal-overlay" onClick={closeNotifyModal}>
          <div className="modal-dialog" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <div className="modal-title">执行并通知</div>
              <button className="modal-close" type="button" onClick={closeNotifyModal} aria-label="关闭">
                <X size={18} />
              </button>
            </div>
            <div className="modal-body">
              <p className="muted">
                即将执行 <strong>{pendingBatchCaseIds.length}</strong> 条用例。
                选择是否需要钉钉通知及触发条件，确认后开始跑批。
              </p>
              <div className="form-row">
                <label>通知机器人</label>
                <select
                  value={notifyRobotId}
                  onChange={(e) => setNotifyRobotId(e.target.value)}
                >
                  <option value="">不通知</option>
                  {robotOptions.map((r) => (
                    <option key={r.id} value={r.id}>{r.name}</option>
                  ))}
                </select>
              </div>
              <div className="form-row">
                <label>触发条件</label>
                <select
                  value={notifyTrigger}
                  onChange={(e) => setNotifyTrigger(e.target.value as InspectionNotifyTrigger)}
                >
                  <option value="always">执行完就通知</option>
                  <option value="failed">仅失败通知</option>
                  <option value="never">不通知</option>
                </select>
              </div>
            </div>
            <div className="modal-footer">
              <button className="ghost-button" onClick={closeNotifyModal}>
                取消
              </button>
              <button className="primary-button" onClick={() => void confirmRunBatch()}>
                <Play size={14} />
                确认执行
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
