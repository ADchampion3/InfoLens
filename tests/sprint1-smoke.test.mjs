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

test("Sprint 1 walking skeleton serves one active plugin end to end", async () => {
  const { child, message } = await startRuntime();
  try {
    assert.equal(message.plugins.length, 1);
    assert.equal(message.plugins[0].id, "hn");

    const health = await fetch(`${message.origin}/plugins/hn/health`).then((response) => response.json());
    assert.deepEqual(health, { pluginId: "hn", state: "running", badge: "8" });

    const workspaceResponse = await fetch(message.plugins[0].workspaceUrl);
    assert.equal(workspaceResponse.status, 200);
    assert.match(await workspaceResponse.text(), /Hacker News/);

    const summaryResponse = await fetch(`${message.plugins[0].apiBaseUrl}summary`);
    assert.equal(summaryResponse.status, 200);
    const summary = await summaryResponse.json();
    assert.equal(summary.source, "Hacker News");
    assert.ok(summary.stories.length >= 15);
  } finally {
    await stopRuntime(child);
  }

  assert.ok(child.exitCode !== null || child.signalCode !== null);
  await assert.rejects(fetch(`${message.origin}/runtime/health`));
});
