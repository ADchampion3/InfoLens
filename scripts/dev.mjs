import { spawn } from "node:child_process";
import { createServer } from "node:net";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function portIsOpen(port) {
  return new Promise((resolve) => {
    const socket = createServer();
    socket.once("error", () => resolve(true));
    socket.once("listening", () => socket.close(() => resolve(false)));
    socket.listen(port, "127.0.0.1");
  });
}

let rendererPort = 5173;
while (await portIsOpen(rendererPort)) rendererPort += 1;

const processes = new Set();
let stopping = false;

function start(command, args, extraEnv = {}) {
  const child = spawn(command, args, {
    cwd: projectRoot,
    env: { ...process.env, ...extraEnv },
    shell: process.platform === "win32",
    stdio: "inherit",
  });
  processes.add(child);
  child.once("exit", (code) => {
    processes.delete(child);
    if (!stopping && code !== 0) shutdown(code ?? 1);
  });
  return child;
}

function shutdown(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of processes) child.kill();
  setTimeout(() => process.exit(code), 250).unref();
}

process.on("SIGINT", () => shutdown());
process.on("SIGTERM", () => shutdown());

start("npm", ["run", "dev:web", "--", "--port", String(rendererPort), "--strictPort"]);

const waitForRenderer = async () => {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${rendererPort}`);
      if (response.ok) return;
    } catch {
      // The Vite server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Renderer dev server did not start");
};

await waitForRenderer();
start(
  path.join(projectRoot, "node_modules", ".bin", process.platform === "win32" ? "electron.cmd" : "electron"),
  ["."],
  { INFOLENS_RENDERER_URL: `http://127.0.0.1:${rendererPort}` },
);
