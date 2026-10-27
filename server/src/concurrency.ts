// 巡检任务与回归任务共享的并发限流器（对话任务不经过此模块，不受影响）。
//
// 设计要点：
// - 并发槽（maxConcurrent）由环境变量配置，默认 5；巡检 run 与回归 batch
//   共享这组槽位，超过上限的任务进入 FIFO 队列排队等待。
// - 单任务执行超时由环境变量配置，默认 60 分钟（3600000ms）；超时后 abort
//   子进程并标记为 failed，避免长时间卡死占住槽位。此值与 recovery.ts 的
//   DB 级僵尸恢复阈值共用同一环境变量，保证两者判定一致。
// - 手动合并"外部 abort（手动中止）"与"超时 abort"信号（兼容 Node 18，不用 AbortSignal.any），
//   保证手动中止 / 超时 / 批次级中止都能正确传递到底层 agent 执行。
// - 排队期间被外部中止的任务：从队列移除并返回一个已 abort 的 slot，
//   调用方检测到 signal.aborted 后跳过执行，避免 Promise 悬挂泄漏槽位。

export interface TaskSlotResult {
  /** 拿到并发槽位后返回的 AbortSignal，已合并超时与外部 abort 信号 */
  signal: AbortSignal;
  /** 外部中止句柄（手动中止用） */
  controller: AbortController;
  /** 是否经过了排队等待 */
  queued: boolean;
  /** 释放并发槽位；必须在任务结束（成功/失败/中止/超时）后调用一次 */
  release: () => void;
}

interface QueueItem {
  externalController: AbortController;
  acquire: () => void;
}

class TaskConcurrencyLimiter {
  private active = 0;
  private readonly queue: QueueItem[] = [];

  constructor(
    private readonly maxConcurrent: number,
    private readonly timeoutMs: number
  ) {
    if (!Number.isFinite(maxConcurrent) || maxConcurrent < 1) {
      throw new Error(`UI_AGENT_TASK_CONCURRENCY 必须为正整数，当前值: ${maxConcurrent}`);
    }
    if (!Number.isFinite(timeoutMs) || timeoutMs < 1000) {
      throw new Error(`UI_AGENT_TASK_TIMEOUT_MS 必须 >= 1000ms，当前值: ${timeoutMs}`);
    }
    console.log(
      `[concurrency] maxConcurrent=${maxConcurrent}, timeoutMs=${timeoutMs}（巡检/回归共享，对话不受限）`
    );
  }

  /** 当前正在执行的任务数（不含排队）。 */
  getActiveCount(): number {
    return this.active;
  }

  /** 当前排队等待的任务数。 */
  getQueueLength(): number {
    return this.queue.length;
  }

  /**
   * 请求一个并发槽位。
   *
   * - 若有空闲槽位，立即返回（queued=false）。
   * - 若已达上限，进入 FIFO 队列等待（queued=true）。
   * - 若排队期间被外部 abort，返回一个已 abort 的 slot（release 为 no-op），
   *   调用方检测 signal.aborted 后跳过执行。
   *
   * 返回的 TaskSlotResult.signal 已合并：外部 abort + 超时 abort。
   * 调用方必须在任务结束后调用 release()，否则会泄漏槽位。
   */
  enqueue(externalController: AbortController): Promise<TaskSlotResult> {
    return new Promise<TaskSlotResult>((resolve) => {
      let settled = false;

      const finishAbortedWhileQueued = () => {
        if (settled) return;
        settled = true;
        const idx = this.queue.findIndex(
          (item) => item.externalController === externalController
        );
        if (idx >= 0) {
          this.queue.splice(idx, 1);
        }
        console.log(
          `[concurrency] 排队期间被中止，移出队列（active=${this.active}/${this.maxConcurrent}, queued=${this.queue.length}）`
        );
        // 返回一个已 abort 的信号 + no-op release（从未真正获取槽位）
        resolve({
          signal: externalController.signal,
          controller: externalController,
          queued: true,
          release: () => {}
        });
      };

      const acquire = () => {
        if (settled) return; // 已因排队期间中止而退出
        settled = true;
        this.active += 1;
        // 超时控制器：到点自动 abort，释放槽位。
        const timeoutController = new AbortController();
        // release 提前声明，供超时回调与调用方共用（幂等）。
        let released = false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const clearTimer = () => {
          if (timer) clearTimeout(timer);
          externalController.signal.removeEventListener("abort", clearTimer);
          timeoutController.signal.removeEventListener("abort", clearTimer);
        };
        const release = () => {
          if (released) return;
          released = true;
          clearTimer();
          this.active -= 1;
          console.log(
            `[concurrency] slot released（active=${this.active}/${this.maxConcurrent}, queued=${this.queue.length}）`
          );
          this.pump();
        };
        timer = setTimeout(() => {
          timeoutController.abort();
          console.warn(
            `[concurrency] 任务超时（${this.timeoutMs}ms），已触发中止并强制回收槽位` +
              `（active=${this.active}/${this.maxConcurrent}, queued=${this.queue.length}）`
          );
          // 兜底：超时后主动回收槽位，避免调用方（如 runAgentForSession）永不返回
          // 时其 finally 中的 release() 永不执行，导致槽位泄漏、后续巡检/回归永久排队卡死。
          // release() 幂等，调用方 finally 再次调用是安全的 no-op。
          release();
        }, this.timeoutMs);
        // 合并外部 abort 与超时 abort。
        // 手动合并信号，避免嵌入式或旧版 Node 运行环境缺少 AbortSignal.any()。
        const combinedController = new AbortController();
        const forwardAbort = (reason: unknown) => {
          if (!combinedController.signal.aborted) {
            combinedController.abort(reason);
          }
        };
        if (externalController.signal.aborted) {
          forwardAbort(externalController.signal.reason);
        } else if (timeoutController.signal.aborted) {
          forwardAbort(timeoutController.signal.reason);
        } else {
          externalController.signal.addEventListener(
            "abort",
            () => forwardAbort(externalController.signal.reason),
            { once: true }
          );
          timeoutController.signal.addEventListener(
            "abort",
            () => forwardAbort(timeoutController.signal.reason),
            { once: true }
          );
        }
        const combined = combinedController.signal;
        // 当任一信号触发时清理超时定时器，避免泄漏。
        externalController.signal.addEventListener("abort", clearTimer, { once: true });
        timeoutController.signal.addEventListener("abort", clearTimer, { once: true });
        console.log(
          `[concurrency] slot acquired（active=${this.active}/${this.maxConcurrent}, queued=${this.queue.length}）`
        );
        resolve({
          signal: combined,
          controller: externalController,
          queued: false,
          release
        });
      };

      if (this.active < this.maxConcurrent) {
        acquire();
        return;
      }
      // 进入队列等待；排队期间若被外部中止则移除并返回已 abort 的 slot
      this.queue.push({ externalController, acquire });
      console.log(
        `[concurrency] slot 已满，进入排队（active=${this.active}/${this.maxConcurrent}, queued=${this.queue.length}）`
      );
      externalController.signal.addEventListener("abort", finishAbortedWhileQueued, {
        once: true
      });
    });
  }

  private pump(): void {
    if (this.active >= this.maxConcurrent) return;
    const next = this.queue.shift();
    if (!next) return;
    console.log(
      `[concurrency] pump 放行排队任务（active=${this.active}/${this.maxConcurrent}, queued=${this.queue.length}）`
    );
    next.acquire();
  }
}

// 从环境变量构造单例。
function resolvePositiveInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) {
    console.warn(
      `[concurrency] ${name}="${raw}" 无效（需正整数），回退默认值 ${fallback}`
    );
    return fallback;
  }
  return n;
}

const maxConcurrent = resolvePositiveInt("UI_AGENT_TASK_CONCURRENCY", 15);
const timeoutMs = resolvePositiveInt("UI_AGENT_TASK_TIMEOUT_MS", 60 * 60 * 1000);

export const taskLimiter = new TaskConcurrencyLimiter(maxConcurrent, timeoutMs);

export function getConcurrencyStatus() {
  return {
    maxConcurrent,
    timeoutMs,
    active: taskLimiter.getActiveCount(),
    queued: taskLimiter.getQueueLength()
  };
}
