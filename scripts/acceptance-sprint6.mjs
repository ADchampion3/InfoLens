import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import { prepareSprint6Profile, profile, root, sprint6Environment } from "./sprint6-profile.mjs";

await prepareSprint6Profile();
const runtime = spawn(process.execPath, [path.join(root, "packages/plugin-runtime/src/server.mjs")], {
  cwd: root, env: { ...sprint6Environment(), INFOLENS_RUNTIME_PORT: "0" }, stdio: ["pipe", "pipe", "inherit"],
});
const lines = readline.createInterface({ input: runtime.stdout });
let origin;
for await (const line of lines) {
  const message = JSON.parse(line);
  if (message.type === "runtime-ready") { origin = message.origin; break; }
}
for (const plugin of ["hn", "github-trending", "zhihu-hot", "product-hunt"]) {
  const summary = await fetch(`${origin}/plugins/${plugin}/api/summary`).then((response) => response.json());
  const empty = summary.stories?.length === 0 || summary.repositories?.length === 0 || summary.questions?.length === 0 || summary.products?.length === 0;
  if (empty) await fetch(`${origin}/plugins/${plugin}/api/refresh`, { method: "POST" });
}
const npmCli = path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
const vite = spawn(process.execPath, [npmCli, "run", "dev:web", "--", "--host", "127.0.0.1", "--port", "4176", "--strictPort"], { cwd: root, stdio: "inherit", windowsHide: true });
const url = `http://127.0.0.1:4176/?runtimeOrigin=${encodeURIComponent(origin)}`;
await writeFile(path.join(profile, "url.txt"), url, "utf8");
process.stdout.write(`Sprint 6 acceptance preview: ${url}\nInstall fixture: ${path.join(root, "tests", "fixtures", "sprint6", "installable-plugin")}\n`);
let stopping = false;
function stop() { if (stopping) return; stopping = true; vite.kill(); runtime.stdin.write("shutdown\n"); }
process.on("SIGINT", stop); process.on("SIGTERM", stop);
runtime.on("exit", () => { vite.kill(); process.exit(0); });
vite.on("exit", () => { if (!stopping) runtime.stdin.write("shutdown\n"); });
