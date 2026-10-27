/**
 * Skill config/.env 用户配置存储。
 *
 * 分层模型：
 * - base 层：skill 源目录 config/.env（不存在则 config/.env.example）——随安装包分发，只读；
 * - 用户覆盖层：dataDir/config/skill.env——UI 编辑保存的持久层，升级客户端不丢失；
 * - 生效合并（workspace.ts writeSkillEnv）：base < process.env(SKILL_ENV_PREFIXES) < 用户覆盖层。
 *
 * 敏感 key（TOKEN/KEY/PASSWORD/SECRET）在 GET 返回时掩码，UI 可请求明文用于编辑。
 */
import fs from "node:fs/promises";
import path from "node:path";
import { configDir, skillSourceDir } from "./paths.js";
import { validateConfiguredBrowserProfile } from "./browserProfiles.js";

/** 用户覆盖层持久化文件。 */
export const userSkillEnvFile = path.join(configDir, "skill.env");

export interface SkillEnvEntry {
  key: string;
  value: string;
  /** base=skill 内置默认；user=用户覆盖层 */
  source: "base" | "user";
  sensitive: boolean;
  /** 掩码后的展示值（sensitive 且未请求明文时使用） */
  maskedValue?: string;
  /** 参数解释（来自 .env 注释或用户新增时填写） */
  description?: string;
}

const SENSITIVE_KEY_PATTERN = /(TOKEN|KEY|PASSWORD|SECRET|CREDENTIAL)/i;

export function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY_PATTERN.test(key);
}

function maskValue(value: string): string {
  if (!value) return "";
  if (value.length <= 6) return "******";
  return `${value.slice(0, 3)}****${value.slice(-3)}`;
}

export function parseEnvText(text: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq > 0) {
      map.set(trimmed.slice(0, eq), trimmed.slice(eq + 1));
    }
  }
  return map;
}

/**
 * 解析 .env 文本并提取每个 key 上方紧邻的注释行作为参数解释。
 * 连续多行注释合并为一段；空行会打断注释与 key 的关联。
 */
export function parseEnvDescriptions(text: string): Map<string, string> {
  const map = new Map<string, string>();
  let pending: string[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) {
      pending = [];
      continue;
    }
    if (trimmed.startsWith("#")) {
      pending.push(trimmed.replace(/^#+\s*/, ""));
      continue;
    }
    const eq = trimmed.indexOf("=");
    if (eq > 0 && pending.length) {
      map.set(trimmed.slice(0, eq), pending.join("\n"));
    }
    pending = [];
  }
  return map;
}

function serializeEnv(entries: Map<string, string>, descriptions?: Map<string, string>): string {
  const lines: string[] = [];
  for (const [k, v] of entries.entries()) {
    const desc = descriptions?.get(k);
    if (desc) {
      for (const dl of desc.split("\n")) {
        lines.push(`# ${dl}`);
      }
    }
    lines.push(`${k}=${v}`);
  }
  return lines.join("\n") + "\n";
}

/** 读取 skill 源 base 层（.env 优先，回退 .env.example），含 key 注释描述。 */
async function readBaseEnvWithDesc(): Promise<{ values: Map<string, string>; descriptions: Map<string, string> }> {
  const configPath = path.join(skillSourceDir, "config");
  for (const name of [".env", ".env.example"]) {
    try {
      const text = await fs.readFile(path.join(configPath, name), "utf8");
      return { values: parseEnvText(text), descriptions: parseEnvDescriptions(text) };
    } catch {
      // try next
    }
  }
  return { values: new Map(), descriptions: new Map() };
}

/** 读取用户覆盖层。 */
export async function readUserSkillEnv(): Promise<Map<string, string>> {
  try {
    return parseEnvText(await fs.readFile(userSkillEnvFile, "utf8"));
  } catch {
    return new Map();
  }
}

/** 局部更新用户覆盖层，供浏览器候选快捷切换使用，避免整体保存丢失其它配置。 */
export async function patchUserSkillEnv(
  updates: Array<{ key: string; value: string; description?: string }>
): Promise<SaveSkillEnvResult> {
  const previous = await readUserSkillEnv();
  const descriptions = await readUserSkillEnvDescriptions();
  for (const update of updates) {
    previous.set(update.key, update.value);
    if (update.description?.trim()) descriptions.set(update.key, update.description.trim());
  }
  return saveUserSkillEnv([...previous].map(([key, value]) => ({
    key,
    value,
    description: descriptions.get(key)
  })));
}

/** 用户覆盖层描述读取（保存在覆盖层文件注释中）。 */
async function readUserSkillEnvDescriptions(): Promise<Map<string, string>> {
  try {
    return parseEnvDescriptions(await fs.readFile(userSkillEnvFile, "utf8"));
  } catch {
    return new Map();
  }
}

/** 合并视图：base + 用户覆盖层（不含 process.env，保持 UI 所见即持久内容）。 */
export async function getSkillEnvView(revealSensitive: boolean): Promise<SkillEnvEntry[]> {
  const { values: base, descriptions: baseDesc } = await readBaseEnvWithDesc();
  const user = await readUserSkillEnv();
  const userDesc = await readUserSkillEnvDescriptions();
  const keys = new Set([...base.keys(), ...user.keys()]);
  const entries: SkillEnvEntry[] = [];
  for (const key of keys) {
    const fromUser = user.has(key);
    const value = fromUser ? user.get(key)! : base.get(key)!;
    const sensitive = isSensitiveKey(key);
    entries.push({
      key,
      value: sensitive && !revealSensitive ? "" : value,
      source: fromUser ? "user" : "base",
      sensitive,
      maskedValue: sensitive ? maskValue(value) : undefined,
      description: baseDesc.get(key) ?? userDesc.get(key)
    });
  }
  return entries.sort((a, b) => a.key.localeCompare(b.key));
}

const KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

export interface SaveSkillEnvResult {
  ok: boolean;
  error?: string;
  savedKeys?: number;
}

/**
 * 保存用户覆盖层（整体替换语义：UI 传入完整的用户覆盖 entries）。
 * value 为空字符串的 sensitive 项如果之前存在，保留旧值（UI 掩码占位未修改）。
 * 可选 description 会以注释形式写入覆盖层文件，供 UI 问号提示展示。
 */
export async function saveUserSkillEnv(
  entries: Array<{ key: string; value: string; description?: string }>
): Promise<SaveSkillEnvResult> {
  const previous = await readUserSkillEnv();
  const previousDesc = await readUserSkillEnvDescriptions();
  const next = new Map<string, string>();
  const nextDesc = new Map<string, string>();
  for (const { key, value, description } of entries) {
    if (!KEY_PATTERN.test(key)) {
      return { ok: false, error: `非法的变量名：${key}` };
    }
    if (value.includes("\n")) {
      return { ok: false, error: `变量 ${key} 的值不能包含换行` };
    }
    if (value === "" && isSensitiveKey(key) && previous.has(key)) {
      // 掩码占位未修改 → 保留旧值
      next.set(key, previous.get(key)!);
    } else {
      next.set(key, value);
    }
    const desc = (description ?? previousDesc.get(key) ?? "").trim();
    if (desc) {
      nextDesc.set(key, desc);
    }
  }
  const browserError = validateConfiguredBrowserProfile(next);
  if (browserError) return { ok: false, error: browserError };
  await fs.mkdir(path.dirname(userSkillEnvFile), { recursive: true });
  await fs.writeFile(userSkillEnvFile, serializeEnv(next, nextDesc), { encoding: "utf8", mode: 0o600 });
  await fs.chmod(userSkillEnvFile, 0o600);
  return { ok: true, savedKeys: next.size };
}
