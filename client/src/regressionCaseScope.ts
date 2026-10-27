export const REGRESSION_CASES_API_PATH = "/api/regression/cases";

interface ModuleScopedCase {
  moduleId: string;
}

/** 顶层状态保留全量用例，模块详情仅派生当前模块的展示子集。 */
export function filterRegressionCasesByModule<T extends ModuleScopedCase>(
  cases: T[],
  moduleId?: string
): T[] {
  return moduleId ? cases.filter((item) => item.moduleId === moduleId) : cases;
}
