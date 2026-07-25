const { app, BrowserWindow, ipcMain } = require("electron");
const { spawn } = require("node:child_process");
const path = require("node:path");
const readline = require("node:readline");

const projectRoot = path.resolve(__dirname, "../..");
let runtimeProcess;
let runtimeInfo;

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
    });
  });
}

function stopRuntime() {
  if (!runtimeProcess) return Promise.resolve();
  return new Promise((resolve) => {
    const child = runtimeProcess;
    const timeout = setTimeout(() => {
      if (!child.killed) child.kill();
      resolve();
    }, 2500);
    child.once("exit", () => {
      clearTimeout(timeout);
      resolve();
    });
    child.stdin.write("shutdown\n");
    child.stdin.end();
  });
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

  window.once("ready-to-show", () => window.show());
  const rendererUrl = process.env.INFOLENS_RENDERER_URL;
  if (rendererUrl) window.loadURL(rendererUrl);
  else window.loadFile(path.join(__dirname, "dist", "index.html"));
}

ipcMain.handle("runtime:get-info", () => runtimeInfo);

app.whenReady().then(async () => {
  await startRuntime();
  createWindow();
});
app.on("window-all-closed", () => app.quit());
app.on("before-quit", (event) => {
  if (!runtimeProcess) return;
  event.preventDefault();
  stopRuntime().finally(() => app.exit(0));
});
