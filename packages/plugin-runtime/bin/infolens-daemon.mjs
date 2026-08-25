#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { access, cp, mkdir, open } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  daemonPaths,
  defaultDaemonDataRoot,
  isLoopbackOrigin,
  loadDaemonCredentials,
  readDaemonLock,
  readDaemonDiscovery,
  DaemonAlreadyRunningError,
} from "../src/daemon-state.mjs";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const projectRoot = path.resolve(packageRoot, "..", "..");
const serverEntry = path.join(packageRoot, "src", "server.mjs");

function parseArgs(values) {
  const options = { command: values[0] || "status" };
  for (let index = 1; index < values.length; index += 1) {
    const value = values[index];
    if (value === "--foreground") { options.foreground = true; continue; }
    if (!["--data-root", "--plugins-root", "--host-web-root", "--port", "--project-root", "--path", "--plugin-id"].includes(value)) {
      throw new Error(`Unknown option '${value}'`);
    }
    if (index + 1 >= values.length) throw new Error(`${value} requires a value`);
    options[value.slice(2).replaceAll("-", "_")] = values[++index];
  }
  return options;
}

function pathsFor(options) {
  const environment = {
    ...process.env,
    ...(options.plugins_root ? { INFOLENS_PLUGINS_ROOT: path.resolve(options.plugins_root) } : {}),
  };
  if (!options.data_root && !environment.INFOLENS_DAEMON_DATA_ROOT && path.resolve(process.cwd()) === projectRoot) {
    environment.INFOLENS_DAEMON_DEV_MODE = "1";
    environment.INFOLENS_PROJECT_ROOT = projectRoot;
  }
  const root = path.resolve(options.data_root || defaultDaemonDataRoot(environment));
  return { root, paths: daemonPaths(root, environment), environment };
}

async function request(record, pathname, init = {}) {
  if (!isLoopbackOrigin(record?.origin)) {
    throw Object.assign(new Error("Daemon discovery origin must be a loopback HTTP origin"), { code: "DAEMON_ORIGIN_NOT_LOOPBACK" });
  }
  const credentials = await loadDaemonCredentials(pathsFor({ data_root: record.dataRoot }).paths);
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${credentials.bearerToken}`);
  if (!headers.has("content-type")) headers.set("content-type", "application/json");
  return fetch(`${record.origin}${pathname}`, { ...init, headers });
}

async function currentDaemon(options) {
  const { paths } = pathsFor(options);
  const record = await readDaemonDiscovery(paths);
  if (!record) return undefined;
  try {
    const response = await request(record, "/api/v1/health");
    if (!response.ok) return undefined;
    return { record, health: await response.json(), paths };
  } catch {
    return undefined;
  }
}

async function waitForDaemon(paths, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const lock = await readDaemonLock(paths);
    if (lock && lock.pid !== process.pid) throw new DaemonAlreadyRunningError(lock);
    const record = await readDaemonDiscovery(paths);
    if (record) {
      try {
        const response = await request(record, "/api/v1/health");
        if (response.ok) return { record, health: await response.json() };
      } catch {}
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Infolens daemon did not become ready before the timeout");
}

async function daemonEnvironment(options, paths, environment) {
  const root = path.resolve(options.project_root || projectRoot);
  const pluginsRoot = path.resolve(options.plugins_root || environment.INFOLENS_PLUGINS_ROOT || paths.pluginsRoot);
  const pluginIds = [];
  try {
    const { readdir } = await import("node:fs/promises");
    for (const entry of await readdir(pluginsRoot, { withFileTypes: true })) if (entry.isDirectory() && !entry.name.startsWith(".")) pluginIds.push(entry.name);
  } catch {}
  const childEnvironment = { ...environment };
  delete childEnvironment.INFOLENS_DAEMON_BEARER_TOKEN;
  return {
    ...childEnvironment,
    INFOLENS_PROJECT_ROOT: root,
    INFOLENS_DAEMON_MODE: "1",
    INFOLENS_DAEMON_DATA_ROOT: paths.root,
    INFOLENS_PLUGINS_ROOT: pluginsRoot,
    INFOLENS_PLUGIN_DATA_ROOT: paths.pluginDataRoot,
    INFOLENS_HOST_STATE_PATH: paths.hostStatePath,
    INFOLENS_BATCH_STATE_PATH: paths.batchStatePath,
    INFOLENS_ADAPTER_REGISTRY_ROOT: paths.adapterRegistryRoot,
    INFOLENS_DAEMON_DISCOVERY_PATH: paths.discoveryPath,
    INFOLENS_DAEMON_LOCK_PATH: paths.lockPath,
    INFOLENS_DAEMON_CREDENTIAL_PATH: paths.credentialPath,
    INFOLENS_APPLICATION_SESSION_ID: randomUUID(),
    INFOLENS_DAEMON_BOOTSTRAP_TOKEN: randomUUID(),
    INFOLENS_DAEMON_HOST_WEB_ROOT: path.resolve(options.host_web_root || path.join(root, "apps", "desktop", "dist")),
    INFOLENS_BUNDLED_PLUGIN_IDS: JSON.stringify(pluginIds),
    INFOLENS_RUNTIME_PORT: String(options.port ?? environment.INFOLENS_RUNTIME_PORT ?? 0),
  };
}

async function start(options) {
  const existing = await currentDaemon(options);
  if (existing) {
    process.stdout.write(`${JSON.stringify({ ok: true, reused: true, ...existing })}\n`);
    return;
  }
  const { paths, environment } = pathsFor(options);
  await mkdir(paths.root, { recursive: true });
  if (!options.plugins_root && !environment.INFOLENS_PLUGINS_ROOT) {
    try { await access(paths.pluginsRoot); }
    catch {
      const bundledRoot = path.join(path.resolve(options.project_root || projectRoot), "plugins");
      try { await cp(bundledRoot, paths.pluginsRoot, { recursive: true }); } catch {}
    }
  }
  const env = await daemonEnvironment(options, paths, environment);
  if (options.foreground) {
    const child = spawn(process.execPath, [serverEntry], { cwd: env.INFOLENS_PROJECT_ROOT, env, stdio: "inherit", windowsHide: true });
    child.once("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
    return;
  }
  const logRoot = path.join(paths.root, "logs");
  await mkdir(logRoot, { recursive: true });
  const stdout = await open(path.join(logRoot, "daemon.stdout.log"), "a");
  const stderr = await open(path.join(logRoot, "daemon.stderr.log"), "a");
  const child = spawn(process.execPath, [serverEntry], {
    cwd: env.INFOLENS_PROJECT_ROOT,
    env,
    detached: true,
    stdio: ["ignore", stdout.fd, stderr.fd],
    windowsHide: true,
  });
  child.unref();
  await stdout.close();
  await stderr.close();
  const ready = await waitForDaemon(paths);
  process.stdout.write(`${JSON.stringify({ ok: true, reused: false, ...ready })}\n`);
}

async function status(options) {
  const current = await currentDaemon(options);
  process.stdout.write(`${JSON.stringify(current ? { ok: true, ...current } : { ok: false, code: "DAEMON_NOT_RUNNING" })}\n`);
  if (!current) process.exitCode = 1;
}

async function stop(options) {
  const current = await currentDaemon(options);
  if (!current) {
    process.stdout.write(`${JSON.stringify({ ok: true, stopped: false, code: "DAEMON_NOT_RUNNING" })}\n`);
    return;
  }
  const response = await request(current.record, "/api/v1/admin/shutdown", { method: "POST", body: JSON.stringify({ reason: "CLI_STOP" }) });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error?.message || body.error || "Daemon stop failed");
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline && await readDaemonDiscovery(current.paths)) await new Promise((resolve) => setTimeout(resolve, 100));
  process.stdout.write(`${JSON.stringify({ ok: true, stopped: true })}\n`);
}

async function health(options) {
  const current = await currentDaemon(options);
  if (!current) throw Object.assign(new Error("Daemon is not running"), { code: "DAEMON_NOT_RUNNING" });
  process.stdout.write(`${JSON.stringify(current.health)}\n`);
}

async function resetCredentials(options) {
  const current = await currentDaemon(options);
  if (!current) throw Object.assign(new Error("Daemon is not running"), { code: "DAEMON_NOT_RUNNING" });
  const response = await request(current.record, "/api/v1/admin/credentials/reset", { method: "POST" });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error?.message || body.error || "Credential reset failed");
  process.stdout.write(`${JSON.stringify(body)}\n`);
}

async function logs(options) {
  const current = await currentDaemon(options);
  if (!current) throw Object.assign(new Error("Daemon is not running"), { code: "DAEMON_NOT_RUNNING" });
  const response = await request(current.record, "/api/v1/logs");
  const body = await response.json();
  if (!response.ok) throw new Error(body.error?.message || body.error || "Daemon logs are unavailable");
  process.stdout.write(`${JSON.stringify(body)}\n`);
}

async function backup(options) {
  const current = await currentDaemon(options);
  if (!current) throw Object.assign(new Error("Daemon is not running"), { code: "DAEMON_NOT_RUNNING" });
  const body = options.path ? { destination: path.resolve(options.path) } : {};
  const response = await request(current.record, "/api/v1/admin/backup", { method: "POST", body: JSON.stringify(body) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error?.message || result.error || "Daemon backup failed");
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

async function restore(options) {
  if (!options.path) throw new Error("restore requires --path <backup>");
  const current = await currentDaemon(options);
  if (!current) throw Object.assign(new Error("Daemon is not running"), { code: "DAEMON_NOT_RUNNING" });
  const response = await request(current.record, "/api/v1/admin/restore", { method: "POST", body: JSON.stringify({ source: path.resolve(options.path) }) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error?.message || result.error || "Daemon restore failed");
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

async function diagnostics(options) {
  if (!options.plugin_id) throw new Error("diagnostics requires --plugin-id <id>");
  const current = await currentDaemon(options);
  if (!current) throw Object.assign(new Error("Daemon is not running"), { code: "DAEMON_NOT_RUNNING" });
  const response = await request(current.record, `/api/v1/plugins/${encodeURIComponent(options.plugin_id)}/diagnostics`);
  const result = await response.json();
  if (!response.ok) throw new Error(result.error?.message || result.error || "Plugin diagnostics are unavailable");
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

function usage() {
  process.stdout.write("Usage: infolens-daemon <start|run|status|health|stop|reset-credentials|logs|backup|restore|diagnostics> [--data-root <path>] [--plugins-root <path>] [--path <path>] [--plugin-id <id>]\n");
}

try {
  const options = parseArgs(process.argv.slice(2));
  if (options.command === "start") await start(options);
  else if (options.command === "run") await start({ ...options, foreground: true });
  else if (options.command === "status") await status(options);
  else if (options.command === "health") await health(options);
  else if (options.command === "stop") await stop(options);
  else if (options.command === "reset-credentials") await resetCredentials(options);
  else if (options.command === "logs") await logs(options);
  else if (options.command === "backup") await backup(options);
  else if (options.command === "restore") await restore(options);
  else if (options.command === "diagnostics") await diagnostics(options);
  else { usage(); process.exitCode = 2; }
} catch (error) {
  process.stderr.write(`${JSON.stringify({ ok: false, code: error?.code || "DAEMON_COMMAND_FAILED", error: error instanceof Error ? error.message : String(error), ...(error?.record ? { record: error.record } : {}) })}\n`);
  process.exitCode = 1;
}
