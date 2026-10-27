import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { buildClaudeRuntimeEnv } from "./claudeEnv.js";
import { findExecutable, resolveDtcoderExecutable, resolveUserPath } from "./depsCheck.js";
import {
  DEFAULT_EXECUTION_RUNTIME_ID,
  DEFAULT_PROFILE_ID,
  getActiveModelProfile,
  getRuntimeModelOverride,
  getSelectedExecutionRuntimeId
} from "./modelStore.js";
import type {
  ExecutionRuntimeId,
  ExecutionRuntimeStatus,
  ModelProfile,
  RuntimeModelCatalog,
  RuntimeModelOption
} from "./types.js";
import {
  executionRuntimeDisabledDetail,
  isExecutionRuntimeEnabled
} from "./executionRuntimePolicy.js";
import {
  cfuseCapabilityWarnings,
  detectCfuseCliCapabilities
} from "./executionRuntimeRunner.js";

const execFileAsync = promisify(execFile);
let dtcoderModelCache: { expiresAt: number; model?: string } = { expiresAt: 0 };
const runtimeModelCatalogCache = new Map<ExecutionRuntimeId, { expiresAt: number; catalog: RuntimeModelCatalog }>();

export interface ExecutionRuntimeDefinition {
  id: ExecutionRuntimeId;
  name: string;
  description: string;
  command: string;
  configHomeEnv?: string;
  capabilities: ExecutionRuntimeStatus["capabilities"];
}

export interface ExecutionRuntimeEnvironment {
  env: Record<string, string>;
  model?: string;
  profile?: ModelProfile;
}

export const EXECUTION_RUNTIME_DEFINITIONS: readonly ExecutionRuntimeDefinition[] = [
  {
    id: "cfuse",
    name: "CFuse",
    description: "可选的 CFuse 兼容底座，使用本机配置。",
    command: "cfuse",
    configHomeEnv: "CFUSE_CONFIG_DIR",
    capabilities: {
      stream: true,
      resume: true,
      modelOverride: true,
      sdkHooks: false,
      cliToolPolicy: true
    }
  },
  {
    id: "codex",
    name: "Codex CLI",
    description: "OpenAI Codex JSONL 执行底座，使用 Codex 本地认证与配置。",
    command: "codex",
    configHomeEnv: "CODEX_HOME",
    capabilities: {
      stream: true,
      resume: true,
      modelOverride: true,
      sdkHooks: false,
      cliToolPolicy: false
    }
  },
  {
    id: "dtcoder",
    name: "AiWork CLI",
    description: "默认执行底座，支持内部版 aiwork、外部版 aiworkcn 与海外版 aiworkcli。",
    command: "dtcoder",
    configHomeEnv: "AGENTIX_HOME",
    capabilities: {
      stream: true,
      resume: true,
      modelOverride: true,
      sdkHooks: false,
      cliToolPolicy: false
    }
  },
  {
    id: "claude-code",
    name: "Claude Code（兼容）",
    description: "旧版 Claude Agent SDK 执行链，仅用于存量环境兼容。",
    command: "claude",
    configHomeEnv: "CLAUDE_CONFIG_DIR",
    capabilities: {
      stream: true,
      resume: true,
      modelOverride: true,
      sdkHooks: true,
      cliToolPolicy: true
    }
  }
] as const;

export function getExecutionRuntimeDefinition(runtimeId: ExecutionRuntimeId): ExecutionRuntimeDefinition {
  return EXECUTION_RUNTIME_DEFINITIONS.find((runtime) => runtime.id === runtimeId)
    ?? EXECUTION_RUNTIME_DEFINITIONS.find((runtime) => runtime.id === DEFAULT_EXECUTION_RUNTIME_ID)
    ?? EXECUTION_RUNTIME_DEFINITIONS.find((runtime) => runtime.id === "dtcoder")!;
}

export function resolveExecutionRuntimeExecutable(runtimeId: ExecutionRuntimeId): string | undefined {
  const definition = getExecutionRuntimeDefinition(runtimeId);
  if (runtimeId === "dtcoder") return resolveDtcoderExecutable() || undefined;
  const fromPath = [definition.command]
    .map((command) => findExecutable(command))
    .find(Boolean);
  if (fromPath) return fromPath;

  const home = os.homedir();
  const nvmBins = findNvmBinDirs(home);
  const candidates: Record<ExecutionRuntimeId, string[]> = {
    cfuse: [path.join(home, ".local/bin/cfuse"), path.join(home, ".codefuse/bin/cfuse")],
    codex: [...nvmBins.map((dir) => path.join(dir, "codex")), path.join(home, ".local/bin/codex")],
    dtcoder: [],
    "claude-code": [...nvmBins.map((dir) => path.join(dir, "claude")), path.join(home, ".local/bin/claude")]
  };
  return candidates[runtimeId].find((candidate) => {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
}

export async function listExecutionRuntimeStatuses(): Promise<ExecutionRuntimeStatus[]> {
  const selectedRuntimeId = await getSelectedExecutionRuntimeId();
  return Promise.all(EXECUTION_RUNTIME_DEFINITIONS.map(async (definition) => {
    const executable = resolveExecutionRuntimeExecutable(definition.id);
    const storedProfile = await getActiveModelProfile(definition.id);
    const profile = effectiveRuntimeProfile(definition.id, storedProfile, stringEnv(process.env));
    const modelOverride = await getRuntimeModelOverride(definition.id);
    const detectedModel = profile?.model || modelOverride || await detectRuntimeDefaultModel(definition.id);
    const modelSource = profile?.model
      ? "profile" as const
      : modelOverride
        ? "runtime-override" as const
      : detectedModel
        ? "cli-config" as const
        : executable
          ? "runtime-default" as const
          : "unavailable" as const;
    if (!isExecutionRuntimeEnabled(definition.id)) {
      return {
        ...definition,
        executable,
        status: "disabled" as const,
        detail: executionRuntimeDisabledDetail(definition.id) ?? "执行底座已禁用",
        selected: false,
        default: false,
        modelProfile: profile ? toPublicProfile(profile) : undefined,
        currentModel: detectedModel,
        modelSource
      };
    }
    if (!executable) {
      const missingDetail = definition.id === "dtcoder"
        ? (process.env.UI_AGENT_AIWORK_BIN?.trim() || process.env.UI_AGENT_DTCODER_BIN?.trim())
          ? "UI_AGENT_AIWORK_BIN（或兼容变量 UI_AGENT_DTCODER_BIN）未指向可执行的绝对路径，请检查配置"
          : "未找到 aiwork、aiworkcn 或 aiworkcli；请安装并登录 AiWork CLI"
        : `未找到 ${definition.command} 命令`;
      return {
        ...definition,
        status: "missing" as const,
        detail: missingDetail,
        selected: definition.id === selectedRuntimeId,
        default: definition.id === DEFAULT_EXECUTION_RUNTIME_ID,
        modelProfile: profile ? toPublicProfile(profile) : undefined,
        currentModel: detectedModel,
        modelSource
      };
    }
    const cfuseCapabilityProbe = definition.id === "cfuse"
      ? detectCfuseCliCapabilities(executable, {
          ...stringEnv(process.env),
          PATH: resolveUserPath()
        })
      : undefined;
    try {
      const { stdout, stderr } = await execFileAsync(executable, ["--version"], {
        timeout: 10_000,
        env: { ...process.env, PATH: resolveUserPath() }
      });
      const rawVersion = stripControlSequences(stdout || stderr).trim().split("\n").filter(Boolean).at(-1) || "已安装";
      const version = definition.id === "cfuse"
        ? formatCfuseVersion(executable, rawVersion)
        : rawVersion;
      if (definition.id === "cfuse") {
        const detected = await cfuseCapabilityProbe!;
        const missingRequired = [
          !detected.print ? "-p/--print" : "",
          !detected.outputFormat ? "--output-format" : ""
        ].filter(Boolean);
        if (missingRequired.length) {
          return {
            ...definition,
            executable,
            version,
            status: "broken" as const,
            detail: `CFuse 缺少 UIWarden 必需参数：${missingRequired.join("、")}`,
            selected: definition.id === selectedRuntimeId,
            default: definition.id === DEFAULT_EXECUTION_RUNTIME_ID,
            modelProfile: profile ? toPublicProfile(profile) : undefined,
            currentModel: detectedModel,
            modelSource,
            compatibility: "compatible" as const,
            warnings: ["该 CFuse 只能用于交互式终端，不能作为 UIWarden 非交互执行底座。"],
            capabilities: {
              ...definition.capabilities,
              stream: Boolean(detected.outputFormat),
              resume: Boolean(detected.resume),
              modelOverride: Boolean(detected.model),
              cliToolPolicy: Boolean(detected.allowedTools)
            }
          };
        }
        const warnings = cfuseCapabilityWarnings(detected);
        return {
          ...definition,
          executable,
          version,
          status: "ready" as const,
          detail: executable,
          selected: definition.id === selectedRuntimeId,
          default: definition.id === DEFAULT_EXECUTION_RUNTIME_ID,
          modelProfile: profile ? toPublicProfile(profile) : undefined,
          currentModel: detectedModel,
          modelSource,
          compatibility: detected.probeStatus === "unavailable"
            ? "unknown" as const
            : warnings.length
              ? "compatible" as const
              : "full" as const,
          warnings,
          capabilities: {
            ...definition.capabilities,
            stream: true,
            resume: Boolean(detected.resume),
            modelOverride: Boolean(detected.model),
            cliToolPolicy: Boolean(detected.allowedTools)
          }
        };
      }
      return {
        ...definition,
        executable,
        version,
        status: "ready" as const,
        detail: executable,
        selected: definition.id === selectedRuntimeId,
        default: definition.id === DEFAULT_EXECUTION_RUNTIME_ID,
        modelProfile: profile ? toPublicProfile(profile) : undefined
        ,currentModel: detectedModel
        ,modelSource
      };
    } catch (error) {
      return {
        ...definition,
        executable,
        status: "broken" as const,
        detail: error instanceof Error ? error.message : String(error),
        selected: definition.id === selectedRuntimeId,
        default: definition.id === DEFAULT_EXECUTION_RUNTIME_ID,
        modelProfile: profile ? toPublicProfile(profile) : undefined
        ,currentModel: detectedModel
        ,modelSource
      };
    }
  }));
}

export async function detectRuntimeConfiguredModel(runtimeId: ExecutionRuntimeId, forceDtcoder = false): Promise<string | undefined> {
  const storedProfile = await getActiveModelProfile(runtimeId);
  const profile = effectiveRuntimeProfile(runtimeId, storedProfile, stringEnv(process.env));
  if (profile?.model) return profile.model;
  const modelOverride = await getRuntimeModelOverride(runtimeId);
  if (modelOverride) return modelOverride;
  return detectRuntimeDefaultModel(runtimeId, forceDtcoder);
}

async function detectRuntimeDefaultModel(
  runtimeId: ExecutionRuntimeId,
  forceDtcoder = false
): Promise<string | undefined> {
  if (runtimeId === "dtcoder") {
    const configured = detectDtcoderConfiguredModel();
    if (configured) return configured;
    if (forceDtcoder) return detectDtcoderModel(true);
    if (Date.now() < dtcoderModelCache.expiresAt) return dtcoderModelCache.model;
    return undefined;
  }
  if (runtimeId === "codex") {
    const root = process.env.CODEX_HOME?.trim() || path.join(os.homedir(), ".codex");
    return readTopLevelTomlString(path.join(root, "config.toml"), "model")
      || process.env.OPENAI_MODEL?.trim()
      || undefined;
  }
  if (runtimeId === "claude-code") {
    return process.env.ANTHROPIC_MODEL?.trim()
      || readJsonModel(path.join(process.env.CLAUDE_CONFIG_DIR?.trim() || path.join(os.homedir(), ".claude"), "settings.json"));
  }
  return detectCfuseConfiguredModel(stringEnv(process.env));
}

export function detectCfuseConfiguredModel(
  env: Record<string, string>,
  homeDir = os.homedir()
): string | undefined {
  const launcherModel = readJsonModel(path.join(homeDir, ".codefuse", "fuse", "codefuse.json"));
  const settingsModel = readJsonModel(findCfuseSettingsPath(env));
  const serviceModel = env.ANTHROPIC_MODEL?.trim() || undefined;

  // CFuse 本地状态存在时，执行链会隔离服务端 ANTHROPIC_* 环境变量。
  // 模型展示必须遵循同一优先级，否则配置中心会展示一个实际不会使用的模型。
  return hasCfuseLocalState(env, homeDir)
    ? launcherModel || settingsModel
    : serviceModel || launcherModel || settingsModel;
}

function readTopLevelTomlString(filePath: string, key: string): string | undefined {
  try {
    for (const line of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
      if (/^\s*\[/.test(line)) break;
      const match = line.match(new RegExp(`^\\s*${key}\\s*=\\s*[\"']([^\"']+)[\"']`));
      if (match?.[1]?.trim()) return match[1].trim();
    }
  } catch {
    // A missing local config means the runtime decides its default model.
  }
  return undefined;
}

function readJsonModel(filePath?: string): string | undefined {
  if (!filePath) return undefined;
  try {
    const value = JSON.parse(fs.readFileSync(filePath, "utf8")) as Record<string, unknown>;
    const custom = value.openaiConfig && typeof value.openaiConfig === "object"
      ? (value.openaiConfig as Record<string, unknown>).customModel
      : undefined;
    const settingsEnv = value.env && typeof value.env === "object"
      ? (value.env as Record<string, unknown>).ANTHROPIC_MODEL
      : undefined;
    return [value.model, settingsEnv, value.engine, custom]
      .find((item) => typeof item === "string" && item.trim()) as string | undefined;
  } catch {
    return undefined;
  }
}

export async function buildExecutionRuntimeEnvironment(
  runtimeId: ExecutionRuntimeId,
  extraEnv: Record<string, string>,
  options: { modelOverride?: string } = {}
): Promise<ExecutionRuntimeEnvironment> {
  const storedProfile = await getActiveModelProfile(runtimeId);
  const profile = effectiveRuntimeProfile(runtimeId, storedProfile, {
    ...stringEnv(process.env),
    ...extraEnv
  });
  const configuredModelOverride = await getRuntimeModelOverride(runtimeId);
  const requestedModel = options.modelOverride?.trim() || undefined;
  const selectedModel = requestedModel || profile?.model || configuredModelOverride;
  if (runtimeId === "claude-code") {
    const runtime = buildClaudeRuntimeEnv(extraEnv, profile);
    if (requestedModel || (configuredModelOverride && !profile?.model)) {
      const model = requestedModel || configuredModelOverride!;
      runtime.env.ANTHROPIC_MODEL = model;
      runtime.env.ANTHROPIC_SMALL_FAST_MODEL = model;
      runtime.env.ANTHROPIC_DEFAULT_SONNET_MODEL = model;
      runtime.env.ANTHROPIC_DEFAULT_HAIKU_MODEL = model;
      runtime.env.ANTHROPIC_DEFAULT_OPUS_MODEL = model;
    }
    return { ...runtime, model: selectedModel || runtime.model, profile };
  }

  const env: Record<string, string> = {
    ...stringEnv(process.env),
    ...extraEnv,
    PATH: resolveUserPath(),
    UIWARDEN_EXECUTION_RUNTIME: runtimeId
  };
  if (runtimeId === "cfuse") {
    if (profile?.authToken.trim() && profile.baseUrl.trim()) {
      const runtime = buildClaudeRuntimeEnv(extraEnv, profile, {
        settingsPath: resolveCfuseSettingsPath(env)
      });
      if (requestedModel) applyAnthropicModelOverride(runtime.env, requestedModel);
      runtime.env.UIWARDEN_EXECUTION_RUNTIME = runtimeId;
      runtime.env.PATH = resolveUserPath();
      return { ...runtime, model: selectedModel || runtime.model, profile };
    }
    if (shouldUseCfuseServiceEnvironment(env)) {
      const runtime = buildClaudeRuntimeEnv(extraEnv, undefined, {
        settingsPath: resolveCfuseSettingsPath(env)
      });
      if (requestedModel) applyAnthropicModelOverride(runtime.env, requestedModel);
      runtime.env.UIWARDEN_EXECUTION_RUNTIME = runtimeId;
      runtime.env.PATH = resolveUserPath();
      return { ...runtime, model: selectedModel || runtime.model, profile };
    }
    for (const key of Object.keys(env)) {
      if (key.startsWith("ANTHROPIC_") || key === "CLAUDE_CONFIG_DIR") delete env[key];
    }
    return { env, model: selectedModel || undefined, profile };
  }

  if (profile?.authToken.trim()) {
    env.OPENAI_API_KEY = profile.authToken;
    if (profile.baseUrl) env.OPENAI_BASE_URL = profile.baseUrl;
    if (runtimeId === "dtcoder") {
      env.ANTHROPIC_AUTH_TOKEN = profile.authToken;
      if (profile.baseUrl) env.ANTHROPIC_BASE_URL = profile.baseUrl;
    }
  }
  const model = runtimeId === "dtcoder" && !selectedModel
    ? await detectDtcoderModel()
    : selectedModel;
  return { env, model, profile };
}

function applyAnthropicModelOverride(env: Record<string, string>, model: string): void {
  env.ANTHROPIC_MODEL = model;
  env.ANTHROPIC_SMALL_FAST_MODEL = model;
  env.ANTHROPIC_DEFAULT_SONNET_MODEL = model;
  env.ANTHROPIC_DEFAULT_HAIKU_MODEL = model;
  env.ANTHROPIC_DEFAULT_OPUS_MODEL = model;
}

export async function listRuntimeModelCatalog(
  runtimeId: ExecutionRuntimeId,
  force = false
): Promise<RuntimeModelCatalog> {
  const cached = runtimeModelCatalogCache.get(runtimeId);
  if (!force && cached && cached.expiresAt > Date.now()) return cached.catalog;

  const storedProfile = await getActiveModelProfile(runtimeId);
  const profile = effectiveRuntimeProfile(runtimeId, storedProfile, stringEnv(process.env));
  const modelOverride = await getRuntimeModelOverride(runtimeId);
  const defaultModel = await detectRuntimeDefaultModel(runtimeId, runtimeId === "dtcoder");
  const discovered = await discoverRuntimeModels(runtimeId);
  const selectedModel = profile?.model || modelOverride;
  const currentModel = selectedModel || defaultModel;
  const models = mergeModelOptions(discovered.models, [currentModel, defaultModel]);
  const catalog: RuntimeModelCatalog = {
    runtimeId,
    currentModel,
    defaultModel,
    selectedModel,
    selectionMode: profile?.model ? "profile" : modelOverride ? "runtime-override" : "runtime-default",
    source: discovered.source,
    models,
    refreshable: true,
    warning: discovered.warning
  };
  runtimeModelCatalogCache.set(runtimeId, {
    expiresAt: Date.now() + (discovered.source === "runtime-api" ? 5 * 60_000 : 60_000),
    catalog
  });
  return catalog;
}

export function invalidateRuntimeModelCatalog(runtimeId: ExecutionRuntimeId): void {
  runtimeModelCatalogCache.delete(runtimeId);
}

async function discoverRuntimeModels(runtimeId: ExecutionRuntimeId): Promise<{
  models: RuntimeModelOption[];
  source: RuntimeModelCatalog["source"];
  warning?: string;
}> {
  if (runtimeId === "cfuse") return discoverCfuseModels();
  if (runtimeId === "dtcoder") {
    const payload = await runDtcoderJson(["models", "--json"], 15_000);
    const models = parseDtcoderModelCatalog(payload);
    return models.length
      ? { models, source: "runtime-api" }
      : { models, source: "fallback", warning: "AiWork CLI 未返回可用模型目录，仅展示当前模型。" };
  }
  if (runtimeId === "codex") {
    const root = process.env.CODEX_HOME?.trim() || path.join(os.homedir(), ".codex");
    const models = parseCodexModelCatalog(readJsonObject(path.join(root, "models_cache.json")));
    return models.length
      ? { models, source: "local-cache" }
      : { models, source: "fallback", warning: "Codex 本地模型缓存不存在，仅展示当前模型；运行一次 Codex 后可刷新。" };
  }
  return {
    models: ["sonnet", "opus", "haiku"].map((id) => ({
      id,
      label: id,
      source: "fallback" as const
    })),
    source: "fallback",
    warning: "Claude Code 未提供稳定的非交互模型目录接口，当前展示内置模型别名。"
  };
}

async function discoverCfuseModels(): Promise<{
  models: RuntimeModelOption[];
  source: RuntimeModelCatalog["source"];
  warning?: string;
}> {
  const catalogUrl = process.env.CFUSE_MODEL_CATALOG_URL?.trim();
  if (!catalogUrl) {
    return {
      models: [],
      source: "local-config",
      warning: "CFuse 模型目录地址未配置，仅展示当前模型。"
    };
  }
  const config = readJsonObject(path.join(os.homedir(), ".codefuse", "fuse", "codefuse.json"));
  const workId = typeof config.workid === "string" ? config.workid.trim() : "";
  if (!workId) {
    return {
      models: [],
      source: "local-config",
      warning: "CFuse 本地配置缺少用户标识，无法读取远端模型目录，仅展示当前模型。"
    };
  }
  try {
    const response = await fetch(catalogUrl, {
      headers: { "X-AGENT-USER": workId },
      signal: AbortSignal.timeout(8_000)
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = await response.json() as unknown;
    const models = parseCfuseModelCatalog(payload);
    return models.length
      ? { models, source: "runtime-api" }
      : { models, source: "local-config", warning: "CFuse 模型接口未返回可用模型，仅展示当前模型。" };
  } catch (error) {
    return {
      models: [],
      source: "local-config",
      warning: `CFuse 模型目录读取失败：${error instanceof Error ? error.message : String(error)}`
    };
  }
}

export function parseCfuseModelCatalog(payload: unknown): RuntimeModelOption[] {
  const root = asRecord(payload);
  const data = Array.isArray(root.data) ? root.data : Array.isArray(asRecord(root.data).models)
    ? asRecord(root.data).models as unknown[]
    : [];
  return data
    .map(asRecord)
    .filter((item) => item.visible !== false)
    .filter((item) => {
      const engines = Array.isArray(item.engine) ? item.engine.map(String) : [];
      return !engines.length || engines.includes("cfuse") || engines.includes("claude");
    })
    .flatMap((item): RuntimeModelOption[] => {
      const id = firstString(item.model, item.modelName, item.id);
      if (!id) return [];
      return [{
        id,
        label: firstString(item.displayName, item.name) || id,
        description: firstString(item.description, item.desc),
        provider: firstString(item.providerCategory, item.modelSource),
        source: "runtime-api" as const
      }];
    });
}

export function parseCodexModelCatalog(payload: unknown): RuntimeModelOption[] {
  const models = asRecord(payload).models;
  if (!Array.isArray(models)) return [];
  return models
    .map(asRecord)
    .filter((item) => item.visibility !== "hide" && item.supported_in_api !== false)
    .flatMap((item): RuntimeModelOption[] => {
      const id = firstString(item.slug, item.id);
      if (!id) return [];
      return [{
        id,
        label: firstString(item.display_name, item.name) || id,
        description: firstString(item.description),
        source: "local-cache" as const
      }];
    });
}

export function parseDtcoderModelCatalog(payload: unknown): RuntimeModelOption[] {
  const models = asRecord(payload).models;
  if (!Array.isArray(models)) return [];
  return models
    .map(asRecord)
    .flatMap((item): RuntimeModelOption[] => {
      const model = firstString(item.model_id, item.model, item.name);
      if (!model) return [];
      const provider = firstString(item.provider, item.provider_id);
      const id = provider ? `${provider}/${model}` : model;
      return [{
        id,
        label: model,
        description: item.reasoning === true ? "支持推理" : undefined,
        provider,
        source: "runtime-api" as const
      }];
    });
}

function mergeModelOptions(
  discovered: RuntimeModelOption[],
  required: Array<string | undefined>
): RuntimeModelOption[] {
  const models = new Map<string, RuntimeModelOption>();
  for (const item of discovered) {
    if (item.id.trim() && !models.has(item.id)) models.set(item.id, item);
  }
  for (const id of required) {
    if (id?.trim() && !models.has(id.trim())) {
      models.set(id.trim(), { id: id.trim(), label: id.trim(), source: "local-config" });
    }
  }
  return [...models.values()];
}

export async function detectDtcoderModel(force = false): Promise<string | undefined> {
  if (!force && Date.now() < dtcoderModelCache.expiresAt) return dtcoderModelCache.model;
  if (!resolveExecutionRuntimeExecutable("dtcoder")) return undefined;
  const defaults = await runDtcoderJson(["ping", "--all", "--json"], 25_000);
  const defaultResults = Array.isArray(defaults.results) ? defaults.results : [];
  const readyDefault = defaultResults.find((item) => {
    const record = item && typeof item === "object" ? item as Record<string, unknown> : {};
    return record.ok === true && typeof record.model_id === "string";
  }) as Record<string, unknown> | undefined;
  if (readyDefault) {
    const model = qualifyDtcoderModel(readyDefault);
    dtcoderModelCache = { expiresAt: Date.now() + 15 * 60_000, model };
    return model;
  }

  const catalog = await runDtcoderJson(["models", "--json"], 15_000);
  const models = (Array.isArray(catalog.models) ? catalog.models : [])
    .filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object"))
    .filter((item) => typeof item.model_id === "string")
    .sort((left, right) => dtcoderCandidateScore(left) - dtcoderCandidateScore(right));
  for (const candidate of models.slice(0, 6)) {
    const qualified = qualifyDtcoderModel(candidate);
    const probe = await runDtcoderJson(["ping", "--model", qualified, "--json"], 20_000);
    if (probe.ok === true) {
      dtcoderModelCache = { expiresAt: Date.now() + 15 * 60_000, model: qualified };
      return qualified;
    }
  }
  dtcoderModelCache = { expiresAt: Date.now() + 60_000, model: undefined };
  return undefined;
}

function detectDtcoderConfiguredModel(): string | undefined {
  const statePaths = [
    path.join(os.homedir(), ".agentix", "dtcoder-tui", "state", "model.json"),
    path.join(os.homedir(), ".agentix", "dtcoder-opentui", "state", "model.json")
  ];
  for (const statePath of statePaths) {
    const recent = readJsonObject(statePath).recent;
    if (!Array.isArray(recent)) continue;
    for (const item of recent) {
      const record = asRecord(item);
      const model = firstString(record.modelID, record.model_id, record.model);
      const provider = firstString(record.providerID, record.provider_id, record.provider);
      if (model) return provider ? `${provider}/${model}` : model;
    }
  }
  return undefined;
}

async function runDtcoderJson(args: string[], timeout: number): Promise<Record<string, unknown>> {
  const executable = resolveExecutionRuntimeExecutable("dtcoder");
  if (!executable) return {};
  try {
    const { stdout } = await execFileAsync(executable, args, {
      timeout,
      env: { ...process.env, PATH: resolveUserPath() }
    });
    return asRecord(JSON.parse(stdout || "{}") as unknown);
  } catch (error) {
    const stdout = (error as { stdout?: string }).stdout;
    try {
      return asRecord(JSON.parse(stdout || "{}") as unknown);
    } catch {
      return {};
    }
  }
}

function qualifyDtcoderModel(item: Record<string, unknown>): string {
  const model = String(item.model_id || "").trim();
  const provider = String(item.provider || item.provider_id || "").trim();
  return provider ? `${provider}/${model}` : model;
}

function dtcoderCandidateScore(item: Record<string, unknown>): number {
  const provider = String(item.provider || "").toLowerCase();
  const providerRank = provider.includes("domestic") ? 0 : provider.includes("foreign") ? 20 : 10;
  const reasoningRank = item.reasoning === true ? 2 : 0;
  return providerRank + reasoningRank;
}

function resolveCfuseSettingsPath(env: Record<string, string>): string {
  const configured = env.CFUSE_CONFIG_DIR?.trim();
  const root = configured || path.join(os.homedir(), ".codefuse");
  return findCfuseSettingsPath(env) || path.join(root, "settings.json");
}

function findCfuseSettingsPath(env: Record<string, string>): string | undefined {
  const configured = env.CFUSE_CONFIG_DIR?.trim();
  const root = configured || path.join(os.homedir(), ".codefuse");
  for (const name of ["settings.json", "config.json"]) {
    const candidate = path.join(root, name);
    if (fs.existsSync(candidate)) return candidate;
  }
  return undefined;
}

export function shouldUseCfuseServiceEnvironment(
  env: Record<string, string>,
  homeDir = os.homedir()
): boolean {
  const hasServiceAuth = Boolean(env.ANTHROPIC_AUTH_TOKEN?.trim() || env.ANTHROPIC_API_KEY?.trim());
  return hasServiceAuth && !hasCfuseLocalState(env, homeDir);
}

function hasCfuseLocalState(env: Record<string, string>, homeDir: string): boolean {
  const configured = env.CFUSE_CONFIG_DIR?.trim();
  const root = configured || path.join(homeDir, ".codefuse");
  // agent.lock、argv.json 和临时 IDENTITY 只能证明 CFuse 曾运行过，
  // 不能证明当前仍有可用认证；否则残留文件会错误屏蔽 UIWarden 服务凭据。
  if (["settings.json", "config.json"].some((name) => fs.existsSync(path.join(root, name)))) {
    return true;
  }
  return hasCfuseLauncherCredentials(path.join(homeDir, ".codefuse", "fuse", "codefuse.json"));
}

function effectiveRuntimeProfile(
  runtimeId: ExecutionRuntimeId,
  profile: ModelProfile | undefined,
  env: Record<string, string>,
  homeDir = os.homedir()
): ModelProfile | undefined {
  if (
    runtimeId === "cfuse"
    && profile?.id === DEFAULT_PROFILE_ID
    && hasCfuseLocalState(env, homeDir)
  ) {
    return undefined;
  }
  return profile;
}

function hasCfuseLauncherCredentials(filePath: string): boolean {
  try {
    const value = JSON.parse(fs.readFileSync(filePath, "utf8")) as Record<string, unknown>;
    return typeof value.token === "string" && Boolean(value.token.trim());
  } catch {
    return false;
  }
}

function findNvmBinDirs(home: string): string[] {
  const root = path.join(home, ".nvm", "versions", "node");
  try {
    return fs.readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(root, entry.name, "bin"))
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
  } catch {
    return [];
  }
}

function readJsonObject(filePath: string): Record<string, unknown> {
  try {
    return asRecord(JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown);
  } catch {
    return {};
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function firstString(...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === "string" && Boolean(value.trim()))?.trim();
}

function stripControlSequences(value: string): string {
  return value
    .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, "")
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "");
}

function formatCfuseVersion(executable: string, engineVersion: string): string {
  let launcherVersion = process.env.CFUSE_LAUNCHER_VERSION?.trim() || "";
  try {
    const resolved = fs.realpathSync(executable);
    launcherVersion ||= /codefuse-cli[/\\]versions[/\\]v?([^/\\]+)/.exec(resolved)?.[1] || "";
  } catch {
    // Keep the engine version when the launcher path cannot be resolved.
  }
  const engine = engineVersion.replace(/\s*\(Claude Code\)\s*/i, "").trim();
  if (launcherVersion && engine === launcherVersion) return `CFuse ${launcherVersion}`;
  return launcherVersion
    ? `CFuse ${launcherVersion} · 兼容引擎 ${engine}`
    : `CFuse · 兼容引擎 ${engine}`;
}

function stringEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === "string")
  );
}

function toPublicProfile(profile: ModelProfile): ExecutionRuntimeStatus["modelProfile"] {
  const { authToken, ...rest } = profile;
  return {
    ...rest,
    hasToken: Boolean(authToken),
    tokenMasked: authToken
      ? authToken.length <= 10 ? "*".repeat(authToken.length) : `${authToken.slice(0, 6)}…${authToken.slice(-4)}`
      : undefined
  };
}
