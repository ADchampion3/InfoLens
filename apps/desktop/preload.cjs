const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("infolens", {
  getRuntimeInfo: () => ipcRenderer.invoke("runtime:get-info"),
  getMarketCatalog: (query) => ipcRenderer.invoke("market:get-catalog", query),
  refreshMarketCatalog: () => ipcRenderer.invoke("market:refresh"),
  installMarketPlugin: (request) => ipcRenderer.invoke("market:install", request),
  cancelMarketInstall: (operationId) => ipcRenderer.invoke("market:cancel", operationId),
  getMarketOperation: (operationId) => ipcRenderer.invoke("market:get-operation", operationId),
  retryMarketInstall: (operationId) => ipcRenderer.invoke("market:retry", operationId),
  queryLogs: async (request) => {
    const result = await ipcRenderer.invoke("logs:query", request);
    if (!result.ok) throw Object.assign(new Error(result.error.message), { code: result.error.code });
    return result.page;
  },
  copyLogEntry: (id) => ipcRenderer.invoke("logs:copy-entry", id),
  copyFilteredLogs: (filters) => ipcRenderer.invoke("logs:copy-filtered", filters),
  exportFilteredLogs: (filters) => ipcRenderer.invoke("logs:export-filtered", filters),
  selectPluginFolder: () => ipcRenderer.invoke("plugin:select-folder"),
  copyText: (value) => ipcRenderer.invoke("clipboard:write-text", value),
  downloadText: (value) => ipcRenderer.invoke("daily-summary:download", value),
  removePlugin: (id) => ipcRenderer.invoke("plugin:remove", id),
  testReadClipboard: () => ipcRenderer.invoke("test:read-clipboard"),
  testTerminateRuntime: () => ipcRenderer.invoke("test:terminate-runtime"),
  testWriteLog: (message) => ipcRenderer.invoke("test:write-log", message),
  testLogQueryCount: () => ipcRenderer.invoke("test:log-query-count"),
  onRuntimeStatus: (listener) => {
    const handler = (_event, value) => listener(value);
    ipcRenderer.on("runtime:status", handler);
    return () => ipcRenderer.removeListener("runtime:status", handler);
  },
  onMarketProgress: (listener) => {
    const handler = (_event, value) => listener(value);
    ipcRenderer.on("market:progress", handler);
    return () => ipcRenderer.removeListener("market:progress", handler);
  },
});
