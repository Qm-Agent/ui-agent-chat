import { randomUUID } from "node:crypto";
import { configDir } from "./paths.js";
import fs from "node:fs/promises";
import { getDatabase } from "./db/index.js";
import { TABLES } from "./db/schema.js";
import { sendDingtalkMarkdown } from "./dingtalk.js";
import type {
  DingtalkRobot,
  InspectionRunStatus,
  NotifyStatus,
  PublicDingtalkRobot,
  RegressionBatchStatus,
  TestOutcome
} from "./types.js";

async function ensureNotifyStorage(): Promise<void> {
  await fs.mkdir(configDir, { recursive: true });
}

interface DingtalkRobotRow {
  id: string;
  name: string;
  webhook_url: string;
  secret: string | null;
  description: string | null;
  inspection_template: string | null;
  regression_template: string | null;
  created_at: string;
  updated_at: string;
}

function rowToRobot(row: DingtalkRobotRow): DingtalkRobot {
  return {
    id: row.id,
    name: row.name,
    webhookUrl: row.webhook_url,
    secret: row.secret ?? undefined,
    description: row.description ?? undefined,
    inspectionTemplate: row.inspection_template ?? undefined,
    regressionTemplate: row.regression_template ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export async function listDingtalkRobots(): Promise<PublicDingtalkRobot[]> {
  await ensureNotifyStorage();
  const { knex } = await getDatabase();
  const rows = await knex<DingtalkRobotRow>(TABLES.dingtalkRobots)
    .select("*")
    .orderBy("updated_at", "desc");
  return rows.map(rowToRobot).map(toPublic);
}

export async function getRobotById(id: string): Promise<DingtalkRobot | null> {
  const { knex } = await getDatabase();
  const row = await knex<DingtalkRobotRow>(TABLES.dingtalkRobots).where({ id }).first();
  return row ? rowToRobot(row) : null;
}

export async function upsertDingtalkRobot(input: {
  id?: string;
  name?: string;
  webhookUrl?: string;
  secret?: string;
  description?: string;
  inspectionTemplate?: string;
  regressionTemplate?: string;
}): Promise<PublicDingtalkRobot> {
  const { knex } = await getDatabase();
  const now = new Date().toISOString();
  const existing = input.id
    ? await knex<DingtalkRobotRow>(TABLES.dingtalkRobots).where({ id: input.id }).first()
    : undefined;

  const name = normalizeText(input.name ?? existing?.name) ?? "未命名机器人";
  // webhookUrl: treat empty or masked value as "unchanged" (same as password),
  // so the secret token is never overwritten when the edit form shows a mask.
  const rawWebhook = normalizeUrl(input.webhookUrl);
  const webhookUnchanged =
    rawWebhook === undefined ||
    isMaskedWebhookUrl(rawWebhook) ||
    (existing?.webhook_url ? rawWebhook === existing.webhook_url : false);
  if (!existing && !rawWebhook) {
    throw new Error("请填写 Webhook URL");
  }
  const webhookUrl = webhookUnchanged
    ? (existing?.webhook_url ?? rawWebhook ?? "")
    : (rawWebhook as string);
  if (!webhookUrl) {
    throw new Error("请填写 Webhook URL");
  }
  let secret = normalizeText(input.secret);
  if (secret === undefined) {
    secret = existing?.secret ?? undefined;
  }
  const description = normalizeText(input.description ?? existing?.description ?? undefined);
  const inspectionTemplate = normalizeText(
    input.inspectionTemplate ?? existing?.inspection_template ?? undefined
  );
  const regressionTemplate = normalizeText(
    input.regressionTemplate ?? existing?.regression_template ?? undefined
  );

  const robot: DingtalkRobot = {
    id: existing?.id ?? randomUUID(),
    name,
    webhookUrl,
    secret,
    description,
    inspectionTemplate,
    regressionTemplate,
    createdAt: existing?.created_at ?? now,
    updatedAt: now
  };

  await knex<DingtalkRobotRow>(TABLES.dingtalkRobots)
    .insert({
      id: robot.id,
      name: robot.name,
      webhook_url: robot.webhookUrl,
      secret: robot.secret ?? null,
      description: robot.description ?? null,
      inspection_template: robot.inspectionTemplate ?? null,
      regression_template: robot.regressionTemplate ?? null,
      created_at: robot.createdAt,
      updated_at: robot.updatedAt
    })
    .onConflict("id")
    .merge({
      name: robot.name,
      webhook_url: robot.webhookUrl,
      secret: robot.secret ?? null,
      description: robot.description ?? null,
      inspection_template: robot.inspectionTemplate ?? null,
      regression_template: robot.regressionTemplate ?? null,
      updated_at: robot.updatedAt
    });
  return toPublic(robot);
}

export async function deleteDingtalkRobot(id: string): Promise<void> {
  const { knex } = await getDatabase();
  const deleted = await knex<DingtalkRobotRow>(TABLES.dingtalkRobots).where({ id }).del();
  if (deleted === 0) {
    throw new Error(`钉钉机器人不存在: ${id}`);
  }
}

export interface RobotTestResult {
  ok: boolean;
  errmsg?: string;
}

export async function testDingtalkRobot(id: string): Promise<RobotTestResult> {
  const robot = await getRobotById(id);
  if (!robot) {
    throw new Error(`钉钉机器人不存在: ${id}`);
  }
  const title = "uiwarden 测试消息";
  const text = `### ${title}\n\n- 机器人：${robot.name}\n- 时间：${new Date().toISOString()}\n- 这是一条来自 uiwarden 的测试推送。`;
  const result = await sendDingtalkMarkdown(robot.webhookUrl, title, text, robot.secret);
  return { ok: result.ok, errmsg: result.errmsg };
}

/**
 * 巡检 run 结束后按触发条件推送钉钉通知。
 *
 * 触发条件：
 * - always：每次巡检结束都通知
 * - failed：仅失败通知（status === "failed"）
 * - never：不通知
 *
 * 通知 markdown 优先使用机器人自带的 inspectionTemplate 渲染；未配置时
 * 回落到默认模板。resultUrl 用于在通知中注入「查看详情」跳转链接。
 */
export async function notifyInspectionResult(params: {
  robotId: string;
  taskName: string;
  taskUrl: string;
  runStatus: InspectionRunStatus;
  testOutcome?: TestOutcome;
  summary?: string;
  error?: string;
  trigger?: string;
  resultUrl?: string;
}): Promise<{ status: NotifyStatus; message: string }> {
  const { robotId, taskName, taskUrl, runStatus, testOutcome, summary, error, trigger, resultUrl } = params;
  const robot = await getRobotById(robotId);
  if (!robot) {
    const message = `钉钉机器人不存在: ${robotId}`;
    console.warn(`[notify] ${message}, skip notification`);
    return { status: "failed", message };
  }
  const outcomeLabel =
    testOutcome === "pass" ? "✅ 测试通过" : testOutcome === "fail" ? "❌ 测试未通过" : "⚠️ 未知结论";
  const execLabel = runStatus === "completed" ? "执行成功" : runStatus === "failed" ? "执行失败" : runStatus;
  const statusLabel = runStatus === "failed" ? "❌ 失败" : testOutcome === "fail" ? "❌ 测试未通过" : testOutcome === "pass" ? "✅ 通过" : execLabel;
  const title = `【巡检结果】${taskName} - ${statusLabel}`;
  const vars: TemplateVars = {
    title: "巡检结果通知",
    taskName,
    taskUrl,
    statusLabel,
    runStatus,
    testOutcome: testOutcome ?? "unknown",
    outcomeLabel,
    execLabel,
    trigger: trigger === "schedule" ? "定时调度" : "手动触发",
    summary: summary ? truncate(summary, 400) : "",
    error: error ? truncate(error, 400) : "",
    time: new Date().toISOString(),
    resultUrl: resultUrl ?? ""
  };
  const { title: renderedTitle, text } = renderTemplate(
    robot.inspectionTemplate,
    DEFAULT_INSPECTION_TEMPLATE,
    title,
    vars
  );
  const result = await sendDingtalkMarkdown(robot.webhookUrl, renderedTitle, text, robot.secret);
  if (!result.ok) {
    const message = result.errmsg ?? "unknown";
    console.error(
      `[notify] dingtalk send failed for robot ${robotId}: ${message}`
    );
    return { status: "failed", message };
  }
  return { status: "sent", message: "已推送" };
}

/**
 * 回归批次结束后按触发条件推送钉钉通知。
 *
 * 触发条件：
 * - always：执行完就通知（不管失败还是成功）
 * - failed：仅批次存在失败用例时通知
 * - never：不通知
 *
 * 通知 markdown 优先使用机器人自带的 regressionTemplate 渲染；未配置时
 * 回落到默认模板。resultUrl 用于在通知中注入「查看详情」跳转链接。
 */
export async function notifyRegressionResult(params: {
  robotId: string;
  batchName: string;
  batchStatus: RegressionBatchStatus;
  total: number;
  completed: number;
  failed: number;
  aborted: number;
  passed?: number;
  assertFailed?: number;
  unknown?: number;
  runs: { caseName: string; status: string; testOutcome?: TestOutcome; error?: string; resultUrl?: string }[];
  resultUrl?: string;
}): Promise<{ status: NotifyStatus; message: string }> {
  const {
    robotId,
    batchName,
    batchStatus,
    total,
    completed,
    failed,
    aborted,
    passed,
    assertFailed,
    unknown,
    runs,
    resultUrl
  } = params;
  const robot = await getRobotById(robotId);
  if (!robot) {
    const message = `钉钉机器人不存在: ${robotId}`;
    console.warn(`[notify] ${message}, skip notification`);
    return { status: "failed", message };
  }
  const hasAssertFailed = (assertFailed ?? 0) > 0;
  const statusLabel =
    batchStatus === "aborted"
      ? "⏹️ 已中止"
      : hasAssertFailed
        ? "❌ 存在测试未通过"
        : failed > 0
          ? "❌ 存在执行失败"
          : batchStatus === "completed"
            ? "✅ 全部通过"
            : "⏳ 进行中";
  const title = `【回归结果】${batchName} - ${statusLabel}`;
  // 通过率汇总：执行维度看 completed/total，测试断言维度看 passed/total。
  // 用例总数为 0 时显示 0%，避免除零。
  const execPassRate = total > 0 ? Math.round(((completed ?? 0) / total) * 100) : 0;
  const testPassRate = total > 0 ? Math.round(((passed ?? 0) / total) * 100) : 0;
  const failedRuns = runs.filter(
    (r) => r.status === "failed" || r.testOutcome === "fail"
  );
  const failedList = failedRuns
    .slice(0, 10)
    .map((r) => {
      const tag = r.testOutcome === "fail" ? "测试未通过" : "执行失败";
      const detail = r.error ? `：${truncate(r.error, 200)}` : "";
      // 每个失败用例行内附带 run 级「查看详情」链接，直达该次执行的详情页；
      // 底部不再渲染通用批次级链接，避免出现多个入口。
      const link = r.resultUrl ? ` [查看详情](${r.resultUrl})` : "";
      return `- ${r.caseName}（${tag}${detail}）${link}`;
    })
    .join("\n");
  const vars: TemplateVars = {
    title: "回归批次结果通知",
    batchName,
    statusLabel,
    batchStatus,
    total: String(total),
    completed: String(completed),
    failed: String(failed),
    aborted: String(aborted),
    passed: String(passed ?? 0),
    assertFailed: String(assertFailed ?? 0),
    unknown: String(unknown ?? 0),
    execPassRate: `${execPassRate}%`,
    execPassDetail: `${completed}/${total}`,
    testPassRate: `${testPassRate}%`,
    testPassDetail: `${passed ?? 0}/${total}`,
    failedList,
    time: new Date().toISOString(),
    resultUrl: resultUrl ?? ""
  };
  const { title: renderedTitle, text } = renderTemplate(
    robot.regressionTemplate,
    DEFAULT_REGRESSION_TEMPLATE,
    title,
    vars
  );
  const result = await sendDingtalkMarkdown(robot.webhookUrl, renderedTitle, text, robot.secret);
  if (!result.ok) {
    const message = result.errmsg ?? "unknown";
    console.error(
      `[notify] dingtalk send failed for robot ${robotId}: ${message}`
    );
    return { status: "failed", message };
  }
  return { status: "sent", message: "已推送" };
}

/* ─── 自定义通知模板 ─── */

type TemplateVars = Record<string, string>;

export const DEFAULT_INSPECTION_TEMPLATE = `### {{title}}

- **任务名称**：{{taskName}}
- **巡检地址**：{{taskUrl}}
- **执行结果**：{{statusLabel}}
- **测试结论**：{{outcomeLabel}}
- **执行状态**：{{execLabel}}
- **触发方式**：{{trigger}}
{{summary}}
{{error}}
- **时间**：{{time}}
{{resultLink}}`;

export const DEFAULT_REGRESSION_TEMPLATE = `### {{title}}

- **批次名称**：{{batchName}}
- **批次状态**：{{statusLabel}}
- **执行通过率**：{{execPassDetail}}（{{execPassRate}}）
- **测试通过率**：{{testPassDetail}}（{{testPassRate}}）
- **中止**：{{aborted}} · **结论未知**：{{unknown}}
- **时间**：{{time}}
{{failedListBlock}}`;

/**
 * Render a user-provided markdown template with {{var}} placeholders.
 *
 * Falls back to the default template when:
 *  - the custom template is empty/whitespace-only
 *  - rendering throws (e.g. malformed input)
 *
 * Variable values are NOT html-escaped (DingTalk markdown renderer is not a
 * browser), but long free-text fields (summary/error/case lists) are truncated
 * upstream so they cannot blow up the message envelope.
 */
export function renderTemplate(
  customTemplate: string | undefined,
  defaultTemplate: string,
  fallbackTitle: string,
  vars: TemplateVars
): { title: string; text: string } {
  const safeVars: TemplateVars = {};
  for (const [k, v] of Object.entries(vars)) {
    safeVars[k] = v ?? "";
  }
  // resultLink is a convenience helper: if resultUrl is set, render a markdown
  // link line; otherwise empty so the template line collapses.
  safeVars.resultLink = safeVars.resultUrl
    ? `> [查看详情](${safeVars.resultUrl})`
    : "";
  // summary/error blocks: only render the label line when the value is non-empty.
  safeVars.summary = safeVars.summary ? `- **摘要**：${safeVars.summary}` : "";
  safeVars.error = safeVars.error ? `- **错误信息**：${safeVars.error}` : "";
  // failedListBlock: render the section header + list when there are failures.
  safeVars.failedListBlock = safeVars.failedList
    ? `\n**失败用例：**\n${safeVars.failedList}`
    : "";

  const render = (tpl: string): string =>
    tpl.replace(/\{\{\s*(\w+)\s*\}\}/g, (_m, key: string) =>
      Object.prototype.hasOwnProperty.call(safeVars, key) ? safeVars[key] : `{{${key}}}`
    );

  let text: string;
  try {
    const tpl = customTemplate && customTemplate.trim() ? customTemplate : defaultTemplate;
    text = render(tpl);
    if (customTemplate && customTemplate.trim() && !text.trim()) {
      text = render(defaultTemplate);
    }
  } catch {
    text = render(defaultTemplate);
  }
  return { title: fallbackTitle, text };
}

function toPublic(robot: DingtalkRobot): PublicDingtalkRobot {
  const { secret: _secret, webhookUrl: _webhookUrl, ...rest } = robot;
  const hasSecret = Boolean(robot.secret);
  return {
    ...rest,
    hasSecret,
    secretMasked: hasSecret ? maskSecretTail(robot.secret!) : undefined,
    webhookUrlMasked: maskWebhookUrl(robot.webhookUrl)
  };
}

/**
 * Mask the access_token (and any other query params) in a DingTalk webhook URL
 * so it can be safely returned to the front-end "view" page. The host and path
 * are preserved so the user can still tell which robot endpoint it points to.
 *
 * Rather than fully hiding the token, the last 4 characters are kept visible so
 * the user can sanity-check which robot a masked URL belongs to.
 *
 * Example: https://oapi.dingtalk.com/robot/send?access_token=ABCDEFG
 *       ->  https://oapi.dingtalk.com/robot/send?access_token=***EFG
 */
function maskWebhookUrl(url: string): string {
  if (!url) return "";
  try {
    const u = new URL(url);
    const params = u.searchParams;
    if (params.size === 0) return url;
    for (const key of Array.from(params.keys())) {
      const val = params.get(key) ?? "";
      params.set(key, maskSecretTail(val));
    }
    return u.toString();
  } catch {
    // Not a parseable URL; mask conservatively if it looks like it carries a
    // token query string.
    return url.replace(/(access_token=)([^&]+)/gi, (_m, p1, p2) => `${p1}${maskSecretTail(p2)}`);
  }
}

/**
 * Mask a secret string by hiding everything except the last 4 characters.
 * Values of 4 characters or fewer are fully masked, since revealing the tail
 * would expose the whole secret.
 */
function maskSecretTail(value: string): string {
  if (!value) return "";
  if (value.length <= 4) return "******";
  return `***${value.slice(-4)}`;
}

/** Whether the provided webhookUrl string is a masked placeholder (any param
 * value starts with the "***" sentinel), meaning "do not overwrite". */
function isMaskedWebhookUrl(url: string): boolean {
  return /[?&][^=]+=\*{3,}/i.test(url) || /access_token=\*{3,}/i.test(url);
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function normalizeText(value?: string): string | undefined {
  const text = value?.trim();
  return text ? text : undefined;
}

function normalizeUrl(value?: string): string | undefined {
  const text = normalizeText(value);
  if (!text) {
    return undefined;
  }
  return /^https?:\/\//i.test(text) ? text : `https://${text}`;
}
