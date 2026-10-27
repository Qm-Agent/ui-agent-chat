const { app, BrowserWindow, ipcMain, shell } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const PRODUCT_NAME = "gui-computer";

const requestedCdpPort = process.argv
  .map((argument) => argument.match(/^--remote-debugging-port=(\d+)$/)?.[1])
  .find(Boolean);
const cdpPort = Number(process.env.GUI_COMPUTER_BROWSER_CDP_PORT || requestedCdpPort)
  || (44000 + Math.floor(Math.random() * 10000));
app.commandLine.appendSwitch("remote-debugging-address", "127.0.0.1");
app.commandLine.appendSwitch("remote-debugging-port", String(cdpPort));
app.commandLine.appendSwitch("remote-allow-origins", "*");
app.setName(PRODUCT_NAME);
const configuredUserData = process.env.GUI_COMPUTER_BROWSER_DATA_DIR;
const configuredDiscoveryFile = process.env.GUI_COMPUTER_BROWSER_DISCOVERY_FILE;
if (configuredUserData) {
  const customUserData = path.resolve(configuredUserData);
  fs.mkdirSync(customUserData, { recursive: true });
  app.setPath("userData", customUserData);
}

const gotLock = process.env.GUI_COMPUTER_BROWSER_E2E === "true"
  || app.requestSingleInstanceLock();
if (!gotLock) app.quit();

const browserWindows = new Map();
let activeEntry = null;
let bridge = null;
let discoveryPath = null;
let ipcRegistered = false;

function browserModule() {
  const modulePath = app.isPackaged
    ? path.join(process.resourcesPath, "embedded-browser.cjs")
    : path.resolve(__dirname, "../desktop/embedded-browser.cjs");
  return require(modulePath);
}

function entryForEvent(event) {
  const owner = BrowserWindow.fromWebContents(event.sender);
  return owner ? browserWindows.get(owner.id) : null;
}

function requireHost(event) {
  const host = entryForEvent(event)?.host;
  if (!host) throw new Error("gui-computer 窗口尚未就绪");
  return host;
}

function bridgeHost() {
  for (const entry of browserWindows.values()) {
    if (entry.host.activeRun) return entry.host;
  }
  return activeEntry?.host || browserWindows.values().next().value?.host || null;
}

function registerIpc() {
  if (ipcRegistered) return;
  ipcRegistered = true;
  ipcMain.handle("gui-computer:get-state", (event) => requireHost(event).getState());
  ipcMain.handle("gui-computer:set-bounds", (event, bounds) => requireHost(event).setBounds(bounds));
  ipcMain.handle("gui-computer:navigate", (event, url) => requireHost(event).navigate(url));
  ipcMain.handle("gui-computer:create-tab", (event, url) => requireHost(event).createTab(url));
  ipcMain.handle("gui-computer:activate-tab", (event, id) => requireHost(event).activateTab(id));
  ipcMain.handle("gui-computer:close-tab", (event, id) => requireHost(event).closeTab(id));
  ipcMain.handle("gui-computer:command", (event, command) => requireHost(event).browserCommand(command));
  ipcMain.handle("gui-computer:find", (event, query, forward) => requireHost(event).findInPage(query, forward));
  ipcMain.handle("gui-computer:stop-find", (event) => requireHost(event).stopFind());
  ipcMain.handle("gui-computer:open-downloads", (event) => requireHost(event).openDownloads());
  ipcMain.handle("gui-computer:toggle-bookmark", (event) => requireHost(event).toggleBookmark());
  ipcMain.handle("gui-computer:remove-bookmark", (event, id) => requireHost(event).removeBookmark(id));
  ipcMain.handle("gui-computer:clear-history", (event) => requireHost(event).clearHistory());
  ipcMain.handle("gui-computer:clear-cookies", (event) => requireHost(event).clearCookies());
  ipcMain.handle("gui-computer:set-zoom-factor", (event, factor) => requireHost(event).setZoomFactor(factor));
  ipcMain.handle("gui-computer:open-devtools", (event) => requireHost(event).openDevTools());
  ipcMain.handle("gui-computer:set-control-mode", (event, mode) => requireHost(event).setControlMode(mode));
  ipcMain.handle("gui-computer:new-window", async () => {
    const entry = await createWindow();
    return { windowId: entry.window.id };
  });
  ipcMain.handle("gui-computer:get-connection", () => ({
    protocolVersion: 1,
    bridgeUrl: bridge?.url,
    discoveryPath,
    cdpUrl: `http://127.0.0.1:${cdpPort}`,
  }));
}

function writeDiscovery() {
  discoveryPath = configuredDiscoveryFile
    ? path.resolve(configuredDiscoveryFile)
    : path.join(app.getPath("userData"), "control-bridge.json");
  fs.mkdirSync(path.dirname(discoveryPath), { recursive: true });
  fs.writeFileSync(discoveryPath, JSON.stringify({
    protocolVersion: 1,
    product: PRODUCT_NAME,
    pid: process.pid,
    bridgeUrl: bridge.url,
    bridgeToken: bridge.token,
    cdpUrl: `http://127.0.0.1:${cdpPort}`,
    startedAt: new Date().toISOString(),
  }, null, 2), { mode: 0o600 });
}

async function ensureBridge() {
  if (bridge) return;
  const { startEmbeddedBrowserBridge } = browserModule();
  bridge = await startEmbeddedBrowserBridge({ getHost: bridgeHost });
  writeDiscovery();
}

async function createWindow() {
  const previous = activeEntry?.window;
  const previousBounds = previous && !previous.isDestroyed() ? previous.getBounds() : null;
  const window = new BrowserWindow({
    x: previousBounds ? previousBounds.x + 28 : undefined,
    y: previousBounds ? previousBounds.y + 28 : undefined,
    width: 1320,
    height: 860,
    minWidth: 820,
    minHeight: 560,
    backgroundColor: "#eef1f1",
    title: PRODUCT_NAME,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  window.setMenuBarVisibility(false);
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });

  const { EmbeddedBrowserHost } = browserModule();
  const host = new EmbeddedBrowserHost(window, { cdpPort, kernel: "gui-computer" });
  const entry = { window, host };
  browserWindows.set(window.id, entry);
  activeEntry = entry;
  await ensureBridge();
  await window.loadFile(path.join(__dirname, "browser.html"));
  await host.initialize();
  host.setVisible(true);
  window.on("focus", () => { activeEntry = entry; });
  window.on("resize", () => window.webContents.send("gui-computer-resize"));
  window.on("closed", () => {
    host.destroy();
    browserWindows.delete(window.id);
    if (activeEntry === entry) activeEntry = Array.from(browserWindows.values()).at(-1) || null;
  });
  return entry;
}

app.whenReady().then(async () => {
  registerIpc();
  await createWindow();
});
app.on("second-instance", () => {
  const window = activeEntry?.window || browserWindows.values().next().value?.window;
  if (!window) return;
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
});
app.on("window-all-closed", () => app.quit());
app.on("before-quit", () => {
  try { if (discoveryPath) fs.rmSync(discoveryPath, { force: true }); } catch { /* ignore */ }
  try { bridge?.server.close(); } catch { /* ignore */ }
});
