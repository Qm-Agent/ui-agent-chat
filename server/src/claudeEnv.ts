import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Settings } from "@anthropic-ai/claude-agent-sdk";
import type { ModelProfile } from "./types.js";

export interface ClaudeRuntimeEnv {
  env: Record<string, string>;
  model?: string;
}

interface ClaudeRuntimeEnvOptions {
  processEnv?: NodeJS.ProcessEnv;
  settingsPath?: string;
}

const ALLOWED_SETTINGS_ENV = /^(?:ANTHROPIC_|CLAUDE_CODE_|DISABLE_|API_TIMEOUT_MS$)/;

export function buildClaudeRuntimeEnv(
  extraEnv: Record<string, string>,
  activeProfile?: ModelProfile,
  options: ClaudeRuntimeEnvOptions = {}
): ClaudeRuntimeEnv {
  const processValues = stringEnv(options.processEnv ?? process.env);
  const settingsEnv = readClaudeCodeSettingsEnv(
    options.settingsPath ?? resolveClaudeSettingsPath(processValues)
  );
  const env: Record<string, string> = {
    ...settingsEnv,
    ...processValues,
    ...extraEnv,
    CLAUDE_AGENT_SDK_CLIENT_APP: "ui-agent-chat/0.1.0"
  };

  // Platform model management: an active profile overrides ANTHROPIC_* env vars,
  // so the server works even without .env on remote bare deployments.
  const hasProfileAuth = Boolean(activeProfile?.authToken.trim());
  if (activeProfile && hasProfileAuth) {
    delete env.ANTHROPIC_API_KEY;
    env.ANTHROPIC_BASE_URL = activeProfile.baseUrl;
    env.ANTHROPIC_AUTH_TOKEN = activeProfile.authToken;
    env.ANTHROPIC_MODEL = activeProfile.model;
    env.ANTHROPIC_SMALL_FAST_MODEL = activeProfile.smallFastModel ?? activeProfile.model;
    env.ANTHROPIC_DEFAULT_SONNET_MODEL = activeProfile.sonnetModel ?? activeProfile.model;
    env.ANTHROPIC_DEFAULT_HAIKU_MODEL = activeProfile.haikuModel ?? activeProfile.model;
    env.ANTHROPIC_DEFAULT_OPUS_MODEL = activeProfile.opusModel ?? activeProfile.model;
  }

  if (!env.ANTHROPIC_API_KEY?.trim() && !env.ANTHROPIC_AUTH_TOKEN?.trim()) {
    throw new Error(
      "Claude Runtime 未配置。请在客户端“模型管理”中激活包含密钥的模型，或配置 ANTHROPIC_AUTH_TOKEN、ANTHROPIC_API_KEY 或 ~/.claude/settings.json。"
    );
  }

  // When using a non-Claude model via proxy, ensure all model slots point to the same model
  // to prevent the CLI from falling back to a default Claude model name the proxy can't handle
  if (env.ANTHROPIC_MODEL && !env.ANTHROPIC_SMALL_FAST_MODEL) {
    env.ANTHROPIC_SMALL_FAST_MODEL = env.ANTHROPIC_MODEL;
  }
  if (env.ANTHROPIC_MODEL && !env.ANTHROPIC_DEFAULT_SONNET_MODEL) {
    env.ANTHROPIC_DEFAULT_SONNET_MODEL = env.ANTHROPIC_MODEL;
  }
  if (env.ANTHROPIC_MODEL && !env.ANTHROPIC_DEFAULT_OPUS_MODEL) {
    env.ANTHROPIC_DEFAULT_OPUS_MODEL = env.ANTHROPIC_MODEL;
  }
  if (env.ANTHROPIC_MODEL && !env.ANTHROPIC_DEFAULT_HAIKU_MODEL) {
    env.ANTHROPIC_DEFAULT_HAIKU_MODEL = env.ANTHROPIC_MODEL;
  }

  const authSource = hasProfileAuth
    ? `profile:${activeProfile!.name}`
    : processValues.ANTHROPIC_AUTH_TOKEN || processValues.ANTHROPIC_API_KEY
      ? "service-env"
      : "claude-settings";
  console.log(`[claudeEnv] ANTHROPIC_BASE_URL=${env.ANTHROPIC_BASE_URL ?? "(unset)"}, ANTHROPIC_MODEL=${env.ANTHROPIC_MODEL ?? "(unset)"}, ANTHROPIC_SMALL_FAST_MODEL=${env.ANTHROPIC_SMALL_FAST_MODEL ?? "(unset)"}, authSource=${authSource}`);

  return {
    env,
    model: env.ANTHROPIC_MODEL
  };
}

/**
 * 生成 Claude SDK 最高优先级的 flag settings，防止用户级 settings.json
 * 在进程启动后再次覆盖平台已激活的模型档案。
 */
export function buildClaudeProfileSettings(activeProfile?: ModelProfile): Settings | undefined {
  if (!activeProfile?.authToken.trim()) return undefined;
  return {
    model: activeProfile.model,
    env: {
      ANTHROPIC_API_KEY: "",
      ANTHROPIC_BASE_URL: activeProfile.baseUrl,
      ANTHROPIC_AUTH_TOKEN: activeProfile.authToken,
      ANTHROPIC_MODEL: activeProfile.model,
      ANTHROPIC_SMALL_FAST_MODEL: activeProfile.smallFastModel ?? activeProfile.model,
      ANTHROPIC_DEFAULT_SONNET_MODEL: activeProfile.sonnetModel ?? activeProfile.model,
      ANTHROPIC_DEFAULT_HAIKU_MODEL: activeProfile.haikuModel ?? activeProfile.model,
      ANTHROPIC_DEFAULT_OPUS_MODEL: activeProfile.opusModel ?? activeProfile.model
    }
  };
}

export function readClaudeCodeSettingsEnv(settingsPath: string): Record<string, string> {
  try {
    const parsed = JSON.parse(fs.readFileSync(settingsPath, "utf8")) as { env?: unknown };
    if (!parsed.env || typeof parsed.env !== "object" || Array.isArray(parsed.env)) return {};
    return Object.fromEntries(
      Object.entries(parsed.env)
        .filter((entry): entry is [string, string] => (
          ALLOWED_SETTINGS_ENV.test(entry[0])
          && typeof entry[1] === "string"
          && entry[1].trim().length > 0
        ))
    );
  } catch {
    return {};
  }
}

function resolveClaudeSettingsPath(env: Record<string, string>): string {
  const configDir = env.CLAUDE_CONFIG_DIR?.trim();
  return path.join(configDir || path.join(os.homedir(), ".claude"), "settings.json");
}

function stringEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === "string")
  );
}
