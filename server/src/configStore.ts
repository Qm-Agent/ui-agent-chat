import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { configDir } from "./paths.js";
import { getDatabase } from "./db/index.js";
import { TABLES } from "./db/schema.js";
import type {
  BusinessEnvironment,
  HostApplyStatus,
  HostEntry,
  PublicBusinessEnvironment
} from "./types.js";
import { applyHosts } from "./hostsManager.js";

const BUSINESS_FILE = path.join(configDir, "business-environments.json");
const HOSTS_FILE = path.join(configDir, "host-entries.json");
const GUI_RUNTIME_FILE = path.join(configDir, "gui-runtime.json");

export interface GuiRuntimeSettings {
  cliCompatibilityMode: boolean;
  updatedAt?: string;
}

const DEFAULT_GUI_RUNTIME_SETTINGS: GuiRuntimeSettings = {
  cliCompatibilityMode: true
};

export async function ensureConfigStorage(): Promise<void> {
  await fs.mkdir(configDir, { recursive: true });
}

/** 读取 GUI Runtime 传输设置；旧版本没有配置时保持兼容 CLI 默认行为。 */
export async function getGuiRuntimeSettings(): Promise<GuiRuntimeSettings> {
  await ensureConfigStorage();
  try {
    const stored = JSON.parse(await fs.readFile(GUI_RUNTIME_FILE, "utf8")) as Partial<GuiRuntimeSettings>;
    return {
      cliCompatibilityMode: stored.cliCompatibilityMode !== false,
      updatedAt: typeof stored.updatedAt === "string" ? stored.updatedAt : undefined
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      console.warn("[config] GUI Runtime 设置读取失败，使用兼容 CLI 默认值", error);
    }
    return { ...DEFAULT_GUI_RUNTIME_SETTINGS };
  }
}

/** 原子保存 GUI Runtime 传输设置。 */
export async function updateGuiRuntimeSettings(input: {
  cliCompatibilityMode?: unknown;
}): Promise<GuiRuntimeSettings> {
  if (typeof input.cliCompatibilityMode !== "boolean") {
    throw new Error("cliCompatibilityMode 必须是布尔值");
  }
  await ensureConfigStorage();
  const settings: GuiRuntimeSettings = {
    cliCompatibilityMode: input.cliCompatibilityMode,
    updatedAt: new Date().toISOString()
  };
  const temporary = `${GUI_RUNTIME_FILE}.${process.pid}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(settings, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await fs.rename(temporary, GUI_RUNTIME_FILE);
  return settings;
}

interface BusinessRow {
  id: string;
  name: string;
  url: string;
  username: string | null;
  password: string | null;
  description: string | null;
  created_at: string;
  updated_at: string;
}

interface HostRow {
  id: string;
  ip: string;
  hostname: string;
  comment: string | null;
  enabled: number;
  created_at: string;
  updated_at: string;
}

interface HostStatusRow {
  id: string;
  applied: number;
  message: string | null;
  applied_at: string | null;
  updated_at: string;
}

const STATUS_ROW_ID = "singleton";

function businessRowToEnv(row: BusinessRow): BusinessEnvironment {
  return {
    id: row.id,
    name: row.name,
    url: row.url,
    username: row.username ?? undefined,
    password: row.password ?? undefined,
    description: row.description ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function hostRowToEntry(row: HostRow): HostEntry {
  return {
    id: row.id,
    ip: row.ip,
    hostname: row.hostname,
    comment: row.comment ?? undefined,
    enabled: Boolean(row.enabled),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function statusRowToStatus(row: HostStatusRow): HostApplyStatus {
  return {
    applied: Boolean(row.applied),
    message: row.message ?? undefined,
    appliedAt: row.applied_at ?? undefined
  };
}

export async function listBusinessEnvironments(): Promise<PublicBusinessEnvironment[]> {
  await ensureConfigStorage();
  const { knex } = await getDatabase();
  const rows = await knex<BusinessRow>(TABLES.businessEnvironments)
    .select("*")
    .orderBy("updated_at", "desc");
  return rows.map(businessRowToEnv).map(toPublicBusinessEnvironment);
}

export async function getBusinessEnvironment(id?: string): Promise<BusinessEnvironment | undefined> {
  if (!id) {
    return undefined;
  }
  const { knex } = await getDatabase();
  const row = await knex<BusinessRow>(TABLES.businessEnvironments).where({ id }).first();
  return row ? businessRowToEnv(row) : undefined;
}

export async function upsertBusinessEnvironment(input: {
  id?: string;
  name?: string;
  url?: string;
  username?: string;
  password?: string;
  description?: string;
}): Promise<PublicBusinessEnvironment> {
  await ensureConfigStorage();
  const { knex } = await getDatabase();
  const now = new Date().toISOString();
  const existing = input.id
    ? await knex<BusinessRow>(TABLES.businessEnvironments).where({ id: input.id }).first()
    : undefined;
  const url = normalizeUrl(input.url ?? existing?.url);
  const next: BusinessEnvironment = {
    id: existing?.id ?? randomUUID(),
    name: normalizeText(input.name ?? existing?.name) ?? defaultName(url),
    url,
    username: normalizeText(input.username ?? existing?.username ?? undefined),
    password: normalizeText(input.password) ?? existing?.password ?? undefined,
    description: normalizeText(input.description ?? existing?.description ?? undefined),
    createdAt: existing?.created_at ?? now,
    updatedAt: now
  };
  await knex<BusinessRow>(TABLES.businessEnvironments)
    .insert({
      id: next.id,
      name: next.name,
      url: next.url,
      username: next.username ?? null,
      password: next.password ?? null,
      description: next.description ?? null,
      created_at: next.createdAt,
      updated_at: next.updatedAt
    })
    .onConflict("id")
    .merge({
      name: next.name,
      url: next.url,
      username: next.username ?? null,
      password: next.password ?? null,
      description: next.description ?? null,
      updated_at: next.updatedAt
    });
  return toPublicBusinessEnvironment(next);
}

export async function deleteBusinessEnvironment(id: string): Promise<void> {
  const { knex } = await getDatabase();
  await knex<BusinessRow>(TABLES.businessEnvironments).where({ id }).del();
}

export async function listHostEntries(): Promise<{ entries: HostEntry[]; status: HostApplyStatus }> {
  await ensureConfigStorage();
  const { knex } = await getDatabase();
  const [entryRows, statusRow] = await Promise.all([
    knex<HostRow>(TABLES.hostEntries).select("*").orderBy("updated_at", "desc"),
    knex<HostStatusRow>(TABLES.hostApplyStatus).where({ id: STATUS_ROW_ID }).first()
  ]);
  const status = statusRow
    ? statusRowToStatus(statusRow)
    : { applied: false, message: "尚未应用" };
  return { entries: entryRows.map(hostRowToEntry), status };
}

export function resolveHostEntryEnabled(inputEnabled?: boolean, existingEnabled?: number | boolean): boolean {
  if (inputEnabled !== undefined) return inputEnabled;
  if (existingEnabled !== undefined) return Boolean(existingEnabled);
  return true;
}

export async function upsertHostEntry(input: {
  id?: string;
  ip?: string;
  hostname?: string;
  comment?: string;
  enabled?: boolean;
}): Promise<{ entry: HostEntry; status: HostApplyStatus }> {
  await ensureConfigStorage();
  const { knex } = await getDatabase();
  const now = new Date().toISOString();
  const existing = input.id
    ? await knex<HostRow>(TABLES.hostEntries).where({ id: input.id }).first()
    : undefined;
  const entry: HostEntry = {
    id: existing?.id ?? randomUUID(),
    ip: normalizeIp(input.ip ?? existing?.ip ?? undefined),
    hostname: normalizeHostname(input.hostname ?? existing?.hostname ?? undefined),
    comment: normalizeText(input.comment ?? existing?.comment ?? undefined),
    enabled: resolveHostEntryEnabled(input.enabled, existing?.enabled),
    createdAt: existing?.created_at ?? now,
    updatedAt: now
  };
  await knex<HostRow>(TABLES.hostEntries)
    .insert({
      id: entry.id,
      ip: entry.ip,
      hostname: entry.hostname,
      comment: entry.comment ?? null,
      enabled: entry.enabled ? 1 : 0,
      created_at: entry.createdAt,
      updated_at: entry.updatedAt
    })
    .onConflict("id")
    .merge({
      ip: entry.ip,
      hostname: entry.hostname,
      comment: entry.comment ?? null,
      enabled: entry.enabled ? 1 : 0,
      updated_at: entry.updatedAt
    });
  const updated = (await knex<HostRow>(TABLES.hostEntries).select("*")).map(hostRowToEntry);
  const status = await applyAndPersistHosts(updated);
  return { entry, status };
}

export async function deleteHostEntry(id: string): Promise<HostApplyStatus> {
  const { knex } = await getDatabase();
  await knex<HostRow>(TABLES.hostEntries).where({ id }).del();
  const updated = (await knex<HostRow>(TABLES.hostEntries).select("*")).map(hostRowToEntry);
  return applyAndPersistHosts(updated);
}

export async function applyStoredHosts(): Promise<HostApplyStatus> {
  await ensureConfigStorage();
  const { knex } = await getDatabase();
  const entries = (await knex<HostRow>(TABLES.hostEntries).select("*")).map(hostRowToEntry);
  return applyAndPersistHosts(entries);
}

export function buildEnvironmentPrompt(env?: BusinessEnvironment, custom?: {
  url?: string;
  username?: string;
  password?: string;
}): string {
  const url = normalizeText(custom?.url) ?? env?.url;
  const username = normalizeText(custom?.username) ?? env?.username;
  const password = normalizeText(custom?.password) ?? env?.password;
  const parts = [];
  if (env) {
    parts.push(`业务名称：${env.name}`);
  }
  if (url) {
    parts.push(`业务 URL：${url}`);
  }
  if (username) {
    parts.push(`账号：${username}`);
  }
  if (password) {
    parts.push(`密码：${password}`);
  }
  return parts.length ? `\n\n执行环境信息：\n${parts.map((part) => `- ${part}`).join("\n")}` : "";
}

function toPublicBusinessEnvironment(env: BusinessEnvironment): PublicBusinessEnvironment {
  const { password: _password, ...publicEnv } = env;
  const hasPassword = Boolean(env.password);
  return {
    ...publicEnv,
    hasPassword,
    passwordMasked: hasPassword ? "******" : undefined
  };
}

async function applyAndPersistHosts(entries: HostEntry[]): Promise<HostApplyStatus> {
  const status = await applyHosts(entries);
  const { knex } = await getDatabase();
  const now = new Date().toISOString();
  await knex<HostStatusRow>(TABLES.hostApplyStatus)
    .insert({
      id: STATUS_ROW_ID,
      applied: status.applied ? 1 : 0,
      message: status.message ?? null,
      applied_at: status.appliedAt ?? null,
      updated_at: now
    })
    .onConflict("id")
    .merge({
      applied: status.applied ? 1 : 0,
      message: status.message ?? null,
      applied_at: status.appliedAt ?? null,
      updated_at: now
    });
  return status;
}

function normalizeUrl(value?: string): string {
  const text = normalizeText(value);
  if (!text) {
    throw new Error("请填写业务 URL");
  }
  return /^https?:\/\//i.test(text) ? text : `https://${text}`;
}

function normalizeIp(value?: string): string {
  const text = normalizeText(value);
  if (!text || !/^[0-9a-fA-F:.]+$/.test(text)) {
    throw new Error("请填写合法 IP");
  }
  return text;
}

function normalizeHostname(value?: string): string {
  const text = normalizeText(value);
  if (!text || !/^[a-zA-Z0-9._-]+$/.test(text)) {
    throw new Error("请填写合法 hostname");
  }
  return text;
}

function normalizeText(value?: string): string | undefined {
  const text = value?.trim();
  return text ? text : undefined;
}

function defaultName(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

// Exported for migration use only.
export const LEGACY_FILES = { BUSINESS_FILE, HOSTS_FILE };
