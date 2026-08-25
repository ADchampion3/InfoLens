import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import readline from "node:readline";
import { daemonPaths, loadDaemonCredentials, readDaemonDiscovery } from "../packages/plugin-runtime/src/daemon-state.mjs";

const root = path.resolve(".");
const serverEntry = path.join(root, "packages", "plugin-runtime", "src", "server.mjs");
const pluginRoot = path.join(root, "plugins");
const hostWebRoot = path.join(root, "apps", "desktop", "dist");
const children = new Set();

afterEach(async () => {
  const active = [...children].filter((child) => child.exitCode === null);
  for (const child of active) child.kill("SIGTERM");
  await Promise.all(active.map((child) => new Promise((resolve) => child.once("exit", resolve))));
  children.clear();
});

function environment(dataRoot) {
  return {
    ...process.env,
    INFOLENS_PROJECT_ROOT: root,
    INFOLENS_DAEMON_MODE: "1",
    INFOLENS_DAEMON_DATA_ROOT: dataRoot,
    INFOLENS_PLUGINS_ROOT: pluginRoot,
    INFOLENS_DAEMON_HOST_WEB_ROOT: hostWebRoot,
    INFOLENS_RUNTIME_PORT: "0",
    INFOLENS_APPLICATION_SESSION_ID: randomUUID(),
    INFOLENS_BUNDLED_PLUGIN_IDS: JSON.stringify(["hn", "juejin", "github-trending", "zhihu-hot", "product-hunt"]),
  };
}

async function start(dataRoot, extra = {}) {
  const child = spawn(process.execPath, [serverEntry], {
    cwd: root,
    env: { ...environment(dataRoot), ...extra },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  children.add(child);
  const errors = [];
  child.stderr.on("data", (chunk) => errors.push(String(chunk)));
  const lines = readline.createInterface({ input: child.stdout });
  const message = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`daemon did not become ready: ${errors.join("")}`)), 10_000);
    child.once("error", reject);
    child.once("exit", (code, signal) => reject(new Error(`daemon exited before ready: ${code ?? signal}: ${errors.join("")}`)));
    lines.on("line", (line) => {
      try {
        const value = JSON.parse(line);
        if (value.type === "runtime-ready") {
          clearTimeout(timeout);
          resolve(value);
        }
      } catch {}
    });
  });
  return { child, message, errors };
}

async function waitForExit(child) {
  if (child.exitCode !== null) return;
  await new Promise((resolve) => child.once("exit", resolve));
}

async function responseBody(response) {
  const text = await response.text();
  try { return JSON.parse(text); } catch { return text; }
}

async function removeTemporaryRoot(dataRoot) {
  let lastError;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      await rm(dataRoot, { recursive: true, force: true });
      return;
    } catch (error) {
      lastError = error;
      if (!['EBUSY', 'EPERM'].includes(error?.code)) throw error;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
  if (['EBUSY', 'EPERM'].includes(lastError?.code)) return;
  throw lastError;
}

async function request(origin, pathname, init = {}, bearerToken) {
  const headers = new Headers(init.headers);
  if (bearerToken) headers.set("authorization", `Bearer ${bearerToken}`);
  return fetch(`${origin}${pathname}`, { ...init, headers });
}

function sessionCookie(response) {
  const value = response.headers.get("set-cookie") ?? "";
  return value.split(",")[0].split(";", 1)[0];
}

test("child daemon exposes authenticated v1 HTTP, Host Web, Workspace assets, and clean shutdown", async () => {
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), "infolens-daemon-contract-"));
  try {
    await mkdir(path.join(dataRoot, "task-records"), { recursive: true });
    await writeFile(path.join(dataRoot, "task-records", "hn.json"), JSON.stringify({ version: 1, pluginId: "hn", records: [{ pluginId: "hn", task: "refresh", operationId: "restarted-operation", state: "running", createdAt: "2026-08-24T00:00:00.000Z" }] }));
    const applicationSessionId = randomUUID();
    const running = await start(dataRoot, { INFOLENS_APPLICATION_SESSION_ID: applicationSessionId });
    const origin = running.message.origin;
    const paths = daemonPaths(dataRoot, environment(dataRoot));
    const credentials = await loadDaemonCredentials(paths);

    const health = await request(origin, "/api/v1/health");
    assert.equal(health.status, 200);
    assert.equal((await responseBody(health)).daemon.loopback, true);

    const unauthorized = await request(origin, "/api/v1/plugins");
    assert.equal(unauthorized.status, 401);
    assert.equal((await responseBody(unauthorized)).code, "DAEMON_UNAUTHORIZED");

    const unexpectedOrigin = await request(origin, "/api/v1/health", { headers: { origin: "https://unexpected.invalid" } });
    assert.equal(unexpectedOrigin.headers.get("access-control-allow-origin"), null);

    const bootstrap = await request(origin, "/api/v1/session/bootstrap", { method: "POST" });
    assert.equal(bootstrap.status, 200);
    assert.match(bootstrap.headers.get("set-cookie") ?? "", /HttpOnly/u);
    const cookie = sessionCookie(bootstrap);
    assert.ok(cookie);
    const bootstrapBody = await responseBody(bootstrap);
    assert.equal(bootstrapBody.plugins, undefined);
    assert.equal(bootstrapBody.hostState, undefined);
    assert.equal(bootstrapBody.activeBatch, undefined);

    const legacySessionToken = await request(origin, "/api/v1/plugins", {}, applicationSessionId);
    assert.equal(legacySessionToken.status, 401);

    const unauthenticatedHealth = await request(origin, "/api/v1/plugins/hn/health");
    assert.equal(unauthenticatedHealth.status, 401);

    const plugins = await request(origin, "/api/v1/plugins", { headers: { cookie } });
    assert.equal(plugins.status, 200);
    const pluginBody = await responseBody(plugins);
    assert.ok(pluginBody.plugins.some((plugin) => plugin.id === "hn"));

    const info = await request(origin, "/api/v1/info", { headers: { cookie } });
    assert.equal(info.status, 200);
    assert.equal((await responseBody(info)).apiVersion, "v1");

    const legacy = await request(origin, "/runtime/info", {}, credentials.bearerToken);
    assert.equal(legacy.status, 404);

    const summary = await request(origin, "/api/v1/plugins/hn/api/summary", { headers: { cookie } });
    assert.equal(summary.status, 200);
    assert.deepEqual((await responseBody(summary)).stories, []);

    const operationHeaders = { cookie, "x-infolens-operation-id": "settings-operation" };
    const firstSettings = await request(origin, "/api/v1/plugins/hn/api/settings?policy=manual&intervalMinutes=60&retentionDays=30", { method: "POST", headers: operationHeaders });
    const secondSettings = await request(origin, "/api/v1/plugins/hn/api/settings?policy=manual&intervalMinutes=60&retentionDays=30", { method: "POST", headers: operationHeaders });
    assert.equal(firstSettings.status, 200);
    assert.equal(secondSettings.status, 200);
    assert.deepEqual(await responseBody(secondSettings), await responseBody(firstSettings));
    const reusedOperation = await request(origin, "/api/v1/plugins/hn/api/settings?policy=fixed&intervalMinutes=60&retentionDays=30", { method: "POST", headers: operationHeaders });
    assert.equal(reusedOperation.status, 409);
    assert.equal((await responseBody(reusedOperation)).code, "OPERATION_ID_REUSED");

    const workspace = await request(origin, "/api/v1/plugins/hn/workspace/", { headers: { cookie } });
    assert.equal(workspace.status, 200);
    assert.match(await workspace.text(), /Hacker News/u);

    const enableHeaders = { cookie, "content-type": "application/json", "x-infolens-operation-id": "enable-operation" };
    const disabled = await request(origin, "/api/v1/plugins/juejin/enabled", { method: "POST", headers: enableHeaders, body: JSON.stringify({ enabled: false }) });
    const repeatedDisable = await request(origin, "/api/v1/plugins/juejin/enabled", { method: "POST", headers: enableHeaders, body: JSON.stringify({ enabled: false }) });
    assert.equal(disabled.status, 200);
    assert.deepEqual(await responseBody(repeatedDisable), await responseBody(disabled));
    const changedEnable = await request(origin, "/api/v1/plugins/juejin/enabled", { method: "POST", headers: enableHeaders, body: JSON.stringify({ enabled: true }) });
    assert.equal(changedEnable.status, 409);
    assert.equal((await responseBody(changedEnable)).code, "OPERATION_ID_REUSED");
    await request(origin, "/api/v1/plugins/juejin/enabled", { method: "POST", headers: { cookie, "content-type": "application/json", "x-infolens-operation-id": "enable-operation-reset" }, body: JSON.stringify({ enabled: true }) });

    const batchHeaders = { cookie, "content-type": "application/json", "x-infolens-operation-id": "batch-operation" };
    const firstBatch = await request(origin, "/api/v1/batches", { method: "POST", headers: batchHeaders, body: JSON.stringify({ pluginIds: ["missing-plugin"] }) });
    const repeatedBatch = await request(origin, "/api/v1/batches", { method: "POST", headers: batchHeaders, body: JSON.stringify({ pluginIds: ["missing-plugin"] }) });
    assert.equal(firstBatch.status, 202);
    assert.deepEqual(await responseBody(repeatedBatch), await responseBody(firstBatch));
    const changedBatch = await request(origin, "/api/v1/batches", { method: "POST", headers: batchHeaders, body: JSON.stringify({ pluginIds: ["other-missing-plugin"] }) });
    assert.equal(changedBatch.status, 409);
    assert.equal((await responseBody(changedBatch)).code, "OPERATION_ID_REUSED");

    const hostWeb = await request(origin, "/", { headers: { cookie } });
    assert.equal(hostWeb.status, 200);
    assert.match(await hostWeb.text(), /<html/u);

    const tasks = await request(origin, "/api/v1/tasks", {}, credentials.bearerToken);
    assert.equal(tasks.status, 200);
    const taskRecords = (await responseBody(tasks)).tasks.records;
    assert.ok(Array.isArray(taskRecords));
    assert.equal(taskRecords.find((record) => record.operationId === "restarted-operation").state, "interrupted");

    const backupPath = path.join(dataRoot, "backup.json");
    const backup = await request(origin, "/api/v1/admin/backup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ destination: backupPath }),
    }, credentials.bearerToken);
    assert.equal(backup.status, 201);
    const backupText = await readFile(backupPath, "utf8");
    const backupDocument = JSON.parse(backupText);
    const taskRecordFile = backupDocument.files.find((file) => file.path === "task-records/hn.json");
    assert.ok(taskRecordFile);
    assert.match(Buffer.from(taskRecordFile.data, "base64").toString("utf8"), /restarted-operation/u);
    assert.doesNotMatch(backupText, new RegExp(credentials.bearerToken, "u"));

    const stop = await request(origin, "/api/v1/admin/shutdown", { method: "POST" }, credentials.bearerToken);
    assert.equal(stop.status, 202);
    await waitForExit(running.child);
    assert.equal(await readDaemonDiscovery(paths), undefined);
  } finally {
    await removeTemporaryRoot(dataRoot);
  }
});

test("daemon lock prevents a second child from becoming a writer", async () => {
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), "infolens-daemon-lock-"));
  try {
    const first = await start(dataRoot);
    const second = spawn(process.execPath, [serverEntry], {
      cwd: root,
      env: environment(dataRoot),
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const stderr = [];
    second.stderr.on("data", (chunk) => stderr.push(String(chunk)));
    const [code] = await new Promise((resolve) => second.once("exit", (...value) => resolve(value)));
    assert.notEqual(code, 0);
    assert.match(stderr.join(""), /DAEMON_ALREADY_RUNNING/u);
    const credentials = await loadDaemonCredentials(daemonPaths(dataRoot, environment(dataRoot)));
    await request(first.message.origin, "/api/v1/admin/shutdown", { method: "POST" }, credentials.bearerToken);
    await waitForExit(first.child);
  } finally {
    await removeTemporaryRoot(dataRoot);
  }
});

test("daemon restart authenticates with the rotated credential file, not an inherited bearer", async () => {
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), "infolens-daemon-credential-restart-"));
  let first;
  let second;
  try {
    first = await start(dataRoot);
    const paths = daemonPaths(dataRoot, environment(dataRoot));
    const initial = await loadDaemonCredentials(paths);
    const reset = await request(first.message.origin, "/api/v1/admin/credentials/reset", { method: "POST" }, initial.bearerToken);
    assert.equal(reset.status, 200);
    const rotated = await loadDaemonCredentials(paths);
    assert.notEqual(rotated.bearerToken, initial.bearerToken);

    const stop = await request(first.message.origin, "/api/v1/admin/shutdown", { method: "POST" }, rotated.bearerToken);
    assert.equal(stop.status, 202);
    await waitForExit(first.child);

    second = await start(dataRoot, { INFOLENS_DAEMON_BEARER_TOKEN: initial.bearerToken });
    const freshCredential = await request(second.message.origin, "/api/v1/info", {}, rotated.bearerToken);
    assert.equal(freshCredential.status, 200);
    const inheritedCredential = await request(second.message.origin, "/api/v1/info", {}, initial.bearerToken);
    assert.equal(inheritedCredential.status, 401);

    const secondStop = await request(second.message.origin, "/api/v1/admin/shutdown", { method: "POST" }, rotated.bearerToken);
    assert.equal(secondStop.status, 202);
    await waitForExit(second.child);
  } finally {
    for (const running of [second, first]) {
      if (running?.child?.exitCode === null) running.child.kill("SIGTERM");
    }
    await Promise.all([second, first].filter(Boolean).map(({ child }) => waitForExit(child)));
    await removeTemporaryRoot(dataRoot);
  }
});

test("daemon replays a completed operation after restart", async () => {
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), "infolens-daemon-idempotency-"));
  try {
    const first = await start(dataRoot);
    const firstCredentials = await loadDaemonCredentials(daemonPaths(dataRoot, environment(dataRoot)));
    const headers = { "content-type": "application/json", "x-infolens-operation-id": "restart-safe-settings" };
    const firstResponse = await request(first.message.origin, "/api/v1/plugins/hn/api/settings?policy=manual&intervalMinutes=60&retentionDays=30", { method: "POST", headers }, firstCredentials.bearerToken);
    assert.equal(firstResponse.status, 200);
    const firstBody = await responseBody(firstResponse);
    await request(first.message.origin, "/api/v1/admin/shutdown", { method: "POST" }, firstCredentials.bearerToken);
    await waitForExit(first.child);

    const second = await start(dataRoot);
    const secondCredentials = await loadDaemonCredentials(daemonPaths(dataRoot, environment(dataRoot)));
    const secondResponse = await request(second.message.origin, "/api/v1/plugins/hn/api/settings?policy=manual&intervalMinutes=60&retentionDays=30", { method: "POST", headers }, secondCredentials.bearerToken);
    assert.equal(secondResponse.status, 200);
    assert.deepEqual(await responseBody(secondResponse), firstBody);
    await request(second.message.origin, "/api/v1/admin/shutdown", { method: "POST" }, secondCredentials.bearerToken);
    await waitForExit(second.child);
  } finally {
    await removeTemporaryRoot(dataRoot);
  }
});
