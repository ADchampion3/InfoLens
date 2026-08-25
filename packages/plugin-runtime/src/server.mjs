import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ContractError, validatePluginPackage } from "./contract.mjs";
import { DEFAULT_TARGET_HOST_VERSION, PLUGIN_CONTRACT_VERSION } from "@infolens/release-metadata";
import { createPluginLogger } from "./logger.mjs";
import { createOpenCliAdapter, resolveBundledOpenCli } from "./opencli-adapter.mjs";
import { createBrowserBridgeCoordinator } from "./browser-bridge.mjs";
import { PluginTaskManager, SharedTaskQueue } from "./task-manager.mjs";
import { redactSensitiveText, redactSensitiveValue } from "./redaction.mjs";
import { HostStateStore } from "./host-state.mjs";
import { normalizeTaskRefreshOutcome, shortRefreshMessage } from "./refresh-outcome.mjs";
import { refreshInputKey, sanitizeRefreshOptions } from "./refresh-options.mjs";
import { BatchManager, BATCH_TERMINAL_STATES } from "./batch-manager.mjs";
import { garbageCollectAdapterStore, preparePluginAdapterScope, removePluginAdapterScope } from "./adapter-scope.mjs";
import { aggregateDailySummary } from "./daily-summary.mjs";
import { extractZip, sha256File } from "@infolens/plugin-market/archive";
import {
  acquireDaemonLock,
  daemonPaths,
  loadDaemonCredentials,
  removeDaemonDiscovery,
  rotateDaemonCredentials,
  writeDaemonDiscovery,
} from "./daemon-state.mjs";
import { createBackup, restoreBackup } from "./backup.mjs";
import { PluginMarketService } from "@infolens/plugin-market";

const projectRoot = process.env.INFOLENS_PROJECT_ROOT
  ? path.resolve(process.env.INFOLENS_PROJECT_ROOT)
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const require = createRequire(import.meta.url);
const daemonMode = process.env.INFOLENS_DAEMON_MODE === "1";
const previewMode = process.env.INFOLENS_RUNTIME_PREVIEW === "1";
const daemonRoot = path.resolve(process.env.INFOLENS_DAEMON_DATA_ROOT ?? path.join(projectRoot, ".infolens-daemon"));
const configuredDaemonPaths = daemonPaths(daemonRoot, process.env);
const pluginsRoot = path.resolve(process.env.INFOLENS_PLUGINS_ROOT ?? (daemonMode ? configuredDaemonPaths.pluginsRoot : path.join(projectRoot, "plugins")));
const dataRoot = path.resolve(process.env.INFOLENS_PLUGIN_DATA_ROOT ?? (daemonMode ? configuredDaemonPaths.pluginDataRoot : path.join(projectRoot, ".infolens-data", "plugins")));
const diagnosticMode = process.env.INFOLENS_RUNTIME_DIAGNOSTIC === "1";
const diagnosticPluginId = process.env.INFOLENS_DIAGNOSTIC_PLUGIN_ID;
const diagnosticKeepAlive = diagnosticMode ? setInterval(() => {}, 1_000) : undefined;
function packageFile(packageName, fallback) {
  try { return require.resolve(packageName); } catch { return fallback; }
}
const pluginSdkBrowserEntry = packageFile("@infolens/plugin-sdk/src/index.js", path.join(projectRoot, "packages", "plugin-sdk", "src", "index.js"));
const pluginSdkRoot = path.dirname(pluginSdkBrowserEntry);
const pluginWorkspaceHistoryEntry = packageFile("@infolens/plugin-workspace/history-controls", path.join(projectRoot, "packages", "plugin-workspace", "src", "history-controls.js"));
const pluginWorkspaceRoot = path.dirname(pluginWorkspaceHistoryEntry);
const pluginWorkspaceHistoryStyles = path.join(pluginWorkspaceRoot, "history.css");
const pluginSdkTokenEntry = path.join(pluginSdkRoot, "workspace-tokens.css");
const pluginSdkWorkspaceStyles = path.join(pluginSdkRoot, "workspace.css");
const hostStatePath = path.resolve(process.env.INFOLENS_HOST_STATE_PATH ?? (daemonMode ? configuredDaemonPaths.hostStatePath : path.join(path.dirname(dataRoot), "host-state.json")));
const adapterRegistryRoot = path.resolve(process.env.INFOLENS_ADAPTER_REGISTRY_ROOT ?? (daemonMode ? configuredDaemonPaths.adapterRegistryRoot : path.join(path.dirname(dataRoot), "opencli-adapters")));
const batchStatePath = process.env.INFOLENS_BATCH_STATE_PATH
  ? path.resolve(process.env.INFOLENS_BATCH_STATE_PATH)
  : (daemonMode ? configuredDaemonPaths.batchStatePath : undefined);
const applicationSessionId = process.env.INFOLENS_APPLICATION_SESSION_ID?.trim() || (daemonMode ? randomUUID() : undefined);
if (!applicationSessionId) throw new Error("INFOLENS_APPLICATION_SESSION_ID is required");
const hostWebRoot = path.resolve(process.env.INFOLENS_DAEMON_HOST_WEB_ROOT ?? path.join(projectRoot, "apps", "desktop", "dist"));
let daemonCredentials;
let daemonBearerToken;
let daemonBootstrapToken;
let daemonLock;
let daemonDiscovery;
if (daemonMode) {
  daemonCredentials = await loadDaemonCredentials(configuredDaemonPaths);
  daemonBearerToken = daemonCredentials.bearerToken;
  daemonBootstrapToken = process.env.INFOLENS_DAEMON_BOOTSTRAP_TOKEN || randomUUID();
  daemonLock = await acquireDaemonLock(configuredDaemonPaths, { sessionId: applicationSessionId });
}
const publicRuntimePaths = new Set([
  "/runtime/plugin-sdk.js",
  "/runtime/plugin-workspace-history.js",
  "/runtime/plugin-workspace-history.css",
  "/runtime/plugin-sdk-tokens.css",
  "/runtime/plugin-sdk-workspace.css",
]);
const dailySummaryTimeZone = process.env.INFOLENS_DAILY_SUMMARY_TIME_ZONE || undefined;
const dailySummaryNow = process.env.INFOLENS_DAILY_SUMMARY_NOW || undefined;
let bundledPluginIds = new Set();
try {
  const value = JSON.parse(process.env.INFOLENS_BUNDLED_PLUGIN_IDS ?? "[]");
  if (Array.isArray(value)) bundledPluginIds = new Set(value.filter((id) => typeof id === "string"));
} catch {}
const openCliRuntime = await resolveBundledOpenCli({ fallbackRoot: path.join(projectRoot, "resources", "opencli") });
const openCliAdapter = createOpenCliAdapter(openCliRuntime);
const validationRuntime = {
  hostVersion: DEFAULT_TARGET_HOST_VERSION,
  contractVersion: String(PLUGIN_CONTRACT_VERSION),
  openCliVersion: openCliRuntime.version,
  availableCommands: openCliRuntime.availableCommands,
};
function adapterScopeOptions(registryRoot) {
  return {
    prepareAdapterScope: ({ packageRoot, manifest }) => preparePluginAdapterScope({
      packageRoot,
      manifest,
      runtime: openCliRuntime,
      registryRoot,
      inspect: (pluginPaths) => openCliAdapter.inspect(pluginPaths),
    }),
  };
}
const contractOptions = adapterScopeOptions(adapterRegistryRoot);
const runtimeSessionId = randomUUID();
const runtimeLogger = await createPluginLogger(path.join(dataRoot, "_runtime"), {
  source: "runtime",
  sessionId: runtimeSessionId,
  fileName: "runtime.log",
  maxBytes: Number(process.env.INFOLENS_PLUGIN_LOG_MAX_BYTES) || undefined,
  maxFiles: Number(process.env.INFOLENS_PLUGIN_LOG_MAX_FILES) || undefined,
});

const activePlugins = [];
const compatiblePlugins = [];
const rejectedPlugins = [];
const installingPluginIds = new Set();
const statusEvents = [];
const browserSessions = new Map();
const eventStreams = new Set();
const taskQueue = new SharedTaskQueue();
let browserBridge;
let eventSequence = 0;
const idempotentOperations = new Map();
const IDEMPOTENCY_RETENTION_MS = 10 * 60 * 1000;
const OPERATION_RECORD_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const OPERATION_RECORD_LIMIT = 1_000;
const operationRecordsPath = daemonMode ? path.join(configuredDaemonPaths.root, "operation-records.json") : undefined;
const persistedOperationRecords = new Map();
let operationRecordsWrite = Promise.resolve();
const hostState = new HostStateStore(hostStatePath);
await hostState.load();
let batchManager;
let marketService;

async function loadOperationRecords() {
  if (!operationRecordsPath) return;
  try {
    const value = JSON.parse(await readFile(operationRecordsPath, "utf8"));
    const now = Date.now();
    for (const record of Array.isArray(value?.operations) ? value.operations : []) {
      if (typeof record?.operationId !== "string" || typeof record.signature !== "string" || typeof record.completedAt !== "string") continue;
      const completedAt = Date.parse(record.completedAt);
      if (Number.isFinite(completedAt) && now - completedAt > OPERATION_RECORD_RETENTION_MS) continue;
      if (!record.result && !record.error) continue;
      persistedOperationRecords.set(record.operationId, {
        signature: record.signature,
        completedAt: record.completedAt,
        ...(record.result ? { result: record.result } : {}),
        ...(record.error ? { error: record.error } : {}),
      });
    }
    while (persistedOperationRecords.size > OPERATION_RECORD_LIMIT) persistedOperationRecords.delete(persistedOperationRecords.keys().next().value);
  } catch (error) {
    if (error?.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
  }
}

function jsonSnapshot(value) {
  if (isDownloadableResponse(value)) return undefined;
  try {
    const encoded = JSON.stringify(value);
    return encoded === undefined ? undefined : JSON.parse(encoded);
  } catch { return undefined; }
}

async function persistOperationRecord(operationId, signature, result, error) {
  if (!operationRecordsPath) return;
  const snapshot = jsonSnapshot(result);
  const failure = error ? errorDetails(error) : undefined;
  if (snapshot === undefined && !failure) return;
  persistedOperationRecords.set(operationId, {
    signature,
    completedAt: new Date().toISOString(),
    ...(snapshot !== undefined ? { result: snapshot } : {}),
    ...(failure ? { error: failure } : {}),
  });
  while (persistedOperationRecords.size > OPERATION_RECORD_LIMIT) persistedOperationRecords.delete(persistedOperationRecords.keys().next().value);
  const operations = [...persistedOperationRecords.entries()].map(([id, record]) => ({ operationId: id, ...record }));
  operationRecordsWrite = operationRecordsWrite.catch(() => {}).then(async () => {
    await mkdir(path.dirname(operationRecordsPath), { recursive: true });
    const temporary = `${operationRecordsPath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify({ version: 1, operations }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
      await rename(temporary, operationRecordsPath);
    } finally {
      await rm(temporary, { force: true });
    }
  });
  await operationRecordsWrite;
}

await loadOperationRecords();

function errorDetails(error) {
  return {
    code: typeof error?.code === "string" ? error.code : error instanceof ContractError ? error.code : "PLUGIN_ERROR",
    message: shortRefreshMessage(error instanceof Error ? error.message : String(error), "Plugin operation failed"),
  };
}

function installationRecord(id) {
  return hostState.snapshot().pluginInstallations?.[id];
}

async function recordInstallation(id, record) {
  await hostState.update((state) => ({
    ...state,
    pluginInstallations: { ...(state.pluginInstallations ?? {}), [id]: record },
  }));
}

function defaultInstallationRecord(id, version) {
  return {
    origin: bundledPluginIds.has(id) ? "bundled" : "local",
    version,
    releaseStatus: "unknown",
    installedAt: new Date().toISOString(),
  };
}

async function reconcileMarketProvenance(releases = []) {
  const byRelease = new Map(
    (Array.isArray(releases) ? releases : [])
      .filter((release) => typeof release?.pluginId === "string" && typeof release?.version === "string")
      .map((release) => [`${release.pluginId}@${release.version}`, release]),
  );
  return hostState.update((state) => {
    const pluginInstallations = { ...(state.pluginInstallations ?? {}) };
    for (const [id, record] of Object.entries(pluginInstallations)) {
      if (record.origin !== "market") continue;
      const release = byRelease.get(`${id}@${record.version}`);
      if (!release) {
        pluginInstallations[id] = { ...record, releaseStatus: "unknown", retractionReason: undefined };
      } else if (release.retraction) {
        pluginInstallations[id] = { ...record, releaseStatus: "retracted", retractionReason: release.retraction.reason };
      } else {
        pluginInstallations[id] = { ...record, releaseStatus: "current", retractionReason: undefined };
      }
    }
    return { ...state, pluginInstallations };
  });
}

function emitStatus(type, pluginId, details = {}) {
  const event = {
    type: "plugin-status",
    event: type,
    sequence: ++eventSequence,
    timestamp: new Date().toISOString(),
    pluginId,
    ...redactSensitiveValue(details),
  };
  statusEvents.push(event);
  if (statusEvents.length > 200) statusEvents.shift();
  process.stdout.write(`${JSON.stringify(event)}\n`);
  for (const stream of eventStreams) {
    try { stream.write(`event: status\ndata: ${JSON.stringify(event)}\n\n`); }
    catch { eventStreams.delete(stream); }
  }
  return event;
}

function emitBatchEvent(event, details = {}) {
  const value = {
    type: "batch",
    event,
    sequence: ++eventSequence,
    timestamp: new Date().toISOString(),
    ...redactSensitiveValue(details),
  };
  statusEvents.push(value);
  if (statusEvents.length > 200) statusEvents.shift();
  process.stdout.write(`${JSON.stringify(value)}\n`);
  for (const stream of eventStreams) {
    try { stream.write(`event: batch\ndata: ${JSON.stringify(value)}\n\n`); }
    catch { eventStreams.delete(stream); }
  }
  const { batchId, operationId, ...fields } = value;
  void runtimeLogger.info(`batch-${event}`, { ...fields, batchId, operationId }).catch(() => {});
  return value;
}

function emitDaemonEvent(event, details = {}) {
  const value = {
    type: "daemon",
    event,
    sequence: ++eventSequence,
    timestamp: new Date().toISOString(),
    ...redactSensitiveValue(details),
  };
  statusEvents.push(value);
  if (statusEvents.length > 200) statusEvents.shift();
  process.stdout.write(`${JSON.stringify(value)}\n`);
  for (const stream of eventStreams) {
    try { stream.write(`event: daemon\ndata: ${JSON.stringify(value)}\n\n`); }
    catch { eventStreams.delete(stream); }
  }
  return value;
}

function json(response, status, body) {
  if (response.destroyed || response.writableEnded) return;
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

function runtimeInfoPayload(origin) {
  return {
    type: "runtime-ready",
    apiVersion: "v1",
    origin,
    ...(daemonMode ? { daemon: { state: "ready", loopback: true } } : { runtimeToken: applicationSessionId }),
    plugins: compatiblePlugins.filter((plugin) => !plugin.unloaded).map((plugin) => publicCompatiblePlugin(plugin, origin)),
    rejectedPlugins,
    hostState: hostState.snapshot(),
    activeBatch: batchManager.active(),
  };
}

function runtimeBootstrapPayload(origin) {
  return {
    type: "runtime-ready",
    apiVersion: "v1",
    origin,
    ...(daemonMode ? { daemon: { state: "ready", loopback: true } } : { runtimeToken: applicationSessionId }),
  };
}

function requestOperationId(request) {
  const value = request.headers["x-infolens-operation-id"];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

async function runIdempotentOperation(operationId, signature, action) {
  if (!operationId) return action();
  const existing = idempotentOperations.get(operationId);
  if (existing) {
    if (existing.signature !== signature) throw new ContractError("OPERATION_ID_REUSED", "Operation ID was already used for a different command");
    return existing.promise;
  }
  const persisted = persistedOperationRecords.get(operationId);
  if (persisted) {
    if (persisted.signature !== signature) throw new ContractError("OPERATION_ID_REUSED", "Operation ID was already used for a different command");
    if (persisted.error) {
      const error = new Error(persisted.error.message);
      error.code = persisted.error.code;
      throw error;
    }
    return structuredClone(persisted.result);
  }
  const promise = Promise.resolve().then(action);
  idempotentOperations.set(operationId, { signature, promise });
  void promise.then(
    (result) => persistOperationRecord(operationId, signature, result).catch(() => {}),
    (error) => persistOperationRecord(operationId, signature, undefined, error).catch(() => {}),
  );
  const forget = () => {
    const current = idempotentOperations.get(operationId);
    if (current?.promise === promise) idempotentOperations.delete(operationId);
  };
  void promise.then(() => setTimeout(forget, IDEMPOTENCY_RETENTION_MS).unref?.(), () => setTimeout(forget, IDEMPOTENCY_RETENTION_MS).unref?.());
  return promise;
}

function configuredCorsOrigins() {
  const values = [
    process.env.INFOLENS_RENDERER_URL,
    ...(process.env.INFOLENS_RUNTIME_ALLOWED_ORIGINS ?? "").split(","),
  ];
  const origins = new Set();
  for (const value of values) {
    if (!value?.trim()) continue;
    try { origins.add(new URL(value.trim()).origin); } catch {}
  }
  return origins;
}

const corsOrigins = configuredCorsOrigins();

function setCorsHeaders(request, response, pathname) {
  if (!pathname.startsWith("/runtime/") && !pathname.startsWith("/api/v1/")) return;
  const origin = request.headers.origin;
  if (typeof origin !== "string" || !corsOrigins.has(origin)) return;
  response.setHeader("access-control-allow-origin", origin);
  response.setHeader("access-control-allow-credentials", "true");
  response.setHeader("access-control-allow-headers", "authorization, content-type, x-infolens-operation-id, x-infolens-bootstrap");
  response.setHeader("access-control-allow-methods", "GET,POST,PATCH,DELETE,OPTIONS");
  response.setHeader("vary", "Origin");
}

function hasRuntimeAuthorization(request) {
  return request.headers.authorization === `Bearer ${applicationSessionId}`;
}

function cookieValue(request, name) {
  const header = typeof request.headers.cookie === "string" ? request.headers.cookie : "";
  for (const part of header.split(";")) {
    const [key, ...value] = part.trim().split("=");
    if (key === name) return decodeURIComponent(value.join("="));
  }
  return undefined;
}

function sessionIsValid(request) {
  if (!daemonMode) return false;
  const value = cookieValue(request, "infolens_session");
  const session = value ? browserSessions.get(value) : undefined;
  if (!session || session.expiresAt <= Date.now()) {
    if (value) browserSessions.delete(value);
    return false;
  }
  session.expiresAt = Date.now() + 30 * 60 * 1000;
  return true;
}

function hasApiAuthorization(request) {
  if (daemonMode) {
    if (request.headers.authorization === `Bearer ${daemonBearerToken}`) return true;
    return sessionIsValid(request);
  }
  return hasRuntimeAuthorization(request);
}

function issueBrowserSession(response) {
  const value = randomUUID();
  browserSessions.set(value, { createdAt: Date.now(), expiresAt: Date.now() + 30 * 60 * 1000 });
  response.setHeader("set-cookie", `infolens_session=${encodeURIComponent(value)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=1800`);
  return { expiresInSeconds: 1800 };
}

function requiresRuntimeAuthorization(pathname) {
  return pathname.startsWith("/runtime/") && !publicRuntimePaths.has(pathname);
}

function requiresApiAuthorization(pathname) {
  if (!daemonMode || !pathname.startsWith("/api/v1/")) return false;
  return ![
    "/api/v1/health",
    "/api/v1/readiness",
    "/api/v1/session/bootstrap",
    "/api/v1/auth/session",
  ].includes(pathname);
}

function rejectRuntimeAuthorization(response) {
  response.setHeader("www-authenticate", "Bearer");
  json(response, 401, { error: "Runtime authorization required", code: "RUNTIME_UNAUTHORIZED" });
}

function rejectApiAuthorization(response) {
  response.setHeader("www-authenticate", "Bearer");
  json(response, 401, { error: "Daemon authentication required", code: "DAEMON_UNAUTHORIZED" });
}

function isDownloadableResponse(value) {
  return value?.type === "infolens:download";
}

const DOWNLOAD_FORMATS = Object.freeze({
  json: { extension: ".json", contentType: "application/json; charset=utf-8" },
  csv: { extension: ".csv", contentType: "text/csv; charset=utf-8" },
  markdown: { extension: ".md", contentType: "text/markdown; charset=utf-8" },
  text: { extension: ".txt", contentType: "text/plain; charset=utf-8" },
});
const MAX_FILENAME_BASE_LENGTH = 120;

function isReservedFilename(value) {
  const stem = value.split(".", 1)[0].toUpperCase();
  return new Set(["CON", "PRN", "AUX", "NUL", ...Array.from({ length: 9 }, (_, index) => `COM${index + 1}`), ...Array.from({ length: 9 }, (_, index) => `LPT${index + 1}`)]).has(stem);
}

function downloadFilename(filenameBase, format) {
  const details = DOWNLOAD_FORMATS[format];
  if (!details) throw new Error(`Plugin returned unsupported download format '${String(format)}'`);
  if (typeof filenameBase !== "string" || !filenameBase.trim()) throw new Error("Plugin returned an empty download filename base");
  const normalized = filenameBase.normalize("NFC");
  if ([...normalized].length > MAX_FILENAME_BASE_LENGTH) throw new Error("Plugin returned an excessively long download filename base");
  if (normalized !== normalized.trim() || normalized === "." || normalized === "..") throw new Error("Plugin returned an unsafe download filename base");
  if (/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(normalized)) throw new Error("Plugin returned an unsafe download filename base");
  if (/[\\/:*?"<>|]/u.test(normalized) || /[. ]$/u.test(normalized) || isReservedFilename(normalized)) throw new Error("Plugin returned an unsafe download filename base");

  const fullName = `${normalized}${details.extension}`;
  let asciiBase = normalized.normalize("NFKD").replace(/[\u0300-\u036f]/gu, "").replace(/[^A-Za-z0-9._-]+/gu, "-").replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/gu, "");
  if (!asciiBase || isReservedFilename(asciiBase)) asciiBase = "download";
  const ascii = `${asciiBase}${details.extension}`;
  const encoded = encodeURIComponent(fullName).replace(/[!'()*]/gu, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
  return { ...details, ascii, utf8: encoded };
}

function abortError() {
  const error = new Error("Plugin download request was cancelled");
  error.code = "REQUEST_ABORTED";
  return error;
}

function nextWithSignal(iterator, signal) {
  if (signal.aborted) return Promise.reject(abortError());
  const next = Promise.resolve().then(() => iterator.next());
  next.catch(() => {});
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    const onAbort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(abortError());
    };
    signal.addEventListener("abort", onAbort, { once: true });
    next.then((result) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    }, (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    });
  });
}

function waitForDrain(response, signal) {
  if (signal.aborted || response.destroyed) return Promise.resolve(false);
  return new Promise((resolve) => {
    let settled = false;
    const cleanup = () => {
      signal.removeEventListener("abort", onAbort);
      response.off("drain", onDrain);
      response.off("close", onClose);
    };
    const finish = (value) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };
    const onAbort = () => finish(false);
    const onDrain = () => finish(true);
    const onClose = () => finish(false);
    signal.addEventListener("abort", onAbort, { once: true });
    response.once("drain", onDrain);
    response.once("close", onClose);
  });
}

async function download(response, value, signal) {
  const filename = downloadFilename(value.filenameBase, value.format);
  const body = value.body;
  if (!body || (typeof body[Symbol.iterator] !== "function" && typeof body[Symbol.asyncIterator] !== "function")) throw new Error("Plugin returned an invalid download body");
  const iterator = typeof body[Symbol.asyncIterator] === "function" ? body[Symbol.asyncIterator]() : body[Symbol.iterator]();
  response.writeHead(200, {
    "content-type": filename.contentType,
    "content-disposition": `attachment; filename="${filename.ascii}"; filename*=UTF-8''${filename.utf8}`,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  try {
    while (true) {
      const result = await nextWithSignal(iterator, signal);
      if (result.done) break;
      if (typeof result.value !== "string") throw new Error("Plugin download chunks must be strings");
      if (signal.aborted || response.destroyed) return false;
      if (!response.write(result.value, "utf8")) {
        if (!await waitForDrain(response, signal)) return false;
      }
    }
    if (!signal.aborted && !response.destroyed && !response.writableEnded) response.end();
    return !signal.aborted;
  } catch (error) {
    if (signal.aborted || response.destroyed || error?.code === "REQUEST_ABORTED") return false;
    if (!response.destroyed) response.destroy(error);
    return false;
  } finally {
    if (signal.aborted && typeof iterator.return === "function") await iterator.return().catch(() => {});
  }
}

function normalizeRoute(method, route) {
  const suffix = route.startsWith("/") ? route : `/${route}`;
  return `${method.toUpperCase()} ${suffix}`;
}

function contentType(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  if (extension === ".html") return "text/html; charset=utf-8";
  if (extension === ".css") return "text/css; charset=utf-8";
  if (extension === ".js" || extension === ".mjs") return "text/javascript; charset=utf-8";
  if (extension === ".json") return "application/json; charset=utf-8";
  if (extension === ".png") return "image/png";
  if (extension === ".svg") return "image/svg+xml";
  if (extension === ".woff") return "font/woff";
  if (extension === ".woff2") return "font/woff2";
  return "application/octet-stream";
}

function requestAbortContext(request, response) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  const onResponseClose = () => {
    if (!response.writableFinished) abort();
  };
  request.once("aborted", abort);
  response.once("close", onResponseClose);
  if (request.aborted || response.destroyed) abort();
  return {
    signal: controller.signal,
    cleanup() {
      request.off("aborted", abort);
      response.off("close", onResponseClose);
    },
  };
}

function setPluginStatus(plugin, state, details = {}) {
  const { clearFailure, ...statusDetails } = details;
  plugin.status = { ...plugin.status, state, ...statusDetails, updatedAt: new Date().toISOString() };
  if (clearFailure) delete plugin.status.failure;
  const knownSnapshot = hostState.snapshot().statusSnapshots[plugin.manifest.id];
  const lastSuccessfulRefreshAt = typeof plugin.status.lastSuccessfulRefresh === "string"
    ? plugin.status.lastSuccessfulRefresh
    : knownSnapshot?.lastSuccessfulRefreshAt;
  const snapshot = {
    state,
    updatedAt: plugin.status.updatedAt,
    ...(lastSuccessfulRefreshAt ? { lastSuccessfulRefreshAt } : {}),
    ...(plugin.status.failure ? { failure: plugin.status.failure } : {}),
  };
  void hostState.update((current) => {
    const currentSnapshot = current.statusSnapshots[plugin.manifest.id];
    const nextSnapshot = { ...currentSnapshot, ...snapshot };
    if (clearFailure) delete nextSnapshot.failure;
    if (!lastSuccessfulRefreshAt && currentSnapshot?.lastSuccessfulRefreshAt) {
      nextSnapshot.lastSuccessfulRefreshAt = currentSnapshot.lastSuccessfulRefreshAt;
    }
    return {
      ...current,
      statusSnapshots: { ...current.statusSnapshots, [plugin.manifest.id]: nextSnapshot },
    };
  }).catch((error) => process.stderr.write(`[host-state] ${error.message}\n`));
}

function applyRefreshOutcome(plugin, outcome, { logId, operationId, batchId } = {}) {
  if (outcome.status === "succeeded") {
    const state = plugin.status.state === "refreshing" ? "running" : plugin.status.state;
    setPluginStatus(plugin, state, { lastSuccessfulRefresh: outcome.lastSuccessfulRefreshAt, clearFailure: true });
    return;
  }
  if (outcome.status === "cancelled") {
    setPluginStatus(plugin, "cancelled", { outcome });
    return;
  }
  const failure = {
    code: outcome.code,
    message: shortRefreshMessage(outcome.message),
    ...(logId ? { logId } : {}),
    ...(operationId ? { operationId } : {}),
    ...(batchId ? { batchId } : {}),
    timestamp: outcome.timestamp,
  };
  const state = plugin.status.state === "refreshing" ? "failed" : plugin.status.state;
  setPluginStatus(plugin, state, { failure });
}

function resolveDataPath(dataDir, relativePath) {
  if (typeof relativePath !== "string" || !relativePath || path.isAbsolute(relativePath)) {
    throw new Error("Plugin data path must be a non-empty relative path");
  }
  const resolved = path.resolve(dataDir, relativePath);
  const relative = path.relative(dataDir, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Plugin data path escapes the plugin data directory");
  return resolved;
}

async function activatePlugin(validated, packageRoot, { diagnostic = diagnosticMode } = {}) {
  const { manifest } = validated;
  const activationOperationId = randomUUID();
  const dataDir = path.join(dataRoot, manifest.id);
  await mkdir(dataDir, { recursive: true });
  const logger = await createPluginLogger(dataDir, {
    pluginId: manifest.id,
    sessionId: runtimeSessionId,
    maxBytes: Number(process.env.INFOLENS_PLUGIN_LOG_MAX_BYTES) || undefined,
    maxFiles: Number(process.env.INFOLENS_PLUGIN_LOG_MAX_FILES) || undefined,
  });
  const plugin = {
    manifest,
    packageRoot,
    workspaceRoot: validated.workspaceRoot,
    routes: new Map(),
    registrations: { routes: [], tasks: [], schedules: [] },
    dailySummaryProvider: undefined,
    diagnostic: diagnostic ? { mode: true, phase: "activation", violations: [] } : undefined,
    lifecycle: undefined,
    logger,
    refreshOptions: undefined,
    status: { state: "starting", updatedAt: new Date().toISOString() },
  };
  const taskManager = new PluginTaskManager(manifest.id, taskQueue, async (type, details) => {
    batchManager?.onTaskEvent(manifest.id, type, details);
    const { result, error, ...eventDetails } = details;
    const refreshOutcome = normalizeTaskRefreshOutcome(type, { ...details, result });
    const safeDetails = error
      ? { ...eventDetails, ...errorDetails(error), error: undefined }
      : eventDetails;
    if (type === "task-queued") setPluginStatus(plugin, "queued");
    if (type === "task-started") setPluginStatus(plugin, "refreshing");
    if (refreshOutcome) {
      safeDetails.outcome = refreshOutcome.status;
      if (refreshOutcome.status !== "succeeded") {
        safeDetails.code = refreshOutcome.code;
        safeDetails.message = refreshOutcome.message;
      }
    }
    if (type === "task-cancelled" && !refreshOutcome) setPluginStatus(plugin, "cancelled", { outcome: details.outcome });
    if (type === "task-interrupted") setPluginStatus(plugin, "interrupted", { outcome: "runtime-restarted" });
    const logLevel = type === "task-failed" || refreshOutcome?.status === "failed" ? "error" : "info";
    const entry = await logger[logLevel](type, safeDetails);
    if (refreshOutcome) {
      applyRefreshOutcome(plugin, refreshOutcome, { logId: entry.id, operationId: entry.operationId, batchId: details.batchId });
      if (details.error && typeof details.error === "object" && refreshOutcome.status === "failed") {
        Object.assign(details.error, { ...errorDetails(details.error), logId: entry.id, operationId: entry.operationId, timestamp: entry.timestamp });
      }
    } else if (type === "task-failed") {
      const failure = { ...errorDetails(error), logId: entry.id, operationId: entry.operationId, timestamp: entry.timestamp };
      if (error && typeof error === "object") Object.assign(error, failure);
      setPluginStatus(plugin, "failed", { failure });
    } else if (type === "task-completed" && plugin.status.state === "refreshing") {
      setPluginStatus(plugin, "running");
    }
    emitStatus(type, manifest.id, { ...safeDetails, logId: entry.id });
  }, { diagnostic, registrations: plugin.registrations, statePath: daemonMode ? path.join(configuredDaemonPaths.taskRecordsRoot, `${manifest.id}.json`) : undefined });
  plugin.taskManager = taskManager;
  activePlugins.push(plugin);
  await logger.info("plugin-activation-started", { operationId: activationOperationId });
  emitStatus("activating", manifest.id);

  const context = {
    pluginId: manifest.id,
    dataDir,
    resolveDataPath(relativePath) { return resolveDataPath(dataDir, relativePath); },
    route(method, route, handler) {
      if (typeof method !== "string" || !/^[A-Za-z]+$/.test(method) || typeof route !== "string" || !route.trim() || !route.startsWith("/")) {
        const error = new TypeError("Route registration requires an HTTP method and an absolute Plugin API path");
        error.code = "INVALID_ROUTE_REGISTRATION";
        throw error;
      }
      if (typeof handler !== "function") {
        const error = new TypeError("Route handler must be a function");
        error.code = "INVALID_ROUTE_REGISTRATION";
        throw error;
      }
      const key = normalizeRoute(method, route);
      if (plugin.routes.has(key)) {
        const error = new Error(`Route '${key}' is already registered`);
        error.code = "DUPLICATE_ROUTE_REGISTRATION";
        throw error;
      }
      plugin.routes.set(key, handler);
      plugin.registrations.routes.push({ method: method.toUpperCase(), path: route });
    },
    task(name, handler) { taskManager.register(name, handler); },
    enqueue(name, input, options) { return taskManager.enqueue(name, input, options); },
    schedule(name, options) { return taskManager.schedule(name, options); },
    setHealth(health) {
      if (!health || typeof health.state !== "string") throw new TypeError("Health must include a state");
      setPluginStatus(plugin, health.state, health);
      emitStatus("health-changed", manifest.id, { state: health.state });
    },
    notify(intent = {}) {
      if (manifest.capabilities.notification?.requested !== true) {
        throw new ContractError("CAPABILITY_NOT_GRANTED", "Plugin notification capability was not requested");
      }
      const title = typeof intent.title === "string" ? intent.title.trim() : "";
      const message = typeof intent.message === "string" ? intent.message.trim() : "";
      if (!title || !message) throw new ContractError("INVALID_NOTIFICATION", "Notification intent requires title and message");
      const notification = {
        notificationId: randomUUID(),
        pluginId: manifest.id,
        title: redactSensitiveText(title).slice(0, 160),
        message: redactSensitiveText(message).slice(0, 1_000),
        ...(typeof intent.level === "string" && ["info", "success", "warning", "error"].includes(intent.level) ? { level: intent.level } : {}),
      };
      emitDaemonEvent("notification-intent", notification);
      void logger.info("notification-intent", notification).catch(() => {});
      return { ok: true, notificationId: notification.notificationId };
    },
    setRefreshOptions(provider) {
      if (typeof provider !== "function") throw new TypeError("Refresh options provider must be a function");
      plugin.refreshOptions = provider;
    },
    registerDailySummaryProvider(provider) {
      if (typeof provider !== "function") {
        const error = new TypeError("Daily Summary provider must be a function");
        error.code = "INVALID_DAILY_SUMMARY_PROVIDER";
        throw error;
      }
      if (plugin.dailySummaryProvider) {
        const error = new Error("Plugin may register only one Daily Summary provider");
        error.code = "DUPLICATE_DAILY_SUMMARY_PROVIDER";
        throw error;
      }
      plugin.dailySummaryProvider = provider;
      plugin.registrations.dailySummary = true;
    },
    logger,
    opencli: {
      async run(commandKey, args = [], signal) {
        const mapping = manifest.openCliCommands[commandKey];
        if (!mapping) throw new Error(`OpenCLI command '${commandKey}' is not declared by plugin '${manifest.id}'`);
        if (diagnostic) {
          const error = new Error(`Diagnostic mode blocked OpenCLI command '${commandKey}' during activation`);
          error.code = "DIAGNOSTIC_OPENCLI_EXECUTION";
          error.phase = "activation";
          plugin.diagnostic.violations.push({ type: "opencli", commandKey, code: error.code });
          throw error;
        }
        await logger.info("opencli-started", { commandKey, strategy: mapping.strategy });
        try {
          const resource = mapping.strategy === "PUBLIC" ? "PUBLIC" : "BROWSER";
          const result = await taskQueue.withPermit({ pluginId: manifest.id, resource, signal }, () => openCliAdapter.run(mapping, args, signal, validated.adapterScope.adapters.map((adapter) => adapter.path)));
          await logger.info("opencli-completed", { commandKey });
          return result;
        } catch (error) {
          await logger.error("opencli-failed", { commandKey, message: error instanceof Error ? error.message : String(error) });
          if (mapping.strategy !== "PUBLIC") void browserBridge.bestEffortCheck().catch(() => {});
          throw error;
        }
      },
    },
  };

  try {
    await taskManager.load();
    if (plugin.diagnostic) {
      plugin.diagnostic.phase = "backend-import";
      process.stdout.write(`${JSON.stringify({ type: "diagnostic-phase", pluginId: manifest.id, phase: "backend-import" })}\n`);
    }
    let module;
    try {
      module = await import(`${pathToFileURL(validated.backendPath).href}?runtime=${Date.now()}`);
    } catch (error) {
      if (!error.code || error.code.startsWith("ERR_")) error.code = "BACKEND_IMPORT_FAILED";
      error.phase = "backend-import";
      throw error;
    }
    if (typeof module.activate !== "function") {
      const error = new Error("backend.entry must export activate(context)");
      error.code = "BACKEND_ACTIVATE_EXPORT_MISSING";
      error.phase = "backend-import";
      throw error;
    }
    try {
      if (plugin.diagnostic) {
        plugin.diagnostic.phase = "activation";
        process.stdout.write(`${JSON.stringify({ type: "diagnostic-phase", pluginId: manifest.id, phase: "activation" })}\n`);
      }
      plugin.lifecycle = await module.activate(context) ?? {};
    } catch (error) {
      if (!error.code) error.code = "BACKEND_ACTIVATION_FAILED";
      error.phase = error.phase ?? "activation";
      throw error;
    }
    const initialHealth = plugin.lifecycle.health;
    if (initialHealth) setPluginStatus(plugin, initialHealth.state, initialHealth);
    else if (plugin.status.state === "starting") setPluginStatus(plugin, "running");
    if (plugin.diagnostic) {
      plugin.diagnostic.phase = "running";
      process.stdout.write(`${JSON.stringify({ type: "diagnostic-phase", pluginId: manifest.id, phase: "running" })}\n`);
    }
    await logger.info("plugin-activated", { operationId: activationOperationId, version: manifest.version });
    emitStatus("activated", manifest.id, { state: plugin.status.state });
  } catch (error) {
    await taskManager.stop();
    plugin.routes.clear();
    const failure = { ...errorDetails(error), ...(error?.phase ? { phase: error.phase } : {}) };
    if (plugin.diagnostic) {
      plugin.diagnostic.phase = error.phase ?? "activation";
      plugin.diagnostic.failure = failure;
    }
    const entry = await logger.error("activation-failed", { ...failure, operationId: activationOperationId });
    const correlatedFailure = { ...failure, logId: entry.id, operationId: entry.operationId, timestamp: entry.timestamp };
    setPluginStatus(plugin, "failed", { failure: correlatedFailure });
    emitStatus("activation-failed", manifest.id, correlatedFailure);
  }
  return plugin;
}

function manifestDetails(manifest = {}) {
  return {
    ...(typeof manifest.id === "string" ? { id: manifest.id } : {}),
    ...(typeof manifest.name === "string" ? { name: manifest.name } : {}),
    ...(typeof manifest.version === "string" ? { version: manifest.version } : {}),
  };
}

async function rejectedDetails(packageRoot, packageName, error) {
  let manifest = {};
  try { manifest = JSON.parse(await readFile(path.join(packageRoot, "manifest.json"), "utf8")); } catch {}
  return { package: packageName, packagePath: packageRoot, ...manifestDetails(manifest), ...errorDetails(error) };
}

async function discoverPlugins() {
  await mkdir(dataRoot, { recursive: true });
  let entries = [];
  try { entries = await readdir(pluginsRoot, { withFileTypes: true }); }
  catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (diagnosticMode) entries = entries.filter((entry) => entry.isDirectory() && (!diagnosticPluginId || entry.name === diagnosticPluginId));
  const claimedPluginIds = new Set();
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isDirectory()) continue;
    const packageRoot = path.join(pluginsRoot, entry.name);
    try {
      let candidateManifest;
      try { candidateManifest = JSON.parse(await readFile(path.join(packageRoot, "manifest.json"), "utf8")); } catch {}
      if (typeof candidateManifest?.id === "string") {
        if (claimedPluginIds.has(candidateManifest.id)) throw new ContractError("DUPLICATE_PLUGIN_ID", `plugin id '${candidateManifest.id}' is already discovered`);
        claimedPluginIds.add(candidateManifest.id);
      }
      const validated = await validatePluginPackage(packageRoot, validationRuntime, contractOptions);
      if (activePlugins.some((plugin) => plugin.manifest.id === validated.manifest.id)) {
        throw new ContractError("DUPLICATE_PLUGIN_ID", `plugin id '${validated.manifest.id}' is already discovered`);
      }
      if (compatiblePlugins.some((plugin) => plugin.validated.manifest.id === validated.manifest.id)) {
        throw new ContractError("DUPLICATE_PLUGIN_ID", `plugin id '${validated.manifest.id}' is already discovered`);
      }
      const descriptor = { validated, packageRoot };
      compatiblePlugins.push(descriptor);
      const id = validated.manifest.id;
      const current = hostState.snapshot();
      if (!current.pluginInstallations?.[id]) await recordInstallation(id, defaultInstallationRecord(id, validated.manifest.version));
      if (!current.statusSnapshots[id]) {
        await hostState.update((state) => ({ ...state, enabledPluginIds: [...state.enabledPluginIds, id] }));
      }
      if (hostState.snapshot().enabledPluginIds.includes(id)) await activatePlugin(validated, packageRoot);
    } catch (error) {
      const rejection = await rejectedDetails(packageRoot, entry.name, error);
      rejectedPlugins.push(rejection);
      await runtimeLogger.warn("package-rejected", rejection);
      emitStatus("package-rejected", entry.name, rejection);
    }
  }
  await garbageCollectAdapterStore(adapterRegistryRoot);
}

function publicPlugin(plugin, origin) {
  const id = plugin.manifest.id;
  const statusSnapshot = hostState.snapshot().statusSnapshots[id];
  const provenance = installationRecord(id);
  const browserDependent = isBrowserDependentManifest(plugin.manifest);
  const dependencyState = getDependencyState(plugin, browserDependent);
  return {
    id,
    name: plugin.manifest.name,
    version: plugin.manifest.version,
    icon: plugin.manifest.icon,
    badge: plugin.status.badge ?? plugin.lifecycle?.badge,
    state: plugin.status.state,
    failure: statusSnapshot?.failure,
    workspaceUrl: `${origin}/plugins/${id}/workspace/`,
    apiBaseUrl: `${origin}/api/v1/plugins/${id}/api/`,
    healthUrl: `${origin}/api/v1/plugins/${id}/health`,
    packagePath: plugin.packageRoot,
    capabilities: publicCapabilities(plugin.manifest),
    enabled: true,
    ...(provenance ? { origin: provenance.origin, releaseStatus: provenance.releaseStatus, provenance } : {}),
    browserDependent,
    ...(browserDependent ? { dependencyState, dependencyWarning: dependencyState !== "connected" } : { dependencyState: "not-required" }),
    statusSnapshot,
  };
}

function dailySummaryPlugin(descriptor) {
  const id = descriptor.validated.manifest.id;
  const active = findPlugin(id);
  const manifest = descriptor.validated.manifest;
  const enabled = !descriptor.deactivated && hostState.snapshot().enabledPluginIds.includes(id);
  return {
    pluginId: id,
    name: manifest.name,
    version: manifest.version,
    enabled,
    active: Boolean(active && !descriptor.deactivated && active.lifecycle !== undefined),
    state: active?.status.state ?? (enabled ? "unavailable" : "disabled"),
    browserDependent: Object.values(manifest.openCliCommands).some((mapping) => mapping.strategy !== "PUBLIC"),
    ...(active?.dailySummaryProvider ? { provider: active.dailySummaryProvider } : {}),
  };
}

async function dailySummaryAggregate(signal) {
  const now = dailySummaryNow ? new Date(dailySummaryNow) : new Date();
  return aggregateDailySummary(
    compatiblePlugins.filter((descriptor) => !descriptor.deactivated).map((descriptor) => dailySummaryPlugin(descriptor)),
    { now, timeZone: dailySummaryTimeZone, signal },
  );
}

function publicCompatiblePlugin(descriptor, origin) {
  const id = descriptor.validated.manifest.id;
  const active = findPlugin(id);
  if (active) return publicPlugin(active, origin);
  const manifest = descriptor.validated.manifest;
  const provenance = installationRecord(id);
  const browserDependent = isBrowserDependentManifest(manifest);
  return {
    id, name: manifest.name, version: manifest.version, icon: manifest.icon,
    state: "disabled", enabled: false, packagePath: descriptor.packageRoot,
    ...(provenance ? { origin: provenance.origin, releaseStatus: provenance.releaseStatus, provenance } : {}),
    browserDependent,
    ...(browserDependent ? { dependencyState: "unknown", dependencyWarning: true } : { dependencyState: "not-required" }),
    workspaceUrl: `${origin}/plugins/${id}/workspace/`,
    apiBaseUrl: `${origin}/api/v1/plugins/${id}/api/`,
    healthUrl: `${origin}/api/v1/plugins/${id}/health`,
    capabilities: publicCapabilities(manifest),
    statusSnapshot: hostState.snapshot().statusSnapshots[id],
  };
}

function publicCapabilities(manifest) {
  return Object.fromEntries(Object.entries(manifest.capabilities ?? {}).map(([name, value]) => [name, { ...value, granted: value.requested === true }]));
}

function findPlugin(id) {
  return activePlugins.find((plugin) => plugin.manifest.id === id);
}

function findCompatible(id) {
  return compatiblePlugins.find((plugin) => plugin.validated.manifest.id === id);
}

const DEPENDENCY_STATES = new Set(["connected", "disconnected", "login-required", "unknown"]);

function isBrowserDependentManifest(manifest) {
  return Object.values(manifest.openCliCommands).some((mapping) => mapping.strategy !== "PUBLIC");
}

function getDependencyState(plugin, browserDependent = true) {
  if (!browserDependent) return "not-required";
  const value = plugin?.status?.dependencyState;
  return DEPENDENCY_STATES.has(value) ? value : "unknown";
}

function browserStatusAffected() {
  return compatiblePlugins
    .filter((descriptor) => !descriptor.deactivated && isBrowserDependentManifest(descriptor.validated.manifest))
    .map((descriptor) => {
      const id = descriptor.validated.manifest.id;
      const plugin = findPlugin(id);
      return {
        id,
        name: descriptor.validated.manifest.name,
        state: plugin?.status.state ?? "disabled",
        dependencyState: getDependencyState(plugin),
      };
    });
}

browserBridge = createBrowserBridgeCoordinator({
  adapter: openCliAdapter,
  taskQueue,
  getAffected: browserStatusAffected,
});

function batchTarget(pluginId) {
  const descriptor = findCompatible(pluginId);
  const plugin = findPlugin(pluginId);
  if (!descriptor) return { pluginId, name: pluginId, state: "unavailable", enabled: false, eligible: false, reason: "Plugin Workspace is not installed" };
  const manifest = descriptor.validated.manifest;
  const snapshot = hostState.snapshot().statusSnapshots[pluginId];
  const state = plugin?.status.state ?? "disabled";
  const enabled = Boolean(plugin && !descriptor.deactivated);
  let refreshOptions;
  try { refreshOptions = sanitizeRefreshOptions(plugin?.refreshOptions?.()); } catch { refreshOptions = undefined; }
  let reason;
  if (!enabled) reason = "Plugin Workspace is disabled";
  else if (["disabled", "unavailable"].includes(state)) reason = state === "disabled" ? "Plugin Workspace is disabled" : "Plugin Workspace is unavailable";
  else if (["starting", "queued", "refreshing"].includes(state)) reason = "Plugin Workspace is already busy";
  else if (plugin?.taskManager?.isPending("refresh", "collection")) reason = "Plugin Workspace already has a refresh queued";
  const browserDependent = isBrowserDependentManifest(manifest);
  return {
    pluginId,
    targetId: `${pluginId}@${manifest.version}`,
    name: manifest.name,
    version: manifest.version,
    state,
    enabled,
    eligible: !reason,
    ...(reason ? { reason } : {}),
    ...(refreshOptions ? { refreshOptions } : {}),
    browserDependent,
    ...(browserDependent ? { dependencyState: getDependencyState(plugin), dependencyWarning: getDependencyState(plugin) !== "connected" } : { dependencyState: "not-required" }),
    ...(snapshot?.lastSuccessfulRefreshAt ? { lastSuccessfulRefreshAt: snapshot.lastSuccessfulRefreshAt } : {}),
    ...(snapshot?.failure ? { failure: snapshot.failure } : {}),
  };
}

async function enqueueBatchTarget(pluginId, { batchId, refreshInput }) {
  const plugin = findPlugin(pluginId);
  if (!plugin) throw Object.assign(new Error(`Plugin '${pluginId}' is not active`), { code: "PLUGIN_NOT_FOUND" });
  return plugin.taskManager.enqueueDetailed("refresh", refreshInput, {
    reason: "batch",
    coalesceKey: refreshInput ? `collection:${refreshInputKey(refreshInput)}` : "collection",
    batchId,
  });
}

batchManager = new BatchManager({
  getTarget: batchTarget,
  enqueueTarget: enqueueBatchTarget,
  statePath: batchStatePath,
  sessionId: daemonMode ? undefined : applicationSessionId,
  onEvent: (event, details) => emitBatchEvent(event, details),
});

async function initializeMarketService() {
  if (!daemonMode) return;
  const marketRoot = path.join(configuredDaemonPaths.root, "market");
  const registryUrl = process.env.INFOLENS_MARKET_REGISTRY_URL
    || (process.env.INFOLENS_TEST_CONTROL === "1" ? process.env.INFOLENS_TEST_MARKET_REGISTRY_URL : undefined);
  marketService = new PluginMarketService({
    ...(registryUrl ? { registryUrl } : {}),
    cachePath: path.join(marketRoot, "catalog.json"),
    tempRoot: path.join(marketRoot, "installations"),
    hostVersion: DEFAULT_TARGET_HOST_VERSION,
    contractVersion: String(PLUGIN_CONTRACT_VERSION),
    logger: (entry) => runtimeLogger.info(entry.event ?? "market-operation", entry),
    reconcileProvenance: (index) => reconcileMarketProvenance(index?.releases),
    runtimeClient: ({ archivePath, expectedSha256, observedSha256, release, operationId, signal }) => installArchive({
      archivePath,
      expectedSha256,
      observedSha256,
      release,
      operationId,
      signal,
      origin: "market",
    }),
  });
  try { await marketService.initialize(); }
  catch (error) {
    await runtimeLogger.warn("market-service-initialization-failed", errorDetails(error));
  }
}

async function deactivatePlugin(plugin, options = {}) {
  if (plugin.diagnostic) {
    plugin.diagnostic.phase = "cleanup";
    process.stdout.write(`${JSON.stringify({ type: "diagnostic-phase", pluginId: plugin.manifest.id, phase: "cleanup" })}\n`);
  }
  if (!options.skipTaskStop) await plugin.taskManager.stop(options);
  plugin.routes.clear();
  let cleanup;
  try {
    await plugin.lifecycle?.deactivate?.();
    await plugin.logger.info("plugin-deactivated");
    emitStatus("deactivated", plugin.manifest.id);
    cleanup = { ok: true, phase: "cleanup" };
  } catch (error) {
    const failure = { ...errorDetails(error), code: error?.code ?? "PLUGIN_CLEANUP_FAILED", phase: "cleanup" };
    setPluginStatus(plugin, "failed", { failure });
    await plugin.logger.error("cleanup-failed", failure);
    emitStatus("cleanup-failed", plugin.manifest.id, failure);
    cleanup = { ok: false, phase: "cleanup", failure };
  }
  if (plugin.diagnostic) plugin.diagnostic.cleanup = cleanup;
  await plugin.logger.flush();
  const index = activePlugins.indexOf(plugin);
  if (index >= 0) activePlugins.splice(index, 1);
  return cleanup;
}

async function readJsonBody(request) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > 64 * 1024) throw new Error("Request body is too large");
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function setPluginEnabled(id, enabled) {
  const descriptor = findCompatible(id);
  if (!descriptor) throw new ContractError("PLUGIN_NOT_FOUND", `plugin '${id}' is not installed and compatible`);
  const active = findPlugin(id);
  descriptor.deactivated = !enabled;
  descriptor.unloaded = false;
  if (enabled && !active) await activatePlugin(descriptor.validated, descriptor.packageRoot);
  if (!enabled && active) await deactivatePlugin(active);
  await hostState.update((state) => ({
    ...state,
    enabledPluginIds: enabled ? [...new Set([...state.enabledPluginIds, id])] : state.enabledPluginIds.filter((pluginId) => pluginId !== id),
    statusSnapshots: {
      ...state.statusSnapshots,
      [id]: enabled
        ? state.statusSnapshots[id] ?? { state: "starting", updatedAt: new Date().toISOString() }
        : { ...state.statusSnapshots[id], state: "disabled", updatedAt: new Date().toISOString() },
    },
  }));
}

function assertInstallableId(id, { market = false } = {}) {
  if (market && bundledPluginIds.has(id)) throw new ContractError("MARKET_BUNDLED_CONFLICT", `Market plugin '${id}' conflicts with a Bundled Plugin; remove or replace the bundled package through a Host release`);
  if (compatiblePlugins.some((plugin) => plugin.validated.manifest.id === id) || rejectedPlugins.some((plugin) => plugin.id === id) || installingPluginIds.has(id)) {
    throw new ContractError("DUPLICATE_PLUGIN_ID", `plugin id '${id}' is already installed; remove the installed plugin first`);
  }
}

function marketReleaseArtifact(release) {
  const artifact = release?.artifact && typeof release.artifact === "object" && !Array.isArray(release.artifact) ? release.artifact : {};
  return {
    pluginId: release?.pluginId,
    version: release?.version,
    contractVersion: String(release?.contractVersion ?? ""),
    minHostVersion: release?.minHostVersion,
    platforms: release?.platforms ?? [],
    architectures: release?.architectures ?? [],
    retraction: release?.retraction,
    sha256: artifact.sha256,
  };
}

function releasePlatformMatches(platforms) {
  const aliases = new Set(platforms.map((value) => value === "windows" ? "win32" : value === "macos" ? "darwin" : value));
  return aliases.has(process.platform);
}

function releaseArchitectureMatches(architectures) {
  return architectures.includes(process.arch) || (process.arch === "x64" && architectures.includes("amd64"));
}

function assertMarketReleaseManifest(manifest, release) {
  const expected = marketReleaseArtifact(release);
  if (expected.pluginId !== manifest.id) throw new ContractError("MARKET_MANIFEST_MISMATCH", "Downloaded package ID does not match the selected Market release");
  if (expected.version !== manifest.version) throw new ContractError("MARKET_MANIFEST_MISMATCH", "Downloaded package version does not match the selected Market release");
  if (expected.contractVersion !== String(manifest.contractVersion)) throw new ContractError("MARKET_MANIFEST_MISMATCH", "Downloaded package Contract Version does not match the selected Market release");
  if (expected.minHostVersion !== manifest.minHostVersion) throw new ContractError("MARKET_MANIFEST_MISMATCH", "Downloaded package Minimum Host Version does not match the selected Market release");
  if (!releasePlatformMatches(expected.platforms)) throw new ContractError("UNSUPPORTED_PLATFORM", `Market release does not support platform '${process.platform}'`);
  if (!releaseArchitectureMatches(expected.architectures)) throw new ContractError("UNSUPPORTED_ARCHITECTURE", `Market release does not support architecture '${process.arch}'`);
  if (expected.retraction) throw new ContractError("MARKET_RELEASE_RETRACTED", "The selected Market release has been retracted");
}

async function commitPluginCandidate(stageRoot, validated, { origin, release, expectedSha256, observedSha256, operationId } = {}) {
  const id = validated.manifest.id;
  assertInstallableId(id, { market: origin === "market" });
  installingPluginIds.add(id);
  const destination = path.join(pluginsRoot, id);
  let descriptor;
  let activated;
  let committed = false;
  try {
    await mkdir(pluginsRoot, { recursive: true });
    await rename(stageRoot, destination);
    committed = true;
    const relocated = {
      ...validated,
      backendPath: path.join(destination, path.relative(stageRoot, validated.backendPath)),
      workspaceEntry: path.join(destination, path.relative(stageRoot, validated.workspaceEntry)),
      workspaceRoot: path.join(destination, path.relative(stageRoot, validated.workspaceRoot)),
    };
    descriptor = { validated: relocated, packageRoot: destination };
    compatiblePlugins.push(descriptor);
    await hostState.update((state) => ({
      ...state,
      enabledPluginIds: [...state.enabledPluginIds, id],
      pluginInstallations: {
        ...(state.pluginInstallations ?? {}),
        [id]: origin === "market"
          ? {
            origin: "market",
            version: validated.manifest.version,
            name: release.name,
            description: release.description,
            registryUrl: release.registryUrl,
            indexUrl: release.indexUrl,
            artifactUrl: release.artifact?.url,
            artifactSize: release.artifact?.size,
            publisher: release.publisher,
            license: release.license,
            categories: release.categories,
            changelog: release.changelog,
            contractVersion: String(release.contractVersion ?? validated.manifest.contractVersion),
            minHostVersion: release.minHostVersion ?? validated.manifest.minHostVersion,
            platforms: release.platforms,
            architectures: release.architectures,
            publishedAt: release.publishedAt,
            expectedSha256,
            observedSha256,
            releaseStatus: release.retraction ? "retracted" : "current",
            ...(release.retraction?.reason ? { retractionReason: release.retraction.reason } : {}),
            installedAt: new Date().toISOString(),
            ...(operationId ? { operationId } : {}),
          }
        : {
          origin: "local",
          version: validated.manifest.version,
          releaseStatus: "unknown",
          ...(observedSha256 ? { observedSha256 } : {}),
          installedAt: new Date().toISOString(),
        },
      },
    }));
    activated = await activatePlugin(relocated, destination);
    if (activated?.status.state === "failed") {
      const failure = activated.status.failure;
      throw new ContractError(failure?.code ?? "PLUGIN_ACTIVATION_FAILED", failure?.message ?? `Plugin '${id}' failed during activation`);
    }
    return id;
  } catch (error) {
    if (descriptor) {
      const index = compatiblePlugins.indexOf(descriptor);
      if (index >= 0) compatiblePlugins.splice(index, 1);
    }
    if (activated) {
      await activated.taskManager.stop().catch(() => {});
      activated.routes.clear();
      const activeIndex = activePlugins.indexOf(activated);
      if (activeIndex >= 0) activePlugins.splice(activeIndex, 1);
      await activated.logger.flush().catch(() => {});
    }
    if (committed) await rm(destination, { recursive: true, force: true });
    await rm(path.join(dataRoot, id), { recursive: true, force: true });
    await removePluginAdapterScope(adapterRegistryRoot, id);
    await hostState.update((state) => {
      const statusSnapshots = { ...state.statusSnapshots };
      delete statusSnapshots[id];
      const pluginInstallations = { ...(state.pluginInstallations ?? {}) };
      delete pluginInstallations[id];
      return { ...state, enabledPluginIds: state.enabledPluginIds.filter((pluginId) => pluginId !== id), statusSnapshots, pluginInstallations };
    });
    throw error;
  } finally {
    installingPluginIds.delete(id);
  }
}

async function validateAndCommitCandidate(stageRoot, { origin, release, expectedSha256, observedSha256, operationId, signal } = {}) {
  const preflightRegistryRoot = await mkdtemp(path.join(os.tmpdir(), "infolens-adapter-preflight-"));
  let validated;
  try {
    validated = await validatePluginPackage(stageRoot, validationRuntime, adapterScopeOptions(preflightRegistryRoot));
  } finally {
    await rm(preflightRegistryRoot, { recursive: true, force: true });
  }
  try {
    assertInstallableId(validated.manifest.id, { market: origin === "market" });
    if (origin === "market") assertMarketReleaseManifest(validated.manifest, release);
    if (signal?.aborted) throw new ContractError("MARKET_INSTALL_CANCELLED", "Market installation was cancelled before commit");
    const copied = await validatePluginPackage(stageRoot, validationRuntime, contractOptions);
    return await commitPluginCandidate(stageRoot, copied, { origin, release, expectedSha256, observedSha256, operationId });
  } catch (error) {
    if (validated?.manifest?.id) await removePluginAdapterScope(adapterRegistryRoot, validated.manifest.id).catch(() => {});
    throw error;
  }
}

async function installPlugin(sourcePath) {
  if (typeof sourcePath !== "string" || !path.isAbsolute(sourcePath)) throw new ContractError("INVALID_INSTALL_PATH", "Select an absolute local plugin folder");
  const sourceRoot = path.resolve(sourcePath);
  let candidateManifest;
  try { candidateManifest = JSON.parse(await readFile(path.join(sourceRoot, "manifest.json"), "utf8")); } catch {}
  if (typeof candidateManifest?.id === "string") assertInstallableId(candidateManifest.id);
  const idHint = typeof candidateManifest?.id === "string" ? candidateManifest.id : "candidate";
  const temporary = path.join(pluginsRoot, `.install-${idHint}-${Date.now()}-${randomUUID()}`);
  try {
    await cp(sourceRoot, temporary, { recursive: true, errorOnExist: true });
    return await validateAndCommitCandidate(temporary, { origin: "local" });
  } catch (error) {
    await rm(temporary, { recursive: true, force: true });
    throw error;
  }
}

async function installArchive({ archivePath, expectedSha256, observedSha256, release, origin = "market", operationId, signal } = {}) {
  if (origin !== "market" && origin !== "local") throw new ContractError("INVALID_INSTALL_ORIGIN", "Plugin archive installation has an unsupported origin");
  if (typeof archivePath !== "string" || !path.isAbsolute(archivePath)) throw new ContractError("INVALID_PLUGIN_ARCHIVE", "Plugin archive installation requires an absolute archive path");
  const archive = path.resolve(archivePath);
  const managedRelation = path.relative(pluginsRoot, archive);
  if (!managedRelation.startsWith("..") && !path.isAbsolute(managedRelation)) throw new ContractError("INVALID_PLUGIN_ARCHIVE", "Plugin archive must remain outside the managed Plugin Directory");
  const isMarket = origin === "market";
  const releaseArtifact = isMarket ? marketReleaseArtifact(release) : undefined;
  const expected = isMarket ? String(expectedSha256 ?? releaseArtifact.sha256 ?? "").toLowerCase() : undefined;
  if (isMarket && releaseArtifact.sha256 && String(releaseArtifact.sha256).toLowerCase() !== expected) throw new ContractError("MARKET_DIGEST_MISMATCH", "Market release digest does not match the expected archive digest");
  const observed = await sha256File(archive);
  if (isMarket && (!/^[0-9a-f]{64}$/u.test(expected) || observed !== expected)) throw new ContractError("MARKET_DIGEST_MISMATCH", "Market archive SHA-256 does not match the selected Registry release");
  if (isMarket && observedSha256 && observedSha256 !== observed) throw new ContractError("MARKET_DIGEST_MISMATCH", "Market archive SHA-256 differs from the Host observation");
  if (signal?.aborted) throw new ContractError(isMarket ? "MARKET_INSTALL_CANCELLED" : "PLUGIN_IMPORT_CANCELLED", "Plugin archive installation was cancelled before extraction");
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), isMarket ? "infolens-market-runtime-" : "infolens-plugin-import-"));
  const stageRoot = path.join(temporaryRoot, "package");
  try {
    await extractZip(archive, stageRoot);
    return await validateAndCommitCandidate(stageRoot, { origin, release, expectedSha256: expected, observedSha256: observed, operationId, signal });
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

async function installMarketPlugin(options = {}) {
  return installArchive({ ...options, origin: "market" });
}

async function installLocalArchive(archivePath, options = {}) {
  return installArchive({ ...options, archivePath, origin: "local" });
}

async function removePlugin(identifier) {
  const descriptor = findCompatible(identifier);
  const rejection = rejectedPlugins.find((plugin) => plugin.id === identifier || plugin.package === identifier);
  if (!descriptor && !rejection) throw new ContractError("PLUGIN_NOT_FOUND", `plugin '${identifier}' is not installed`);
  const id = descriptor?.validated.manifest.id ?? rejection.id ?? rejection.package;
  const packageRoot = descriptor?.packageRoot ?? rejection.packagePath;
  const relativePackage = path.relative(pluginsRoot, packageRoot);
  if (relativePackage.startsWith("..") || path.isAbsolute(relativePackage)) throw new Error("Refusing to remove a package outside the managed plugin directory");
  const active = findPlugin(id);
  if (active) {
    const graceMs = Number(process.env.INFOLENS_DEACTIVATION_GRACE_MS) || 2_500;
    const settled = await Promise.race([
      deactivatePlugin(active).then(() => true),
      new Promise((resolve) => setTimeout(() => resolve(false), graceMs)),
    ]);
    if (!settled) throw new ContractError("RUNTIME_RESTART_REQUIRED", `plugin '${id}' did not deactivate within ${graceMs}ms; restart Runtime before deletion`);
  }
  await rm(packageRoot, { recursive: true, force: true });
  await rm(path.join(dataRoot, id), { recursive: true, force: true });
  await removePluginAdapterScope(adapterRegistryRoot, id);
  if (descriptor) compatiblePlugins.splice(compatiblePlugins.indexOf(descriptor), 1);
  if (rejection) rejectedPlugins.splice(rejectedPlugins.indexOf(rejection), 1);
  await hostState.update((state) => {
    const statusSnapshots = { ...state.statusSnapshots };
    delete statusSnapshots[id];
    const pluginInstallations = { ...(state.pluginInstallations ?? {}) };
    delete pluginInstallations[id];
    return {
      ...state,
      enabledPluginIds: state.enabledPluginIds.filter((pluginId) => pluginId !== id),
      lastSelection: state.lastSelection === id ? null : state.lastSelection,
      statusSnapshots,
      pluginInstallations,
    };
  });
  emitStatus("removed", id);
}

async function pluginDiagnostics(id) {
  const descriptor = findCompatible(id);
  const plugin = findPlugin(id);
  if (!descriptor) throw new ContractError("PLUGIN_NOT_FOUND", `plugin '${id}' is not installed and compatible`);
  let logs = plugin ? await plugin.logger.readRecent() : "";
  if (!plugin) {
    try { logs = await readFile(path.join(dataRoot, id, "logs", "plugin.log"), "utf8"); } catch {}
  }
  const report = {
    plugin: { id, name: descriptor.validated.manifest.name, version: descriptor.validated.manifest.version },
    ...(installationRecord(id) ? { provenance: installationRecord(id) } : {}),
    status: hostState.snapshot().statusSnapshots[id] ?? { state: "disabled" },
    logs: logs.split(/\r?\n/).filter(Boolean).slice(-100).map((line) => redactSensitiveText(line)),
  };
  return `${JSON.stringify(report, null, 2)}\n`;
}

async function serveWorkspace(response, plugin, relativePath) {
  const requested = relativePath || "index.html";
  const filePath = path.resolve(plugin.workspaceRoot, requested);
  const relative = path.relative(plugin.workspaceRoot, filePath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    json(response, 403, { error: "Workspace path is outside the plugin package" });
    return;
  }
  try {
    const data = await readFile(filePath);
    response.writeHead(200, { "content-type": contentType(filePath), "cache-control": "no-store" });
    response.end(data);
  } catch {
    json(response, 404, { error: "Workspace asset not found" });
  }
}

function canonicalPathname(pathname) {
  if (!pathname.startsWith("/api/v1/")) return pathname;
  const suffix = pathname.slice("/api/v1".length);
  const simple = new Map([
    ["/info", "/runtime/info"],
    ["/tasks", "/runtime/tasks"],
    ["/events", "/runtime/events"],
    ["/daily-summary", "/runtime/daily-summary"],
    ["/host/state", "/runtime/host-state"],
    ["/browser-status", "/runtime/browser-status"],
    ["/browser-status/check", "/runtime/browser-status/check"],
    ["/browser-status/reconnect", "/runtime/browser-status/reconnect"],
    ["/batches", "/runtime/batches"],
    ["/batches/active", "/runtime/batches/active"],
    ["/batches/targets", "/runtime/batches/targets"],
    ["/batch-refresh", "/runtime/batch-refresh"],
    ["/batch-refresh/targets", "/runtime/batch-refresh/targets"],
    ["/plugins/install", "/runtime/plugins/install"],
    ["/plugins/install-archive", "/runtime/plugins/install-archive"],
    ["/plugins/install-market", "/runtime/plugins/install-market"],
    ["/plugins/reconcile-market", "/runtime/plugins/reconcile-market"],
  ]);
  if (simple.has(suffix)) return simple.get(suffix);
  const batch = suffix.match(/^\/(?:batches|batch-refresh)\/([^/]+)(\/retry)?$/);
  if (batch) return `/runtime/batches/${batch[1]}${batch[2] ?? ""}`;
  const plugin = suffix.match(/^\/plugins\/([^/]+)\/(health|api|workspace)(?:\/(.*))?$/);
  if (plugin) return `/plugins/${plugin[1]}/${plugin[2]}${plugin[3] === undefined ? "" : `/${plugin[3]}`}`;
  const pluginAdmin = suffix.match(/^\/plugins\/([^/]+)(?:\/(enabled|diagnostics|remove))?$/);
  if (pluginAdmin) {
    if (pluginAdmin[2] === "enabled") return `/runtime/plugins/${pluginAdmin[1]}/enabled`;
    if (pluginAdmin[2] === "diagnostics") return `/runtime/plugins/${pluginAdmin[1]}/diagnostics`;
    if (pluginAdmin[2] === "remove") return `/runtime/plugins/${pluginAdmin[1]}/remove`;
    return `/runtime/plugins/${pluginAdmin[1]}`;
  }
  return pathname;
}

function daemonReadiness() {
  const plugins = compatiblePlugins.map((descriptor) => {
    const plugin = findPlugin(descriptor.validated.manifest.id);
    return {
      id: descriptor.validated.manifest.id,
      name: descriptor.validated.manifest.name,
      state: plugin?.status.state ?? "disabled",
      enabled: Boolean(plugin),
      ...(plugin?.status.failure ? { failure: plugin.status.failure } : {}),
    };
  });
  for (const rejected of rejectedPlugins) plugins.push({ id: rejected.id ?? rejected.package, name: rejected.name ?? rejected.package, state: "unavailable", enabled: false, failure: { code: rejected.code, message: rejected.message } });
  const unavailable = plugins.filter((plugin) => ["failed", "unavailable"].includes(plugin.state));
  return {
    state: "ready",
    daemon: { state: "ready", loopback: true, version: String(DEFAULT_TARGET_HOST_VERSION) },
    pluginCount: plugins.length,
    unavailableCount: unavailable.length,
    plugins,
  };
}

async function serveHostWeb(response, relativePath) {
  const requested = relativePath && relativePath !== "/" ? relativePath : "/index.html";
  const candidate = path.resolve(hostWebRoot, `.${requested.startsWith("/") ? requested : `/${requested}`}`);
  const relative = path.relative(hostWebRoot, candidate);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    json(response, 403, { error: "Host Web path is outside the Web bundle", code: "WEB_PATH_FORBIDDEN" });
    return;
  }
  try {
    const data = await readFile(candidate);
    response.writeHead(200, { "content-type": contentType(candidate), "cache-control": "no-store", "x-content-type-options": "nosniff" });
    response.end(data);
  } catch (error) {
    if (!path.extname(candidate)) {
      try {
        const fallback = path.join(hostWebRoot, "index.html");
        response.writeHead(200, { "content-type": contentType(fallback), "cache-control": "no-store" });
        response.end(await readFile(fallback));
        return;
      } catch {}
    }
    json(response, error?.code === "ENOENT" ? 404 : 500, { error: "Host Web asset not found", code: "WEB_ASSET_NOT_FOUND" });
  }
}

async function readOperationalLogEntries({ filters = {}, cursor, limit = 200 } = {}) {
  const sources = [
    { source: "runtime", filePath: path.join(dataRoot, "_runtime", "logs", "runtime.log") },
    ...(daemonMode ? [{ source: "host", filePath: path.join(configuredDaemonPaths.root, "logs", "host.log") }] : []),
  ];
  try {
    for (const entry of await readdir(dataRoot, { withFileTypes: true })) {
      if (entry.isDirectory() && entry.name !== "_runtime") sources.push({ source: `plugin:${entry.name}`, filePath: path.join(dataRoot, entry.name, "logs", "plugin.log") });
    }
  } catch {}
  const entries = [];
  for (const source of sources) {
    let value;
    try { value = await readFile(source.filePath, "utf8"); } catch { continue; }
    for (const line of value.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line);
        entries.push({
          id: String(parsed.id ?? randomUUID()),
          timestamp: String(parsed.timestamp ?? new Date(0).toISOString()),
          level: ["debug", "info", "warn", "error"].includes(parsed.level) ? parsed.level : "info",
          source: source.source,
          message: redactSensitiveText(String(parsed.message ?? "")),
          ...(parsed.code ? { code: String(parsed.code) } : {}),
          sessionId: String(parsed.sessionId ?? "daemon"),
          ...(parsed.operationId ? { operationId: String(parsed.operationId) } : {}),
          ...(parsed.batchId ? { batchId: String(parsed.batchId) } : {}),
        });
      } catch {}
    }
  }
  const normalizedSources = new Set(Array.isArray(filters.sources) ? filters.sources.map(String) : []);
  const normalizedLevels = new Set(Array.isArray(filters.levels) ? filters.levels.map(String) : []);
  const keyword = typeof filters.keyword === "string" ? filters.keyword.toLowerCase() : "";
  const filtered = entries
    .sort((left, right) => right.timestamp.localeCompare(left.timestamp) || right.id.localeCompare(left.id))
    .filter((entry) => !normalizedSources.size || normalizedSources.has(entry.source))
    .filter((entry) => !normalizedLevels.size || normalizedLevels.has(entry.level))
    .filter((entry) => !filters.from || entry.timestamp >= String(filters.from))
    .filter((entry) => !filters.to || entry.timestamp <= String(filters.to))
    .filter((entry) => !keyword || `${entry.message} ${entry.code ?? ""}`.toLowerCase().includes(keyword))
    .filter((entry) => !filters.operationId || entry.operationId === String(filters.operationId))
    .filter((entry) => !filters.batchId || entry.batchId === String(filters.batchId));
  let start = 0;
  if (typeof cursor === "string" && cursor) {
    try {
      const decoded = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
      const index = filtered.findIndex((entry) => entry.id === decoded.id && entry.timestamp === decoded.timestamp);
      if (index < 0) throw new Error("cursor not found");
      start = index + 1;
    } catch (error) {
      const failure = new Error("Log cursor is invalid");
      failure.code = "INVALID_LOG_CURSOR";
      throw failure;
    }
  }
  const pageSize = Math.min(200, Math.max(1, Number(limit) || 200));
  const page = filtered.slice(start, start + pageSize);
  const last = page.at(-1);
  return {
    entries: page,
    ...(start + page.length < filtered.length && last ? { nextCursor: Buffer.from(JSON.stringify({ id: last.id, timestamp: last.timestamp }), "utf8").toString("base64url") } : {}),
  };
}

await batchManager.load();
await discoverPlugins();
await initializeMarketService();

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  const requestedPathname = url.pathname;
  setCorsHeaders(request, response, requestedPathname);
  if (request.method === "OPTIONS") { response.writeHead(204); response.end(); return; }
  if (!previewMode && requestedPathname.startsWith("/runtime/") && !publicRuntimePaths.has(requestedPathname)) {
    json(response, 404, { error: "Use the versioned daemon API", code: "API_VERSION_REQUIRED" });
    return;
  }
  if (!previewMode && /^\/plugins\/[^/]+\/(?:api|health)(?:\/|$)/u.test(requestedPathname)) {
    json(response, 404, { error: "Use the versioned daemon Plugin API", code: "API_VERSION_REQUIRED" });
    return;
  }
  if (daemonMode && requestedPathname === "/api/v1/health" && request.method === "GET") {
    json(response, 200, daemonReadiness());
    return;
  }
  if (daemonMode && requestedPathname === "/api/v1/readiness" && request.method === "GET") {
    json(response, 200, daemonReadiness());
    return;
  }
  if (["/api/v1/session/bootstrap", "/api/v1/auth/session"].includes(requestedPathname) && ["GET", "POST"].includes(request.method ?? "GET")) {
    if (daemonMode) {
      const suppliedBootstrap = request.headers["x-infolens-bootstrap"];
      if (suppliedBootstrap && suppliedBootstrap !== daemonBootstrapToken) {
        json(response, 401, { error: "Daemon bootstrap token is invalid", code: "DAEMON_BOOTSTRAP_INVALID" });
        return;
      }
      const session = issueBrowserSession(response);
      json(response, 200, { ok: true, authenticated: true, session, ...runtimeBootstrapPayload(`http://${request.headers.host}`) });
      return;
    }
    json(response, 200, runtimeBootstrapPayload(`http://${request.headers.host}`));
    return;
  }
  if (requiresApiAuthorization(requestedPathname) && !hasApiAuthorization(request)) {
    rejectApiAuthorization(response);
    return;
  }
  if (daemonMode && requestedPathname.startsWith("/plugins/") && !hasApiAuthorization(request)) {
    rejectApiAuthorization(response);
    return;
  }
  if (requiresRuntimeAuthorization(url.pathname) && !hasRuntimeAuthorization(request)) {
    rejectRuntimeAuthorization(response);
    return;
  }
  url.pathname = canonicalPathname(requestedPathname);

  if (daemonMode && requestedPathname === "/api/v1/plugins" && request.method === "GET") {
    const info = runtimeInfoPayload(`http://${request.headers.host}`);
    json(response, 200, { plugins: info.plugins, rejectedPlugins: info.rejectedPlugins, hostState: info.hostState });
    return;
  }
  if (daemonMode && requestedPathname === "/api/v1/host/state" && request.method === "GET") {
    json(response, 200, hostState.snapshot());
    return;
  }
  if (daemonMode && requestedPathname === "/api/v1/events" && request.method === "GET") {
    response.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-store",
      "connection": "keep-alive",
      "x-accel-buffering": "no",
    });
    response.write(`event: snapshot\ndata: ${JSON.stringify({ events: statusEvents.slice(-50), readiness: daemonReadiness() })}\n\n`);
    eventStreams.add(response);
    const close = () => eventStreams.delete(response);
    request.once("close", close);
    response.once("close", close);
    return;
  }
  if (daemonMode && requestedPathname === "/api/v1/logs" && request.method === "GET") {
    try {
      const filters = {
        sources: url.searchParams.getAll("source"),
        levels: url.searchParams.getAll("level"),
        from: url.searchParams.get("from") ?? "",
        to: url.searchParams.get("to") ?? "",
        keyword: url.searchParams.get("keyword") ?? "",
        operationId: url.searchParams.get("operationId") ?? "",
        batchId: url.searchParams.get("batchId") ?? "",
      };
      json(response, 200, await readOperationalLogEntries({ filters, cursor: url.searchParams.get("cursor") ?? undefined, limit: url.searchParams.get("limit") ?? undefined }));
    } catch (error) {
      const failure = errorDetails(error);
      json(response, 400, { error: failure.message, code: failure.code });
    }
    return;
  }
  if (daemonMode && requestedPathname === "/api/v1/admin/backup" && request.method === "POST") {
    try {
      const body = await readJsonBody(request);
      const destination = path.resolve(body.destination || path.join(configuredDaemonPaths.backupRoot, `infolens-backup-${new Date().toISOString().replace(/[:.]/gu, "-")}.json`));
      const result = await createBackup({
        paths: configuredDaemonPaths,
        outputPath: destination,
        metadata: { hostVersion: DEFAULT_TARGET_HOST_VERSION, pluginIds: compatiblePlugins.map((plugin) => plugin.validated.manifest.id) },
      });
      await runtimeLogger.info("backup-created", { fileCount: result.fileCount });
      json(response, 201, result);
    } catch (error) {
      const failure = errorDetails(error);
      json(response, 400, { error: failure.message, code: failure.code === "PLUGIN_ERROR" ? "BACKUP_FAILED" : failure.code });
    }
    return;
  }
  if (daemonMode && requestedPathname === "/api/v1/admin/restore" && request.method === "POST") {
    let restoreQuiesced = false;
    const previousEnabledPluginIds = new Set(hostState.snapshot().enabledPluginIds);
    try {
      const body = await readJsonBody(request);
      const source = body.source || body.sourcePath;
      if (typeof source !== "string" || !path.isAbsolute(source)) throw Object.assign(new Error("Restore requires an absolute backup path"), { code: "BACKUP_SOURCE_INVALID" });
      await restoreBackup({ paths: configuredDaemonPaths, sourcePath: source, validateOnly: true });
      await hostState.flush();
      await batchManager.interruptActive("BACKUP_RESTORE");
      restoreQuiesced = true;
      for (const plugin of [...activePlugins]) await deactivatePlugin(plugin, { preserveInterrupted: daemonMode });
      const result = await restoreBackup({ paths: configuredDaemonPaths, sourcePath: source });
      await hostState.load();
      await batchManager.load();
      batchManager.resumeAfterRestore();
      const enabledPluginIds = new Set(hostState.snapshot().enabledPluginIds);
      for (const descriptor of compatiblePlugins) {
        const id = descriptor.validated.manifest.id;
        descriptor.deactivated = !enabledPluginIds.has(id);
        descriptor.unloaded = false;
        if (enabledPluginIds.has(id) && !findPlugin(id)) await activatePlugin(descriptor.validated, descriptor.packageRoot);
      }
      await runtimeLogger.info("backup-restored", { fileCount: result.fileCount });
      json(response, 200, result);
    } catch (error) {
      if (restoreQuiesced) {
        try {
          await hostState.load();
          await batchManager.load();
          batchManager.resumeAfterRestore();
          for (const descriptor of compatiblePlugins) {
            const id = descriptor.validated.manifest.id;
            descriptor.deactivated = !previousEnabledPluginIds.has(id);
            descriptor.unloaded = false;
            if (previousEnabledPluginIds.has(id) && !findPlugin(id)) await activatePlugin(descriptor.validated, descriptor.packageRoot);
          }
        } catch (recoveryError) {
          await runtimeLogger.error("backup-restore-recovery-failed", errorDetails(recoveryError)).catch(() => {});
        }
      }
      const failure = errorDetails(error);
      json(response, 400, { error: failure.message, code: failure.code === "PLUGIN_ERROR" ? "RESTORE_FAILED" : failure.code });
    }
    return;
  }
  if (daemonMode && requestedPathname === "/api/v1/admin/credentials/reset" && request.method === "POST") {
    const next = await rotateDaemonCredentials(configuredDaemonPaths);
    daemonCredentials = next;
    daemonBearerToken = next.bearerToken;
    json(response, 200, { ok: true, rotatedAt: next.rotatedAt, bearerToken: next.bearerToken });
    return;
  }
  if (daemonMode && requestedPathname === "/api/v1/admin/shutdown" && request.method === "POST") {
    json(response, 202, { ok: true, state: "stopping" });
    setTimeout(() => { void shutdown("ADMIN_STOP"); }, 0).unref?.();
    return;
  }

  if (daemonMode && requestedPathname === "/api/v1/market/catalog" && request.method === "GET") {
    if (!marketService) { json(response, 503, { error: "Plugin Market is unavailable", code: "MARKET_UNAVAILABLE" }); return; }
    json(response, 200, marketService.catalog(url.searchParams.get("query") ?? ""));
    return;
  }
  if (daemonMode && requestedPathname === "/api/v1/market/refresh" && request.method === "POST") {
    if (!marketService) { json(response, 503, { error: "Plugin Market is unavailable", code: "MARKET_UNAVAILABLE" }); return; }
    try {
      const result = await marketService.refreshCatalog();
      emitDaemonEvent("market-catalog-refreshed", { cachedAt: result.cachedAt });
      json(response, 200, result);
    } catch (error) {
      const failure = errorDetails(error);
      json(response, 502, { error: failure.message, code: failure.code });
    }
    return;
  }
  const marketOperationMatch = requestedPathname.match(/^\/api\/v1\/market\/operations\/([^/]+)(?:\/(cancel|retry))?$/);
  if (daemonMode && marketOperationMatch && request.method === "GET" && !marketOperationMatch[2]) {
    const operation = marketService?.operation(decodeURIComponent(marketOperationMatch[1]));
    if (!operation) { json(response, 404, { error: "Market operation not found", code: "MARKET_OPERATION_NOT_FOUND" }); return; }
    json(response, 200, operation);
    return;
  }
  if (daemonMode && marketOperationMatch && marketOperationMatch[2] === "cancel" && request.method === "POST") {
    if (!marketService) { json(response, 503, { error: "Plugin Market is unavailable", code: "MARKET_UNAVAILABLE" }); return; }
    json(response, 200, { ok: true, canceled: marketService.cancel(decodeURIComponent(marketOperationMatch[1])) });
    return;
  }
  if (daemonMode && marketOperationMatch && marketOperationMatch[2] === "retry" && request.method === "POST") {
    if (!marketService) { json(response, 503, { error: "Plugin Market is unavailable", code: "MARKET_UNAVAILABLE" }); return; }
    const operationId = decodeURIComponent(marketOperationMatch[1]);
    const requestContext = requestAbortContext(request, response);
    try {
      const result = await marketService.retry(operationId, {
        signal: requestContext.signal,
        onProgress: (operation) => emitDaemonEvent("market-progress", operation),
      });
      json(response, 201, result);
    } catch (error) {
      const failure = errorDetails(error);
      json(response, 400, { error: failure.message, code: failure.code, ...(error?.operationId ? { operationId: error.operationId } : {}) });
    } finally { requestContext.cleanup(); }
    return;
  }
  if (daemonMode && requestedPathname === "/api/v1/market/install" && request.method === "POST") {
    if (!marketService) { json(response, 503, { error: "Plugin Market is unavailable", code: "MARKET_UNAVAILABLE" }); return; }
    const operationId = requestOperationId(request) || randomUUID();
    const requestContext = requestAbortContext(request, response);
    try {
      const body = await readJsonBody(request);
      const signature = `POST ${requestedPathname}:${JSON.stringify({ pluginId: String(body.pluginId ?? ""), version: String(body.version ?? "") })}`;
      const result = await runIdempotentOperation(operationId, signature, async () => {
        try {
          const installed = await marketService.install(String(body.pluginId ?? ""), String(body.version ?? ""), {
            operationId,
            signal: requestContext.signal,
            onProgress: (operation) => emitDaemonEvent("market-progress", operation),
          });
          return { status: 201, body: installed };
        } catch (error) {
          const failure = errorDetails(error);
          return { status: 400, body: { error: failure.message, code: failure.code, operationId: error?.operationId ?? operationId } };
        }
      });
      if (!requestContext.signal.aborted && !response.destroyed) json(response, result.status, result.body);
    } catch (error) {
      const failure = errorDetails(error);
      if (!requestContext.signal.aborted && !response.destroyed) json(response, failure.code === "OPERATION_ID_REUSED" ? 409 : 400, { error: failure.message, code: failure.code, operationId });
    } finally { requestContext.cleanup(); }
    return;
  }

  if (daemonMode && request.method === "GET" && !requestedPathname.startsWith("/api/v1/") && requestedPathname !== "/runtime/info" && !requestedPathname.startsWith("/runtime/") && !requestedPathname.startsWith("/plugins/")) {
    await serveHostWeb(response, requestedPathname);
    return;
  }
  if (url.pathname === "/runtime/plugin-sdk.js" && request.method === "GET") {
    try {
      const data = await readFile(pluginSdkBrowserEntry);
      response.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store" });
      response.end(data);
    } catch {
      json(response, 404, { error: "Plugin SDK browser entry not found" });
    }
    return;
  }

  if (url.pathname === "/runtime/plugin-workspace-history.js" && request.method === "GET") {
    try {
      response.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store" });
      response.end(await readFile(pluginWorkspaceHistoryEntry));
    } catch {
      json(response, 404, { error: "Plugin Workspace history controls not found" });
    }
    return;
  }
  if (url.pathname === "/runtime/plugin-workspace-history.css" && request.method === "GET") {
    try {
      response.writeHead(200, { "content-type": "text/css; charset=utf-8", "cache-control": "no-store" });
      response.end(await readFile(pluginWorkspaceHistoryStyles));
    } catch {
      json(response, 404, { error: "Plugin Workspace history styles not found" });
    }
    return;
  }
  if (url.pathname === "/runtime/plugin-sdk-tokens.css" && request.method === "GET") {
    try {
      response.writeHead(200, { "content-type": "text/css; charset=utf-8", "cache-control": "no-store" });
      response.end(await readFile(pluginSdkTokenEntry));
    } catch {
      json(response, 404, { error: "Plugin SDK workspace tokens not found" });
    }
    return;
  }
  if (url.pathname === "/runtime/plugin-sdk-workspace.css" && request.method === "GET") {
    try {
      response.writeHead(200, { "content-type": "text/css; charset=utf-8", "cache-control": "no-store" });
      response.end(await readFile(pluginSdkWorkspaceStyles));
    } catch {
      json(response, 404, { error: "Plugin SDK workspace styles not found" });
    }
    return;
  }
  if (url.pathname === "/runtime/health") {
    json(response, 200, { state: "running", pluginCount: activePlugins.length, rejectedCount: rejectedPlugins.length });
    return;
  }
  if (url.pathname === "/runtime/events") {
    json(response, 200, { events: statusEvents });
    return;
  }
  if (url.pathname === "/runtime/tasks") {
    const snapshot = taskQueue.snapshot();
    snapshot.tasks.records = activePlugins.flatMap((plugin) => plugin.taskManager.snapshot());
    json(response, 200, snapshot);
    return;
  }
  if (url.pathname === "/runtime/daily-summary" && request.method === "GET") {
    const requestContext = requestAbortContext(request, response);
    try {
      const aggregate = await dailySummaryAggregate(requestContext.signal);
      if (!requestContext.signal.aborted && !response.destroyed) json(response, 200, aggregate);
    } catch {
      if (!requestContext.signal.aborted && !response.destroyed) json(response, 503, { error: "Daily Summary is unavailable", code: "DAILY_SUMMARY_UNAVAILABLE" });
    } finally {
      requestContext.cleanup();
    }
    return;
  }
  if (["/runtime/batches/targets", "/runtime/batch-refresh/targets"].includes(url.pathname) && request.method === "GET") {
    json(response, 200, { targets: compatiblePlugins.filter((descriptor) => !descriptor.deactivated).map((descriptor) => batchTarget(descriptor.validated.manifest.id)) });
    return;
  }
  if (["/runtime/batches", "/runtime/batch-refresh"].includes(url.pathname) && request.method === "GET") {
    json(response, 200, { activeBatch: batchManager.active(), batches: batchManager.list() });
    return;
  }
  if (["/runtime/batches", "/runtime/batch-refresh"].includes(url.pathname) && request.method === "POST") {
    const operationId = requestOperationId(request) || randomUUID();
    try {
      const body = await readJsonBody(request);
      const selections = body.targets ?? body.pluginIds;
      const signature = `POST ${url.pathname}:${JSON.stringify(selections ?? null)}`;
      const result = await runIdempotentOperation(operationId, signature, async () => {
        try {
          const created = await batchManager.create(selections);
          const payload = { ...created.batch, batch: created.batch, reused: created.reused, operationId };
          return { status: created.reused ? 200 : 202, body: payload };
        } catch (error) {
          const failure = errorDetails(error);
          return {
            status: ["BATCH_ACTIVE", "RUNTIME_STOPPING"].includes(failure.code) ? 409 : 400,
            body: { error: failure.message, code: failure.code, operationId },
          };
        }
      });
      json(response, result.status, result.body);
    } catch (error) {
      const failure = errorDetails(error);
      json(response, failure.code === "OPERATION_ID_REUSED" ? 409 : 400, { error: failure.message, code: failure.code, operationId });
    }
    return;
  }
  if (url.pathname === "/runtime/batches/active" && request.method === "GET") {
    const batch = batchManager.active();
    json(response, 200, { batch: batch ?? null });
    return;
  }
  const batchRetryMatch = url.pathname.match(/^\/runtime\/batches\/([^/]+)\/retry$/);
  if (batchRetryMatch && request.method === "POST") {
    try {
      const result = await batchManager.retry(decodeURIComponent(batchRetryMatch[1]));
      json(response, 202, { ...result.batch, batch: result.batch, reused: result.reused });
    } catch (error) {
      const failure = errorDetails(error);
      json(response, ["BATCH_ACTIVE", "BATCH_NOT_FOUND"].includes(failure.code) ? 409 : 400, { error: failure.message, code: failure.code });
    }
    return;
  }
  const batchMatch = url.pathname.match(/^\/runtime\/batches\/([^/]+)$/);
  if (batchMatch && request.method === "GET") {
    const batch = batchManager.get(decodeURIComponent(batchMatch[1]));
    if (!batch) { json(response, 404, { error: "Batch not found", code: "BATCH_NOT_FOUND" }); return; }
    json(response, 200, batch);
    return;
  }
  if (url.pathname === "/runtime/host-state" && request.method === "PATCH") {
    try {
      const body = await readJsonBody(request);
      const next = await hostState.update((state) => ({
        ...state,
        ...(body.theme !== undefined ? { theme: body.theme } : {}),
        ...(body.lastSelection !== undefined ? { lastSelection: body.lastSelection } : {}),
      }));
      json(response, 200, next);
    } catch (error) { json(response, 400, { error: errorDetails(error).message }); }
    return;
  }
  if (url.pathname === "/runtime/plugins/reconcile-market" && request.method === "POST") {
    try {
      const body = await readJsonBody(request);
      const next = await reconcileMarketProvenance(body.releases);
      json(response, 200, next);
    } catch (error) {
      const failure = errorDetails(error);
      json(response, 400, { error: failure.message, code: failure.code });
    }
    return;
  }
  if (url.pathname === "/runtime/browser-status" && request.method === "GET") {
    json(response, 200, browserBridge.getStatus());
    return;
  }
  if (url.pathname === "/runtime/browser-status/check" && request.method === "POST") {
    try { json(response, 200, await browserBridge.check()); }
    catch (error) { const failure = errorDetails(error); json(response, 503, { ...browserBridge.getStatus(), code: failure.code, retryable: true, action: "retry" }); }
    return;
  }
  if (url.pathname === "/runtime/browser-status/reconnect" && request.method === "POST") {
    try { json(response, 200, await browserBridge.reconnect()); }
    catch (error) { const failure = errorDetails(error); json(response, 503, { ...browserBridge.getStatus(), code: failure.code, retryable: true, action: "retry" }); }
    return;
  }
  if (url.pathname === "/runtime/plugins/install" && request.method === "POST") {
    const operationId = requestOperationId(request) || randomUUID();
    try {
      const body = await readJsonBody(request);
      const signature = `POST ${url.pathname}:${JSON.stringify({ sourcePath: String(body.sourcePath ?? "") })}`;
      const result = await runIdempotentOperation(operationId, signature, async () => {
        await runtimeLogger.info("plugin-install-started", { operationId });
        try {
          const id = await installPlugin(body.sourcePath);
          const entry = await runtimeLogger.info("plugin-install-completed", { operationId, pluginId: id });
          return { status: 201, body: { ok: true, pluginId: id, logId: entry.id, operationId } };
        } catch (error) {
          const failure = errorDetails(error);
          const entry = await runtimeLogger.error("plugin-install-failed", { ...failure, operationId });
          return { status: failure.code === "DUPLICATE_PLUGIN_ID" ? 409 : 400, body: { error: failure.message, code: failure.code, logId: entry.id, operationId } };
        }
      });
      json(response, result.status, result.body);
    } catch (error) {
      const failure = errorDetails(error);
      json(response, failure.code === "OPERATION_ID_REUSED" ? 409 : 400, { error: failure.message, code: failure.code, operationId });
    }
    return;
  }
  if (url.pathname === "/runtime/plugins/install-archive" && request.method === "POST") {
    const operationId = requestOperationId(request) || randomUUID();
    const requestContext = requestAbortContext(request, response);
    try {
      const body = await readJsonBody(request);
      const signature = `POST ${url.pathname}:${JSON.stringify({ archivePath: String(body.archivePath ?? "") })}`;
      const result = await runIdempotentOperation(operationId, signature, async () => {
        await runtimeLogger.info("plugin-import-started", { operationId });
        try {
          const id = await installLocalArchive(body.archivePath, { operationId, signal: requestContext.signal });
          const entry = await runtimeLogger.info("plugin-import-completed", { operationId, pluginId: id });
          return { status: 201, body: { ok: true, pluginId: id, logId: entry.id, operationId } };
        } catch (error) {
          const failure = errorDetails(error);
          const entry = await runtimeLogger.error("plugin-import-failed", { ...failure, operationId });
          const status = failure.code === "DUPLICATE_PLUGIN_ID" ? 409 : String(failure.code).startsWith("ARCHIVE_") ? 422 : 400;
          return { status, body: { error: failure.message, code: failure.code, logId: entry.id, operationId } };
        }
      });
      if (!requestContext.signal.aborted && !response.destroyed) json(response, result.status, result.body);
    } catch (error) {
      const failure = errorDetails(error);
      if (!requestContext.signal.aborted && !response.destroyed) json(response, failure.code === "OPERATION_ID_REUSED" ? 409 : 400, { error: failure.message, code: failure.code, operationId });
    } finally {
      requestContext.cleanup();
    }
    return;
  }
  if (url.pathname === "/runtime/plugins/install-market" && request.method === "POST") {
    const operationId = requestOperationId(request) || randomUUID();
    const requestContext = requestAbortContext(request, response);
    try {
      const body = await readJsonBody(request);
      const signature = `POST ${url.pathname}:${JSON.stringify(body)}`;
      const result = await runIdempotentOperation(operationId, signature, async () => {
        await runtimeLogger.info("market-install-started", { operationId });
        try {
          const id = await installMarketPlugin({ ...body, operationId, signal: requestContext.signal });
          const entry = await runtimeLogger.info("market-install-completed", { operationId, pluginId: id });
          return { status: 201, body: { ok: true, pluginId: id, logId: entry.id, operationId } };
        } catch (error) {
          const failure = errorDetails(error);
          const entry = await runtimeLogger.error("market-install-failed", { ...failure, operationId });
          const status = ["DUPLICATE_PLUGIN_ID", "MARKET_BUNDLED_CONFLICT"].includes(failure.code) ? 409 : ["MARKET_DIGEST_MISMATCH", "ARCHIVE_INVALID", "ARCHIVE_PATH_TRAVERSAL", "ARCHIVE_SYMLINK", "ARCHIVE_DUPLICATE_ENTRY"].includes(failure.code) ? 422 : 400;
          return { status, body: { error: failure.message, code: failure.code, logId: entry.id, operationId } };
        }
      });
      if (!requestContext.signal.aborted && !response.destroyed) json(response, result.status, result.body);
    } catch (error) {
      const failure = errorDetails(error);
      if (!requestContext.signal.aborted && !response.destroyed) json(response, failure.code === "OPERATION_ID_REUSED" ? 409 : 400, { error: failure.message, code: failure.code, operationId });
    } finally {
      requestContext.cleanup();
    }
    return;
  }
  const enabledMatch = url.pathname.match(/^\/runtime\/plugins\/([^/]+)\/enabled$/);
  if (enabledMatch && request.method === "POST") {
    const operationId = requestOperationId(request) || randomUUID();
    try {
      const body = await readJsonBody(request);
      const enabled = Boolean(body.enabled);
      const signature = `POST ${url.pathname}:${JSON.stringify({ enabled })}`;
      const result = await runIdempotentOperation(operationId, signature, async () => {
        try {
          await setPluginEnabled(decodeURIComponent(enabledMatch[1]), enabled);
          return { status: 200, body: { ok: true, operationId } };
        } catch (error) {
          const failure = errorDetails(error);
          return { status: 400, body: { error: failure.message, code: failure.code, operationId } };
        }
      });
      json(response, result.status, result.body);
    } catch (error) {
      const failure = errorDetails(error);
      json(response, failure.code === "OPERATION_ID_REUSED" ? 409 : 400, { error: failure.message, code: failure.code, operationId });
    }
    return;
  }
  const diagnosticsMatch = url.pathname.match(/^\/runtime\/plugins\/([^/]+)\/diagnostics$/);
  if (diagnosticsMatch && request.method === "GET") {
    try { json(response, 200, { diagnostics: await pluginDiagnostics(decodeURIComponent(diagnosticsMatch[1])) }); }
    catch (error) { const failure = errorDetails(error); json(response, 404, { error: failure.message, code: failure.code }); }
    return;
  }
  const removalMatch = url.pathname.match(/^\/runtime\/plugins\/([^/]+)\/remove$/);
  if (removalMatch && request.method === "DELETE") {
    const pluginId = decodeURIComponent(removalMatch[1]);
    const operationId = requestOperationId(request) || randomUUID();
    try {
      const result = await runIdempotentOperation(operationId, `DELETE ${url.pathname}`, async () => {
        await runtimeLogger.info("plugin-removal-started", { operationId, pluginId });
        try {
          await removePlugin(pluginId);
          const entry = await runtimeLogger.info("plugin-removal-completed", { operationId, pluginId });
          return { status: 200, body: { ok: true, pluginId, logId: entry.id, operationId } };
        } catch (error) {
          const failure = errorDetails(error);
          const entry = await runtimeLogger.error("plugin-removal-failed", { ...failure, operationId, pluginId });
          return { status: failure.code === "RUNTIME_RESTART_REQUIRED" ? 503 : 404, body: { error: failure.message, code: failure.code, logId: entry.id, operationId } };
        }
      });
      json(response, result.status, result.body);
    } catch (error) {
      const failure = errorDetails(error);
      json(response, failure.code === "OPERATION_ID_REUSED" ? 409 : 404, { error: failure.message, code: failure.code, operationId });
    }
    return;
  }
  const deactivateMatch = url.pathname.match(/^\/runtime\/plugins\/([^/]+)$/);
  if (deactivateMatch && request.method === "DELETE") {
    const operationId = requestOperationId(request) || randomUUID();
    try {
      const result = await runIdempotentOperation(operationId, `DELETE ${url.pathname}`, async () => {
        const plugin = findPlugin(decodeURIComponent(deactivateMatch[1]));
        if (!plugin) return { status: 404, body: { error: "Plugin not found", code: "PLUGIN_NOT_FOUND", operationId } };
        await deactivatePlugin(plugin);
        const descriptor = findCompatible(decodeURIComponent(deactivateMatch[1]));
        if (descriptor) { descriptor.deactivated = false; descriptor.unloaded = true; }
        return { status: 200, body: { ok: true, pluginId: deactivateMatch[1], operationId } };
      });
      json(response, result.status, result.body);
    } catch (error) {
      const failure = errorDetails(error);
      json(response, failure.code === "OPERATION_ID_REUSED" ? 409 : 400, { error: failure.message, code: failure.code, operationId });
    }
    return;
  }
  if (url.pathname === "/runtime/info") {
    const origin = `http://${request.headers.host}`;
    json(response, 200, runtimeInfoPayload(origin));
    return;
  }

  const match = url.pathname.match(/^\/plugins\/([^/]+)\/(health|api|workspace)(?:\/(.*))?$/);
  if (!match) {
    json(response, 404, { error: "Route not found" });
    return;
  }

  const [, pluginId, section, tail = ""] = match;
  const plugin = findPlugin(pluginId);
  if (!plugin) {
    json(response, 404, { error: "Plugin not found" });
    return;
  }

  if (section === "health") {
    const statusSnapshot = hostState.snapshot().statusSnapshots[pluginId];
    const browserDependent = isBrowserDependentManifest(plugin.manifest);
    json(response, plugin.status.state === "failed" ? 503 : 200, {
      pluginId,
      state: plugin.status.state,
      badge: plugin.status.badge ?? plugin.lifecycle?.badge,
      ...(browserDependent ? { dependencyState: getDependencyState(plugin), dependencyWarning: getDependencyState(plugin) !== "connected" } : { dependencyState: "not-required" }),
      ...(statusSnapshot?.lastSuccessfulRefreshAt ? { lastSuccessfulRefreshAt: statusSnapshot.lastSuccessfulRefreshAt } : {}),
      ...(statusSnapshot?.failure ? { failure: statusSnapshot.failure } : {}),
    });
    return;
  }

  if (section === "workspace") {
    if (plugin.status.state === "failed") {
      json(response, 503, { error: "Plugin is failed", failure: plugin.status.failure });
      return;
    }
    await serveWorkspace(response, plugin, tail);
    return;
  }

  const handler = plugin.routes.get(normalizeRoute(request.method ?? "GET", `/${tail}`));
  if (!handler) {
    json(response, 404, { error: "Plugin API route not found" });
    return;
  }

  const requestContext = requestAbortContext(request, response);
  try {
    const operationId = ["GET", "HEAD"].includes(request.method ?? "GET") ? undefined : requestOperationId(request);
    const body = await runIdempotentOperation(operationId, `${request.method ?? "GET"} ${requestedPathname}${url.search}`, () => handler({ method: request.method, url, headers: request.headers, signal: requestContext.signal }));
    if (requestContext.signal.aborted || response.destroyed) return;
    if (isDownloadableResponse(body)) await download(response, body, requestContext.signal);
    else json(response, 200, body);
  } catch (error) {
    if (requestContext.signal.aborted || response.destroyed || response.headersSent) return;
    const failure = errorDetails(error);
    if (failure.code === "OPERATION_ID_REUSED") {
      json(response, 409, { error: failure.message, code: failure.code });
      return;
    }
    if (error?.logId && error?.operationId) {
      const correlatedFailure = { ...failure, logId: error.logId, operationId: error.operationId, timestamp: error.timestamp };
      setPluginStatus(plugin, "failed", { failure: correlatedFailure });
      json(response, 500, { error: failure.message, code: failure.code, logId: error.logId, operationId: error.operationId });
      return;
    }
    const operationId = randomUUID();
    const entry = await plugin.logger.error("route-failed", { route: tail, ...failure, operationId });
    const correlatedFailure = { ...failure, logId: entry.id, operationId, timestamp: entry.timestamp };
    setPluginStatus(plugin, "failed", { failure: correlatedFailure });
    emitStatus("route-failed", pluginId, { route: tail, ...correlatedFailure });
    json(response, 500, { error: failure.message, code: failure.code, logId: entry.id, operationId });
  } finally {
    requestContext.cleanup();
  }
});

const port = Number(process.env.INFOLENS_RUNTIME_PORT ?? 0);
server.listen(port, "127.0.0.1", () => {
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Runtime did not bind a TCP port");
  const origin = `http://127.0.0.1:${address.port}`;
  void (async () => {
    if (daemonMode) {
      daemonDiscovery = await writeDaemonDiscovery(configuredDaemonPaths, {
        origin,
        port: address.port,
        sessionId: applicationSessionId,
        apiVersion: "v1",
        bootstrap: { path: "/api/v1/session/bootstrap", method: "POST", token: daemonBootstrapToken },
      });
    }
    await runtimeLogger.info("runtime-started", { origin });
    process.stdout.write(`${JSON.stringify(runtimeInfoPayload(origin))}\n`);
  })().catch((error) => {
    process.stderr.write(`[runtime-startup] ${error.message}\n`);
    void shutdown("STARTUP_FAILED");
  });
});

let stopping = false;
function diagnosticResult(plugin) {
  const checks = [];
  if (!plugin) {
    checks.push({ id: "doctor.runtime", severity: "error", status: "failed", phase: "discovery", code: "DIAGNOSTIC_PLUGIN_NOT_FOUND", message: "Diagnostic Plugin was not discovered" });
    return { type: "diagnostic-result", ok: false, checks, registrations: { routes: [], tasks: [], schedules: [] } };
  }
  const diagnostic = plugin.diagnostic ?? {};
  if (diagnostic.failure) {
    const failure = diagnostic.failure;
    const id = failure.phase === "backend-import" ? "doctor.backend-import" : "doctor.activation";
    checks.push({ id, severity: "error", status: "failed", phase: failure.phase ?? "activation", code: failure.code, message: failure.message });
  } else {
    checks.push({ id: "doctor.activation", severity: "info", status: "passed", phase: "activation", details: { state: plugin.status.state } });
  }
  const registrations = plugin.taskManager.diagnosticSnapshot();
  const registrationDetails = {
    routes: plugin.registrations.routes,
    tasks: registrations.registrations.tasks,
    schedules: registrations.registrations.schedules,
    ...(plugin.registrations.dailySummary ? { dailySummary: true } : {}),
  };
  checks.push({ id: "doctor.registrations", severity: "info", status: "passed", phase: "activation", details: registrationDetails });
  for (const violation of registrations.violations.concat(diagnostic.violations ?? [])) {
    checks.push({ id: "doctor.side-effect", severity: "error", status: "failed", phase: "activation", code: violation.code, message: `Diagnostic mode blocked ${violation.type}` });
  }
  const healthFailure = plugin.status.state === "failed" && !diagnostic.failure ? plugin.status.failure : undefined;
  const healthyState = plugin.status.state === "ready" || plugin.status.state === "running";
  if (healthFailure || (!diagnostic.failure && !healthyState)) {
    checks.push({ id: "doctor.health", severity: "error", status: "failed", phase: "health", code: "PLUGIN_HEALTH_FAILED", message: healthFailure?.message ?? `Plugin Health state '${plugin.status.state}' is not ready` });
  } else if (diagnostic.failure) {
    checks.push({ id: "doctor.health", severity: "info", status: "skipped", phase: "health", details: { reason: "activation failed" } });
  } else {
    checks.push({ id: "doctor.health", severity: "info", status: "passed", phase: "health", details: { state: plugin.status.state } });
  }
  if (diagnostic.cleanup?.ok === false) checks.push({ id: "doctor.cleanup", severity: "error", status: "failed", phase: "cleanup", code: diagnostic.cleanup.failure?.code ?? "PLUGIN_CLEANUP_FAILED", message: diagnostic.cleanup.failure?.message });
  else if (diagnostic.cleanup) checks.push({ id: "doctor.cleanup", severity: "info", status: "passed", phase: "cleanup" });
  return {
    type: "diagnostic-result",
    ok: !checks.some((check) => check.severity === "error"),
    plugin: { id: plugin.manifest.id, name: plugin.manifest.name, version: plugin.manifest.version },
    registrations: registrationDetails,
    ...(plugin.status.state ? { health: { state: plugin.status.state } } : {}),
    ...(diagnostic.cleanup ? { cleanup: diagnostic.cleanup } : {}),
    checks,
  };
}

async function shutdown(reason = "RUNTIME_RESTARTED") {
  if (stopping) return;
  stopping = true;
  process.stdin.pause();
  process.stdin.removeAllListeners("data");
  process.stdin.destroy?.();
  const diagnosticPlugin = diagnosticMode ? activePlugins.find((plugin) => plugin.manifest.id === diagnosticPluginId) : undefined;
  await batchManager.interruptActive(reason);
  browserBridge.stop();
  for (const plugin of [...activePlugins]) await plugin.taskManager.stop({ preserveInterrupted: daemonMode });
  taskQueue.stop();
  for (const stream of eventStreams) stream.destroy();
  eventStreams.clear();
  await new Promise((resolve) => server.close(resolve));
  for (const plugin of [...activePlugins]) await deactivatePlugin(plugin, { skipTaskStop: true });
  if (diagnosticMode) process.stdout.write(`${JSON.stringify(diagnosticResult(diagnosticPlugin))}\n`);
  if (diagnosticKeepAlive) clearInterval(diagnosticKeepAlive);
  await runtimeLogger.info("runtime-stopped");
  await runtimeLogger.flush();
  browserSessions.clear();
  if (daemonMode) {
    await removeDaemonDiscovery(configuredDaemonPaths, { sessionId: applicationSessionId });
    await daemonLock?.release();
  }
  process.exitCode = 0;
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  for (const line of chunk.split(/\r?\n/)) {
    const value = line.trim();
    if (value === "shutdown") shutdown();
    else if (value.startsWith("shutdown:")) shutdown(value.slice("shutdown:".length) || "RUNTIME_RESTARTED");
  }
});
