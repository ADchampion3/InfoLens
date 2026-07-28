import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";

const root = path.resolve(import.meta.dirname, "..");
const profile = path.join(root, ".infolens-live", "sprint3");
await mkdir(profile, { recursive: true });

const {
  INFOLENS_BUNDLED_OPENCLI_ROOT: _bundledOpenCliRoot,
  INFOLENS_TEST_OPENCLI_STATE: _testOpenCliState,
  ...baseEnvironment
} = process.env;
const runtime = spawn(process.execPath, [path.join(root, "packages/plugin-runtime/src/server.mjs")], {
  cwd: root,
  env: {
    ...baseEnvironment,
    INFOLENS_PROJECT_ROOT: root,
    INFOLENS_PLUGIN_DATA_ROOT: path.join(profile, "data"),
    INFOLENS_RUNTIME_PORT: "0",
  },
  stdio: ["pipe", "pipe", "inherit"],
});
const lines = readline.createInterface({ input: runtime.stdout });
let origin;
for await (const line of lines) {
  const message = JSON.parse(line);
  if (message.type === "runtime-ready") {
    origin = message.origin;
    break;
  }
}

const npmCli = path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
const vite = spawn(process.execPath, [npmCli, "run", "dev:web", "--", "--host", "127.0.0.1", "--port", "4174", "--strictPort"], {
  cwd: root,
  stdio: "inherit",
  windowsHide: true,
});
const liveUrl = `http://127.0.0.1:4174/?runtimeOrigin=${encodeURIComponent(origin)}`;
await writeFile(path.join(profile, "url.txt"), liveUrl);
process.stdout.write(`Live Sprint 3 preview: ${liveUrl}\n`);

let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  vite.kill();
  runtime.stdin.write("shutdown\n");
}
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
runtime.on("exit", () => { vite.kill(); process.exit(0); });
vite.on("exit", () => { if (!stopping) runtime.stdin.write("shutdown\n"); });
