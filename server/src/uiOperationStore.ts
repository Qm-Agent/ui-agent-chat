import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { uiOperationsDir } from "./paths.js";
import type {
  BrowserKernel,
  NativeAppSelectorKind,
  NativeProviderId,
  UiOperationApprovalMode,
  UiOperationExperience,
  UiOperationExecutionTarget,
  UiOperationRun,
  UiOperationTask
} from "./types.js";

const STORE_FILE = path.join(uiOperationsDir, "tasks.json");
let mutationQueue: Promise<void> = Promise.resolve();
export const AGENT_SELECTED_NATIVE_APP = {
  kind: "name" as const,
  value: "__agent_select__"
};

/** 初始化通用 UI 操作的文件式仓储。 */
export async function ensureUiOperationStorage(): Promise<void> {
  await fs.mkdir(uiOperationsDir, { recursive: true });
  try {
    await fs.access(STORE_FILE);
  } catch (error) {
    if (!isFileNotFound(error)) throw error;
    await writeTasks([]);
  }
}

async function readTasks(): Promise<UiOperationTask[]> {
  await ensureUiOperationStorage();
  try {
    const parsed = JSON.parse(await fs.readFile(STORE_FILE, "utf8")) as unknown;
    if (!Array.isArray(parsed)) throw new Error("根节点必须是数组");
    return parsed.map((item) => normalizeStoredUiOperationTask(item));
  } catch (error) {
    throw new Error(`UI 操作存储文件损坏，已停止写入以保护原数据：${error instanceof Error ? error.message : String(error)}`);
  }
}

async function writeTasks(tasks: UiOperationTask[]): Promise<void> {
  await fs.mkdir(uiOperationsDir, { recursive: true });
  const temporary = `${STORE_FILE}.${process.pid}.tmp`;
  try {
    await fs.writeFile(temporary, JSON.stringify(tasks, null, 2), { encoding: "utf8", mode: 0o600 });
    await fs.rename(temporary, STORE_FILE);
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => undefined);
  }
}

/** 返回全部 UI 操作任务，最近更新的任务排在前面。 */
export async function listUiOperationTasks(): Promise<UiOperationTask[]> {
  return (await readTasks()).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/** 读取单个 UI 操作任务。 */
export async function loadUiOperationTask(id: string): Promise<UiOperationTask> {
  const task = (await readTasks()).find((item) => item.id === id);
  if (!task) throw new Error(`UI 操作任务不存在：${id}`);
  return task;
}

/** 新建或更新通用 UI 操作任务。 */
export async function upsertUiOperationTask(input: {
  id?: string;
  name?: string;
  instruction?: string;
  targetUrl?: string;
  businessId?: string;
  browserKernel?: BrowserKernel;
  executionTarget?: UiOperationExecutionTarget;
  experience?: Partial<UiOperationExperience>;
  approvalMode?: UiOperationApprovalMode;
  isDraft?: boolean;
}): Promise<UiOperationTask> {
  return withMutation(async () => {
    const tasks = await readTasks();
    const existing = input.id ? tasks.find((item) => item.id === input.id) : undefined;
    if (input.id && !existing) throw new Error(`UI 操作任务不存在：${input.id}`);
    const instruction = String(input.instruction ?? existing?.instruction ?? "").trim();
    if (!instruction) throw new Error("UI 操作指令不能为空");
    const now = new Date().toISOString();
    const executionTarget = normalizeExecutionTarget(input.executionTarget, existing, input);
    const browserKernel = executionTarget.kind === "browser"
      ? executionTarget.browserKernel
      : normalizeBrowserKernel(input.browserKernel ?? existing?.browserKernel);
    const targetUrl = executionTarget.kind === "browser"
      ? executionTarget.targetUrl
      : undefined;
    const task: UiOperationTask = {
      id: existing?.id ?? randomUUID(),
      name: String(input.name ?? existing?.name ?? "").trim() || instruction.slice(0, 40),
      instruction,
      isDraft: input.isDraft ?? existing?.isDraft ?? false,
      targetUrl,
      businessId: String(input.businessId ?? existing?.businessId ?? "").trim() || undefined,
      browserKernel,
      executionTarget,
      experience: normalizeExperience(input.experience, existing?.experience),
      approvalMode: normalizeApprovalMode(
        input.approvalMode ?? existing?.approvalMode,
        browserKernel,
        executionTarget.kind
      ),
      conversationSessionId: existing?.conversationSessionId,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      runs: existing?.runs ?? []
    };
    const next = existing ? tasks.map((item) => item.id === task.id ? task : item) : [task, ...tasks];
    await writeTasks(next);
    return task;
  });
}

/** 删除 UI 操作任务；运行状态由服务层负责校验。 */
export async function deleteUiOperationTask(id: string): Promise<void> {
  await withMutation(async () => {
    const tasks = await readTasks();
    if (!tasks.some((item) => item.id === id)) throw new Error(`UI 操作任务不存在：${id}`);
    await writeTasks(tasks.filter((item) => item.id !== id));
  });
}

/** 添加一次 UI 操作运行记录。 */
export async function appendUiOperationRun(taskId: string, run: UiOperationRun): Promise<UiOperationTask> {
  return withMutation(() => updateTaskUnsafe(taskId, (task) => ({ ...task, updatedAt: new Date().toISOString(), runs: [run, ...task.runs] })));
}

/** 将 UI 操作对话固定到一个 Agent 会话，后续轮次复用 SDK 上下文。 */
export async function setUiOperationConversationSession(taskId: string, sessionId: string): Promise<UiOperationTask> {
  return withMutation(() => updateTaskUnsafe(taskId, (task) => ({
    ...task,
    conversationSessionId: sessionId,
    updatedAt: new Date().toISOString()
  })));
}

/** 更新 UI 操作运行记录。 */
export async function updateUiOperationRun(
  taskId: string,
  runId: string,
  patch: Partial<UiOperationRun>
): Promise<UiOperationRun> {
  let updated: UiOperationRun | undefined;
  await withMutation(() => updateTaskUnsafe(taskId, (task) => ({
      ...task,
      updatedAt: new Date().toISOString(),
      runs: task.runs.map((run) => {
        if (run.id !== runId) return run;
        updated = { ...run, ...patch };
        return updated;
      })
    })));
  if (!updated) throw new Error(`UI 操作运行不存在：${runId}`);
  return updated;
}

async function updateTaskUnsafe(id: string, updater: (task: UiOperationTask) => UiOperationTask): Promise<UiOperationTask> {
  const tasks = await readTasks();
  const index = tasks.findIndex((item) => item.id === id);
  if (index < 0) throw new Error(`UI 操作任务不存在：${id}`);
  const updated = updater(tasks[index]);
  tasks[index] = updated;
  await writeTasks(tasks);
  return updated;
}

function withMutation<T>(operation: () => Promise<T>): Promise<T> {
  const result = mutationQueue.then(operation, operation);
  mutationQueue = result.then(() => undefined, () => undefined);
  return result;
}

function normalizeBrowserKernel(value?: BrowserKernel): BrowserKernel {
  return value === "external-cdp" || value === "uiwarden-embedded" || value === "gui-computer"
    ? value
    : "playwright";
}

function normalizeApprovalMode(
  value: UiOperationApprovalMode | undefined,
  _kernel: BrowserKernel,
  _targetKind: UiOperationExecutionTarget["kind"] = "browser"
): UiOperationApprovalMode {
  if (value === "none" || value === "manual-finalize") return value;
  return "none";
}

function normalizeExecutionTarget(
  value: UiOperationExecutionTarget | undefined,
  existing: UiOperationTask | undefined,
  input: { browserKernel?: BrowserKernel; targetUrl?: string }
): UiOperationExecutionTarget {
  if (value?.kind === "native-app") {
    const providerId = normalizeNativeProvider(value.providerId);
    const appValue = String(value.app?.value ?? "").trim() || AGENT_SELECTED_NATIVE_APP.value;
    return {
      kind: "native-app",
      providerId,
      app: {
        kind: appValue === AGENT_SELECTED_NATIVE_APP.value
          ? AGENT_SELECTED_NATIVE_APP.kind
          : normalizeNativeAppKind(value.app?.kind),
        value: appValue
      },
      displayName: appValue === AGENT_SELECTED_NATIVE_APP.value
        ? "Agent 自动选择"
        : String(value.displayName ?? "").trim() || undefined
    };
  }
  if (value && value.kind !== "browser") throw new Error("无效的 UI 操作执行目标");
  if (!value && existing?.executionTarget?.kind === "native-app" && input.browserKernel == null && input.targetUrl == null) {
    return existing.executionTarget;
  }
  const browserKernel = normalizeBrowserKernel(
    value?.kind === "browser" ? value.browserKernel : input.browserKernel ?? existing?.browserKernel
  );
  return {
    kind: "browser",
    browserKernel,
    targetUrl: normalizeOptionalUrl(
      value?.kind === "browser" ? value.targetUrl : input.targetUrl ?? existing?.targetUrl
    )
  };
}

export function normalizeStoredUiOperationTask(value: unknown): UiOperationTask {
  if (!value || typeof value !== "object") throw new Error("任务项必须是对象");
  const raw = value as Partial<UiOperationTask>;
  const browserKernel = normalizeBrowserKernel(raw.browserKernel);
  const executionTarget = raw.executionTarget?.kind === "native-app"
    ? normalizeExecutionTarget(raw.executionTarget, undefined, {})
    : {
        kind: "browser" as const,
        browserKernel,
        targetUrl: normalizeOptionalUrl(raw.executionTarget?.kind === "browser"
          ? raw.executionTarget.targetUrl
          : raw.targetUrl)
      };
  return {
    ...raw,
    id: String(raw.id ?? ""),
    name: String(raw.name ?? ""),
    instruction: String(raw.instruction ?? ""),
    isDraft: raw.isDraft === true,
    conversationSessionId: raw.conversationSessionId ? String(raw.conversationSessionId) : undefined,
    browserKernel: executionTarget.kind === "browser" ? executionTarget.browserKernel : browserKernel,
    targetUrl: executionTarget.kind === "browser" ? executionTarget.targetUrl : undefined,
    executionTarget,
    experience: normalizeExperience(raw.experience),
    approvalMode: normalizeApprovalMode(raw.approvalMode, browserKernel, executionTarget.kind),
    createdAt: String(raw.createdAt ?? ""),
    updatedAt: String(raw.updatedAt ?? ""),
    runs: Array.isArray(raw.runs) ? raw.runs : []
  };
}

function normalizeExperience(
  value?: Partial<UiOperationExperience>,
  existing?: UiOperationExperience
): UiOperationExperience {
  return {
    presentationMode: value?.presentationMode === "picture-in-picture"
      ? "picture-in-picture"
      : value?.presentationMode === "inline"
        ? "inline"
        : existing?.presentationMode ?? "inline",
    browserTaskGroupMode: value?.browserTaskGroupMode === "user-browser"
      ? "user-browser"
      : value?.browserTaskGroupMode === "off"
        ? "off"
        : existing?.browserTaskGroupMode ?? "off",
    nativeDeliveryMode: value?.nativeDeliveryMode === "background-safe"
      ? "background-safe"
      : value?.nativeDeliveryMode === "foreground-compatible"
        ? "foreground-compatible"
        : existing?.nativeDeliveryMode ?? "foreground-compatible"
  };
}

function normalizeNativeProvider(value: unknown): NativeProviderId {
  if (value === "mock" || value === "macos-accessibility" || value === "windows-ui-automation") return value;
  throw new Error("不支持的原生自动化 Provider");
}

function normalizeNativeAppKind(value: unknown): NativeAppSelectorKind {
  return value === "bundle-id" || value === "path" || value === "process-id" ? value : "name";
}

function normalizeOptionalUrl(value?: string): string | undefined {
  const input = String(value ?? "").trim();
  if (!input) return undefined;
  const normalized = /^https?:\/\//i.test(input) ? input : `https://${input}`;
  const url = new URL(normalized);
  if (!/^https?:$/.test(url.protocol)) throw new Error("UI 操作目标只支持 HTTP/HTTPS URL");
  return url.toString();
}

function isFileNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
