const { app, BrowserWindow, clipboard, dialog, ipcMain, session } = require("electron");
const { spawn } = require("node:child_process");
const { randomUUID } = require("node:crypto");
const { access, cp, mkdir, readFile, readdir, rename, rm, writeFile } = require("node:fs/promises");
const path = require("node:path");
const readline = require("node:readline");
const { pathToFileURL } = require("node:url");
const { runtimeProxyEnvironment } = require("./runtime-network.cjs");

const projectRoot = path.resolve(__dirname, "../..");
const bundledPluginsRoot = path.join(projectRoot, "plugins");
if (process.env.INFOLENS_USER_DATA_ROOT) app.setPath("userData", path.resolve(process.env.INFOLENS_USER_DATA_ROOT));
let runtimeProcess;
let runtimeInfo;
let runtimeStartPromise;
let mainWindow;
let quitting = false;
let quitPromptActive = false;
let restarting = false;
let suppressRestart = false;
let logService;
let serializeLogEntries;
let logQueryCount = 0;
let marketService;
const applicationSessionId = process.env.INFOLENS_APPLICATION_SESSION_ID || randomUUID();

function runtimeHeaders(headers = {}) {
  return { ...headers, authorization: `Bearer ${applicationSessionId}` };
}

function trustedWorkspacePermission(webContents, requestingUrl) {
  if (!runtimeInfo?.origin || typeof requestingUrl !== "string") return false;
  let parsed;
  try { parsed = new URL(requestingUrl); } catch { return false; }
  if (parsed.origin !== runtimeInfo.origin || !/^\/plugins\/[^/]+\/workspace(?:\/|$)/.test(parsed.pathname)) return false;
  let pluginId;
  try { pluginId = decodeURIComponent(parsed.pathname.split("/")[2] ?? ""); } catch { return false; }
  if (!runtimeInfo.plugins.some((plugin) => plugin.id === pluginId)) return false;
  return true;
}

function installWorkspacePermissionHandlers() {
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback, details = {}) => {
    const writePermission = permission === "clipboard-sanitized-write" || permission === "clipboard-write";
    callback(writePermission && trustedWorkspacePermission(webContents, details.requestingUrl || webContents?.getURL?.()));
  });
  session.defaultSession.setPermissionCheckHandler((webContents, permission, _requestingOrigin, details = {}) => {
    const writePermission = permission === "clipboard-sanitized-write" || permission === "clipboard-write";
    return writePermission && trustedWorkspacePermission(webContents, details.requestingUrl || webContents?.getURL?.());
  });
}

function publishRuntimeStatus(status, details = {}) {
  if (!mainWindow?.isDestroyed()) mainWindow.webContents.send("runtime:status", { status, ...details });
}

function managedPaths() {
  const profileRoot = app.isPackaged ? app.getPath("userData") : path.join(projectRoot, ".infolens-data");
  const pluginsRoot = path.resolve(process.env.INFOLENS_PLUGINS_ROOT ?? (app.isPackaged ? path.join(profileRoot, "plugins") : bundledPluginsRoot));
  const dataRoot = path.resolve(process.env.INFOLENS_PLUGIN_DATA_ROOT ?? path.join(profileRoot, app.isPackaged ? "plugins-data" : "plugins"));
  const hostStatePath = path.resolve(process.env.INFOLENS_HOST_STATE_PATH ?? path.join(profileRoot, "host-state.json"));
  const hostLogsRoot = path.resolve(process.env.INFOLENS_HOST_LOG_ROOT ?? path.join(profileRoot, "logs"));
  const batchStatePath = path.join(dataRoot, "_runtime", `batches-${applicationSessionId}.json`);
  const adapterRegistryRoot = path.resolve(process.env.INFOLENS_ADAPTER_REGISTRY_ROOT ?? path.join(path.dirname(dataRoot), "opencli-adapters"));
  const marketRoot = path.resolve(process.env.INFOLENS_MARKET_DATA_ROOT ?? path.join(profileRoot, "market"));
  return { pluginsRoot, dataRoot, hostStatePath, hostLogsRoot, batchStatePath, adapterRegistryRoot, marketRoot, marketCachePath: path.join(marketRoot, "catalog.json"), marketTempRoot: path.join(marketRoot, "installations") };
}

async function initializeLogService() {
  const modulePath = path.join(projectRoot, "packages", "log-service", "src", "index.mjs");
  const logModule = await import(pathToFileURL(modulePath).href);
  const { createLogService } = logModule;
  serializeLogEntries = logModule.serializeLogEntries;
  logService = createLogService({ root: managedPaths().hostLogsRoot, sessionId: randomUUID() });
  await logService.write({ level: "info", message: "Host Shell started" });
}

async function initializeMarketService() {
  const modulePath = path.join(projectRoot, "packages", "plugin-market", "src", "service.mjs");
  const releasePath = path.join(projectRoot, "packages", "release-metadata", "src", "index.mjs");
  const [{ PluginMarketService }, release] = await Promise.all([import(pathToFileURL(modulePath).href), import(pathToFileURL(releasePath).href)]);
  const paths = managedPaths();
  const testRegistryUrl = process.env.INFOLENS_TEST_CONTROL === "1" ? process.env.INFOLENS_TEST_MARKET_REGISTRY_URL : undefined;
  marketService = new PluginMarketService({
    registryUrl: testRegistryUrl ?? undefined,
    cachePath: paths.marketCachePath,
    tempRoot: paths.marketTempRoot,
    hostVersion: release.DEFAULT_TARGET_HOST_VERSION,
    contractVersion: String(release.PLUGIN_CONTRACT_VERSION),
    logger: (entry) => logService?.write({ level: entry.event?.endsWith("failed") ? "error" : "info", message: entry.event ?? "market-operation", ...entry }),
    reconcileProvenance: async (index) => {
      if (!runtimeInfo?.origin) return;
      const response = await fetch(`${runtimeInfo.origin}/runtime/plugins/reconcile-market`, {
        method: "POST",
        headers: runtimeHeaders({ "content-type": "application/json" }),
        body: JSON.stringify({ releases: index.releases.map(({ pluginId, version, retraction }) => ({ pluginId, version, ...(retraction ? { retraction } : {}) })) }),
      });
      if (!response.ok) throw new Error("Plugin Runtime could not reconcile Market provenance");
    },
    runtimeClient: async ({ archivePath, expectedSha256, observedSha256, release: selectedRelease, operationId, signal }) => {
      if (!runtimeInfo?.origin) throw Object.assign(new Error("Plugin services are unavailable"), { code: "MARKET_RUNTIME_UNAVAILABLE" });
      const response = await fetch(`${runtimeInfo.origin}/runtime/plugins/install-market`, {
        method: "POST",
        signal,
        headers: runtimeHeaders({ "content-type": "application/json", "x-infolens-operation-id": operationId }),
        body: JSON.stringify({ archivePath, expectedSha256, observedSha256, release: selectedRelease }),
      });
      let body;
      try { body = await response.json(); } catch { body = {}; }
      if (!response.ok) throw Object.assign(new Error(body.error ?? "Market Plugin installation failed"), { code: body.code, body });
      return body;
    },
  });
  await marketService.initialize();
}

async function seedBundledPlugins() {
  if (!app.isPackaged || process.env.INFOLENS_PLUGINS_ROOT) return;
  const { pluginsRoot } = managedPaths();
  await mkdir(pluginsRoot, { recursive: true });
  for (const entry of await readdir(bundledPluginsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const destination = path.join(pluginsRoot, entry.name);
    try { await access(destination); }
    catch { await cp(path.join(bundledPluginsRoot, entry.name), destination, { recursive: true }); }
  }
}

async function startRuntimeProcess() {
  await logService?.write({ level: "info", message: "Plugin Runtime starting" });
  let proxyRules = "DIRECT";
  try { proxyRules = await session.defaultSession.resolveProxy("https://github.com"); } catch {}
  const networkEnvironment = runtimeProxyEnvironment(process.env, proxyRules);
  const bundledPluginIds = (await readdir(bundledPluginsRoot, { withFileTypes: true }).catch(() => [])).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  return new Promise((resolve, reject) => {
    const runtimeEntry = path.join(projectRoot, "packages", "plugin-runtime", "src", "server.mjs");
    const { pluginsRoot, dataRoot, hostStatePath, batchStatePath } = managedPaths();
    runtimeProcess = spawn(process.execPath, [runtimeEntry], {
      cwd: projectRoot,
      env: {
        ...process.env,
        ...networkEnvironment,
        ELECTRON_RUN_AS_NODE: "1",
        INFOLENS_PROJECT_ROOT: projectRoot,
        INFOLENS_PLUGINS_ROOT: pluginsRoot,
        INFOLENS_PLUGIN_DATA_ROOT: dataRoot,
        INFOLENS_HOST_STATE_PATH: hostStatePath,
        INFOLENS_BATCH_STATE_PATH: batchStatePath,
        INFOLENS_APPLICATION_SESSION_ID: applicationSessionId,
        INFOLENS_BUNDLED_PLUGIN_IDS: JSON.stringify(bundledPluginIds),
        INFOLENS_RUNTIME_PORT: process.env.INFOLENS_RUNTIME_PORT ?? "0",
      },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    const lines = readline.createInterface({ input: runtimeProcess.stdout });
    const timeout = setTimeout(() => reject(new Error("Plugin Runtime did not become ready")), 10000);

    lines.on("line", (line) => {
      try {
        const message = JSON.parse(line);
        if (message.type === "runtime-ready") {
          clearTimeout(timeout);
          runtimeInfo = message;
          logService?.write({ level: "info", message: "Plugin Runtime started" }).catch(console.error);
          resolve(message);
        }
      } catch {
        console.log(`[runtime] ${line}`);
      }
    });

    runtimeProcess.stderr.on("data", (chunk) => console.error(`[runtime] ${chunk}`));
    runtimeProcess.once("error", (error) => {
      logService?.write({ level: "error", message: `Plugin Runtime failed to start: ${error.message}` }).catch(console.error);
      reject(error);
    });
    runtimeProcess.once("exit", (code, signal) => {
      runtimeProcess = undefined;
      runtimeInfo = undefined;
      logService?.write({ level: quitting ? "info" : "warn", message: `Plugin Runtime exited code=${code ?? "none"} signal=${signal ?? "none"}` }).catch(console.error);
      if (!quitting && !suppressRestart) restartRuntime();
    });
  });
}

async function startRuntime() {
  if (runtimeStartPromise) return runtimeStartPromise;
  const promise = startRuntimeProcess();
  runtimeStartPromise = promise;
  try {
    return await promise;
  } finally {
    if (runtimeStartPromise === promise) runtimeStartPromise = undefined;
  }
}

async function restartRuntime() {
  if (restarting || quitting) return;
  restarting = true;
  publishRuntimeStatus("restarting");
  try {
    await new Promise((resolve) => setTimeout(resolve, 400));
    const info = await startRuntime();
    publishRuntimeStatus("running", { info });
  } catch (error) {
    publishRuntimeStatus("unavailable", { message: error instanceof Error ? error.message : String(error) });
    setTimeout(() => { restarting = false; restartRuntime(); }, 1500);
    return;
  }
  restarting = false;
}

function stopRuntime(reason = "application-exit") {
  if (!runtimeProcess) return Promise.resolve();
  return new Promise((resolve) => {
    const child = runtimeProcess;
    const timeout = setTimeout(() => {
      if (!child.killed) child.kill();
      setTimeout(resolve, 1_000);
    }, 2500);
    child.once("exit", () => {
      clearTimeout(timeout);
      resolve();
    });
    child.stdin.write(`shutdown:${reason}\n`);
    child.stdin.end();
  });
}

function assertManagedPath(root, target) {
  const relative = path.relative(root, target);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Refusing to remove a path outside the managed directory");
}

async function removeHostStatePlugin(filePath, id) {
  let state;
  try { state = JSON.parse(await readFile(filePath, "utf8")); } catch { return; }
  state.enabledPluginIds = (state.enabledPluginIds ?? []).filter((pluginId) => pluginId !== id);
  if (state.lastSelection === id) state.lastSelection = null;
  if (state.statusSnapshots) delete state.statusSnapshots[id];
  if (state.pluginInstallations) delete state.pluginInstallations[id];
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  await rename(temporary, filePath);
}

async function removePlugin(id) {
  const operationId = randomUUID();
  if (!runtimeInfo?.origin) throw new Error("Plugin services are unavailable");
  const record = runtimeInfo.plugins?.find((plugin) => plugin.id === id)
    ?? runtimeInfo.rejectedPlugins?.find((plugin) => plugin.id === id || plugin.package === id);
  if (!record?.packagePath) throw new Error(`Plugin '${id}' is not installed`);
  const response = await fetch(`${runtimeInfo.origin}/runtime/plugins/${encodeURIComponent(id)}/remove`, { method: "DELETE", headers: runtimeHeaders({ "x-infolens-operation-id": operationId }) });
  if (response.ok) {
    await logService?.write({ level: "info", message: `Plugin removed id=${id}`, operationId });
    return;
  }
  const failure = await response.json();
  if (failure.code !== "RUNTIME_RESTART_REQUIRED") throw new Error(failure.error ?? "Plugin removal failed");

  const { pluginsRoot, dataRoot, hostStatePath, adapterRegistryRoot } = managedPaths();
  const packagePath = path.resolve(record.packagePath);
  const dataPath = path.resolve(dataRoot, record.id ?? id);
  assertManagedPath(pluginsRoot, packagePath);
  assertManagedPath(dataRoot, dataPath);
  suppressRestart = true;
  publishRuntimeStatus("restarting");
  let info;
  try {
    await stopRuntime("RUNTIME_RESTARTED");
    await rm(packagePath, { recursive: true, force: true });
    await rm(dataPath, { recursive: true, force: true });
    const adapterScopeModule = await import(pathToFileURL(path.join(projectRoot, "packages", "plugin-runtime", "src", "adapter-scope.mjs")).href);
    await adapterScopeModule.removePluginAdapterScope(adapterRegistryRoot, record.id ?? id);
    await removeHostStatePlugin(hostStatePath, record.id ?? id);
    info = await startRuntime();
  } finally {
    suppressRestart = false;
  }
  publishRuntimeStatus("running", { info });
  await logService?.write({ level: "info", message: `Plugin removed id=${record.id ?? id}`, operationId });
}

function createWindow() {
  const window = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 700,
    backgroundColor: "#f5f7f9",
    title: "Infolens",
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow = window;

  window.once("ready-to-show", () => window.show());
  const rendererUrl = process.env.INFOLENS_RENDERER_URL;
  if (rendererUrl) window.loadURL(rendererUrl);
  else window.loadFile(path.join(__dirname, "dist", "index.html"));
}

ipcMain.handle("runtime:get-info", async () => {
  if (!runtimeInfo?.origin && runtimeStartPromise) {
    try { await runtimeStartPromise; } catch {}
  }
  if (!runtimeInfo?.origin) return runtimeInfo;
  try {
    const response = await fetch(`${runtimeInfo.origin}/runtime/info`, { headers: runtimeHeaders() });
    if (response.ok) runtimeInfo = await response.json();
    return runtimeInfo;
  } catch {
    return runtimeInfo;
  }
});
ipcMain.handle("market:get-catalog", async (_event, query = "") => {
  if (!marketService) throw new Error("Plugin Market is unavailable");
  return marketService.catalog(String(query ?? ""));
});
ipcMain.handle("market:refresh", async () => {
  if (!marketService) throw new Error("Plugin Market is unavailable");
  return marketService.refreshCatalog();
});
ipcMain.handle("market:install", async (_event, request = {}) => {
  if (!marketService) throw new Error("Plugin Market is unavailable");
  return marketService.install(String(request.pluginId ?? ""), String(request.version ?? ""), {
    onProgress: (progress) => {
      if (!mainWindow?.isDestroyed()) mainWindow.webContents.send("market:progress", progress);
    },
  });
});
ipcMain.handle("market:cancel", (_event, operationId) => marketService?.cancel(String(operationId)) ?? false);
ipcMain.handle("market:get-operation", (_event, operationId) => marketService?.operation(String(operationId)));
ipcMain.handle("market:retry", async (_event, operationId) => {
  if (!marketService) throw new Error("Plugin Market is unavailable");
  return marketService.retry(String(operationId), {
    onProgress: (progress) => {
      if (!mainWindow?.isDestroyed()) mainWindow.webContents.send("market:progress", progress);
    },
  });
});
async function retainedLogSources() {
  const { dataRoot } = managedPaths();
  const sources = [{ source: "runtime", filePath: path.join(dataRoot, "_runtime", "logs", "runtime.log") }];
  try {
    for (const entry of await readdir(dataRoot, { withFileTypes: true })) {
      if (entry.isDirectory() && entry.name !== "_runtime") {
        sources.push({ source: `plugin:${entry.name}`, filePath: path.join(dataRoot, entry.name, "logs", "plugin.log") });
      }
    }
  } catch (error) { if (error?.code !== "ENOENT") throw error; }
  return sources;
}

async function queryLogPage(request = {}) {
  return logService.query({ ...request, sources: await retainedLogSources() });
}

async function collectLogEntries(filters = {}) {
  const entries = [];
  let cursor;
  do {
    const page = await queryLogPage({ filters, cursor, limit: 200 });
    entries.push(...page.entries);
    cursor = page.nextCursor;
  } while (cursor);
  return entries;
}

ipcMain.handle("logs:query", async (_event, request = {}) => {
  if (!logService) throw new Error("Host logs are not initialized");
  logQueryCount += 1;
  try {
    return { ok: true, page: await queryLogPage(request) };
  } catch (error) {
    if (error?.code === "INVALID_LOG_CURSOR") return { ok: false, error: { code: error.code, message: error.message } };
    throw error;
  }
});
ipcMain.handle("logs:copy-entry", async (_event, id) => {
  const entry = (await collectLogEntries()).find((candidate) => candidate.id === String(id));
  if (!entry) throw new Error("Log entry is no longer retained");
  clipboard.writeText(serializeLogEntries([entry]));
  return { count: 1 };
});
ipcMain.handle("logs:copy-filtered", async (_event, filters = {}) => {
  const entries = await collectLogEntries(filters);
  clipboard.writeText(serializeLogEntries(entries));
  return { count: entries.length };
});
ipcMain.handle("logs:export-filtered", async (_event, filters = {}) => {
  const entries = await collectLogEntries(filters);
  let filePath = process.env.INFOLENS_TEST_EXPORT_PATH ? path.resolve(process.env.INFOLENS_TEST_EXPORT_PATH) : undefined;
  if (!filePath) {
    const result = await dialog.showSaveDialog(mainWindow, {
      title: "Export filtered logs",
      defaultPath: `infolens-logs-${new Date().toISOString().slice(0, 10)}.jsonl`,
      filters: [{ name: "JSON Lines", extensions: ["jsonl"] }],
    });
    if (result.canceled || !result.filePath) return { canceled: true, count: 0 };
    filePath = result.filePath;
  }
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, serializeLogEntries(entries), "utf8");
  return { canceled: false, count: entries.length };
});
ipcMain.handle("plugin:select-folder", async () => {
  if (process.env.INFOLENS_TEST_CONTROL === "1" && process.env.INFOLENS_TEST_INSTALL_PATH) {
    return path.resolve(process.env.INFOLENS_TEST_INSTALL_PATH);
  }
  const result = await dialog.showOpenDialog(mainWindow, { title: "Install plugin", properties: ["openDirectory"] });
  return result.canceled ? null : result.filePaths[0];
});
ipcMain.handle("plugin:select-archive", async () => {
  if (process.env.INFOLENS_TEST_CONTROL === "1" && process.env.INFOLENS_TEST_IMPORT_ARCHIVE_PATH) {
    return path.resolve(process.env.INFOLENS_TEST_IMPORT_ARCHIVE_PATH);
  }
  const result = await dialog.showOpenDialog(mainWindow, {
    title: "Import plugin ZIP",
    properties: ["openFile"],
    filters: [{ name: "Plugin ZIP archives", extensions: ["zip"] }],
  });
  return result.canceled ? null : result.filePaths[0];
});
ipcMain.handle("clipboard:write-text", (_event, value) => { clipboard.writeText(String(value)); });
ipcMain.handle("daily-summary:download", async (_event, value = {}) => {
  const filename = String(value.filename ?? "");
  const text = String(value.text ?? "");
  if (!/^infolens-daily-summary-(?:(?:prompt|written)-)?\d{4}-\d{2}-\d{2}\.md$/u.test(filename)) throw new Error("Daily Summary filename is invalid");
  let filePath = process.env.INFOLENS_TEST_DAILY_SUMMARY_PATH ? path.resolve(process.env.INFOLENS_TEST_DAILY_SUMMARY_PATH) : undefined;
  if (!filePath) {
    const result = await dialog.showSaveDialog(mainWindow, {
      title: "Download Daily Summary",
      defaultPath: filename,
      filters: [{ name: "Markdown", extensions: ["md"] }],
    });
    if (result.canceled || !result.filePath) return { canceled: true };
    filePath = path.join(path.dirname(result.filePath), filename);
  }
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, text, "utf8");
  return { canceled: false, filename: filePath };
});
ipcMain.handle("plugin:remove", (_event, id) => removePlugin(String(id)));
ipcMain.handle("test:read-clipboard", () => {
  if (process.env.INFOLENS_TEST_CONTROL !== "1") throw new Error("Test control is disabled");
  return clipboard.readText();
});
ipcMain.handle("test:terminate-runtime", () => {
  if (process.env.INFOLENS_TEST_CONTROL !== "1") throw new Error("Test control is disabled");
  if (!runtimeProcess) throw new Error("Plugin Runtime is not running");
  runtimeProcess.kill();
});
ipcMain.handle("test:write-log", async (_event, message) => {
  if (process.env.INFOLENS_TEST_CONTROL !== "1") throw new Error("Test control is disabled");
  return logService.write({ level: "info", message: String(message) });
});
ipcMain.handle("test:log-query-count", () => {
  if (process.env.INFOLENS_TEST_CONTROL !== "1") throw new Error("Test control is disabled");
  return logQueryCount;
});

app.whenReady().then(async () => {
  installWorkspacePermissionHandlers();
  await initializeLogService();
  await initializeMarketService();
  await seedBundledPlugins();
  const initialRuntime = startRuntime();
  createWindow();
  try { await initialRuntime; publishRuntimeStatus("running", { info: runtimeInfo }); }
  catch (error) { publishRuntimeStatus("unavailable", { message: error instanceof Error ? error.message : String(error) }); restartRuntime(); }
});
app.on("window-all-closed", () => app.quit());
app.on("before-quit", (event) => {
  if (quitting) return;
  event.preventDefault();
  if (quitPromptActive) return;
  quitPromptActive = true;
  (async () => {
    let activeBatch = false;
    try {
      if (runtimeInfo?.origin) {
        const response = await fetch(`${runtimeInfo.origin}/runtime/batches/active`, { headers: runtimeHeaders() });
        if (response.ok) activeBatch = Boolean((await response.json()).batch);
      }
    } catch {}
    if (activeBatch) {
      const result = await dialog.showMessageBox(mainWindow, {
        type: "warning",
        title: "Batch refresh in progress",
        message: "Unfinished batch refresh work will stop when Infolens exits.",
        buttons: ["Keep working", "Exit Infolens"],
        defaultId: 0,
        cancelId: 0,
      });
      if (result.response !== 1) {
        quitPromptActive = false;
        return;
      }
    }
    quitting = true;
    await stopRuntime("APPLICATION_EXIT");
    await rm(managedPaths().batchStatePath, { force: true });
    app.exit(0);
  })().catch((error) => {
    quitPromptActive = false;
    console.error(error);
  });
});
