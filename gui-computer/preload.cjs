const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("guiComputer", {
  getState: () => ipcRenderer.invoke("gui-computer:get-state"),
  getConnection: () => ipcRenderer.invoke("gui-computer:get-connection"),
  newWindow: () => ipcRenderer.invoke("gui-computer:new-window"),
  setBounds: (bounds) => ipcRenderer.invoke("gui-computer:set-bounds", bounds),
  navigate: (url) => ipcRenderer.invoke("gui-computer:navigate", url),
  createTab: (url) => ipcRenderer.invoke("gui-computer:create-tab", url),
  activateTab: (id) => ipcRenderer.invoke("gui-computer:activate-tab", id),
  closeTab: (id) => ipcRenderer.invoke("gui-computer:close-tab", id),
  command: (command) => ipcRenderer.invoke("gui-computer:command", command),
  find: (query, forward) => ipcRenderer.invoke("gui-computer:find", query, forward),
  stopFind: () => ipcRenderer.invoke("gui-computer:stop-find"),
  openDownloads: () => ipcRenderer.invoke("gui-computer:open-downloads"),
  toggleBookmark: () => ipcRenderer.invoke("gui-computer:toggle-bookmark"),
  removeBookmark: (id) => ipcRenderer.invoke("gui-computer:remove-bookmark", id),
  clearHistory: () => ipcRenderer.invoke("gui-computer:clear-history"),
  clearCookies: () => ipcRenderer.invoke("gui-computer:clear-cookies"),
  setZoomFactor: (factor) => ipcRenderer.invoke("gui-computer:set-zoom-factor", factor),
  openDevTools: () => ipcRenderer.invoke("gui-computer:open-devtools"),
  setControlMode: (mode) => ipcRenderer.invoke("gui-computer:set-control-mode", mode),
  onState: (listener) => {
    const handler = (_event, state) => listener(state);
    ipcRenderer.on("gui-computer:browser-state", handler);
    return () => ipcRenderer.removeListener("gui-computer:browser-state", handler);
  },
  onResize: (listener) => {
    const handler = () => listener();
    ipcRenderer.on("gui-computer-resize", handler);
    return () => ipcRenderer.removeListener("gui-computer-resize", handler);
  },
});
