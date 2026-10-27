import { test } from "node:test";
import assert from "node:assert/strict";
import { parseTestOutcome } from "../../server/src/testOutcome.js";

// 6.1 parseTestOutcome 单测：中文/英文 PASS、FAIL、无结论三类

test("英文 FAIL 明确标记 -> fail", () => {
  const r = parseTestOutcome("Running assertions...\nResult: FAIL - expected earthquake banner not shown");
  assert.equal(r.outcome, "fail");
  assert.match(r.summary ?? "", /FAIL/);
});

test("英文 PASS 明确标记 -> pass", () => {
  const r = parseTestOutcome("All steps executed.\nOverall: PASS");
  assert.equal(r.outcome, "pass");
  assert.match(r.summary ?? "", /PASS/);
});

test("中文测试通过 -> pass", () => {
  const r = parseTestOutcome("已完成全部校验步骤。\n结论：测试通过，符合预期。");
  assert.equal(r.outcome, "pass");
});

test("中文测试未通过 -> fail", () => {
  const r = parseTestOutcome("页面没有出现地震提示。\n结论：测试未通过。");
  assert.equal(r.outcome, "fail");
});

test("中文测试失败 -> fail", () => {
  const r = parseTestOutcome("断言校验失败：元素未找到。\n测试失败。");
  assert.equal(r.outcome, "fail");
});

test("emoji ❌ 视为 fail", () => {
  const r = parseTestOutcome("步骤 3 ❌ 未达预期");
  assert.equal(r.outcome, "fail");
});

test("emoji ✅ 视为 pass", () => {
  const r = parseTestOutcome("步骤 1 ✅\n步骤 2 ✅");
  assert.equal(r.outcome, "pass");
});

test("无明确结论 -> unknown", () => {
  const r = parseTestOutcome("我打开了页面并截了图，随后结束了会话。");
  assert.equal(r.outcome, "unknown");
  assert.equal(r.summary, undefined);
});

test("空文本 -> unknown", () => {
  assert.equal(parseTestOutcome("").outcome, "unknown");
  assert.equal(parseTestOutcome("   \n  ").outcome, "unknown");
});

test("同时含通过与未通过时失败优先", () => {
  // "测试未通过" 含 "通过" 子串，必须判为 fail 而非 pass
  const r = parseTestOutcome("大部分校验通过。\n但关键断言：测试未通过。");
  assert.equal(r.outcome, "fail");
});

test("执行成功但断言 FAIL 仍判 fail（与执行状态正交）", () => {
  const r = parseTestOutcome("任务执行成功，无异常。\n测试结果：FAIL");
  assert.equal(r.outcome, "fail");
});

test("结论在长文本末尾窗口内仍可命中", () => {
  const filler = "过程日志行\n".repeat(500);
  const r = parseTestOutcome(filler + "最终结论：测试通过");
  assert.equal(r.outcome, "pass");
});
