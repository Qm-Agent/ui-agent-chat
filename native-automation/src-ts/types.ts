export const PROTOCOL_VERSION = 1;
export const RUNTIME_VERSION = "0.6.1";

export type ProviderId = "mock" | "macos-accessibility" | "windows-ui-automation";
export type ControlMode = "observe" | "agent-control" | "human-control";
export type ApprovalPolicy = "none" | "sensitive-actions";
export type ActionActor = "agent" | "user";
export type DeliveryMode = "foreground-compatible" | "background-safe";

export interface AppSelector {
  kind: "bundle-id" | "path" | "name" | "process-id";
  value: string;
}

export interface AppInfo {
  id: string;
  displayName: string;
  isRunning: boolean;
  processId?: number;
}

export interface UiBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface UiElement {
  elementId: string;
  providerPath: string;
  role: string;
  name: string;
  value?: string;
  secure: boolean;
  enabled: boolean;
  actions: string[];
  focused: boolean;
  bounds?: UiBounds;
}

export interface ProviderSnapshot {
  app: AppInfo;
  text: string;
  elements: UiElement[];
  projection?: {
    mode: "compact" | "full";
    maxDepth: number;
    maxElements: number;
    truncated: boolean;
  };
  screenshotPath?: string;
  windowBounds?: UiBounds;
  captureGaps: string[];
}

export interface UiSnapshot extends ProviderSnapshot {
  version: number;
  snapshotId: string;
  sessionId: string;
  sequence: number;
  focusedElement?: UiElement;
  delta: ObservationDelta;
  changes?: ObservationChanges;
  capturedAt: string;
}

export interface ObservationChanges {
  addedElements: UiElement[];
  updatedElements: UiElement[];
  removedElementIds: string[];
}

export interface ObservationDelta {
  changed: boolean;
  windowChanged: boolean;
  focusedElementChanged: boolean;
  textChanged: boolean;
  addedElementCount: number;
  removedElementCount: number;
  updatedElementCount: number;
  actionCountSinceLastObservation: number;
  noProgressCount: number;
}

export interface ApprovalChallenge {
  challengeId: string;
  actionSignature: string;
  actionSummary: string;
  snapshotId: string;
  expiresAt: string;
  granted: boolean;
}

export interface NativeAction {
  kind: string;
  elementId?: string;
  value?: string;
  key?: string;
  direction?: string;
  pages?: number;
  x?: number;
  y?: number;
  allowCoordinateFallback: boolean;
  focused: boolean;
  visualText?: string;
  matchMode?: string;
  occurrence?: number;
}

export interface AutomationSession {
  version: number;
  sessionId: string;
  providerId: ProviderId;
  app: AppSelector;
  controlMode: ControlMode;
  deliveryMode: DeliveryMode;
  approvalPolicy: ApprovalPolicy;
  state: "active" | "stopped" | "failed";
  currentSnapshotId?: string;
  artifactDir: string;
  startedAt: string;
  finishedAt?: string;
  stopReason?: string;
  snapshotSequence: number;
  lastElements: UiElement[];
  lastScreenshotPath?: string;
  lastWindowBounds?: UiBounds;
  pendingApprovals: ApprovalChallenge[];
  providerState: Record<string, unknown>;
  eventCount: number;
  actionCount: number;
  approvalCount: number;
  captureGaps: string[];
}

export interface NativeProvider {
  readonly id: ProviderId;
  probe(): Promise<Record<string, unknown>>;
  listApps(): Promise<AppInfo[]>;
  launchApp(app: AppSelector, deliveryMode: DeliveryMode): Promise<AppInfo>;
  observe(session: AutomationSession, full: boolean): Promise<ProviderSnapshot>;
  perform(session: AutomationSession, action: NativeAction): Promise<Record<string, unknown>>;
}
