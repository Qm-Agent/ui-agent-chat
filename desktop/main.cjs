// UIWarden 桌面客户端主进程。
// - 客户端在用户本机拉起同一套 Node server（UI_AGENT_DESKTOP=true 本地模式），
//   加载同一套 web 前端（dist/client 静态产物或 vite dev server）；
// - server 代码不分叉：web 部署与客户端共用同一入口，仅通过环境变量切换行为；
// - agent 执行使用用户本机浏览器环境（Chrome/Chromium、CDP、本机登录态）。
const { app, BrowserWindow, dialog, ipcMain, Menu, screen, shell, session } = require("electron");
const { spawn, execFileSync } = require("node:child_process");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { EmbeddedBrowserHost, startEmbeddedBrowserBridge } = require("./embedded-browser.cjs");
const { PictureInPictureController } = require("./picture-in-picture.cjs");
const { buildApplicationMenuTemplate } = require("./application-menu.cjs");
const {
  createDesktopShellVisibilityController,
  createWindowCoordinator,
  loadWindowUrlWithRetry,
} = require("./window-lifecycle.cjs");

// 打包后 server/web 产物位于 resources 下；开发模式直接用仓库根目录。
const repoRoot = app.isPackaged ? process.resourcesPath : path.resolve(__dirname, "..");
const isDev = !app.isPackaged;
const devWebDev = process.env.UI_AGENT_DESKTOP_DEV === "true";

// 客户端默认端口与 web 部署（8787/5174）错开，避免与本机开发服务冲突。
const apiPort = Number(process.env.UI_AGENT_DESKTOP_API_PORT || (app.isPackaged ? "8797" : "8787"));
const apiBaseUrl = `http://127.0.0.1:${apiPort}`;
// 客户端直接加载 server 托管的静态前端（server 已内置 express.static dist/client），
// 开发模式可选走 vite dev server 以便热更新。
let webUrl = process.env.UI_AGENT_DESKTOP_WEB_URL || (devWebDev ? "http://127.0.0.1:5174" : apiBaseUrl);

// Electron 自带 Chromium 即内置浏览器执行内核。调试端口只监听本机，并使用
// 每次启动随机高位端口，避免与外部 Chrome CDP 或其它 UIWarden 实例冲突。
const embeddedCdpPort = Number(process.env.UI_AGENT_EMBEDDED_CDP_PORT)
  || (32000 + Math.floor(Math.random() * 12000));
app.commandLine.appendSwitch("remote-debugging-address", "127.0.0.1");
app.commandLine.appendSwitch("remote-debugging-port", String(embeddedCdpPort));
// Playwright uses its own WebSocket Origin when attaching over CDP. Chromium
// rejects that handshake unless explicitly allowed; the endpoint remains bound
// to a random localhost-only port.
app.commandLine.appendSwitch("remote-allow-origins", "*");

const children = [];
let mainWindow = null;
let embeddedBrowserHost = null;
let embeddedBrowserBridge = null;
let embeddedBrowserIpcRegistered = false;
let pictureInPictureController = null;
let pictureInPictureIpcRegistered = false;
// server 子进程诊断状态：打包后 GUI 看不到控制台输出，必须落盘 + 弹窗带原因。
let serverExit = null; // { code, signal }
let serverLogPath = null;
let appQuitting = false;

const isDesktopE2e = process.env.UI_AGENT_DESKTOP_E2E === "true";
if (isDesktopE2e && process.env.UI_AGENT_DESKTOP_DATA_DIR) {
  const e2eUserDataDir = path.join(process.env.UI_AGENT_DESKTOP_DATA_DIR, "electron-user-data");
  fs.mkdirSync(e2eUserDataDir, { recursive: true });
  app.setPath("userData", e2eUserDataDir);
}
app.setName(isDesktopE2e ? "UIWarden E2E" : "UIWarden");

const gotSingleInstanceLock = isDesktopE2e || app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    void app.whenReady().then(() => ensureMainWindow());
  });
}

function desktopDataDir() {
  // 客户端数据放用户目录，与 web 部署（仓库 data/）隔离，保证本机数据独立与离线可用。
  return process.env.UI_AGENT_DESKTOP_DATA_DIR || path.join(app.getPath("userData"), "data");
}

const keepDesktopShellVisible = createDesktopShellVisibilityController({
  app,
  platform: process.platform,
});

function showMainWindow(window = mainWindow) {
  if (!window || window.isDestroyed()) return;
  keepDesktopShellVisible();
  if (window.isMinimized()) window.restore();
  if (process.platform === "darwin" && app.isHidden?.()) {
    app.show();
  }
  if (typeof window.isVisible !== "function" || !window.isVisible()) window.show();
  if (typeof window.isFocused !== "function" || !window.isFocused()) window.focus();
}

function configureDesktopShell() {
  keepDesktopShellVisible();
  Menu.setApplicationMenu(Menu.buildFromTemplate(buildApplicationMenuTemplate({
    appName: "UIWarden",
    isMac: process.platform === "darwin",
    showMainWindow,
    reloadMainWindow: () => {
      if (!mainWindow?.isDestroyed()) mainWindow.webContents.reload();
    },
    forceReloadMainWindow: () => {
      if (!mainWindow?.isDestroyed()) mainWindow.webContents.reloadIgnoringCache();
    },
    toggleMainDevTools: () => {
      if (!mainWindow?.isDestroyed()) mainWindow.webContents.toggleDevTools();
    },
  })));
}

function resolveUserPath() {
  // GUI 启动的 app 继承不到 shell PATH；macOS 下取用户默认 shell 的 PATH，
  // 保证能找到 claude CLI、python3、本机 Chrome 等 agent 依赖。
  if (process.platform !== "darwin" && process.platform !== "linux") {
    return process.env.PATH || "";
  }
  try {
    const shellBin = process.env.SHELL || "/bin/zsh";
    const shellEnv = { ...process.env };
    delete shellEnv.npm_config_prefix;
    const output = execFileSync(shellBin, ["-ilc", "echo -n \"$PATH\""], {
      encoding: "utf8",
      env: shellEnv,
      timeout: 8000,
    });
    if (output && output.length > 0) {
      return [process.env.PATH || "", output]
        .filter(Boolean)
        .join(path.delimiter);
    }
  } catch {
    // ignore — fall back to process PATH
  }
  return process.env.PATH || "";
}

function serverEnv(userPath) {
  const localDataDir = desktopDataDir();
  const localDbFile = path.join(localDataDir, "ui-agent-chat.db");
  const computerHome = process.env.DT_GUI_COMPUTER_HOME
    || path.join(localDataDir, "native-automation");
  const browserAutomationHome = process.env.DT_GUI_BROWSER_HOME
    || path.join(localDataDir, "browser-automation");
  const browserAutomationRoot = path.join(repoRoot, "browser-automation");
  const packagedSkillRoot = (name) => path.join(
    repoRoot,
    ...(app.isPackaged ? [name] : ["skills", name])
  );
  const bundledBrowserUseWheel = path.join(
    repoRoot,
    "vendor",
    "browser-use",
    "browser_use-3.1.6-py3-none-any.whl"
  );
  const bundledUiTestRuntimeRoot = path.join(repoRoot, "ui-test-runtime");
  const bundledUiTestPython = path.join(
    bundledUiTestRuntimeRoot,
    "python",
    process.platform === "win32" ? "python.exe" : path.join("bin", "python3")
  );
  const bundledPlaywrightBrowsers = path.join(bundledUiTestRuntimeRoot, "ms-playwright");
  const hasBundledUiTestRuntime = app.isPackaged
    && fs.existsSync(path.join(bundledUiTestRuntimeRoot, "runtime-manifest.json"))
    && fs.existsSync(bundledUiTestPython)
    && fs.existsSync(bundledPlaywrightBrowsers);
  const bundledNodeDir = app.isPackaged ? path.join(repoRoot, "runtime") : "";
  const bundledNodePath = app.isPackaged
    ? path.join(bundledNodeDir, process.platform === "win32" ? "node.exe" : "node")
    : "";
  const computerBinary = process.env.DT_GUI_COMPUTER_BIN
    || (app.isPackaged
      ? path.join(repoRoot, "native-automation", process.platform === "win32" ? "dt-gui-computer.cmd" : "dt-gui-computer")
      : path.join(repoRoot, "native-automation", process.platform === "win32" ? "dt-gui-computer.cmd" : "dt-gui-computer"));
  const macProvider = process.env.DT_GUI_COMPUTER_MACOS_PROVIDER
    || (app.isPackaged
      ? path.join(repoRoot, "native-automation", "dt-gui-computer Provider.app")
      : path.join(repoRoot, "native-automation", "target", "native-provider", "dt-gui-computer Provider.app"));
  const windowsProvider = process.env.DT_GUI_COMPUTER_WINDOWS_PROVIDER
    || (app.isPackaged
      ? path.join(repoRoot, "native-automation", "windows", "DTGuiComputer.WindowsProvider.exe")
      : path.join(repoRoot, "native-automation", "target", "native-provider", "windows", "DTGuiComputer.WindowsProvider.exe"));
  return {
    ...process.env,
    PATH: [bundledNodeDir, userPath].filter(Boolean).join(path.delimiter),
    HOST: "127.0.0.1",
    PORT: String(apiPort),
    // 桌面本地模式：本机 SQLite 与文件存储，不依赖外部数据库或对象存储。
    UI_AGENT_DESKTOP: "true",
    UI_AGENT_DB_MODE: process.env.UI_AGENT_DESKTOP_DB_MODE || "sqlite",
    UI_AGENT_DATA_DIR: localDataDir,
    UI_AGENT_DB_FILE: localDbFile,
    UI_AGENT_DEFAULT_EXECUTION_RUNTIME: process.env.UI_AGENT_DEFAULT_EXECUTION_RUNTIME || "dtcoder",
    CFUSE_LAUNCHER_VERSION: process.env.CFUSE_LAUNCHER_VERSION || "",
    UI_AGENT_EMBEDDED_BROWSER_BRIDGE_URL: embeddedBrowserBridge?.url || "",
    UI_AGENT_EMBEDDED_BROWSER_BRIDGE_TOKEN: embeddedBrowserBridge?.token || "",
    UI_AGENT_EMBEDDED_BROWSER_CDP_URL: `http://127.0.0.1:${embeddedCdpPort}`,
    UI_AGENT_BROWSER_TASK_GROUP_EXTENSION_DIR: process.env.UI_AGENT_BROWSER_TASK_GROUP_EXTENSION_DIR
      || path.join(repoRoot, "browser-task-group-extension"),
    UI_TEST_ASSISTANT_SKILL_PATH: process.env.UI_TEST_ASSISTANT_SKILL_PATH
      || packagedSkillRoot("ui-test-assistant-skill"),
    UIWARDEN_BROWSER_USE_WHEEL: process.env.UIWARDEN_BROWSER_USE_WHEEL
      || bundledBrowserUseWheel,
    UIWARDEN_UI_TEST_RUNTIME: process.env.UIWARDEN_UI_TEST_RUNTIME
      || (hasBundledUiTestRuntime ? bundledUiTestRuntimeRoot : ""),
    UI_TEST_PYTHON: process.env.UI_TEST_PYTHON
      || (hasBundledUiTestRuntime ? bundledUiTestPython : ""),
    PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH
      || (hasBundledUiTestRuntime ? bundledPlaywrightBrowsers : ""),
    PLAYWRIGHT_SKIP_BROWSER_GC: process.env.PLAYWRIGHT_SKIP_BROWSER_GC
      || (hasBundledUiTestRuntime ? "1" : ""),
    DT_GUI_COMPUTER_HOME: computerHome,
    DT_GUI_COMPUTER_BIN: computerBinary,
    DT_GUI_COMPUTER_NODE: process.env.DT_GUI_COMPUTER_NODE || bundledNodePath,
    DT_GUI_COMPUTER_SKILL_PATH: process.env.DT_GUI_COMPUTER_SKILL_PATH
      || packagedSkillRoot("dt-gui-computer-skill"),
    DT_GUI_COMPUTER_MACOS_PROVIDER: macProvider,
    DT_GUI_COMPUTER_WINDOWS_PROVIDER: windowsProvider,
    DT_GUI_BROWSER_HOME: browserAutomationHome,
    DT_GUI_BROWSER_CLI: process.env.DT_GUI_BROWSER_CLI || path.join(browserAutomationRoot, "cli.mjs"),
    DT_GUI_BROWSER_BIN: process.env.DT_GUI_BROWSER_BIN || path.join(
      browserAutomationRoot,
      "bin",
      process.platform === "win32" ? "dt-gui-browser.cmd" : "dt-gui-browser"
    ),
    DT_GUI_BROWSER_SKILL_PATH: process.env.DT_GUI_BROWSER_SKILL_PATH
      || packagedSkillRoot("dt-gui-browser-skill"),
  };
}

async function ensureEmbeddedBrowserBridge() {
  if (embeddedBrowserBridge) return embeddedBrowserBridge;
  embeddedBrowserBridge = await startEmbeddedBrowserBridge({
    getHost: () => embeddedBrowserHost,
  });
  return embeddedBrowserBridge;
}

function requireEmbeddedBrowserHost() {
  if (!embeddedBrowserHost) throw new Error("内置浏览器尚未就绪");
  return embeddedBrowserHost;
}

function registerEmbeddedBrowserIpc() {
  if (embeddedBrowserIpcRegistered) return;
  embeddedBrowserIpcRegistered = true;
  ipcMain.handle("uiwarden:embedded-browser:get-state", () => requireEmbeddedBrowserHost().getState());
  ipcMain.handle("uiwarden:embedded-browser:capture-preview", () => requireEmbeddedBrowserHost().capturePreview());
  ipcMain.handle("uiwarden:embedded-browser:set-visible", (_event, visible) => requireEmbeddedBrowserHost().setVisible(visible));
  ipcMain.handle("uiwarden:embedded-browser:set-bounds", (_event, bounds) => requireEmbeddedBrowserHost().setBounds(bounds));
  ipcMain.handle("uiwarden:embedded-browser:navigate", (_event, url) => requireEmbeddedBrowserHost().navigate(url));
  ipcMain.handle("uiwarden:embedded-browser:create-tab", (_event, url) => requireEmbeddedBrowserHost().createTab(url));
  ipcMain.handle("uiwarden:embedded-browser:activate-tab", (_event, tabId) => requireEmbeddedBrowserHost().activateTab(tabId));
  ipcMain.handle("uiwarden:embedded-browser:close-tab", (_event, tabId) => requireEmbeddedBrowserHost().closeTab(tabId));
  ipcMain.handle("uiwarden:embedded-browser:command", (_event, command) => requireEmbeddedBrowserHost().browserCommand(command));
  ipcMain.handle("uiwarden:embedded-browser:find", (_event, query, forward) => requireEmbeddedBrowserHost().findInPage(query, forward));
  ipcMain.handle("uiwarden:embedded-browser:stop-find", () => requireEmbeddedBrowserHost().stopFind());
  ipcMain.handle("uiwarden:embedded-browser:open-downloads", () => requireEmbeddedBrowserHost().openDownloads());
  ipcMain.handle("uiwarden:embedded-browser:toggle-bookmark", () => requireEmbeddedBrowserHost().toggleBookmark());
  ipcMain.handle("uiwarden:embedded-browser:remove-bookmark", (_event, id) => requireEmbeddedBrowserHost().removeBookmark(id));
  ipcMain.handle("uiwarden:embedded-browser:clear-history", () => requireEmbeddedBrowserHost().clearHistory());
  ipcMain.handle("uiwarden:embedded-browser:clear-cookies", () => requireEmbeddedBrowserHost().clearCookies());
  ipcMain.handle("uiwarden:embedded-browser:set-zoom-factor", (_event, factor) => requireEmbeddedBrowserHost().setZoomFactor(factor));
  ipcMain.handle("uiwarden:embedded-browser:open-devtools", () => requireEmbeddedBrowserHost().openDevTools());
  ipcMain.handle("uiwarden:embedded-browser:set-control-mode", (_event, mode) => requireEmbeddedBrowserHost().setControlMode(mode));
}

function requirePictureInPictureController() {
  if (!pictureInPictureController) throw new Error("画中画控制器尚未就绪");
  return pictureInPictureController;
}

function registerPictureInPictureIpc() {
  if (pictureInPictureIpcRegistered) return;
  pictureInPictureIpcRegistered = true;
  ipcMain.handle("uiwarden:picture-in-picture:get-state", () => requirePictureInPictureController().getState());
  ipcMain.handle("uiwarden:picture-in-picture:open", (_event, input) => requirePictureInPictureController().open(input));
  ipcMain.handle("uiwarden:picture-in-picture:update", (_event, input) => requirePictureInPictureController().update(input));
  ipcMain.handle("uiwarden:picture-in-picture:close", () => requirePictureInPictureController().close());
  ipcMain.handle("uiwarden:picture-in-picture:focus-main-window", () => requirePictureInPictureController().focusMainWindow());
  ipcMain.handle("uiwarden:picture-in-picture:set-interaction", (_event, enabled) =>
    requirePictureInPictureController().setInteractionEnabled(enabled));
  ipcMain.handle("uiwarden:picture-in-picture:click-native-surface", (_event, input) =>
    requirePictureInPictureController().clickNativeSurface(input));
}

function resolveNodeCommand(userPath) {
  // 打包客户端固定使用随包 Node，确保 better-sqlite3 等原生模块 ABI 一致。
  if (app.isPackaged) {
    const bundledNode = path.join(repoRoot, "runtime", process.platform === "win32" ? "node.exe" : "node");
    if (isCompatibleNodeRuntime(bundledNode, userPath)) return bundledNode;
  }
  const expectedAbi = expectedNodeModuleAbi();
  const candidates = process.platform === "win32" ? ["node.exe", "node"] : ["node"];
  for (const name of candidates) {
    try {
      const resolvedCandidates = execFileSync(
        process.platform === "win32" ? "where" : "which",
        process.platform === "win32" ? [name] : ["-a", name],
        {
        encoding: "utf8",
        env: { ...process.env, PATH: userPath },
        timeout: 5000,
        }
      ).split(/\r?\n/).map((entry) => entry.trim()).filter(Boolean);
      for (const resolved of [...new Set(resolvedCandidates)]) {
        if (isCompatibleNodeRuntime(resolved, userPath, expectedAbi)) return resolved;
      }
    } catch {
      // continue
    }
  }
  return null;
}

function expectedNodeModuleAbi() {
  // 开发模式的 server 是独立 Node 子进程，不能拿 Electron 主进程 ABI
  // 去筛选它；原生依赖兼容性由 server 启动结果暴露。打包模式仍严格
  // 使用随包 runtime 元数据，避免客户环境误选系统 Node。
  if (!app.isPackaged) return "";
  try {
    const metadata = JSON.parse(fs.readFileSync(path.join(repoRoot, "runtime", "node-runtime.json"), "utf8"));
    return String(metadata.modules || "");
  } catch {
    return "";
  }
}

function isCompatibleNodeRuntime(executable, userPath, expectedAbi = expectedNodeModuleAbi()) {
  if (!executable || !fs.existsSync(executable)) return false;
  try {
    const modules = execFileSync(executable, ["-p", "process.versions.modules"], {
      encoding: "utf8",
      env: { ...process.env, PATH: userPath },
      timeout: 5000,
    }).trim();
    return Boolean(modules) && (!expectedAbi || modules === expectedAbi);
  } catch {
    return false;
  }
}

function serverLogFile() {
  // 打包后 GUI 看不到 stdout/stderr；把 server 输出落到用户目录日志，弹窗里给出路径。
  const dir = path.join(app.getPath("userData"), "logs");
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    // ignore
  }
  return path.join(dir, "server.log");
}

function startApiServer() {
  const userPath = resolveUserPath();
  const serverEntry = path.join(repoRoot, "dist", "server", "index.js");
  if (!fs.existsSync(serverEntry)) {
    dialog.showErrorBox(
      "UIWarden 启动失败",
      `未找到 server 产物：${serverEntry}\n请先在仓库根目录执行 npm run build。`
    );
    app.quit();
    return;
  }
  const nodeCmd = resolveNodeCommand(userPath);
  if (!nodeCmd) {
    dialog.showErrorBox(
      "UIWarden 启动失败",
      "未找到与客户端原生模块兼容的 Node 运行时。请重新安装完整的 UIWarden 客户端。"
    );
    app.quit();
    return;
  }
  const env = serverEnv(userPath);
  serverExit = null;
  serverLogPath = serverLogFile();
  let logStream = null;
  try {
    logStream = fs.createWriteStream(serverLogPath, { flags: "a" });
  } catch {
    // ignore — 日志不可写不阻塞启动
  }
  const writeLog = (chunk) => {
    try {
      logStream?.write(chunk);
    } catch {
      // ignore
    }
  };
  writeLog(
    `\n[desktop] ${new Date().toISOString()} starting server (runtime=${nodeCmd}, port=${apiPort}, packaged=${app.isPackaged})\n`
  );
  const child = spawn(nodeCmd, [serverEntry], { env, cwd: repoRoot, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.on("data", (chunk) => {
    process.stdout.write(`[server] ${chunk}`);
    writeLog(chunk);
  });
  child.stderr.on("data", (chunk) => {
    process.stderr.write(`[server] ${chunk}`);
    writeLog(chunk);
  });
  child.on("exit", (code, signal) => {
    serverExit = { code, signal };
    const idx = children.indexOf(child);
    if (idx >= 0) children.splice(idx, 1);
    writeLog(`[desktop] server exited code=${code} signal=${signal || ""}\n`);
    console.log(`[desktop] server exited with code ${code}`);
  });
  children.push(child);
}

function fetchJson(url, timeoutMs = 2000) {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => {
        try {
          resolve(res.statusCode === 200 ? JSON.parse(body) : null);
        } catch {
          resolve(null);
        }
      });
    });
    req.on("error", () => resolve(null));
    req.on("timeout", () => {
      req.destroy();
      resolve(null);
    });
  });
}

async function waitFor(url, label, attempts = 120, intervalMs = 500) {
  for (let i = 0; i < attempts; i += 1) {
    const ok = await fetchJson(url);
    if (ok) return true;
    // server 子进程已退出（且兜底重试也失败/未触发）时不再空等 60s，直接报错。
    if (serverExit && children.length === 0) break;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  const exitInfo = serverExit
    ? `\nserver 进程已退出（code=${serverExit.code}，signal=${serverExit.signal || "无"}）。`
    : "";
  const logInfo = serverLogPath ? `\n诊断日志：${serverLogPath}` : "";
  dialog.showErrorBox(
    "UIWarden 启动超时",
    `${label} 未在预期时间内就绪：${url}${exitInfo}${logInfo}\n可尝试：检查 ${apiPort} 端口占用、查看诊断日志后重启应用。`
  );
  return false;
}

function appBundleVersion() {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"));
    return pkg.version || "unknown";
  } catch {
    return "unknown";
  }
}

function killPortListeners(port) {
  // 清理端口上的残留 server（旧版本 app 退出未杀干净 / 版本不匹配时）。
  if (process.platform === "win32") return;
  try {
    const out = execFileSync("lsof", ["-ti", `tcp:${port}`], { encoding: "utf8", timeout: 5000 });
    for (const pid of out.split("\n").map((s) => s.trim()).filter(Boolean)) {
      if (Number(pid) === process.pid) continue;
      try {
        process.kill(Number(pid), "SIGTERM");
      } catch {
        // ignore
      }
    }
  } catch {
    // lsof 无匹配时退出码非 0，忽略
  }
}

async function ensureLocalRuntime() {
  const expectedVersion = appBundleVersion();
  let health = await fetchJson(`${apiBaseUrl}/api/health`);
  if (health && health.version !== expectedVersion) {
    // 端口上是旧版残留 server（缺新 API 路由会导致前端 JSON 报错），清理后重启。
    console.log(`[desktop] stale server on port ${apiPort} (version=${health.version ?? "unknown"}, expected=${expectedVersion}); restarting`);
    killPortListeners(apiPort);
    await new Promise((r) => setTimeout(r, 800));
    health = await fetchJson(`${apiBaseUrl}/api/health`);
  }
  if (!health && process.env.UI_AGENT_DESKTOP_SKIP_SERVER !== "true") {
    startApiServer();
  }
  await waitFor(`${apiBaseUrl}/api/health`, "UIWarden API");
}

async function createWindow() {
  await ensureEmbeddedBrowserBridge();
  await ensureLocalRuntime();

  // 企业内网常配置强制系统代理（含 PAC），会把 127.0.0.1 也代理掉，
  // 导致加载本地页面报 ERR_PROXY_CONNECTION_FAILED。本 app 只加载本机服务，直连即可。
  if (process.env.UI_AGENT_DESKTOP_KEEP_PROXY !== "true") {
    await session.defaultSession.setProxy({ mode: "direct" });
  }

  const window = new BrowserWindow({
    width: 1480,
    height: 960,
    minWidth: 1200,
    minHeight: 780,
    title: "UIWarden",
    backgroundColor: "#f7f8fa",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
    show: false,
  });
  mainWindow = window;

  window.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });
  window.webContents.on("did-start-loading", () => {
    if (mainWindow !== window) return;
    pictureInPictureController?.close("renderer-reload");
    embeddedBrowserHost?.setVisible(false);
  });
  window.webContents.on("render-process-gone", () => {
    if (mainWindow === window) embeddedBrowserHost?.setVisible(false);
  });
  window.on("show", keepDesktopShellVisible);
  window.on("focus", keepDesktopShellVisible);

  const browserHost = new EmbeddedBrowserHost(window, { cdpPort: embeddedCdpPort });
  embeddedBrowserHost = browserHost;
  registerEmbeddedBrowserIpc();
  await browserHost.initialize();
  const pipController = new PictureInPictureController({
    BrowserWindow,
    app,
    screen,
    mainWindow: window,
    getEmbeddedBrowserHost: () => browserHost,
    keepApplicationVisible: keepDesktopShellVisible,
    preloadPath: path.join(__dirname, "pip-preload.cjs"),
    htmlPath: path.join(__dirname, "pip.html"),
    allowedSnapshotOrigins: [apiBaseUrl, webUrl],
    nativeProviderAppPath: process.env.DT_GUI_COMPUTER_MACOS_PROVIDER || (
      app.isPackaged
        ? path.join(repoRoot, "native-automation", "dt-gui-computer Provider.app")
        : path.join(repoRoot, "native-automation", "target", "native-provider", "dt-gui-computer Provider.app")
    ),
  });
  pictureInPictureController = pipController;
  registerPictureInPictureIpc();
  window.on("closed", () => {
    pipController.destroy();
    browserHost.destroy();
    if (pictureInPictureController === pipController) pictureInPictureController = null;
    if (embeddedBrowserHost === browserHost) embeddedBrowserHost = null;
    if (mainWindow === window) mainWindow = null;
  });

  await loadWindowUrlWithRetry(window, webUrl);
  // Electron may install its default menu while creating the first window.
  // Reapply the product menu after navigation so packaged builds keep all shell actions.
  configureDesktopShell();
  return window;
}

async function handleWindowCreationError(error) {
  if (appQuitting) return;
  dialog.showErrorBox("UIWarden 启动失败", String(error?.stack || error));
  app.quit();
}

const ensureMainWindow = createWindowCoordinator({
  getWindow: () => mainWindow,
  createWindow,
  showWindow: showMainWindow,
  onError: handleWindowCreationError,
});

function stopChildren() {
  for (const child of children) {
    try {
      child.kill("SIGTERM");
    } catch {
      // ignore
    }
  }
  children.length = 0;
  try {
    pictureInPictureController?.destroy();
    pictureInPictureController = null;
  } catch {
    // ignore
  }
  try {
    embeddedBrowserHost?.destroy();
  } catch {
    // ignore
  }
  try {
    embeddedBrowserBridge?.server?.close();
  } catch {
    // ignore
  }
}

app.whenReady().then(() => {
  configureDesktopShell();
  void ensureMainWindow();

  app.on("activate", () => {
    keepDesktopShellVisible();
    void ensureMainWindow();
  });
  app.on("did-become-active", keepDesktopShellVisible);
  app.on("browser-window-created", keepDesktopShellVisible);
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("before-quit", () => {
  appQuitting = true;
  stopChildren();
});
process.on("exit", stopChildren);
