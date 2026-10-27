import assert from "node:assert/strict";
import test from "node:test";
import {
  CLAUDE_CODE_RUNTIME_ENABLE_ENV,
  executionRuntimeDisabledDetail,
  isExecutionRuntimeEnabled
} from "../../server/src/executionRuntimePolicy.js";

test("Claude Code runtime is disabled by default while CFuse remains enabled", () => {
  assert.equal(isExecutionRuntimeEnabled("claude-code", {}), false);
  assert.equal(isExecutionRuntimeEnabled("cfuse", {}), true);
  assert.match(executionRuntimeDisabledDetail("claude-code") ?? "", /已按平台策略禁用/);
});

test("Claude Code runtime can be restored through an explicit feature flag", () => {
  assert.equal(isExecutionRuntimeEnabled("claude-code", {
    [CLAUDE_CODE_RUNTIME_ENABLE_ENV]: "true"
  }), true);
  assert.equal(isExecutionRuntimeEnabled("claude-code", {
    [CLAUDE_CODE_RUNTIME_ENABLE_ENV]: "false"
  }), false);
});
