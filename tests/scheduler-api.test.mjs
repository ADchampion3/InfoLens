import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { test } from "node:test";
import { daemonPaths, loadDaemonCredentials } from "../packages/plugin-runtime/src/daemon-state.mjs";

const root = path.resolve(import.meta.dirname, "..");
const serverEntry = path.join(root, "packages", "plugin-runtime", "src", "server.mjs");

async function startDaemon(dataRoot) {
  const environment = {
    ...process.env,
    INFOLENS_PROJECT_ROOT: root,
    INFOLENS_DAEMON_MODE: "1",
    INFOLENS_DAEMON_DATA_ROOT: dataRoot,
    INFOLENS_PLUGINS_ROOT: path.join(root, "plugins"),
    INFOLENS_DAEMON_HOST_WEB_ROOT: path.join(root, "apps", "desktop", "dist"),
    INFOLENS_RUNTIME_PORT: "0",
    INFOLENS_APPLICATION_SESSION_ID: "scheduler-api-" + Date.now(),
    INFOLENS_BUNDLED_PLUGIN_IDS: JSON.stringify(["hn", "juejin", "github-trending", "zhihu-hot", "product-hunt"]),
  };
  const child = spawn(process.execPath, [serverEntry], { cwd: root, env: environment, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  const errors = [];
  child.stderr.on("data", (chunk) => errors.push(String(chunk)));
  const lines = readline.createInterface({ input: child.stdout });
  const message = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("daemon start timed out: " + errors.join(""))), 10_000);
    child.once("error", reject);
    child.once("exit", (code) => reject(new Error("daemon exited before ready: " + code + ": " + errors.join(""))));
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
  const credentials = await loadDaemonCredentials(daemonPaths(dataRoot, environment));
  return { child, lines, message, credentials, environment };
}

async function stopDaemon(runtime) {
  if (!runtime?.child || runtime.child.exitCode !== null) return;
  const exited = new Promise((resolve) => runtime.child.once("exit", resolve));
  runtime.child.stdin.write("shutdown\n");
  runtime.child.stdin.end();
  await exited;
  runtime.lines.close();
}

async function request(runtime, pathname, init = {}) {
  const headers = new Headers(init.headers);
  headers.set("authorization", "Bearer " + runtime.credentials.bearerToken);
  if (init.body && !headers.has("content-type")) headers.set("content-type", "application/json");
  const response = await fetch(runtime.message.origin + pathname, { ...init, headers });
  const text = await response.text();
  return { response, body: text ? JSON.parse(text) : undefined };
}

test("daemon schedule and mail APIs persist configuration without exposing the SMTP password", async () => {
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), "infolens-scheduler-api-"));
  let runtime;
  try {
    runtime = await startDaemon(dataRoot);
    const initial = await request(runtime, "/api/v1/schedules");
    assert.equal(initial.response.status, 200);
    assert.deepEqual(initial.body.schedules, []);
    assert.equal(initial.body.mail.configured, false);

    const scheduleBody = {
      kind: "refresh",
      pluginId: "hn",
      spec: { type: "interval", intervalMinutes: 15 },
      timeZone: "Asia/Shanghai",
      name: "HN refresh",
    };
    const created = await request(runtime, "/api/v1/schedules", {
      method: "POST",
      headers: { "x-infolens-operation-id": "create-schedule" },
      body: JSON.stringify(scheduleBody),
    });
    assert.equal(created.response.status, 201);
    assert.equal(created.body.schedule.kind, "refresh");
    assert.equal(created.body.schedule.state, "enabled");
    const repeated = await request(runtime, "/api/v1/schedules", {
      method: "POST",
      headers: { "x-infolens-operation-id": "create-schedule" },
      body: JSON.stringify(scheduleBody),
    });
    assert.deepEqual(repeated.body, created.body);

    const duplicate = await request(runtime, "/api/v1/schedules", {
      method: "POST",
      headers: { "x-infolens-operation-id": "duplicate-schedule" },
      body: JSON.stringify(scheduleBody),
    });
    assert.equal(duplicate.response.status, 409);
    assert.equal(duplicate.body.code, "REFRESH_SCHEDULE_EXISTS");

    const id = created.body.schedule.scheduleId;
    const updated = await request(runtime, "/api/v1/schedules/" + id, {
      method: "PATCH",
      headers: { "x-infolens-operation-id": "update-schedule" },
      body: JSON.stringify({ version: 1, name: "HN morning refresh" }),
    });
    assert.equal(updated.response.status, 200);
    assert.equal(updated.body.schedule.version, 2);
    const conflict = await request(runtime, "/api/v1/schedules/" + id, {
      method: "PATCH",
      body: JSON.stringify({ version: 1, name: "stale" }),
    });
    assert.equal(conflict.response.status, 409);
    assert.equal(conflict.body.code, "SCHEDULE_VERSION_CONFLICT");

    const mail = await request(runtime, "/api/v1/mail-settings", {
      method: "PUT",
      headers: { "x-infolens-operation-id": "save-mail" },
      body: JSON.stringify({
        host: "smtp.example.com",
        port: 587,
        security: "starttls",
        username: "sender@example.com",
        from: "sender@example.com",
        password: "secret-value",
      }),
    });
    assert.equal(mail.response.status, 200);
    assert.equal(mail.body.mail.hasPassword, true);
    assert.doesNotMatch(JSON.stringify(mail.body), /secret-value/u);
    const publicSettings = await request(runtime, "/api/v1/mail-settings");
    assert.equal(publicSettings.body.mail.host, "smtp.example.com");
    assert.doesNotMatch(JSON.stringify(publicSettings.body), /secret-value/u);
    const secretPath = daemonPaths(dataRoot, runtime.environment).mailSecretPath;
    assert.match(await readFile(secretPath, "utf8"), /secret-value/u);

    const digest = await request(runtime, "/api/v1/schedules", {
      method: "POST",
      body: JSON.stringify({
        kind: "daily_digest",
        pluginIds: ["hn", "juejin"],
        recipients: ["reader@example.com"],
        spec: { type: "daily", time: "08:30" },
        timeZone: "Asia/Shanghai",
      }),
    });
    assert.equal(digest.response.status, 201);
    assert.deepEqual(digest.body.schedule.pluginIds, ["hn", "juejin"]);
    const backup = await request(runtime, "/api/v1/admin/backup", {
      method: "POST",
      body: JSON.stringify({ destination: path.join(dataRoot, "scheduler-backup.json") }),
    });
    assert.equal(backup.response.status, 201);
    const backupText = await readFile(path.join(dataRoot, "scheduler-backup.json"), "utf8");
    assert.match(backupText, /scheduler\.sqlite/u);
    assert.doesNotMatch(backupText, /secret-value/u);
  } finally {
    await stopDaemon(runtime);
    await rm(dataRoot, { recursive: true, force: true });
  }
});
