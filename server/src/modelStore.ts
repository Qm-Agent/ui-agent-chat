import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { configDir } from "./paths.js";
import { getDatabase } from "./db/index.js";
import { TABLES } from "./db/schema.js";
import type { ExecutionRuntimeId, ModelProfile, PublicModelProfile } from "./types.js";
import { isExecutionRuntimeEnabled } from "./executionRuntimePolicy.js";
import { testModelProfileConnection, type ModelConnectionResult } from "./modelConnection.js";

const MODELS_FILE = path.join(configDir, "models.json");
export const DEFAULT_PROFILE_ID = "default-minimax-m25";
const DEFAULT_PROFILE_TOKEN = process.env.UI_AGENT_DEFAULT_MODEL_AUTH_TOKEN?.trim() ?? "";
const DEFAULT_PROFILE_MODEL = DEFAULT_PROFILE_TOKEN
  ? process.env.ANTHROPIC_MODEL?.trim() || "MiniMax-M2.5"
  : "";

const DEFAULT_PROFILE: ModelProfile = {
  id: DEFAULT_PROFILE_ID,
  runtimeId: "cfuse",
  name: "CFuse 本地/服务配置",
  baseUrl: DEFAULT_PROFILE_TOKEN
    ? process.env.ANTHROPIC_BASE_URL?.trim() || "https://api.minimaxi.com/anthropic"
    : "",
  authToken: DEFAULT_PROFILE_TOKEN,
  model: DEFAULT_PROFILE_MODEL,
  smallFastModel: DEFAULT_PROFILE_TOKEN
    ? process.env.ANTHROPIC_SMALL_FAST_MODEL?.trim() || DEFAULT_PROFILE_MODEL
    : "",
  sonnetModel: DEFAULT_PROFILE_TOKEN
    ? process.env.ANTHROPIC_DEFAULT_SONNET_MODEL?.trim() || DEFAULT_PROFILE_MODEL
    : "",
  haikuModel: DEFAULT_PROFILE_TOKEN
    ? process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL?.trim() || DEFAULT_PROFILE_MODEL
    : "",
  opusModel: DEFAULT_PROFILE_TOKEN
    ? process.env.ANTHROPIC_DEFAULT_OPUS_MODEL?.trim() || DEFAULT_PROFILE_MODEL
    : "",
  isDefault: true,
  isActive: true,
  createdAt: "2025-01-01T00:00:00.000Z",
  updatedAt: "2025-01-01T00:00:00.000Z"
};

interface ModelProfileRow {
  id: string;
  runtime_id: string;
  name: string;
  base_url: string;
  auth_token: string;
  model: string;
  small_fast_model: string | null;
  sonnet_model: string | null;
  haiku_model: string | null;
  opus_model: string | null;
  is_default: number;
  created_at: string;
  updated_at: string;
}

interface ModelSettingsRow {
  id: string;
  active_id: string;
  active_profile_ids_json: string;
  model_overrides_json: string;
  execution_runtime_id: string;
  updated_at: string;
}

const SETTINGS_ROW_ID = "singleton";
const EXECUTION_RUNTIME_IDS = new Set<ExecutionRuntimeId>(["cfuse", "codex", "dtcoder", "claude-code"]);

export class ModelProfileValidationError extends Error {
  constructor(message: string, readonly statusCode = 400) {
    super(message);
    this.name = "ModelProfileValidationError";
  }
}

export const DEFAULT_EXECUTION_RUNTIME_ID = normalizeRuntimeId(
  process.env.UI_AGENT_DEFAULT_EXECUTION_RUNTIME,
  "dtcoder"
);

async function ensureConfigStorage(): Promise<void> {
  await fs.mkdir(configDir, { recursive: true });
}

function rowToProfile(row: ModelProfileRow): ModelProfile {
  return {
    id: row.id,
    runtimeId: normalizeRuntimeId(row.runtime_id, "claude-code"),
    name: row.name,
    baseUrl: row.base_url,
    authToken: row.auth_token,
    model: row.model,
    smallFastModel: row.small_fast_model ?? undefined,
    sonnetModel: row.sonnet_model ?? undefined,
    haikuModel: row.haiku_model ?? undefined,
    opusModel: row.opus_model ?? undefined,
    isDefault: Boolean(row.is_default),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export function validateCfuseExplicitProfile(input: {
  baseUrl: string;
  authToken: string;
  model: string;
}): void {
  const hasBaseUrl = Boolean(input.baseUrl);
  const hasAuthToken = Boolean(input.authToken);
  if (hasBaseUrl !== hasAuthToken) {
    throw new ModelProfileValidationError("CFuse 自定义路由必须同时填写 API Base URL 和 API Token");
  }
  if (hasBaseUrl) {
    if (!input.model) {
      throw new ModelProfileValidationError("CFuse 自定义路由必须填写主模型");
    }
    return;
  }
  if (!input.model) return;
  const isBuiltInAlias = /^(?:opus|sonnet|haiku)(?:\[[^\]]+\])?$/i.test(input.model);
  const isClaudeModel = /^claude-/i.test(input.model);
  if (!input.model.includes("/") && !isBuiltInAlias && !isClaudeModel) {
    throw new ModelProfileValidationError(
      `使用 CFuse 本地供应商时，模型必须填写带渠道前缀的 ID，例如 antchat/${input.model}；也可以同时填写 Base URL 和 Token 建立独立路由`
    );
  }
}

export function validateDtcoderExplicitProfile(input: {
  baseUrl: string;
  authToken: string;
  model: string;
}): void {
  if (!input.baseUrl && !input.authToken) return;
  if (!input.model.includes("/") || input.model.startsWith("/") || input.model.endsWith("/")) {
    throw new ModelProfileValidationError(
      "DTCoder 自定义路由的主模型必须填写完整 provider/model，例如 maas/claude-opus-4-8"
    );
  }
}

async function readActiveId(): Promise<string> {
  const { knex } = await getDatabase();
  const row = await knex<ModelSettingsRow>(TABLES.modelSettings)
    .where({ id: SETTINGS_ROW_ID })
    .first();
  return row?.active_id || DEFAULT_PROFILE_ID;
}

type RuntimeProfileSelections = Partial<Record<ExecutionRuntimeId, string | null>>;
type RuntimeModelOverrides = Partial<Record<ExecutionRuntimeId, string>>;

async function readRuntimeSelections(): Promise<{ selections: RuntimeProfileSelections; explicit: Set<ExecutionRuntimeId> }> {
  const { knex } = await getDatabase();
  const row = await knex<ModelSettingsRow>(TABLES.modelSettings).where({ id: SETTINGS_ROW_ID }).first();
  try {
    const parsed = JSON.parse(row?.active_profile_ids_json || "{}") as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { selections: {}, explicit: new Set() };
    const selections: RuntimeProfileSelections = {};
    const explicit = new Set<ExecutionRuntimeId>();
    for (const runtimeId of EXECUTION_RUNTIME_IDS) {
      if (!Object.prototype.hasOwnProperty.call(parsed, runtimeId)) continue;
      const value = (parsed as Record<string, unknown>)[runtimeId];
      if (value === null || typeof value === "string") {
        selections[runtimeId] = typeof value === "string" && value.trim() ? value.trim() : null;
        explicit.add(runtimeId);
      }
    }
    return { selections, explicit };
  } catch {
    return { selections: {}, explicit: new Set() };
  }
}

async function writeRuntimeSelection(runtimeId: ExecutionRuntimeId, profileId: string | null): Promise<void> {
  const { knex } = await getDatabase();
  const current = await knex<ModelSettingsRow>(TABLES.modelSettings).where({ id: SETTINGS_ROW_ID }).first();
  const { selections } = await readRuntimeSelections();
  selections[runtimeId] = profileId;
  const now = new Date().toISOString();
  await knex<ModelSettingsRow>(TABLES.modelSettings)
    .insert({
      id: SETTINGS_ROW_ID,
      active_id: profileId || current?.active_id || DEFAULT_PROFILE_ID,
      active_profile_ids_json: JSON.stringify(selections),
      model_overrides_json: current?.model_overrides_json || "{}",
      execution_runtime_id: normalizeRuntimeId(current?.execution_runtime_id, DEFAULT_EXECUTION_RUNTIME_ID),
      updated_at: now
    })
    .onConflict("id")
    .merge({
      active_id: profileId || current?.active_id || DEFAULT_PROFILE_ID,
      active_profile_ids_json: JSON.stringify(selections),
      updated_at: now
    });
}

async function readRuntimeModelOverrides(): Promise<RuntimeModelOverrides> {
  const { knex } = await getDatabase();
  const row = await knex<ModelSettingsRow>(TABLES.modelSettings).where({ id: SETTINGS_ROW_ID }).first();
  try {
    const parsed = JSON.parse(row?.model_overrides_json || "{}") as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const overrides: RuntimeModelOverrides = {};
    for (const runtimeId of EXECUTION_RUNTIME_IDS) {
      const value = (parsed as Record<string, unknown>)[runtimeId];
      if (typeof value === "string" && value.trim()) overrides[runtimeId] = value.trim();
    }
    return overrides;
  } catch {
    return {};
  }
}

export async function getRuntimeModelOverride(runtimeId: ExecutionRuntimeId): Promise<string | undefined> {
  return (await readRuntimeModelOverrides())[runtimeId];
}

export async function selectRuntimeModel(runtimeId: ExecutionRuntimeId, model?: string | null): Promise<void> {
  const { knex } = await getDatabase();
  const current = await knex<ModelSettingsRow>(TABLES.modelSettings).where({ id: SETTINGS_ROW_ID }).first();
  const overrides = await readRuntimeModelOverrides();
  const normalized = normalizeText(model ?? undefined);
  if (normalized) overrides[runtimeId] = normalized;
  else delete overrides[runtimeId];
  const { selections } = await readRuntimeSelections();
  selections[runtimeId] = null;
  const now = new Date().toISOString();
  await knex<ModelSettingsRow>(TABLES.modelSettings)
    .insert({
      id: SETTINGS_ROW_ID,
      active_id: current?.active_id || DEFAULT_PROFILE_ID,
      active_profile_ids_json: JSON.stringify(selections),
      model_overrides_json: JSON.stringify(overrides),
      execution_runtime_id: normalizeRuntimeId(current?.execution_runtime_id, DEFAULT_EXECUTION_RUNTIME_ID),
      updated_at: now
    })
    .onConflict("id")
    .merge({
      active_profile_ids_json: JSON.stringify(selections),
      model_overrides_json: JSON.stringify(overrides),
      updated_at: now
    });
}

export async function getSelectedExecutionRuntimeId(): Promise<ExecutionRuntimeId> {
  const { knex } = await getDatabase();
  const row = await knex<ModelSettingsRow>(TABLES.modelSettings)
    .where({ id: SETTINGS_ROW_ID })
    .first();
  const selected = normalizeRuntimeId(row?.execution_runtime_id, DEFAULT_EXECUTION_RUNTIME_ID);
  if (isExecutionRuntimeEnabled(selected)) return selected;

  await knex<ModelSettingsRow>(TABLES.modelSettings)
    .where({ id: SETTINGS_ROW_ID })
    .update({ execution_runtime_id: DEFAULT_EXECUTION_RUNTIME_ID, updated_at: new Date().toISOString() });
  return DEFAULT_EXECUTION_RUNTIME_ID;
}

async function writeActiveId(activeId: string): Promise<void> {
  const { knex } = await getDatabase();
  await knex<ModelSettingsRow>(TABLES.modelSettings)
    .insert({
      id: SETTINGS_ROW_ID,
      active_id: activeId,
      active_profile_ids_json: "{}",
      model_overrides_json: "{}",
      execution_runtime_id: await getSelectedExecutionRuntimeId(),
      updated_at: new Date().toISOString()
    })
    .onConflict("id")
    .merge({ active_id: activeId, updated_at: new Date().toISOString() });
}

export async function selectExecutionRuntime(runtimeId: ExecutionRuntimeId): Promise<void> {
  const selected = normalizeRuntimeId(runtimeId, DEFAULT_EXECUTION_RUNTIME_ID);
  if (!isExecutionRuntimeEnabled(selected)) {
    throw new ModelProfileValidationError("Claude Code 兼容底座当前已禁用，请使用默认的 DTCoder 底座");
  }
  const { knex } = await getDatabase();
  const current = await knex<ModelSettingsRow>(TABLES.modelSettings)
    .where({ id: SETTINGS_ROW_ID })
    .first();
  await knex<ModelSettingsRow>(TABLES.modelSettings)
    .insert({
      id: SETTINGS_ROW_ID,
      active_id: current?.active_id || DEFAULT_PROFILE_ID,
      active_profile_ids_json: current?.active_profile_ids_json || "{}",
      model_overrides_json: current?.model_overrides_json || "{}",
      execution_runtime_id: selected,
      updated_at: new Date().toISOString()
    })
    .onConflict("id")
    .merge({ execution_runtime_id: selected, updated_at: new Date().toISOString() });
}

export async function listModelProfiles(): Promise<PublicModelProfile[]> {
  await ensureConfigStorage();
  const { knex } = await getDatabase();
  const rows = await knex<ModelProfileRow>(TABLES.modelProfiles).select("*");
  const custom = rows.map(rowToProfile);
  const all = [DEFAULT_PROFILE, ...custom];
  const activeProfiles = new Map<ExecutionRuntimeId, string>();
  await Promise.all([...EXECUTION_RUNTIME_IDS].map(async (runtimeId) => {
    const profile = await getActiveModelProfile(runtimeId);
    if (profile) activeProfiles.set(runtimeId, profile.id);
  }));
  return all.map((p) => toPublic({
    ...p,
    isActive: p.id === activeProfiles.get(p.runtimeId)
  }));
}

export async function getActiveModelProfile(runtimeId?: ExecutionRuntimeId): Promise<ModelProfile | undefined> {
  const { knex } = await getDatabase();
  const selectedRuntimeId = runtimeId ?? await getSelectedExecutionRuntimeId();
  const { selections, explicit } = await readRuntimeSelections();
  if (explicit.has(selectedRuntimeId)) {
    const selectedId = selections[selectedRuntimeId];
    if (!selectedId) return undefined;
    if (selectedId === DEFAULT_PROFILE_ID && selectedRuntimeId === DEFAULT_PROFILE.runtimeId) {
      return { ...DEFAULT_PROFILE, isActive: true };
    }
    const selectedRow = await knex<ModelProfileRow>(TABLES.modelProfiles).where({ id: selectedId }).first();
    return selectedRow && rowToProfile(selectedRow).runtimeId === selectedRuntimeId
      ? { ...rowToProfile(selectedRow), isActive: true }
      : undefined;
  }
  const activeId = await readActiveId();
  if (activeId === DEFAULT_PROFILE_ID && selectedRuntimeId === DEFAULT_PROFILE.runtimeId) {
    return { ...DEFAULT_PROFILE, isActive: true };
  }
  const row = await knex<ModelProfileRow>(TABLES.modelProfiles).where({ id: activeId }).first();
  if (row && rowToProfile(row).runtimeId === selectedRuntimeId) {
    return { ...rowToProfile(row), isActive: true };
  }
  if (selectedRuntimeId === DEFAULT_PROFILE.runtimeId) {
    return { ...DEFAULT_PROFILE, isActive: true };
  }
  const fallback = await knex<ModelProfileRow>(TABLES.modelProfiles)
    .where({ runtime_id: selectedRuntimeId })
    .orderBy("updated_at", "desc")
    .first();
  return fallback ? { ...rowToProfile(fallback), isActive: false } : undefined;
}

export interface ModelProfileInput {
  id?: string;
  runtimeId?: ExecutionRuntimeId;
  name?: string;
  baseUrl?: string;
  authToken?: string;
  model?: string;
  smallFastModel?: string;
  sonnetModel?: string;
  haikuModel?: string;
  opusModel?: string;
}

export async function upsertModelProfile(
  input: ModelProfileInput,
  options: { testConnection?: boolean } = {}
): Promise<PublicModelProfile> {
  if (input.id === DEFAULT_PROFILE_ID) {
    throw new ModelProfileValidationError("默认模型档案不可编辑");
  }
  if (input.runtimeId !== undefined && !EXECUTION_RUNTIME_IDS.has(input.runtimeId)) {
    throw new ModelProfileValidationError("不支持的执行底座");
  }
  const { knex } = await getDatabase();
  const now = new Date().toISOString();
  const existing = input.id
    ? await knex<ModelProfileRow>(TABLES.modelProfiles).where({ id: input.id }).first()
    : undefined;

  const name = normalizeText(input.name ?? existing?.name) ?? "自定义模型";
  const runtimeId = normalizeRuntimeId(input.runtimeId ?? existing?.runtime_id, DEFAULT_EXECUTION_RUNTIME_ID);
  const runtimeChanged = Boolean(existing && normalizeRuntimeId(existing.runtime_id, "claude-code") !== runtimeId);
  let baseUrl = normalizeUrl(input.baseUrl ?? existing?.base_url) ?? "";
  const model = normalizeText(input.model ?? existing?.model) ?? "";
  let authToken = normalizeText(input.authToken);
  if (!authToken && !runtimeChanged) {
    authToken = existing?.auth_token;
  }
  if (runtimeId === "claude-code" && (!baseUrl || !authToken || !model)) {
    throw new ModelProfileValidationError("Claude Code 模型档案必须填写 API Base URL、API Token 和模型名称");
  }
  if ((baseUrl && !authToken) || (!baseUrl && authToken)) {
    throw new ModelProfileValidationError("自定义路由必须同时填写 API Base URL 和 API Token");
  }
  if (baseUrl && !model) {
    throw new ModelProfileValidationError("自定义路由必须填写主模型");
  }
  if (runtimeId === "cfuse") {
    validateCfuseExplicitProfile({ baseUrl, authToken: authToken ?? "", model });
  }
  if (runtimeId === "dtcoder") {
    validateDtcoderExplicitProfile({ baseUrl, authToken: authToken ?? "", model });
  }

  const profile: ModelProfile = {
    id: existing?.id ?? randomUUID(),
    runtimeId,
    name,
    baseUrl,
    authToken: authToken ?? "",
    model,
    smallFastModel: normalizeText(input.smallFastModel) ?? model,
    sonnetModel: normalizeText(input.sonnetModel) ?? model,
    haikuModel: normalizeText(input.haikuModel) ?? model,
    opusModel: normalizeText(input.opusModel) ?? model,
    isDefault: false,
    isActive: false,
    createdAt: existing?.created_at ?? now,
    updatedAt: now
  };

  if (options.testConnection) {
    try {
      await testModelProfileConnection(profile);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new ModelProfileValidationError(`模型路由联通测试失败：${detail}`, 422);
    }
  }

  await knex<ModelProfileRow>(TABLES.modelProfiles)
    .insert({
      id: profile.id,
      runtime_id: profile.runtimeId,
      name: profile.name,
      base_url: profile.baseUrl,
      auth_token: profile.authToken,
      model: profile.model,
      small_fast_model: profile.smallFastModel ?? null,
      sonnet_model: profile.sonnetModel ?? null,
      haiku_model: profile.haikuModel ?? null,
      opus_model: profile.opusModel ?? null,
      is_default: 0,
      created_at: profile.createdAt,
      updated_at: profile.updatedAt
    })
    .onConflict("id")
    .merge({
      name: profile.name,
      runtime_id: profile.runtimeId,
      base_url: profile.baseUrl,
      auth_token: profile.authToken,
      model: profile.model,
      small_fast_model: profile.smallFastModel ?? null,
      sonnet_model: profile.sonnetModel ?? null,
      haiku_model: profile.haikuModel ?? null,
      opus_model: profile.opusModel ?? null,
      updated_at: profile.updatedAt
    });
  const active = await getActiveModelProfile(runtimeId);
  return toPublic({ ...profile, isActive: profile.id === active?.id });
}

export async function testModelProfileInputConnection(input: ModelProfileInput): Promise<ModelConnectionResult> {
  if (input.id === DEFAULT_PROFILE_ID) {
    throw new ModelProfileValidationError("默认模型档案不可编辑");
  }
  const { knex } = await getDatabase();
  const existing = input.id
    ? await knex<ModelProfileRow>(TABLES.modelProfiles).where({ id: input.id }).first()
    : undefined;
  const runtimeId = normalizeRuntimeId(input.runtimeId ?? existing?.runtime_id, DEFAULT_EXECUTION_RUNTIME_ID);
  const runtimeChanged = Boolean(existing && normalizeRuntimeId(existing.runtime_id, "claude-code") !== runtimeId);
  const baseUrl = normalizeUrl(input.baseUrl ?? existing?.base_url) ?? "";
  let authToken = normalizeText(input.authToken);
  if (!authToken && !runtimeChanged) authToken = existing?.auth_token;
  const model = normalizeText(input.model ?? existing?.model) ?? "";
  if ((baseUrl && !authToken) || (!baseUrl && authToken) || (baseUrl && !model)) {
    throw new ModelProfileValidationError("自定义路由必须同时填写 API Base URL、API Token 和主模型");
  }
  if (runtimeId === "cfuse") validateCfuseExplicitProfile({ baseUrl, authToken: authToken ?? "", model });
  if (runtimeId === "dtcoder") validateDtcoderExplicitProfile({ baseUrl, authToken: authToken ?? "", model });
  try {
    return await testModelProfileConnection({
      id: existing?.id ?? "connection-test",
      runtimeId,
      name: normalizeText(input.name ?? existing?.name) ?? "待测试路由",
      baseUrl,
      authToken: authToken ?? "",
      model,
      smallFastModel: normalizeText(input.smallFastModel) ?? model,
      sonnetModel: normalizeText(input.sonnetModel) ?? model,
      haikuModel: normalizeText(input.haikuModel) ?? model,
      opusModel: normalizeText(input.opusModel) ?? model,
      createdAt: existing?.created_at ?? new Date().toISOString(),
      updatedAt: new Date().toISOString()
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new ModelProfileValidationError(`模型路由联通测试失败：${detail}`, 422);
  }
}

export async function deleteModelProfile(id: string): Promise<void> {
  if (id === DEFAULT_PROFILE_ID) {
    throw new ModelProfileValidationError("默认模型档案不可删除");
  }
  const { knex } = await getDatabase();
  await knex<ModelProfileRow>(TABLES.modelProfiles).where({ id }).del();
  const activeId = await readActiveId();
  if (activeId === id) {
    await writeActiveId(DEFAULT_PROFILE_ID);
  }
  const { selections, explicit } = await readRuntimeSelections();
  for (const runtimeId of EXECUTION_RUNTIME_IDS) {
    if (explicit.has(runtimeId) && selections[runtimeId] === id) await writeRuntimeSelection(runtimeId, null);
  }
}

export async function activateModelProfile(id: string): Promise<PublicModelProfile[]> {
  const { knex } = await getDatabase();
  let runtimeId = DEFAULT_PROFILE.runtimeId;
  if (id !== DEFAULT_PROFILE_ID) {
    const exists = await knex<ModelProfileRow>(TABLES.modelProfiles).where({ id }).first();
    if (!exists) {
      throw new Error("模型档案不存在");
    }
    runtimeId = rowToProfile(exists).runtimeId;
  }
  await writeRuntimeSelection(runtimeId, id);
  const overrides = await readRuntimeModelOverrides();
  if (overrides[runtimeId]) {
    delete overrides[runtimeId];
    const { knex } = await getDatabase();
    await knex<ModelSettingsRow>(TABLES.modelSettings)
      .where({ id: SETTINGS_ROW_ID })
      .update({ model_overrides_json: JSON.stringify(overrides), updated_at: new Date().toISOString() });
  }
  return listModelProfiles();
}

export async function clearActiveModelProfile(runtimeId: ExecutionRuntimeId): Promise<PublicModelProfile[]> {
  await selectRuntimeModel(runtimeId, null);
  return listModelProfiles();
}

function toPublic(profile: ModelProfile): PublicModelProfile {
  const { authToken: _token, ...rest } = profile;
  return {
    ...rest,
    hasToken: Boolean(profile.authToken),
    tokenMasked: profile.authToken ? maskToken(profile.authToken) : undefined
  };
}

function maskToken(token: string): string {
  if (token.length <= 10) {
    return "*".repeat(token.length);
  }
  return `${token.slice(0, 6)}…${token.slice(-4)}`;
}

function normalizeUrl(value?: string): string | undefined {
  const text = normalizeText(value);
  if (!text) {
    return undefined;
  }
  return /^https?:\/\//i.test(text) ? text : `https://${text}`;
}

function normalizeText(value?: string): string | undefined {
  const text = value?.trim();
  return text ? text : undefined;
}

function normalizeRuntimeId(value: unknown, fallback: ExecutionRuntimeId): ExecutionRuntimeId {
  return EXECUTION_RUNTIME_IDS.has(value as ExecutionRuntimeId)
    ? value as ExecutionRuntimeId
    : fallback;
}

// Exported for migration use only.
export { DEFAULT_PROFILE };
export const LEGACY_MODELS_FILE = MODELS_FILE;
