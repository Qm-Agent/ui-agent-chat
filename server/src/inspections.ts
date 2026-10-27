import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { inspectionsDir } from "./paths.js";
import { isDesktopMode } from "./runtimeMode.js";
import { getDatabase } from "./db/index.js";
import { TABLES } from "./db/schema.js";
import type {
  InspectionRun,
  InspectionRunStatus,
  InspectionRunTrigger,
  InspectionTask,
  InspectionNotifyTrigger,
  NotifyStatus,
  PublicInspectionTask,
  TestOutcome
} from "./types.js";

const DEFAULT_INTERVAL_MINUTES = 180;
const MIN_INTERVAL_MINUTES = 5;
const DEFAULT_CRON_EXPRESSION = "0 */3 * * *";

// 巡检任务列表默认返回条数上限，避免无分页全表扫描。可用环境变量覆盖。
function resolvePositiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}
const DEFAULT_TASK_LIST_LIMIT = resolvePositiveIntEnv("UI_AGENT_INSPECTION_TASK_LIST_LIMIT", 200);
// 列表接口里每个任务最多携带的最近 run 数。详情页分页每页 30，此上限足够首屏且避免把
// 单任务上千条历史全部塞进列表响应体。单任务详情如需更多可走 GET /api/inspection-tasks/:id。
const RUNS_PER_TASK_IN_LIST = resolvePositiveIntEnv("UI_AGENT_INSPECTION_RUNS_PER_TASK", 50);

export async function ensureInspectionStorage(): Promise<void> {
  await fs.mkdir(inspectionsDir, { recursive: true });
}

export function defaultInspectionPrompt(url: string): string {
  return `请对 ${url} 做一次通用页面巡检。

巡检目标：
1. 打开页面并确认页面可访问、无明显白屏、报错页、资源加载异常。
2. 检查首屏核心内容、导航、按钮、表单输入等关键交互是否正常。
3. 如果提供了账号和密码，先完成登录，再巡检登录后的主页面。
4. 记录关键截图、错误信息、控制台异常和网络失败请求。
5. 结束时输出通过/失败结论、主要风险点和产物路径。`;
}

interface InspectionTaskRow {
  id: string;
  name: string;
  url: string;
  business_id: string | null;
  username: string | null;
  password: string | null;
  prompt: string | null;
  schedule_enabled: number;
  schedule_mode: string | null;
  interval_minutes: number | null;
  cron_expression: string | null;
  next_run_at: string | null;
  status: string;
  last_run_at: string | null;
  last_status: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
  notify_robot_id: string | null;
  notify_trigger: string | null;
}

interface InspectionRunRow {
  id: string;
  task_id: string;
  session_id: string;
  trigger: string;
  status: string;
  started_at: string;
  finished_at: string | null;
  summary: string | null;
  error: string | null;
  artifacts_count: number | null;
  logs_json: string | null;
  test_outcome: string | null;
  notify_status: string | null;
  notify_message: string | null;
  seq: number;
}

function rowToTask(row: InspectionTaskRow, runs: InspectionRun[]): InspectionTask {
  return {
    id: row.id,
    name: row.name,
    url: row.url,
    businessId: row.business_id ?? undefined,
    username: row.username ?? undefined,
    password: row.password ?? undefined,
    prompt: row.prompt ?? undefined,
    scheduleEnabled: Boolean(row.schedule_enabled),
    scheduleMode: row.schedule_mode === "interval" ? "interval" : row.schedule_mode === "cron" ? "cron" : undefined,
    intervalMinutes: row.interval_minutes ?? undefined,
    cronExpression: row.cron_expression ?? undefined,
    nextRunAt: row.next_run_at ?? undefined,
    status: row.status as InspectionTask["status"],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastRunAt: row.last_run_at ?? undefined,
    lastStatus: row.last_status as InspectionRunStatus | undefined,
    lastError: row.last_error ?? undefined,
    notifyRobotId: row.notify_robot_id ?? undefined,
    notifyTrigger: (row.notify_trigger as InspectionNotifyTrigger | null) ?? undefined,
    runs
  };
}

function runRowToRun(row: InspectionRunRow): InspectionRun {
  return {
    id: row.id,
    taskId: row.task_id,
    sessionId: row.session_id,
    trigger: row.trigger as InspectionRunTrigger,
    status: row.status as InspectionRunStatus,
    startedAt: row.started_at,
    finishedAt: row.finished_at ?? undefined,
    summary: row.summary ?? undefined,
    error: row.error ?? undefined,
    artifactsCount: row.artifacts_count ?? undefined,
    logs: row.logs_json ? safeParseLogs(row.logs_json) : undefined,
    testOutcome: (row.test_outcome as TestOutcome | null) ?? undefined,
    notifyStatus: (row.notify_status as NotifyStatus | null) ?? undefined,
    notifyMessage: row.notify_message ?? undefined
  };
}

function safeParseLogs(raw: string): string[] | undefined {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map(String) : undefined;
  } catch {
    return undefined;
  }
}

async function loadRuns(taskId: string): Promise<InspectionRun[]> {
  const { knex } = await getDatabase();
  const rows = await knex<InspectionRunRow>(TABLES.inspectionRuns)
    .where({ task_id: taskId })
    .orderBy("seq", "desc")
    .orderBy("started_at", "desc")
    .limit(200);
  return rows.map(runRowToRun);
}

// 批量取回多个任务的 runs，一次 whereIn 消除逐任务串行查询的 N+1 问题。
// 每个任务只保留最近 runsPerTask 条（按 seq/started_at 降序），在内存里按 task_id 分组截断，
// 避免依赖各数据库方言的窗口函数。返回按 task_id 分组、组内已截断且保持降序的 Map。
async function loadRunsForTasks(
  taskIds: string[],
  runsPerTask: number
): Promise<Map<string, InspectionRun[]>> {
  const result = new Map<string, InspectionRun[]>();
  if (taskIds.length === 0) {
    return result;
  }
  const { knex } = await getDatabase();
  const rows = await knex<InspectionRunRow>(TABLES.inspectionRuns)
    .whereIn("task_id", taskIds)
    .orderBy("seq", "desc")
    .orderBy("started_at", "desc");
  for (const row of rows) {
    const bucket = result.get(row.task_id);
    if (bucket) {
      if (bucket.length < runsPerTask) {
        bucket.push(runRowToRun(row));
      }
    } else {
      result.set(row.task_id, [runRowToRun(row)]);
    }
  }
  return result;
}

export async function listInspectionTasks(): Promise<PublicInspectionTask[]> {
  await ensureInspectionStorage();
  const { knex } = await getDatabase();
  const rows = await knex<InspectionTaskRow>(TABLES.inspectionTasks)
    .select("*")
    .orderBy("updated_at", "desc")
    .limit(DEFAULT_TASK_LIST_LIMIT);
  const runsByTask = await loadRunsForTasks(
    rows.map((row) => row.id),
    RUNS_PER_TASK_IN_LIST
  );
  return rows.map((row) => toPublicInspectionTask(rowToTask(row, runsByTask.get(row.id) ?? [])));
}

export async function createInspectionTask(input: {
  name?: string;
  url?: string;
  businessId?: string;
  username?: string;
  password?: string;
  prompt?: string;
  scheduleEnabled?: boolean;
  scheduleMode?: "interval" | "cron";
  intervalMinutes?: number;
  cronExpression?: string;
  notifyRobotId?: string;
  notifyTrigger?: InspectionNotifyTrigger;
}): Promise<PublicInspectionTask> {
  await ensureInspectionStorage();
  const url = normalizeUrl(input.url);
  const now = new Date().toISOString();
  const scheduleEnabled = Boolean(input.scheduleEnabled);
  const scheduleMode = input.scheduleMode === "interval" ? "interval" : "cron";
  const intervalMinutes = normalizeInterval(input.intervalMinutes);
  const cronExpression = normalizeCronExpression(input.cronExpression);
  const nextRunAt = scheduleEnabled
    ? computeNextRunAt({ scheduleMode, intervalMinutes, cronExpression, from: now })
    : undefined;
  const task: InspectionTask = {
    id: randomUUID(),
    name: normalizeText(input.name) ?? defaultTaskName(url),
    url,
    businessId: normalizeText(input.businessId),
    username: normalizeText(input.username),
    password: normalizeText(input.password),
    prompt: normalizeText(input.prompt),
    scheduleEnabled,
    scheduleMode: scheduleEnabled ? scheduleMode : undefined,
    intervalMinutes: scheduleEnabled && scheduleMode === "interval" ? intervalMinutes : undefined,
    cronExpression: scheduleEnabled && scheduleMode === "cron" ? cronExpression : undefined,
    nextRunAt,
    status: scheduleEnabled ? "idle" : "disabled",
    createdAt: now,
    updatedAt: now,
    notifyRobotId: normalizeText(input.notifyRobotId),
    notifyTrigger: normalizeNotifyTrigger(input.notifyTrigger),
    runs: []
  };
  await saveInspectionTask(task);
  return toPublicInspectionTask(task);
}

export async function loadInspectionTask(taskId: string): Promise<InspectionTask> {
  const { knex } = await getDatabase();
  const row = await knex<InspectionTaskRow>(TABLES.inspectionTasks).where({ id: taskId }).first();
  if (!row) {
    throw new Error(`Inspection task not found: ${taskId}`);
  }
  const runs = await loadRuns(taskId);
  return rowToTask(row, runs);
}

export async function getPublicInspectionTask(taskId: string): Promise<PublicInspectionTask> {
  return toPublicInspectionTask(await loadInspectionTask(taskId));
}

export async function updateInspectionTask(taskId: string, input: {
  name?: string;
  url?: string;
  businessId?: string;
  username?: string;
  password?: string;
  prompt?: string;
  scheduleEnabled?: boolean;
  scheduleMode?: "interval" | "cron";
  intervalMinutes?: number;
  cronExpression?: string;
  notifyRobotId?: string;
  notifyTrigger?: InspectionNotifyTrigger;
}): Promise<PublicInspectionTask> {
  const task = await loadInspectionTask(taskId);
  const now = new Date().toISOString();
  if (input.url !== undefined) {
    task.url = normalizeUrl(input.url);
  }
  if (input.name !== undefined) {
    task.name = normalizeText(input.name) ?? defaultTaskName(task.url);
  }
  if (input.businessId !== undefined) {
    task.businessId = normalizeText(input.businessId);
  }
  if (input.username !== undefined) {
    task.username = normalizeText(input.username);
  }
  if (input.password !== undefined) {
    const pw = normalizeText(input.password);
    task.password = pw ?? task.password;
  }
  if (input.prompt !== undefined) {
    task.prompt = normalizeText(input.prompt);
  }
  if (input.scheduleEnabled !== undefined) {
    task.scheduleEnabled = Boolean(input.scheduleEnabled);
  }
  if (input.scheduleMode !== undefined) {
    task.scheduleMode = input.scheduleMode === "interval" ? "interval" : "cron";
  }
  if (input.intervalMinutes !== undefined) {
    task.intervalMinutes = normalizeInterval(input.intervalMinutes);
  }
  if (input.cronExpression !== undefined) {
    task.cronExpression = normalizeCronExpression(input.cronExpression);
  }
  if (input.notifyRobotId !== undefined) {
    task.notifyRobotId = normalizeText(input.notifyRobotId);
  }
  if (input.notifyTrigger !== undefined) {
    task.notifyTrigger = normalizeNotifyTrigger(input.notifyTrigger);
  }
  if (task.scheduleEnabled) {
    const scheduleMode = task.scheduleMode ?? "cron";
    task.scheduleMode = scheduleMode;
    task.intervalMinutes = scheduleMode === "interval" ? (task.intervalMinutes ?? DEFAULT_INTERVAL_MINUTES) : undefined;
    task.cronExpression = scheduleMode === "cron" ? (task.cronExpression ?? DEFAULT_CRON_EXPRESSION) : undefined;
    task.nextRunAt = computeNextRunAt({
      scheduleMode,
      intervalMinutes: task.intervalMinutes ?? DEFAULT_INTERVAL_MINUTES,
      cronExpression: task.cronExpression ?? DEFAULT_CRON_EXPRESSION,
      from: now
    });
    if (task.status !== "running") {
      task.status = "idle";
    }
  } else {
    task.scheduleMode = undefined;
    task.intervalMinutes = undefined;
    task.cronExpression = undefined;
    task.nextRunAt = undefined;
    if (task.status !== "running") {
      task.status = "disabled";
    }
  }
  task.updatedAt = now;
  await saveInspectionTask(task);
  return toPublicInspectionTask(task);
}

export async function saveInspectionTask(task: InspectionTask): Promise<void> {
  const { knex } = await getDatabase();
  const now = new Date().toISOString();
  task.updatedAt = now;
  const row: Partial<InspectionTaskRow> = {
    id: task.id,
    name: task.name,
    url: task.url,
    business_id: task.businessId ?? null,
    username: task.username ?? null,
    password: task.password ?? null,
    prompt: task.prompt ?? null,
    schedule_enabled: task.scheduleEnabled ? 1 : 0,
    schedule_mode: task.scheduleMode ?? null,
    interval_minutes: task.intervalMinutes ?? null,
    cron_expression: task.cronExpression ?? null,
    next_run_at: task.nextRunAt ?? null,
    status: task.status,
    last_run_at: task.lastRunAt ?? null,
    last_status: task.lastStatus ?? null,
    last_error: task.lastError ?? null,
    created_at: task.createdAt,
    updated_at: task.updatedAt,
    notify_robot_id: task.notifyRobotId ?? null,
    notify_trigger: task.notifyTrigger ?? null
  };
  await knex<InspectionTaskRow>(TABLES.inspectionTasks)
    .insert(row)
    .onConflict("id")
    .merge();
  // Persist the runs[] snapshot (used by migration + legacy callers).
  if (task.runs.length) {
    await knex.transaction(async (trx) => {
      for (const run of task.runs) {
        await trx<InspectionRunRow>(TABLES.inspectionRuns)
          .insert({
            id: run.id,
            task_id: task.id,
            session_id: run.sessionId,
            trigger: run.trigger,
            status: run.status,
            started_at: run.startedAt,
            finished_at: run.finishedAt ?? null,
            summary: run.summary ?? null,
            error: run.error ?? null,
            artifacts_count: run.artifactsCount ?? null,
            logs_json: run.logs ? JSON.stringify(run.logs) : null,
            seq: 0
          })
          .onConflict("id")
          .merge();
      }
    });
  }
}

export async function deleteInspectionTask(taskId: string): Promise<void> {
  const { knex } = await getDatabase();
  await knex.transaction(async (trx) => {
    await trx<InspectionRunRow>(TABLES.inspectionRuns).where({ task_id: taskId }).del();
    const deleted = await trx<InspectionTaskRow>(TABLES.inspectionTasks).where({ id: taskId }).del();
    if (deleted === 0) {
      throw new Error(`Inspection task not found: ${taskId}`);
    }
  });
  await fs.rm(taskDir(taskId), { recursive: true, force: true }).catch(() => undefined);
}

export async function createInspectionRun(
  taskId: string,
  sessionId: string,
  trigger: InspectionRunTrigger
): Promise<InspectionRun> {
  const { knex } = await getDatabase();
  const now = new Date().toISOString();
  const run: InspectionRun = {
    id: randomUUID(),
    taskId,
    sessionId,
    trigger,
    status: "running",
    startedAt: now
  };
  // Determine the next seq number for ordering.
  const lastRun = await knex<InspectionRunRow>(TABLES.inspectionRuns)
    .where({ task_id: taskId })
    .orderBy("seq", "desc")
    .first();
  const seq = lastRun ? lastRun.seq + 1 : 0;
  await knex.transaction(async (trx) => {
    await trx<InspectionRunRow>(TABLES.inspectionRuns).insert({
      id: run.id,
      task_id: taskId,
      session_id: sessionId,
      trigger,
      status: "running",
      started_at: now,
      finished_at: null,
      summary: null,
      error: null,
      artifacts_count: null,
      logs_json: null,
      test_outcome: null,
      notify_status: null,
      notify_message: null,
      seq
    });
    await trx<InspectionTaskRow>(TABLES.inspectionTasks).where({ id: taskId }).update({
      status: "running",
      last_run_at: now,
      last_status: "running",
      last_error: null,
      updated_at: now
    });
  });
  return run;
}

export async function finishInspectionRun(
  taskId: string,
  runId: string,
  patch: {
    status: Exclude<InspectionRunStatus, "running">;
    summary?: string;
    error?: string;
    artifactsCount?: number;
    testOutcome?: TestOutcome;
    notifyStatus?: NotifyStatus;
    notifyMessage?: string;
  }
): Promise<void> {
  const { knex } = await getDatabase();
  const now = new Date().toISOString();
  const task = await loadInspectionTask(taskId);
  const nextRunAt = task.scheduleEnabled
    ? computeNextRunAt({
        scheduleMode: task.scheduleMode ?? "interval",
        intervalMinutes: task.intervalMinutes ?? DEFAULT_INTERVAL_MINUTES,
        cronExpression: task.cronExpression ?? DEFAULT_CRON_EXPRESSION,
        from: now
      })
    : undefined;
  await knex.transaction(async (trx) => {
    await trx<InspectionRunRow>(TABLES.inspectionRuns).where({ id: runId }).update({
      status: patch.status,
      summary: patch.summary ?? null,
      error: patch.error ?? null,
      artifacts_count: patch.artifactsCount ?? null,
      test_outcome: patch.testOutcome ?? null,
      notify_status: patch.notifyStatus ?? null,
      notify_message: patch.notifyMessage ?? null,
      finished_at: now
    });
    await trx<InspectionTaskRow>(TABLES.inspectionTasks).where({ id: taskId }).update({
      status: task.scheduleEnabled ? "idle" : "disabled",
      last_status: patch.status,
      last_error: patch.error ?? null,
      next_run_at: nextRunAt ?? null,
      updated_at: now
    });
  });
}

export async function rescheduleInspectionTask(taskId: string): Promise<void> {
  const { knex } = await getDatabase();
  const task = await loadInspectionTask(taskId);
  if (!task.scheduleEnabled) {
    return;
  }
  const nextRunAt = computeNextRunAt({
    scheduleMode: task.scheduleMode ?? "interval",
    intervalMinutes: task.intervalMinutes ?? DEFAULT_INTERVAL_MINUTES,
    cronExpression: task.cronExpression ?? DEFAULT_CRON_EXPRESSION,
    from: new Date().toISOString()
  });
  await knex<InspectionTaskRow>(TABLES.inspectionTasks).where({ id: taskId }).update({
    next_run_at: nextRunAt,
    updated_at: new Date().toISOString()
  });
}

export function buildInspectionPrompt(task: InspectionTask): string {
  const basePrompt = task.prompt?.trim() || defaultInspectionPrompt(task.url);
  const desktopSection = isDesktopMode()
    ? `\n\n**桌面客户端本地模式**：本服务运行在用户本机，巡检默认**无头模式**执行（不加 \`--headed\`），避免定时巡检弹出浏览器窗口打扰用户；仅当任务提示词明确要求有头/可视化时才追加 \`--headed\`。`
    : "";
  const loginSection = task.username
    ? `\n\n登录信息：\n- 账号：${task.username}\n- 密码：${task.password ? task.password : "未提供"}`
    : "\n\n登录信息：未提供账号密码，如页面需要登录请在结果中说明阻塞原因。";
  return `${basePrompt}

被巡检 URL：${task.url}${loginSection}

执行要求：
- 优先使用 ui-test-assistant-skill 完成巡检。
- 调用 quick/巡检/冒烟脚本时必须显式传入目标 URL，不要使用环境变量里的默认 URL 覆盖本任务 URL。
- 如巡检失败，请保留截图、日志和错误说明；后续系统会基于失败记录扩展钉钉通知。

**run_quick_mode.py 参数规则（必须严格遵守）：**
- 巡检模式使用 \`--health-check\`，冒烟模式使用 \`--smoke-walkthrough\`。
- 有账号密码时加 \`--username <账号> --password <密码>\`；无账号密码时加 \`--no-login\`。
- \`--headless\` 和 \`--headed\` 是开关标志，**不加值**。正确：\`--headless\`。错误：\`--headless true\`。**禁止**使用 \`--no-headless\`。
- **禁止**直接调用 \`python3 -m browser_use.cli\`，**必须**通过 \`run_quick_mode.py\` 执行。
- 标准巡检命令：\`python3 .claude/skills/ui-test-assistant-skill/package/scripts/run_quick_mode.py --query "巡检 <URL>" --target-url "<URL>" --health-check --no-login --output-dir .skill-output/quick 2>&1 | tee -a .skill-output/uiwarden-live.log\`${desktopSection}`;
}

export function toPublicInspectionTask(task: InspectionTask): PublicInspectionTask {
  const { password: _password, ...publicTask } = task;
  const hasPassword = Boolean(task.password);
  return {
    ...publicTask,
    hasPassword,
    passwordMasked: hasPassword ? "******" : undefined
  };
}

function taskDir(taskId: string): string {
  return path.join(inspectionsDir, taskId);
}

function normalizeUrl(value?: string): string {
  const text = value?.trim();
  if (!text) {
    throw new Error("请填写巡检 URL");
  }
  return /^https?:\/\//i.test(text) ? text : `https://${text}`;
}

function normalizeText(value?: string): string | undefined {
  const text = value?.trim();
  return text ? text : undefined;
}

function normalizeInterval(value?: number): number {
  const interval = Number(value ?? DEFAULT_INTERVAL_MINUTES);
  if (!Number.isFinite(interval)) {
    return DEFAULT_INTERVAL_MINUTES;
  }
  return Math.max(MIN_INTERVAL_MINUTES, Math.floor(interval));
}

function addMinutes(value: string, minutes: number): string {
  return new Date(new Date(value).getTime() + minutes * 60_000).toISOString();
}

function normalizeCronExpression(value?: string): string {
  const expression = normalizeText(value) ?? DEFAULT_CRON_EXPRESSION;
  parseCronExpression(expression);
  return expression;
}

function computeNextRunAt(params: {
  scheduleMode: "interval" | "cron";
  intervalMinutes: number;
  cronExpression: string;
  from: string;
}): string {
  if (params.scheduleMode === "interval") {
    return addMinutes(params.from, params.intervalMinutes);
  }
  return nextCronRunAt(params.cronExpression, new Date(params.from)).toISOString();
}

function nextCronRunAt(expression: string, from: Date): Date {
  const matcher = parseCronExpression(expression);
  const candidate = new Date(from.getTime() + 60_000);
  candidate.setSeconds(0, 0);
  const deadline = new Date(from.getTime() + 366 * 24 * 60 * 60_000);
  while (candidate <= deadline) {
    if (
      matcher.minute.has(candidate.getMinutes()) &&
      matcher.hour.has(candidate.getHours()) &&
      matcher.dayOfMonth.has(candidate.getDate()) &&
      matcher.month.has(candidate.getMonth() + 1) &&
      matcher.dayOfWeek.has(candidate.getDay())
    ) {
      return candidate;
    }
    candidate.setMinutes(candidate.getMinutes() + 1);
  }
  throw new Error("cron 表达式一年内没有可执行时间");
}

function parseCronExpression(expression: string): {
  minute: Set<number>;
  hour: Set<number>;
  dayOfMonth: Set<number>;
  month: Set<number>;
  dayOfWeek: Set<number>;
} {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new Error("cron 表达式需为 5 字段格式，例如：0 */3 * * *");
  }
  return {
    minute: parseCronField(fields[0], 0, 59, "分钟"),
    hour: parseCronField(fields[1], 0, 23, "小时"),
    dayOfMonth: parseCronField(fields[2], 1, 31, "日期"),
    month: parseCronField(fields[3], 1, 12, "月份"),
    dayOfWeek: parseCronField(fields[4], 0, 7, "星期", true)
  };
}

function parseCronField(
  field: string,
  min: number,
  max: number,
  label: string,
  normalizeSunday = false
): Set<number> {
  const values = new Set<number>();
  for (const part of field.split(",")) {
    const [rangePart, stepPart] = part.split("/");
    const step = stepPart ? Number(stepPart) : 1;
    if (!Number.isInteger(step) || step <= 0) {
      throw new Error(`cron ${label}字段 step 非法`);
    }
    const [start, end] = rangePart === "*"
      ? [min, max]
      : rangePart.includes("-")
        ? rangePart.split("-").map(Number)
        : [Number(rangePart), Number(rangePart)];
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < min || end > max || start > end) {
      throw new Error(`cron ${label}字段范围非法`);
    }
    for (let value = start; value <= end; value += step) {
      values.add(normalizeSunday && value === 7 ? 0 : value);
    }
  }
  return values;
}

function defaultTaskName(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url.slice(0, 40);
  }
}

function normalizeNotifyTrigger(value?: string): InspectionNotifyTrigger | undefined {
  if (value === "always" || value === "failed" || value === "never") {
    return value;
  }
  return undefined;
}
