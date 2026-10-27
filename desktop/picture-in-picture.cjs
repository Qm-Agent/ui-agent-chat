const fs = require("node:fs");
const path = require("node:path");
const { NativeWindowStream, normalizeNativeStreamTarget } = require("./native-window-stream.cjs");

const DEFAULT_WIDTH = 340;
const DEFAULT_HEIGHT = 220;
const MIN_WIDTH = 260;
const MIN_HEIGHT = 170;
const TOOLBAR_HEIGHT = 34;
const BOUNDS_SCHEMA_VERSION = 2;

function finiteInteger(value, fallback) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.round(numeric) : fallback;
}

function validSnapshotUrl(value, allowedOrigins = []) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  if (/^data:image\/(?:png|jpe?g|webp);base64,/i.test(raw)) return raw;
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== "http:") return "";
    if (parsed.hostname !== "127.0.0.1" && parsed.hostname !== "localhost") return "";
    if (allowedOrigins.length > 0 && !allowedOrigins.includes(parsed.origin)) return "";
    return parsed.toString();
  } catch {
    return "";
  }
}

function normalizeSource(value) {
  if (value === "embedded-browser" || value === "native-stream") return value;
  return "snapshot";
}

function validLocalApiUrl(value, allowedOrigins, suffix) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== "http:") return "";
    if (parsed.hostname !== "127.0.0.1" && parsed.hostname !== "localhost") return "";
    if (!allowedOrigins.includes(parsed.origin)) return "";
    if (!parsed.pathname.endsWith(suffix)) return "";
    return parsed.toString();
  } catch {
    return "";
  }
}

function normalizeNativeInteraction(value, allowedOrigins) {
  if (!value || typeof value !== "object") return null;
  const clickUrl = validLocalApiUrl(value.clickUrl, allowedOrigins, "/native/pip-click");
  const controlUrl = validLocalApiUrl(value.controlUrl, allowedOrigins, "/native/control");
  return clickUrl && controlUrl ? { clickUrl, controlUrl } : null;
}

class PictureInPictureController {
  constructor(options) {
    this.BrowserWindow = options.BrowserWindow;
    this.app = options.app;
    this.screen = options.screen;
    this.mainWindow = options.mainWindow;
    this.getEmbeddedBrowserHost = options.getEmbeddedBrowserHost;
    this.keepApplicationVisible = options.keepApplicationVisible || (() => undefined);
    this.preloadPath = options.preloadPath;
    this.htmlPath = options.htmlPath;
    this.allowedSnapshotOrigins = [...new Set(
      (options.allowedSnapshotOrigins || [])
        .map((value) => {
          try {
            return new URL(String(value)).origin;
          } catch {
            return "";
          }
        })
        .filter(Boolean)
    )];
    this.window = null;
    this.windowReadyPromise = null;
    this.openSequence = 0;
    this.persistTimer = null;
    this.nativeInteraction = null;
    this.nativeWindowStream = new NativeWindowStream({
      providerAppPath: options.nativeProviderAppPath || "",
      onFrame: (frame) => this.emitNativeFrame(frame),
      onStatus: (status) => {
        if (this.state.source !== "native-stream") return;
        this.state = {
          ...this.state,
          streamStatus: status.status,
          streamError: String(status.error || "").slice(0, 300),
        };
        this.emitState();
      },
    });
    this.windowStatePath = path.join(this.app.getPath("userData"), "picture-in-picture-window.json");
    this.state = {
      available: true,
      open: false,
      closeReason: "",
      source: "snapshot",
      interactive: false,
      title: "UI 操作",
      subtitle: "等待执行画面",
      status: "idle",
      snapshotUrl: "",
      placeholder: "等待执行画面",
      streamStatus: "idle",
      streamError: "",
      streamFps: 0,
      streamConfiguredFps: 0,
      interactionEnabled: false,
      nativeTarget: null,
      bounds: this.initialBounds(),
    };
  }

  initialBounds() {
    const saved = this.readSavedBounds();
    const display = saved
      ? this.screen.getDisplayMatching(saved)
      : this.screen.getDisplayNearestPoint(this.screen.getCursorScreenPoint());
    const fallback = {
      x: display.workArea.x + display.workArea.width - DEFAULT_WIDTH - 20,
      y: display.workArea.y + 20,
      width: DEFAULT_WIDTH,
      height: DEFAULT_HEIGHT,
    };
    return this.clampBounds(saved || fallback, display.workArea);
  }

  readSavedBounds() {
    try {
      const value = JSON.parse(fs.readFileSync(this.windowStatePath, "utf8"));
      if (!value || typeof value !== "object" || value.version !== BOUNDS_SCHEMA_VERSION) return null;
      return {
        x: finiteInteger(value.x, 0),
        y: finiteInteger(value.y, 0),
        width: finiteInteger(value.width, DEFAULT_WIDTH),
        height: finiteInteger(value.height, DEFAULT_HEIGHT),
      };
    } catch {
      return null;
    }
  }

  clampBounds(bounds, workArea = this.screen.getDisplayMatching(bounds).workArea) {
    const width = Math.min(
      Math.max(MIN_WIDTH, finiteInteger(bounds.width, DEFAULT_WIDTH)),
      workArea.width
    );
    const height = Math.min(
      Math.max(MIN_HEIGHT, finiteInteger(bounds.height, DEFAULT_HEIGHT)),
      workArea.height
    );
    return {
      x: Math.min(
        Math.max(workArea.x, finiteInteger(bounds.x, workArea.x)),
        workArea.x + workArea.width - width
      ),
      y: Math.min(
        Math.max(workArea.y, finiteInteger(bounds.y, workArea.y)),
        workArea.y + workArea.height - height
      ),
      width,
      height,
    };
  }

  getState() {
    return { ...this.state, bounds: { ...this.state.bounds } };
  }

  async open(input = {}) {
    const openSequence = ++this.openSequence;
    const nextSource = normalizeSource(input.source);
    const requestedSnapshot = input.snapshotUrl == null
      ? this.state.snapshotUrl
      : validSnapshotUrl(input.snapshotUrl, this.allowedSnapshotOrigins);
    if (input.snapshotUrl && !requestedSnapshot) throw new Error("画中画截图地址无效");
    const hasNativeTarget = Object.prototype.hasOwnProperty.call(input, "nativeTarget");
    const hasNativeInteraction = Object.prototype.hasOwnProperty.call(input, "nativeInteraction");
    const nativeTarget = hasNativeTarget
      ? normalizeNativeStreamTarget(input.nativeTarget)
      : this.state.nativeTarget;
    const nativeInteraction = hasNativeInteraction
      ? normalizeNativeInteraction(input.nativeInteraction, this.allowedSnapshotOrigins)
      : this.nativeInteraction;
    if (nextSource === "native-stream" && input.nativeInteraction && !nativeInteraction) {
      throw new Error("原生画中画控制地址无效");
    }
    const previousState = this.state;
    const previousNativeInteraction = this.nativeInteraction;
    if (
      this.state.interactionEnabled
      && (
        nextSource !== "native-stream"
        || previousNativeInteraction?.controlUrl !== nativeInteraction?.controlUrl
      )
    ) {
      this.resumeNativeInteraction(previousNativeInteraction);
    }
    this.nativeInteraction = nativeInteraction;
    this.state = {
      ...this.state,
      open: true,
      closeReason: "",
      source: nextSource,
      interactive: nextSource === "embedded-browser"
        || (nextSource === "native-stream" && Boolean(nativeInteraction)),
      interactionEnabled: nextSource === "embedded-browser",
      title: String(input.title || this.state.title || "UI 操作").slice(0, 80),
      subtitle: String(input.subtitle || this.state.subtitle || "").slice(0, 160),
      status: String(input.status || this.state.status || "idle").slice(0, 32),
      snapshotUrl: requestedSnapshot,
      placeholder: String(input.placeholder || this.state.placeholder || "等待执行画面").slice(0, 160),
      nativeTarget,
      streamStatus: nextSource === "native-stream" ? "starting" : "idle",
      streamError: "",
    };
    try {
      this.ensureMainWindowVisible();
      const pipWindow = await this.ensureWindow();
      if (
        openSequence !== this.openSequence
        || !this.state.open
        || this.window !== pipWindow
        || !this.isWindowUsable(pipWindow)
      ) {
        return this.getState();
      }
      this.attachSurface();
      if (!this.isWindowUsable(pipWindow)) return this.getState();
      try {
        this.keepApplicationVisible();
        this.ensureMainWindowVisible();
        pipWindow.showInactive();
        // Reparenting a WebContentsView can leave a still-visible macOS window
        // occluded. Raise it without focus; the always-on-top PiP remains above it.
        this.mainWindow.showInactive?.();
        this.keepApplicationVisible();
      } catch (error) {
        if (!this.isWindowUsable(pipWindow) || openSequence !== this.openSequence) {
          return this.getState();
        }
        throw error;
      }
      this.emitState();
      return this.getState();
    } catch (error) {
      if (openSequence !== this.openSequence) return this.getState();
      this.state = previousState;
      this.nativeInteraction = previousNativeInteraction;
      if (previousState.open) {
        try {
          this.attachSurface();
        } catch {
          // Preserve the original error while restoring as much prior state as possible.
        }
      } else if (this.window && !this.window.isDestroyed()) {
        this.window.close();
      }
      this.emitState();
      throw error;
    }
  }

  update(input = {}) {
    const requestedSnapshot = input.snapshotUrl == null
      ? this.state.snapshotUrl
      : validSnapshotUrl(input.snapshotUrl, this.allowedSnapshotOrigins);
    if (input.snapshotUrl && !requestedSnapshot) throw new Error("画中画截图地址无效");
    const previousState = this.state;
    const previousNativeInteraction = this.nativeInteraction;
    const previousSource = this.state.source;
    const previousTarget = JSON.stringify(this.state.nativeTarget);
    if (Object.prototype.hasOwnProperty.call(input, "nativeInteraction")) {
      const interaction = normalizeNativeInteraction(input.nativeInteraction, this.allowedSnapshotOrigins);
      if (input.nativeInteraction && !interaction) throw new Error("原生画中画控制地址无效");
      this.nativeInteraction = interaction;
    }
    const nextSource = input.source == null ? this.state.source : normalizeSource(input.source);
    if (
      this.state.interactionEnabled
      && (
        nextSource !== "native-stream"
        || previousNativeInteraction?.controlUrl !== this.nativeInteraction?.controlUrl
      )
    ) {
      this.resumeNativeInteraction(previousNativeInteraction);
    }
    this.state = {
      ...this.state,
      source: nextSource,
      title: input.title == null ? this.state.title : String(input.title).slice(0, 80),
      subtitle: input.subtitle == null ? this.state.subtitle : String(input.subtitle).slice(0, 160),
      status: input.status == null ? this.state.status : String(input.status).slice(0, 32),
      snapshotUrl: requestedSnapshot,
      placeholder: input.placeholder == null
        ? this.state.placeholder
        : String(input.placeholder || "等待执行画面").slice(0, 160),
      nativeTarget: Object.prototype.hasOwnProperty.call(input, "nativeTarget")
        ? normalizeNativeStreamTarget(input.nativeTarget)
        : this.state.nativeTarget,
    };
    this.state.interactive = this.state.source === "embedded-browser"
      || (this.state.source === "native-stream" && Boolean(this.nativeInteraction));
    if (this.state.source !== "native-stream") {
      this.state.interactionEnabled = this.state.source === "embedded-browser";
    } else if (previousSource !== "native-stream" || !this.nativeInteraction) {
      this.state.interactionEnabled = false;
    }
    try {
      if (this.window) {
        if (
          previousSource !== this.state.source
          || previousTarget !== JSON.stringify(this.state.nativeTarget)
        ) this.attachSurface();
        else this.applyMousePolicy();
      }
      this.emitState();
      return this.getState();
    } catch (error) {
      this.state = previousState;
      this.nativeInteraction = previousNativeInteraction;
      try {
        this.attachSurface();
      } catch {
        // Preserve the original error while restoring as much prior state as possible.
      }
      this.emitState();
      throw error;
    }
  }

  async ensureWindow() {
    if (this.isWindowUsable(this.window)) {
      if (this.windowReadyPromise) await this.windowReadyPromise;
      return this.window;
    }
    const bounds = this.clampBounds(this.state.bounds);
    const pipWindow = new this.BrowserWindow({
      ...bounds,
      minWidth: MIN_WIDTH,
      minHeight: MIN_HEIGHT,
      title: "UIWarden 画中画",
      frame: false,
      roundedCorners: true,
      hasShadow: true,
      resizable: true,
      fullscreenable: false,
      minimizable: false,
      maximizable: false,
      alwaysOnTop: true,
      skipTaskbar: process.platform !== "darwin",
      show: false,
      backgroundColor: "#f7f9fb",
      webPreferences: {
        preload: this.preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    this.window = pipWindow;
    this.keepApplicationVisible();
    pipWindow.setAlwaysOnTop(true, "floating");
    if (process.platform === "darwin") {
      pipWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    }
    pipWindow.on("resize", () => {
      this.updateBrowserBounds();
      this.schedulePersistBounds();
    });
    pipWindow.on("move", () => this.schedulePersistBounds());
    pipWindow.on("closed", () => {
      this.getEmbeddedBrowserHost()?.clearPresentationWindow(pipWindow);
      if (this.window !== pipWindow) return;
      const shouldResumeNativeControl = this.state.interactionEnabled;
      const nativeInteraction = this.nativeInteraction;
      this.openSequence += 1;
      this.window = null;
      this.windowReadyPromise = null;
      this.nativeWindowStream.stop();
      if (shouldResumeNativeControl) this.resumeNativeInteraction(nativeInteraction);
      this.state = {
        ...this.state,
        open: false,
        interactive: false,
        interactionEnabled: false,
        closeReason: this.state.closeReason || "user",
      };
      this.emitState();
    });
    pipWindow.webContents.on("did-finish-load", () => this.emitState());
    pipWindow.webContents.on("will-navigate", (event) => event.preventDefault());
    pipWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    const readyPromise = pipWindow.loadFile(this.htmlPath);
    this.windowReadyPromise = readyPromise;
    try {
      await readyPromise;
    } finally {
      if (this.windowReadyPromise === readyPromise) this.windowReadyPromise = null;
    }
    return pipWindow;
  }

  isWindowUsable(window) {
    if (!window || window.isDestroyed()) return false;
    return typeof window.webContents?.isDestroyed !== "function"
      || !window.webContents.isDestroyed();
  }

  isMainWindowVisible() {
    if (!this.isWindowUsable(this.mainWindow)) return false;
    if (typeof this.mainWindow.isMinimized === "function" && this.mainWindow.isMinimized()) return false;
    return typeof this.mainWindow.isVisible !== "function" || this.mainWindow.isVisible();
  }

  ensureMainWindowVisible() {
    if (!this.isWindowUsable(this.mainWindow)) return;
    this.keepApplicationVisible();
    if (typeof this.mainWindow.isMinimized === "function" && this.mainWindow.isMinimized()) {
      this.mainWindow.restore?.();
    }
    if (typeof this.mainWindow.isVisible !== "function" || !this.mainWindow.isVisible()) {
      if (typeof this.mainWindow.showInactive === "function") {
        this.mainWindow.showInactive();
      } else {
        this.mainWindow.show?.();
      }
    }
  }

  attachSurface() {
    if (!this.window || this.window.isDestroyed()) return;
    const browserHost = this.getEmbeddedBrowserHost();
    if (this.state.source === "embedded-browser") {
      if (!browserHost) throw new Error("内置浏览器尚未就绪");
      this.nativeWindowStream.stop();
      browserHost.setPresentationWindow(this.window, this.browserBounds());
    } else {
      browserHost?.clearPresentationWindow(this.window);
      if (this.state.source === "native-stream" && this.state.nativeTarget) {
        void this.nativeWindowStream.start(this.state.nativeTarget).catch((error) => {
          if (this.state.source !== "native-stream") return;
          this.state = {
            ...this.state,
            streamStatus: "failed",
            streamError: String(error?.message || error).slice(0, 300),
          };
          this.emitState();
        });
      } else {
        this.nativeWindowStream.stop();
        if (this.state.source === "native-stream") {
          this.state = { ...this.state, streamStatus: "waiting-target" };
        }
      }
    }
    this.applyMousePolicy();
  }

  applyMousePolicy() {
    if (!this.window || this.window.isDestroyed()) return;
    const runningSnapshot = this.state.source === "snapshot"
      && (this.state.status === "running" || this.state.status === "waiting-approval");
    const acceptsFocus = this.state.source === "embedded-browser"
      || (this.state.source === "native-stream" && this.state.interactionEnabled);
    this.window.setFocusable?.(acceptsFocus);
    this.window.setIgnoreMouseEvents(runningSnapshot);
  }

  async setInteractionEnabled(enabled) {
    if (this.state.source !== "native-stream" || !this.nativeInteraction) {
      throw new Error("当前画中画不支持原生交互");
    }
    const nextEnabled = enabled === true;
    await this.postJson(this.nativeInteraction.controlUrl, {
      mode: nextEnabled ? "human-control" : "agent-control",
    });
    this.state = { ...this.state, interactionEnabled: nextEnabled };
    this.applyMousePolicy();
    this.emitState();
    return this.getState();
  }

  async clickNativeSurface(input) {
    if (
      this.state.source !== "native-stream"
      || !this.state.interactionEnabled
      || !this.nativeInteraction
    ) {
      throw new Error("请先开启画中画交互");
    }
    const xRatio = Number(input?.xRatio);
    const yRatio = Number(input?.yRatio);
    if (
      !Number.isFinite(xRatio)
      || !Number.isFinite(yRatio)
      || xRatio < 0
      || xRatio > 1
      || yRatio < 0
      || yRatio > 1
    ) {
      throw new Error("画中画点击坐标无效");
    }
    return this.postJson(this.nativeInteraction.clickUrl, { xRatio, yRatio });
  }

  async postJson(url, body) {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || `画中画控制失败（HTTP ${response.status}）`);
    return payload;
  }

  resumeNativeInteraction(interaction = this.nativeInteraction) {
    if (!interaction?.controlUrl) return;
    void this.postJson(interaction.controlUrl, { mode: "agent-control" }).catch(() => undefined);
  }

  emitNativeFrame(frame) {
    if (this.state.source !== "native-stream" || !this.state.open) return;
    this.state = {
      ...this.state,
      streamStatus: "live",
      streamError: "",
      streamFps: frame.fps,
      streamConfiguredFps: frame.configuredFps,
    };
    if (this.isWindowUsable(this.window)) {
      this.window.webContents.send("uiwarden:picture-in-picture:frame", frame);
    }
  }

  browserBounds() {
    if (!this.window || this.window.isDestroyed()) {
      return { x: 0, y: TOOLBAR_HEIGHT, width: MIN_WIDTH, height: MIN_HEIGHT - TOOLBAR_HEIGHT };
    }
    const [width, height] = this.window.getContentSize();
    return {
      x: 0,
      y: TOOLBAR_HEIGHT,
      width: Math.max(1, width),
      height: Math.max(1, height - TOOLBAR_HEIGHT),
    };
  }

  updateBrowserBounds() {
    if (this.state.source !== "embedded-browser" || !this.isWindowUsable(this.window)) return;
    this.getEmbeddedBrowserHost()?.updatePresentationBounds(this.window, this.browserBounds());
  }

  close(reason = "user") {
    this.openSequence += 1;
    const resumeControlUrl = this.state.interactionEnabled
      ? this.nativeInteraction?.controlUrl
      : "";
    this.state = {
      ...this.state,
      open: false,
      interactive: false,
      interactionEnabled: false,
      closeReason: String(reason || "user").slice(0, 32),
    };
    this.nativeWindowStream.stop();
    if (resumeControlUrl) this.resumeNativeInteraction({ controlUrl: resumeControlUrl });
    this.emitState();
    const pipWindow = this.window;
    this.window = null;
    this.windowReadyPromise = null;
    if (pipWindow) {
      this.getEmbeddedBrowserHost()?.clearPresentationWindow(pipWindow);
      if (!pipWindow.isDestroyed()) pipWindow.close();
    }
    return this.getState();
  }

  focusMainWindow() {
    if (!this.isWindowUsable(this.mainWindow)) return this.getState();
    this.keepApplicationVisible();
    if (this.mainWindow.isMinimized()) this.mainWindow.restore();
    this.mainWindow.show();
    this.mainWindow.focus();
    this.keepApplicationVisible();
    return this.getState();
  }

  emitState() {
    const state = this.getState();
    if (
      !this.mainWindow.isDestroyed()
      && (typeof this.mainWindow.webContents?.isDestroyed !== "function"
        || !this.mainWindow.webContents.isDestroyed())
    ) {
      this.mainWindow.webContents.send("uiwarden:picture-in-picture:state", state);
    }
    if (this.isWindowUsable(this.window)) {
      this.window.webContents.send("uiwarden:picture-in-picture:state", state);
    }
  }

  schedulePersistBounds() {
    if (this.persistTimer) clearTimeout(this.persistTimer);
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      if (!this.window || this.window.isDestroyed()) return;
      const bounds = this.clampBounds(this.window.getBounds());
      this.state = { ...this.state, bounds };
      try {
        fs.mkdirSync(path.dirname(this.windowStatePath), { recursive: true });
        fs.writeFileSync(
          this.windowStatePath,
          JSON.stringify({ version: BOUNDS_SCHEMA_VERSION, ...bounds }, null, 2),
          { mode: 0o600 }
        );
      } catch {
        // Window persistence is best effort and must not interrupt a running task.
      }
    }, 180);
  }

  destroy() {
    if (this.persistTimer) clearTimeout(this.persistTimer);
    this.persistTimer = null;
    this.openSequence += 1;
    if (this.state.interactionEnabled) this.resumeNativeInteraction();
    this.nativeWindowStream.stop();
    const pipWindow = this.window;
    this.window = null;
    this.windowReadyPromise = null;
    if (pipWindow) {
      this.getEmbeddedBrowserHost()?.clearPresentationWindow(pipWindow);
      if (!pipWindow.isDestroyed()) pipWindow.destroy();
    }
    this.state = { ...this.state, open: false, interactive: false, interactionEnabled: false };
  }
}

module.exports = {
  PictureInPictureController,
  normalizeNativeInteraction,
  validSnapshotUrl,
};
