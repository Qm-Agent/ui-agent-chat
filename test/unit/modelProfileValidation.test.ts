import assert from "node:assert/strict";
import test from "node:test";
import {
  validateCfuseExplicitProfile,
  validateDtcoderExplicitProfile
} from "../../server/src/modelStore.js";

test("CFuse custom model rejects an unqualified provider model ID", () => {
  assert.throws(
    () => validateCfuseExplicitProfile({
      baseUrl: "",
      authToken: "",
      model: "MiniMax-M2.5"
    }),
    /antchat\/MiniMax-M2\.5/
  );
});

test("CFuse independent route accepts an unqualified model and requires URL/token as a pair", () => {
  assert.doesNotThrow(() => validateCfuseExplicitProfile({
    baseUrl: "https://example.test/anthropic",
    authToken: "test-token",
    model: "MiniMax-M2.5"
  }));
  assert.throws(
    () => validateCfuseExplicitProfile({
      baseUrl: "https://example.test/anthropic",
      authToken: "",
      model: "MiniMax-M2.5"
    }),
    /同时填写 API Base URL 和 API Token/
  );
});

test("CFuse custom model accepts a provider-qualified model ID", () => {
  assert.doesNotThrow(() => validateCfuseExplicitProfile({
    baseUrl: "",
    authToken: "",
    model: "antchat/MiniMax-M2.5"
  }));
});

test("CFuse local provider mode and built-in aliases remain valid", () => {
  assert.doesNotThrow(() => validateCfuseExplicitProfile({
    baseUrl: "",
    authToken: "",
    model: ""
  }));
  assert.doesNotThrow(() => validateCfuseExplicitProfile({
    baseUrl: "",
    authToken: "",
    model: "sonnet"
  }));
});

test("DTCoder custom route requires a provider-qualified model ID", () => {
  assert.throws(
    () => validateDtcoderExplicitProfile({
      baseUrl: "https://maas.example.test",
      authToken: "test-token",
      model: "claude-opus-4-8"
    }),
    /maas\/claude-opus-4-8/
  );
  assert.doesNotThrow(() => validateDtcoderExplicitProfile({
    baseUrl: "https://maas.example.test",
    authToken: "test-token",
    model: "maas/claude-opus-4-8"
  }));
});
