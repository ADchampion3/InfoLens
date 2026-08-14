import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { test } from "node:test";
import { observeWorkspaceTheme, workspaceTheme } from "@infolens/plugin-sdk";

const root = path.resolve(import.meta.dirname, "..");
const openCliRoot = path.join(root, "tests/fixtures/sprint2/opencli");
const providedOpenCliRoot = path.join(root, "tests/fixtures/sprint5/opencli");

async function packageFixture(packageRoot, id, { valid = true } = {}) {
  await mkdir(path.join(packageRoot, "backend"), { recursive: true });
  await mkdir(path.join(packageRoot, "web"), { recursive: true });
  const manifest = {
    id, name: id === "daily-reader" ? "Daily Reader" : "Existing Plugin", version: "1.0.0",
    contractVersion: "2", minHostVersion: "0.1.0",
    backend: { entry: "backend/index.mjs" }, ui: { entry: "web/index.html" },
    openCliAdapters: {},
    openCliCommands: { read: { adapter: "builtin", site: "fixture", command: ["fixture", "read"], strategy: "PUBLIC", access: "read", outputFormat: "json" } },
  };
  await writeFile(path.join(packageRoot, "manifest.json"), JSON.stringify(manifest, null, 2));
  await writeFile(path.join(packageRoot, "web/index.html"), "<!doctype html><title>Fixture</title>");
  if (valid) await writeFile(path.join(packageRoot, "backend/index.mjs"), `
    import { writeFile } from "node:fs/promises";
    export async function activate(context) {
      await writeFile(context.resolveDataPath("retained.txt"), "source record");
      await context.logger.info("fixture-ready", { cookie: "private-value", detail: "operational" });
      context.setHealth({ state: "ready", badge: "7", lastSuccessfulRefresh: "2026-07-29T08:00:00.000Z" });
      context.route("GET", "/summary", () => ({ ok: true }));
      return { deactivate() {} };
    }
  `);
}

async function packageProvidedFixture(packageRoot, id, adapterVersion) {
  await packageFixture(packageRoot, id);
  const manifestPath = path.join(packageRoot, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.openCliAdapters = {
    productHunt: { id: "io.infolens.producthunt", version: adapterVersion, path: "opencli-adapters/producthunt" },
  };
  manifest.openCliCommands = {
    today: { adapter: "productHunt", site: "infolens-producthunt", command: ["infolens-producthunt", "today"], strategy: "INTERCEPT", access: "read", outputFormat: "json" },
  };
  const adapterRoot = path.join(packageRoot, "opencli-adapters", "producthunt");
  await mkdir(adapterRoot, { recursive: true });
  await writeFile(path.join(adapterRoot, "opencli-plugin.json"), JSON.stringify({ name: "io.infolens.producthunt", version: adapterVersion, opencli: ">=1.8.6 <2.0.0" }));
  await writeFile(path.join(adapterRoot, "today.js"), `export const version = "${adapterVersion}";`);
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2));
}

function startRuntime(temporaryRoot, environment = {}) {
  const child = spawn(process.execPath, [path.join(root, "packages/plugin-runtime/src/server.mjs")], {
    cwd: root,
    env: {
      ...process.env,
      INFOLENS_PROJECT_ROOT: root,
      INFOLENS_PLUGINS_ROOT: path.join(temporaryRoot, "managed-plugins"),
      INFOLENS_PLUGIN_DATA_ROOT: path.join(temporaryRoot, "data", "plugins"),
      INFOLENS_HOST_STATE_PATH: path.join(temporaryRoot, "data", "host-state.json"),
      INFOLENS_BUNDLED_OPENCLI_ROOT: openCliRoot,
      INFOLENS_RUNTIME_PORT: "0",
      ...environment,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const errors = [];
  child.stderr.on("data", (chunk) => errors.push(String(chunk)));
  const lines = readline.createInterface({ input: child.stdout });
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Runtime timed out: ${errors.join("")}`)), 5_000);
    child.once("error", reject);
    child.once("exit", (code) => reject(new Error(`Runtime exited with ${code}: ${errors.join("")}`)));
    lines.on("line", (line) => {
      const message = JSON.parse(line);
      if (message.type === "runtime-ready") { clearTimeout(timeout); resolve({ child, info: message }); }
    });
  });
}

async function stopRuntime(child) {
  if (child.exitCode !== null) return;
  const exit = new Promise((resolve) => child.once("exit", resolve));
  child.stdin.write("shutdown\n");
  child.stdin.end();
  await exit;
}

async function request(origin, route, options) {
  const response = await fetch(`${origin}${route}`, options);
  const body = await response.json();
  return { response, body };
}

test("host state, package lifecycle, diagnostics, and removal run through Runtime", async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "infolens-sprint6-"));
  const installedRoot = path.join(temporaryRoot, "managed-plugins", "existing");
  const sourceRoot = path.join(temporaryRoot, "source-package");
  const rejectedRoot = path.join(temporaryRoot, "managed-plugins", "rejected-package");
  await packageFixture(installedRoot, "existing");
  await packageFixture(sourceRoot, "daily-reader");
  await packageFixture(rejectedRoot, "rejected-package", { valid: false });
  let running = await startRuntime(temporaryRoot);
  try {
    assert.equal(running.info.plugins.find(({ id }) => id === "existing").enabled, true, "new compatible packages start enabled");
    assert.equal(running.info.rejectedPlugins[0].code, "INVALID_PACKAGE_STRUCTURE");
    const origin = running.info.origin;

    const stateResult = await request(origin, "/runtime/host-state", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ theme: "dark", lastSelection: "existing" }) });
    assert.equal(stateResult.body.theme, "dark");
    assert.equal(stateResult.body.lastSelection, "existing");

    await request(origin, "/runtime/plugins/existing/enabled", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ enabled: false }) });
    const disabled = await request(origin, "/runtime/info");
    assert.equal(disabled.body.plugins.find(({ id }) => id === "existing").state, "disabled");

    const installed = await request(origin, "/runtime/plugins/install", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sourcePath: sourceRoot }) });
    assert.equal(installed.response.status, 201);
    assert.equal(installed.body.pluginId, "daily-reader");
    await access(path.join(temporaryRoot, "managed-plugins", "daily-reader", "manifest.json"));

    const duplicate = await request(origin, "/runtime/plugins/install", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sourcePath: sourceRoot }) });
    assert.equal(duplicate.response.status, 409);
    assert.equal(duplicate.body.code, "DUPLICATE_PLUGIN_ID");
    assert.match(duplicate.body.error, /remove the installed plugin first/);

    const diagnostics = await request(origin, "/runtime/plugins/daily-reader/diagnostics");
    assert.match(diagnostics.body.diagnostics, /fixture-ready/);
    assert.match(diagnostics.body.diagnostics, /\[REDACTED\]/);
    assert.doesNotMatch(diagnostics.body.diagnostics, /private-value|source record/);
    assert.match(diagnostics.body.diagnostics, /2026-07-29T08:00:00.000Z/);

    await request(origin, "/runtime/plugins/daily-reader/remove", { method: "DELETE" });
    await assert.rejects(access(path.join(temporaryRoot, "managed-plugins", "daily-reader")));
    await assert.rejects(access(path.join(temporaryRoot, "data", "plugins", "daily-reader")));
    const afterRemoval = await request(origin, "/runtime/info");
    assert(!afterRemoval.body.plugins.some(({ id }) => id === "daily-reader"));
    const runtimeLogRoot = path.join(temporaryRoot, "data", "plugins", "_runtime", "logs");
    const runtimeEntries = (await Promise.all((await readdir(runtimeLogRoot)).filter((name) => name.startsWith("runtime.log")).map((name) => readFile(path.join(runtimeLogRoot, name), "utf8"))))
      .flatMap((content) => content.trim().split(/\r?\n/).filter(Boolean).map(JSON.parse));
    for (const messages of [["plugin-install-started", "plugin-install-completed {\"pluginId\":\"daily-reader\"}"], ["plugin-removal-started {\"pluginId\":\"daily-reader\"}", "plugin-removal-completed {\"pluginId\":\"daily-reader\"}"]]) {
      const completed = runtimeEntries.find((entry) => entry.message === messages[1]);
      assert(completed?.operationId, `${messages[1]} did not have an operation ID`);
      assert.deepEqual(runtimeEntries.filter((entry) => entry.operationId === completed.operationId).map(({ message }) => message), messages);
    }
  } finally {
    await stopRuntime(running.child);
  }

  running = await startRuntime(temporaryRoot);
  try {
    assert.equal(running.info.hostState.theme, "dark");
    assert.equal(running.info.hostState.lastSelection, "existing");
    assert.equal(running.info.plugins.find(({ id }) => id === "existing").state, "disabled");
    JSON.parse(await readFile(path.join(temporaryRoot, "data", "host-state.json"), "utf8"));
  } finally {
    await stopRuntime(running.child);
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("SDK theme convention reads initial configuration and observes live updates", () => {
  assert.equal(workspaceTheme({ search: "?theme=dark" }), "dark");
  assert.equal(workspaceTheme({ search: "?theme=unsupported" }), "light");
  const target = new EventTarget();
  const themes = [];
  const stop = observeWorkspaceTheme((theme) => themes.push(theme), target);
  target.dispatchEvent(new MessageEvent("message", { data: { type: "infolens:theme", theme: "dark" } }));
  target.dispatchEvent(new MessageEvent("message", { data: { type: "other", theme: "light" } }));
  stop();
  target.dispatchEvent(new MessageEvent("message", { data: { type: "infolens:theme", theme: "light" } }));
  assert.deepEqual(themes, ["dark"]);
});

test("removal requests a Runtime restart before deleting a module that will not settle", async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "infolens-sprint6-timeout-"));
  const packageRoot = path.join(temporaryRoot, "managed-plugins", "stuck-plugin");
  await packageFixture(packageRoot, "stuck-plugin");
  await writeFile(path.join(packageRoot, "backend/index.mjs"), `export function activate(context) { context.setHealth({ state: "ready" }); return { deactivate() { return new Promise(() => {}); } }; }`);
  const running = await startRuntime(temporaryRoot, { INFOLENS_DEACTIVATION_GRACE_MS: "40" });
  try {
    const removal = await request(running.info.origin, "/runtime/plugins/stuck-plugin/remove", { method: "DELETE" });
    assert.equal(removal.response.status, 503);
    assert.equal(removal.body.code, "RUNTIME_RESTART_REQUIRED");
    await access(packageRoot);
    await access(path.join(temporaryRoot, "data", "plugins", "stuck-plugin"));
  } finally {
    const exit = new Promise((resolve) => running.child.once("exit", resolve));
    running.child.kill();
    await exit;
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("duplicate plugin ids are rejected before an existing Adapter Scope is changed", async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "infolens-sprint6-duplicate-scope-"));
  const firstRoot = path.join(temporaryRoot, "managed-plugins", "a-first");
  const duplicateRoot = path.join(temporaryRoot, "managed-plugins", "z-duplicate");
  await packageProvidedFixture(firstRoot, "shared-id", "1.0.0");
  await packageProvidedFixture(duplicateRoot, "shared-id", "2.0.0");
  const adapterRegistryRoot = path.join(temporaryRoot, "data", "opencli-adapters");
  const running = await startRuntime(temporaryRoot, {
    INFOLENS_BUNDLED_OPENCLI_ROOT: providedOpenCliRoot,
    INFOLENS_ADAPTER_REGISTRY_ROOT: adapterRegistryRoot,
  });
  try {
    assert.equal(running.info.plugins.filter(({ id }) => id === "shared-id").length, 1);
    assert.equal(running.info.rejectedPlugins.find(({ package: packageName }) => packageName === "z-duplicate")?.code, "DUPLICATE_PLUGIN_ID");
    const lock = JSON.parse(await readFile(path.join(adapterRegistryRoot, "scopes", "shared-id", "scope.lock.json"), "utf8"));
    assert.equal(lock.adapters[0].version, "1.0.0");
    await access(lock.adapters[0].path);
  } finally {
    await stopRuntime(running.child);
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("bundled OpenCLI receives Node-shaped arguments from an Electron-hosted Runtime", async () => {
  const electronExecutable = path.join(root, "node_modules", "electron", "dist", process.platform === "win32" ? "electron.exe" : "electron");
  const runner = path.join(root, "tests", "fixtures", "sprint6", "electron-adapter-runner.mjs");
  const child = spawn(electronExecutable, [runner], {
    cwd: root,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const code = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });
  assert.equal(code, 0, stderr);
  assert.deepEqual(JSON.parse(stdout).args, [
    "fixture", "read",
    "--window", "background",
    "--site-session", "ephemeral",
    "--keep-tab", "false",
    "-f", "json",
  ]);
});
