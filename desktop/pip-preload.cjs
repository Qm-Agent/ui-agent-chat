const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("uiwardenPictureInPicture", {
  getState: () => ipcRenderer.invoke("uiwarden:picture-in-picture:get-state"),
  close: () => ipcRenderer.invoke("uiwarden:picture-in-picture:close"),
  focusMainWindow: () => ipcRenderer.invoke("uiwarden:picture-in-picture:focus-main-window"),
  setInteractionEnabled: (enabled) => ipcRenderer.invoke("uiwarden:picture-in-picture:set-interaction", Boolean(enabled)),
  clickNativeSurface: (input) => ipcRenderer.invoke("uiwarden:picture-in-picture:click-native-surface", input),
  onStateChanged: (listener) => {
    const wrapped = (_event, state) => listener(state);
    ipcRenderer.on("uiwarden:picture-in-picture:state", wrapped);
    return () => ipcRenderer.removeListener("uiwarden:picture-in-picture:state", wrapped);
  },
  onFrame: (listener) => {
    const wrapped = (_event, frame) => listener(frame);
    ipcRenderer.on("uiwarden:picture-in-picture:frame", wrapped);
    return () => ipcRenderer.removeListener("uiwarden:picture-in-picture:frame", wrapped);
  },
});
