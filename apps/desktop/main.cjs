const { app, BrowserWindow, clipboard, dialog, ipcMain, session, shell } = require("electron");
const { spawn } = require("node:child_process");
const { randomUUID } = require("node:crypto");
const { access, cp, mkdir, readdir, readFile, stat, writeFile } = require("node:fs/promises");
const { isIP } = require("node:net");
const path = require("node:path");
const readline = require("node:readline");
const { pathToFileURL } = require("node:url");
const { runtimeProxyEnvironment } = require("./runtime-network.cjs");

const projectRoot = path.resolve(__dirname, "../..");
const bundledPluginsRoot = path.join(projectRoot, "plugins");
const MAX_PLUGIN_ARCHIVE_BYTES = 128 * 1024 * 1024;
if (process.env.INFOLENS_USER_DATA_ROOT) app.setPath("userData", path.resolve(process.env.INFOLENS_USER_DATA_ROOT));
let runtimeProcess;
let runtimeInfo;
let runtimeStartPromise;
let daemonMonitor;
let daemonMonitorBusy = false;
let mainWindow;
let quitting = false;
let restarting = false;
let logService;
const applicationSessionId = process.env.INFOLENS_APPLICATION_SESSION_ID || randomUUID();

async function readPluginArchiveDigest(archivePath) {
  let value;
  try { value = await readFile(`${archivePath}.sha256`, "utf8"); }
  catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  }
  const digest = value.trim().split(/\s+/u)[0];
  if (!/^[0-9a-f]{64}$/iu.test(digest)) throw new Error("Plugin ZIP digest companion is invalid");
  return digest.toLowerCase();
}

function isLoopbackOrigin(value) {
  if (typeof value !== "string" || value.length > 2048) return false;
  let parsed;
  try { parsed = new URL(value); } catch { return false; }
  if (parsed.protocol !== "http:" || parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) return false;
  const hostname = parsed.hostname.replace(/^\[|\]$/gu, "");
  const version = isIP(hostname);
  return (version === 4 && hostname.startsWith("127.")) || (version === 6 && hostname === "::1");
}

function trustedWorkspacePermission(webContents, requestingUrl) {
  if (!runtimeInfo?.origin || typeof requestingUrl !== "string") return false;
  let parsed;
  try { parsed = new URL(requestingUrl); } catch { return false; }
  if (parsed.origin !== runtimeInfo.origin || !/^\/plugins\/[^/]+\/workspace(?:\/|$)/.test(parsed.pathname)) return false;
  let pluginId;
  try { pluginId = decodeURIComponent(parsed.pathname.split("/")[2] ?? ""); } catch { return false; }
  if (!Array.isArray(runtimeInfo.plugins) || !runtimeInfo.plugins.some((plugin) => plugin.id === pluginId)) return false;
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
  const defaultDaemonRoot = app.isPackaged
    ? path.join(
      process.platform === "win32"
        ? (process.env.LOCALAPPDATA || process.env.APPDATA || profileRoot)
        : (process.env.XDG_DATA_HOME || path.join(app.getPath("home"), ".local", "share")),
      "Infolens",
      "daemon",
    )
    : path.join(profileRoot, "daemon");
  const daemonRoot = path.resolve(process.env.INFOLENS_DAEMON_DATA_ROOT ?? defaultDaemonRoot);
  const pluginsRoot = path.resolve(process.env.INFOLENS_PLUGINS_ROOT ?? (app.isPackaged ? path.join(daemonRoot, "plugins") : bundledPluginsRoot));
  const dataRoot = path.resolve(process.env.INFOLENS_PLUGIN_DATA_ROOT ?? path.join(daemonRoot, "plugin-data"));
  const hostStatePath = path.resolve(process.env.INFOLENS_HOST_STATE_PATH ?? path.join(daemonRoot, "host-state.json"));
  const hostLogsRoot = path.resolve(process.env.INFOLENS_HOST_LOG_ROOT ?? path.join(daemonRoot, "logs"));
  const adapterRegistryRoot = path.resolve(process.env.INFOLENS_ADAPTER_REGISTRY_ROOT ?? path.join(daemonRoot, "opencli-adapters"));
  return { daemonRoot, pluginsRoot, dataRoot, hostStatePath, hostLogsRoot, adapterRegistryRoot };
}

async function initializeLogService() {
  const modulePath = path.join(projectRoot, "packages", "log-service", "src", "index.mjs");
  const logModule = await import(pathToFileURL(modulePath).href);
  const { createLogService } = logModule;
  logService = createLogService({ root: managedPaths().hostLogsRoot, sessionId: randomUUID() });
  await logService.write({ level: "info", message: "Host Shell started" });
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

function stopDaemonMonitor() {
  if (daemonMonitor) clearInterval(daemonMonitor);
  daemonMonitor = undefined;
  daemonMonitorBusy = false;
}

function startDaemonMonitor(origin) {
  if (!isLoopbackOrigin(origin)) return;
  stopDaemonMonitor();
  daemonMonitor = setInterval(async () => {
    if (quitting || runtimeProcess || daemonMonitorBusy) return;
    daemonMonitorBusy = true;
    try {
      const response = await fetch(`${origin}/api/v1/health`);
      if (!response.ok) throw new Error(`Daemon health returned ${response.status}`);
    } catch {
      stopDaemonMonitor();
      runtimeInfo = undefined;
      restartRuntime();
    } finally {
      daemonMonitorBusy = false;
    }
  }, 1_000);
  daemonMonitor.unref?.();
}

async function discoverExistingDaemon() {
  const { daemonRoot } = managedPaths();
  const modulePath = path.join(projectRoot, "packages", "plugin-runtime", "src", "daemon-state.mjs");
  try {
    const { daemonPaths, loadDaemonCredentials, readDaemonDiscovery } = await import(pathToFileURL(modulePath).href);
    const paths = daemonPaths(daemonRoot, { ...process.env, INFOLENS_DAEMON_DATA_ROOT: daemonRoot });
    const record = await readDaemonDiscovery(paths);
    if (!record?.origin || !isLoopbackOrigin(record.origin)) return undefined;
    const health = await fetch(`${record.origin}/api/v1/health`);
    if (!health.ok) return undefined;
    const credentials = await loadDaemonCredentials(paths);
    const infoResponse = await fetch(`${record.origin}/api/v1/info`, { headers: { authorization: `Bearer ${credentials.bearerToken}` } });
    if (!infoResponse.ok) return undefined;
    const info = await infoResponse.json();
    startDaemonMonitor(record.origin);
    return info;
  } catch {
    return undefined;
  }
}

async function startRuntimeProcess() {
  const existing = await discoverExistingDaemon();
  if (existing) {
    runtimeInfo = existing;
    await logService?.write({ level: "info", message: "Existing Plugin Runtime daemon discovered" });
    return existing;
  }
  stopDaemonMonitor();
  await logService?.write({ level: "info", message: "Plugin Runtime starting" });
  let proxyRules = "DIRECT";
  try { proxyRules = await session.defaultSession.resolveProxy("https://github.com"); } catch {}
  const networkEnvironment = runtimeProxyEnvironment(process.env, proxyRules);
  const bundledPluginIds = (await readdir(bundledPluginsRoot, { withFileTypes: true }).catch(() => [])).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  const runtimeEnvironment = { ...process.env, ...networkEnvironment };
  delete runtimeEnvironment.INFOLENS_DAEMON_BEARER_TOKEN;
  return new Promise((resolve, reject) => {
    const runtimeEntry = path.join(projectRoot, "packages", "plugin-runtime", "src", "server.mjs");
    const { daemonRoot, pluginsRoot, dataRoot, hostStatePath, adapterRegistryRoot } = managedPaths();
    runtimeProcess = spawn(process.execPath, [runtimeEntry], {
      cwd: projectRoot,
      env: {
        ...runtimeEnvironment,
        ELECTRON_RUN_AS_NODE: "1",
        INFOLENS_PROJECT_ROOT: projectRoot,
        INFOLENS_DAEMON_MODE: "1",
        INFOLENS_DAEMON_DATA_ROOT: daemonRoot,
        INFOLENS_PLUGINS_ROOT: pluginsRoot,
        INFOLENS_PLUGIN_DATA_ROOT: dataRoot,
        INFOLENS_HOST_STATE_PATH: hostStatePath,
        INFOLENS_BATCH_STATE_PATH: path.join(daemonRoot, "task-state.json"),
        INFOLENS_ADAPTER_REGISTRY_ROOT: adapterRegistryRoot,
        INFOLENS_DAEMON_HOST_WEB_ROOT: path.join(projectRoot, "apps", "desktop", "dist"),
        INFOLENS_APPLICATION_SESSION_ID: applicationSessionId,
        INFOLENS_BUNDLED_PLUGIN_IDS: JSON.stringify(bundledPluginIds),
        INFOLENS_RUNTIME_PORT: process.env.INFOLENS_RUNTIME_PORT ?? "0",
      },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      detached: true,
    });
    const lines = readline.createInterface({ input: runtimeProcess.stdout });
    const timeout = setTimeout(() => reject(new Error("Plugin Runtime did not become ready")), 10000);

    lines.on("line", (line) => {
      try {
        const message = JSON.parse(line);
        if (message.type === "runtime-ready") {
          if (!isLoopbackOrigin(message.origin)) {
            clearTimeout(timeout);
            runtimeProcess.kill();
            reject(Object.assign(new Error("Plugin Runtime origin must be a loopback HTTP origin"), { code: "DAEMON_ORIGIN_NOT_LOOPBACK" }));
            return;
          }
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
      stopDaemonMonitor();
      runtimeProcess = undefined;
      runtimeInfo = undefined;
      logService?.write({ level: quitting ? "info" : "warn", message: `Plugin Runtime exited code=${code ?? "none"} signal=${signal ?? "none"}` }).catch(console.error);
      if (!quitting) restartRuntime();
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

function createWindow(daemonOrigin) {
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
  window.webContents.setWindowOpenHandler(({ url }) => {
    try {
      const parsed = new URL(url);
      if (parsed.protocol === "http:" || parsed.protocol === "https:") void shell.openExternal(parsed.toString()).catch(() => {});
    } catch {}
    return { action: "deny" };
  });

  window.once("ready-to-show", () => window.show());
  const rendererUrl = process.env.INFOLENS_RENDERER_URL;
  if (rendererUrl) window.loadURL(rendererUrl);
  else if (isLoopbackOrigin(daemonOrigin)) window.loadURL(`${daemonOrigin}/`);
  else window.loadFile(path.join(__dirname, "dist", "index.html"));
}

ipcMain.handle("runtime:get-info", async () => {
  if (!runtimeInfo?.origin && runtimeStartPromise) {
    try { await runtimeStartPromise; } catch {}
  }
  if (!runtimeInfo?.origin) return runtimeInfo;
  if (!isLoopbackOrigin(runtimeInfo.origin)) return runtimeInfo;
  try {
    const response = await fetch(`${runtimeInfo.origin}/api/v1/session/bootstrap`, { method: "POST" });
    if (response.ok) {
      let token = runtimeInfo.runtimeToken;
      if (!token) {
        const modulePath = path.join(projectRoot, "packages", "plugin-runtime", "src", "daemon-state.mjs");
        const { daemonPaths, loadDaemonCredentials } = await import(pathToFileURL(modulePath).href);
        const credentials = await loadDaemonCredentials(daemonPaths(managedPaths().daemonRoot, { ...process.env, INFOLENS_DAEMON_DATA_ROOT: managedPaths().daemonRoot }));
        token = credentials.bearerToken;
      }
      const infoResponse = await fetch(`${runtimeInfo.origin}/api/v1/info`, { headers: token ? { authorization: `Bearer ${token}` } : {} });
      if (infoResponse.ok) runtimeInfo = await infoResponse.json();
    }
    return runtimeInfo;
  } catch {
    return runtimeInfo;
  }
});
ipcMain.handle("runtime:start", async () => {
  const info = await startRuntime();
  runtimeInfo = info;
  if (info?.origin) startDaemonMonitor(info.origin);
  publishRuntimeStatus("running", { info });
  return info;
});
ipcMain.handle("plugin:select-archive", async () => {
  if (process.env.INFOLENS_TEST_CONTROL === "1" && process.env.INFOLENS_TEST_IMPORT_ARCHIVE_PATH) {
    const archivePath = path.resolve(process.env.INFOLENS_TEST_IMPORT_ARCHIVE_PATH);
    const details = await stat(archivePath);
    if (!details.isFile() || details.size > MAX_PLUGIN_ARCHIVE_BYTES) throw new Error("Plugin ZIP is unavailable or exceeds the size limit");
    const bytes = await readFile(archivePath);
    return { fileName: path.basename(archivePath), data: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), expectedSha256: await readPluginArchiveDigest(archivePath) };
  }
  const result = await dialog.showOpenDialog(mainWindow, {
    title: "Import plugin ZIP",
    properties: ["openFile"],
    filters: [{ name: "Plugin ZIP archives", extensions: ["zip"] }],
  });
  if (result.canceled) return null;
  const archivePath = result.filePaths[0];
  const details = await stat(archivePath);
  if (!details.isFile() || details.size > MAX_PLUGIN_ARCHIVE_BYTES) throw new Error("Plugin ZIP is unavailable or exceeds the size limit");
  const bytes = await readFile(archivePath);
  return { fileName: path.basename(archivePath), data: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), expectedSha256: await readPluginArchiveDigest(archivePath) };
});
ipcMain.handle("clipboard:write-text", (_event, value) => { clipboard.writeText(String(value)); });
ipcMain.handle("daily-summary:download", async (_event, value = {}) => {
  const filename = String(value.filename ?? "");
  const text = String(value.text ?? "");
  if (!/^(?:infolens-daily-summary-(?:(?:prompt|written)-)?\d{4}-\d{2}-\d{2}\.md|infolens-logs-\d{4}-\d{2}-\d{2}\.jsonl)$/u.test(filename)) throw new Error("Download filename is invalid");
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

app.whenReady().then(async () => {
  installWorkspacePermissionHandlers();
  await initializeLogService();
  await seedBundledPlugins();
  const initialRuntime = startRuntime();
  let initialInfo;
  try { initialInfo = await initialRuntime; }
  catch (error) { console.error(error); }
  createWindow(initialInfo?.origin);
  if (initialInfo) publishRuntimeStatus("running", { info: initialInfo });
  else { publishRuntimeStatus("unavailable", { message: "Plugin services did not start" }); restartRuntime(); }
});
app.on("window-all-closed", () => app.quit());
app.on("before-quit", () => { quitting = true; stopDaemonMonitor(); });
