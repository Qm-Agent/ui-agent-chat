import assert from "node:assert/strict";
import test from "node:test";
import { buildAgentFailureMessage } from "../../server/src/agent.js";

test("creates a visible failure reply when the agent produced no text", () => {
  assert.equal(buildAgentFailureMessage("", "模型服务不可用"), "任务执行失败：模型服务不可用");
});

test("preserves partial output and appends the failure reason", () => {
  assert.equal(
    buildAgentFailureMessage("正在打开目标页面", "连接浏览器失败"),
    "正在打开目标页面\n\n---\n连接浏览器失败"
  );
});

test("does not duplicate an error already present in the reply", () => {
  const text = "执行失败：连接浏览器失败";
  assert.equal(buildAgentFailureMessage(text, "连接浏览器失败"), text);
});

test("keeps an explicit abort reason", () => {
  assert.equal(buildAgentFailureMessage("", "任务已被中止"), "任务已被中止");
});
