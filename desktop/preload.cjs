const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("uiwardenDesktop", {
  embeddedBrowser: {
    getState: () => ipcRenderer.invoke("uiwarden:embedded-browser:get-state"),
    capturePreview: () => ipcRenderer.invoke("uiwarden:embedded-browser:capture-preview"),
    setVisible: (visible) => ipcRenderer.invoke("uiwarden:embedded-browser:set-visible", Boolean(visible)),
    setBounds: (bounds) => ipcRenderer.invoke("uiwarden:embedded-browser:set-bounds", bounds),
    navigate: (url) => ipcRenderer.invoke("uiwarden:embedded-browser:navigate", url),
    createTab: (url) => ipcRenderer.invoke("uiwarden:embedded-browser:create-tab", url),
    activateTab: (tabId) => ipcRenderer.invoke("uiwarden:embedded-browser:activate-tab", tabId),
    closeTab: (tabId) => ipcRenderer.invoke("uiwarden:embedded-browser:close-tab", tabId),
    command: (command) => ipcRenderer.invoke("uiwarden:embedded-browser:command", command),
    find: (query, forward) => ipcRenderer.invoke("uiwarden:embedded-browser:find", query, forward),
    stopFind: () => ipcRenderer.invoke("uiwarden:embedded-browser:stop-find"),
    openDownloads: () => ipcRenderer.invoke("uiwarden:embedded-browser:open-downloads"),
    toggleBookmark: () => ipcRenderer.invoke("uiwarden:embedded-browser:toggle-bookmark"),
    removeBookmark: (id) => ipcRenderer.invoke("uiwarden:embedded-browser:remove-bookmark", id),
    clearHistory: () => ipcRenderer.invoke("uiwarden:embedded-browser:clear-history"),
    clearCookies: () => ipcRenderer.invoke("uiwarden:embedded-browser:clear-cookies"),
    setZoomFactor: (factor) => ipcRenderer.invoke("uiwarden:embedded-browser:set-zoom-factor", factor),
    openDevTools: () => ipcRenderer.invoke("uiwarden:embedded-browser:open-devtools"),
    setControlMode: (mode) => ipcRenderer.invoke("uiwarden:embedded-browser:set-control-mode", mode),
    onStateChanged: (listener) => {
      const wrapped = (_event, state) => listener(state);
      ipcRenderer.on("gui-computer:browser-state", wrapped);
      return () => ipcRenderer.removeListener("gui-computer:browser-state", wrapped);
    },
  },
  pictureInPicture: {
    getState: () => ipcRenderer.invoke("uiwarden:picture-in-picture:get-state"),
    open: (input) => ipcRenderer.invoke("uiwarden:picture-in-picture:open", input),
    update: (input) => ipcRenderer.invoke("uiwarden:picture-in-picture:update", input),
    close: () => ipcRenderer.invoke("uiwarden:picture-in-picture:close"),
    focusMainWindow: () => ipcRenderer.invoke("uiwarden:picture-in-picture:focus-main-window"),
    setInteractionEnabled: (enabled) => ipcRenderer.invoke("uiwarden:picture-in-picture:set-interaction", Boolean(enabled)),
    onStateChanged: (listener) => {
      const wrapped = (_event, state) => listener(state);
      ipcRenderer.on("uiwarden:picture-in-picture:state", wrapped);
      return () => ipcRenderer.removeListener("uiwarden:picture-in-picture:state", wrapped);
    },
  },
});
