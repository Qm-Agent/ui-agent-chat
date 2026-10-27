/**
 * browser-use 浏览器 profile 枚举与本机浏览器探测。
 *
 * browser-use（profiles.py）通过环境变量选择浏览器：
 * - `BU_BROWSER_TYPE`  — 单浏览器 key，如 `chrome`、`chrome:147`、`edge`、`360:13.3`
 * - `BU_CHROME_139_PATH` / `BU_CHROME_147_PATH` / `BU_EDGE_147_PATH` /
 *   `BU_360_BROWSER_PATH` / `BU_FIREFOX_PATH` — 覆盖对应 profile 的可执行文件路径
 *
 * 这些 env 通过 skillEnvStore 用户覆盖层持久化，并在 prepareWorkspace →
 * writeSkillEnv 时写入工作区 skill config/.env，quick 执行时被 browser-use 读取。
 */
import fs from "node:fs/promises";
import os from "node:os";
import type { BrowserKernel } from "./types.js";

export interface BrowserProfileInfo {
  /** browser-use 注册表 key（BU_BROWSER_TYPE 的值） */
  key: string;
  displayName: string;
  vendor: string;
  version?: string;
  /** 该 profile 可执行路径对应的 env key（default profile 无） */
  pathEnvKey?: string;
  /** browser-use 内置默认路径（Linux 容器路径，客户端本机通常需覆盖） */
  defaultPath?: string;
  /** 是否需要 executable_path 才能工作（default profile 用 Playwright 内置内核，不需要） */
  requiresPath: boolean;
}

/** 与 browser-use browser_use/browser/profiles.py 内置注册表保持一致。 */
export const BROWSER_PROFILES: BrowserProfileInfo[] = [
  {
    key: "firefox",
    displayName: "Firefox（Playwright 配套引擎）",
    vendor: "firefox",
    pathEnvKey: "BU_FIREFOX_PATH",
    requiresPath: false
  },
  {
    key: "chrome",
    displayName: "Chrome (Playwright 内置内核)",
    vendor: "chrome",
    requiresPath: false
  },
  {
    key: "chrome:139",
    displayName: "Chrome 139",
    vendor: "chrome",
    version: "139",
    pathEnvKey: "BU_CHROME_139_PATH",
    defaultPath: "/opt/chrome/chrome-139/chrome",
    requiresPath: true
  },
  {
    key: "chrome:147",
    displayName: "Chrome 147",
    vendor: "chrome",
    version: "147",
    pathEnvKey: "BU_CHROME_147_PATH",
    defaultPath: "/opt/chrome/chrome-147/chrome",
    requiresPath: true
  },
  {
    key: "edge",
    displayName: "Microsoft Edge (系统默认)",
    vendor: "edge",
    requiresPath: false
  },
  {
    key: "edge:147",
    displayName: "Edge 147",
    vendor: "edge",
    version: "147",
    pathEnvKey: "BU_EDGE_147_PATH",
    defaultPath: "/opt/edge/edge-147/msedge",
    requiresPath: true
  },
  {
    key: "360:13.3",
    displayName: "360 企业浏览器 13.3",
    vendor: "360",
    version: "13.3",
    pathEnvKey: "BU_360_BROWSER_PATH",
    defaultPath: "/opt/browser360ent/browser360ent-cn",
    requiresPath: true
  },
  {
    // 自定义 Chromium：sitecustomize 在 browser-use 3.1.6 启动前注册该 profile。
    // 与内置 profile 不同，没有固定 vendor/version，路径直接由 BU_CUSTOM_BROWSER_PATH 提供。
    key: "custom",
    displayName: "自定义 Chromium（指定本机路径）",
    vendor: "custom",
    pathEnvKey: "BU_CUSTOM_BROWSER_PATH",
    requiresPath: true
  }
];

/** 浏览器选择相关的 env key（skill 配置页「浏览器」区块读写这些 key）。 */
export const BROWSER_ENV_KEYS = {
  browserType: "BU_BROWSER_TYPE",
  cdpUrl: "BU_LOCAL_BROWSER_CDP_URL",
  customBrowserPath: "BU_CUSTOM_BROWSER_PATH",
  firefoxPath: "BU_FIREFOX_PATH",
  standaloneBrowserPath: "UIWARDEN_STANDALONE_BROWSER_PATH"
} as const;

export interface DetectedBrowser {
  vendor: string;
  name: string;
  path: string;
  kind: "chromium" | "firefox" | "standalone";
  profileCompatible: boolean;
  compatibilityNote?: string;
  recommendedKernel?: "gui-computer";
}

/** 各平台常见浏览器安装路径（探测用）。 */
function candidatePaths(): DetectedBrowser[] {
  const platform = os.platform();
  if (platform === "darwin") {
    return [
      {
        vendor: "chrome",
        name: "Google Chrome",
        path: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        kind: "chromium",
        profileCompatible: true
      },
      {
        vendor: "chrome",
        name: "Google Chrome Canary",
        path: "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
        kind: "chromium",
        profileCompatible: true
      },
      {
        vendor: "chrome",
        name: "Google Chrome Beta",
        path: "/Applications/Google Chrome Beta.app/Contents/MacOS/Google Chrome Beta",
        kind: "chromium",
        profileCompatible: true
      },
      {
        vendor: "edge",
        name: "Microsoft Edge",
        path: "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
        kind: "chromium",
        profileCompatible: true
      },
      {
        vendor: "chrome",
        name: "Chromium",
        path: "/Applications/Chromium.app/Contents/MacOS/Chromium",
        kind: "chromium",
        profileCompatible: true
      },
      {
        vendor: "brave",
        name: "Brave Browser",
        path: "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
        kind: "chromium",
        profileCompatible: true
      },
      {
        vendor: "chrome",
        name: "Google Chrome（用户安装）",
        path: `${os.homedir()}/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`,
        kind: "chromium",
        profileCompatible: true
      },
      {
        vendor: "chrome",
        name: "Google Chrome Beta（用户安装）",
        path: `${os.homedir()}/Applications/Google Chrome Beta.app/Contents/MacOS/Google Chrome Beta`,
        kind: "chromium",
        profileCompatible: true
      },
      {
        vendor: "edge",
        name: "Microsoft Edge（用户安装）",
        path: `${os.homedir()}/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge`,
        kind: "chromium",
        profileCompatible: true
      },
      {
        vendor: "firefox",
        name: "Firefox",
        path: "/Applications/Firefox.app/Contents/MacOS/firefox",
        kind: "firefox",
        profileCompatible: true,
        compatibilityNote: "可选为 browser-use Firefox Profile；本机路径用于检测，执行使用 Playwright 配套 Firefox"
      },
      {
        vendor: "uiwarden",
        name: "UIWarden-Browser",
        path: "/Applications/UIWarden-Browser.app/Contents/MacOS/UIWarden-Browser",
        kind: "standalone",
        profileCompatible: false,
        compatibilityNote: "可选为 UI 操作的本机独立浏览器，不作为 browser-use 自定义 Chromium 启动",
        recommendedKernel: "gui-computer"
      },
      {
        vendor: "dt-gui",
        name: "gui-computer",
        path: "/Applications/gui-computer.app/Contents/MacOS/gui-computer",
        kind: "standalone",
        profileCompatible: false,
        recommendedKernel: "gui-computer"
      }
    ];
  }
  if (platform === "win32") {
    const programFiles = process.env["ProgramFiles"] ?? "C:\\Program Files";
    const programFilesX86 = process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)";
    const localAppData = process.env["LOCALAPPDATA"] ?? "";
    return [
      { vendor: "chrome", name: "Google Chrome", path: `${programFiles}\\Google\\Chrome\\Application\\chrome.exe`, kind: "chromium", profileCompatible: true },
      { vendor: "chrome", name: "Google Chrome", path: `${programFilesX86}\\Google\\Chrome\\Application\\chrome.exe`, kind: "chromium", profileCompatible: true },
      { vendor: "chrome", name: "Google Chrome (用户安装)", path: `${localAppData}\\Google\\Chrome\\Application\\chrome.exe`, kind: "chromium", profileCompatible: true },
      { vendor: "edge", name: "Microsoft Edge", path: `${programFiles}\\Microsoft\\Edge\\Application\\msedge.exe`, kind: "chromium", profileCompatible: true },
      { vendor: "edge", name: "Microsoft Edge", path: `${programFilesX86}\\Microsoft\\Edge\\Application\\msedge.exe`, kind: "chromium", profileCompatible: true },
      { vendor: "360", name: "360 企业浏览器", path: `${programFilesX86}\\360\\360se6\\Application\\360se.exe`, kind: "chromium", profileCompatible: true },
      { vendor: "firefox", name: "Firefox", path: `${programFiles}\\Mozilla Firefox\\firefox.exe`, kind: "firefox", profileCompatible: true, compatibilityNote: "可选为 browser-use Firefox Profile" },
      { vendor: "uiwarden", name: "UIWarden-Browser", path: `${programFiles}\\UIWarden-Browser\\UIWarden-Browser.exe`, kind: "standalone", profileCompatible: false, recommendedKernel: "gui-computer" },
      { vendor: "dt-gui", name: "gui-computer", path: `${programFiles}\\gui-computer\\gui-computer.exe`, kind: "standalone", profileCompatible: false, recommendedKernel: "gui-computer" }
    ];
  }
  // Linux
  return [
    { vendor: "chrome", name: "Google Chrome", path: "/usr/bin/google-chrome", kind: "chromium", profileCompatible: true },
    { vendor: "chrome", name: "Google Chrome Stable", path: "/usr/bin/google-chrome-stable", kind: "chromium", profileCompatible: true },
    { vendor: "chrome", name: "Chromium", path: "/usr/bin/chromium-browser", kind: "chromium", profileCompatible: true },
    { vendor: "chrome", name: "Chromium", path: "/usr/bin/chromium", kind: "chromium", profileCompatible: true },
    { vendor: "edge", name: "Microsoft Edge", path: "/usr/bin/microsoft-edge", kind: "chromium", profileCompatible: true },
    { vendor: "firefox", name: "Firefox", path: "/usr/bin/firefox", kind: "firefox", profileCompatible: true, compatibilityNote: "可选为 browser-use Firefox Profile" }
  ];
}

/** 探测本机已安装浏览器（仅检查文件存在，不执行）。 */
export async function detectLocalBrowsers(): Promise<DetectedBrowser[]> {
  const found: DetectedBrowser[] = [];
  for (const candidate of candidatePaths()) {
    if (!candidate.path) continue;
    try {
      await fs.access(candidate.path);
      found.push(candidate);
    } catch {
      // 不存在，跳过
    }
  }
  return found;
}

/** 首选本机 Chrome/Edge 路径（CDP 托管启动用）：Chrome 优先，其次 Edge。 */
export async function preferredCdpBrowserPath(): Promise<string | undefined> {
  const browsers = await detectLocalBrowsers();
  return (
    browsers.find((b) => b.vendor === "chrome")?.path ??
    browsers.find((b) => b.vendor === "edge")?.path
  );
}

/**
 * 从 skill 用户配置层解析 CDP 托管浏览器可执行路径。
 *
 * 优先级：
 * 1. `BU_CUSTOM_BROWSER_PATH`（用户指定的 Chromium 浏览器）；
 * 2. 当前选中 profile（`BU_BROWSER_TYPE`）对应的 `BU_*_PATH`（如 chrome:147 → BU_CHROME_147_PATH）；
 * 3. 以上均未配置/路径不存在 → 返回 undefined，由调用方走 preferredCdpBrowserPath 自动探测。
 *
 * 注意：内置 default profile（chrome/edge，无 pathEnvKey）用 Playwright 内置内核，
 * 不需要本机可执行路径，此处返回 undefined，由调用方探测本机 Chrome/Edge。
 *
 * @param env skill 用户覆盖层 env 视图（key→value，value 可能为空串）
 */
export function resolveConfiguredCdpBrowserPath(env: Record<string, string> | undefined): string | undefined {
  if (!env) return undefined;
  const custom = env[BROWSER_ENV_KEYS.customBrowserPath]?.trim();
  if (custom && !/firefox|gui-computer|uiwarden-browser/i.test(custom)) return custom;
  const browserType = env[BROWSER_ENV_KEYS.browserType]?.trim();
  if (browserType) {
    const profile = BROWSER_PROFILES.find((p) => p.key === browserType);
    if (profile?.pathEnvKey) {
      const configuredPath = env[profile.pathEnvKey]?.trim();
      if (configuredPath && !/firefox|gui-computer|uiwarden-browser/i.test(configuredPath)) return configuredPath;
    }
  }
  return undefined;
}

/**
 * 新建普通会话时按 Skill Profile 解析执行内核。
 * 测试任务只返回 Playwright 或 Skill Profile。独立 gui-browser 属于 UI 操作
 * 原子能力，不通过测试任务的 browser-use 内核启动。
 */
export function resolveConfiguredSessionKernel(env: Record<string, string> | undefined): BrowserKernel {
  if (!env) return "playwright";
  if (validateConfiguredBrowserProfile(new Map(Object.entries(env)))) return "playwright";
  const browserType = env[BROWSER_ENV_KEYS.browserType]?.trim() || "chrome";
  if (browserType !== "custom") return browserType === "chrome" ? "playwright" : "skill-profile";
  return "skill-profile";
}

/** 校验 Skill Profile 的必填路径；具体 launcher 由 profile 决定。 */
export function validateConfiguredBrowserProfile(env: Map<string, string>): string | undefined {
  const browserType = (env.get(BROWSER_ENV_KEYS.browserType) || "chrome").trim();
  if (browserType === "firefox") return undefined;
  if (browserType !== "custom") return undefined;
  const executable = (env.get(BROWSER_ENV_KEYS.customBrowserPath) || "").trim();
  if (!executable) return "自定义 Chromium 需要填写可执行文件路径";
  if (/firefox/i.test(executable)) return "Firefox 路径必须通过 Firefox Profile 配置，不能作为自定义 Chromium 启动";
  if (/gui-computer|uiwarden-browser/i.test(executable)) return "独立 gui-browser 仅用于 UI 操作，测试任务不支持该执行内核";
  return undefined;
}
