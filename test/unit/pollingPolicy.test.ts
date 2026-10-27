import assert from "node:assert/strict";
import test from "node:test";
import { shouldLoadRegressionData, shouldPollView } from "../../client/src/pollingPolicy";

test("Host 配置页不轮询回归、巡检或聊天任务", () => {
  assert.equal(shouldPollView("skillenv", "regression", true), false);
  assert.equal(shouldPollView("skillenv", "inspections", true), false);
  assert.equal(shouldPollView("skillenv", "chat", true), false);
});

test("活动任务只在所属工作区轮询", () => {
  assert.equal(shouldPollView("regression", "regression", true), true);
  assert.equal(shouldPollView("regression", "regression", false), false);
  assert.equal(shouldPollView("chat", "regression", true), false);
});

test("回归数据仅在回归工作区按需加载", () => {
  assert.equal(shouldLoadRegressionData("regression"), true);
  assert.equal(shouldLoadRegressionData("skillenv"), false);
  assert.equal(shouldLoadRegressionData("chat"), false);
});
