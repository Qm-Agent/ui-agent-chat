/**
 * 桌面客户端依赖环境检测。
 *
 * 客户端模式下 agent 执行链依赖用户本机环境（desktop/main.cjs 注释约定）：
 * - 可选执行底座（新库默认 dtcoder；cfuse / codex / Claude Code 兼容）
 * - 安装包内置 UI Test Runtime（Python、browser-use 与 Playwright Chromium/Firefox）
 * - 开发模式/旧安装包兼容用户 Python >= 3.10（UI_TEST_PYTHON 优先）
 * - browser-use==3.1.6（与 skill SKILL.md 固定版本一致）
 * - Playwright Chromium；选择 Firefox Profile 时还需要 Playwright Firefox
 *
 * 检测只读、无副作用；修复动作见 depsRepair.ts。
 */
import { execFile, execFileSync } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { configDir, projectRoot } from "./paths.js";
import { getSelectedExecutionRuntimeId } from "./modelStore.js";

const execFileAsync = promisify(execFile);

export type DepStatus = "ok" | "missing" | "broken";

export interface DepCheckResult {
  id: DepId;
  name: string;
  required: boolean;
  status: DepStatus;
  version?: string;
  detail: string;
  /** 是否支持服务端一键修复 */
  fixable: boolean;
  /** 不可自动修复时给用户的手动命令/指引 */
  manualCommand?: string;
}

export type DepId =
  | "cfuse-cli"
  | "codex-cli"
  | "dtcoder-cli"
  | "claude-cli"
  | "python"
  | "browser-use"
  | "playwright-chromium"
  | "playwright-firefox"
  | "chrome";

export const BROWSER_USE_VERSION = "3.1.6";
export const AIWORK_COMMANDS = ["aiwork", "aiworkcn", "aiworkcli"] as const;
const BROWSER_USE_WHEEL_PATTERN = new RegExp(
  `^browser_use-${BROWSER_USE_VERSION.replaceAll(".", "\\.")}-[^/]+\\.whl$`
);

export interface BundledUiTestRuntime {
  root: string;
  pythonPath: string;
  browsersPath: string;
  manifestPath: string;
  manifest: {
    schemaVersion: string;
    builderRevision: number;
    platform: string;
    arch: string;
    pythonVersion: string;
    browserUseVersion: string;
    playwrightVersion: string;
    browsers?: string[];
  };
}

/** Resolve a complete, platform-specific Runtime. Partial directories are rejected. */
export function resolveBundledUiTestRuntime(
  env: NodeJS.ProcessEnv = process.env,
  root: string = projectRoot,
  platform: NodeJS.Platform = process.platform
): BundledUiTestRuntime | undefined {
  const runtimeRoot = path.resolve(env.UIWARDEN_UI_TEST_RUNTIME?.trim() || path.join(root, "ui-test-runtime"));
  const manifestPath = path.join(runtimeRoot, "runtime-manifest.json");
  const pythonPath = platform === "win32"
    ? path.join(runtimeRoot, "python", "python.exe")
    : path.join(runtimeRoot, "python", "bin", "python3");
  const browsersPath = path.join(runtimeRoot, "ms-playwright");
  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as BundledUiTestRuntime["manifest"];
    if (
      manifest.schemaVersion !== "uiwarden-ui-test-runtime/v1"
      || manifest.builderRevision !== 5
      || manifest.platform !== platform
      || manifest.arch !== process.arch
      || manifest.browserUseVersion !== BROWSER_USE_VERSION
      || !fs.statSync(pythonPath).isFile()
      || !fs.statSync(browsersPath).isDirectory()
      || !fs.readdirSync(browsersPath).some((name) => name.startsWith("chromium-"))
      || !fs.readdirSync(browsersPath).some((name) => name.startsWith("firefox-"))
    ) return undefined;
    return { root: runtimeRoot, pythonPath, browsersPath, manifestPath, manifest };
  } catch {
    return undefined;
  }
}

export function resolveBrowserUseWheel(
  env: NodeJS.ProcessEnv = process.env,
  root: string = projectRoot
): string | undefined {
  const explicit = env.UIWARDEN_BROWSER_USE_WHEEL?.trim();
  if (explicit) {
    try {
      const stat = fs.statSync(explicit);
      return stat.isFile() && BROWSER_USE_WHEEL_PATTERN.test(path.basename(explicit))
        ? path.resolve(explicit)
        : undefined;
    } catch {
      return undefined;
    }
  }
  const directory = path.join(root, "vendor", "browser-use");
  try {
    const matches = fs.readdirSync(directory)
      .filter((name) => BROWSER_USE_WHEEL_PATTERN.test(name));
    return matches.length === 1 ? path.join(directory, matches[0]) : undefined;
  } catch {
    return undefined;
  }
}

/** 一键修复建出的默认 venv（与 SKILL.md 安装指引一致）。 */
export const DEFAULT_VENV_DIR = path.join(os.homedir(), ".venvs", "ui-test-assistant");

export function venvPythonPath(venvDir: string = DEFAULT_VENV_DIR): string {
  return process.platform === "win32"
    ? path.join(venvDir, "Scripts", "python.exe")
    : path.join(venvDir, "bin", "python");
}

/** 修复结果持久化文件（记录已选定的 Python 解释器等）。 */
const DEPS_STATE_FILE = path.join(configDir, "deps-state.json");

interface DepsState {
  pythonPath?: string;
}

export async function readDepsState(): Promise<DepsState> {
  try {
    return JSON.parse(await fsp.readFile(DEPS_STATE_FILE, "utf8")) as DepsState;
  } catch {
    return {};
  }
}

export async function writeDepsState(state: DepsState): Promise<void> {
  await fsp.mkdir(path.dirname(DEPS_STATE_FILE), { recursive: true });
  await fsp.writeFile(DEPS_STATE_FILE, JSON.stringify(state, null, 2), "utf8");
}

/** 服务启动时恢复持久化的 UI_TEST_PYTHON（若环境未显式指定）。 */
export async function restorePersistedPython(): Promise<void> {
  if (process.env.UI_TEST_PYTHON) return;
  const bundled = resolveBundledUiTestRuntime();
  if (bundled) {
    process.env.UI_TEST_PYTHON = bundled.pythonPath;
    process.env.PLAYWRIGHT_BROWSERS_PATH ||= bundled.browsersPath;
    return;
  }
  const state = await readDepsState();
  if (state.pythonPath && fs.existsSync(state.pythonPath)) {
    process.env.UI_TEST_PYTHON = state.pythonPath;
  }
}

// ---------------------------------------------------------------------------
// PATH 解析：GUI 启动的进程继承不到 shell PATH（与 desktop/main.cjs 同一问题）。
// server 可能由 Electron 直接 spawn，这里再兜底解析一次用户登录 shell 的 PATH。
// ---------------------------------------------------------------------------
let cachedUserPath: string | null = null;

/** 合并多个 PATH，保留顺序并去重，避免 GUI PATH 与登录 Shell PATH 相互覆盖。 */
export function mergeExecutablePaths(...values: Array<string | undefined>): string {
  const directories = values
    .flatMap((value) => String(value || "").split(path.delimiter))
    .map((directory) => directory.trim())
    .filter(Boolean);
  return [...new Set(directories)].join(path.delimiter);
}

export function resolveUserPath(): string {
  if (cachedUserPath !== null) return cachedUserPath;
  // JavaScript CLIs commonly use `#!/usr/bin/env node`. Keep the Node that
  // successfully started this server ahead of stale system installations.
  let userPath = mergeExecutablePaths(path.dirname(process.execPath), process.env.PATH);
  if (process.platform === "darwin" || process.platform === "linux") {
    try {
      const shellBin = process.env.SHELL || "/bin/zsh";
      const shellEnv = { ...process.env };
      delete shellEnv.npm_config_prefix;
      const marker = "__UIWARDEN_PATH__";
      const output = execFileSync(shellBin, ["-ilc", `printf '${marker}%s' "$PATH"`], {
        encoding: "utf8",
        env: shellEnv,
        timeout: 5000
      });
      const markerIndex = output.lastIndexOf(marker);
      const shellPath = markerIndex >= 0 ? output.slice(markerIndex + marker.length) : output;
      userPath = mergeExecutablePaths(userPath, shellPath);
    } catch {
      // 解析失败时保持 process.env.PATH
    }
  }
  const fallbackPaths = process.platform === "win32" ? [] : [
    path.join(os.homedir(), ".agentix", "bin"),
    path.join(os.homedir(), ".codefuse", "bin"),
    path.join(os.homedir(), ".local", "bin"),
    path.join(os.homedir(), "go", "bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin"
  ];
  cachedUserPath = mergeExecutablePaths(userPath, ...fallbackPaths);
  return cachedUserPath;
}

export function findExecutable(cmd: string): string | null {
  const dirs = resolveUserPath().split(path.delimiter).filter(Boolean);
  const exts = process.platform === "win32" ? [".exe", ".cmd", ".bat", ""] : [""];
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = path.join(dir, cmd + ext);
      try {
        fs.accessSync(candidate, fs.constants.X_OK);
        return candidate;
      } catch {
        // continue
      }
    }
  }
  return null;
}

export function dtcoderInstallCandidates(
  home: string = os.homedir(),
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env
): string[] {
  const executable = (command: string) => platform === "win32" ? `${command}.exe` : command;
  const commands = AIWORK_COMMANDS.map(executable);
  const candidates = commands.flatMap((command) => [
    path.join(home, ".agentix", "bin", command),
    path.join(home, ".local", "bin", command)
  ]);
  if (platform === "darwin") {
    candidates.push(
      path.join(home, "Library", "Application Support", "Agentix", "program", "internal", "current", "bin", executable("aiwork")),
      path.join(home, "Library", "Application Support", "Agentix", "program", "external", "current", "bin", executable("aiworkcn")),
      path.join(home, "Library", "Application Support", "Agentix", "program", "global", "current", "bin", executable("aiworkcli")),
      ...commands.map((command) => path.join(home, "Library", "Application Support", "Agentix", "program", "bin", command)),
      path.join(home, "Library", "Application Support", "AiWorkCN", "program", "bin", executable("aiworkcn"))
    );
  } else if (platform === "linux") {
    const dataHome = env.XDG_DATA_HOME || path.join(home, ".local", "share");
    candidates.push(
      path.join(dataHome, "agentix", "program", "internal", "current", "bin", executable("aiwork")),
      path.join(dataHome, "agentix", "program", "external", "current", "bin", executable("aiworkcn")),
      path.join(dataHome, "agentix", "program", "global", "current", "bin", executable("aiworkcli")),
      ...commands.map((command) => path.join(dataHome, "agentix", "program", "bin", command))
    );
  } else if (platform === "win32" && env.LOCALAPPDATA) {
    candidates.push(
      path.join(env.LOCALAPPDATA, "Agentix", "program", "internal", "current", "bin", executable("aiwork")),
      path.join(env.LOCALAPPDATA, "Agentix", "program", "external", "current", "bin", executable("aiworkcn")),
      path.join(env.LOCALAPPDATA, "Agentix", "program", "global", "current", "bin", executable("aiworkcli")),
      ...commands.map((command) => path.join(env.LOCALAPPDATA!, "Agentix", "program", "bin", command))
    );
  }
  return [...new Set(candidates)];
}

export function aiworkDistributionForExecutable(executable: string): "internal" | "external" | "global" | undefined {
  let resolved = executable;
  try {
    resolved = fs.realpathSync(executable);
  } catch {
    // PATH command names and test doubles may not have a resolvable real path.
  }
  for (const candidate of [executable, resolved]) {
    const name = (candidate.split(/[\\/]/).at(-1) || candidate).replace(/\.exe$/i, "").toLowerCase();
    if (name === "aiwork") return "internal";
    if (name === "aiworkcn") return "external";
    if (name === "aiworkcli") return "global";
  }
  return undefined;
}

export function resolveDtcoderExecutable(options: {
  env?: NodeJS.ProcessEnv;
  home?: string;
  platform?: NodeJS.Platform;
  pathLookup?: (command: string) => string | null;
} = {}): string | null {
  const env = options.env ?? process.env;
  const explicit = env.UI_AGENT_AIWORK_BIN?.trim() || env.UI_AGENT_DTCODER_BIN?.trim();
  if (explicit) {
    if (!path.isAbsolute(explicit)) return null;
    try {
      fs.accessSync(explicit, fs.constants.X_OK);
      return explicit;
    } catch {
      return null;
    }
  }
  const pathLookup = options.pathLookup ?? findExecutable;
  for (const command of [...AIWORK_COMMANDS, "dtcoder"] as const) {
    const fromPath = pathLookup(command);
    if (fromPath) return fromPath;
  }
  return dtcoderInstallCandidates(options.home, options.platform, env).find((candidate) => {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  }) || null;
}

async function runVersion(
  file: string,
  args: string[],
  timeoutMs = 10000
): Promise<{ ok: boolean; output: string }> {
  try {
    const { stdout, stderr } = await execFileAsync(file, args, {
      timeout: timeoutMs,
      env: { ...process.env, PATH: resolveUserPath() }
    });
    return { ok: true, output: stripControlSequences(stdout || stderr).trim() };
  } catch (error) {
    return { ok: false, output: String((error as Error).message ?? error) };
  }
}

function stripControlSequences(value: string): string {
  return value
    .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, "")
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\u001b[()][A-Za-z0-9]/g, "")
    .replace(/\u001b[78]/g, "");
}

// ---------------------------------------------------------------------------
// Python 解释器解析：UI_TEST_PYTHON > 持久化 state > 默认 venv > PATH python3
// ---------------------------------------------------------------------------
export async function resolvePythonCandidate(): Promise<string | null> {
  const explicit = process.env.UI_TEST_PYTHON;
  if (explicit && fs.existsSync(explicit)) return explicit;
  const bundled = resolveBundledUiTestRuntime();
  if (bundled) return bundled.pythonPath;
  const state = await readDepsState();
  if (state.pythonPath && fs.existsSync(state.pythonPath)) return state.pythonPath;
  const venvPy = venvPythonPath();
  if (fs.existsSync(venvPy)) return venvPy;
  return findExecutable("python3") ?? findExecutable("python");
}

function parsePythonVersion(output: string): [number, number] | null {
  const match = /Python\s+(\d+)\.(\d+)/.exec(output);
  if (!match) return null;
  return [Number(match[1]), Number(match[2])];
}

// ---------------------------------------------------------------------------
// 各依赖项检测
// ---------------------------------------------------------------------------
async function checkAgentCli(
  id: Extract<DepId, "cfuse-cli" | "codex-cli" | "dtcoder-cli" | "claude-cli">,
  selectedRuntimeId: string
): Promise<DepCheckResult> {
  const definitions = {
    "cfuse-cli": { command: "cfuse", name: "CFuse CLI", runtimeId: "cfuse", fixable: false, manualCommand: "请按团队 CFuse 发布渠道安装 cfuse CLI" },
    "codex-cli": { command: "codex", name: "Codex CLI", runtimeId: "codex", fixable: true, manualCommand: "npm install -g @openai/codex" },
    "dtcoder-cli": { command: "aiwork", name: "AiWork CLI", runtimeId: "dtcoder", fixable: false, manualCommand: undefined },
    "claude-cli": { command: "claude", name: "Claude Code（兼容）", runtimeId: "claude-code", fixable: true, manualCommand: "npm install -g @anthropic-ai/claude-code" }
  } as const;
  const definition = definitions[id];
  const base: Omit<DepCheckResult, "status" | "detail"> = {
    id,
    name: definition.name,
    required: selectedRuntimeId === definition.runtimeId,
    fixable: definition.fixable,
    manualCommand: definition.manualCommand
  };
  const bin = id === "dtcoder-cli"
    ? resolveDtcoderExecutable()
    : findExecutable(definition.command);
  if (!bin) {
    const aiworkAppInstalled = id === "dtcoder-cli" && process.platform === "darwin" && [
      "/Applications/AiWorkCN.app",
      "/Applications/AiWork.app",
      path.join(os.homedir(), "Applications/AiWorkCN.app"),
      path.join(os.homedir(), "Applications/AiWork.app")
    ].some((appPath) => fs.existsSync(appPath));
    return { ...base, status: "missing", detail: id === "dtcoder-cli"
      ? aiworkAppInstalled
        ? "已安装 AiWork 图形客户端，但未找到可执行的 aiwork、aiworkcn 或 aiworkcli 入口；请更新客户端、单独安装 CLI 或设置 UI_AGENT_AIWORK_BIN"
        : "未找到 AiWork CLI；外部用户可安装 aiworkcn，内部环境也支持 aiwork，海外环境支持 aiworkcli"
      : `PATH 中未找到 ${definition.command} 命令` };
  }
  const res = await runVersion(bin, ["--version"]);
  if (!res.ok) {
    return { ...base, status: "broken", detail: `${definition.command} --version 执行失败：${res.output}` };
  }
  const version = id === "cfuse-cli"
    ? formatCfuseDependencyVersion(res.output)
    : res.output;
  const distribution = id === "dtcoder-cli" ? aiworkDistributionForExecutable(bin) : undefined;
  const distributionLabel = distribution === "internal" ? "内部版"
    : distribution === "external" ? "外部版"
      : distribution === "global" ? "海外版"
        : undefined;
  return { ...base, status: "ok", version, detail: distributionLabel ? `${distributionLabel} · ${bin}` : bin };
}

function formatCfuseDependencyVersion(output: string): string {
  const engine = output.replace(/\s*\(Claude Code\)\s*/i, "").trim();
  const launcher = process.env.CFUSE_LAUNCHER_VERSION?.trim();
  if (launcher && engine === launcher) return `CFuse ${launcher}`;
  return launcher
    ? `CFuse ${launcher} · 兼容引擎 ${engine}`
    : `CFuse · 兼容引擎 ${engine}`;
}

async function checkPython(): Promise<DepCheckResult> {
  const base: Omit<DepCheckResult, "status" | "detail"> = {
    id: "python",
    name: "Python (>= 3.10)",
    required: true,
    fixable: true,
    manualCommand: "brew install python@3.12  # 或从 python.org 安装 3.10+"
  };
  const py = await resolvePythonCandidate();
  if (!py) {
    return { ...base, status: "missing", detail: "未找到 python3，请先安装 Python 3.10+" };
  }
  const res = await runVersion(py, ["--version"]);
  if (!res.ok) {
    return { ...base, status: "broken", detail: `${py} 无法执行：${res.output}` };
  }
  const version = parsePythonVersion(res.output);
  if (!version) {
    return { ...base, status: "broken", detail: `无法解析版本输出：${res.output}` };
  }
  if (version[0] < 3 || (version[0] === 3 && version[1] < 10)) {
    return {
      ...base,
      status: "broken",
      version: res.output,
      detail: `${py} 版本过低（需要 >= 3.10）`
    };
  }
  return { ...base, status: "ok", version: res.output, detail: py };
}

async function checkBrowserUse(): Promise<DepCheckResult> {
  const wheel = resolveBrowserUseWheel();
  const base: Omit<DepCheckResult, "status" | "detail"> = {
    id: "browser-use",
    name: `browser-use (${BROWSER_USE_VERSION})`,
    required: true,
    fixable: true,
    manualCommand: wheel
      ? `"$UI_TEST_PYTHON" -m pip install ${JSON.stringify(wheel)}`
      : "安装包缺少 browser-use SDK wheel，请重新安装完整的 UIWarden 客户端"
  };
  const py = await resolvePythonCandidate();
  if (!py) {
    return { ...base, status: "missing", detail: "缺少 Python 解释器，无法检测 browser-use" };
  }
  const res = await runVersion(py, [
    "-c",
    "from importlib.metadata import version; print(version('browser-use'))"
  ]);
  if (!res.ok) {
    return { ...base, status: "missing", detail: `browser-use 未安装（解释器：${py}）` };
  }
  const installed = res.output.trim();
  if (installed !== BROWSER_USE_VERSION) {
    return {
      ...base,
      status: "broken",
      version: installed,
      detail: `已安装 ${installed}，skill 要求 ${BROWSER_USE_VERSION}`
    };
  }
  return { ...base, status: "ok", version: installed, detail: `解释器：${py}` };
}

/** Playwright 浏览器缓存目录（playwright install 的落盘位置）。 */
export function playwrightBrowsersDir(): string {
  if (process.env.PLAYWRIGHT_BROWSERS_PATH) return process.env.PLAYWRIGHT_BROWSERS_PATH;
  const bundled = resolveBundledUiTestRuntime();
  if (bundled) return bundled.browsersPath;
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Caches", "ms-playwright");
  }
  if (process.platform === "win32") {
    return path.join(
      process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local"),
      "ms-playwright"
    );
  }
  return path.join(os.homedir(), ".cache", "ms-playwright");
}

async function checkPlaywrightChromium(): Promise<DepCheckResult> {
  const base: Omit<DepCheckResult, "status" | "detail"> = {
    id: "playwright-chromium",
    name: "Playwright Chromium",
    required: true,
    fixable: true,
    manualCommand: '"$UI_TEST_PYTHON" -m playwright install chromium'
  };
  const dir = playwrightBrowsersDir();
  try {
    const entries = await fsp.readdir(dir);
    const chromium = entries.filter((e) => e.startsWith("chromium"));
    if (chromium.length > 0) {
      return {
        ...base,
        status: "ok",
        version: chromium.sort().at(-1),
        detail: path.join(dir, chromium.sort().at(-1) ?? "")
      };
    }
  } catch {
    // 目录不存在 → 未安装
  }
  return { ...base, status: "missing", detail: `未在 ${dir} 找到 chromium，需执行 playwright install` };
}

async function checkPlaywrightFirefox(): Promise<DepCheckResult> {
  const selected = await configuredBrowserType() === "firefox";
  const base: Omit<DepCheckResult, "status" | "detail"> = {
    id: "playwright-firefox",
    name: "Playwright Firefox",
    required: selected,
    fixable: true,
    manualCommand: '"$UI_TEST_PYTHON" -m playwright install firefox'
  };
  const dir = playwrightBrowsersDir();
  try {
    const entries = await fsp.readdir(dir);
    const firefox = entries.filter((entry) => entry.startsWith("firefox"));
    if (firefox.length > 0) {
      return {
        ...base,
        status: "ok",
        version: firefox.sort().at(-1),
        detail: path.join(dir, firefox.sort().at(-1) ?? "")
      };
    }
  } catch {
    // 目录不存在 → 未安装
  }
  return {
    ...base,
    status: "missing",
    detail: selected
      ? `当前已选择 Firefox Profile，但 ${dir} 中缺少 Playwright Firefox`
      : "未启用 Firefox Profile，可按需安装"
  };
}

async function configuredBrowserType(): Promise<string> {
  try {
    const text = await fsp.readFile(path.join(configDir, "skill.env"), "utf8");
    for (const line of text.split(/\r?\n/).reverse()) {
      const match = line.trim().match(/^BU_BROWSER_TYPE=(.*)$/);
      if (match) return match[1].trim();
    }
  } catch {
    // 用户覆盖层不存在时使用默认 Chromium。
  }
  return "chrome";
}

/** 本机 Chrome：可选增强（CDP/本机登录态）。缺失时可用 Playwright Chromium 兜底。 */
async function checkChrome(): Promise<DepCheckResult> {
  const base: Omit<DepCheckResult, "status" | "detail"> = {
    id: "chrome",
    name: "本机 Chrome 浏览器",
    required: false,
    fixable: false,
    manualCommand: "https://www.google.com/chrome/ 下载安装"
  };
  const candidates: string[] = [];
  if (process.platform === "darwin") {
    candidates.push(
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Chromium.app/Contents/MacOS/Chromium"
    );
  } else if (process.platform === "win32") {
    for (const root of [process.env["PROGRAMFILES"], process.env["PROGRAMFILES(X86)"], process.env.LOCALAPPDATA]) {
      if (root) candidates.push(path.join(root, "Google", "Chrome", "Application", "chrome.exe"));
    }
  } else {
    for (const cmd of ["google-chrome", "google-chrome-stable", "chromium-browser", "chromium"]) {
      const found = findExecutable(cmd);
      if (found) candidates.push(found);
    }
  }
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return { ...base, status: "ok", detail: candidate };
    }
  }
  return { ...base, status: "missing", detail: "未检测到本机 Chrome；agent 将使用 Playwright Chromium" };
}

export async function checkAllDependencies(): Promise<DepCheckResult[]> {
  const selectedRuntimeId = await getSelectedExecutionRuntimeId();
  return Promise.all([
    checkAgentCli("cfuse-cli", selectedRuntimeId),
    checkAgentCli("codex-cli", selectedRuntimeId),
    checkAgentCli("dtcoder-cli", selectedRuntimeId),
    checkAgentCli("claude-cli", selectedRuntimeId),
    checkPython(),
    checkBrowserUse(),
    checkPlaywrightChromium(),
    checkPlaywrightFirefox(),
    checkChrome()
  ]);
}
