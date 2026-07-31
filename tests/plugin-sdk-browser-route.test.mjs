import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import path from "node:path";
import readline from "node:readline";
import { test } from "node:test";

const root = path.resolve(import.meta.dirname, "..");

async function startRuntime() {
  const child = spawn(process.execPath, [path.join(root, "packages/plugin-runtime/src/server.mjs")], {
    cwd: root,
    env: { ...process.env, INFOLENS_PROJECT_ROOT: root, INFOLENS_RUNTIME_PORT: "0" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const lines = readline.createInterface({ input: child.stdout });
  const origin = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Runtime did not become ready")), 10_000);
    child.once("error", reject);
    lines.on("line", (line) => {
      try {
        const message = JSON.parse(line);
        if (message.type !== "runtime-ready") return;
        clearTimeout(timeout);
        resolve(message.origin);
      } catch {}
    });
  });
  return { child, lines, origin };
}

test("runtime exposes the plugin SDK as a browser module", async () => {
  const runtime = await startRuntime();
  try {
    const response = await fetch(`${runtime.origin}/runtime/plugin-sdk.js`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /^text\/javascript/);
    const source = await response.text();
    assert.match(source, /export function workspaceTheme/);
    assert.match(source, /export function observeWorkspaceTheme/);

    const tokenResponse = await fetch(`${runtime.origin}/runtime/plugin-sdk-tokens.css`);
    assert.equal(tokenResponse.status, 200);
    assert.match(tokenResponse.headers.get("content-type") ?? "", /^text\/css/);
    assert.match(await tokenResponse.text(), /--color-paper:/);

    const stylesResponse = await fetch(`${runtime.origin}/runtime/plugin-sdk-workspace.css`);
    assert.equal(stylesResponse.status, 200);
    assert.match(stylesResponse.headers.get("content-type") ?? "", /^text\/css/);
    assert.match(await stylesResponse.text(), /\.workspace-header/);
  } finally {
    runtime.lines.close();
    runtime.child.kill("SIGKILL");
    if (runtime.child.exitCode === null) await once(runtime.child, "exit");
  }
});
