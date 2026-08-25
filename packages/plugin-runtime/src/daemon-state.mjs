import { randomBytes, randomUUID } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { isIP } from "node:net";
import os from "node:os";
import path from "node:path";

export const DAEMON_DISCOVERY_VERSION = 1;
export const DAEMON_CREDENTIAL_VERSION = 1;

function token(bytes = 32) {
  return randomBytes(bytes).toString("base64url");
}

function now() {
  return new Date().toISOString();
}

function resolved(value) {
  return path.resolve(String(value));
}

export function defaultDaemonDataRoot(environment = process.env) {
  if (environment.INFOLENS_DAEMON_DATA_ROOT) return resolved(environment.INFOLENS_DAEMON_DATA_ROOT);
  if (environment.INFOLENS_DAEMON_DEV_MODE === "1" && environment.INFOLENS_PROJECT_ROOT) {
    return path.join(resolved(environment.INFOLENS_PROJECT_ROOT), ".infolens-data", "daemon");
  }
  const base = process.platform === "win32"
    ? environment.LOCALAPPDATA || environment.APPDATA || os.tmpdir()
    : environment.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share");
  return path.join(base, "Infolens", "daemon");
}

export function isLoopbackOrigin(value) {
  if (typeof value !== "string" || value.length > 2048) return false;
  let parsed;
  try { parsed = new URL(value); } catch { return false; }
  if (parsed.protocol !== "http:" || parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) return false;
  const hostname = parsed.hostname.replace(/^\[|\]$/gu, "");
  const version = isIP(hostname);
  return (version === 4 && hostname.startsWith("127.")) || (version === 6 && hostname === "::1");
}

export function daemonPaths(root = defaultDaemonDataRoot(), environment = process.env) {
  const dataRoot = resolved(root);
  return Object.freeze({
    root: dataRoot,
    pluginsRoot: resolved(environment.INFOLENS_PLUGINS_ROOT || path.join(dataRoot, "plugins")),
    pluginDataRoot: resolved(environment.INFOLENS_PLUGIN_DATA_ROOT || path.join(dataRoot, "plugin-data")),
    hostStatePath: resolved(environment.INFOLENS_HOST_STATE_PATH || path.join(dataRoot, "host-state.json")),
    batchStatePath: resolved(environment.INFOLENS_BATCH_STATE_PATH || path.join(dataRoot, "task-state.json")),
    taskRecordsRoot: resolved(environment.INFOLENS_TASK_RECORDS_ROOT || path.join(dataRoot, "task-records")),
    adapterRegistryRoot: resolved(environment.INFOLENS_ADAPTER_REGISTRY_ROOT || path.join(dataRoot, "opencli-adapters")),
    discoveryPath: resolved(environment.INFOLENS_DAEMON_DISCOVERY_PATH || path.join(dataRoot, "daemon.json")),
    lockPath: resolved(environment.INFOLENS_DAEMON_LOCK_PATH || path.join(dataRoot, "daemon.lock")),
    credentialPath: resolved(environment.INFOLENS_DAEMON_CREDENTIAL_PATH || path.join(dataRoot, "credentials.json")),
    backupRoot: resolved(environment.INFOLENS_DAEMON_BACKUP_ROOT || path.join(dataRoot, "backups")),
  });
}

async function readJson(filename) {
  try { return JSON.parse(await readFile(filename, "utf8")); }
  catch (error) {
    if (error?.code === "ENOENT" || error instanceof SyntaxError) return undefined;
    throw error;
  }
}

async function atomicWrite(filename, value, mode) {
  await mkdir(path.dirname(filename), { recursive: true });
  const temporary = `${filename}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode });
  try {
    await rename(temporary, filename);
  } finally {
    await rm(temporary, { force: true });
  }
  if (mode) await chmod(filename, mode).catch(() => {});
}

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

export class DaemonAlreadyRunningError extends Error {
  constructor(record) {
    super(`An Infolens daemon already owns this data root${record?.pid ? ` (pid ${record.pid})` : ""}`);
    this.name = "DaemonAlreadyRunningError";
    this.code = "DAEMON_ALREADY_RUNNING";
    this.record = record;
  }
}

export async function acquireDaemonLock(paths, details = {}) {
  await mkdir(paths.root, { recursive: true });
  const lockId = randomUUID();
  const record = {
    version: DAEMON_DISCOVERY_VERSION,
    lockId,
    pid: process.pid,
    startedAt: now(),
    dataRoot: paths.root,
    ...details,
  };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(paths.lockPath, "wx", 0o600);
      try { await handle.writeFile(`${JSON.stringify(record)}\n`, "utf8"); }
      finally { await handle.close(); }
      return {
        record,
        async release() {
          const current = await readJson(paths.lockPath);
          if (current?.lockId === lockId) await rm(paths.lockPath, { force: true });
        },
      };
    } catch (error) {
      if (error?.code !== "EEXIST" || attempt > 0) throw error;
      const current = await readJson(paths.lockPath);
      if (processIsAlive(current?.pid)) throw new DaemonAlreadyRunningError(current);
      await rm(paths.lockPath, { force: true });
    }
  }
  throw new DaemonAlreadyRunningError(await readJson(paths.lockPath));
}

export async function readDaemonLock(paths, { rejectStale = true } = {}) {
  const record = await readJson(paths.lockPath);
  if (!record || record.version !== DAEMON_DISCOVERY_VERSION || !Number.isInteger(record.pid)) return undefined;
  if (!rejectStale || processIsAlive(record.pid)) return record;
  await rm(paths.lockPath, { force: true });
  return undefined;
}

export async function loadDaemonCredentials(paths) {
  const current = await readJson(paths.credentialPath);
  if (current?.version === DAEMON_CREDENTIAL_VERSION && typeof current.bearerToken === "string" && current.bearerToken.length >= 32) {
    return current;
  }
  const credentials = {
    version: DAEMON_CREDENTIAL_VERSION,
    bearerToken: token(),
    createdAt: now(),
    rotatedAt: now(),
  };
  await atomicWrite(paths.credentialPath, credentials, 0o600);
  return credentials;
}

export async function rotateDaemonCredentials(paths) {
  const current = await loadDaemonCredentials(paths);
  const next = {
    version: DAEMON_CREDENTIAL_VERSION,
    bearerToken: token(),
    createdAt: current.createdAt ?? now(),
    rotatedAt: now(),
  };
  await atomicWrite(paths.credentialPath, next, 0o600);
  return next;
}

export async function writeDaemonDiscovery(paths, details) {
  const discovery = {
    version: DAEMON_DISCOVERY_VERSION,
    pid: process.pid,
    dataRoot: paths.root,
    writtenAt: now(),
    ...details,
  };
  await atomicWrite(paths.discoveryPath, discovery, 0o600);
  return discovery;
}

export async function removeDaemonDiscovery(paths, { pid = process.pid, sessionId } = {}) {
  const current = await readJson(paths.discoveryPath);
  if (current && (current.pid !== pid || (sessionId && current.sessionId !== sessionId))) return false;
  await rm(paths.discoveryPath, { force: true });
  return true;
}

export async function readDaemonDiscovery(paths, { rejectStale = true } = {}) {
  const record = await readJson(paths.discoveryPath);
  if (!record || record.version !== DAEMON_DISCOVERY_VERSION || !isLoopbackOrigin(record.origin)) return undefined;
  if (!rejectStale || processIsAlive(record.pid)) return record;
  await rm(paths.discoveryPath, { force: true });
  return undefined;
}
