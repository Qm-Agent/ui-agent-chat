const activeSessionRuns = new Set<string>();

// 会话级 AbortController：供「停止任务」中断运行中的 agent run。
// markSessionRunStarted 时注册，markSessionRunFinished 时回收。
const activeAbortControllers = new Map<string, AbortController>();

export function markSessionRunStarted(sessionId: string, controller?: AbortController): void {
  activeSessionRuns.add(sessionId);
  if (controller) {
    activeAbortControllers.set(sessionId, controller);
  }
}

export function markSessionRunFinished(sessionId: string): void {
  activeSessionRuns.delete(sessionId);
  activeAbortControllers.delete(sessionId);
}

export function isSessionActivelyRunning(sessionId: string): boolean {
  return activeSessionRuns.has(sessionId);
}

/**
 * 中断运行中的 agent run（CDP/普通会话通用）。
 * 返回 true 表示已发出 abort 信号；false 表示该会话当前没有运行中的任务。
 * 注意：abort 仅通知 SDK 迭代循环退出，子进程（browser-use）可能需要额外时间收尾。
 */
export function abortSessionRun(sessionId: string): boolean {
  const controller = activeAbortControllers.get(sessionId);
  if (controller && !controller.signal.aborted) {
    controller.abort();
    return true;
  }
  return false;
}
