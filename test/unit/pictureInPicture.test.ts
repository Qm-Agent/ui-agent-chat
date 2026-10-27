import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const {
  PictureInPictureController,
  normalizeNativeInteraction,
  validSnapshotUrl
} = require("../../desktop/picture-in-picture.cjs") as {
  PictureInPictureController: new (options: Record<string, unknown>) => {
    window?: {
      isDestroyed(): boolean;
      close(): void;
      showInactive(): void;
      setIgnoreMouseEvents(ignore: boolean): void;
      getContentSize(): [number, number];
      webContents: { isDestroyed?(): boolean; send(): void };
    };
    ensureWindow(): Promise<unknown>;
    getState(): {
      open: boolean;
      closeReason?: string;
      source: "embedded-browser" | "snapshot";
      bounds: { x: number; y: number; width: number; height: number };
    };
    open(input: Record<string, unknown>): Promise<unknown>;
    update(input: Record<string, unknown>): unknown;
    close(reason?: string): unknown;
    clampBounds(
      bounds: { x: number; y: number; width: number; height: number },
      workArea: { x: number; y: number; width: number; height: number }
    ): { x: number; y: number; width: number; height: number };
  };
  normalizeNativeInteraction(
    value: unknown,
    allowedOrigins: string[]
  ): { clickUrl: string; controlUrl: string } | null;
  validSnapshotUrl(value: unknown): string;
};
const { normalizeNativeStreamTarget } = require("../../desktop/native-window-stream.cjs") as {
  normalizeNativeStreamTarget(value: unknown): { kind: string; value: string } | null;
};

test("picture-in-picture snapshot URL accepts only local HTTP and image data", () => {
  assert.equal(validSnapshotUrl("http://127.0.0.1:8787/api/image.png"), "http://127.0.0.1:8787/api/image.png");
  assert.equal(validSnapshotUrl("http://localhost:8897/preview/a.webp"), "http://localhost:8897/preview/a.webp");
  assert.match(validSnapshotUrl("data:image/png;base64,AA=="), /^data:image\/png/);
  assert.equal(validSnapshotUrl("https://example.com/image.png"), "");
  assert.equal(validSnapshotUrl("file:///tmp/private.png"), "");
  assert.equal(
    validSnapshotUrl("http://127.0.0.1:8787/api/image.png", ["http://127.0.0.1:8897"]),
    ""
  );
  assert.equal(
    validSnapshotUrl("http://127.0.0.1:8897/api/image.png", ["http://127.0.0.1:8897"]),
    "http://127.0.0.1:8897/api/image.png"
  );
});

test("picture-in-picture explicitly clears a previous task snapshot", () => {
  const controller = new PictureInPictureController({
    BrowserWindow: class {},
    app: { getPath: () => "/tmp/uiwarden-pip-test" },
    screen: {
      getDisplayMatching: () => ({ workArea: { x: 0, y: 0, width: 1280, height: 720 } }),
      getDisplayNearestPoint: () => ({ workArea: { x: 0, y: 0, width: 1280, height: 720 } }),
      getCursorScreenPoint: () => ({ x: 10, y: 10 })
    },
    mainWindow: { isDestroyed: () => true },
    getEmbeddedBrowserHost: () => undefined,
    preloadPath: "",
    htmlPath: "",
    allowedSnapshotOrigins: ["http://127.0.0.1:8797"]
  });

  controller.update({ snapshotUrl: "http://127.0.0.1:8797/old.png" });
  controller.update({ snapshotUrl: "", placeholder: "等待新任务画面" });

  assert.equal((controller.getState() as { snapshotUrl?: string }).snapshotUrl, "");
  assert.equal((controller.getState() as { placeholder?: string }).placeholder, "等待新任务画面");
});

test("native picture-in-picture accepts only bounded targets and local run endpoints", () => {
  assert.deepEqual(
    normalizeNativeStreamTarget({ kind: "process-id", value: "1234" }),
    { kind: "process-id", value: "1234" }
  );
  assert.equal(normalizeNativeStreamTarget({ kind: "url", value: "https://example.com" }), null);
  assert.deepEqual(
    normalizeNativeInteraction({
      clickUrl: "http://127.0.0.1:8797/api/ui-operations/task/runs/run/native/pip-click",
      controlUrl: "http://127.0.0.1:8797/api/ui-operations/task/runs/run/native/control"
    }, ["http://127.0.0.1:8797"]),
    {
      clickUrl: "http://127.0.0.1:8797/api/ui-operations/task/runs/run/native/pip-click",
      controlUrl: "http://127.0.0.1:8797/api/ui-operations/task/runs/run/native/control"
    }
  );
  assert.equal(
    normalizeNativeInteraction({
      clickUrl: "https://example.com/native/pip-click",
      controlUrl: "http://127.0.0.1:8797/native/control"
    }, ["http://127.0.0.1:8797"]),
    null
  );
});

test("native picture-in-picture returns control when its interaction endpoint is removed", async () => {
  const controller = new PictureInPictureController({
    BrowserWindow: class {},
    app: { getPath: () => "/tmp/uiwarden-pip-test" },
    screen: {
      getDisplayMatching: () => ({ workArea: { x: 0, y: 0, width: 1280, height: 720 } }),
      getDisplayNearestPoint: () => ({ workArea: { x: 0, y: 0, width: 1280, height: 720 } }),
      getCursorScreenPoint: () => ({ x: 10, y: 10 })
    },
    mainWindow: { isDestroyed: () => true },
    getEmbeddedBrowserHost: () => undefined,
    preloadPath: "",
    htmlPath: "",
    allowedSnapshotOrigins: ["http://127.0.0.1:8797"]
  });
  const controlModes: string[] = [];
  Object.assign(controller, {
    state: { ...controller.getState(), source: "native-stream", interactive: true },
    nativeInteraction: {
      clickUrl: "http://127.0.0.1:8797/api/ui-operations/task/runs/run/native/pip-click",
      controlUrl: "http://127.0.0.1:8797/api/ui-operations/task/runs/run/native/control"
    },
    postJson: async (_url: string, body: { mode?: string }) => {
      if (body.mode) controlModes.push(body.mode);
      return {};
    }
  });

  await (controller as unknown as {
    setInteractionEnabled(enabled: boolean): Promise<unknown>;
  }).setInteractionEnabled(true);
  controller.update({ nativeInteraction: null });
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(controlModes, ["human-control", "agent-control"]);
  assert.equal((controller.getState() as { interactionEnabled?: boolean }).interactionEnabled, false);
});

test("picture-in-picture open rolls back when the requested surface cannot attach", async () => {
  let closed = false;
  const controller = new PictureInPictureController({
    BrowserWindow: class {},
    app: { getPath: () => "/tmp/uiwarden-pip-test" },
    screen: {
      getDisplayMatching: () => ({ workArea: { x: 0, y: 0, width: 1280, height: 720 } }),
      getDisplayNearestPoint: () => ({ workArea: { x: 0, y: 0, width: 1280, height: 720 } }),
      getCursorScreenPoint: () => ({ x: 10, y: 10 })
    },
    mainWindow: { isDestroyed: () => true },
    getEmbeddedBrowserHost: () => undefined,
    preloadPath: "",
    htmlPath: ""
  });
  controller.window = {
    isDestroyed: () => false,
    close: () => { closed = true; },
    showInactive: () => undefined,
    setIgnoreMouseEvents: () => undefined,
    getContentSize: () => [480, 320],
    webContents: { send: () => undefined }
  };
  controller.ensureWindow = async () => controller.window;

  await assert.rejects(
    controller.open({ source: "embedded-browser" }),
    /内置浏览器尚未就绪/
  );
  assert.equal(controller.getState().open, false);
  assert.equal(controller.getState().source, "snapshot");
  assert.equal(closed, true);
});

test("picture-in-picture source update restores the previous surface after attach failure", () => {
  const controller = new PictureInPictureController({
    BrowserWindow: class {},
    app: { getPath: () => "/tmp/uiwarden-pip-test" },
    screen: {
      getDisplayMatching: () => ({ workArea: { x: 0, y: 0, width: 1280, height: 720 } }),
      getDisplayNearestPoint: () => ({ workArea: { x: 0, y: 0, width: 1280, height: 720 } }),
      getCursorScreenPoint: () => ({ x: 10, y: 10 })
    },
    mainWindow: { isDestroyed: () => true },
    getEmbeddedBrowserHost: () => undefined,
    preloadPath: "",
    htmlPath: ""
  });
  controller.window = {
    isDestroyed: () => false,
    close: () => undefined,
    showInactive: () => undefined,
    setIgnoreMouseEvents: () => undefined,
    getContentSize: () => [480, 320],
    webContents: { send: () => undefined }
  };
  Object.assign(controller, {
    state: { ...controller.getState(), open: true, source: "snapshot" }
  });

  assert.throws(
    () => controller.update({ source: "embedded-browser" }),
    /内置浏览器尚未就绪/
  );
  assert.equal(controller.getState().open, true);
  assert.equal(controller.getState().source, "snapshot");
});

test("picture-in-picture ignores an open request after rapid close and reopen", async () => {
  const pendingLoads: Array<() => void> = [];
  const shownWindows: number[] = [];
  let nextWindowId = 0;
  class FakeBrowserWindow {
    id = ++nextWindowId;
    destroyed = false;
    listeners = new Map<string, () => void>();
    webContents = {
      isDestroyed: () => this.destroyed,
      on: () => undefined,
      send: () => undefined,
      setWindowOpenHandler: () => undefined
    };
    contentView = { removeChildView: () => undefined };
    constructor(_options: Record<string, unknown>) {}
    isDestroyed() { return this.destroyed; }
    setAlwaysOnTop() {}
    setVisibleOnAllWorkspaces() {}
    on(name: string, listener: () => void) { this.listeners.set(name, listener); }
    loadFile() {
      return new Promise<void>((resolve) => pendingLoads.push(resolve));
    }
    showInactive() {
      if (this.destroyed) throw new TypeError("Object has been destroyed");
      shownWindows.push(this.id);
    }
    setIgnoreMouseEvents() {}
    getContentSize(): [number, number] { return [480, 320]; }
    close() {
      this.destroyed = true;
      this.listeners.get("closed")?.();
    }
  }
  const controller = new PictureInPictureController({
    BrowserWindow: FakeBrowserWindow,
    app: { getPath: () => "/tmp/uiwarden-pip-test" },
    screen: {
      getDisplayMatching: () => ({ workArea: { x: 0, y: 0, width: 1280, height: 720 } }),
      getDisplayNearestPoint: () => ({ workArea: { x: 0, y: 0, width: 1280, height: 720 } }),
      getCursorScreenPoint: () => ({ x: 10, y: 10 })
    },
    mainWindow: { isDestroyed: () => true },
    getEmbeddedBrowserHost: () => ({
      setPresentationWindow: () => undefined,
      clearPresentationWindow: () => undefined
    }),
    preloadPath: "",
    htmlPath: ""
  });

  const firstOpen = controller.open({ source: "snapshot" });
  controller.close();
  const secondOpen = controller.open({ source: "snapshot" });
  pendingLoads[0]();
  pendingLoads[1]();

  await Promise.all([firstOpen, secondOpen]);
  assert.deepEqual(shownWindows, [2]);
  assert.equal(controller.getState().open, true);
});

test("picture-in-picture distinguishes renderer recovery from a user close", () => {
  const controller = new PictureInPictureController({
    BrowserWindow: class {},
    app: { getPath: () => "/tmp/uiwarden-pip-test" },
    screen: {
      getDisplayMatching: () => ({ workArea: { x: 0, y: 0, width: 1280, height: 720 } }),
      getDisplayNearestPoint: () => ({ workArea: { x: 0, y: 0, width: 1280, height: 720 } }),
      getCursorScreenPoint: () => ({ x: 10, y: 10 })
    },
    mainWindow: { isDestroyed: () => true },
    getEmbeddedBrowserHost: () => undefined,
    preloadPath: "",
    htmlPath: ""
  });
  controller.close("renderer-reload");
  assert.equal(controller.getState().open, false);
  assert.equal(controller.getState().closeReason, "renderer-reload");
  controller.close();
  assert.equal(controller.getState().closeReason, "user");
});

test("running snapshot is mouse-through while live browser remains interactive", () => {
  const ignored: boolean[] = [];
  const focusable: boolean[] = [];
  const controller = new PictureInPictureController({
    BrowserWindow: class {},
    app: { getPath: () => "/tmp/uiwarden-pip-test" },
    screen: {
      getDisplayMatching: () => ({ workArea: { x: 0, y: 0, width: 1280, height: 720 } }),
      getDisplayNearestPoint: () => ({ workArea: { x: 0, y: 0, width: 1280, height: 720 } }),
      getCursorScreenPoint: () => ({ x: 10, y: 10 })
    },
    mainWindow: { isDestroyed: () => true },
    getEmbeddedBrowserHost: () => ({
      setPresentationWindow: () => undefined,
      clearPresentationWindow: () => undefined
    }),
    preloadPath: "",
    htmlPath: ""
  });
  controller.window = {
    isDestroyed: () => false,
    close: () => undefined,
    showInactive: () => undefined,
    setIgnoreMouseEvents: (ignore) => ignored.push(ignore),
    setFocusable: (enabled) => focusable.push(enabled),
    getContentSize: () => [480, 320],
    webContents: { send: () => undefined }
  };

  controller.update({ source: "snapshot", status: "running" });
  controller.update({ source: "snapshot", status: "completed" });
  controller.update({ source: "embedded-browser", status: "running" });

  assert.deepEqual(ignored, [true, false, false]);
  assert.deepEqual(focusable, [false, false, true]);
});

test("returning to the main window keeps picture-in-picture open", () => {
  const mainActions: string[] = [];
  let shellVisibleCalls = 0;
  const controller = new PictureInPictureController({
    BrowserWindow: class {},
    app: { getPath: () => "/tmp/uiwarden-pip-test" },
    screen: {
      getDisplayMatching: () => ({ workArea: { x: 0, y: 0, width: 1280, height: 720 } }),
      getDisplayNearestPoint: () => ({ workArea: { x: 0, y: 0, width: 1280, height: 720 } }),
      getCursorScreenPoint: () => ({ x: 10, y: 10 })
    },
    mainWindow: {
      isDestroyed: () => false,
      isMinimized: () => true,
      restore: () => mainActions.push("restore"),
      show: () => mainActions.push("show"),
      focus: () => mainActions.push("focus"),
      webContents: { isDestroyed: () => false, send: () => undefined }
    },
    getEmbeddedBrowserHost: () => undefined,
    keepApplicationVisible: () => { shellVisibleCalls += 1; },
    preloadPath: "",
    htmlPath: ""
  });
  Object.assign(controller, {
    state: { ...controller.getState(), open: true, source: "snapshot" }
  });

  const state = (controller as unknown as {
    focusMainWindow(): { open: boolean };
  }).focusMainWindow();

  assert.equal(state.open, true);
  assert.deepEqual(mainActions, ["restore", "show", "focus"]);
  assert.equal(shellVisibleCalls, 2);
});

test("opening picture-in-picture restores the main window without stealing focus", async () => {
  const mainActions: string[] = [];
  let minimized = true;
  let visible = false;
  const controller = new PictureInPictureController({
    BrowserWindow: class {},
    app: { getPath: () => "/tmp/uiwarden-pip-test" },
    screen: {
      getDisplayMatching: () => ({ workArea: { x: 0, y: 0, width: 1280, height: 720 } }),
      getDisplayNearestPoint: () => ({ workArea: { x: 0, y: 0, width: 1280, height: 720 } }),
      getCursorScreenPoint: () => ({ x: 10, y: 10 })
    },
    mainWindow: {
      isDestroyed: () => false,
      isMinimized: () => minimized,
      isVisible: () => visible,
      restore: () => {
        minimized = false;
        mainActions.push("restore");
      },
      showInactive: () => {
        visible = true;
        mainActions.push("showInactive");
      },
      focus: () => mainActions.push("focus"),
      webContents: { isDestroyed: () => false, send: () => undefined }
    },
    getEmbeddedBrowserHost: () => undefined,
    keepApplicationVisible: () => undefined,
    preloadPath: "",
    htmlPath: ""
  });
  controller.window = {
    isDestroyed: () => false,
    close: () => undefined,
    showInactive: () => undefined,
    setIgnoreMouseEvents: () => undefined,
    setFocusable: () => undefined,
    getContentSize: () => [480, 320],
    webContents: { isDestroyed: () => false, send: () => undefined }
  };
  controller.ensureWindow = async () => controller.window;

  await controller.open({ source: "snapshot", status: "running" });

  assert.deepEqual(mainActions, ["restore", "showInactive", "showInactive"]);
  assert.equal(controller.getState().open, true);
  assert.equal(visible, true);
  assert.equal(minimized, false);
});

test("picture-in-picture uses a separate Dock entry only outside macOS", async () => {
  let windowOptions: Record<string, unknown> = {};
  class FakeBrowserWindow {
    webContents = {
      isDestroyed: () => false,
      on: () => undefined,
      send: () => undefined,
      setWindowOpenHandler: () => undefined
    };
    contentView = { removeChildView: () => undefined };
    constructor(options: Record<string, unknown>) { windowOptions = options; }
    isDestroyed() { return false; }
    setAlwaysOnTop() {}
    setVisibleOnAllWorkspaces() {}
    on() {}
    loadFile() { return Promise.resolve(); }
  }
  const controller = new PictureInPictureController({
    BrowserWindow: FakeBrowserWindow,
    app: { getPath: () => "/tmp/uiwarden-pip-test" },
    screen: {
      getDisplayMatching: () => ({ workArea: { x: 0, y: 0, width: 1280, height: 720 } }),
      getDisplayNearestPoint: () => ({ workArea: { x: 0, y: 0, width: 1280, height: 720 } }),
      getCursorScreenPoint: () => ({ x: 10, y: 10 })
    },
    mainWindow: { isDestroyed: () => true },
    getEmbeddedBrowserHost: () => undefined,
    preloadPath: "",
    htmlPath: ""
  });

  await controller.ensureWindow();
  assert.equal(windowOptions.skipTaskbar, process.platform !== "darwin");
});

test("picture-in-picture bounds remain fully inside the selected display", () => {
  const workArea = { x: 100, y: 50, width: 1280, height: 720 };
  const controller = new PictureInPictureController({
    BrowserWindow: class {},
    app: { getPath: () => "/tmp/uiwarden-pip-test" },
    screen: {
      getDisplayMatching: () => ({ workArea }),
      getDisplayNearestPoint: () => ({ workArea }),
      getCursorScreenPoint: () => ({ x: 200, y: 100 })
    },
    mainWindow: {},
    getEmbeddedBrowserHost: () => undefined,
    preloadPath: "",
    htmlPath: ""
  });
  assert.deepEqual(
    controller.clampBounds({ x: -1000, y: 5000, width: 2000, height: 100 }, workArea),
    { x: 100, y: 600, width: 1280, height: 170 }
  );
});
