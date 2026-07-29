const { app, BrowserWindow, clipboard, dialog, ipcMain } = require("electron");
const { spawn } = require("node:child_process");
const { mkdir, readFile, rename, rm, writeFile } = require("node:fs/promises");
const path = require("node:path");
const readline = require("node:readline");

const projectRoot = path.resolve(__dirname, "../..");
let runtimeProcess;
let runtimeInfo;
let mainWindow;
let quitting = false;
let restarting = false;
let suppressRestart = false;

function publishRuntimeStatus(status, details = {}) {
  if (!mainWindow?.isDestroyed()) mainWindow.webContents.send("runtime:status", { status, ...details });
}

function startRuntime() {
  return new Promise((resolve, reject) => {
    const runtimeEntry = path.join(projectRoot, "packages", "plugin-runtime", "src", "server.mjs");
    runtimeProcess = spawn(process.execPath, [runtimeEntry], {
      cwd: projectRoot,
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: "1",
        INFOLENS_PROJECT_ROOT: projectRoot,
        INFOLENS_RUNTIME_PORT: "0",
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
          resolve(message);
        }
      } catch {
        console.log(`[runtime] ${line}`);
      }
    });

    runtimeProcess.stderr.on("data", (chunk) => console.error(`[runtime] ${chunk}`));
    runtimeProcess.once("error", reject);
    runtimeProcess.once("exit", () => {
      runtimeProcess = undefined;
      runtimeInfo = undefined;
      if (!quitting && !suppressRestart) restartRuntime();
    });
  });
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

function stopRuntime() {
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
    child.stdin.write("shutdown\n");
    child.stdin.end();
  });
}

function managedPaths() {
  const pluginsRoot = path.resolve(process.env.INFOLENS_PLUGINS_ROOT ?? path.join(projectRoot, "plugins"));
  const dataRoot = path.resolve(process.env.INFOLENS_PLUGIN_DATA_ROOT ?? path.join(projectRoot, ".infolens-data", "plugins"));
  const hostStatePath = path.resolve(process.env.INFOLENS_HOST_STATE_PATH ?? path.join(path.dirname(dataRoot), "host-state.json"));
  return { pluginsRoot, dataRoot, hostStatePath };
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
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  await rename(temporary, filePath);
}

async function removePlugin(id) {
  if (!runtimeInfo?.origin) throw new Error("Plugin services are unavailable");
  const record = runtimeInfo.plugins?.find((plugin) => plugin.id === id)
    ?? runtimeInfo.rejectedPlugins?.find((plugin) => plugin.id === id || plugin.package === id);
  if (!record?.packagePath) throw new Error(`Plugin '${id}' is not installed`);
  const response = await fetch(`${runtimeInfo.origin}/runtime/plugins/${encodeURIComponent(id)}/remove`, { method: "DELETE" });
  if (response.ok) return;
  const failure = await response.json();
  if (failure.code !== "RUNTIME_RESTART_REQUIRED") throw new Error(failure.error ?? "Plugin removal failed");

  const { pluginsRoot, dataRoot, hostStatePath } = managedPaths();
  const packagePath = path.resolve(record.packagePath);
  const dataPath = path.resolve(dataRoot, record.id ?? id);
  assertManagedPath(pluginsRoot, packagePath);
  assertManagedPath(dataRoot, dataPath);
  suppressRestart = true;
  publishRuntimeStatus("restarting");
  await stopRuntime();
  await rm(packagePath, { recursive: true, force: true });
  await rm(dataPath, { recursive: true, force: true });
  await removeHostStatePlugin(hostStatePath, record.id ?? id);
  suppressRestart = false;
  const info = await startRuntime();
  publishRuntimeStatus("running", { info });
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
  if (!runtimeInfo?.origin) return runtimeInfo;
  try {
    const response = await fetch(`${runtimeInfo.origin}/runtime/info`);
    if (response.ok) runtimeInfo = await response.json();
    return runtimeInfo;
  } catch {
    return runtimeInfo;
  }
});
ipcMain.handle("plugin:select-folder", async () => {
  const result = await dialog.showOpenDialog(mainWindow, { title: "Install plugin", properties: ["openDirectory"] });
  return result.canceled ? null : result.filePaths[0];
});
ipcMain.handle("clipboard:write-text", (_event, value) => { clipboard.writeText(String(value)); });
ipcMain.handle("plugin:remove", (_event, id) => removePlugin(String(id)));

app.whenReady().then(async () => {
  createWindow();
  try { await startRuntime(); publishRuntimeStatus("running", { info: runtimeInfo }); }
  catch (error) { publishRuntimeStatus("unavailable", { message: error instanceof Error ? error.message : String(error) }); restartRuntime(); }
});
app.on("window-all-closed", () => app.quit());
app.on("before-quit", (event) => {
  quitting = true;
  if (!runtimeProcess) return;
  event.preventDefault();
  stopRuntime().finally(() => app.exit(0));
});
