// 僵尸任务恢复：处理进程重启 / 崩溃 / 卡死导致 DB 中残留 "running" 状态的
// 巡检 run、回归 run/batch、以及会话（session），保证：
//
// 1. 进程重启后（内存中的 AbortController / 超时定时器 / dispatched 占位全部丢失），
//    启动时把 DB 里所有 running 且本进程没有活跃句柄的记录收尾为 failed，
//    并推进巡检 nextRunAt，让调度器后续能继续按期发起。
// 2. 运行期间某个 run 卡死超过执行超时阈值（默认 60min），即使内存限流器的
//    超时 abort 因为某种原因没生效（例如底层子进程忽略了信号），也由 DB 级
//    周期扫描把它标记 failed，从而释放调度、避免永远卡在 running。
//
// 设计要点：
// - 本模块只做 DB 状态收尾，不负责真正 kill 子进程（那是限流器 + AbortController
//   的职责）。它是"兜底"层，专门修复状态不一致。
// - 通过 activeRunIds 登记"本进程确实还在跑"的 run，避免误伤正在正常执行、
//   只是耗时较长但仍在超时窗口内的任务。
// - 超时判定基于 DB 里的 started_at，不依赖任何内存计时器，因此重启也能生效。

import { getDatabase } from "./db/index.js";
import { TABLES } from "./db/schema.js";
import { finishInspectionRun, rescheduleInspectionTask } from "./inspections.js";
import { updateRegressionRun } from "./regressionStore.js";
import { updateSessionStatus, loadSession } from "./storage.js";
import { isSessionActivelyRunning } from "./sessionRuntime.js";

/** 默认执行超时：60 分钟（可用 UI_AGENT_TASK_TIMEOUT_MS 覆盖，与限流器保持一致）。 */
function resolveTimeoutMs(): number {
  const raw = process.env.UI_AGENT_TASK_TIMEOUT_MS;
  const fallback = 60 * 60 * 1000;
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1000) return fallback;
  return n;
}

// 本进程内"确实还在执行"的运行句柄登记表。用 runId / batchId / sessionId 作为 key。
// 只有登记在册的记录才被视为"活跃"，其余 running 记录一律视为孤儿/卡死候选。
const activeInspectionRunIds = new Set<string>();
const activeRegressionBatchIds = new Set<string>();

export function registerActiveInspectionRun(runId: string): void {
  activeInspectionRunIds.add(runId);
}
export function unregisterActiveInspectionRun(runId: string): void {
  activeInspectionRunIds.delete(runId);
}
export function registerActiveRegressionBatch(batchId: string): void {
  activeRegressionBatchIds.add(batchId);
}
export function unregisterActiveRegressionBatch(batchId: string): void {
  activeRegressionBatchIds.delete(batchId);
}

interface StuckInspectionRunRow {
  id: string;
  task_id: string;
  status: string;
  started_at: string;
}

interface StuckRegressionRunRow {
  id: string;
  batch_id: string;
  status: string;
  started_at: string | null;
}

interface StuckSessionRow {
  id: string;
  status: string;
  updated_at: string;
}

/**
 * 收尾一个卡死/孤儿的巡检 run：标记 run failed、把任务状态复位、推进 nextRunAt。
 * finishInspectionRun 内部已经根据 scheduleEnabled 复位 task.status 并计算 next_run_at，
 * 因此调用它即可让调度器后续重新发起。
 */
async function recoverInspectionRun(taskId: string, runId: string, reason: string): Promise<void> {
  await finishInspectionRun(taskId, runId, {
    status: "failed",
    error: reason,
    testOutcome: "unknown"
  }).catch((error) => {
    console.error(`[recovery] 收尾巡检 run 失败 task=${taskId} run=${runId}`, error);
  });
  // 双保险：即使 finishInspectionRun 已推进过，这里再确保 nextRunAt 被刷新，
  // 避免 nextRunAt 仍停留在过去时间导致调度器每 tick 反复命中。
  await rescheduleInspectionTask(taskId).catch(() => undefined);
}

/** 收尾一个卡死/孤儿的回归 run：标记 failed；updateRegressionRun 会自动重算 batch 计数与状态。 */
async function recoverRegressionRun(batchId: string, runId: string, reason: string): Promise<void> {
  await updateRegressionRun(batchId, runId, {
    status: "failed",
    finishedAt: new Date().toISOString(),
    error: reason,
    testOutcome: "unknown"
  }).catch((error) => {
    console.error(`[recovery] 收尾回归 run 失败 batch=${batchId} run=${runId}`, error);
  });
}

/** 收尾一个卡死/孤儿的会话：标记 failed 并写入错误说明，前端不再永远转圈。 */
async function recoverSession(sessionId: string, reason: string): Promise<void> {
  try {
    await loadSession(sessionId);
  } catch {
    return; // 会话已被删除，跳过
  }
  await updateSessionStatus(sessionId, "failed", {
    lastError: reason,
    testOutcome: "unknown"
  }).catch((error) => {
    console.error(`[recovery] 收尾会话失败 session=${sessionId}`, error);
  });
}

/**
 * 扫描并恢复卡死/孤儿的 running 记录。
 *
 * @param mode
 *   - "startup"：进程刚启动，内存句柄一定为空，把所有 running 记录都当孤儿收尾。
 *   - "sweep"：运行期周期扫描，只收尾"本进程无活跃句柄"或"已超执行超时阈值"的记录。
 */
export async function reconcileStuckRuns(mode: "startup" | "sweep"): Promise<{
  inspectionRuns: number;
  regressionRuns: number;
  sessions: number;
}> {
  const { knex } = await getDatabase();
  const timeoutMs = resolveTimeoutMs();
  const now = Date.now();
  const startupReason = "服务重启导致执行中断，任务状态已自动恢复为失败";
  const timeoutReason = `执行超时（超过 ${Math.round(timeoutMs / 60000)} 分钟未完成），已自动标记失败`;

  let inspectionRuns = 0;
  let regressionRuns = 0;
  let sessions = 0;

  // ── 巡检 running run ──
  const inspRows = await knex<StuckInspectionRunRow>(TABLES.inspectionRuns)
    .where({ status: "running" })
    .select("id", "task_id", "started_at");
  for (const row of inspRows) {
    const active = activeInspectionRunIds.has(row.id);
    const overdue = row.started_at ? now - new Date(row.started_at).getTime() > timeoutMs : true;
    if (mode === "startup" || !active || overdue) {
      const reason = mode === "startup" ? startupReason : overdue ? timeoutReason : startupReason;
      await recoverInspectionRun(row.task_id, row.id, reason);
      activeInspectionRunIds.delete(row.id);
      inspectionRuns += 1;
    }
  }

  // 兜底：任务卡在 running 但没有任何 running run（run 已收尾但 task 状态没跟上）。
  const stuckTasks = await knex<{ id: string; status: string; schedule_enabled: number }>(TABLES.inspectionTasks)
    .where({ status: "running" })
    .select("id", "schedule_enabled");
  for (const task of stuckTasks) {
    const stillRunning = await knex<StuckInspectionRunRow>(TABLES.inspectionRuns)
      .where({ task_id: task.id, status: "running" })
      .first();
    if (!stillRunning) {
      await knex<{ id: string; status: string; updated_at: string }>(TABLES.inspectionTasks)
        .where({ id: task.id })
        .update({
          status: task.schedule_enabled ? "idle" : "disabled",
          updated_at: new Date().toISOString()
        });
      await rescheduleInspectionTask(task.id).catch(() => undefined);
    }
  }

  // ── 回归 running run ──
  const regRows = await knex<StuckRegressionRunRow>(TABLES.regressionRuns)
    .where({ status: "running" })
    .select("id", "batch_id", "started_at");
  for (const row of regRows) {
    const active = activeRegressionBatchIds.has(row.batch_id);
    const overdue = row.started_at ? now - new Date(row.started_at).getTime() > timeoutMs : true;
    if (mode === "startup" || !active || overdue) {
      const reason = mode === "startup" ? startupReason : overdue ? timeoutReason : startupReason;
      await recoverRegressionRun(row.batch_id, row.id, reason);
      regressionRuns += 1;
    }
  }

  // ── running session（对话任务本身，也包括巡检/回归底层会话）──
  const sessRows = await knex<StuckSessionRow>(TABLES.sessions)
    .where({ status: "running" })
    .select("id", "updated_at");
  for (const row of sessRows) {
    // sweep 模式下：若本进程仍在真实执行该会话，且未超时，则不动它。
    const active = isSessionActivelyRunning(row.id);
    const overdue = row.updated_at ? now - new Date(row.updated_at).getTime() > timeoutMs : true;
    if (mode === "startup" || (!active && overdue)) {
      const reason = mode === "startup" ? startupReason : timeoutReason;
      await recoverSession(row.id, reason);
      sessions += 1;
    }
  }

  if (inspectionRuns || regressionRuns || sessions) {
    console.log(
      `[recovery] mode=${mode} 恢复：巡检run=${inspectionRuns} 回归run=${regressionRuns} 会话=${sessions}`
    );
  }
  return { inspectionRuns, regressionRuns, sessions };
}
