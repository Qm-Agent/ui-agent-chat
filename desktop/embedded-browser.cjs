const { randomBytes, randomUUID } = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { WebContentsView, app, dialog, session, shell } = require("electron");
const { embeddedTabMarkerUrl } = require("./embedded-browser-url.cjs");

const PARTITION = "persist:gui-computer-browser";
const DEFAULT_BOUNDS = { x: 0, y: 0, width: 900, height: 700 };
const ALLOWED_PERMISSIONS = new Set(["media", "geolocation", "notifications", "clipboard-read"]);
const LIBRARY_VERSION = 1;
const HISTORY_LIMIT = 1000;
function clampBounds(bounds) {
  const finite = (value, fallback) => Number.isFinite(Number(value)) ? Math.round(Number(value)) : fallback;
  return {
    x: Math.max(0, finite(bounds?.x, DEFAULT_BOUNDS.x)),
    y: Math.max(0, finite(bounds?.y, DEFAULT_BOUNDS.y)),
    width: Math.max(320, finite(bounds?.width, DEFAULT_BOUNDS.width)),
    height: Math.max(240, finite(bounds?.height, DEFAULT_BOUNDS.height)),
  };
}

function clampViewBounds(bounds) {
  const finite = (value, fallback) => Number.isFinite(Number(value)) ? Math.round(Number(value)) : fallback;
  return {
    x: Math.max(0, finite(bounds?.x, 0)),
    y: Math.max(0, finite(bounds?.y, 0)),
    width: Math.max(1, finite(bounds?.width, 1)),
    height: Math.max(1, finite(bounds?.height, 1)),
  };
}

async function fetchJson(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(2000) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

class EmbeddedBrowserHost {
  constructor(window, options) {
    this.window = window;
    this.presentationWindow = null;
    this.presentationBounds = null;
    this.cdpPort = options.cdpPort;
    this.kernel = options.kernel || "uiwarden-embedded";
    this.tabs = new Map();
    this.activeTabId = null;
    this.bounds = DEFAULT_BOUNDS;
    this.visible = false;
    this.activeRun = null;
    this.downloads = [];
    this.downloadDirectory = path.join(app.getPath("downloads"), "gui-computer");
    this.libraryPath = path.join(app.getPath("userData"), "browser-library.json");
    this.library = this.loadLibrary();
    this.lastFindQuery = "";
    this.configurePermissions();
    this.configureDownloads();
  }

  loadLibrary() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.libraryPath, "utf8"));
      if (parsed?.version !== LIBRARY_VERSION) return { version: LIBRARY_VERSION, bookmarks: [], history: [] };
      return {
        version: LIBRARY_VERSION,
        bookmarks: Array.isArray(parsed.bookmarks) ? parsed.bookmarks.slice(0, HISTORY_LIMIT) : [],
        history: Array.isArray(parsed.history) ? parsed.history.slice(0, HISTORY_LIMIT) : [],
      };
    } catch {
      return { version: LIBRARY_VERSION, bookmarks: [], history: [] };
    }
  }

  saveLibrary() {
    fs.mkdirSync(path.dirname(this.libraryPath), { recursive: true });
    const temporaryPath = `${this.libraryPath}.${process.pid}.tmp`;
    fs.writeFileSync(temporaryPath, JSON.stringify(this.library, null, 2), { mode: 0o600 });
    fs.renameSync(temporaryPath, this.libraryPath);
  }

  recordHistory(tab) {
    const url = String(tab?.view.webContents.getURL() || tab?.url || "");
    if (!/^https?:\/\//i.test(url)) return;
    this.library = this.loadLibrary();
    const title = String(tab?.view.webContents.getTitle() || tab?.title || url);
    const previous = this.library.history[0];
    const entry = {
      id: previous?.url === url ? previous.id : randomUUID(),
      url,
      title,
      visitedAt: new Date().toISOString(),
    };
    this.library.history = previous?.url === url
      ? [entry, ...this.library.history.slice(1)]
      : [entry, ...this.library.history].slice(0, HISTORY_LIMIT);
    this.saveLibrary();
  }

  configurePermissions() {
    const targetSession = session.fromPartition(PARTITION);
    targetSession.setPermissionRequestHandler((_contents, permission, callback, details) => {
      // Map/navigation tasks request location frequently. gui-computer is
      // a user-visible local browser, so geolocation follows the user's
      // explicit product preference and does not interrupt every agent turn.
      if (permission === "geolocation") {
        callback(true);
        return;
      }
      if (!ALLOWED_PERMISSIONS.has(permission)) {
        callback(false);
        return;
      }
      const origin = details.requestingUrl || "当前页面";
      void dialog.showMessageBox(this.window, {
        type: "question",
        buttons: ["拒绝", "允许"],
        defaultId: 0,
        cancelId: 0,
        title: "网页权限请求",
        message: `是否允许 ${origin} 使用 ${permission}？`,
        detail: "该权限只授予当前 gui-computer 目标网页。",
      }).then((result) => callback(result.response === 1));
    });
  }

  configureDownloads() {
    fs.mkdirSync(this.downloadDirectory, { recursive: true });
    this.downloadHandler = (_event, item, sourceContents) => {
      const belongsToHost = [...this.tabs.values()]
        .some((tab) => tab.view.webContents.id === sourceContents?.id);
      if (!belongsToHost) return;
      const id = randomUUID();
      const originalName = path.basename(item.getFilename() || `download-${Date.now()}`);
      const parsed = path.parse(originalName);
      let savePath = path.join(this.downloadDirectory, originalName);
      if (fs.existsSync(savePath)) {
        savePath = path.join(this.downloadDirectory, `${parsed.name}-${Date.now()}${parsed.ext}`);
      }
      item.setSavePath(savePath);
      const record = {
        id,
        filename: path.basename(savePath),
        path: savePath,
        status: "progressing",
        receivedBytes: 0,
        totalBytes: item.getTotalBytes(),
      };
      this.downloads = [record, ...this.downloads].slice(0, 20);
      const update = () => {
        record.receivedBytes = item.getReceivedBytes();
        record.totalBytes = item.getTotalBytes();
        this.emitState();
      };
      item.on("updated", update);
      item.once("done", (_doneEvent, state) => {
        record.status = state;
        update();
      });
      this.emitState();
    };
    session.fromPartition(PARTITION).on("will-download", this.downloadHandler);
  }

  async initialize() {
    if (!this.activeTabId) await this.createTab("about:blank");
    return this.getState();
  }

  get activeTab() {
    return this.activeTabId ? this.tabs.get(this.activeTabId) || null : null;
  }

  getState() {
    const activeContents = this.activeTab?.view.webContents;
    return {
      available: true,
      windowId: this.window.id,
      visible: this.visible,
      presentationMode: this.presentationWindow ? "picture-in-picture" : "inline",
      activeTabId: this.activeTabId,
      cdpUrl: `http://127.0.0.1:${this.cdpPort}`,
      controlMode: this.activeRun?.controlMode || "idle",
      activeRunId: this.activeRun?.runId,
      controlledTargetId: this.activeRun?.targetId,
      bounds: this.bounds,
      downloadDirectory: this.downloadDirectory,
      downloads: this.downloads,
      bookmarks: this.library.bookmarks,
      history: this.library.history,
      activeBookmarked: Boolean(this.activeTab?.url && this.library.bookmarks.some((item) => item.url === this.activeTab.url)),
      zoomFactor: activeContents && !activeContents.isDestroyed() ? activeContents.getZoomFactor() : 1,
      tabs: [...this.tabs.values()].map((tab) => ({
        id: tab.id,
        targetId: tab.targetId,
        title: tab.title || "新标签页",
        url: tab.url || "about:blank",
        loading: tab.loading,
        crashed: tab.crashed,
        canGoBack: !tab.view.webContents.isDestroyed() && tab.view.webContents.navigationHistory.canGoBack(),
        canGoForward: !tab.view.webContents.isDestroyed() && tab.view.webContents.navigationHistory.canGoForward(),
      })),
    };
  }

  async capturePreview() {
    const tab = this.activeTab;
    const capturedAt = new Date().toISOString();
    if (!tab || tab.view.webContents.isDestroyed()) {
      return { dataUrl: "", capturedAt, targetId: tab?.targetId || "" };
    }
    try {
      const image = await tab.view.webContents.capturePage();
      const sourceSize = image.getSize();
      if (sourceSize.width < 1 || sourceSize.height < 1) {
        return { dataUrl: "", capturedAt, targetId: tab.targetId || "" };
      }
      const preview = sourceSize.width > 960
        ? image.resize({
          width: 960,
          height: Math.max(1, Math.round(sourceSize.height * (960 / sourceSize.width))),
          quality: "good",
        })
        : image;
      const size = preview.getSize();
      return {
        dataUrl: preview.toDataURL(),
        capturedAt,
        targetId: tab.targetId || "",
        width: size.width,
        height: size.height,
      };
    } catch {
      return { dataUrl: "", capturedAt, targetId: tab.targetId || "" };
    }
  }

  emitState() {
    if (!this.window.isDestroyed()) {
      this.window.webContents.send("gui-computer:browser-state", this.getState());
    }
    if (this.presentationWindow && !this.presentationWindow.isDestroyed()) {
      this.presentationWindow.webContents.send("gui-computer:browser-state", this.getState());
    }
  }

  attachActiveView() {
    for (const tab of this.tabs.values()) {
      for (const hostWindow of [this.window, this.presentationWindow]) {
        if (!hostWindow || hostWindow.isDestroyed()) continue;
        try {
          hostWindow.contentView.removeChildView(tab.view);
        } catch {
          // A detached view is expected when switching tabs or changing surfaces.
        }
      }
    }
    const tab = this.activeTab;
    const hostWindow = this.presentationWindow && !this.presentationWindow.isDestroyed()
      ? this.presentationWindow
      : this.window;
    const visible = Boolean(this.presentationWindow) || this.visible;
    if (!visible || !tab || tab.view.webContents.isDestroyed()) {
      this.window.webContents.invalidate?.();
      return;
    }
    hostWindow.contentView.addChildView(tab.view);
    tab.view.setBounds(this.presentationWindow ? this.presentationBounds : this.bounds);
  }

  async resolveTargetId(markerUrl) {
    const endpoint = `http://127.0.0.1:${this.cdpPort}/json/list`;
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      try {
        const targets = await fetchJson(endpoint);
        const target = Array.isArray(targets)
          ? targets.find((item) => item.type === "page" && item.url === markerUrl)
          : null;
        if (target?.id) return String(target.id);
      } catch {
        // Chromium may still be starting its DevTools endpoint.
      }
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    throw new Error("gui-computer CDP target 8 秒内未就绪");
  }

  async createTab(initialUrl = "about:blank", options = {}) {
    const activate = options.activate !== false;
    if (activate && this.activeRun?.controlMode === "agent-control") {
      throw new Error("任务执行中新建目标标签页前，请先点击暂停/接管");
    }
    const id = randomUUID();
    // Electron 38 rejects `loadURL("about:blank#fragment")` with ERR_FAILED.
    // A minimal data document keeps target mapping unique without a network request.
    const markerUrl = embeddedTabMarkerUrl(id);
    const view = new WebContentsView({
      webPreferences: {
        partition: PARTITION,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
      },
    });
    // A detached WebContentsView otherwise starts with a 0x0 viewport. Agent
    // startup can race React's bounds IPC, causing Page.captureScreenshot to
    // fail before the browser pane becomes visible.
    view.setBounds(this.bounds);
    const tab = {
      id,
      view,
      targetId: undefined,
      title: "新标签页",
      url: markerUrl,
      loading: true,
      crashed: false,
    };
    this.tabs.set(id, tab);
    if (activate) this.activeTabId = id;
    this.bindTab(tab);
    if (activate) this.attachActiveView();
    await view.webContents.loadURL(markerUrl);
    tab.targetId = await this.resolveTargetId(markerUrl);
    if (initialUrl !== markerUrl) await this.navigate(initialUrl, id);
    if (activate && this.activeRun?.controlMode === "human-control") {
      this.activeRun.targetId = tab.targetId;
      this.activeRun.pageUrl = tab.view.webContents.getURL() || tab.url;
    }
    this.emitState();
    return { ...this.getState(), createdTabId: id };
  }

  bindTab(tab) {
    const contents = tab.view.webContents;
    const update = () => {
      tab.url = contents.getURL() || tab.url;
      tab.title = contents.getTitle() || tab.title;
      tab.loading = contents.isLoading();
      this.emitState();
    };
    contents.on("did-start-loading", update);
    contents.on("did-stop-loading", () => {
      update();
      this.recordHistory(tab);
      this.emitState();
    });
    contents.on("did-finish-load", () => {
      tab.crashed = false;
      update();
    });
    contents.on("did-navigate", update);
    contents.on("did-navigate-in-page", () => {
      update();
      this.recordHistory(tab);
      this.emitState();
    });
    contents.on("page-title-updated", update);
    contents.on("before-input-event", (event, input) => {
      const opensDevTools = input.type === "keyDown"
        && (input.key === "F12" || (input.key.toLowerCase() === "i" && input.meta && input.alt));
      if (!opensDevTools) return;
      event.preventDefault();
      void this.openDevTools();
    });
    contents.on("render-process-gone", () => {
      tab.crashed = true;
      tab.loading = false;
      this.emitState();
    });
    contents.setWindowOpenHandler(({ url }) => {
      void this.createTab(url, { activate: this.activeRun?.controlMode !== "agent-control" });
      return { action: "deny" };
    });
  }

  setVisible(visible) {
    this.visible = Boolean(visible);
    this.attachActiveView();
    this.emitState();
    return this.getState();
  }

  setBounds(bounds) {
    const requested = clampBounds(bounds);
    const content = this.window.getContentBounds();
    const minimumWidth = Math.min(320, Math.max(1, content.width));
    const minimumHeight = Math.min(240, Math.max(1, content.height));
    const x = Math.min(requested.x, Math.max(0, content.width - minimumWidth));
    const y = Math.min(requested.y, Math.max(0, content.height - minimumHeight));
    this.bounds = {
      x,
      y,
      width: Math.max(minimumWidth, Math.min(requested.width, content.width - x)),
      height: Math.max(minimumHeight, Math.min(requested.height, content.height - y)),
    };
    if (this.visible && this.activeTab) this.activeTab.view.setBounds(this.bounds);
    return this.getState();
  }

  setPresentationWindow(window, bounds) {
    if (!window || window.isDestroyed()) throw new Error("画中画窗口不可用");
    this.presentationWindow = window;
    this.presentationBounds = clampViewBounds(bounds);
    this.attachActiveView();
    this.emitState();
    return this.getState();
  }

  updatePresentationBounds(window, bounds) {
    if (this.presentationWindow !== window || window.isDestroyed()) return this.getState();
    this.presentationBounds = clampViewBounds(bounds);
    if (this.activeTab && !this.activeTab.view.webContents.isDestroyed()) {
      this.activeTab.view.setBounds(this.presentationBounds);
    }
    return this.getState();
  }

  clearPresentationWindow(window) {
    if (!this.presentationWindow || (window && this.presentationWindow !== window)) return this.getState();
    const previous = this.presentationWindow;
    this.presentationWindow = null;
    this.presentationBounds = null;
    if (previous && !previous.isDestroyed() && this.activeTab) {
      try {
        previous.contentView.removeChildView(this.activeTab.view);
      } catch {
        // The view may already have been detached while closing the PiP window.
      }
    }
    this.attachActiveView();
    this.emitState();
    return this.getState();
  }

  setZoomFactor(value) {
    const contents = this.activeTab?.view.webContents;
    if (!contents || contents.isDestroyed()) throw new Error("gui-computer未就绪");
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) throw new Error("无效的浏览器缩放比例");
    const factor = Math.min(2, Math.max(0.5, Math.round(numeric * 10) / 10));
    if (this.activeRun?.controlMode === "agent-control") this.activeRun.controlMode = "human-control";
    contents.setZoomFactor(factor);
    this.emitState();
    return this.getState();
  }

  async navigate(rawUrl, tabId = this.activeTabId) {
    const tab = tabId ? this.tabs.get(tabId) : null;
    if (!tab) throw new Error("没有可导航的gui-computer标签页");
    const input = String(rawUrl || "").trim();
    const url = !input
      ? "about:blank"
      : /^(https?|file|about|data):/i.test(input)
        ? input
        : `https://${input}`;
    await tab.view.webContents.loadURL(url);
    return this.getState();
  }

  activateTab(tabId) {
    if (!this.tabs.has(tabId)) throw new Error("gui-computer标签页不存在");
    const tab = this.tabs.get(tabId);
    if (this.activeRun && this.activeRun.targetId !== tab.targetId) {
      if (this.activeRun.controlMode !== "human-control") {
        throw new Error("任务执行中切换目标标签页前，请先点击暂停/接管");
      }
      this.activeRun.targetId = tab.targetId;
      this.activeRun.pageUrl = tab.view.webContents.getURL() || tab.url;
    }
    this.activeTabId = tabId;
    this.attachActiveView();
    this.emitState();
    return this.getState();
  }

  closeTab(tabId) {
    const tab = this.tabs.get(tabId);
    if (!tab) return this.getState();
    if (this.activeRun?.targetId === tab.targetId) {
      throw new Error("当前受控标签页不能关闭；请先停止任务或切换到人工控制后选择其他标签页");
    }
    for (const hostWindow of [this.window, this.presentationWindow]) {
      if (!hostWindow || hostWindow.isDestroyed()) continue;
      try {
        hostWindow.contentView.removeChildView(tab.view);
      } catch {
        // ignore
      }
    }
    if (!tab.view.webContents.isDestroyed()) tab.view.webContents.close();
    this.tabs.delete(tabId);
    if (this.activeTabId === tabId) this.activeTabId = this.tabs.keys().next().value || null;
    if (!this.activeTabId) void this.createTab("about:blank");
    else this.attachActiveView();
    this.emitState();
    return this.getState();
  }

  browserCommand(command) {
    const contents = this.activeTab?.view.webContents;
    if (!contents) throw new Error("gui-computer未就绪");
    if (command === "back" && contents.navigationHistory.canGoBack()) contents.navigationHistory.goBack();
    if (command === "forward" && contents.navigationHistory.canGoForward()) contents.navigationHistory.goForward();
    if (command === "reload") {
      if (this.activeTab) this.activeTab.crashed = false;
      contents.reload();
    }
    return this.getState();
  }

  findInPage(query, forward = true) {
    const contents = this.activeTab?.view.webContents;
    if (!contents) throw new Error("gui-computer未就绪");
    const normalized = String(query || "").trim();
    if (!normalized) {
      contents.stopFindInPage("clearSelection");
      this.lastFindQuery = "";
      return this.getState();
    }
    contents.findInPage(normalized, { forward: Boolean(forward), findNext: this.lastFindQuery === normalized });
    this.lastFindQuery = normalized;
    return this.getState();
  }

  stopFind() {
    const contents = this.activeTab?.view.webContents;
    if (contents) contents.stopFindInPage("clearSelection");
    this.lastFindQuery = "";
    return this.getState();
  }

  async openDownloads() {
    fs.mkdirSync(this.downloadDirectory, { recursive: true });
    const error = await shell.openPath(this.downloadDirectory);
    if (error) throw new Error(error);
    return this.getState();
  }

  toggleBookmark() {
    const tab = this.activeTab;
    const url = String(tab?.view.webContents.getURL() || tab?.url || "");
    if (!/^https?:\/\//i.test(url)) throw new Error("当前页面不能加入书签");
    this.library = this.loadLibrary();
    const existingIndex = this.library.bookmarks.findIndex((item) => item.url === url);
    if (existingIndex >= 0) {
      this.library.bookmarks.splice(existingIndex, 1);
    } else {
      this.library.bookmarks.unshift({
        id: randomUUID(),
        url,
        title: String(tab.view.webContents.getTitle() || tab.title || url),
        createdAt: new Date().toISOString(),
      });
    }
    this.saveLibrary();
    this.emitState();
    return this.getState();
  }

  removeBookmark(id) {
    this.library = this.loadLibrary();
    this.library.bookmarks = this.library.bookmarks.filter((item) => item.id !== id);
    this.saveLibrary();
    this.emitState();
    return this.getState();
  }

  clearHistory() {
    this.library = this.loadLibrary();
    this.library.history = [];
    this.saveLibrary();
    this.emitState();
    return this.getState();
  }

  async clearCookies() {
    await session.fromPartition(PARTITION).clearStorageData({ storages: ["cookies"] });
    for (const tab of this.tabs.values()) {
      if (!tab.view.webContents.isDestroyed()) tab.view.webContents.reload();
    }
    this.emitState();
    return this.getState();
  }

  openDevTools() {
    const contents = this.activeTab?.view.webContents;
    if (!contents) throw new Error("gui-computer未就绪");
    // DevTools is an explicit human takeover. Keep CDP attached for recording,
    // but stop the agent before the user changes DOM, storage, or requests.
    if (this.activeRun?.controlMode === "agent-control") {
      this.activeRun.controlMode = "human-control";
    }
    contents.openDevTools({ mode: "detach", activate: true });
    this.emitState();
    return this.getState();
  }

  async resolveBrowserCdpUrl() {
    const version = await fetchJson(`http://127.0.0.1:${this.cdpPort}/json/version`);
    const websocketUrl = String(version?.webSocketDebuggerUrl || "");
    if (!websocketUrl.startsWith(`ws://127.0.0.1:${this.cdpPort}/devtools/browser/`)) {
      throw new Error("gui-computer CDP WebSocket 地址无效");
    }
    return `http://127.0.0.1:${this.cdpPort}`;
  }

  async startRun(sessionId) {
    const tab = this.activeTab;
    if (!sessionId) throw new Error("sessionId 不能为空");
    if (!tab?.targetId) throw new Error("gui-computer target 尚未就绪");
    if (this.activeRun && this.activeRun.sessionId !== sessionId) {
      throw new Error("另一个会话正在使用gui-computer");
    }
    if (this.presentationWindow && !this.presentationWindow.isDestroyed()) {
      this.presentationWindow.showInactive();
    } else {
      if (this.window?.isMinimized()) this.window.restore();
      this.window?.show();
      this.window?.focus();
    }
    this.visible = true;
    this.attachActiveView();
    this.activeRun = {
      runId: this.activeRun?.runId || randomUUID(),
      sessionId,
      targetId: tab.targetId,
      pageUrl: tab.view.webContents.getURL() || tab.url,
      cdpUrl: await this.resolveBrowserCdpUrl(),
      controlMode: "agent-control",
      startedAt: new Date().toISOString(),
    };
    this.emitState();
    return this.executionSession();
  }

  executionSession() {
    if (!this.activeRun) throw new Error("gui-computer当前没有执行任务");
    return {
      version: 1,
      kernel: this.kernel,
      runId: this.activeRun.runId,
      sessionId: this.activeRun.sessionId,
      cdpUrl: this.activeRun.cdpUrl,
      targetId: this.activeRun.targetId,
      pageUrl: this.activeRun.pageUrl,
      controlMode: this.activeRun.controlMode,
      startedAt: this.activeRun.startedAt,
    };
  }

  setControlMode(mode) {
    if (!this.activeRun) throw new Error("没有运行中的gui-computer任务");
    if (mode !== "agent-control" && mode !== "human-control") throw new Error("无效控制模式");
    this.activeRun.controlMode = mode;
    this.emitState();
    return this.executionSession();
  }

  stopRun(reason = "completed") {
    const completed = this.activeRun ? { ...this.executionSession(), stopReason: reason } : null;
    this.activeRun = null;
    this.emitState();
    return completed;
  }

  destroy() {
    this.clearPresentationWindow();
    if (this.downloadHandler) {
      session.fromPartition(PARTITION).removeListener("will-download", this.downloadHandler);
      this.downloadHandler = null;
    }
    for (const tab of this.tabs.values()) {
      if (!tab.view.webContents.isDestroyed()) tab.view.webContents.close();
    }
    this.tabs.clear();
  }
}

function sendJson(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

async function readBody(req) {
  let body = "";
  for await (const chunk of req) body += chunk;
  return body ? JSON.parse(body) : {};
}

function startEmbeddedBrowserBridge(options) {
  const token = randomBytes(32).toString("hex");
  const server = http.createServer((req, res) => {
    void (async () => {
      try {
        if (req.headers.authorization !== `Bearer ${token}`) {
          sendJson(res, 401, { error: "Unauthorized" });
          return;
        }
        const host = options.getHost();
        if (!host) {
          sendJson(res, 503, { error: "gui-computer窗口尚未就绪" });
          return;
        }
        const url = new URL(req.url || "/", "http://127.0.0.1");
        if (req.method === "GET" && url.pathname === "/v1/browser/status") {
          sendJson(res, 200, host.getState());
          return;
        }
        if (req.method === "POST" && url.pathname === "/v1/browser/navigate") {
          const body = await readBody(req);
          sendJson(res, 200, await host.navigate(String(body.url || "")));
          return;
        }
        if (req.method === "POST" && url.pathname === "/v1/browser/runs") {
          const body = await readBody(req);
          sendJson(res, 200, await host.startRun(String(body.sessionId || "")));
          return;
        }
        const runMatch = url.pathname.match(/^\/v1\/browser\/runs\/([^/]+)$/);
        if (runMatch && req.method === "GET") {
          const run = host.executionSession();
          sendJson(res, run.runId === runMatch[1] ? 200 : 404, run.runId === runMatch[1] ? run : { error: "run 不存在" });
          return;
        }
        const controlMatch = url.pathname.match(/^\/v1\/browser\/runs\/([^/]+)\/control$/);
        if (controlMatch && req.method === "POST") {
          const body = await readBody(req);
          const run = host.executionSession();
          if (run.runId !== controlMatch[1]) throw new Error("run 不存在");
          sendJson(res, 200, host.setControlMode(body.mode));
          return;
        }
        if (runMatch && req.method === "DELETE") {
          const body = await readBody(req);
          sendJson(res, 200, host.stopRun(String(body.reason || "completed")) || {});
          return;
        }
        sendJson(res, 404, { error: "Not found" });
      } catch (error) {
        sendJson(res, 400, { error: String(error?.message || error) });
      }
    })();
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve({ server, token, url: `http://127.0.0.1:${address.port}` });
    });
  });
}

module.exports = { EmbeddedBrowserHost, embeddedTabMarkerUrl, startEmbeddedBrowserBridge };
