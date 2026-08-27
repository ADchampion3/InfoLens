const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("infolens", {
  getRuntimeInfo: () => ipcRenderer.invoke("runtime:get-info"),
  startDaemon: () => ipcRenderer.invoke("runtime:start"),
  selectPluginArchive: () => ipcRenderer.invoke("plugin:select-archive"),
  copyText: (value) => ipcRenderer.invoke("clipboard:write-text", value),
  downloadText: (value) => ipcRenderer.invoke("daily-summary:download", value),
  onRuntimeStatus: (listener) => {
    const handler = (_event, value) => listener(value);
    ipcRenderer.on("runtime:status", handler);
    return () => ipcRenderer.removeListener("runtime:status", handler);
  },
});
