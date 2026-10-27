export type ChatRole = "user" | "assistant" | "system";

export type SessionStatus = "idle" | "running" | "failed" | "completed";

/**
 * 测试断言结果状态：与执行状态（SessionStatus/InspectionRunStatus 等）正交。
 * - pass：agent 输出明确 PASS/通过 结论
 * - fail：agent 输出明确 FAIL/失败/未通过 结论
 * - unknown：agent 未给出明确结论，或历史数据未回填
 *
 * 通知触发条件 notifyTrigger === "failed" 中的"失败"统一指
 * testOutcome === "fail" 或执行状态 failed，二者满足其一即视为失败。
 */
export type TestOutcome = "pass" | "fail" | "unknown";

/**
 * 钉钉通知推送状态：记录每次巡检 run / 回归批次结束后通知是否需要、是否成功。
 * - skipped：未配置机器人、触发条件为 never，或仅失败通知但本次未失败 → 未推送
 * - sent：已触发且推送成功
 * - failed：已触发但推送失败（机器人不存在 / 网络异常 / 钉钉返回错误）
 * 配合 notifyMessage 记录具体原因或错误信息，便于用户排查和复盘。
 */
export type NotifyStatus = "skipped" | "sent" | "failed";

export interface UploadedFileInfo {
  id: string;
  originalName: string;
  filename: string;
  path: string;
  size: number;
  mimeType: string;
  createdAt: string;
}

export interface ArtifactInfo {
  id: string;
  name: string;
  relativePath: string;
  size: number;
  modifiedAt: string;
  kind: "file" | "directory";
  isCoreReport?: boolean;
}

export interface ChatMessage {
  id: string;
  role: ChatRole;
  content: string;
  createdAt: string;
  files?: UploadedFileInfo[];
  meta?: Record<string, unknown>;
}

/**
 * 会话类型：
 * - chat：普通对话/巡检/回归会话（默认，headless 新启浏览器）
 * - cdp：CDP 直连会话（桌面客户端特性）——附着本地 CDP 浏览器复用登录态，
 *   支持连续多轮人机协同操作（轮间用户可手动操作浏览器）。
 */
export type SessionKind = "chat" | "cdp";
export type BrowserKernel = "playwright" | "skill-profile" | "external-cdp" | "uiwarden-embedded" | "gui-computer";

export interface AgentSession {
  id: string;
  title: string;
  status: SessionStatus;
  kind?: SessionKind;
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

export type InspectionTaskStatus = "idle" | "running" | "disabled";
export type InspectionRunStatus = "running" | "completed" | "failed";
export type InspectionRunTrigger = "manual" | "schedule";

export interface InspectionRun {
  id: string;
  taskId: string;
  sessionId: string;
  trigger: InspectionRunTrigger;
  status: InspectionRunStatus;
  startedAt: string;
  finishedAt?: string;
  summary?: string;
  error?: string;
  artifactsCount?: number;
  logs?: string[];
  testOutcome?: TestOutcome;
  notifyStatus?: NotifyStatus;
  notifyMessage?: string;
}

export type InspectionNotifyTrigger = "always" | "failed" | "never";

export interface InspectionTask {
  id: string;
  name: string;
  url: string;
  businessId?: string;
  username?: string;
  password?: string;
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
  notifyRobotId?: string;
  notifyTrigger?: InspectionNotifyTrigger;
}

export type PublicInspectionTask = Omit<InspectionTask, "password"> & {
  hasPassword: boolean;
  passwordMasked?: string;
};

export interface BusinessEnvironment {
  id: string;
  name: string;
  url: string;
  username?: string;
  password?: string;
  description?: string;
  createdAt: string;
  updatedAt: string;
}

export type PublicBusinessEnvironment = Omit<BusinessEnvironment, "password"> & {
  hasPassword: boolean;
  passwordMasked?: string;
};

export interface HostEntry {
  id: string;
  ip: string;
  hostname: string;
  comment?: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface HostApplyStatus {
  applied: boolean;
  message?: string;
  appliedAt?: string;
}

export interface StreamPayload {
  type:
    | "session"
    | "message"
    | "text"
    | "tool"
    | "log"
    | "screenshot"
    | "status"
    | "result"
    | "artifacts"
    | "error"
    | "done";
  data?: unknown;
}

export interface ScreenshotEvent {
  relativePath: string;
  url: string;
  modifiedAt: string;
  stepIndex?: number;
  pageUrl?: string;
  title?: string;
  actionSummary?: string;
  source?: "live" | "result" | "artifact";
}

export type ExecutionRuntimeId = "cfuse" | "codex" | "dtcoder" | "claude-code";

export interface ModelProfile {
  id: string;
  runtimeId: ExecutionRuntimeId;
  name: string;
  baseUrl: string;
  authToken: string;
  model: string;
  smallFastModel?: string;
  sonnetModel?: string;
  haikuModel?: string;
  opusModel?: string;
  isDefault?: boolean;
  isActive?: boolean;
  createdAt: string;
  updatedAt: string;
}

export type PublicModelProfile = Omit<ModelProfile, "authToken"> & {
  hasToken: boolean;
  tokenMasked?: string;
};

export interface RuntimeModelOption {
  id: string;
  label: string;
  description?: string;
  provider?: string;
  source: "runtime-api" | "local-cache" | "local-config" | "fallback";
}

export interface RuntimeModelCatalog {
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

export interface ExecutionRuntimeStatus {
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
  modelProfile?: PublicModelProfile;
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

/* ─── 回归任务模块 ─── */

export type RegressionRunStatus = "pending" | "running" | "completed" | "failed" | "aborted";
export type RegressionBatchStatus = "running" | "completed" | "aborted";

export interface RegressionModule {
  id: string;
  name: string;
  description?: string;
  createdAt: string;
  updatedAt: string;
}

export interface RegressionCase {
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

export interface RegressionRun {
  id: string;
  batchId: string;
  caseId: string;
  caseName: string;
  sessionId: string;
  status: RegressionRunStatus;
  startedAt?: string;
  finishedAt?: string;
  summary?: string;
  error?: string;
  artifactsCount?: number;
  testOutcome?: TestOutcome;
  notifyStatus?: NotifyStatus;
  notifyMessage?: string;
}

export interface RegressionBatch {
  id: string;
  name: string;
  status: RegressionBatchStatus;
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

export type PublicRegressionCase = RegressionCase;

/* ─── 钉钉群机器人通知 ─── */

export interface DingtalkRobot {
  id: string;
  name: string;
  webhookUrl: string;
  secret?: string;
  description?: string;
  inspectionTemplate?: string;
  regressionTemplate?: string;
  createdAt: string;
  updatedAt: string;
}

/* ─── 统一质量领域（应用层投影，暂不新增数据库表） ─── */

export type ExecutionPurpose = "test" | "operation";
export type QualityRunSource = "conversation" | "inspection" | "regression" | "ui-operation";

export interface QualityStep {
  id: string;
  title: string;
  status: "pending" | "running" | "completed" | "failed" | "skipped";
  evidencePaths: string[];
}

export interface QualityAssertion {
  id: string;
  title: string;
  status: TestOutcome;
  evidencePaths: string[];
}

export interface UnifiedQualityRun {
  id: string;
  sessionId: string;
  purpose: ExecutionPurpose;
  source: QualityRunSource;
  sourceId?: string;
  sourceName: string;
  status: "idle" | "queued" | "running" | "completed" | "failed" | "aborted" | "waiting-approval";
  outcome: TestOutcome;
  browserKernel: BrowserKernel;
  environmentId?: string;
  environmentName?: string;
  startedAt: string;
  finishedAt?: string;
  durationMs?: number;
  summary?: string;
  error?: string;
  artifactsCount: number;
  steps: QualityStep[];
  assertions: QualityAssertion[];
  defectId?: string;
  defectUrl?: string;
}

export interface QualityTrendPoint {
  date: string;
  total: number;
  passed: number;
  failed: number;
  unknown: number;
  aborted: number;
}

export interface QualityDashboard {
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
  trends: QualityTrendPoint[];
  recentRuns: UnifiedQualityRun[];
}

export type UiOperationStatus = "idle" | "running" | "waiting-approval" | "completed" | "failed" | "aborted";
export type UiOperationApprovalMode = "none" | "manual-finalize";
export type UiOperationPresentationMode = "inline" | "picture-in-picture";
export type UiOperationBrowserTaskGroupMode = "off" | "user-browser";
export type NativeProviderId = "mock" | "macos-accessibility" | "windows-ui-automation";
export type NativeAppSelectorKind = "bundle-id" | "path" | "name" | "process-id";
export type NativeControlMode = "observe" | "agent-control" | "human-control";
export type NativeDeliveryMode = "foreground-compatible" | "background-safe";

export interface NativeAppSelector {
  kind: NativeAppSelectorKind;
  value: string;
}

export type UiOperationExecutionTarget =
  | {
      kind: "browser";
      browserKernel: BrowserKernel;
      targetUrl?: string;
    }
  | {
      kind: "native-app";
      providerId: NativeProviderId;
      app: NativeAppSelector;
      displayName?: string;
    };

export interface UiOperationExperience {
  presentationMode: UiOperationPresentationMode;
  browserTaskGroupMode: UiOperationBrowserTaskGroupMode;
  nativeDeliveryMode: NativeDeliveryMode;
}

export interface UiOperationBrowserTaskGroup {
  status: "created" | "failed";
  groupId?: number;
  chromeTabId?: number;
  targetId?: string;
  markerUrl?: string;
  title?: string;
  error?: string;
}

export interface UiOperationRun {
  id: string;
  taskId: string;
  sessionId: string;
  instruction?: string;
  status: UiOperationStatus;
  startedAt: string;
  finishedAt?: string;
  summary?: string;
  error?: string;
  artifactsCount: number;
  nativeSessionId?: string;
  nativeControlMode?: NativeControlMode;
  nativeArtifactDir?: string;
  browserTaskGroup?: UiOperationBrowserTaskGroup;
  pendingApprovalId?: string;
  pendingApprovalSummary?: string;
}

export interface UiOperationTask {
  id: string;
  name: string;
  instruction: string;
  isDraft?: boolean;
  conversationSessionId?: string;
  targetUrl?: string;
  businessId?: string;
  browserKernel: BrowserKernel;
  executionTarget: UiOperationExecutionTarget;
  experience: UiOperationExperience;
  approvalMode: UiOperationApprovalMode;
  createdAt: string;
  updatedAt: string;
  runs: UiOperationRun[];
}

export type EvaluationOperationType = "browser" | "computer";
export type EvaluationRunStatus = "queued" | "running" | "completed" | "failed" | "aborted";
export type EvaluationCaseRunStatus =
  | "queued"
  | "running"
  | "pass"
  | "fail"
  | "blocked"
  | "not-run"
  | "unknown"
  | "aborted";
export type GuiRuntimeTransportPreference = "inherit" | "cli" | "mcp";
export type EvaluationAssertionEvaluator =
  | "run-completed"
  | "summary-contains"
  | "summary-not-contains"
  | "artifact-count"
  | "duration";

export interface EvaluationAssertionDefinition {
  id: string;
  label: string;
  evaluator: EvaluationAssertionEvaluator;
  weight: number;
  required: boolean;
  params: {
    terms?: string[];
    matchMode?: "all" | "any";
    min?: number;
    maxMs?: number;
  };
}

export interface EvaluationCaseDefinition {
  id: string;
  name: string;
  category: string;
  instruction: string;
  compatibleTargets: EvaluationOperationType[];
  targetUrl?: string;
  tags: string[];
  timeoutMs: number;
  enabled: boolean;
  passThreshold?: number;
  assertions: EvaluationAssertionDefinition[];
}

export interface EvaluationTargetServiceDefinition {
  id: string;
  name: string;
  kind: "managed" | "external";
  provider?: string;
  baseUrl?: string;
  healthPath?: string;
}

export interface EvaluationTargetServiceStatus {
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

export interface EvaluationResolvedTargetService {
  id: string;
  name: string;
  kind: EvaluationTargetServiceDefinition["kind"];
  provider?: string;
  baseUrl: string;
  healthUrl?: string;
}

export interface EvaluationSuite {
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

export interface EvaluationRunConfig {
  operationType: EvaluationOperationType;
  browserKernel?: BrowserKernel;
  providerId?: NativeProviderId;
  nativeDeliveryMode?: NativeDeliveryMode;
  guiRuntimeTransport?: GuiRuntimeTransportPreference;
  executionRuntimeId?: ExecutionRuntimeId;
  model?: string;
  businessId?: string;
  repetitions: number;
  passThreshold: number;
  concurrency: number;
}

export interface EvaluationPlan {
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

export interface EvaluationAssertionResult {
  id: string;
  label: string;
  evaluator: EvaluationAssertionEvaluator;
  status: "pass" | "fail" | "unknown";
  score: number;
  maxScore: number;
  reason: string;
  evidencePaths: string[];
}

export interface EvaluationCaseObservability {
  eventCount: number;
  tokenUsage?: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
  };
  gaps: string[];
}

export interface EvaluationCaseRun {
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
  observability: EvaluationCaseObservability;
}

export interface EvaluationCaseAttempt {
  attemptNumber: number;
  trigger: "checkpoint-resume" | "case-rerun";
  archivedAt: string;
  snapshot: Omit<EvaluationCaseRun, "attemptHistory">;
}

export interface EvaluationRunResumeEntry {
  id: string;
  trigger: "checkpoint-resume" | "case-rerun";
  resumedAt: string;
  previousCaseRunIds: string[];
  nextCaseRunIds: string[];
}

export interface EvaluationEnvironmentSnapshot {
  executionRuntimeId: ExecutionRuntimeId;
  model?: string;
  selectionSource?: "configured-default" | "plan-override";
  platform: string;
  desktop: boolean;
  executionChain: string[];
  guiRuntimeTransport?: "cli" | "mcp";
  targetServices?: EvaluationResolvedTargetService[];
  capturedAt: string;
}

export interface EvaluationRunSummary {
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

export interface EvaluationRun {
  schemaVersion: "1.0";
  id: string;
  planId?: string;
  planName?: string;
  planSnapshot?: EvaluationPlan;
  rerunOfRunId?: string;
  rerunOfCaseRunId?: string;
  suiteId: string;
  suiteName: string;
  suiteHash: string;
  suiteSnapshot: EvaluationSuite;
  status: EvaluationRunStatus;
  config: EvaluationRunConfig;
  environment: EvaluationEnvironmentSnapshot;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  stopReason?: string;
  currentCaseRunId?: string;
  caseRuns: EvaluationCaseRun[];
  resumeHistory?: EvaluationRunResumeEntry[];
  summary: EvaluationRunSummary;
  reportPaths?: {
    json: string;
    html: string;
    bundle?: string;
  };
}

export interface EvaluationReportArtifact {
  name: string;
  relativePath: string;
  kind: "manifest" | "actions" | "snapshots" | "events" | "screenshot" | "schema" | "report" | "other";
  size: number;
}

export interface EvaluationCaseDiagnosis {
  category: "passed" | "timeout" | "provider" | "blocked" | "execution" | "assertion" | "observability" | "unknown";
  stage: "discovery" | "action" | "verification" | "cleanup" | "completed" | "unknown";
  confidence: "high" | "medium" | "low";
  primaryCause: string;
  contributingFactors: string[];
  evidence: string[];
  recommendations: string[];
}

export interface EvaluationCaseReportDetail {
  caseRunId: string;
  caseId: string;
  instruction: string;
  tags: string[];
  timeoutMs: number;
  passThreshold: number;
  expectedAssertions: EvaluationAssertionDefinition[];
  identifiers: {
    taskId?: string;
    operationRunId?: string;
    sessionId?: string;
    nativeSessionId?: string;
  };
  operation: {
    status?: UiOperationStatus;
    error?: string;
    artifactsCount: number;
    nativeArtifactDir?: string;
    browserArtifactDir?: string;
  };
  metrics: {
    timeoutUtilizationPercent?: number;
    evaluationEvents: number;
    toolEvents: number;
    toolCalls: number;
    textEvents: number;
    commandErrors: number;
    oversizedOutputs: number;
    providerTimeouts: number;
    staleSnapshots: number;
    focusContextErrors: number;
    maxEventGapMs: number;
    nativeActions: number;
    nativeSnapshots: number;
    nativeEvents: number;
    actionKinds: Record<string, number>;
  };
  progressSummary?: string;
  captureGaps: string[];
  eventEvidencePath: string;
  artifacts: EvaluationReportArtifact[];
  visualEvidence?: {
    firstScreenshot?: EvaluationScreenshotEvidence;
    lastScreenshot?: EvaluationScreenshotEvidence;
  };
  diagnosis: EvaluationCaseDiagnosis;
}

export interface EvaluationScreenshotEvidence {
  reportPath: string;
  sourceRelativePath: string;
  size: number;
}

export interface EvaluationExperimentReport extends EvaluationRun {
  reportSchemaVersion: "2.0";
  generatedAt: string;
  scoreCoverage: {
    scoredCases: number;
    totalCases: number;
    percent: number;
    note: string;
  };
  privacy: {
    rawApplicationContentIncluded: boolean;
    note: string;
  };
  diagnosisSummary: {
    primaryFailureCategories: Record<string, number>;
    sharedContributingFactors: string[];
    prioritizedRecommendations: string[];
  };
  caseDetails: EvaluationCaseReportDetail[];
}

export type PublicDingtalkRobot = Omit<DingtalkRobot, "secret" | "webhookUrl"> & {
  hasSecret: boolean;
  secretMasked?: string;
  webhookUrlMasked?: string;
};
