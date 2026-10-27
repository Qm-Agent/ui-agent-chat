import fs from "node:fs/promises";
import path from "node:path";
import { browserSkillSourceDir, computerSkillSourceDir, skillSourceDir } from "./paths.js";
import { parseEnvText, userSkillEnvFile } from "./skillEnvStore.js";
import type { ExecutionRuntimeId, UploadedFileInfo } from "./types.js";

const UI_TEST_SKILL_TARGET = path.join(".claude", "skills", "ui-test-assistant-skill");
const COMPUTER_SKILL_TARGET = path.join(".claude", "skills", "dt-gui-computer-skill");
const BROWSER_SKILL_TARGET = path.join(".claude", "skills", "dt-gui-browser-skill");
const AGENT_SKILL_TARGETS = [
  [skillSourceDir, path.join(".agents", "skills", "ui-test-assistant-skill")],
  [computerSkillSourceDir, path.join(".agents", "skills", "dt-gui-computer-skill")],
  [browserSkillSourceDir, path.join(".agents", "skills", "dt-gui-browser-skill")]
] as const;

export interface WorkspacePreparationOptions {
  browserProfileMode?: "bundled" | "skill";
  executionRuntimeId?: ExecutionRuntimeId;
}

export function applyBrowserProfileMode(
  env: Map<string, string>,
  mode: WorkspacePreparationOptions["browserProfileMode"]
): void {
  if (mode !== "bundled") return;
  env.set("BU_BROWSER_TYPE", "chrome");
  env.delete("BU_BROWSER_TYPES");
  env.delete("BU_CUSTOM_BROWSER_PATH");
}

export async function prepareWorkspace(
  workspacePath: string,
  options: WorkspacePreparationOptions = {}
): Promise<void> {
  await fs.mkdir(workspacePath, { recursive: true });
  await fs.mkdir(path.join(workspacePath, "uploads"), { recursive: true });
  await fs.mkdir(path.join(workspacePath, ".skill-output"), { recursive: true });
  await copySkill(workspacePath, skillSourceDir, UI_TEST_SKILL_TARGET);
  await copySkill(workspacePath, computerSkillSourceDir, COMPUTER_SKILL_TARGET);
  await copySkill(workspacePath, browserSkillSourceDir, BROWSER_SKILL_TARGET);
  for (const [source, target] of AGENT_SKILL_TARGETS) {
    await copySkill(workspacePath, source, target);
  }
  await writeWorkspaceInstructions(workspacePath, options.executionRuntimeId);
  await writeSkillEnv(workspacePath, options);
}

export async function moveUploadedFiles(
  files: Express.Multer.File[],
  uploadRoot: string
): Promise<UploadedFileInfo[]> {
  await fs.mkdir(uploadRoot, { recursive: true });
  const result: UploadedFileInfo[] = [];
  for (const file of files) {
    const safeName = file.originalname.replace(/[^\w.\-\u4e00-\u9fa5]+/g, "_");
    const filename = `${Date.now()}-${safeName}`;
    const target = path.join(uploadRoot, filename);
    await fs.rename(file.path, target);
    result.push({
      id: filename,
      originalName: file.originalname,
      filename,
      path: target,
      size: file.size,
      mimeType: file.mimetype,
      createdAt: new Date().toISOString()
    });
  }
  return result;
}

async function copySkill(workspacePath: string, sourceDir: string, relativeTarget: string): Promise<void> {
  const target = path.join(workspacePath, relativeTarget);
  await fs.rm(target, { recursive: true, force: true });
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.cp(sourceDir, target, {
    recursive: true,
    filter: (source) => {
      const relative = path.relative(sourceDir, source);
      if (!relative) {
        return true;
      }
      const parts = relative.split(path.sep);
      return !parts.some((part) =>
        [
          "logs",
          ".skill-output",
          ".pytest_cache",
          "__pycache__",
          ".git",
          "node_modules"
        ].includes(part)
      ) && !relative.endsWith(".DS_Store");
    }
  });
}

async function writeWorkspaceInstructions(
  workspacePath: string,
  executionRuntimeId: ExecutionRuntimeId = "dtcoder"
): Promise<void> {
  const content = `# UI Agent Workspace

你在一个 UIWarden 测试或 UI 操作会话工作区内运行。

- 本工作区已内置三个边界清晰的 project skill：
  - 浏览器测试、回归和巡检：\`.claude/skills/ui-test-assistant-skill\`（Codex/DTCoder 兼容目录：\`.agents/skills/ui-test-assistant-skill\`）。
  - UI 操作中的浏览器页面原子操作：\`.claude/skills/dt-gui-browser-skill\`（兼容目录：\`.agents/skills/dt-gui-browser-skill\`）。
  - UI 操作中的电脑桌面原生应用操作：\`.claude/skills/dt-gui-computer-skill\`（兼容目录：\`.agents/skills/dt-gui-computer-skill\`）。
- 当前会话固定执行底座：\`${executionRuntimeId}\`。不要改用或探测其他 Agent CLI。
- 当用户提出 UI 测试、快速测试、冒烟、巡检、需求/用例文档执行等任务时，优先使用 \`ui-test-assistant-skill\`。
- 当 UI 操作的执行目标是浏览器且 UIWarden 已提供受控浏览器会话时，必须使用 \`dt-gui-browser-skill\`，并禁止调用 \`ui-test-assistant-skill\`、quick、browser-use 或 Playwright。意图理解和步骤规划由主 Agent 完成，Skill 只提供原子动作协议。
- 当执行目标是电脑桌面或原生应用时，必须使用 \`dt-gui-computer-skill\`，并禁止调用 \`ui-test-assistant-skill\`、browser-use 或 Playwright。意图理解和步骤规划由主 Agent 完成，Skill 只提供原子动作协议。
- 用户上传的文档位于 \`uploads/\`。
- 产物必须优先写入 \`.skill-output/ui-test-assistant-skill-output/<RUN_TS>/\`，并遵守 skill 自身输出目录约定。
- 执行 browser-use 或页面巡检时，必须将运行中页面截图写入 \`${process.env.UIWARDEN_OBSERVATION_DIR ?? ".skill-output/uiwarden-observation"}\` 或其子目录；每个 step 保存 \`frame_0001.png\` 这类递增截图，并维护同目录 \`manifest.ndjson\`。
- 不要扫描工作区外项目来猜测 URL、账号、密码或业务上下文。
- 如缺少被测 URL、账号、密码等必要信息，直接说明缺失项，不要编造。
`;
  await fs.writeFile(path.join(workspacePath, "CLAUDE.md"), content, "utf8");
  await fs.writeFile(path.join(workspacePath, "AGENTS.md"), content, "utf8");
}

const SKILL_ENV_PREFIXES = [
  "ANTHROPIC_",
  "OPENAI_",
  "BU_",
  "QUICK_",
  "TARGET_URL",
  "USERNAME",
  "PASSWORD",
  "UI_TEST_",
  "UIWARDEN_",
  "MIDSCENE_",
  "PLAYWRIGHT_",
  "PUPPETEER_"
];

async function writeSkillEnv(
  workspacePath: string,
  options: WorkspacePreparationOptions
): Promise<void> {
  const claudeEnvFile = path.join(
    workspacePath,
    ".claude",
    "skills",
    "ui-test-assistant-skill",
    "config",
    ".env"
  );
  const agentEnvFile = path.join(
    workspacePath,
    ".agents",
    "skills",
    "ui-test-assistant-skill",
    "config",
    ".env"
  );
  await Promise.all([
    fs.mkdir(path.dirname(claudeEnvFile), { recursive: true }),
    fs.mkdir(path.dirname(agentEnvFile), { recursive: true })
  ]);

  // Read existing .env as base (from copySkill), then overlay env vars.
  // The skill source ships config/.env.example (model defaults without credentials)
  // but not config/.env itself (gitignored). When the target
  // .env is absent, fall back to .env.example so browser-use actor/planner
  // model config is carried into the workspace instead of being lost.
  let base = "";
  try {
    base = await fs.readFile(claudeEnvFile, "utf8");
  } catch {
    try {
      base = await fs.readFile(
        path.join(path.dirname(claudeEnvFile), ".env.example"),
        "utf8"
      );
    } catch {
      // No .env and no .env.example — will create from env vars only
    }
  }

  // Parse existing key=value pairs
  const existing = new Map<string, string>();
  for (const line of base.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq > 0) {
      existing.set(trimmed.slice(0, eq), trimmed.slice(eq + 1));
    }
  }

  // Overlay matching env vars (env takes precedence)
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (SKILL_ENV_PREFIXES.some((prefix) => key === prefix || key.startsWith(prefix))) {
      existing.set(key, value);
    }
  }

  // Overlay user-edited skill env (highest precedence; see skillEnvStore.ts).
  // 用户在客户端『Skill 配置』页保存的覆盖层：base < process.env < user。
  // 读取失败（文件不存在/权限问题）时静默跳过，保持原合并行为不变。
  try {
    const userText = await fs.readFile(userSkillEnvFile, "utf8");
    for (const [key, value] of parseEnvText(userText)) {
      existing.set(key, value);
    }
  } catch {
    // No user overrides — keep base + process.env merge as-is
  }

  // 默认 Playwright 模式必须稳定使用配套 Chromium。只有 skill-profile
  // 会话保留用户设置的 BU_BROWSER_TYPE/BU_CUSTOM_BROWSER_PATH。
  applyBrowserProfileMode(existing, options.browserProfileMode);

  // Write back
  const lines = Array.from(existing.entries()).map(([k, v]) => `${k}=${v}`);
  const content = lines.join("\n") + "\n";
  await Promise.all([
    fs.writeFile(claudeEnvFile, content, { encoding: "utf8", mode: 0o600 }),
    fs.writeFile(agentEnvFile, content, { encoding: "utf8", mode: 0o600 })
  ]);
  await Promise.all([
    fs.chmod(claudeEnvFile, 0o600),
    fs.chmod(agentEnvFile, 0o600)
  ]);
}
