/**
 * 本地 CDP 浏览器生命周期管理（桌面客户端特性）。
 *
 * 职责：
 * - 托管启动本机 Chrome/Edge：`--remote-debugging-port=<port>` + 专用持久
 *   profile（dataDir/cdp-profile，与用户日常浏览器 profile 隔离，Chrome 不允许
 *   同一 user-data-dir 双开）。首次登录后登录态长期保留，供 quick --cdp 复用。
 * - attach 已有 CDP 浏览器：端口已被监听时不重复启动，直接附加。
 * - 健康检查：GET /json/version；tab 枚举：GET /json/list；
 *   tab 激活：GET /json/activate/<targetId>（quick --cdp 操作的是活动标签页，
 *   UI 选中某 tab 时先激活它再执行任务）。
 * - 优雅关闭：先 CDP Browser.close 语义（HTTP 无该端点，用进程信号），托管进程
 *   SIGTERM → 超时 SIGKILL；attach 模式只断开不杀进程。
 *
 * 该模块无持久化状态；服务重启后通过端口探测恢复 attach。
 */
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { dataDir, projectRoot } from "./paths.js";
import { detectLocalBrowsers, preferredCdpBrowserPath } from "./browserProfiles.js";
import {
  activateBrowserExtensionTab,
  browserExtensionCdpUrl,
  createBrowserExtensionTab,
  createBrowserExtensionTaskGroup,
  getBrowserExtensionBridgeStatus,
  listBrowserExtensionTabs
} from "./browserExtensionBridge.js";

export const DEFAULT_CDP_PORT = 9222;
export const TASK_GROUP_EXTENSION_ID = "ohpncegdnhjblgbapfaepnabaaaffkad";
const execFileAsync = promisify(execFile);

/** CDP 专用持久 profile 目录：与用户日常浏览器 profile 隔离，登录态长期保留。 */
export const cdpProfileDir = path.join(dataDir, "cdp-profile");

export interface CdpTab {
  id: string;
  title: string;
  url: string;
  type: string;
  active?: boolean;
}

export interface CdpStatus {
  running: boolean;
  /** managed=本服务托管启动；external=附加已有 CDP；extension=扩展接管用户现有标签页 */
  mode?: "managed" | "external" | "extension";
  port: number;
  cdpUrl: string;
  browserVersion?: string;
  browserPath?: string;
  browserName?: string;
  selectedBrowserId?: string;
  tabs?: CdpTab[];
  error?: string;
  /** UI 选中的目标标签页 id（空=当前活动标签页）；每轮 agent run 前重新激活，保证多轮在选中 tab 执行 */
  selectedTabId?: string;
}

export interface CdpBrowserOption {
  id: string;
  name: string;
  vendor: string;
  source: "installed" | "running-cdp" | "extension-bridge" | "firefox-profile" | "embedded-kernel";
  action: "launch-cdp" | "connect-cdp" | "connect-extension" | "use-firefox-profile" | "use-embedded-kernel";
  path?: string;
  running: boolean;
  connectable: boolean;
  cdpUrl?: string;
  port?: number;
  browserVersion?: string;
  tabsCount?: number;
  note: string;
}

export interface CdpBrowserDiscovery {
  browsers: CdpBrowserOption[];
  defaultBrowserId?: string;
  limitation: string;
}

let managedProcess: ChildProcess | null = null;
let managedBrowserPath: string | undefined;
let currentBrowserPath: string | undefined;
let currentBrowserName: string | undefined;
let currentBrowserId: string | undefined;
let currentPort = DEFAULT_CDP_PORT;
let connectionEnabled = true;
let taskGroupExtensionLoaded = false;
let currentTransport: "cdp" | "extension" = "cdp";
// UI 选中的目标标签页 id（空串/undefined=当前活动标签页）。activateCdpTab 时记录，
// clearSelectedTab 清除；runAgentTurn 前读它重新激活，保证多轮切换 tab 实际生效。
let selectedTargetId: string | undefined;

export interface CdpTaskGroupCapability {
  available: boolean;
  extensionId: string;
  setupRequired: boolean;
  installationMode: "installed" | "manual" | "unavailable";
  autoLoadSupported: boolean;
  reason?: string;
}

export interface CdpTaskGroupSetup {
  opened: boolean;
  extensionId: string;
  instruction: string;
}

export interface CdpTaskGroup {
  version: 1;
  groupId: number;
  chromeTabId: number;
  targetId: string;
  markerUrl: string;
  title: string;
}

interface CdpClientLike {
  send<T = Record<string, unknown>>(
    method: string,
    params?: Record<string, unknown>,
    timeoutMs?: number,
    sessionId?: string
  ): Promise<T>;
  close(): void;
}

interface CdpRuntimeModule {
  CdpClient: {
    connect(url: string): Promise<CdpClientLike>;
  };
}

interface ExtensionCommandResult {
  version: number;
  chromeTabId?: number;
  groupId?: number;
  markerUrl?: string;
  tabs?: boolean;
  tabGroups?: boolean;
}

function cdpHttpBase(port: number): string {
  return `http://127.0.0.1:${port}`;
}

function localServerBaseUrl(): string {
  const port = Number(process.env.PORT || (process.env.UI_AGENT_DESKTOP === "true" ? 8797 : 8787));
  return `http://127.0.0.1:${Number.isInteger(port) && port > 0 ? port : 8797}`;
}

export function cdpUrl(port = currentPort): string {
  if (currentTransport === "extension") return browserExtensionCdpUrl(localServerBaseUrl());
  return cdpHttpBase(port);
}

async function fetchJson<T>(url: string, timeoutMs = 3000, init?: RequestInit): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    return (await res.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

/** 端口上是否有存活的 CDP 浏览器。 */
export async function probeCdp(port = currentPort): Promise<{ alive: boolean; version?: string }> {
  try {
    const info = await fetchJson<{ Browser?: string }>(`${cdpHttpBase(port)}/json/version`);
    return { alive: true, version: info.Browser };
  } catch {
    return { alive: false };
  }
}

/** 从浏览器进程命令行提取本机 TCP 远程调试端口。pipe 模式不能跨进程附加。 */
export function parseRemoteDebuggingPorts(command: string): number[] {
  const ports = new Set<number>();
  const pattern = /--remote-debugging-port(?:=|\s+)(\d{2,5})(?=\s|$)/g;
  for (const match of command.matchAll(pattern)) {
    const port = Number(match[1]);
    if (port > 0 && port <= 65535) ports.add(port);
  }
  return [...ports];
}

function optionId(source: CdpBrowserOption["source"], value: string): string {
  const digest = createHash("sha256").update(value).digest("hex").slice(0, 12);
  return `${source}-${digest}`;
}

async function processCommands(): Promise<string[]> {
  try {
    if (os.platform() === "win32") {
      const { stdout } = await execFileAsync("powershell.exe", [
        "-NoProfile",
        "-Command",
        "Get-CimInstance Win32_Process | Select-Object ProcessId,ExecutablePath,CommandLine | ConvertTo-Json -Compress"
      ], { timeout: 5000, maxBuffer: 4 * 1024 * 1024 });
      const parsed = JSON.parse(stdout || "[]") as unknown;
      const rows = Array.isArray(parsed) ? parsed : parsed ? [parsed] : [];
      return rows.flatMap((row) => {
        if (!row || typeof row !== "object") return [];
        const value = row as { ExecutablePath?: unknown; CommandLine?: unknown };
        const command = String(value.CommandLine || value.ExecutablePath || "").trim();
        return command ? [command] : [];
      });
    }
    const { stdout } = await execFileAsync("ps", ["-axo", "command="], {
      timeout: 5000,
      maxBuffer: 4 * 1024 * 1024
    });
    return stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

function processMatchesBrowser(command: string, executablePath: string): boolean {
  const normalized = command.toLowerCase();
  const executable = executablePath.toLowerCase();
  if (normalized.includes(executable)) return true;
  const basename = path.basename(executablePath).toLowerCase();
  return basename.length > 4 && normalized.includes(basename);
}

/**
 * 枚举 CDP 可选浏览器。普通运行中的浏览器只能被识别，只有带 TCP
 * remote-debugging-port 且端点健康的实例才能继承其现有标签页。
 */
export async function discoverCdpBrowsers(): Promise<CdpBrowserDiscovery> {
  const detected = await detectLocalBrowsers();
  const installed = detected.filter((browser) => browser.kind === "chromium");
  const commands = await processCommands();
  const options: CdpBrowserOption[] = [];
  const claimedPorts = new Set<number>();
  const extensionStatus = await getBrowserExtensionBridgeStatus();
  options.push({
    id: "extension-bridge-user-chrome",
    name: extensionStatus.connected ? "用户 Chromium（扩展桥）" : "用户 Chromium 扩展桥",
    vendor: "chromium",
    source: "extension-bridge",
    action: "connect-extension",
    running: extensionStatus.connected,
    connectable: extensionStatus.connected,
    cdpUrl: extensionStatus.connected ? browserExtensionCdpUrl(localServerBaseUrl()) : undefined,
    tabsCount: extensionStatus.tabs.length,
    browserVersion: extensionStatus.version,
    note: extensionStatus.connected
      ? `可接管当前 Profile 中 ${extensionStatus.tabs.length} 个已开启页面，并保留登录态`
      : extensionStatus.reason || "安装并配对 UIWarden Browser Bridge 后可接管用户现有页面"
  });

  for (const browser of installed) {
    const matchingCommands = commands.filter((command) => processMatchesBrowser(command, browser.path));
    const candidatePorts = [...new Set(matchingCommands.flatMap(parseRemoteDebuggingPorts))];
    for (const port of candidatePorts) {
      const probe = await probeCdp(port);
      if (!probe.alive) continue;
      claimedPorts.add(port);
      const isManagedCurrent = managedProcess?.exitCode === null
        && currentPort === port
        && currentBrowserPath === browser.path;
      if (isManagedCurrent) continue;
      let tabsCount: number | undefined;
      try { tabsCount = (await listCdpTabs(port)).length; } catch { /* 状态仍可连接 */ }
      options.push({
        id: optionId("running-cdp", `${browser.path}:${port}`),
        name: `${browser.name}（已开启）`,
        vendor: browser.vendor,
        source: "running-cdp",
        action: "connect-cdp",
        path: browser.path,
        running: true,
        connectable: true,
        cdpUrl: cdpHttpBase(port),
        port,
        browserVersion: probe.version,
        tabsCount,
        note: `可直接连接并继承 ${tabsCount ?? 0} 个已开启页面`
      });
    }
    const running = matchingCommands.length > 0;
    options.push({
      id: optionId("installed", browser.path),
      name: browser.name,
      vendor: browser.vendor,
      source: "installed",
      action: "launch-cdp",
      path: browser.path,
      running,
      connectable: false,
      note: running && candidatePorts.length === 0
        ? "已检测到浏览器正在运行，但该实例未开放 CDP 控制通道；可启动同一浏览器的 UIWarden 可控实例，普通窗口和登录态不会被接管"
        : "启动 UIWarden 独立持久 Profile"
    });
  }

  for (const browser of detected.filter((candidate) => candidate.kind === "firefox")) {
    options.push({
      id: optionId("firefox-profile", browser.path),
      name: browser.name,
      vendor: browser.vendor,
      source: "firefox-profile",
      action: "use-firefox-profile",
      path: browser.path,
      running: commands.some((command) => processMatchesBrowser(command, browser.path)),
      connectable: false,
      note: "Firefox 不支持 Chromium CDP；选择后将保存本机路径并切换到 Firefox Skill Profile"
    });
  }

  for (const browser of detected.filter((candidate) => candidate.kind === "standalone" && candidate.vendor === "uiwarden")) {
    options.push({
      id: optionId("embedded-kernel", browser.path),
      name: browser.name,
      vendor: browser.vendor,
      source: "embedded-kernel",
      action: "use-embedded-kernel",
      path: browser.path,
      running: commands.some((command) => processMatchesBrowser(command, browser.path)),
      connectable: false,
      note: "UIWarden-Browser 使用专用控制桥；选择后切换到客户端内置 gui-browser，避免误操作浏览器壳页面"
    });
  }

  // 兼容由脚本或非标准安装路径启动的默认 CDP 端点。
  if (!claimedPorts.has(DEFAULT_CDP_PORT)) {
    const probe = await probeCdp(DEFAULT_CDP_PORT);
    if (probe.alive) {
      let tabsCount: number | undefined;
      try { tabsCount = (await listCdpTabs(DEFAULT_CDP_PORT)).length; } catch { /* 状态仍可连接 */ }
      options.unshift({
        id: optionId("running-cdp", cdpHttpBase(DEFAULT_CDP_PORT)),
        name: "已开启的 Chromium CDP 浏览器",
        vendor: "chromium",
        source: "running-cdp",
        action: "connect-cdp",
        running: true,
        connectable: true,
        cdpUrl: cdpHttpBase(DEFAULT_CDP_PORT),
        port: DEFAULT_CDP_PORT,
        browserVersion: probe.version,
        tabsCount,
        note: `可直接连接并继承 ${tabsCount ?? 0} 个已开启页面`
      });
    }
  }

  const defaultOption = options.find((item) => item.source === "extension-bridge" && item.connectable)
    ?? options.find((item) => item.vendor === "chrome" && item.source === "running-cdp")
    ?? options.find((item) => item.vendor === "chrome" && item.source === "installed")
    ?? options.find((item) => item.source === "running-cdp")
    ?? options[0];
  return {
    browsers: options,
    defaultBrowserId: defaultOption?.id,
    limitation: "UIWarden Browser Bridge 可接管普通 Chromium 当前 Profile 中的现有 HTTP(S) 页面；未配对扩展时仍可连接已开放 CDP 的实例，或启动 UIWarden 专用持久 Profile。"
  };
}

export async function resolveCdpBrowserOption(browserId: string): Promise<CdpBrowserOption | undefined> {
  return (await discoverCdpBrowsers()).browsers.find((browser) => browser.id === browserId);
}

/** 枚举页面型 tab（过滤 devtools/extension/service worker target）。 */
export async function listCdpTabs(port = currentPort): Promise<CdpTab[]> {
  if (currentTransport === "extension") {
    return (await listBrowserExtensionTabs()).map((tab) => ({
      id: tab.id,
      title: tab.title,
      url: tab.url,
      type: "page",
      active: tab.active
    }));
  }
  const targets = await fetchJson<Array<{ id: string; title: string; url: string; type: string }>>(
    `${cdpHttpBase(port)}/json/list`
  );
  return targets
    .filter((t) => t.type === "page" && !t.url.startsWith("devtools://"))
    .map((t) => ({ id: t.id, title: t.title, url: t.url, type: t.type }));
}

/**
 * 新建一个空白标签页（可选打开指定 URL）。
 * Chrome CDP HTTP 端点 `GET /json/new?<url>` 会新建标签页并返回其 target 信息。
 * 返回新 tab 的 id，便于 UI 高亮「当前受控标签页」。
 */
export async function newCdpTab(url: string | undefined, port = currentPort): Promise<CdpTab> {
  if (currentTransport === "extension") {
    const tab = await createBrowserExtensionTab(url);
    selectedTargetId = tab.id;
    return { id: tab.id, title: tab.title, url: tab.url, type: "page", active: tab.active };
  }
  // /json/new 需要 URL 参数；不传或空时用 about:blank 打开空白页。
  const openUrl = url && url.trim() ? url.trim() : "about:blank";
  const u = `${cdpHttpBase(port)}/json/new?${encodeURIComponent(openUrl)}`;
  const info = await fetchJson<{ id: string; title: string; url: string; type: string }>(
    u,
    5000,
    { method: "PUT" }
  );
  return { id: info.id, title: info.title, url: info.url, type: info.type };
}

/**
 * 激活指定 tab（把它变成活动标签页）。
 * quick --cdp 操作的是当前活动标签页，因此「选择 tab」的落地语义是先激活再执行。
 */
export async function activateCdpTab(targetId: string, port = currentPort): Promise<void> {
  selectedTargetId = targetId;
  if (currentTransport === "extension") {
    await activateBrowserExtensionTab(targetId);
    return;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3000);
  try {
    const res = await fetch(`${cdpHttpBase(port)}/json/activate/${encodeURIComponent(targetId)}`, {
      signal: controller.signal
    });
    if (!res.ok) {
      throw new Error(`激活标签页失败：HTTP ${res.status}`);
    }
  } finally {
    clearTimeout(timer);
  }
}

/** 读取 UI 选中的目标标签页 id（供 runAgentTurn 前重新激活）。 */
export function getSelectedTargetId(): string | undefined {
  return selectedTargetId;
}

/** 清除选中的目标标签页（UI 切回「默认活动标签页」时调用）。 */
export function clearSelectedTab(): void {
  selectedTargetId = undefined;
}

/** 当前 CDP 状态（含健康检查与 tab 列表）。 */
export async function getCdpStatus(): Promise<CdpStatus> {
  const port = currentPort;
  if (!connectionEnabled) {
    return { running: false, port, cdpUrl: cdpUrl(port) };
  }
  if (currentTransport === "extension") {
    const extension = await getBrowserExtensionBridgeStatus();
    if (!extension.connected) {
      return {
        running: false,
        mode: "extension",
        port: 0,
        cdpUrl: browserExtensionCdpUrl(localServerBaseUrl()),
        error: extension.reason
      };
    }
    const tabs = extension.tabs.map((tab) => ({
      id: tab.id,
      title: tab.title,
      url: tab.url,
      type: "page",
      active: tab.active
    }));
    if (selectedTargetId && !tabs.some((tab) => tab.id === selectedTargetId)) selectedTargetId = undefined;
    selectedTargetId = selectedTargetId ?? tabs.find((tab) => tab.active)?.id;
    return {
      running: true,
      mode: "extension",
      port: 0,
      cdpUrl: browserExtensionCdpUrl(localServerBaseUrl()),
      browserVersion: extension.version,
      browserName: extension.browserName || "用户 Chromium",
      selectedBrowserId: currentBrowserId || "extension-bridge-user-chrome",
      tabs,
      selectedTabId: selectedTargetId
    };
  }
  const probe = await probeCdp(port);
  if (!probe.alive) {
    // 进程存在但端口无响应 → 视为死亡，回收句柄
    if (managedProcess && managedProcess.exitCode !== null) {
      managedProcess = null;
    }
    return { running: false, port, cdpUrl: cdpUrl(port) };
  }
  let tabs: CdpTab[] = [];
  try {
    tabs = await listCdpTabs(port);
  } catch {
    // tab 枚举失败不影响 running 判定
  }
  return {
    running: true,
    mode: managedProcess && managedProcess.exitCode === null ? "managed" : "external",
    port,
    cdpUrl: cdpUrl(port),
    browserVersion: probe.version,
    browserPath: currentBrowserPath ?? managedBrowserPath,
    browserName: currentBrowserName,
    selectedBrowserId: currentBrowserId,
    tabs,
    selectedTabId: selectedTargetId
  };
}

export interface StartCdpOptions {
  port?: number;
  /** 指定浏览器可执行路径；缺省自动探测本机 Chrome/Edge */
  browserPath?: string;
  browserName?: string;
  browserId?: string;
  /** false 表示必须启动所选浏览器，不附加端口上已有的其它实例。 */
  reuseExisting?: boolean;
  /** 启动后打开的初始 URL */
  initialUrl?: string;
  transport?: "cdp" | "extension";
}

function taskGroupExtensionDir(): string {
  return path.resolve(
    process.env.UI_AGENT_BROWSER_TASK_GROUP_EXTENSION_DIR?.trim()
      || path.join(projectRoot, "browser-task-group-extension")
  );
}

async function hasTaskGroupExtensionFiles(): Promise<boolean> {
  try {
    const manifest = JSON.parse(
      await fs.readFile(path.join(taskGroupExtensionDir(), "manifest.json"), "utf8")
    ) as { key?: unknown; permissions?: unknown };
    return typeof manifest.key === "string"
      && Array.isArray(manifest.permissions)
      && manifest.permissions.includes("tabs")
      && manifest.permissions.includes("tabGroups");
  } catch {
    return false;
  }
}

/**
 * Chrome 137+ ignores --load-extension in official branded builds. Keep automatic
 * unpacked loading limited to developer-oriented Chromium distributions that
 * still document and honor the switch.
 */
export function canAutoLoadUnpackedTaskGroupExtension(
  browserPath: string,
  browserName = ""
): boolean {
  const identity = `${browserName} ${browserPath}`.toLowerCase();
  return identity.includes("chrome for testing") || /(^|[\\/\s])chromium(?:[\\/\s.]|$)/.test(identity);
}

/** 清洗浏览器标签组标题，避免控制字符和过长标题污染用户标签栏。 */
export function normalizeCdpTaskGroupTitle(value: string): string {
  const normalized = String(value || "UIWarden Task")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 24);
  return normalized || "UIWarden Task";
}

async function loadCdpRuntime(): Promise<CdpRuntimeModule> {
  const moduleUrl = pathToFileURL(path.join(projectRoot, "browser-automation", "src", "cdp.mjs")).href;
  return await import(moduleUrl) as unknown as CdpRuntimeModule;
}

async function browserWebSocketUrl(port = currentPort): Promise<string> {
  const version = await fetchJson<{ webSocketDebuggerUrl?: unknown }>(
    `${cdpHttpBase(port)}/json/version`
  );
  const url = String(version.webSocketDebuggerUrl || "");
  if (!url.startsWith(`ws://127.0.0.1:${port}/devtools/browser/`)
    && !url.startsWith(`ws://localhost:${port}/devtools/browser/`)) {
    throw new Error("当前 Chromium 未返回可信的本机 Browser CDP 地址");
  }
  return url;
}

async function runTaskGroupExtensionCommand(
  command: "capabilities" | "createTaskGroup",
  input?: { markerUrl: string; title: string; color: "red" | "blue" }
): Promise<ExtensionCommandResult> {
  const runtime = await loadCdpRuntime();
  const client = await runtime.CdpClient.connect(await browserWebSocketUrl());
  let controlTargetId = "";
  try {
    const controlUrl = `chrome-extension://${TASK_GROUP_EXTENSION_ID}/control.html`;
    let created: { targetId?: string };
    try {
      created = await client.send("Target.createTarget", {
        url: controlUrl,
        hidden: true,
        background: true,
      });
    } catch {
      created = await client.send("Target.createTarget", {
        url: controlUrl,
        background: true,
        focus: false,
      });
    }
    controlTargetId = String(created.targetId || "");
    if (!controlTargetId) throw new Error("无法创建任务标签组控制 target");
    const attached = await client.send<{ sessionId?: string }>("Target.attachToTarget", {
      targetId: controlTargetId,
      flatten: true,
    });
    const sessionId = String(attached.sessionId || "");
    if (!sessionId) throw new Error("无法附加任务标签组控制 target");
    await client.send("Runtime.enable", {}, 5_000, sessionId);
    const argument = input ? JSON.stringify(input) : "";
    const invocation = command === "capabilities"
      ? "globalThis.uiwardenTaskGroups.capabilities()"
      : `globalThis.uiwardenTaskGroups.createTaskGroup(${argument})`;
    const expression = `(async () => {
      for (let attempt = 0; attempt < 40; attempt += 1) {
        if (globalThis.uiwardenTaskGroups) return await (${invocation});
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      throw new Error("UIWarden 任务标签组扩展未加载");
    })()`;
    const evaluated = await client.send<{
      result?: { value?: unknown };
      exceptionDetails?: { text?: string; exception?: { description?: string } };
    }>("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    }, 8_000, sessionId);
    if (evaluated.exceptionDetails) {
      throw new Error(
        evaluated.exceptionDetails.exception?.description
          || evaluated.exceptionDetails.text
          || "任务标签组扩展执行失败"
      );
    }
    if (!evaluated.result?.value || typeof evaluated.result.value !== "object") {
      throw new Error("当前浏览器未安装 UIWarden 任务标签组扩展");
    }
    return evaluated.result.value as ExtensionCommandResult;
  } finally {
    if (controlTargetId) {
      await client.send("Target.closeTarget", { targetId: controlTargetId }).catch(() => undefined);
    }
    client.close();
  }
}

/** 检查当前 CDP 浏览器是否可以创建真实 Chromium 标签组。 */
export async function getCdpTaskGroupCapability(): Promise<CdpTaskGroupCapability> {
  if (currentTransport === "extension") {
    const extension = await getBrowserExtensionBridgeStatus();
    const available = extension.connected && extension.canGroupExistingTab;
    return {
      available,
      extensionId: TASK_GROUP_EXTENSION_ID,
      setupRequired: !available,
      installationMode: available ? "installed" : "manual",
      autoLoadSupported: false,
      reason: available
        ? undefined
        : extension.connected
          ? "当前 UIWarden 扩展版本过低，请重新加载 0.9.0 或更高版本"
          : extension.reason
    };
  }
  const probe = await probeCdp();
  const autoLoadSupported = currentBrowserPath
    ? canAutoLoadUnpackedTaskGroupExtension(currentBrowserPath, currentBrowserName)
    : false;
  if (!probe.alive) {
    return {
      available: false,
      extensionId: TASK_GROUP_EXTENSION_ID,
      setupRequired: false,
      installationMode: "unavailable",
      autoLoadSupported,
      reason: "请先选择并连接 Chromium 浏览器"
    };
  }
  try {
    const capability = await runTaskGroupExtensionCommand("capabilities");
    const available = capability.version === 1 && capability.tabs === true && capability.tabGroups === true;
    return {
      available,
      extensionId: TASK_GROUP_EXTENSION_ID,
      setupRequired: !available,
      installationMode: available ? "installed" : "manual",
      autoLoadSupported,
      reason: available ? undefined : "任务标签组扩展版本不兼容"
    };
  } catch (error) {
    return {
      available: false,
      extensionId: TASK_GROUP_EXTENSION_ID,
      setupRequired: true,
      installationMode: "manual",
      autoLoadSupported,
      reason: taskGroupExtensionLoaded
        ? `任务标签组扩展尚未就绪：${error instanceof Error ? error.message : String(error)}`
        : "当前浏览器未安装 UIWarden 任务标签组扩展"
    };
  }
}

/** 打开固定的扩展目录和当前 Chromium 的扩展管理页，供用户明确安装。 */
export async function openCdpTaskGroupExtensionSetup(): Promise<CdpTaskGroupSetup> {
  if (!await hasTaskGroupExtensionFiles()) {
    throw new Error("客户端安装包中缺少 UIWarden 任务标签组扩展");
  }
  if (!(await probeCdp()).alive) {
    throw new Error("请先选择并连接要安装任务标签组扩展的 Chromium 浏览器");
  }
  const extensionDir = taskGroupExtensionDir();
  if (process.platform === "darwin") {
    await execFileAsync("open", [extensionDir]);
  } else if (process.platform === "win32") {
    await execFileAsync("explorer.exe", [extensionDir]);
  } else {
    await execFileAsync("xdg-open", [extensionDir]);
  }
  const extensionManagerTab = await newCdpTab("chrome://extensions/");
  await activateCdpTab(extensionManagerTab.id);
  return {
    opened: true,
    extensionId: TASK_GROUP_EXTENSION_ID,
    instruction: "请在扩展管理页开启开发者模式，选择“加载已解压的扩展程序”，并选中已打开的扩展目录。"
  };
}

/** 为本轮 UI 操作创建真实用户浏览器标签组，并锁定入口 CDP target。 */
export async function createCdpTaskGroup(title: string): Promise<CdpTaskGroup> {
  if (currentTransport === "extension") {
    const normalizedTitle = normalizeCdpTaskGroupTitle(title);
    const markerUrl = `about:blank#uiwarden-task-${randomUUID()}`;
    const existingTargetId = selectedTargetId
      || (await listBrowserExtensionTabs()).find((tab) => tab.active)?.id;
    const result = await createBrowserExtensionTaskGroup({
      markerUrl,
      title: normalizedTitle,
      color: "red",
      targetId: existingTargetId
    });
    const targetId = `chrome-tab-${result.chromeTabId}`;
    selectedTargetId = targetId;
    return {
      version: 1,
      groupId: result.groupId,
      chromeTabId: result.chromeTabId,
      targetId,
      markerUrl,
      title: normalizedTitle
    };
  }
  const probe = await probeCdp();
  if (!probe.alive) throw new Error("请先在外部 CDP 面板选择并连接用户 Chromium 浏览器");
  const normalizedTitle = normalizeCdpTaskGroupTitle(title);
  const markerUrl = `about:blank#uiwarden-task-${randomUUID()}`;
  let result: ExtensionCommandResult;
  try {
    result = await runTaskGroupExtensionCommand("createTaskGroup", {
      markerUrl,
      title: normalizedTitle,
      color: "red",
    });
  } catch (error) {
    throw new Error(
      `无法创建用户浏览器任务标签组：${error instanceof Error ? error.message : String(error)}`
    );
  }
  if (result.version !== 1 || !Number.isInteger(result.groupId) || !Number.isInteger(result.chromeTabId)) {
    throw new Error("任务标签组扩展返回了不兼容的结果");
  }
  const deadline = Date.now() + 5_000;
  let targetId = "";
  while (Date.now() < deadline) {
    const tab = (await listCdpTabs()).find((candidate) => candidate.url === markerUrl);
    if (tab) {
      targetId = tab.id;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (!targetId) throw new Error("任务标签组已创建，但未能映射对应的 CDP target");
  await activateCdpTab(targetId);
  return {
    version: 1,
    groupId: result.groupId!,
    chromeTabId: result.chromeTabId!,
    targetId,
    markerUrl,
    title: normalizedTitle,
  };
}

async function portAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => server.close(() => resolve(true)));
    server.listen(port, "127.0.0.1");
  });
}

async function availableCdpPort(preferred: number): Promise<number> {
  for (let port = preferred; port < preferred + 100; port += 1) {
    if (await portAvailable(port)) return port;
  }
  throw new Error(`未找到可用 CDP 端口（${preferred}-${preferred + 99}）`);
}

/**
 * 启动（或附加）CDP 浏览器。
 * - 端口已有存活 CDP → 直接 attach，不重复启动；
 * - 否则用专用持久 profile 托管启动本机浏览器。
 */
export async function startCdpBrowser(options: StartCdpOptions = {}): Promise<CdpStatus> {
  if (options.transport === "extension") {
    currentTransport = "extension";
    connectionEnabled = true;
    managedProcess = null;
    managedBrowserPath = undefined;
    currentBrowserPath = undefined;
    currentBrowserName = options.browserName || "用户 Chromium";
    currentBrowserId = options.browserId || "extension-bridge-user-chrome";
    selectedTargetId = undefined;
    taskGroupExtensionLoaded = true;
    return getCdpStatus();
  }
  currentTransport = "cdp";
  let port = options.port ?? DEFAULT_CDP_PORT;
  if (options.browserPath && options.reuseExisting === false) {
    port = await availableCdpPort(port);
  }
  currentPort = port;
  connectionEnabled = true;
  selectedTargetId = undefined;
  taskGroupExtensionLoaded = false;

  const existing = await probeCdp(port);
  if (existing.alive) {
    managedProcess = null;
    managedBrowserPath = undefined;
    currentBrowserPath = options.browserPath;
    currentBrowserName = options.browserName;
    currentBrowserId = options.browserId;
    return getCdpStatus();
  }

  const browserPath = options.browserPath ?? (await preferredCdpBrowserPath());
  if (!browserPath) {
    return {
      running: false,
      port,
      cdpUrl: cdpUrl(port),
      error: "未找到本机 Chrome/Edge，请安装浏览器或在 Skill 配置中指定浏览器路径"
    };
  }

  await fs.mkdir(cdpProfileDir, { recursive: true });
  const extensionAvailable = await hasTaskGroupExtensionFiles();
  const autoLoadTaskGroupExtension = extensionAvailable
    && canAutoLoadUnpackedTaskGroupExtension(browserPath, options.browserName);

  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${cdpProfileDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-features=ChromeWhatsNewUI"
  ];
  if (autoLoadTaskGroupExtension) args.push(`--load-extension=${taskGroupExtensionDir()}`);
  args.push(options.initialUrl ?? "about:blank");
  const child = spawn(browserPath, args, {
    detached: false,
    stdio: "ignore"
  });
  child.on("exit", () => {
    if (managedProcess === child) {
      managedProcess = null;
    }
  });
  child.on("error", () => {
    if (managedProcess === child) {
      managedProcess = null;
    }
  });
  managedProcess = child;
  managedBrowserPath = browserPath;
  currentBrowserPath = browserPath;
  currentBrowserName = options.browserName;
  currentBrowserId = options.browserId;
  taskGroupExtensionLoaded = autoLoadTaskGroupExtension;

  // 等待 CDP 端口就绪（最多 15s）
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const probe = await probeCdp(port);
    if (probe.alive) {
      return getCdpStatus();
    }
    if (child.exitCode !== null) {
      managedProcess = null;
      return {
        running: false,
        port,
        cdpUrl: cdpUrl(port),
        error: `浏览器进程启动后立即退出（exit=${child.exitCode}），可能是 profile 目录被占用或浏览器路径无效`
      };
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return {
    running: false,
    port,
    cdpUrl: cdpUrl(port),
    error: "浏览器已启动但 CDP 端口 15s 内未就绪"
  };
}

/**
 * 关闭 CDP 浏览器。
 * - 托管进程：SIGTERM → 5s 超时 SIGKILL；
 * - attach 的外部浏览器：不杀进程，仅返回提示（用户自己启动的浏览器由用户管理）。
 */
export async function stopCdpBrowser(): Promise<{ stopped: boolean; message: string }> {
  if (currentTransport === "extension") {
    connectionEnabled = false;
    selectedTargetId = undefined;
    currentBrowserId = undefined;
    currentBrowserName = undefined;
    currentBrowserPath = undefined;
    taskGroupExtensionLoaded = false;
    currentTransport = "cdp";
    return {
      stopped: true,
      message: "已断开用户 Chromium 扩展桥，浏览器及其页面保持打开"
    };
  }
  const child = managedProcess;
  if (!child || child.exitCode !== null) {
    managedProcess = null;
    const probe = await probeCdp(currentPort);
    if (probe.alive) {
      connectionEnabled = false;
      selectedTargetId = undefined;
      currentBrowserId = undefined;
      currentBrowserName = undefined;
      currentBrowserPath = undefined;
      taskGroupExtensionLoaded = false;
      return {
        stopped: true,
        message: "已断开外部 CDP 浏览器，浏览器及其页面保持打开"
      };
    }
    return { stopped: true, message: "CDP 浏览器未在运行" };
  }
  return new Promise((resolve) => {
    const killTimer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // 已退出
      }
    }, 5000);
    child.once("exit", () => {
      clearTimeout(killTimer);
      managedProcess = null;
      connectionEnabled = false;
      selectedTargetId = undefined;
      currentBrowserId = undefined;
      currentBrowserName = undefined;
      currentBrowserPath = undefined;
      taskGroupExtensionLoaded = false;
      resolve({ stopped: true, message: "CDP 浏览器已关闭" });
    });
    try {
      child.kill("SIGTERM");
    } catch {
      clearTimeout(killTimer);
      managedProcess = null;
      connectionEnabled = false;
      selectedTargetId = undefined;
      currentBrowserId = undefined;
      currentBrowserName = undefined;
      currentBrowserPath = undefined;
      taskGroupExtensionLoaded = false;
      resolve({ stopped: true, message: "CDP 浏览器已退出" });
    }
  });
}
