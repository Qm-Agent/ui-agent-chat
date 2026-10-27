import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  buildClaudeProfileSettings,
  buildClaudeRuntimeEnv,
  readClaudeCodeSettingsEnv
} from "../../server/src/claudeEnv.js";
import type { ModelProfile } from "../../server/src/types.js";

function profile(authToken: string): ModelProfile {
  return {
    id: "profile",
    runtimeId: "claude-code",
    name: "Profile",
    baseUrl: "https://profile.example/anthropic",
    authToken,
    model: "profile-model",
    isDefault: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z"
  };
}

test("Claude Code settings supply auth when the built-in profile has no token", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "uiwarden-claude-env-"));
  const settingsPath = path.join(root, "settings.json");
  fs.writeFileSync(settingsPath, JSON.stringify({
    env: {
      ANTHROPIC_AUTH_TOKEN: "settings-token",
      ANTHROPIC_BASE_URL: "https://settings.example/anthropic",
      ANTHROPIC_MODEL: "settings-model",
      PATH: "/untrusted/path"
    }
  }));
  try {
    const runtime = buildClaudeRuntimeEnv({}, profile(""), { processEnv: {}, settingsPath });
    assert.equal(runtime.env.ANTHROPIC_AUTH_TOKEN, "settings-token");
    assert.equal(runtime.env.ANTHROPIC_BASE_URL, "https://settings.example/anthropic");
    assert.equal(runtime.model, "settings-model");
    assert.equal(runtime.env.PATH, undefined);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("active model profile overrides Claude Code settings", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "uiwarden-claude-env-"));
  const settingsPath = path.join(root, "settings.json");
  fs.writeFileSync(settingsPath, JSON.stringify({ env: { ANTHROPIC_AUTH_TOKEN: "settings-token" } }));
  try {
    const runtime = buildClaudeRuntimeEnv({}, profile("profile-token"), {
      processEnv: { ANTHROPIC_API_KEY: "stale-api-key" },
      settingsPath
    });
    assert.equal(runtime.env.ANTHROPIC_AUTH_TOKEN, "profile-token");
    assert.equal(runtime.env.ANTHROPIC_BASE_URL, "https://profile.example/anthropic");
    assert.equal(runtime.env.ANTHROPIC_API_KEY, undefined);
    assert.equal(runtime.model, "profile-model");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("active profile creates highest-priority Claude SDK settings", () => {
  const activeProfile = profile("profile-token");
  activeProfile.smallFastModel = "profile-fast-model";
  const settings = buildClaudeProfileSettings(activeProfile);
  assert.deepEqual(settings, {
    model: "profile-model",
    env: {
      ANTHROPIC_API_KEY: "",
      ANTHROPIC_BASE_URL: "https://profile.example/anthropic",
      ANTHROPIC_AUTH_TOKEN: "profile-token",
      ANTHROPIC_MODEL: "profile-model",
      ANTHROPIC_SMALL_FAST_MODEL: "profile-fast-model",
      ANTHROPIC_DEFAULT_SONNET_MODEL: "profile-model",
      ANTHROPIC_DEFAULT_HAIKU_MODEL: "profile-model",
      ANTHROPIC_DEFAULT_OPUS_MODEL: "profile-model"
    }
  });
});

test("Claude settings reader ignores non-model process overrides", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "uiwarden-claude-env-"));
  const settingsPath = path.join(root, "settings.json");
  fs.writeFileSync(settingsPath, JSON.stringify({ env: { ANTHROPIC_API_KEY: "key", NODE_OPTIONS: "--require bad.js" } }));
  try {
    assert.deepEqual(readClaudeCodeSettingsEnv(settingsPath), { ANTHROPIC_API_KEY: "key" });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
