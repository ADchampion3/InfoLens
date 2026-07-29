const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("infolens", {
  getRuntimeInfo: () => ipcRenderer.invoke("runtime:get-info"),
  selectPluginFolder: () => ipcRenderer.invoke("plugin:select-folder"),
  copyText: (value) => ipcRenderer.invoke("clipboard:write-text", value),
  removePlugin: (id) => ipcRenderer.invoke("plugin:remove", id),
  testReadClipboard: () => ipcRenderer.invoke("test:read-clipboard"),
  testTerminateRuntime: () => ipcRenderer.invoke("test:terminate-runtime"),
  onRuntimeStatus: (listener) => {
    const handler = (_event, value) => listener(value);
    ipcRenderer.on("runtime:status", handler);
    return () => ipcRenderer.removeListener("runtime:status", handler);
  },
});
