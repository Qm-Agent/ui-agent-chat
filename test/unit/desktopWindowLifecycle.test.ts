import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const {
  createDesktopShellVisibilityController,
  createWindowCoordinator,
  isNavigationAbortError,
  loadWindowUrlWithRetry,
} = require("../../desktop/window-lifecycle.cjs") as {
  createDesktopShellVisibilityController(options: {
    platform: string;
    app: {
      setActivationPolicy(policy: string): void;
      dock?: { isVisible(): boolean; show(): Promise<void> };
    };
  }): () => void;
  createWindowCoordinator(options: {
    getWindow(): FakeWindow | null;
    createWindow(): Promise<FakeWindow>;
    showWindow(window: FakeWindow): void;
    onError(error: unknown): void;
  }): () => Promise<FakeWindow | null>;
  isNavigationAbortError(error: unknown): boolean;
  loadWindowUrlWithRetry(
    window: FakeWindow,
    url: string,
    options?: { retries?: number; retryDelayMs?: number }
  ): Promise<void>;
};

type FakeWindow = {
  isDestroyed(): boolean;
  webContents: { isDestroyed(): boolean };
  loadURL(url: string): Promise<void>;
};

function usableWindow(loadURL: FakeWindow["loadURL"] = async () => undefined): FakeWindow {
  return {
    isDestroyed: () => false,
    webContents: { isDestroyed: () => false },
    loadURL,
  };
}

test("desktop shell configures activation policy once and only restores a hidden Dock", async () => {
  let activationPolicyCalls = 0;
  let dockShowCalls = 0;
  let dockVisible = true;
  const keepVisible = createDesktopShellVisibilityController({
    platform: "darwin",
    app: {
      setActivationPolicy: (policy) => {
        assert.equal(policy, "regular");
        activationPolicyCalls += 1;
      },
      dock: {
        isVisible: () => dockVisible,
        show: async () => {
          dockShowCalls += 1;
          dockVisible = true;
        },
      },
    },
  });

  keepVisible();
  keepVisible();
  assert.equal(activationPolicyCalls, 1);
  assert.equal(dockShowCalls, 0);

  dockVisible = false;
  keepVisible();
  keepVisible();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(activationPolicyCalls, 1);
  assert.equal(dockShowCalls, 1);
});

test("desktop window coordinator shares one in-flight creation", async () => {
  let markCreationStarted!: () => void;
  let finishCreation!: () => void;
  let createCalls = 0;
  let currentWindow: FakeWindow | null = null;
  const shown: FakeWindow[] = [];
  const creationStarted = new Promise<void>((resolve) => {
    markCreationStarted = resolve;
  });
  const creationFinished = new Promise<void>((resolve) => {
    finishCreation = resolve;
  });
  const window = usableWindow();
  const ensureWindow = createWindowCoordinator({
    getWindow: () => currentWindow,
    createWindow: async () => {
      createCalls += 1;
      currentWindow = window;
      markCreationStarted();
      await creationFinished;
      return currentWindow;
    },
    showWindow: (window) => shown.push(window),
    onError: () => undefined,
  });

  const first = ensureWindow();
  await creationStarted;
  const second = ensureWindow();
  const third = ensureWindow();
  assert.equal(first, second);
  assert.equal(second, third);
  assert.equal(createCalls, 1);

  finishCreation();
  assert.deepEqual(await Promise.all([first, second, third]), [window, window, window]);
  assert.equal(createCalls, 1);
  assert.deepEqual(shown, [window]);

  assert.equal(await ensureWindow(), window);
  assert.deepEqual(shown, [window, window]);
});

test("desktop window navigation retries one recoverable ERR_ABORTED", async () => {
  const loadedUrls: string[] = [];
  const window = usableWindow(async (url) => {
    loadedUrls.push(url);
    if (loadedUrls.length === 1) {
      const error = new Error(`ERR_ABORTED (-3) loading '${url}'`) as Error & {
        code: string;
        errno: number;
      };
      error.code = "ERR_ABORTED";
      error.errno = -3;
      throw error;
    }
  });

  await loadWindowUrlWithRetry(window, "http://127.0.0.1:8797/", {
    retries: 1,
    retryDelayMs: 0,
  });
  assert.deepEqual(loadedUrls, [
    "http://127.0.0.1:8797/",
    "http://127.0.0.1:8797/",
  ]);
  assert.equal(isNavigationAbortError(new Error("ERR_ABORTED (-3) loading 'about:blank'")), true);
});

test("desktop window navigation does not hide non-abort failures", async () => {
  const window = usableWindow(async () => {
    throw new Error("ERR_CONNECTION_REFUSED");
  });
  await assert.rejects(
    loadWindowUrlWithRetry(window, "http://127.0.0.1:8797/", {
      retries: 1,
      retryDelayMs: 0,
    }),
    /ERR_CONNECTION_REFUSED/
  );
});
