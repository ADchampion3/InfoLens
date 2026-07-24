const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("infolens", {
  getRuntimeInfo: () => ipcRenderer.invoke("runtime:get-info"),
});
