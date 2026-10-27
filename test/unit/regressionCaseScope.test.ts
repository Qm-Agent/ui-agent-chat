import assert from "node:assert/strict";
import test from "node:test";
import {
  filterRegressionCasesByModule,
  REGRESSION_CASES_API_PATH
} from "../../client/src/regressionCaseScope";

const cases = [
  { id: "case-a", moduleId: "module-a" },
  { id: "case-b", moduleId: "module-b" }
];

test("回归用例顶层数据源始终请求全量列表", () => {
  assert.equal(REGRESSION_CASES_API_PATH, "/api/regression/cases");
  assert.equal(REGRESSION_CASES_API_PATH.includes("moduleId"), false);
});

test("模块详情从全量用例派生子集且不修改原列表", () => {
  assert.deepEqual(filterRegressionCasesByModule(cases, "module-a"), [cases[0]]);
  assert.deepEqual(filterRegressionCasesByModule(cases), cases);
  assert.equal(cases.length, 2);
});
