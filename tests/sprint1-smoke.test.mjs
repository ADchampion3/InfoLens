import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import readline from "node:readline";
import { test } from "node:test";

const projectRoot = path.resolve(import.meta.dirname, "..");

function startRuntime() {
  const child = spawn(process.execPath, [path.join(projectRoot, "packages/plugin-runtime/src/server.mjs")], {
    cwd: projectRoot,
    env: { ...process.env, INFOLENS_PROJECT_ROOT: projectRoot, INFOLENS_RUNTIME_PORT: "0" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const lines = readline.createInterface({ input: child.stdout });
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Runtime start timed out")), 5000);
    child.once("error", reject);
    child.stderr.on("data", (chunk) => process.stderr.write(chunk));
    lines.on("line", (line) => {
      const message = JSON.parse(line);
      if (message.type === "runtime-ready") {
        clearTimeout(timeout);
        resolve({ child, message });
      }
    });
  });
}

function stopRuntime(child) {
  return new Promise((resolve) => {
    child.once("exit", resolve);
    child.kill();
  });
}

test("Sprint 1 walking skeleton remains available after later bundled plugins are added", async () => {
  const { child, message } = await startRuntime();
  try {
    assert.ok(message.plugins.length >= 1);
    const hnPlugin = message.plugins.find((plugin) => plugin.id === "hn");
    assert.ok(hnPlugin);

    const health = await fetch(`${message.origin}/plugins/hn/health`).then((response) => response.json());
    assert.equal(health.pluginId, "hn");
    assert.equal(health.state, "ready");
    assert.match(health.badge, /^\d+$/);

    const workspaceResponse = await fetch(hnPlugin.workspaceUrl);
    assert.equal(workspaceResponse.status, 200);
    assert.match(await workspaceResponse.text(), /Hacker News/);

    const summaryResponse = await fetch(`${hnPlugin.apiBaseUrl}summary`);
    assert.equal(summaryResponse.status, 200);
    const summary = await summaryResponse.json();
    assert.equal(summary.source, "Hacker News");
    assert.ok(Array.isArray(summary.stories));
  } finally {
    await stopRuntime(child);
  }

  assert.ok(child.exitCode !== null || child.signalCode !== null);
  await assert.rejects(fetch(`${message.origin}/runtime/health`));
});
