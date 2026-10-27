import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type {
  AgentSession,
  ArtifactInfo,
  BrowserKernel,
  ChatMessage,
  ChatRole,
  ExecutionRuntimeId,
  SessionStatus,
  TestOutcome,
  UploadedFileInfo
} from "./types.js";
import { sessionsDir } from "./paths.js";
import { getDatabase } from "./db/index.js";
import { TABLES } from "./db/schema.js";
import { getSelectedExecutionRuntimeId } from "./modelStore.js";

const SESSION_FILE = "session.json";

// Per-session write lock to prevent concurrent load+save from corrupting state.
// The DB gives us row-level safety, but the read-modify-write cycle in
// appendMessage/appendMessageContent still needs process-level serialization
// to avoid lost updates on the messages array snapshot.
const sessionLocks = new Map<string, Promise<void>>();

function withLock<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
  const prev = sessionLocks.get(sessionId) ?? Promise.resolve();
  let resolve: () => void;
  const next = new Promise<void>((r) => { resolve = r; });
  sessionLocks.set(sessionId, next);
  return prev.then(async () => {
    try {
      return await fn();
    } finally {
      resolve!();
      if (sessionLocks.get(sessionId) === next) {
        sessionLocks.delete(sessionId);
      }
    }
  });
}

export async function ensureStorage(): Promise<void> {
  await fs.mkdir(sessionsDir, { recursive: true });
}

export function sessionDir(sessionId: string): string {
  return path.join(sessionsDir, sessionId);
}

export function workspaceDir(sessionId: string): string {
  return path.join(sessionDir(sessionId), "workspace");
}

export function uploadsDir(sessionId: string): string {
  return path.join(workspaceDir(sessionId), "uploads");
}

export function sessionFile(sessionId: string): string {
  return path.join(sessionDir(sessionId), SESSION_FILE);
}

interface SessionRow {
  id: string;
  title: string;
  status: string;
  sdk_session_id: string | null;
  workspace_path: string;
  files_json: string;
  last_error: string | null;
  created_at: string;
  updated_at: string;
  test_outcome: string | null;
  test_summary: string | null;
  kind: string | null;
  browser_kernel: string | null;
  execution_runtime_id: string | null;
}

interface ChatMessageRow {
  id: string;
  session_id: string;
  role: string;
  content: string;
  files_json: string | null;
  meta_json: string | null;
  created_at: string;
  seq: number;
}

interface ArtifactRow {
  id: string;
  session_id: string;
  name: string;
  relative_path: string;
  size: number;
  modified_at: string;
  kind: string;
  is_core_report: number;
}

function parseJson<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function rowToSession(
  row: SessionRow,
  messages: ChatMessage[],
  artifacts: ArtifactInfo[]
): AgentSession {
  return {
    id: row.id,
    title: row.title,
    status: row.status as SessionStatus,
    sdkSessionId: row.sdk_session_id ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    workspacePath: row.workspace_path,
    messages,
    files: parseJson<UploadedFileInfo[]>(row.files_json, []),
    artifacts,
    lastError: row.last_error ?? undefined,
    testOutcome: (row.test_outcome as TestOutcome | null) ?? undefined,
    testSummary: row.test_summary ?? undefined,
    kind: row.kind === "cdp" ? "cdp" : undefined,
    browserKernel: normalizeBrowserKernel(row.browser_kernel, row.kind),
    executionRuntimeId: normalizeExecutionRuntimeId(row.execution_runtime_id)
  };
}

export function normalizeBrowserKernel(value: string | null | undefined, legacyKind?: string | null): BrowserKernel {
  if (value === "skill-profile" || value === "external-cdp" || value === "uiwarden-embedded" || value === "gui-computer") return value;
  return legacyKind === "cdp" ? "external-cdp" : "playwright";
}

function normalizeExecutionRuntimeId(value: string | null | undefined): ExecutionRuntimeId | undefined {
  return value === "cfuse" || value === "codex" || value === "dtcoder" || value === "claude-code"
    ? value
    : undefined;
}

function messageRowToChatMessage(row: ChatMessageRow): ChatMessage {
  return {
    id: row.id,
    role: row.role as ChatRole,
    content: row.content,
    createdAt: row.created_at,
    files: parseJson<UploadedFileInfo[] | undefined>(row.files_json, undefined),
    meta: parseJson<Record<string, unknown> | undefined>(row.meta_json, undefined)
  };
}

function artifactRowToInfo(row: ArtifactRow): ArtifactInfo {
  return {
    id: row.id,
    name: row.name,
    relativePath: row.relative_path,
    size: row.size,
    modifiedAt: row.modified_at,
    kind: row.kind === "directory" ? "directory" : "file",
    isCoreReport: Boolean(row.is_core_report),
  };
}

async function loadMessages(k: ReturnType<typeof getDatabaseSync>["knex"], sessionId: string): Promise<ChatMessage[]> {
  const rows = await k<ChatMessageRow>(TABLES.chatMessages)
    .where({ session_id: sessionId })
    .orderBy("seq", "asc")
    .orderBy("created_at", "asc");
  return rows.map(messageRowToChatMessage);
}

async function loadArtifacts(k: ReturnType<typeof getDatabaseSync>["knex"], sessionId: string): Promise<ArtifactInfo[]> {
  const rows = await k<ArtifactRow>(TABLES.sessionArtifacts)
    .where({ session_id: sessionId });
  return rows.map(artifactRowToInfo);
}

// P1 性能修复：写操作（appendMessage/updateSessionStatus/updateMessageMeta/
// appendMessageContent）此前以 loadSession 收尾，把该会话【全部历史消息】重新
// 读一遍再返回。运行中 SSE 每追加一条消息就触发一次全量回读，单会话消息数 n 大
// 时呈 O(n²)。这些返回值实际只被 index.ts 用作 runAgentTurn 的 session 载体，
// 而 runAgentForSession 只读 session.id/workspacePath/sdkSessionId，从不读
// session.messages。因此改为只查 sessions 表一行构造轻量会话（messages/artifacts
// 为空数组），语义不变但消除全量回读。需要完整会话仍走 loadSession/GET :id。
async function loadSessionLight(
  k: import("knex").Knex,
  sessionId: string
): Promise<AgentSession> {
  const row = await k<SessionRow>(TABLES.sessions).where({ id: sessionId }).first();
  if (!row) {
    throw new Error(`Session not found: ${sessionId}`);
  }
  return rowToSession(row, [], []);
}

// Avoid circular import: define a lightweight sync accessor. The runtime is
// initialized at startup before any storage call, so this is safe.
function getDatabaseSync(): { knex: import("knex").Knex } {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const mod = require("./db/index.js") as typeof import("./db/index.js");
  return { knex: mod.getDatabaseSync().knex };
}

export async function createSession(
  title?: string,
  browserKernel: BrowserKernel = "playwright",
  legacyKind?: "chat" | "cdp",
  executionRuntimeOverride?: ExecutionRuntimeId
): Promise<AgentSession> {
  await ensureStorage();
  const id = randomUUID();
  const now = new Date().toISOString();
  const workspacePath = workspaceDir(id);
  const executionRuntimeId = executionRuntimeOverride ?? await getSelectedExecutionRuntimeId();
  await fs.mkdir(path.join(workspacePath, "uploads"), { recursive: true });
  const session: AgentSession = {
    id,
    title: normalizeTitle(title) ?? (browserKernel === "external-cdp"
      ? "CDP 直连会话"
      : browserKernel === "gui-computer" ? "本机 gui-browser 会话" : "新的 UI 测试会话"),
    status: "idle",
    kind: legacyKind === "cdp" || browserKernel === "external-cdp" ? "cdp" : undefined,
    browserKernel,
    executionRuntimeId,
    createdAt: now,
    updatedAt: now,
    workspacePath,
    messages: [],
    files: [],
    artifacts: []
  };
  const { knex } = await getDatabase();
  await knex<SessionRow>(TABLES.sessions).insert({
    id: session.id,
    title: session.title,
    status: session.status,
    sdk_session_id: null,
    workspace_path: session.workspacePath,
    files_json: "[]",
    last_error: null,
    created_at: session.createdAt,
    updated_at: session.updatedAt,
    test_outcome: null,
    test_summary: null,
    kind: session.kind ?? null,
    browser_kernel: session.browserKernel,
    execution_runtime_id: session.executionRuntimeId ?? null
  });
  return session;
}

export async function updateSessionBrowserKernel(
  sessionId: string,
  browserKernel: BrowserKernel
): Promise<AgentSession> {
  return withLock(sessionId, async () => {
    const { knex } = await getDatabase();
    await knex<SessionRow>(TABLES.sessions).where({ id: sessionId }).update({
      browser_kernel: browserKernel,
      kind: browserKernel === "external-cdp" ? "cdp" : null,
      updated_at: new Date().toISOString()
    });
    return loadSession(sessionId);
  });
}

export async function listSessions(): Promise<AgentSession[]> {
  await ensureStorage();
  const { knex } = await getDatabase();
  const rows = await knex<SessionRow>(TABLES.sessions)
    .select("*")
    .orderBy("updated_at", "desc");
  const result: AgentSession[] = [];
  for (const row of rows) {
    const [messages, artifacts] = await Promise.all([
      loadMessages(knex, row.id),
      loadArtifacts(knex, row.id)
    ]);
    result.push(rowToSession(row, messages, artifacts));
  }
  return result;
}

// P0 性能修复：会话列表接口只需展示层元信息（id/title/status/updatedAt/testOutcome
// 等），不需要每个会话的全量 messages/artifacts。原 listSessions() 对每个会话
// 串行拉取完整聊天记录（含 MEDIUMTEXT 正文）+ 产物，会话累积后是最严重的
// 全表 N+1；叠加前端运行中会话每 2s 轮询，会把整库对话内容反复载入内存。
// listSessionSummaries() 只查 sessions 表一行，带上限，messages/artifacts 返回
// 空数组（保持 AgentSession 形状以兼容前端类型；正文由 GET /api/sessions/:id 按需拉）。
const DEFAULT_SESSION_LIST_LIMIT = resolvePositiveIntEnv(
  "UI_AGENT_SESSION_LIST_LIMIT",
  200
);

function resolvePositiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export async function listSessionSummaries(): Promise<AgentSession[]> {
  await ensureStorage();
  const { knex } = await getDatabase();
  const rows = await knex<SessionRow>(TABLES.sessions)
    .select("*")
    .orderBy("updated_at", "desc")
    .limit(DEFAULT_SESSION_LIST_LIMIT);
  return rows.map((row) => rowToSession(row, [], []));
}

/** 批量统计会话文件产物数量，供质量看板使用，避免逐会话加载产物正文。 */
export async function getSessionArtifactCounts(sessionIds: string[]): Promise<Map<string, number>> {
  if (!sessionIds.length) return new Map();
  const { knex } = await getDatabase();
  const rows = await knex<ArtifactRow>(TABLES.sessionArtifacts)
    .select("session_id")
    .count<{ session_id: string; count: number | string }[]>({ count: "id" })
    .whereIn("session_id", sessionIds)
    .andWhere({ kind: "file" })
    .groupBy("session_id");
  return new Map(rows.map((row) => [row.session_id, Number(row.count) || 0]));
}

export async function loadSession(sessionId: string): Promise<AgentSession> {
  const { knex } = await getDatabase();
  const row = await knex<SessionRow>(TABLES.sessions).where({ id: sessionId }).first();
  if (!row) {
    throw new Error(`Session not found: ${sessionId}`);
  }
  const [messages, artifacts] = await Promise.all([
    loadMessages(knex, sessionId),
    loadArtifacts(knex, sessionId)
  ]);
  return rowToSession(row, messages, artifacts);
}

export async function deleteSession(sessionId: string): Promise<void> {
  const { knex } = await getDatabase();
  await knex.transaction(async (trx) => {
    await trx<ArtifactRow>(TABLES.sessionArtifacts).where({ session_id: sessionId }).del();
    await trx<ChatMessageRow>(TABLES.chatMessages).where({ session_id: sessionId }).del();
    await trx<SessionRow>(TABLES.sessions).where({ id: sessionId }).del();
  });
  // Remove workspace files on disk too.
  await fs.rm(sessionDir(sessionId), { recursive: true, force: true }).catch(() => undefined);
}

export async function saveSession(session: AgentSession): Promise<void> {
  const { knex } = await getDatabase();
  session.updatedAt = new Date().toISOString();
  await knex<SessionRow>(TABLES.sessions)
    .where({ id: session.id })
    .update({
      title: session.title,
      status: session.status,
      sdk_session_id: session.sdkSessionId ?? null,
      files_json: JSON.stringify(session.files ?? []),
      last_error: session.lastError ?? null,
      updated_at: session.updatedAt
    });
}

export async function appendMessage(sessionId: string, message: ChatMessage): Promise<AgentSession> {
  return withLock(sessionId, async () => {
    const { knex } = await getDatabase();
    const row = await knex<SessionRow>(TABLES.sessions).where({ id: sessionId }).first();
    if (!row) {
      throw new Error(`Session not found: ${sessionId}`);
    }
    // seq 取当前最大值 +1（避免全量拉 messages 只为拿 length）。
    const maxRow = await knex<ChatMessageRow>(TABLES.chatMessages)
      .where({ session_id: sessionId })
      .max<{ maxSeq: number | null }>("seq as maxSeq")
      .first();
    const seq = (maxRow?.maxSeq ?? -1) + 1;
    await knex<ChatMessageRow>(TABLES.chatMessages).insert({
      id: message.id,
      session_id: sessionId,
      role: message.role,
      content: message.content,
      files_json: message.files ? JSON.stringify(message.files) : null,
      meta_json: message.meta ? JSON.stringify(message.meta) : null,
      created_at: message.createdAt,
      seq
    });
    const now = new Date().toISOString();
    let title = row.title;
    if (message.role === "user" && row.title === "新的 UI 测试会话") {
      title = normalizeTitle(message.content) ?? row.title;
    }
    await knex<SessionRow>(TABLES.sessions)
      .where({ id: sessionId })
      .update({ title, updated_at: now });
    console.log(`[storage] appendMessage: session=${sessionId.slice(0, 8)} role=${message.role} seq=${seq}`);
    return rowToSession({ ...row, title, updated_at: now }, [], []);
  });
}

export async function appendMessageContent(
  sessionId: string,
  messageId: string,
  contentDelta: string
): Promise<AgentSession> {
  return withLock(sessionId, async () => {
    const { knex } = await getDatabase();
    const row = await knex<ChatMessageRow>(TABLES.chatMessages)
      .where({ id: messageId, session_id: sessionId })
      .first();
    if (!row) {
      return loadSessionLight(knex, sessionId);
    }
    await knex<ChatMessageRow>(TABLES.chatMessages)
      .where({ id: messageId })
      .update({ content: row.content + contentDelta });
    await knex<SessionRow>(TABLES.sessions)
      .where({ id: sessionId })
      .update({ updated_at: new Date().toISOString() });
    return loadSessionLight(knex, sessionId);
  });
}

export async function updateMessageMeta(
  sessionId: string,
  messageId: string,
  meta: Record<string, unknown>
): Promise<AgentSession> {
  return withLock(sessionId, async () => {
    const { knex } = await getDatabase();
    const row = await knex<ChatMessageRow>(TABLES.chatMessages)
      .where({ id: messageId, session_id: sessionId })
      .first();
    if (!row) {
      return loadSessionLight(knex, sessionId);
    }
    const existing = parseJson<Record<string, unknown>>(row.meta_json, {});
    await knex<ChatMessageRow>(TABLES.chatMessages)
      .where({ id: messageId })
      .update({ meta_json: JSON.stringify({ ...existing, ...meta }) });
    return loadSessionLight(knex, sessionId);
  });
}

export async function updateSessionStatus(
  sessionId: string,
  status: SessionStatus,
  patch: Partial<AgentSession> = {}
): Promise<AgentSession> {
  return withLock(sessionId, async () => {
    const { knex } = await getDatabase();
    const now = new Date().toISOString();
    const update: Partial<SessionRow> = { status, updated_at: now };
    if (patch.sdkSessionId !== undefined) update.sdk_session_id = patch.sdkSessionId;
    if (patch.lastError !== undefined) update.last_error = patch.lastError;
    if (patch.title !== undefined) update.title = patch.title;
    if (patch.testOutcome !== undefined) update.test_outcome = patch.testOutcome;
    if (patch.testSummary !== undefined) update.test_summary = patch.testSummary;
    if (patch.executionRuntimeId !== undefined) update.execution_runtime_id = patch.executionRuntimeId;
    await knex<SessionRow>(TABLES.sessions).where({ id: sessionId }).update(update);
    console.log(`[storage] updateSessionStatus: session=${sessionId.slice(0, 8)} status=${status} patchKeys=${Object.keys(patch).join(",")}`);
    return loadSessionLight(knex, sessionId);
  });
}

export async function addUploadedFiles(
  sessionId: string,
  files: UploadedFileInfo[]
): Promise<AgentSession> {
  return withLock(sessionId, async () => {
    const { knex } = await getDatabase();
    const row = await knex<SessionRow>(TABLES.sessions).where({ id: sessionId }).first();
    if (!row) {
      throw new Error(`Session not found: ${sessionId}`);
    }
    const existingFiles = parseJson<UploadedFileInfo[]>(row.files_json, []);
    const nextFiles = [...existingFiles, ...files];
    const now = new Date().toISOString();
    await knex<SessionRow>(TABLES.sessions)
      .where({ id: sessionId })
      .update({
        files_json: JSON.stringify(nextFiles),
        updated_at: now
      });
    return rowToSession({ ...row, files_json: JSON.stringify(nextFiles), updated_at: now }, [], []);
  });
}

export async function refreshArtifacts(sessionId: string): Promise<ArtifactInfo[]> {
  return withLock(sessionId, async () => {
    const { knex } = await getDatabase();
    const session = await loadSession(sessionId);
    const artifacts = await scanArtifacts(session.workspacePath);
    // Replace all artifact rows for this session.
    await knex.transaction(async (trx) => {
      await trx<ArtifactRow>(TABLES.sessionArtifacts).where({ session_id: sessionId }).del();
      if (artifacts.length) {
        await trx<ArtifactRow>(TABLES.sessionArtifacts).insert(
          artifacts.map((a) => ({
            id: a.id,
            session_id: sessionId,
            name: a.name,
            relative_path: a.relativePath,
            size: a.size,
            modified_at: a.modifiedAt,
            kind: a.kind,
            is_core_report: a.isCoreReport ? 1 : 0
          }))
        );
      }
      await trx<SessionRow>(TABLES.sessions)
        .where({ id: sessionId })
        .update({ updated_at: new Date().toISOString() });
    });
    return artifacts;
  });
}

async function scanArtifacts(workspacePath: string): Promise<ArtifactInfo[]> {
  const candidates = [
    ".skill-output",
    "reports",
    "output",
    "outputs",
    "artifacts",
    "uploads",
    ".uiwarden-screenshots"
  ];
  const artifacts: ArtifactInfo[] = [];
  for (const candidate of candidates) {
    const full = path.join(workspacePath, candidate);
    try {
      await collectArtifacts(workspacePath, full, artifacts);
    } catch {
      // Missing artifact roots are expected for new sessions.
    }
  }
  return artifacts.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
}

async function collectArtifacts(root: string, current: string, artifacts: ArtifactInfo[]): Promise<void> {
  const stat = await fs.stat(current);
  const relativePath = path.relative(root, current);
  if (relativePath) {
    artifacts.push({
      id: encodeURIComponent(relativePath),
      name: path.basename(current),
      relativePath,
      size: stat.size,
      modifiedAt: stat.mtime.toISOString(),
      kind: stat.isDirectory() ? "directory" : "file",
      isCoreReport: isCoreHtmlReport(relativePath)
    });
  }
  if (!stat.isDirectory()) {
    return;
  }
  const entries = await fs.readdir(current, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === ".DS_Store" || entry.name === "__pycache__") {
      continue;
    }
    await collectArtifacts(root, path.join(current, entry.name), artifacts);
  }
}

function isCoreHtmlReport(relativePath: string): boolean {
  const normalized = relativePath.replaceAll("\\", "/");
  const fileName = path.basename(normalized).toLowerCase();
  return (
    normalized.includes("/attempt_") &&
    fileName.endsWith(".html") &&
    (fileName.includes("quick_task_report") || fileName.includes("report_success"))
  );
}

export function createMessage(
  role: ChatRole,
  content: string,
  patch: Partial<ChatMessage> = {}
): ChatMessage {
  return {
    id: randomUUID(),
    role,
    content,
    createdAt: new Date().toISOString(),
    ...patch
  };
}

function normalizeTitle(title?: string): string | undefined {
  const text = title?.trim().replace(/\s+/g, " ");
  if (!text) {
    return undefined;
  }
  return text.length > 28 ? `${text.slice(0, 28)}...` : text;
}
