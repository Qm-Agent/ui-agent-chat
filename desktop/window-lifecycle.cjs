function isWindowUsable(window) {
  if (!window || typeof window.isDestroyed !== "function" || window.isDestroyed()) return false;
  return typeof window.webContents?.isDestroyed !== "function"
    || !window.webContents.isDestroyed();
}

function createDesktopShellVisibilityController(options) {
  const platform = options.platform;
  const app = options.app;
  let activationPolicyConfigured = false;
  let dockShowPending = false;

  return function keepDesktopShellVisible() {
    if (platform !== "darwin") return;
    if (!activationPolicyConfigured) {
      app.setActivationPolicy("regular");
      activationPolicyConfigured = true;
    }

    const dock = app.dock;
    if (!dock || dockShowPending) return;
    if (typeof dock.isVisible === "function" && dock.isVisible()) return;

    dockShowPending = true;
    Promise.resolve(dock.show())
      .catch(() => undefined)
      .finally(() => {
        dockShowPending = false;
      });
  };
}

function isNavigationAbortError(error) {
  const code = String(error?.code || "");
  const message = String(error?.message || error || "");
  return code === "ERR_ABORTED"
    || Number(error?.errno) === -3
    || /\bERR_ABORTED\b|\(-3\)\s+loading\b/.test(message);
}

async function loadWindowUrlWithRetry(window, url, options = {}) {
  const retries = Math.max(0, Number(options.retries ?? 1));
  const retryDelayMs = Math.max(0, Number(options.retryDelayMs ?? 120));
  let attempt = 0;
  while (true) {
    try {
      await window.loadURL(url);
      return;
    } catch (error) {
      if (
        attempt >= retries
        || !isNavigationAbortError(error)
        || !isWindowUsable(window)
      ) {
        throw error;
      }
      attempt += 1;
      if (retryDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
      }
    }
  }
}

function createWindowCoordinator(options) {
  let pendingCreation = null;

  return function ensureWindow() {
    if (pendingCreation) return pendingCreation;
    const existing = options.getWindow();
    if (isWindowUsable(existing)) {
      options.showWindow?.(existing);
      return Promise.resolve(existing);
    }

    let coordinatedCreation;
    coordinatedCreation = Promise.resolve()
      .then(() => options.createWindow())
      .then((window) => {
        if (isWindowUsable(window)) options.showWindow?.(window);
        return window;
      })
      .catch(async (error) => {
        await options.onError?.(error);
        return null;
      })
      .finally(() => {
        if (pendingCreation === coordinatedCreation) pendingCreation = null;
      });
    pendingCreation = coordinatedCreation;
    return coordinatedCreation;
  };
}

module.exports = {
  createDesktopShellVisibilityController,
  createWindowCoordinator,
  isNavigationAbortError,
  isWindowUsable,
  loadWindowUrlWithRetry,
};
