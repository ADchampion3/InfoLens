import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

export const BACKUP_FORMAT = "infolens-daemon-backup";
export const BACKUP_VERSION = 1;

function contained(root, target) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Backup path escapes the daemon data root");
  return relative.replaceAll(path.sep, "/");
}

function forbidden(relative) {
  const normalized = relative.replaceAll("\\", "/").toLowerCase();
  return normalized === "credentials.json"
    || normalized === "daemon.json"
    || normalized === "daemon.lock"
    || normalized.startsWith("logs/")
    || normalized.includes("/logs/")
    || normalized.includes("browser")
    || normalized.includes("cache");
}

async function walk(root, current = root, files = []) {
  for (const entry of await readdir(current, { withFileTypes: true })) {
    const filename = path.join(current, entry.name);
    if (entry.isDirectory()) await walk(root, filename, files);
    else if (entry.isFile()) files.push(filename);
  }
  return files;
}

function encodedFile(relative, value) {
  return { path: relative, encoding: "base64", data: Buffer.from(value).toString("base64") };
}

const HOST_THEMES = new Set(["system", "light", "dark"]);
const TASK_STATES = new Set(["queued", "running", "succeeded", "failed", "canceled", "interrupted"]);
const BATCH_STATES = new Set(["queued", "running", "succeeded", "partial", "failed", "skipped", "interrupted"]);

function invalidState(relative, message) {
  const error = new Error(`Backup state '${relative}' is invalid: ${message}`);
  error.code = "BACKUP_STATE_INVALID";
  return error;
}

function objectValue(value, relative) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalidState(relative, "expected an object");
  return value;
}

function validateHostState(value, relative) {
  const state = objectValue(value, relative);
  if (state.version !== undefined && state.version !== 2) throw invalidState(relative, "unsupported version");
  if (state.enabledPluginIds !== undefined && (!Array.isArray(state.enabledPluginIds) || state.enabledPluginIds.some((id) => typeof id !== "string"))) {
    throw invalidState(relative, "enabledPluginIds must be an array of strings");
  }
  if (state.lastSelection !== undefined && state.lastSelection !== null && typeof state.lastSelection !== "string") throw invalidState(relative, "lastSelection must be a string or null");
  if (state.theme !== undefined && !HOST_THEMES.has(state.theme)) throw invalidState(relative, "theme is unsupported");
  for (const field of ["statusSnapshots", "pluginInstallations"]) {
    if (state[field] !== undefined && (!state[field] || typeof state[field] !== "object" || Array.isArray(state[field]))) throw invalidState(relative, `${field} must be an object`);
  }
}

function validateBatchState(value, relative) {
  const state = objectValue(value, relative);
  if (state.version !== undefined && state.version !== 1) throw invalidState(relative, "unsupported version");
  if (state.sessionId !== undefined && typeof state.sessionId !== "string") throw invalidState(relative, "sessionId must be a string");
  if (state.batches !== undefined && !Array.isArray(state.batches)) throw invalidState(relative, "batches must be an array");
  for (const batch of state.batches ?? []) {
    objectValue(batch, relative);
    if (typeof batch.batchId !== "string" || !batch.batchId) throw invalidState(relative, "each batch needs a batchId");
    if (batch.status !== undefined && !BATCH_STATES.has(batch.status)) throw invalidState(relative, `unsupported batch status '${String(batch.status)}'`);
    if (batch.items !== undefined && !Array.isArray(batch.items)) throw invalidState(relative, "batch items must be an array");
    for (const item of batch.items ?? []) {
      objectValue(item, relative);
      if (typeof item.pluginId !== "string" || !item.pluginId) throw invalidState(relative, "each batch item needs a pluginId");
      if (item.state !== undefined && !new Set(["queued", "running", "succeeded", "failed", "skipped", "interrupted"]).has(item.state)) throw invalidState(relative, `unsupported batch item state '${String(item.state)}'`);
    }
  }
}

function validateTaskRecords(value, relative, pluginId) {
  const state = objectValue(value, relative);
  if (state.version !== undefined && state.version !== 1) throw invalidState(relative, "unsupported version");
  if (state.pluginId !== undefined && state.pluginId !== pluginId) throw invalidState(relative, "pluginId does not match the task-record filename");
  if (!Array.isArray(state.records)) throw invalidState(relative, "records must be an array");
  for (const record of state.records) {
    objectValue(record, relative);
    if (record.pluginId !== pluginId || typeof record.task !== "string" || typeof record.operationId !== "string") throw invalidState(relative, "task record identity is invalid");
    if (!TASK_STATES.has(record.state)) throw invalidState(relative, `unsupported task state '${String(record.state)}'`);
  }
}

function validateStateFile(relative, data) {
  const normalized = relative.replaceAll("\\", "/");
  const isHostState = normalized === "host-state.json";
  const isBatchState = normalized === "task-state.json";
  const taskMatch = normalized.match(/^task-records\/([^/]+)\.json$/u);
  if (!isHostState && !isBatchState && !taskMatch) return;
  let parsed;
  try { parsed = JSON.parse(Buffer.from(data, "base64").toString("utf8")); }
  catch { throw invalidState(relative, "must contain valid JSON"); }
  if (isHostState) validateHostState(parsed, relative);
  else if (isBatchState) validateBatchState(parsed, relative);
  else validateTaskRecords(parsed, relative, taskMatch[1]);
}

export function validateBackup(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Backup must contain an object");
  if (value.format !== BACKUP_FORMAT || value.version !== BACKUP_VERSION) throw new Error("Backup format or version is unsupported");
  if (!Array.isArray(value.files)) throw new Error("Backup files are missing");
  const files = [];
  const seen = new Set();
  for (const file of value.files) {
    if (!file || typeof file.path !== "string" || file.encoding !== "base64" || typeof file.data !== "string") throw new Error("Backup contains an invalid file entry");
    const relative = file.path.replaceAll("\\", "/");
    if (!relative || relative.startsWith("/") || relative.split("/").includes("..") || forbidden(relative)) throw new Error(`Backup contains a forbidden path '${relative}'`);
    if (seen.has(relative)) throw new Error(`Backup contains a duplicate path '${relative}'`);
    seen.add(relative);
    if (!/^[A-Za-z0-9+/]*={0,2}$/u.test(file.data) || file.data.length % 4 === 1) throw new Error(`Backup file '${relative}' is not valid base64`);
    try {
      const decoded = Buffer.from(file.data, "base64");
      if (decoded.toString("base64") !== file.data) throw new Error("non-canonical base64");
    } catch { throw new Error(`Backup file '${relative}' is not valid base64`); }
    validateStateFile(relative, file.data);
    files.push({ path: relative, encoding: "base64", data: file.data });
  }
  return { format: BACKUP_FORMAT, version: BACKUP_VERSION, createdAt: String(value.createdAt ?? ""), files };
}

export async function createBackup({ paths, outputPath, metadata = {} }) {
  const files = [];
  const include = async (filename, relative) => {
    try { files.push(encodedFile(relative, await readFile(filename))); } catch (error) { if (error?.code !== "ENOENT") throw error; }
  };
  await include(paths.hostStatePath, "host-state.json");
  await include(paths.batchStatePath, "task-state.json");
  if (await stat(paths.taskRecordsRoot).then(() => true).catch(() => false)) {
    for (const filename of await walk(paths.taskRecordsRoot)) {
      files.push(encodedFile(`task-records/${contained(paths.taskRecordsRoot, filename)}`, await readFile(filename)));
    }
  }
  if (await stat(paths.pluginDataRoot).then(() => true).catch(() => false)) {
    for (const filename of await walk(paths.pluginDataRoot)) {
      const relative = `plugin-data/${contained(paths.pluginDataRoot, filename)}`;
      if (!forbidden(relative)) files.push(encodedFile(relative, await readFile(filename)));
    }
  }
  const value = {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    createdAt: new Date().toISOString(),
    metadata: { hostVersion: metadata.hostVersion, pluginIds: metadata.pluginIds ?? [] },
    files,
    excluded: ["credentials.json", "daemon.json", "daemon.lock", "logs", "plugins", "opencli-adapters", "caches", "browser profiles"],
  };
  const validated = validateBackup(value);
  const destination = path.resolve(outputPath);
  await mkdir(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(validated, null, 2)}\n`, "utf8");
  await rename(temporary, destination);
  return { path: destination, format: BACKUP_FORMAT, version: BACKUP_VERSION, createdAt: value.createdAt, fileCount: files.length };
}

async function readBackup(sourcePath) {
  return validateBackup(JSON.parse(await readFile(sourcePath, "utf8")));
}

export async function restoreBackup({ paths, sourcePath, backup, validateOnly = false }) {
  const value = backup ? validateBackup(backup) : await readBackup(path.resolve(sourcePath));
  const stagingRoot = path.join(paths.root, `.restore-${process.pid}-${randomUUID()}`);
  const rollbackRoot = path.join(paths.root, `.restore-rollback-${process.pid}-${randomUUID()}`);
  try {
    await mkdir(stagingRoot, { recursive: true });
    for (const file of value.files) {
      const target = path.resolve(stagingRoot, file.path);
      const relative = path.relative(stagingRoot, target);
      if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Backup restore path escapes staging area");
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, Buffer.from(file.data, "base64"));
    }
    if (validateOnly) return { ok: true, restoredAt: undefined, fileCount: value.files.length };
    const replacements = [
      { relative: "plugin-data", target: paths.pluginDataRoot },
      { relative: "task-records", target: paths.taskRecordsRoot },
      { relative: "host-state.json", target: paths.hostStatePath },
      { relative: "task-state.json", target: paths.batchStatePath },
    ];
    await mkdir(rollbackRoot, { recursive: true });
    const moved = [];
    const installed = [];
    try {
      for (const replacement of replacements) {
        const targetExists = await stat(replacement.target).then(() => true).catch(() => false);
        if (!targetExists) continue;
        const backupTarget = path.join(rollbackRoot, replacement.relative);
        await mkdir(path.dirname(backupTarget), { recursive: true });
        await rename(replacement.target, backupTarget);
        moved.push({ ...replacement, backupTarget });
      }
      for (const replacement of replacements) {
        const source = path.join(stagingRoot, replacement.relative);
        const sourceExists = await stat(source).then(() => true).catch(() => false);
        if (!sourceExists) continue;
        await mkdir(path.dirname(replacement.target), { recursive: true });
        await rename(source, replacement.target);
        installed.push(replacement);
      }
    } catch (error) {
      for (const replacement of installed.reverse()) await rm(replacement.target, { recursive: true, force: true });
      for (const replacement of moved.reverse()) {
        await mkdir(path.dirname(replacement.target), { recursive: true });
        await rename(replacement.backupTarget, replacement.target);
      }
      throw error;
    }
    return { ok: true, restoredAt: new Date().toISOString(), fileCount: value.files.length };
  } finally {
    await rm(stagingRoot, { recursive: true, force: true });
    await rm(rollbackRoot, { recursive: true, force: true });
  }
}
