import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  AppWindow,
  ArrowLeft,
  ArrowRight,
  Bot,
  Check,
  ChevronDown,
  Code2,
  Copy,
  Cookie,
  Download,
  Eye,
  FileText,
  FolderOpen,
  Globe2,
  Hand,
  History,
  Image,
  List,
  Loader2,
  MessageSquare,
  Monitor,
  PanelRightClose,
  PanelRightOpen,
  PanelsTopLeft,
  Pause,
  PictureInPicture2,
  Plus,
  Play,
  RefreshCw,
  RotateCw,
  Send,
  Settings,
  Search,
  ShieldCheck,
  Square,
  Star,
  Terminal,
  Trash2,
  ZoomIn,
  ZoomOut,
  X
} from "lucide-react";
import { reconcilePictureInPictureClose } from "./pictureInPictureState";
import { NativeRunPanel } from "./qualityWorkspace";
import "./qualityWorkspace.css";

type BrowserKernel = "playwright" | "skill-profile" | "external-cdp" | "uiwarden-embedded" | "gui-computer";
type NativeProviderId = "mock" | "macos-accessibility" | "windows-ui-automation";
type NativeControlMode = "observe" | "agent-control" | "human-control";
const IS_DESKTOP_APP = typeof navigator !== "undefined" && navigator.userAgent.includes("Electron");
const DEFAULT_OPERATION_EXPERIENCE: UiOperationExperience = {
  presentationMode: "inline",
  browserTaskGroupMode: "off",
  nativeDeliveryMode: "foreground-compatible"
};

interface BusinessEnvironmentOption {
  id: string;
  name: string;
}

interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  createdAt: string;
}

interface AgentSession {
  id: string;
  status: "idle" | "running" | "failed" | "completed";
  messages: ChatMessage[];
  artifacts: ArtifactInfo[];
  lastError?: string;
}

interface CdpStatus {
  running: boolean;
  mode?: "managed" | "external" | "extension";
  port: number;
  cdpUrl: string;
  browserVersion?: string;
  browserPath?: string;
  browserName?: string;
  selectedBrowserId?: string;
  selectedTabId?: string;
  tabs?: Array<{ id: string; title: string; url: string; type: string }>;
  error?: string;
}

interface CdpBrowserOption {
  id: string;
  name: string;
  vendor: string;
  source: "installed" | "running-cdp" | "extension-bridge" | "firefox-profile" | "embedded-kernel";
  action: "launch-cdp" | "connect-cdp" | "connect-extension" | "use-firefox-profile" | "use-embedded-kernel";
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

interface BrowserExtensionBridgeStatus {
  installed: boolean;
  paired: boolean;
  connected: boolean;
  canGroupExistingTab: boolean;
  extensionId: string;
  extensionDir: string;
  tabs: Array<{ id: string; title: string; url: string; active: boolean }>;
  reason?: string;
}

interface BrowserExtensionPairing {
  pairingUrl: string;
  extensionId: string;
  extensionDir: string;
  instruction: string;
}

interface CdpTaskGroupCapability {
  available: boolean;
  extensionId: string;
  setupRequired: boolean;
  installationMode: "installed" | "manual" | "unavailable";
  autoLoadSupported: boolean;
  reason?: string;
}

interface CdpTaskGroupSetup {
  opened: boolean;
  extensionId: string;
  instruction: string;
}

function cdpBrowserOptionLabel(browser: CdpBrowserOption): string {
  if (browser.action === "connect-extension") {
    return browser.connectable
      ? `${browser.name} · 可接管 ${browser.tabsCount ?? 0} 个现有页面`
      : `${browser.name} · 需要安装或配对`;
  }
  if (browser.action === "use-firefox-profile") {
    return `${browser.name} · 已安装（切换 Firefox Profile）`;
  }
  if (browser.action === "use-embedded-kernel") {
    return `${browser.name} · 已安装（切换内置内核）`;
  }
  if (browser.connectable) {
    return `${browser.name} · 可连接 ${browser.tabsCount ?? 0} 个页面`;
  }
  return `${browser.name}${browser.running ? " · 正在运行（需启动可控实例）" : " · 已安装"}`;
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

interface UiOperationRun {
  id: string;
  taskId: string;
  sessionId: string;
  instruction?: string;
  status: "idle" | "running" | "waiting-approval" | "completed" | "failed" | "aborted";
  startedAt: string;
  finishedAt?: string;
  summary?: string;
  error?: string;
  artifactsCount: number;
  nativeSessionId?: string;
  nativeControlMode?: NativeControlMode;
  nativeArtifactDir?: string;
  browserTaskGroup?: {
    status: "created" | "failed";
    groupId?: number;
    targetId?: string;
    title?: string;
    error?: string;
  };
  pendingApprovalId?: string;
  pendingApprovalSummary?: string;
}

interface UiOperationExperience {
  presentationMode: "inline" | "picture-in-picture";
  browserTaskGroupMode: "off" | "user-browser";
  nativeDeliveryMode: "foreground-compatible" | "background-safe";
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
  isDraft?: boolean;
  conversationSessionId?: string;
  businessId?: string;
  browserKernel: BrowserKernel;
  executionTarget: UiOperationExecutionTarget;
  experience: UiOperationExperience;
  approvalMode: "none" | "manual-finalize";
  createdAt: string;
  updatedAt: string;
  runs: UiOperationRun[];
}

interface NativeAutomationStatus {
  platform: string;
  providers: Array<{
    providerId: string;
    status: "ok" | "unavailable";
    data?: { permission?: string; screenCapturePermission?: string };
    error?: { message?: string };
  }>;
}

interface StreamPayload {
  type: "session" | "message" | "text" | "tool" | "log" | "screenshot" | "status" | "result" | "artifacts" | "error" | "done";
  data?: unknown;
}

interface EmbeddedBrowserTab {
  id: string;
  title: string;
  url: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  targetId?: string;
  crashed?: boolean;
}

interface EmbeddedBrowserLibraryEntry {
  id: string;
  title: string;
  url: string;
}

interface EmbeddedBrowserState {
  activeTabId: string | null;
  controlMode: "idle" | "agent-control" | "human-control";
  activeRunId?: string;
  controlledTargetId?: string;
  bookmarks: EmbeddedBrowserLibraryEntry[];
  history: EmbeddedBrowserLibraryEntry[];
  activeBookmarked: boolean;
  zoomFactor: number;
  presentationMode?: "inline" | "picture-in-picture";
  tabs: EmbeddedBrowserTab[];
}

interface EmbeddedBrowserApi {
  getState: () => Promise<EmbeddedBrowserState>;
  capturePreview: () => Promise<{
    dataUrl: string;
    capturedAt: string;
    targetId?: string;
    width?: number;
    height?: number;
  }>;
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

interface PictureInPictureState {
  available: boolean;
  open: boolean;
  closeReason?: string;
  source: "embedded-browser" | "native-stream" | "snapshot";
  interactive: boolean;
  interactionEnabled?: boolean;
  title: string;
  subtitle: string;
  status: string;
  snapshotUrl: string;
  placeholder?: string;
  streamStatus?: string;
  streamError?: string;
  streamFps?: number;
}

interface PictureInPictureApi {
  getState: () => Promise<PictureInPictureState>;
  open: (input: {
    source: "embedded-browser" | "native-stream" | "snapshot";
    title: string;
    subtitle: string;
    status: string;
    snapshotUrl?: string;
    placeholder?: string;
    nativeTarget?: { kind: "bundle-id" | "path" | "name" | "process-id"; value: string } | null;
    nativeInteraction?: { clickUrl: string; controlUrl: string } | null;
  }) => Promise<PictureInPictureState>;
  update: (input: Partial<Pick<PictureInPictureState, "source" | "title" | "subtitle" | "status" | "snapshotUrl" | "placeholder">> & {
    nativeTarget?: { kind: "bundle-id" | "path" | "name" | "process-id"; value: string } | null;
    nativeInteraction?: { clickUrl: string; controlUrl: string } | null;
  }) => Promise<PictureInPictureState>;
  close: () => Promise<PictureInPictureState>;
  focusMainWindow: () => Promise<PictureInPictureState>;
  onStateChanged: (listener: (state: PictureInPictureState) => void) => () => void;
}

export function UiOperationsView({
  environments
}: {
  environments: BusinessEnvironmentOption[];
}) {
  const [tasks, setTasks] = useState<UiOperationTask[]>([]);
  const [selectedId, setSelectedId] = useState<string>();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [artifacts, setArtifacts] = useState<ArtifactInfo[]>([]);
  const [detailMode, setDetailMode] = useState<"conversation" | "browser" | "observation" | "artifacts">("conversation");
  const [previewArtifact, setPreviewArtifact] = useState<ArtifactInfo>();
  const [conversationPage, setConversationPage] = useState(1);
  const [conversationPageSize, setConversationPageSize] = useState(10);
  const [draft, setDraft] = useState("");
  const [targetKind, setTargetKind] = useState<"browser" | "native-app">(() => IS_DESKTOP_APP ? "native-app" : "browser");
  const [browserKernel, setBrowserKernel] = useState<BrowserKernel>("playwright");
  const [draftExperience, setDraftExperience] = useState<UiOperationExperience>(() => loadOperationExperience());
  const [pictureInPictureState, setPictureInPictureState] = useState<PictureInPictureState>();
  const [nativePictureInPictureFeed, setNativePictureInPictureFeed] = useState<{
    taskId: string;
    runId: string;
    snapshotUrl?: string;
    captureGaps?: string[];
    target?: { kind: "bundle-id" | "path" | "name" | "process-id"; value: string };
  }>();
  const [browserPictureInPictureFeed, setBrowserPictureInPictureFeed] = useState<{
    taskId: string;
    runId: string;
    snapshotUrl?: string;
    sequence?: number;
  }>();
  const [taskGroupCapability, setTaskGroupCapability] = useState<CdpTaskGroupCapability>();
  const [taskGroupSetupBusy, setTaskGroupSetupBusy] = useState(false);
  const [experienceBusy, setExperienceBusy] = useState(false);
  const [businessId, setBusinessId] = useState("");
  const [nativeStatus, setNativeStatus] = useState<NativeAutomationStatus>();
  const [nativeStatusRefreshing, setNativeStatusRefreshing] = useState(false);
  const [loading, setLoading] = useState(true);
  const [creatingConversation, setCreatingConversation] = useState(false);
  const [sending, setSending] = useState(false);
  const [streamingText, setStreamingText] = useState("");
  const [toolEvents, setToolEvents] = useState<string[]>([]);
  const [nativeInspectorOpen, setNativeInspectorOpen] = useState(true);
  const [copiedSessionId, setCopiedSessionId] = useState<string>();
  const [error, setError] = useState<string>();
  const composingNewRef = useRef(false);
  const viewTokenRef = useRef(0);
  const assistantMessageBaselineRef = useRef<Set<string>>(new Set());
  const pictureInPictureWasOpenRef = useRef(false);
  const experienceBusyRef = useRef(false);
  const experienceRef = useRef<UiOperationExperience>(draftExperience);
  const experiencePersistQueueRef = useRef<Promise<void>>(Promise.resolve());
  const nativeStatusRefreshingRef = useRef(false);
  const browserFrameKeyRef = useRef("");
  const messageEndRef = useRef<HTMLDivElement>(null);

  const refreshTasks = useCallback(async () => {
    setLoading(true);
    try {
      const data = await requestJson<UiOperationTask[]>("/api/ui-operations");
      setTasks(data);
      if (!composingNewRef.current) {
        setSelectedId((current) => current && data.some((task) => task.id === current) ? current : data[0]?.id);
      }
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setLoading(false);
    }
  }, []);

  const loadConversation = useCallback(async (sessionId: string | undefined, expectedViewToken = viewTokenRef.current) => {
    if (!sessionId) {
      if (expectedViewToken === viewTokenRef.current) {
        setMessages([]);
        setArtifacts([]);
      }
      return;
    }
    try {
      const session = await requestJson<AgentSession>(`/api/sessions/${encodeURIComponent(sessionId)}`);
      if (expectedViewToken !== viewTokenRef.current) return;
      setMessages(session.messages);
      setArtifacts(session.artifacts || []);
      if (session.lastError && session.status === "failed") {
        const message = cleanAgentError(session.lastError);
        if (isRecoverableAppDiscoveryWarning(message)) {
          setToolEvents((current) => [...current.slice(-5), `WARN ${message}`]);
        } else {
          setError(message);
        }
      }
    } catch (cause) {
      if (expectedViewToken === viewTokenRef.current) setError(errorMessage(cause));
    }
  }, []);

  const refreshNativeStatus = useCallback(async (reportError = true) => {
    if (nativeStatusRefreshingRef.current) return undefined;
    nativeStatusRefreshingRef.current = true;
    setNativeStatusRefreshing(true);
    try {
      const status = await requestJson<NativeAutomationStatus>("/api/native-automation/status");
      setNativeStatus(status);
      return status;
    } catch (cause) {
      if (reportError) setError(errorMessage(cause));
      return undefined;
    } finally {
      nativeStatusRefreshingRef.current = false;
      setNativeStatusRefreshing(false);
    }
  }, []);

  useEffect(() => { void refreshTasks(); }, [refreshTasks]);
  useEffect(() => {
    void refreshNativeStatus();
  }, [refreshNativeStatus]);

  const selected = tasks.find((task) => task.id === selectedId);
  const effectiveTargetKind = selected?.executionTarget.kind ?? targetKind;
  const effectiveBrowserKernel = selected?.executionTarget.kind === "browser"
    ? selected.executionTarget.browserKernel
    : browserKernel;
  const providerId = selected?.executionTarget.kind === "native-app"
    ? selected.executionTarget.providerId
    : nativeProviderForPlatform(nativeStatus?.platform);
  const permissionDenied = effectiveTargetKind === "native-app"
    && nativePermissionDenied(nativeStatus, providerId);
  const selectedSessionId = selected?.conversationSessionId ?? selected?.runs[0]?.sessionId;
  const currentRun = selected?.runs.find((run) => run.status === "running" || run.status === "waiting-approval")
    ?? selected?.runs[0];
  const nativeRun = selected?.executionTarget.kind === "native-app" && currentRun?.nativeSessionId
    ? currentRun
    : undefined;
  const browserRun = selected?.executionTarget.kind === "browser" && currentRun
    ? currentRun
    : undefined;
  const embeddedApi = (window as unknown as { uiwardenDesktop?: { embeddedBrowser: EmbeddedBrowserApi } }).uiwardenDesktop?.embeddedBrowser;
  const pictureInPictureApi = (window as unknown as {
    uiwardenDesktop?: { pictureInPicture?: PictureInPictureApi };
  }).uiwardenDesktop?.pictureInPicture;
  const effectiveExperience = selected?.experience ?? draftExperience;
  experienceRef.current = effectiveExperience;
  const embeddedBrowserSelected = selected?.executionTarget.kind === "browser"
    && selected.executionTarget.browserKernel === "uiwarden-embedded";
  const active = currentRun?.status === "running" || currentRun?.status === "waiting-approval";
  const browserBridgeTaskGroupSupported = effectiveTargetKind === "browser"
    && effectiveBrowserKernel === "external-cdp";
  const browserTaskGroupDisabledReason = active
    ? "当前运行结束后可修改浏览器桥接标签组策略"
    : effectiveTargetKind !== "browser"
      ? "浏览器桥接标签组仅适用于浏览器目标"
      : !browserBridgeTaskGroupSupported
        ? "切换为“用户浏览器桥接”内核后可用"
        : "";
  const nativeBackgroundSupported = effectiveTargetKind === "native-app"
    && providerId === "macos-accessibility";
  const nativeBackgroundDisabledReason = active
    ? "当前运行结束后可修改电脑桌面投递模式"
    : effectiveTargetKind !== "native-app"
      ? "严格后台执行仅适用于电脑桌面目标"
      : providerId !== "macos-accessibility"
        ? "当前仅 macOS Accessibility 支持严格后台执行"
        : "";
  const screenshotArtifacts = artifacts.filter((artifact) => artifact.kind === "file" && /\.(?:png|jpe?g|webp)$/i.test(artifact.name));
  const latestBrowserScreenshot = useMemo(
    () => [...screenshotArtifacts].sort(compareObservationArtifacts).at(-1),
    [screenshotArtifacts]
  );
  const pictureInPictureEnabled = IS_DESKTOP_APP
    && effectiveExperience.presentationMode === "picture-in-picture";
  const nativeContinuousPictureInPicture = effectiveTargetKind === "native-app"
    && providerId === "macos-accessibility"
    && Boolean(nativeRun && active);
  const pictureInPictureSource = embeddedBrowserSelected
    ? "embedded-browser"
    : nativeContinuousPictureInPicture
      ? "native-stream"
      : "snapshot";
  const artifactPictureInPictureSnapshotUrl = selectedSessionId && latestBrowserScreenshot
    ? new URL(artifactPreviewHref(selectedSessionId, latestBrowserScreenshot), window.location.origin).toString()
    : "";
  const pictureInPictureSnapshotUrl = nativeRun
    ? nativePictureInPictureFeed?.taskId === selected?.id
      && nativePictureInPictureFeed?.runId === nativeRun.id
      ? nativePictureInPictureFeed.snapshotUrl || ""
      : ""
    : browserRun
      && browserPictureInPictureFeed?.taskId === selected?.id
      && browserPictureInPictureFeed?.runId === browserRun.id
      ? browserPictureInPictureFeed.snapshotUrl || artifactPictureInPictureSnapshotUrl
      : artifactPictureInPictureSnapshotUrl;
  const pictureInPictureNativeTarget = nativeRun
    && nativePictureInPictureFeed?.taskId === selected?.id
    && nativePictureInPictureFeed?.runId === nativeRun.id
      ? nativePictureInPictureFeed.target
      : undefined;
  const pictureInPictureNativeInteraction = nativeRun && active
    ? {
        clickUrl: new URL(
          `/api/ui-operations/${encodeURIComponent(selected!.id)}/runs/${encodeURIComponent(nativeRun.id)}/native/pip-click`,
          window.location.origin
        ).toString(),
        controlUrl: new URL(
          `/api/ui-operations/${encodeURIComponent(selected!.id)}/runs/${encodeURIComponent(nativeRun.id)}/native/control`,
          window.location.origin
        ).toString()
      }
    : undefined;
  const nativeScreenCaptureDenied = nativePictureInPictureFeed?.captureGaps?.includes(
    "screen-recording-permission-denied"
  ) === true;
  const pictureInPictureSubtitle = pictureInPictureSource === "embedded-browser"
    ? "实时浏览器 · 可交互"
    : pictureInPictureSource === "native-stream"
      ? nativeScreenCaptureDenied
        ? "屏幕录制未授权 · 操作仍在执行"
        : effectiveExperience.nativeDeliveryMode === "background-safe"
          ? "后台窗口 · 不抢焦点 · 真实窗口可见"
          : "实时窗口 · 可交互"
    : effectiveTargetKind === "native-app"
      ? "电脑桌面 · 只读镜像"
      : "浏览器画面 · 只读镜像";
  const pictureInPicturePlaceholder = nativeScreenCaptureDenied
    ? "请在系统设置中允许 UIWarden 屏幕录制；任务仍在后台执行"
    : pictureInPictureSource === "native-stream"
      ? "正在连接目标应用窗口"
      : "等待执行画面";
  const conversationPages = Math.max(1, Math.ceil(tasks.length / conversationPageSize));
  const visibleConversationPage = Math.min(conversationPage, conversationPages);
  const visibleTasks = tasks.slice(
    (visibleConversationPage - 1) * conversationPageSize,
    visibleConversationPage * conversationPageSize
  );
  const visibleMessages = sending
    ? messages.filter((message) => message.role !== "assistant" || assistantMessageBaselineRef.current.has(message.id))
    : messages;

  useEffect(() => {
    if (conversationPage > conversationPages) setConversationPage(conversationPages);
  }, [conversationPage, conversationPages]);

  useEffect(() => {
    setTaskGroupCapability(undefined);
  }, [effectiveBrowserKernel, effectiveTargetKind]);

  const switchDetailMode = useCallback(async (mode: "conversation" | "browser" | "observation" | "artifacts") => {
    if ((mode === "observation" || mode === "artifacts") && embeddedApi) {
      try {
        await embeddedApi.setVisible(false);
      } catch (cause) {
        setError(errorMessage(cause));
      }
    }
    setDetailMode(mode);
  }, [embeddedApi]);

  useEffect(() => { void loadConversation(selectedSessionId); }, [loadConversation, selectedSessionId]);
  useEffect(() => {
    if (!pictureInPictureApi) return;
    void pictureInPictureApi.getState().then(setPictureInPictureState).catch((cause) => setError(errorMessage(cause)));
    return pictureInPictureApi.onStateChanged(setPictureInPictureState);
  }, [pictureInPictureApi]);
  useEffect(() => {
    if (!pictureInPictureApi) return;
    if (!pictureInPictureEnabled || !selected) {
      void pictureInPictureApi.close().catch((cause) => setError(errorMessage(cause)));
      return;
    }
    void pictureInPictureApi.open({
      source: pictureInPictureSource,
      title: selected.name || "UI 操作",
      subtitle: pictureInPictureSubtitle,
      status: currentRun?.status || "idle",
      snapshotUrl: pictureInPictureSnapshotUrl,
      placeholder: pictureInPicturePlaceholder,
      nativeTarget: pictureInPictureNativeTarget || null,
      nativeInteraction: pictureInPictureNativeInteraction || null
    }).then(setPictureInPictureState).catch((cause) => setError(errorMessage(cause)));
  }, [
    pictureInPictureApi,
    pictureInPictureEnabled,
    pictureInPictureSource,
    pictureInPictureSnapshotUrl,
    pictureInPictureSubtitle,
    pictureInPicturePlaceholder,
    pictureInPictureNativeInteraction?.clickUrl,
    pictureInPictureNativeTarget?.kind,
    pictureInPictureNativeTarget?.value,
    selected?.id,
    selected?.name,
  ]);
  useEffect(() => {
    if (!pictureInPictureApi || !pictureInPictureEnabled || !selected) return;
    void pictureInPictureApi.update({
      source: pictureInPictureSource,
      title: selected.name || "UI 操作",
      subtitle: pictureInPictureSubtitle,
      status: currentRun?.status || "idle",
      snapshotUrl: pictureInPictureSnapshotUrl,
      placeholder: pictureInPicturePlaceholder,
      nativeTarget: pictureInPictureNativeTarget || null,
      nativeInteraction: pictureInPictureNativeInteraction || null
    }).then(setPictureInPictureState).catch((cause) => setError(errorMessage(cause)));
  }, [
    currentRun?.status,
    pictureInPictureApi,
    pictureInPictureEnabled,
    pictureInPictureSnapshotUrl,
    pictureInPictureNativeInteraction?.clickUrl,
    pictureInPictureNativeTarget?.kind,
    pictureInPictureNativeTarget?.value,
    pictureInPictureSource,
    pictureInPictureSubtitle,
    pictureInPicturePlaceholder,
    selected?.id,
    selected?.name,
  ]);
  useEffect(() => {
    if (
      !pictureInPictureEnabled
      || !selected
      || selected.executionTarget.kind !== "native-app"
      || !nativeRun?.nativeSessionId
    ) {
      setNativePictureInPictureFeed(undefined);
      return;
    }
    let cancelled = false;
    const refresh = async () => {
      try {
        const state = await requestJson<{
          session: {
            app: { kind: "bundle-id" | "path" | "name" | "process-id"; value: string };
            captureGaps?: string[];
          };
          snapshot?: {
            sequence: number;
            screenshotPath?: string;
            app?: { processId?: number };
            captureGaps?: string[];
          };
        }>(
          `/api/ui-operations/${encodeURIComponent(selected.id)}/runs/${encodeURIComponent(nativeRun.id)}/native`
        );
        if (cancelled) return;
        const target = state.snapshot?.app?.processId
          ? { kind: "process-id" as const, value: String(state.snapshot.app.processId) }
          : state.session.app.value && state.session.app.value !== "__agent_selected__"
            ? state.session.app
            : undefined;
        setNativePictureInPictureFeed({
          taskId: selected.id,
          runId: nativeRun.id,
          target,
          captureGaps: state.snapshot?.captureGaps ?? state.session.captureGaps ?? [],
          snapshotUrl: state.snapshot?.screenshotPath
            ? new URL(
                `/api/ui-operations/${encodeURIComponent(selected.id)}/runs/${encodeURIComponent(nativeRun.id)}/native/screenshot?v=${encodeURIComponent(state.snapshot.sequence)}`,
                window.location.origin
              ).toString()
            : undefined
        });
      } catch {
        // The agent may not have selected an application or captured its first frame yet.
      }
    };
    void refresh();
    if (!active) return () => { cancelled = true; };
    const timer = window.setInterval(() => void refresh(), 1200);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [
    active,
    nativeRun?.id,
    nativeRun?.nativeSessionId,
    pictureInPictureEnabled,
    selected?.id,
    selected?.executionTarget.kind,
  ]);
  useEffect(() => {
    if (!selected || selected.executionTarget.kind !== "browser" || !browserRun) {
      setBrowserPictureInPictureFeed(undefined);
      browserFrameKeyRef.current = "";
      return;
    }
    let cancelled = false;
    const refresh = async () => {
      try {
        const state = await requestJson<{
          snapshots: Array<{ sequence: number; capturedAt: string }>;
        }>(
          `/api/ui-operations/${encodeURIComponent(selected.id)}/runs/${encodeURIComponent(browserRun.id)}/browser`
        );
        if (cancelled) return;
        const latest = state.snapshots.at(-1);
        const frameKey = latest ? `${selected.id}/${browserRun.id}/${latest.sequence}` : "";
        if (frameKey === browserFrameKeyRef.current) return;
        browserFrameKeyRef.current = frameKey;
        setBrowserPictureInPictureFeed({
          taskId: selected.id,
          runId: browserRun.id,
          sequence: latest?.sequence,
          snapshotUrl: latest
            ? new URL(
                `/api/ui-operations/${encodeURIComponent(selected.id)}/runs/${encodeURIComponent(browserRun.id)}/browser/screenshot?sequence=${encodeURIComponent(latest.sequence)}&v=${encodeURIComponent(latest.capturedAt)}`,
                window.location.origin
              ).toString()
            : undefined
        });
        if (latest && selectedSessionId) {
          const nextArtifacts = await requestJson<ArtifactInfo[]>(
            `/api/sessions/${encodeURIComponent(selectedSessionId)}/artifacts`
          );
          if (!cancelled) setArtifacts(nextArtifacts);
        }
      } catch {
        // Browser Automation may still be connecting or waiting for its first observe.
      }
    };
    void refresh();
    if (!active) return () => { cancelled = true; };
    const timer = window.setInterval(() => void refresh(), 1200);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [
    active,
    browserRun?.id,
    selected?.id,
    selected?.executionTarget.kind,
    selectedSessionId
  ]);
  useEffect(() => () => {
    void pictureInPictureApi?.close();
  }, [pictureInPictureApi]);
  useEffect(() => {
    if (!tasks.some((task) => task.runs.some(
      (run) => run.status === "running" || run.status === "waiting-approval"
    ))) return;
    const timer = window.setInterval(() => {
      void refreshTasks();
      if (selectedSessionId && !sending) void loadConversation(selectedSessionId);
    }, 2000);
    return () => window.clearInterval(timer);
  }, [loadConversation, refreshTasks, selectedSessionId, sending, tasks]);
  useEffect(() => {
    if (!permissionDenied) return;
    const refreshPermission = () => {
      void refreshNativeStatus(false);
    };
    const refreshWhenVisible = () => {
      if (document.visibilityState === "visible") refreshPermission();
    };
    window.addEventListener("focus", refreshPermission);
    document.addEventListener("visibilitychange", refreshWhenVisible);
    const timer = window.setInterval(refreshPermission, 2000);
    return () => {
      window.removeEventListener("focus", refreshPermission);
      document.removeEventListener("visibilitychange", refreshWhenVisible);
      window.clearInterval(timer);
    };
  }, [permissionDenied, refreshNativeStatus]);
  useEffect(() => {
    messageEndRef.current?.scrollIntoView({ block: "end" });
  }, [messages, streamingText, toolEvents]);

  const beginConversation = async () => {
    if (creatingConversation) return;
    viewTokenRef.current += 1;
    composingNewRef.current = true;
    setError(undefined);
    setCreatingConversation(true);
    const nextTargetKind = IS_DESKTOP_APP ? "native-app" : "browser";
    const nextProviderId = nativeProviderForPlatform(nativeStatus?.platform);
    const executionTarget: UiOperationExecutionTarget = nextTargetKind === "native-app"
      ? {
          kind: "native-app",
          providerId: nextProviderId,
          app: { kind: "name", value: "__agent_select__" },
          displayName: "Agent 自动选择"
        }
      : { kind: "browser", browserKernel: "playwright" };
    const conversationExperience: UiOperationExperience = {
      ...draftExperience,
      presentationMode: "inline",
      browserTaskGroupMode: "off"
    };
    try {
      const task = await requestJson<UiOperationTask>("/api/ui-operations/conversations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          businessId,
          executionTarget,
          experience: conversationExperience,
          approvalMode: "none"
        })
      });
      setTasks((current) => [task, ...current.filter((item) => item.id !== task.id)]);
      setConversationPage(1);
      setTargetKind(nextTargetKind);
      setBrowserKernel("playwright");
      setMessages([]);
      setArtifacts([]);
      setDraft("");
      setSending(false);
      setStreamingText("");
      setToolEvents([]);
      setCopiedSessionId(undefined);
      setSelectedId(task.id);
      setDraftExperience(conversationExperience);
      saveOperationExperience(conversationExperience);
      setDetailMode("conversation");
      setNativeInspectorOpen(true);
      void embeddedApi?.setVisible(false);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      composingNewRef.current = false;
      setCreatingConversation(false);
    }
  };

  const selectConversation = (task: UiOperationTask) => {
    viewTokenRef.current += 1;
    composingNewRef.current = false;
    setSelectedId(task.id);
    setStreamingText("");
    setToolEvents([]);
    if (task.executionTarget.kind !== "browser" || task.executionTarget.browserKernel !== "uiwarden-embedded") {
      void embeddedApi?.setVisible(false);
    }
    setDetailMode("conversation");
    setError(undefined);
    setSending(false);
    setCopiedSessionId(undefined);
    setBusinessId(task.businessId || "");
    setTargetKind(task.executionTarget.kind);
    if (task.executionTarget.kind === "browser") setBrowserKernel(task.executionTarget.browserKernel);
    setNativeInspectorOpen(true);
  };

  const copyConversationSessionId = async (sessionId: string) => {
    try {
      await navigator.clipboard.writeText(sessionId);
    } catch {
      window.prompt("手动复制会话 ID：", sessionId);
      return;
    }
    setCopiedSessionId(sessionId);
    window.setTimeout(() => setCopiedSessionId((current) => current === sessionId ? undefined : current), 1500);
  };

  const updateDraftExecutionTarget = async (executionTarget: UiOperationExecutionTarget) => {
    if (executionTarget.kind === "browser") {
      setTargetKind("browser");
      setBrowserKernel(executionTarget.browserKernel);
    } else {
      setTargetKind("native-app");
    }
    if (!selected?.isDraft) return;
    const optimistic = { ...selected, executionTarget, browserKernel: executionTarget.kind === "browser" ? executionTarget.browserKernel : selected.browserKernel };
    setTasks((current) => current.map((task) => task.id === selected.id ? optimistic : task));
    try {
      const updated = await requestJson<UiOperationTask>(`/api/ui-operations/${encodeURIComponent(selected.id)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: selected.name,
          instruction: selected.instruction,
          businessId,
          executionTarget,
          approvalMode: selected.approvalMode,
          isDraft: true
        })
      });
      setTasks((current) => current.map((task) => task.id === updated.id ? updated : task));
    } catch (cause) {
      setError(errorMessage(cause));
      await refreshTasks();
    }
  };

  const updateExperience = async (patch: Partial<UiOperationExperience>) => {
    const next = { ...experienceRef.current, ...patch };
    experienceRef.current = next;
    setDraftExperience(next);
    saveOperationExperience(next);
    if (!selected) return;
    setTasks((current) => current.map((task) => task.id === selected.id ? { ...task, experience: next } : task));
    const taskId = selected.id;
    const persist = async () => {
      try {
        const updated = await requestJson<UiOperationTask>(`/api/ui-operations/${encodeURIComponent(taskId)}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ experience: next })
        });
        setTasks((current) => current.map((task) => task.id === updated.id ? updated : task));
      } catch (cause) {
        setError(errorMessage(cause));
        await refreshTasks();
      }
    };
    const queued = experiencePersistQueueRef.current.catch(() => undefined).then(persist);
    experiencePersistQueueRef.current = queued;
    await queued;
  };

  useEffect(() => {
    if (
      browserBridgeTaskGroupSupported
      || effectiveExperience.browserTaskGroupMode !== "user-browser"
    ) return;
    void updateExperience({ browserTaskGroupMode: "off" });
  }, [browserBridgeTaskGroupSupported, effectiveExperience.browserTaskGroupMode]);

  const togglePictureInPicture = async () => {
    if (experienceBusyRef.current) return;
    experienceBusyRef.current = true;
    setExperienceBusy(true);
    try {
      await updateExperience({
        presentationMode: pictureInPictureEnabled ? "inline" : "picture-in-picture"
      });
    } finally {
      experienceBusyRef.current = false;
      setExperienceBusy(false);
    }
  };

  useEffect(() => {
    const sync = reconcilePictureInPictureClose({
      enabled: pictureInPictureEnabled,
      open: Boolean(pictureInPictureState?.open),
      wasOpen: pictureInPictureWasOpenRef.current,
      closeReason: pictureInPictureState?.closeReason,
    });
    pictureInPictureWasOpenRef.current = sync.nextWasOpen;
    if (sync.disablePresentation) void updateExperience({ presentationMode: "inline" });
  }, [
    pictureInPictureEnabled,
    pictureInPictureState?.closeReason,
    pictureInPictureState?.open,
  ]);

  const toggleBrowserTaskGroup = async () => {
    if (!browserBridgeTaskGroupSupported) return;
    const enabled = effectiveExperience.browserTaskGroupMode === "user-browser";
    if (enabled) {
      await updateExperience({ browserTaskGroupMode: "off" });
      return;
    }
    try {
      const capability = await requestJson<CdpTaskGroupCapability>("/api/cdp/task-groups/capability");
      setTaskGroupCapability(capability);
      if (!capability.available) return;
      await updateExperience({ browserTaskGroupMode: "user-browser" });
      setError(undefined);
    } catch (cause) {
      setError(errorMessage(cause));
    }
  };

  const toggleNativeBackground = async () => {
    if (!nativeBackgroundSupported || active || experienceBusyRef.current) return;
    experienceBusyRef.current = true;
    setExperienceBusy(true);
    try {
      await updateExperience({
        nativeDeliveryMode: effectiveExperience.nativeDeliveryMode === "background-safe"
          ? "foreground-compatible"
          : "background-safe"
      });
    } finally {
      experienceBusyRef.current = false;
      setExperienceBusy(false);
    }
  };

  const openBrowserTaskGroupSetup = async () => {
    setTaskGroupSetupBusy(true);
    try {
      const setup = await requestJson<CdpTaskGroupSetup>("/api/cdp/task-groups/setup", { method: "POST" });
      setTaskGroupCapability((current) => current ? { ...current, reason: setup.instruction } : current);
      setError(undefined);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setTaskGroupSetupBusy(false);
    }
  };

  const sendMessage = async () => {
    const text = draft.trim();
    if (!text || sending || active) return;
    setDraft("");
    setSending(true);
    assistantMessageBaselineRef.current = new Set(
      messages.filter((message) => message.role === "assistant").map((message) => message.id)
    );
    setStreamingText("");
    setToolEvents([]);
    setError(undefined);
    const viewToken = viewTokenRef.current;
    const isCurrentView = () => viewTokenRef.current === viewToken;
    const optimistic: ChatMessage = {
      id: `optimistic-${Date.now()}`,
      role: "user",
      content: text,
      createdAt: new Date().toISOString()
    };
    setMessages((current) => [...current, optimistic]);

    let operationTaskId = selected?.id;
    let operationSessionId = selectedSessionId;
    const executionTarget: UiOperationExecutionTarget = effectiveTargetKind === "native-app"
      ? {
          kind: "native-app",
          providerId,
          app: { kind: "name", value: "__agent_select__" },
          displayName: "Agent 自动选择"
        }
      : { kind: "browser", browserKernel: effectiveBrowserKernel };
    const url = selected
      ? `/api/ui-operations/${encodeURIComponent(selected.id)}/messages`
      : "/api/ui-operations/messages";
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: text,
          businessId,
          executionTarget,
          experience: effectiveExperience,
          approvalMode: "none"
        })
      });
      if (!response.ok || !response.body) throw new Error(await response.text());
      await readSse(response.body, (payload) => {
        if (payload.type === "session") {
          const data = payload.data as { operationTaskId?: string; sessionId?: string };
          operationTaskId = data.operationTaskId || operationTaskId;
          operationSessionId = data.sessionId || operationSessionId;
          if (operationTaskId && isCurrentView()) {
            composingNewRef.current = false;
            setSelectedId(operationTaskId);
            void refreshTasks();
          }
        } else if (payload.type === "message") {
          if (!isCurrentView()) return;
          const message = payload.data as ChatMessage;
          setMessages((current) => [...current.filter((item) => item.id !== optimistic.id && item.id !== message.id), message]);
        } else if (payload.type === "text") {
          if (!isCurrentView()) return;
          setStreamingText((current) => current + String(payload.data ?? ""));
        } else if (payload.type === "tool") {
          if (!isCurrentView()) return;
          const tool = payload.data as { phase?: string; name?: string };
          const phase = tool.phase;
          if (phase === "start" || phase === "stop") {
            setToolEvents((current) => mergeToolEvent(current, phase, tool.name || "工具"));
          }
        } else if (payload.type === "status") {
          if (!isCurrentView()) return;
          const status = payload.data as { label?: string };
          const label = status.label;
          if (label) {
            setToolEvents((current) => mergeStatusEvent(current, label));
          }
        } else if (payload.type === "error") {
          if (!isCurrentView()) return;
          const message = cleanAgentError(String(payload.data ?? "执行失败"));
          if (isRecoverableAppDiscoveryWarning(message)) {
            setToolEvents((current) => [...current.slice(-7), `WARN ${message}`]);
          } else {
            setError(message);
          }
        } else if (payload.type === "artifacts" && isCurrentView()) {
          setArtifacts(payload.data as ArtifactInfo[]);
        }
      });
      await refreshTasks();
      if (isCurrentView()) {
        await loadConversation(operationSessionId, viewToken);
        if (operationTaskId) setSelectedId(operationTaskId);
      }
    } catch (cause) {
      if (isCurrentView()) setError(errorMessage(cause));
    } finally {
      if (isCurrentView()) {
        setStreamingText("");
        setSending(false);
      }
    }
  };

  const mutateRun = async (path: string) => {
    try {
      await requestJson(path, { method: "POST" });
      await refreshTasks();
      await loadConversation(selectedSessionId);
    } catch (cause) {
      setError(errorMessage(cause));
    }
  };

  const openNativePermissionSettings = async () => {
    try {
      await requestJson("/api/native-automation/permissions/open", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ permission: "accessibility" })
      });
      window.setTimeout(() => void refreshNativeStatus(false), 1000);
    } catch (cause) {
      setError(errorMessage(cause));
    }
  };

  const deleteConversation = async (task = selected) => {
    if (!task) return;
    if (task.runs.some((run) => run.status === "running" || run.status === "waiting-approval")) {
      setError("运行中的操作对话不能删除");
      return;
    }
    try {
      await requestJson(`/api/ui-operations/${encodeURIComponent(task.id)}`, { method: "DELETE" });
      if (selectedId === task.id) {
        viewTokenRef.current += 1;
        setSelectedId(undefined);
        setMessages([]);
        setArtifacts([]);
      }
      await refreshTasks();
    } catch (cause) {
      setError(errorMessage(cause));
    }
  };

  return (
    <main className="qualityWorkspace operationChatWorkspace">
      <header className="qualityHeader operationPageHeader">
        <div><h1>UI 操作</h1><p>{selected ? selected.name : "新对话"}</p></div>
        <div className="qualityHeaderActions">
          <button type="button" className="qualitySecondaryButton" disabled={loading} onClick={() => void refreshTasks()}><RefreshCw size={14} />刷新</button>
          <button type="button" className="qualityPrimaryButton" disabled={creatingConversation} onClick={() => void beginConversation()}>{creatingConversation ? <Loader2 className="spin" size={14} /> : <Plus size={14} />}新对话</button>
        </div>
      </header>
      {error && <div className="qualityBanner qualityBannerError operationError"><AlertTriangle size={15} /><span>{error}</span><button type="button" title="关闭" onClick={() => setError(undefined)}><X size={13} /></button></div>}
      <section className="operationChatLayout">
        <aside className="operationList operationConversationList">
          <div className="qualitySectionHeading"><div><strong>操作对话</strong><span>{tasks.length}</span></div></div>
          <div className="operationConversationItems">
          {visibleTasks.map((task) => (
            <div key={task.id} data-task-id={task.id} className={`operationConversationItem${task.id === selectedId ? " active" : ""}`}>
              <button type="button" className="operationConversationSelect" title={task.name} onClick={() => selectConversation(task)}>
                {task.executionTarget.kind === "native-app" ? <Monitor size={15} /> : <Globe2 size={15} />}
                <span><strong>{task.name}</strong><em>{formatConversationTime(task.updatedAt)} · {operationTargetLabel(task)}</em></span>
                <OperationStatus status={task.runs[0]?.status ?? "idle"} />
              </button>
              <span className="operationConversationActions">
                <button
                  type="button"
                  className="operationConversationCopy"
                  disabled={!task.conversationSessionId}
                  title={task.conversationSessionId ? `复制会话 ID：${task.conversationSessionId}` : "会话 ID 尚未生成"}
                  onClick={() => task.conversationSessionId && void copyConversationSessionId(task.conversationSessionId)}
                >{copiedSessionId === task.conversationSessionId ? <Check size={12} /> : <Copy size={12} />}</button>
                <button
                  type="button"
                  className="operationConversationDelete"
                  disabled={task.runs.some((run) => run.status === "running" || run.status === "waiting-approval")}
                  title="删除操作对话"
                  onClick={() => void deleteConversation(task)}
                ><Trash2 size={12} /></button>
              </span>
            </div>
          ))}
          </div>
          {!tasks.length && !loading && <div className="qualityEmpty">暂无操作对话</div>}
          {tasks.length > 0 && (
            <div className="operationConversationPagination">
              <button type="button" disabled={visibleConversationPage <= 1} onClick={() => setConversationPage((page) => Math.max(1, page - 1))}><ArrowLeft size={12} /></button>
              <span>{visibleConversationPage} / {conversationPages}</span>
              <button type="button" disabled={visibleConversationPage >= conversationPages} onClick={() => setConversationPage((page) => Math.min(conversationPages, page + 1))}><ArrowRight size={12} /></button>
              <select value={conversationPageSize} aria-label="每页对话数" onChange={(event) => { setConversationPageSize(Number(event.target.value)); setConversationPage(1); }}>
                <option value={10}>10 条</option><option value={30}>30 条</option><option value={50}>50 条</option>
              </select>
            </div>
          )}
        </aside>

        <div className="operationConversation">
          <header className="operationConversationHeader">
            <div className="operationConversationTitle">
              {selected?.executionTarget.kind === "native-app" ? <Monitor size={16} /> : <MessageSquare size={16} />}
              <span><strong>{selected?.name || "新 UI 操作"}</strong><em>{selected ? operationTargetLabel(selected) : targetKind === "native-app" ? `电脑桌面 · ${nativeProviderLabel(providerId)}` : kernelLabel(browserKernel)}</em></span>
              {selectedSessionId && (
                <button
                  className="session-id-chip operationSessionIdChip"
                  type="button"
                  title={`复制会话 ID（用于问题排查）：${selectedSessionId}`}
                  onClick={() => void copyConversationSessionId(selectedSessionId)}
                >
                  {copiedSessionId === selectedSessionId ? <Check size={12} /> : <Copy size={12} />}
                  <code>{selectedSessionId}</code>
                </button>
              )}
              {currentRun && <OperationStatus status={currentRun.status} />}
            </div>
            <div className="qualityHeaderActions">
              {currentRun?.status === "waiting-approval" && <button type="button" className="qualityPrimaryButton" onClick={() => void mutateRun(`/api/ui-operations/${selected!.id}/runs/${currentRun.id}/approve`)}><Check size={13} />批准继续</button>}
              {active && <button type="button" className="qualityDangerButton" onClick={() => void mutateRun(`/api/ui-operations/${selected!.id}/runs/${currentRun!.id}/abort`)}><Square size={12} />停止</button>}
              {selectedSessionId && <button type="button" className="qualitySecondaryButton" onClick={() => void switchDetailMode("artifacts")}><FolderOpen size={13} />产物</button>}
              {selected && <button type="button" className="qualityDangerButton" disabled={active} title="删除对话" onClick={() => void deleteConversation()}><Trash2 size={13} /></button>}
            </div>
          </header>

          {(!selected || selected.isDraft) && (
            <div className="operationModeBar">
              <div className="operationTargetField">
                <span>执行目标</span>
                <div className="operationTargetSwitch" role="tablist" aria-label="执行目标">
                  <button type="button" className={effectiveTargetKind === "browser" ? "active" : ""} onClick={() => void updateDraftExecutionTarget({ kind: "browser", browserKernel: "playwright" })}><Globe2 size={14} />浏览器</button>
                  <button type="button" className={effectiveTargetKind === "native-app" ? "active" : ""} onClick={() => void updateDraftExecutionTarget({ kind: "native-app", providerId: nativeProviderForPlatform(nativeStatus?.platform), app: { kind: "name", value: "__agent_select__" }, displayName: "Agent 自动选择" })}><Monitor size={14} />电脑桌面</button>
                </div>
              </div>
              {effectiveTargetKind === "browser" ? (
                <label className="operationKernelField"><span>浏览器模式</span><select value={effectiveBrowserKernel} onChange={(event) => void updateDraftExecutionTarget({ kind: "browser", browserKernel: event.target.value as BrowserKernel })}><option value="playwright">Playwright 配套 Chromium（默认）</option><option value="uiwarden-embedded">{IS_DESKTOP_APP ? "客户端内置 gui-browser" : "服务端托管 gui-browser"}</option>{IS_DESKTOP_APP && <option value="external-cdp">用户浏览器桥接</option>}</select><em>{kernelDescription(effectiveBrowserKernel)}</em></label>
              ) : <div className="operationAutoTargetField"><span>目标应用</span><div className="operationAutoTarget"><AppWindow size={14} /><span><strong>Agent 自动选择应用</strong><em>{nativeProviderLabel(providerId)}</em></span></div></div>}
              <label><span>业务环境</span><select value={businessId} onChange={(event) => setBusinessId(event.target.value)}><option value="">默认环境</option>{environments.map((environment) => <option key={environment.id} value={environment.id}>{environment.name}</option>)}</select></label>
            </div>
          )}

          {IS_DESKTOP_APP && (
            <div className="operationExperienceBar" aria-label="执行体验">
              <span className="operationExperienceLabel">执行体验</span>
              <button
                type="button"
                role="switch"
                aria-checked={pictureInPictureEnabled}
                disabled={experienceBusy}
                className={pictureInPictureEnabled ? "active" : ""}
                onClick={() => void togglePictureInPicture()}
              >
                <PictureInPicture2 size={14} />
                <span>
                  <strong>画中画</strong>
                  <em>
                    {pictureInPictureSource === "embedded-browser"
                      ? "实时可交互"
                      : pictureInPictureSource === "native-stream"
                        ? "实时窗口"
                        : "只读镜像"}
                  </em>
                </span>
                <i><b /></i>
              </button>
              <button
                type="button"
                role="switch"
                aria-checked={nativeBackgroundSupported && effectiveExperience.nativeDeliveryMode === "background-safe"}
                disabled={Boolean(active) || experienceBusy || !nativeBackgroundSupported}
                className={nativeBackgroundSupported && effectiveExperience.nativeDeliveryMode === "background-safe" ? "active" : ""}
                title={nativeBackgroundDisabledReason || "使用 AX 语义动作和目标 PID 定向事件，禁止激活应用、移动系统鼠标或占用剪贴板"}
                onClick={() => void toggleNativeBackground()}
              >
                <ShieldCheck size={14} />
                <span>
                  <strong>后台执行</strong>
                  <em>{nativeBackgroundSupported ? "不抢焦点 · 窗口可见" : "仅 macOS Computer"}</em>
                </span>
                <i><b /></i>
              </button>
              <button
                type="button"
                role="switch"
                aria-checked={browserBridgeTaskGroupSupported && effectiveExperience.browserTaskGroupMode === "user-browser"}
                disabled={Boolean(active) || experienceBusy || !browserBridgeTaskGroupSupported}
                className={browserBridgeTaskGroupSupported && effectiveExperience.browserTaskGroupMode === "user-browser" ? "active" : ""}
                title={browserTaskGroupDisabledReason || "通过 UIWarden Browser Bridge 为每次运行新建独立标签组"}
                onClick={() => void toggleBrowserTaskGroup()}
              >
                <PanelsTopLeft size={14} />
                <span><strong>浏览器桥接标签组</strong><em>{browserBridgeTaskGroupSupported ? "用户 Chromium" : "需用户浏览器桥接"}</em></span>
                <i><b /></i>
              </button>
              {pictureInPictureEnabled && (
                <span className={`operationPictureInPictureStatus${pictureInPictureState?.open ? " active" : ""}`}>
                  {pictureInPictureState?.open ? "小窗已显示" : "等待打开小窗"}
                </span>
              )}
              {browserBridgeTaskGroupSupported
                && taskGroupCapability
                && !taskGroupCapability.available
                && (
                  <span className="operationTaskGroupSetup">
                    <em title={taskGroupCapability.reason}>{taskGroupCapability.reason}</em>
                    {taskGroupCapability.setupRequired && (
                      <button type="button" disabled={taskGroupSetupBusy || Boolean(active)} onClick={() => void openBrowserTaskGroupSetup()}>
                        {taskGroupSetupBusy ? <Loader2 size={11} className="spin" /> : <FolderOpen size={11} />}
                        安装引导
                      </button>
                    )}
                    <button type="button" disabled={taskGroupSetupBusy || Boolean(active)} onClick={() => void toggleBrowserTaskGroup()}>
                      <RefreshCw size={11} />检测并启用
                    </button>
                  </span>
                )}
            </div>
          )}

          {effectiveTargetKind === "browser" && effectiveBrowserKernel === "external-cdp" && (
            <OperationCdpControlPanel
              taskRunning={Boolean(active)}
              onError={setError}
              onUseEmbedded={!selected || selected.isDraft ? () => void updateDraftExecutionTarget({ kind: "browser", browserKernel: "uiwarden-embedded" }) : undefined}
            />
          )}

          {selected && (
            <div className="operationWorkspaceTabs" role="tablist" aria-label="UI 操作工作区">
              <button type="button" className={detailMode === "conversation" ? "active" : ""} onClick={() => void switchDetailMode("conversation")}><MessageSquare size={13} />对话</button>
              {embeddedBrowserSelected && <button type="button" className={detailMode === "browser" ? "active" : ""} onClick={() => void switchDetailMode("browser")}><Globe2 size={13} />浏览器</button>}
              <button type="button" className={detailMode === "observation" ? "active" : ""} onClick={() => void switchDetailMode("observation")}><Image size={13} />执行观察{Boolean(screenshotArtifacts.length) && <span>{screenshotArtifacts.length}</span>}</button>
              <button type="button" className={detailMode === "artifacts" ? "active" : ""} onClick={() => void switchDetailMode("artifacts")}><Download size={13} />产物与诊断{Boolean(artifacts.length) && <span>{artifacts.filter((artifact) => artifact.kind === "file").length}</span>}</button>
              {nativeRun && detailMode === "conversation" && (
                <button type="button" className="operationInspectorToggle" title={nativeInspectorOpen ? "收起原生控制" : "展开原生控制"} onClick={() => setNativeInspectorOpen((open) => !open)}>
                  {nativeInspectorOpen ? <PanelRightClose size={13} /> : <PanelRightOpen size={13} />}
                  {nativeInspectorOpen ? "收起原生控制" : "展开原生控制"}
                </button>
              )}
            </div>
          )}

          {permissionDenied && (
            <div className="qualityBanner qualityBannerWarn operationPermission">
              <AlertTriangle size={14} />
              <span>电脑桌面权限未授权</span>
              <button type="button" disabled={nativeStatusRefreshing} onClick={() => void refreshNativeStatus()}>
                {nativeStatusRefreshing ? <Loader2 className="spin" size={13} /> : <RefreshCw size={13} />}
                重新检测
              </button>
              <button type="button" onClick={() => void openNativePermissionSettings()}><Settings size={13} />打开设置</button>
            </div>
          )}

          {detailMode === "conversation" && <div className={`operationConversationBody${(nativeRun && nativeInspectorOpen) || embeddedBrowserSelected ? " withInspector" : ""}`}>
            <section className="operationMessages" aria-live="polite">
              {currentRun?.browserTaskGroup?.status === "created" && (
                <div className="qualityBanner qualityBannerOk">
                  <PanelsTopLeft size={14} />
                  <span>浏览器桥接标签组已由 UIWarden 创建：{currentRun.browserTaskGroup.title || currentRun.browserTaskGroup.groupId}</span>
                </div>
              )}
              {currentRun?.browserTaskGroup?.status === "failed" && (
                <div className="qualityBanner qualityBannerWarn">
                  <AlertTriangle size={14} />
                  <span>浏览器桥接标签组创建失败：{currentRun.browserTaskGroup.error || "未知错误"}</span>
                </div>
              )}
              {!messages.length && !streamingText && <div className="operationChatEmpty"><Bot size={28} /><strong>发送第一条操作指令</strong></div>}
              {visibleMessages.map((message) => <OperationMessage key={message.id} message={message} />)}
              {streamingText && <OperationMessage message={{ id: "stream", role: "assistant", content: streamingText, createdAt: new Date().toISOString() }} streaming />}
              {toolEvents.length > 0 && <OperationActivity events={toolEvents} running={sending || active} />}
              {currentRun?.status === "failed" && currentRun.error && <div className="operationInlineError"><AlertTriangle size={14} />{cleanAgentError(currentRun.error)}</div>}
              <div ref={messageEndRef} />
            </section>
            {selected && nativeRun && nativeInspectorOpen && <aside className="operationInspector"><NativeRunPanel task={selected} run={nativeRun} onChanged={refreshTasks} onError={setError} /></aside>}
            {embeddedBrowserSelected && <OperationEmbeddedBrowser running={Boolean(active)} onError={setError} sessionId={selectedSessionId} latestScreenshot={latestBrowserScreenshot} pictureInPictureActive={pictureInPictureEnabled && pictureInPictureState?.open} />}
          </div>}
          {detailMode === "browser" && embeddedBrowserSelected && <OperationEmbeddedBrowser running={Boolean(active)} onError={setError} sessionId={selectedSessionId} latestScreenshot={latestBrowserScreenshot} pictureInPictureActive={pictureInPictureEnabled && pictureInPictureState?.open} fullWidth />}
          {detailMode === "observation" && selectedSessionId && <OperationObservationPanel sessionId={selectedSessionId} artifacts={screenshotArtifacts} onPreview={setPreviewArtifact} />}
          {detailMode === "artifacts" && selectedSessionId && (
            <OperationArtifactsPanel
              sessionId={selectedSessionId}
              task={selected}
              artifacts={artifacts}
              onArtifacts={setArtifacts}
              onPreview={setPreviewArtifact}
              onError={setError}
            />
          )}

          <footer className="operationComposer">
            <textarea
              value={draft}
              disabled={sending || active || permissionDenied}
              placeholder={effectiveTargetKind === "native-app" ? "描述要在电脑桌面完成的操作" : "描述要在浏览器完成的操作"}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                  event.preventDefault();
                  void sendMessage();
                }
              }}
            />
            <button type="button" className="operationSendButton" title="发送" disabled={!draft.trim() || sending || active || permissionDenied} onClick={() => void sendMessage()}>{sending ? <Loader2 size={17} className="spin" /> : <Send size={17} />}</button>
          </footer>
        </div>
      </section>
      {previewArtifact && selectedSessionId && <OperationArtifactPreview sessionId={selectedSessionId} artifact={previewArtifact} onClose={() => setPreviewArtifact(undefined)} />}
    </main>
  );
}

function mergeToolEvent(
  current: string[],
  phase: "start" | "stop",
  name: string
): string[] {
  const startEvent = `执行 ${name}`;
  const nextEvent = phase === "start" ? startEvent : `完成 ${name}`;
  const withoutMatchingStart = phase === "stop"
    ? current.filter((event) => event !== startEvent)
    : current;
  return [...withoutMatchingStart.slice(-7), nextEvent];
}

function mergeStatusEvent(current: string[], label: string): string[] {
  const event = `执行 ${label}`;
  if (current[current.length - 1] === event) return current;
  const completed = current.map((item, index) =>
    index === current.length - 1 && item.startsWith("执行 ")
      ? `完成 ${item.slice(3)}`
      : item
  );
  return [...completed.slice(-7), event];
}

function OperationActivity({ events, running }: { events: string[]; running: boolean }) {
  const [expanded, setExpanded] = useState(true);
  return (
    <section className="operationActivity" aria-label="执行活动">
      <button
        type="button"
        className="operationActivitySummary"
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
      >
        {running ? <Loader2 size={13} className="spin" /> : <Check size={13} />}
        <strong>{running ? "正在执行" : "执行活动"}</strong>
        <span>{running ? `${events.length} 项活动` : `已记录 ${events.length} 项`}</span>
        <ChevronDown size={13} className={expanded ? "expanded" : undefined} />
      </button>
      {expanded && (
        <div className="operationActivityRows">
          {events.map((event, index) => {
            const warning = event.startsWith("WARN ");
            const pending = running && event.startsWith("执行 ");
            const taskGroup = event.startsWith("创建浏览器桥接标签组");
            return (
              <div className={warning ? "warning" : undefined} key={`${event}-${index}`}>
                {warning
                  ? <AlertTriangle size={12} />
                  : pending
                    ? <Loader2 size={12} className="spin" />
                    : taskGroup
                      ? <PanelsTopLeft size={12} />
                      : <Check size={12} />}
                <span>{warning ? event.slice(5) : event}</span>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

function OperationCdpControlPanel({
  taskRunning,
  onError,
  onUseEmbedded,
  onUseFirefox
}: {
  taskRunning: boolean;
  onError: (message?: string) => void;
  onUseEmbedded?: () => void;
  onUseFirefox?: (executablePath: string) => Promise<void>;
}) {
  const [status, setStatus] = useState<CdpStatus>();
  const [discovery, setDiscovery] = useState<CdpBrowserDiscovery>();
  const [selectedBrowserId, setSelectedBrowserId] = useState("");
  const [selectedTabId, setSelectedTabId] = useState("");
  const [extensionBridge, setExtensionBridge] = useState<BrowserExtensionBridgeStatus>();
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const [data, detected, bridge] = await Promise.all([
        requestJson<CdpStatus>("/api/cdp/status"),
        requestJson<CdpBrowserDiscovery>("/api/cdp/browsers"),
        requestJson<BrowserExtensionBridgeStatus>("/api/cdp/extension-bridge/status")
      ]);
      setStatus(data);
      setDiscovery(detected);
      setExtensionBridge(bridge);
      setSelectedBrowserId((current) => {
        if (current && detected.browsers.some((browser) => browser.id === current)) return current;
        const requested = data.selectedBrowserId;
        if (requested && detected.browsers.some((browser) => browser.id === requested)) return requested;
        return detected.defaultBrowserId ?? "";
      });
      setSelectedTabId((current) => {
        const requested = data.selectedTabId ?? current;
        return requested && data.tabs?.some((tab) => tab.id === requested) ? requested : "";
      });
    } catch (cause) {
      onError(errorMessage(cause));
    }
  }, [onError]);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 4000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const startBrowser = async () => {
    setBusy(true);
    onError(undefined);
    try {
      if (!selectedBrowserId) throw new Error("未检测到可用的 Chromium 浏览器");
      if (status?.running) {
        if (selectedBrowserId === status.selectedBrowserId) return;
        const stopped = await requestJson<{ stopped: boolean; message: string }>("/api/cdp/stop", { method: "POST" });
        if (!stopped.stopped) throw new Error(stopped.message);
      }
      const data = await requestJson<CdpStatus>("/api/cdp/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ browserId: selectedBrowserId })
      });
      setStatus(data);
      if (!data.running) throw new Error(data.error || "CDP 浏览器启动失败");
      const targetId = data.selectedTabId ?? data.tabs?.[0]?.id;
      if (targetId) await selectTab(targetId);
    } catch (cause) {
      onError(errorMessage(cause));
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
      onUseEmbedded?.();
      return;
    }
    if (browser.action === "use-firefox-profile") {
      if (!onUseFirefox) return;
      if (!browser.path) {
        onError("Firefox 可执行路径不可用，请重新检测");
        return;
      }
      setBusy(true);
      onError(undefined);
      try {
        await onUseFirefox(browser.path);
      } catch (cause) {
        onError(errorMessage(cause));
      } finally {
        setBusy(false);
      }
      return;
    }
    setSelectedBrowserId(browserId);
  };

  const stopBrowser = async () => {
    setBusy(true);
    onError(undefined);
    try {
      const result = await requestJson<{ stopped: boolean; message: string }>("/api/cdp/stop", { method: "POST" });
      if (!result.stopped) throw new Error(result.message);
      setSelectedTabId("");
      await refresh();
    } catch (cause) {
      onError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  };

  const pairExtension = async () => {
    setBusy(true);
    onError(undefined);
    try {
      await requestJson("/api/cdp/extension-bridge/reveal", { method: "POST" });
      const pairing = await requestJson<BrowserExtensionPairing>("/api/cdp/extension-bridge/pair", {
        method: "POST"
      });
      window.open(pairing.pairingUrl, "_blank", "noopener,noreferrer");
      setSelectedBrowserId("extension-bridge-user-chrome");
    } catch (cause) {
      onError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  };

  const selectTab = async (value: string) => {
    setBusy(true);
    onError(undefined);
    try {
      let targetId = value;
      if (value === "__new__") {
        const tab = await requestJson<{ id: string }>("/api/cdp/tabs", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({})
        });
        targetId = tab.id;
      }
      await requestJson("/api/cdp/selected-tab", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ targetId })
      });
      setSelectedTabId(targetId);
      await refresh();
    } catch (cause) {
      onError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  };

  const running = status?.running ?? false;
  const selectedBrowser = discovery?.browsers.find((browser) => browser.id === selectedBrowserId);
  const selectedUsesCdp = selectedBrowser?.action === "launch-cdp"
    || selectedBrowser?.action === "connect-cdp"
    || selectedBrowser?.action === "connect-extension";
  const browserChanged = running && selectedUsesCdp && Boolean(selectedBrowserId) && selectedBrowserId !== status?.selectedBrowserId;
  return (
    <section className="operationCdpPanel" aria-label="用户浏览器桥接控制">
      <div className="operationCdpStatus">
        <span className={`operationCdpDot${running ? " running" : ""}`} />
        <span><strong>用户浏览器桥接</strong><em>{running ? `${status?.browserName ?? status?.browserVersion ?? "已连接"} · ${status?.mode === "extension" ? "扩展桥接现有页面" : status?.cdpUrl}` : "通过 Browser Bridge 接管现有页面，或启动可控浏览器实例"}</em></span>
      </div>
      <div className="operationCdpActions">
        <button type="button" className="qualitySecondaryButton" disabled={busy} onClick={() => void refresh()}><RefreshCw size={12} />刷新</button>
        {browserChanged && <button type="button" className="qualityPrimaryButton" disabled={busy || taskRunning} onClick={() => void startBrowser()}>{busy ? <Loader2 size={12} className="spin" /> : <RefreshCw size={12} />}切换浏览器</button>}
        {running ? (
          <button type="button" className="qualityDangerButton" disabled={busy || taskRunning} title={taskRunning ? "任务执行中不能断开浏览器" : status?.mode === "managed" ? "关闭 CDP 浏览器" : "断开连接，不关闭用户浏览器"} onClick={() => void stopBrowser()}><Square size={12} />{status?.mode === "managed" ? "关闭" : "断开"}</button>
        ) : !browserChanged ? (
          selectedBrowser?.action === "connect-extension" && !selectedBrowser.connectable
            ? <button type="button" className="qualityPrimaryButton" disabled={busy} onClick={() => void pairExtension()}>{busy ? <Loader2 size={12} className="spin" /> : <Play size={12} />}安装 / 配对扩展</button>
            : <button type="button" className="qualityPrimaryButton" disabled={busy || !selectedBrowserId} onClick={() => void startBrowser()}>{busy ? <Loader2 size={12} className="spin" /> : <Play size={12} />}{selectedBrowser?.action === "connect-extension" ? "接管现有页面" : selectedBrowser?.connectable ? "连接已开启浏览器" : "启动所选浏览器"}</button>
        ) : null}
      </div>
      <label className="operationCdpTabs operationCdpBrowserSelect">
        <span>浏览器</span>
        <select
          value={selectedBrowserId}
          disabled={busy || taskRunning}
          onChange={(event) => void selectBrowser(event.target.value)}
        >
          {!discovery?.browsers.length && <option value="">未检测到本机浏览器</option>}
          {(discovery?.browsers ?? []).map((browser) => (
            <option
              key={browser.id}
              value={browser.id}
              disabled={(browser.action === "use-embedded-kernel" && !onUseEmbedded) || (browser.action === "use-firefox-profile" && !onUseFirefox)}
            >
              {cdpBrowserOptionLabel(browser)}{((browser.action === "use-embedded-kernel" && !onUseEmbedded) || (browser.action === "use-firefox-profile" && !onUseFirefox)) ? " · 新会话可切换" : ""}
            </option>
          ))}
        </select>
        {selectedBrowser && <em title={selectedBrowser.note}>{selectedBrowser.note}</em>}
      </label>
      {selectedBrowser?.action === "connect-extension" && !extensionBridge?.connected && (
        <div className="operationCdpBridgeHint">
          <span>{extensionBridge?.reason || "扩展桥尚未连接"}</span>
          <code title={extensionBridge?.extensionDir}>{extensionBridge?.extensionDir}</code>
        </div>
      )}
      {running && (
        <label className="operationCdpTabs"><span>目标标签页</span><select value={selectedTabId} disabled={busy || taskRunning} onChange={(event) => void selectTab(event.target.value)}><option value="">请选择受控标签页</option><option value="__new__">＋ 新开空白标签页</option>{(status?.tabs ?? []).map((tab) => <option key={tab.id} value={tab.id}>{(tab.title || tab.url || tab.id).slice(0, 80)}</option>)}</select>{status?.mode === "extension" && <em>任务开始后 Agent 会按标题和 URL 在授权页面中智能选页</em>}</label>
      )}
    </section>
  );
}

function OperationEmbeddedBrowser({
  running,
  onError,
  sessionId,
  latestScreenshot,
  pictureInPictureActive = false,
  fullWidth = false
}: {
  running: boolean;
  onError: (message?: string) => void;
  sessionId?: string;
  latestScreenshot?: ArtifactInfo;
  pictureInPictureActive?: boolean;
  fullWidth?: boolean;
}) {
  const api = (window as unknown as { uiwardenDesktop?: { embeddedBrowser: EmbeddedBrowserApi } }).uiwardenDesktop?.embeddedBrowser;
  const slotRef = useRef<HTMLDivElement>(null);
  const tabsRef = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<EmbeddedBrowserState>();
  const [address, setAddress] = useState("about:blank");
  const [libraryMode, setLibraryMode] = useState<"tabs" | "bookmarks" | "history" | null>(null);
  const [findVisible, setFindVisible] = useState(false);
  const [findQuery, setFindQuery] = useState("");
  const [pictureInPicturePreview, setPictureInPicturePreview] = useState("");

  const applyState = useCallback((next: EmbeddedBrowserState) => {
    setState(next);
    const activeTab = next.tabs.find((tab) => tab.id === next.activeTabId);
    if (activeTab) setAddress(activeTab.url);
  }, []);

  useEffect(() => {
    if (!api) return;
    void api.getState().then(applyState).catch((cause) => onError(errorMessage(cause)));
    return api.onStateChanged(applyState);
  }, [api, applyState, onError]);

  useEffect(() => {
    if (!api || !slotRef.current) return;
    const slot = slotRef.current;
    const syncBounds = () => {
      const rect = slot.getBoundingClientRect();
      if (rect.width < 1 || rect.height < 1) return;
      const x = Math.max(0, Math.floor(rect.left));
      const y = Math.max(0, Math.floor(rect.top));
      const width = Math.max(1, Math.floor(Math.min(rect.right, window.innerWidth) - x));
      const height = Math.max(1, Math.floor(Math.min(rect.bottom, window.innerHeight) - y));
      void api.setBounds({ x, y, width, height })
        .then(() => api.setVisible(true))
        .catch((cause) => onError(errorMessage(cause)));
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
  }, [api, onError]);

  useEffect(() => {
    const activeTab = tabsRef.current?.querySelector<HTMLElement>(`[data-tab-id="${state?.activeTabId || ""}"]`);
    activeTab?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [state?.activeTabId]);

  useEffect(() => {
    if (!api || !pictureInPictureActive) {
      setPictureInPicturePreview("");
      return;
    }
    let disposed = false;
    let capturePending = false;
    const capture = async () => {
      if (capturePending) return;
      capturePending = true;
      try {
        const preview = await api.capturePreview();
        if (!disposed && preview.dataUrl) setPictureInPicturePreview(preview.dataUrl);
      } catch {
        if (!disposed) setPictureInPicturePreview("");
      } finally {
        capturePending = false;
      }
    };
    void capture();
    const timer = window.setInterval(() => void capture(), 800);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [api, pictureInPictureActive, state?.activeTabId]);

  const invoke = async (operation: () => Promise<EmbeddedBrowserState>) => {
    try {
      applyState(await operation());
      onError(undefined);
    } catch (cause) {
      onError(errorMessage(cause));
    }
  };
  const activeTab = state?.tabs.find((tab) => tab.id === state.activeTabId);
  const humanControl = state?.controlMode === "human-control";
  const libraryEntries = libraryMode ? (libraryMode === "tabs" ? state?.tabs : state?.[libraryMode]) ?? [] : [];

  if (!api) {
    return <aside className={`operationBrowserInspector operationWebBrowserInspector${fullWidth ? " fullWidth" : ""}`}>
      <header className="operationWebBrowserHeader">
        <span><Globe2 size={14} /><strong>服务端 gui-browser 执行镜像</strong></span>
        <em className={running ? "running" : ""}>{running ? "实时执行中" : "托管 Chromium"}</em>
      </header>
      <div className="operationWebBrowserMirror">
        {sessionId && latestScreenshot
          ? <img src={artifactPreviewHref(sessionId, latestScreenshot)} alt={`浏览器执行镜像：${latestScreenshot.name}`} />
          : <div className="qualityEmpty"><Monitor size={24} /><strong>等待浏览器画面</strong><span>任务启动后，服务端托管 Chromium 的执行截图将在此持续更新。</span></div>}
      </div>
      <footer>Web 页面展示服务端浏览器截图；当前托管模式不提供用户鼠标键盘接管，暂停和停止仍可使用。</footer>
    </aside>;
  }
  return (
    <aside className={`operationBrowserInspector${fullWidth ? " fullWidth" : ""}`}>
      <div className="operationBrowserTabBar">
        <div className="operationBrowserTabs" ref={tabsRef} onWheel={(event) => { if (Math.abs(event.deltaY) > Math.abs(event.deltaX)) { event.preventDefault(); event.currentTarget.scrollLeft += event.deltaY; } }}>
          {state?.tabs.map((tab) => <div key={tab.id} className={`${tab.id === state.activeTabId ? "active" : ""}${tab.targetId === state.controlledTargetId ? " controlled" : ""}`} data-tab-id={tab.id}><button type="button" title={tab.title || tab.url} onClick={() => void invoke(() => api.activateTab(tab.id))}><span>{tab.crashed ? "页面已崩溃" : tab.loading ? "加载中" : tab.title || "新标签页"}</span></button><button type="button" title="关闭标签页" onClick={() => void invoke(() => api.closeTab(tab.id))}><X size={11} /></button></div>)}
        </div>
        <button type="button" className="operationBrowserAllTabs" title="查看全部标签页" onClick={() => setLibraryMode("tabs")}><List size={14} /></button>
        <button type="button" className="operationBrowserNewTab" title="新建标签页" onClick={() => void invoke(() => api.createTab())}><Plus size={14} /></button>
      </div>
      <div className="operationBrowserToolbar">
        <button type="button" title="后退" disabled={!activeTab?.canGoBack} onClick={() => void invoke(() => api.command("back"))}><ArrowLeft size={14} /></button>
        <button type="button" title="前进" disabled={!activeTab?.canGoForward} onClick={() => void invoke(() => api.command("forward"))}><ArrowRight size={14} /></button>
        <button type="button" title="刷新" onClick={() => void invoke(() => api.command("reload"))}><RotateCw size={14} /></button>
        <form onSubmit={(event) => { event.preventDefault(); void invoke(() => api.navigate(address)); }}><input aria-label="浏览器地址" value={address} onChange={(event) => setAddress(event.target.value)} /></form>
        <button type="button" title={state?.activeBookmarked ? "移除书签" : "添加书签"} onClick={() => void invoke(() => api.toggleBookmark())}><Star size={14} fill={state?.activeBookmarked ? "currentColor" : "none"} /></button>
        <button type="button" title="书签与历史记录" onClick={() => setLibraryMode((mode) => mode ? null : "bookmarks")}><History size={14} /></button>
        <button type="button" title="页内查找" onClick={() => { setFindVisible((visible) => !visible); if (findVisible) void invoke(() => api.stopFind()); }}><Search size={14} /></button>
        <button type="button" title="打开下载目录" onClick={() => void invoke(() => api.openDownloads())}><Download size={14} /></button>
        <div className="operationBrowserZoom" aria-label="页面缩放"><button type="button" title="缩小" onClick={() => void invoke(() => api.setZoomFactor((state?.zoomFactor || 1) - 0.1))}><ZoomOut size={12} /></button><button type="button" title="恢复 100%" onClick={() => void invoke(() => api.setZoomFactor(1))}>{Math.round((state?.zoomFactor || 1) * 100)}%</button><button type="button" title="放大" onClick={() => void invoke(() => api.setZoomFactor((state?.zoomFactor || 1) + 0.1))}><ZoomIn size={12} /></button></div>
        <button type="button" title="清除全部 Cookie" onClick={() => void invoke(() => api.clearCookies())}><Cookie size={14} /></button>
        <button type="button" title="开发者工具：请求与控制台（F12）" onClick={() => void invoke(() => api.openDevTools())}><Terminal size={14} /></button>
        {running && <button type="button" className={humanControl ? "human" : ""} title={humanControl ? "继续 Agent" : "人工接管"} onClick={() => void invoke(() => api.setControlMode(humanControl ? "agent-control" : "human-control"))}>{humanControl ? <Play size={14} /> : <Hand size={14} />}</button>}
      </div>
      {findVisible && <form className="operationBrowserFind" onSubmit={(event) => { event.preventDefault(); void invoke(() => api.find(findQuery, true)); }}><Search size={13} /><input autoFocus value={findQuery} onChange={(event) => setFindQuery(event.target.value)} placeholder="页内查找" /><button type="button" title="上一个" onClick={() => void invoke(() => api.find(findQuery, false))}><ArrowLeft size={12} /></button><button type="submit" title="下一个"><ArrowRight size={12} /></button><button type="button" title="关闭" onClick={() => { setFindVisible(false); void invoke(() => api.stopFind()); }}><X size={12} /></button></form>}
      {libraryMode && <section className="operationBrowserLibrary"><header><div><button type="button" className={libraryMode === "tabs" ? "active" : ""} onClick={() => setLibraryMode("tabs")}>标签页</button><button type="button" className={libraryMode === "bookmarks" ? "active" : ""} onClick={() => setLibraryMode("bookmarks")}>书签</button><button type="button" className={libraryMode === "history" ? "active" : ""} onClick={() => setLibraryMode("history")}>历史</button></div>{libraryMode === "history" && <button type="button" onClick={() => void invoke(() => api.clearHistory())}>清除历史</button>}<button type="button" title="关闭" onClick={() => setLibraryMode(null)}><X size={13} /></button></header><div>{libraryEntries.map((entry) => <div key={entry.id}><button type="button" title={entry.url} onClick={() => { void invoke(() => libraryMode === "tabs" ? api.activateTab(entry.id) : api.navigate(entry.url)); setLibraryMode(null); }}><strong>{entry.title || entry.url}</strong><span>{entry.url}</span></button>{libraryMode !== "history" && <button type="button" title={libraryMode === "tabs" ? "关闭标签页" : "移除书签"} onClick={() => void invoke(() => libraryMode === "tabs" ? api.closeTab(entry.id) : api.removeBookmark(entry.id))}><X size={12} /></button>}</div>)}{!libraryEntries.length && <div className="qualityEmpty">暂无记录</div>}</div></section>}
      <div className="operationBrowserSlot" ref={slotRef}>
        {pictureInPictureActive && (
          <div className="operationBrowserPipPlaceholder">
            {pictureInPicturePreview
              ? <img src={pictureInPicturePreview} alt="画中画浏览器实时只读镜像" />
              : <PictureInPicture2 size={24} />}
            <div>
              <strong>浏览器正在画中画显示</strong>
              <span>小窗保持实时交互，此处同步展示只读镜像。</span>
            </div>
          </div>
        )}
      </div>
    </aside>
  );
}

function OperationObservationPanel({ sessionId, artifacts, onPreview }: { sessionId: string; artifacts: ArtifactInfo[]; onPreview: (artifact: ArtifactInfo) => void }) {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [replayOpen, setReplayOpen] = useState(false);
  const orderedArtifacts = useMemo(() => [...artifacts].sort(compareObservationArtifacts), [artifacts]);
  const index = Math.min(selectedIndex, Math.max(0, orderedArtifacts.length - 1));
  const selected = orderedArtifacts[index];
  useEffect(() => {
    if (selectedIndex >= orderedArtifacts.length) setSelectedIndex(Math.max(0, orderedArtifacts.length - 1));
    if (orderedArtifacts.length === 0) setReplayOpen(false);
  }, [orderedArtifacts.length, selectedIndex]);
  useEffect(() => {
    setSelectedIndex(0);
    setReplayOpen(false);
  }, [sessionId]);
  return <><section className="operationEvidencePanel"><header><div><Image size={14} /><strong>执行观察</strong></div><div className="operationObservationControls"><span>{orderedArtifacts.length ? `${index + 1} / ${orderedArtifacts.length}` : "暂无截图"}</span><button type="button" title="上一帧" disabled={orderedArtifacts.length < 2} onClick={() => setSelectedIndex((current) => (current - 1 + orderedArtifacts.length) % orderedArtifacts.length)}><ArrowLeft size={12} /></button><button type="button" title="回放执行过程" disabled={orderedArtifacts.length < 2} onClick={() => setReplayOpen(true)}><Play size={12} /></button><button type="button" title="下一帧" disabled={orderedArtifacts.length < 2} onClick={() => setSelectedIndex((current) => (current + 1) % orderedArtifacts.length)}><ArrowRight size={12} /></button></div></header>{selected ? <div className="operationObservationContent"><button type="button" className="operationObservationPreview" onClick={() => onPreview(selected)}><img src={artifactPreviewHref(sessionId, selected)} alt={selected.name} /></button><div className="operationObservationTimeline">{orderedArtifacts.map((artifact, artifactIndex) => <button type="button" key={artifact.relativePath} className={artifactIndex === index ? "active" : ""} onClick={() => setSelectedIndex(artifactIndex)}><img src={artifactPreviewHref(sessionId, artifact)} alt="" /><span><strong>Step {artifactIndex + 1}</strong><em title={artifact.name}>{artifact.name}</em></span></button>)}</div></div> : <div className="qualityEmpty">任务产生截图后会在这里形成可回放的观察时间线。</div>}</section>{replayOpen && <OperationObservationReplay sessionId={sessionId} artifacts={orderedArtifacts} initialIndex={index} onSelectedIndexChange={setSelectedIndex} onClose={() => setReplayOpen(false)} />}</>;
}

function OperationObservationReplay({ sessionId, artifacts, initialIndex, onSelectedIndexChange, onClose }: { sessionId: string; artifacts: ArtifactInfo[]; initialIndex: number; onSelectedIndexChange: (index: number) => void; onClose: () => void }) {
  const [selectedIndex, setSelectedIndex] = useState(initialIndex);
  const [playing, setPlaying] = useState(true);
  const index = Math.min(selectedIndex, artifacts.length - 1);
  const select = useCallback((nextIndex: number) => {
    setSelectedIndex(nextIndex);
    onSelectedIndexChange(nextIndex);
  }, [onSelectedIndexChange]);
  useEffect(() => {
    if (!playing || artifacts.length < 2) return;
    const timer = window.setInterval(() => select((selectedIndex + 1) % artifacts.length), 900);
    return () => window.clearInterval(timer);
  }, [artifacts.length, playing, select, selectedIndex]);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);
  return <div className="operationObservationReplay" role="dialog" aria-modal="true" aria-label="执行流程预览"><div><header><span><strong>执行流程预览</strong><em>Step {index + 1} / {artifacts.length}</em></span><div><button type="button" onClick={() => setPlaying((current) => !current)}>{playing ? <Pause size={13} /> : <Play size={13} />}{playing ? "暂停" : "播放"}</button><button type="button" title="关闭" onClick={onClose}><X size={15} /></button></div></header><div className="operationObservationReplayBody"><button type="button" title="上一帧" onClick={() => { setPlaying(false); select((index - 1 + artifacts.length) % artifacts.length); }}><ArrowLeft size={22} /></button><img src={artifactPreviewHref(sessionId, artifacts[index])} alt={artifacts[index].name} /><button type="button" title="下一帧" onClick={() => { setPlaying(false); select((index + 1) % artifacts.length); }}><ArrowRight size={22} /></button></div><div className="operationObservationReplayStrip">{artifacts.map((artifact, artifactIndex) => <button type="button" key={artifact.relativePath} className={artifactIndex === index ? "active" : ""} title={`Step ${artifactIndex + 1} · ${artifact.name}`} onClick={() => { setPlaying(false); select(artifactIndex); }}><img src={artifactPreviewHref(sessionId, artifact)} alt={`Step ${artifactIndex + 1}`} /><span>{artifactIndex + 1}</span></button>)}</div></div></div>;
}

function compareObservationArtifacts(a: ArtifactInfo, b: ArtifactInfo): number {
  const modifiedOrder = a.modifiedAt.localeCompare(b.modifiedAt);
  if (modifiedOrder !== 0) return modifiedOrder;
  const aStep = observationStepIndex(a);
  const bStep = observationStepIndex(b);
  if (aStep != null && bStep != null && aStep !== bStep) return aStep - bStep;
  return a.relativePath.localeCompare(b.relativePath, undefined, { numeric: true });
}

function observationStepIndex(artifact: ArtifactInfo): number | undefined {
  const match = artifact.relativePath.match(/(?:frame|step|screenshot)[_-]?(\d+)/i);
  if (!match) return undefined;
  const index = Number.parseInt(match[1], 10);
  return Number.isFinite(index) ? index : undefined;
}

type OperationArtifactCategory = "全部" | "Browser Rep" | "Native Rep" | "截图" | "报告" | "操作" | "网络" | "控制台" | "Trace";

function OperationArtifactsPanel({ sessionId, task, artifacts, onArtifacts, onPreview, onError }: { sessionId: string; task?: UiOperationTask; artifacts: ArtifactInfo[]; onArtifacts: (artifacts: ArtifactInfo[]) => void; onPreview: (artifact: ArtifactInfo) => void; onError: (message?: string) => void }) {
  const [category, setCategory] = useState<OperationArtifactCategory>("全部");
  const [diagnosing, setDiagnosing] = useState(false);
  const files = artifacts.filter((artifact) => artifact.kind === "file");
  const categories = (["全部", "Browser Rep", "Native Rep", "截图", "报告", "操作", "网络", "控制台", "Trace"] as OperationArtifactCategory[]).filter((entry) => entry === "全部" || files.some((artifact) => operationArtifactMatches(artifact, entry)));
  const effectiveCategory = categories.includes(category) ? category : "全部";
  const visible = effectiveCategory === "全部" ? files : files.filter((artifact) => operationArtifactMatches(artifact, effectiveCategory));
  const browserDiagnosis = task?.executionTarget.kind === "browser" && (task.executionTarget.browserKernel === "uiwarden-embedded" || task.executionTarget.browserKernel === "gui-computer");
  const diagnose = async () => {
    setDiagnosing(true);
    try {
      const result = await requestJson<{ artifacts: ArtifactInfo[] }>(`/api/sessions/${encodeURIComponent(sessionId)}/browser-artifacts/diagnose`, { method: "POST" });
      onArtifacts(result.artifacts);
      onError(undefined);
    } catch (cause) {
      onError(errorMessage(cause));
    } finally {
      setDiagnosing(false);
    }
  };
  return <section className="operationEvidencePanel operationArtifactsPanel"><header><div><Download size={14} /><strong>产物与诊断</strong></div><div>{browserDiagnosis && <button type="button" disabled={diagnosing} onClick={() => void diagnose()}>{diagnosing ? <Loader2 size={12} className="spin" /> : <Code2 size={12} />}分析问题</button>}{browserDiagnosis && <a href={`/api/sessions/${encodeURIComponent(sessionId)}/browser-artifacts/download`}><Download size={12} />诊断包</a>}<a href={`/api/sessions/${encodeURIComponent(sessionId)}/artifacts/download`}><Download size={12} />下载全部</a></div></header><div className="operationArtifactTabs">{categories.map((entry) => <button type="button" key={entry} className={entry === effectiveCategory ? "active" : ""} onClick={() => setCategory(entry)}>{entry}<span>{entry === "全部" ? files.length : files.filter((artifact) => operationArtifactMatches(artifact, entry)).length}</span></button>)}</div><div className="operationArtifactList">{visible.map((artifact) => <div key={artifact.relativePath} className={operationArtifactHighlighted(artifact) ? "core" : ""}><button type="button" disabled={!operationArtifactPreviewable(artifact)} onClick={() => onPreview(artifact)}>{operationArtifactPreviewable(artifact) ? <Eye size={13} /> : <FileText size={13} />}<span><strong>{artifact.name}</strong><em>{artifact.relativePath}</em></span><small>{formatArtifactSize(artifact.size)}</small></button><a href={artifactDownloadHref(sessionId, artifact)} download title="下载"><Download size={13} /></a></div>)}{!visible.length && <div className="qualityEmpty">当前分类暂无产物</div>}</div></section>;
}

function OperationArtifactPreview({ sessionId, artifact, onClose }: { sessionId: string; artifact: ArtifactInfo; onClose: () => void }) {
  const image = /\.(?:png|jpe?g|webp)$/i.test(artifact.name);
  return <div className="operationArtifactPreview" role="dialog" aria-modal="true" aria-label={`预览 ${artifact.name}`}><div><header><span><Eye size={14} /><strong>{artifact.name}</strong></span><button type="button" title="关闭" onClick={onClose}><X size={14} /></button></header>{image ? <img src={artifactPreviewHref(sessionId, artifact)} alt={artifact.name} /> : <iframe title={artifact.name} src={artifactPreviewHref(sessionId, artifact)} sandbox="allow-scripts" />}</div></div>;
}

function OperationMessage({ message, streaming = false }: { message: ChatMessage; streaming?: boolean }) {
  return <article className={`operationMessage ${message.role}${streaming ? " streaming" : ""}`}><div>{message.role === "assistant" ? <Bot size={15} /> : message.role === "user" ? <span>你</span> : <AppWindow size={14} />}</div><section><header>{message.role === "assistant" ? "Agent" : message.role === "user" ? "你" : "系统"}<time>{formatTime(message.createdAt)}</time></header><p>{message.content}</p></section></article>;
}

function OperationStatus({ status }: { status: UiOperationRun["status"] }) {
  const labels: Record<UiOperationRun["status"], string> = { idle: "未执行", running: "运行中", "waiting-approval": "待审批", completed: "已完成", failed: "失败", aborted: "已停止" };
  return <span className={`qualityStatus qualityStatus${status.replace("-", "")}`}>{labels[status]}</span>;
}

function operationTargetLabel(task: UiOperationTask): string {
  if (task.executionTarget.kind === "native-app") return "电脑桌面 · Agent 自动选择";
  return kernelLabel(task.executionTarget.browserKernel);
}

function kernelLabel(kernel: BrowserKernel): string {
  return ({ playwright: "Playwright 配套 Chromium", "skill-profile": "Playwright 配套 Chromium", "external-cdp": "用户浏览器桥接", "uiwarden-embedded": IS_DESKTOP_APP ? "客户端内置 gui-browser" : "服务端托管 gui-browser", "gui-computer": "本机独立 gui-browser" } as const)[kernel];
}

function kernelDescription(kernel: BrowserKernel): string {
  if (kernel === "playwright") return "dt-gui-browser-skill：使用 Playwright 配套 Chromium 执行原子浏览器操作。";
  if (kernel === "skill-profile") return "历史配置已迁移为 Playwright 配套 Chromium。";
  if (kernel === "external-cdp") return "dt-gui-browser-skill：通过 UIWarden Browser Bridge 连接用户 Chromium。";
  return "dt-gui-browser-skill：通过原子浏览器能力执行，不启动 browser-use。";
}

function nativeProviderForPlatform(platform?: string): NativeProviderId {
  if (!IS_DESKTOP_APP) return "mock";
  if (platform === "windows") return "windows-ui-automation";
  if (platform === "macos") return "macos-accessibility";
  if (platform) return "mock";
  if (typeof navigator !== "undefined" && /win/i.test(navigator.platform || navigator.userAgent)) return "windows-ui-automation";
  if (typeof navigator !== "undefined" && /mac/i.test(navigator.platform || navigator.userAgent)) return "macos-accessibility";
  return "mock";
}

function nativeProviderLabel(providerId: NativeProviderId): string {
  return providerId === "macos-accessibility" ? "macOS Accessibility" : providerId === "windows-ui-automation" ? "Windows UI Automation" : IS_DESKTOP_APP ? "Mock Provider" : "服务器 Mock Provider（协议验证）";
}

function nativePermissionDenied(status: NativeAutomationStatus | undefined, providerId: NativeProviderId): boolean {
  return status?.providers.find((provider) => provider.providerId === providerId)?.data?.permission === "denied";
}

function operationArtifactMatches(artifact: ArtifactInfo, category: OperationArtifactCategory): boolean {
  const path = artifact.relativePath.replace(/\\/g, "/").toLowerCase();
  if (category === "全部") return true;
  if (category === "Browser Rep") return path.includes("/.skill-output/browser-reps/") || path.includes(".skill-output/browser-reps/") || path.includes(".skill-output/uiwarden-reps/");
  if (category === "Native Rep") return path.includes(".skill-output/native-reps/");
  if (category === "截图") return /\.(?:png|jpe?g|webp)$/.test(path);
  if (category === "网络") return path.includes("network.jsonl") || path.endsWith("network.har");
  if (category === "控制台") return path.includes("console.jsonl") || path.includes("page-errors.jsonl");
  if (category === "Trace") return path.includes("/trace/") || path.endsWith(".zip");
  if (category === "操作") return path.includes("/streams/actions.") || path.includes("/streams/events.");
  return !operationArtifactMatches(artifact, "截图")
    && !operationArtifactMatches(artifact, "网络")
    && !operationArtifactMatches(artifact, "控制台")
    && !operationArtifactMatches(artifact, "Trace")
    && !operationArtifactMatches(artifact, "操作");
}

function operationArtifactPreviewable(artifact: ArtifactInfo): boolean {
  return /\.(?:png|jpe?g|webp|html?|md|txt|log|json|jsonl|har|ya?ml)$/i.test(artifact.name);
}

function operationArtifactHighlighted(artifact: ArtifactInfo): boolean {
  const normalized = artifact.name.toLowerCase();
  return Boolean(artifact.isCoreReport) || normalized === "manifest.json" || /(?:index|report)\.html?$/.test(normalized);
}

function artifactPreviewHref(sessionId: string, artifact: ArtifactInfo): string {
  return `/api/sessions/${encodeURIComponent(sessionId)}/preview/${encodeArtifactPath(artifact.relativePath)}?v=${encodeURIComponent(artifact.modifiedAt)}`;
}

function artifactDownloadHref(sessionId: string, artifact: ArtifactInfo): string {
  return `/api/sessions/${encodeURIComponent(sessionId)}/files/${encodeArtifactPath(artifact.relativePath)}`;
}

function encodeArtifactPath(relativePath: string): string {
  return relativePath.replace(/\\/g, "/").split("/").map(encodeURIComponent).join("/");
}

function formatArtifactSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const text = await response.text();
  let payload: unknown;
  try { payload = text ? JSON.parse(text) : undefined; } catch { payload = text; }
  if (!response.ok) {
    const message = payload && typeof payload === "object" && "error" in payload ? String((payload as { error: unknown }).error) : String(payload || `HTTP ${response.status}`);
    throw new Error(message);
  }
  return payload as T;
}

async function readSse(body: ReadableStream<Uint8Array>, onPayload: (payload: StreamPayload) => void): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    const chunks = buffer.split("\n\n");
    buffer = chunks.pop() ?? "";
    for (const chunk of chunks) {
      const line = chunk.split("\n").find((item) => item.startsWith("data:"));
      if (line) onPayload(JSON.parse(line.slice(5).trim()) as StreamPayload);
    }
    if (done) break;
  }
}

function cleanAgentError(value: string): string {
  const plain = value.split("\n\n[Stack]")[0].trim();
  try {
    const parsed = JSON.parse(plain) as { error?: string };
    return parsed.error || plain;
  } catch {
    return plain;
  }
}

function errorMessage(cause: unknown): string {
  return cleanAgentError(cause instanceof Error ? cause.message : String(cause));
}

function loadOperationExperience(): UiOperationExperience {
  try {
    const parsed = JSON.parse(window.localStorage.getItem("uiwarden.ui-operation-experience") || "{}") as Partial<UiOperationExperience>;
    return {
      presentationMode: parsed.presentationMode === "picture-in-picture" ? "picture-in-picture" : "inline",
      browserTaskGroupMode: "off",
      nativeDeliveryMode: parsed.nativeDeliveryMode === "background-safe"
        ? "background-safe"
        : "foreground-compatible"
    };
  } catch {
    return DEFAULT_OPERATION_EXPERIENCE;
  }
}

function saveOperationExperience(experience: UiOperationExperience): void {
  try {
    window.localStorage.setItem("uiwarden.ui-operation-experience", JSON.stringify({
      presentationMode: experience.presentationMode,
      nativeDeliveryMode: experience.nativeDeliveryMode
    }));
  } catch {
    // A blocked localStorage must not prevent updating the persisted task.
  }
}

function isRecoverableAppDiscoveryWarning(message: string): boolean {
  const normalized = message.toLowerCase();
  return normalized.includes("target-window-not-found")
    || normalized.includes("__agent_select__")
    || normalized.includes("找不到_app")
    || /(?:找不到|未找到).{0,24}(?:应用|app)/i.test(message);
}

function formatTime(value: string): string {
  return new Date(value).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
}

function formatConversationTime(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(value));
}
