import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { test } from "node:test";
import { healthResponse, pluginApiUrl, pluginHealthUrl, pluginWorkspaceUrl } from "@infolens/plugin-sdk";

const projectRoot = path.resolve(import.meta.dirname, "..");
const fixturesRoot = path.join(import.meta.dirname, "fixtures", "sprint2");

async function materializePlugins(root) {
  const manifestsRoot = path.join(fixturesRoot, "manifests");
  const names = await readdir(manifestsRoot);
  for (const name of names) {
    const manifest = JSON.parse(await readFile(path.join(manifestsRoot, name), "utf8"));
    const packageRoot = path.join(root, path.basename(name, ".json"));
    await mkdir(path.join(packageRoot, "backend"), { recursive: true });
    await mkdir(path.join(packageRoot, "web"), { recursive: true });
    const backendFixture = manifest.fixtureBackend ?? "valid";
    await cp(path.join(fixturesRoot, "backends", `${backendFixture}.mjs`), path.join(packageRoot, "backend", "index.mjs"));
    await writeFile(path.join(packageRoot, "web", "index.html"), `<!doctype html><title>${manifest.name}</title>`, "utf8");
    await writeFile(path.join(packageRoot, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
  }
}

function startRuntime({ pluginsRoot, dataRoot }) {
  const child = spawn(process.execPath, [path.join(projectRoot, "packages/plugin-runtime/src/server.mjs")], {
    cwd: projectRoot,
    env: {
      ...process.env,
      INFOLENS_PROJECT_ROOT: projectRoot,
      INFOLENS_PLUGINS_ROOT: pluginsRoot,
      INFOLENS_PLUGIN_DATA_ROOT: dataRoot,
      INFOLENS_BUNDLED_OPENCLI_ROOT: path.join(fixturesRoot, "opencli"),
      INFOLENS_PLUGIN_LOG_MAX_BYTES: "700",
      INFOLENS_PLUGIN_LOG_MAX_FILES: "3",
      INFOLENS_RUNTIME_PORT: "0",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const messages = [];
  const errors = [];
  const lines = readline.createInterface({ input: child.stdout });
  child.stderr.on("data", (chunk) => errors.push(String(chunk)));
  const ready = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Runtime start timed out: ${errors.join("")}`)), 5000);
    child.once("error", reject);
    child.once("exit", (code) => reject(new Error(`Runtime exited before ready with ${code}: ${errors.join("")}`)));
    lines.on("line", (line) => {
      const message = JSON.parse(line);
      messages.push(message);
      if (message.type === "runtime-ready") {
        clearTimeout(timeout);
        resolve({ child, message, messages, errors });
      }
    });
  });
  return ready;
}

async function stopRuntime(child) {
  if (child.exitCode !== null) return;
  const exited = new Promise((resolve) => child.once("exit", resolve));
  child.stdin.write("shutdown\n");
  child.stdin.end();
  await exited;
}

test("SDK workspace URL helpers retain the Runtime-owned plugin boundary", () => {
  assert.equal(pluginHealthUrl("http://127.0.0.1:1234", "demo"), "http://127.0.0.1:1234/plugins/demo/health");
  assert.equal(pluginWorkspaceUrl("http://127.0.0.1:1234", "demo"), "http://127.0.0.1:1234/plugins/demo/workspace/");
  assert.equal(pluginApiUrl("http://127.0.0.1:1234", "demo", "/items"), "http://127.0.0.1:1234/plugins/demo/api/items");
  assert.deepEqual(healthResponse("refreshing", { badge: "2" }), { state: "refreshing", badge: "2" });
});

test("Sprint 2 contracts execute through the actual Plugin Runtime", async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "infolens-sprint2-"));
  const pluginsRoot = path.join(temporaryRoot, "plugins");
  const dataRoot = path.join(temporaryRoot, "data");
  await mkdir(pluginsRoot, { recursive: true });
  await materializePlugins(pluginsRoot);
  const { child, message, messages } = await startRuntime({ pluginsRoot, dataRoot });

  try {
    const activeById = new Map(message.plugins.map((plugin) => [plugin.id, plugin]));
    assert.equal(activeById.get("activation-failure").state, "failed");
    assert.equal(activeById.get("valid-contract").state, "ready");
    assert.equal(activeById.get("route-failure").state, "running");
    assert.equal(activeById.get("cleanup-failure").state, "running");

    const rejectionCodes = new Set(message.rejectedPlugins.map((plugin) => plugin.code));
    for (const code of [
      "INVALID_PACKAGE_STRUCTURE", "INCOMPATIBLE_CONTRACT", "INCOMPATIBLE_HOST", "INCOMPATIBLE_OPENCLI",
      "INVALID_OPENCLI_RANGE", "UNSUPPORTED_STRATEGY", "UNSUPPORTED_ACCESS", "UNSUPPORTED_OUTPUT", "UNAVAILABLE_COMMAND",
    ]) assert.ok(rejectionCodes.has(code), `Expected rejection code ${code}`);

    const origin = message.origin;
    const context = await fetch(`${origin}/plugins/valid-contract/api/context`).then((response) => response.json());
    assert.equal(context.pluginId, "valid-contract");
    assert.equal(context.hasLogger, true);
    assert.ok(context.resolvedDataPath.startsWith(context.dataDir));

    const coalesced = await fetch(`${origin}/plugins/valid-contract/api/coalesce`).then((response) => response.json());
    assert.equal(coalesced.samePromise, true);
    assert.equal(coalesced.executions, 1);
    assert.deepEqual(coalesced.results[0], coalesced.results[1]);

    const opencli = await fetch(`${origin}/plugins/valid-contract/api/opencli`).then((response) => response.json());
    assert.equal(opencli.bundled, true);
    assert.deepEqual(opencli.args, ["fixture", "read", "--limit", "2", "--output=json"]);

    await fetch(`${origin}/plugins/valid-contract/api/log`);
    const logFiles = await readdir(path.join(dataRoot, "valid-contract", "logs"));
    assert.ok(logFiles.includes("plugin.log"));
    assert.ok(logFiles.some((name) => name.startsWith("plugin.log.")), "Expected the bounded log to rotate");

    const routeFailure = await fetch(`${origin}/plugins/route-failure/api/fail`);
    assert.equal(routeFailure.status, 500);
    const failedHealth = await fetch(`${origin}/plugins/route-failure/health`);
    assert.equal(failedHealth.status, 503);
    assert.equal((await failedHealth.json()).failure.message, "fixture route exploded");
    const sibling = await fetch(`${origin}/plugins/cleanup-failure/api/ok`).then((response) => response.json());
    assert.equal(sibling.healthy, true);

    const taskFailure = await fetch(`${origin}/plugins/valid-contract/api/task-fail`);
    assert.equal(taskFailure.status, 500);
    assert.equal((await fetch(`${origin}/plugins/valid-contract/health`).then((response) => response.json())).state, "failed");
    assert.equal((await fetch(`${origin}/plugins/cleanup-failure/api/ok`).then((response) => response.json())).healthy, true);
    const undeclared = await fetch(`${origin}/plugins/valid-contract/api/undeclared`);
    assert.equal(undeclared.status, 500);
    assert.match((await undeclared.json()).error, /not declared/);

    const events = await fetch(`${origin}/runtime/events`).then((response) => response.json());
    assert.ok(events.events.some((event) => event.event === "task-coalesced" && event.pluginId === "valid-contract"));
    assert.ok(events.events.some((event) => event.event === "activation-failed" && event.pluginId === "activation-failure"));
    assert.ok(events.events.some((event) => event.event === "route-failed" && event.pluginId === "route-failure"));
  } finally {
    await stopRuntime(child);
    await rm(temporaryRoot, { recursive: true, force: true });
  }

  assert.ok(messages.some((event) => event.event === "cleanup-failed" && event.pluginId === "cleanup-failure"));
  assert.ok(messages.some((event) => event.event === "deactivated" && event.pluginId === "route-failure"));
});
