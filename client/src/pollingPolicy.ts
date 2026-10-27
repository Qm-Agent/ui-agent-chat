export type PollingView = "chat" | "inspections" | "regression";

/** 页面级轮询仅在对应工作区可见且确有活动任务时启用。 */
export function shouldPollView(
  currentView: string,
  pollingView: PollingView,
  hasActiveWork: boolean
): boolean {
  return currentView === pollingView && hasActiveWork;
}

/** 回归数据不在应用启动时全局加载，只在回归工作区按需读取。 */
export function shouldLoadRegressionData(currentView: string): boolean {
  return currentView === "regression";
}
