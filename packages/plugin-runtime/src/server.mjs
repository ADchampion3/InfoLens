import { createServer } from "node:http";
import { createHash, randomUUID } from "node:crypto";
import { access, cp, copyFile, mkdir, mkdtemp, open, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
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
import { renderFactsHtml, renderFactsMarkdown } from "./daily-summary-renderer.mjs";
import { MailSecretStore, normalizeMailRecipients, normalizeMailSettings, publicMailSettings, sendSmtpMail } from "./mail.mjs";
import { Scheduler, SCHEDULER_RETRY, localDateKey, localDateTimeToInstant } from "./scheduler.mjs";
import { extractZip } from "@infolens/plugin-distribution/archive";
import { PluginDistributionModule } from "@infolens/plugin-distribution/module";
import { DEFAULT_SOURCE_LIMITS, DistributionError, downloadDistributionSource, normalizeDistributionFileName, stageLocalDistributionSource } from "@infolens/plugin-distribution/source";
import {
  acquireDaemonLock,
  daemonPaths,
  loadDaemonCredentials,
  removeDaemonDiscovery,
  rotateDaemonCredentials,
  writeDaemonDiscovery,
} from "./daemon-state.mjs";
import { createBackup, restoreBackup } from "./backup.mjs";

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
const schedulerDatabasePath = path.resolve(process.env.INFOLENS_SCHEDULER_DATABASE_PATH ?? (daemonMode ? configuredDaemonPaths.schedulerDatabasePath : path.join(path.dirname(dataRoot), "scheduler.sqlite")));
const mailSecretPath = path.resolve(process.env.INFOLENS_MAIL_SECRET_PATH ?? (daemonMode ? configuredDaemonPaths.mailSecretPath : path.join(path.dirname(dataRoot), "mail-secrets.json")));
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
const distributionRoot = path.resolve(process.env.INFOLENS_DISTRIBUTION_ROOT ?? (daemonMode ? configuredDaemonPaths.distributionRoot : path.join(path.dirname(dataRoot), "plugin-distribution")));
const distributionJournalRoot = path.resolve(process.env.INFOLENS_DISTRIBUTION_JOURNAL_ROOT ?? path.join(distributionRoot, "journals"));
const distributionRevisionRoot = path.resolve(process.env.INFOLENS_DISTRIBUTION_REVISION_ROOT ?? path.join(distributionRoot, "revisions"));
const distributionOperationRoot = path.join(distributionRoot, "operations");
const distributionStatusRoot = path.join(distributionRoot, "status");
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
let scheduler;
const mailSecretStore = new MailSecretStore(mailSecretPath);
const distributionLocks = new Map();
const distributionJournals = new Map();
const distributionModule = new PluginDistributionModule({
  maxOperations: 1_000,
  execute: ({ operation }) => executeDistributionOperation(operation),
  onCreate: async (operation) => {
    await persistDistributionStatus(operation);
    await writeDistributionJournal(operation);
    await runtimeLogger.info("distribution-operation-started", {
      operationId: operation.operationId,
      intent: operation.intent,
      ...(operation.pluginId ? { pluginId: operation.pluginId } : {}),
      ...(operation.source ? { source: publicDistributionSource(operation.source) } : {}),
    }).catch(() => {});
  },
  onComplete: async (operation, result) => {
    await persistDistributionStatus(operation).catch(() => {});
    await writeDistributionJournal(operation).catch(() => {});
    await runtimeLogger.info("distribution-operation-completed", {
      operationId: operation.operationId,
      intent: operation.intent,
      pluginId: operation.pluginId,
      version: result?.version,
      observedSha256: result?.observedSha256,
      ...(result?.previousRevision?.revisionId ? { revisionId: result.previousRevision.revisionId } : {}),
    }).catch(() => {});
    await removeDistributionJournal(operation.operationId).catch(() => {});
  },
  onFailure: async (operation) => {
    await updateDistributionOperation(operation, operation.state, operation.phase, { error: operation.error }).catch(() => {});
    await runtimeLogger[operation.state === "cancelled" ? "warn" : "error"]("distribution-operation-failed", {
      operationId: operation.operationId,
      intent: operation.intent,
      ...(operation.pluginId ? { pluginId: operation.pluginId } : {}),
      phase: operation.phase,
      ...operation.error,
    }).catch(() => {});
    await removeDistributionJournal(operation.operationId).catch(() => {});
  },
});
const distributionOperations = distributionModule.operations;
const distributionControllers = distributionModule.controllers;

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
    installedAt: new Date().toISOString(),
  };
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
  response.setHeader("access-control-allow-headers", "authorization, content-type, x-infolens-operation-id, x-infolens-bootstrap, x-infolens-distribution-intent, x-infolens-plugin-id, x-infolens-distribution-file-name, x-infolens-expected-sha256");
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
  }, { diagnostic, registrations: plugin.registrations, statePath: daemonMode ? path.join(configuredDaemonPaths.taskRecordsRoot, `${manifest.id}.json`) : undefined, enableSchedules: false });
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
    ...(provenance ? { origin: provenance.origin, provenance } : {}),
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

async function dailySummaryAggregate(signal, options = {}) {
  const now = options.now ?? (dailySummaryNow ? new Date(dailySummaryNow) : new Date());
  return aggregateDailySummary(
    (options.includeDisabled ? compatiblePlugins : compatiblePlugins.filter((descriptor) => !descriptor.deactivated)).map((descriptor) => dailySummaryPlugin(descriptor)),
    {
      now,
      timeZone: options.timeZone ?? dailySummaryTimeZone,
      localDate: options.localDate,
      windowStart: options.windowStart,
      windowEnd: options.windowEnd,
      pluginIds: options.pluginIds,
      includeDisabled: options.includeDisabled,
      signal,
    },
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
    ...(provenance ? { origin: provenance.origin, provenance } : {}),
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

function schedulerPluginState(pluginId) {
  const descriptor = findCompatible(pluginId);
  const plugin = findPlugin(pluginId);
  const enabled = Boolean(plugin && descriptor && !descriptor.deactivated && hostState.snapshot().enabledPluginIds.includes(pluginId));
  const active = Boolean(plugin && plugin.lifecycle && plugin.status.state !== "failed");
  return {
    installed: Boolean(descriptor),
    enabled,
    active,
    ...(plugin?.status?.failure ? { error: plugin.status.failure } : {}),
  };
}

function nextLocalDate(localDate) {
  const value = new Date(localDate + "T00:00:00.000Z");
  value.setUTCDate(value.getUTCDate() + 1);
  return value.toISOString().slice(0, 10);
}

async function waitForRefreshCommit(plugin, signal) {
  if (signal.aborted) {
    const error = new Error("Daily digest was canceled");
    error.code = "SCHEDULER_CANCELED";
    throw error;
  }
  const pending = [
    ...plugin.taskManager.pendingPromises("refresh"),
    ...scheduler.activeRefreshPromises(plugin.manifest.id),
  ];
  if (!pending.length) return;
  const deadlineMs = 60_000;
  let timer;
  let abort;
  const deadline = new Promise((resolve, reject) => {
    timer = setTimeout(() => {
      const error = new Error("Daily digest waited too long for the refresh to commit");
      error.code = "DIGEST_REFRESH_DEADLINE";
      error.retryable = true;
      reject(error);
    }, deadlineMs);
  });
  const canceled = new Promise((resolve, reject) => {
    abort = () => {
      const error = new Error("Daily digest was canceled");
      error.code = "SCHEDULER_CANCELED";
      reject(error);
    };
    signal.addEventListener("abort", abort, { once: true });
  });
  try {
    await Promise.race([Promise.allSettled(pending), deadline, canceled]);
  } catch (error) {
    if (error?.code === "DIGEST_REFRESH_DEADLINE" || error?.code === "SCHEDULER_CANCELED") throw error;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", abort);
  }
}

async function executeScheduledRefresh({ schedule, signal }) {
  const plugin = findPlugin(schedule.pluginId);
  if (!plugin) return { ok: false, status: "skipped", skipReason: "PLUGIN_UNAVAILABLE" };
  const operation = plugin.taskManager.enqueueDetailed("refresh", undefined, {
    reason: "schedule",
    coalesceKey: "collection",
  });
  const result = await operation.promise;
  return {
    ...(result && typeof result === "object" ? result : {}),
    ok: result?.ok !== false,
    operationId: operation.operationId,
  };
}

async function executeScheduledDigest({ schedule, run, periodKey, sourceRun, signal, resend }) {
  const currentRun = scheduler.getRun(run.runId) ?? run;
  let snapshot = currentRun.snapshotId ? scheduler.getSnapshot(currentRun.snapshotId) : undefined;
  if (resend && sourceRun?.snapshotId) snapshot = scheduler.getSnapshot(sourceRun.snapshotId);
  const generatedAt = new Date();
  const currentLocalDate = localDateKey(generatedAt, schedule.timeZone);
  const previousLocalDateValue = new Date(currentLocalDate + "T00:00:00.000Z");
  previousLocalDateValue.setUTCDate(previousLocalDateValue.getUTCDate() - 1);
  const localDate = snapshot?.localDate
    ?? periodKey
    ?? previousLocalDateValue.toISOString().slice(0, 10);
  if (!snapshot) {
    for (const pluginId of schedule.pluginIds) {
      const plugin = findPlugin(pluginId);
      if (plugin) await waitForRefreshCommit(plugin, signal);
    }
    const windowStart = localDateTimeToInstant(localDate, "00:00", schedule.timeZone);
    const windowEnd = localDateTimeToInstant(nextLocalDate(localDate), "00:00", schedule.timeZone);
    const aggregate = await dailySummaryAggregate(signal, {
      now: generatedAt,
      timeZone: schedule.timeZone,
      localDate,
      windowStart: windowStart.toISOString(),
      windowEnd: windowEnd.toISOString(),
      pluginIds: schedule.pluginIds,
      includeDisabled: true,
    });
    const markdown = renderFactsMarkdown(aggregate, schedule.pluginIds);
    snapshot = scheduler.store.saveSnapshot({
      runId: currentRun.runId,
      scheduleId: schedule.scheduleId,
      localDate,
      timeZone: schedule.timeZone,
      aggregate,
      markdown,
    });
  }
  const aggregate = snapshot.aggregate;
  const sourceSuccesses = (aggregate.plugins ?? []).filter((plugin) => ["ready", "no-data"].includes(plugin.status));
  if (!sourceSuccesses.length) {
    const error = new Error("All Daily Summary sources failed");
    error.code = "DIGEST_ALL_SOURCES_FAILED";
    throw error;
  }
  const recordCount = sourceSuccesses.reduce((total, plugin) => total + (plugin.context?.records?.length ?? 0), 0);
  if (!recordCount) return { ok: true, status: "skipped", skipReason: "NO_DATA", snapshotId: snapshot.snapshotId };
  const partial = (aggregate.plugins ?? []).some((plugin) => !["ready", "no-data"].includes(plugin.status));
  const settings = scheduler.getMailSettings();
  if (!settings.config) {
    const error = new Error("Mail settings are not configured");
    error.code = "MAIL_NOT_CONFIGURED";
    throw error;
  }
  const password = await mailSecretStore.read();
  if (!password) {
    const error = new Error("SMTP password is not configured");
    error.code = "MAIL_SECRET_MISSING";
    throw error;
  }
  const recipients = normalizeMailRecipients(schedule.recipients);
  const subject = "Infolens Daily Summary " + localDate + (partial ? " (partial)" : "");
  let delivery = currentRun.deliveryId ? scheduler.getDelivery(currentRun.deliveryId) : undefined;
  if (delivery?.state === "sent") return { ok: true, status: partial ? "partial" : "sent", snapshotId: snapshot.snapshotId, deliveryId: delivery.deliveryId, partial };
  if (delivery?.state === "unknown") {
    const error = new Error("SMTP delivery state is unknown; use manual resend");
    error.code = "DELIVERY_UNKNOWN";
    throw error;
  }
  if (!delivery) {
    delivery = scheduler.store.createDelivery({
      runId: currentRun.runId,
      scheduleId: schedule.scheduleId,
      periodKey: periodKey ?? localDate,
      recipients,
      subject,
      textBody: snapshot.markdown,
      htmlBody: renderFactsHtml(snapshot.markdown),
      configVersion: settings.version,
    });
  }
  scheduler.store.updateDelivery(delivery.deliveryId, {
    state: "sending",
    attempts: delivery.attempts + 1,
  });
  try {
    await sendSmtpMail(settings.config, password, {
      from: settings.config.from,
      recipients,
      subject,
      textBody: snapshot.markdown,
      htmlBody: renderFactsHtml(snapshot.markdown),
    });
  } catch (error) {
    scheduler.store.updateDelivery(delivery.deliveryId, {
      state: error?.uncertain ? "unknown" : "failed",
      error: { code: error?.code ?? "SMTP_FAILED", message: String(error?.message ?? error) },
    });
    if (error?.uncertain) error.retryable = false;
    throw error;
  }
  scheduler.store.updateDelivery(delivery.deliveryId, { state: "sent", sentAt: new Date().toISOString(), error: null });
  return { ok: true, status: partial ? "partial" : "sent", snapshotId: snapshot.snapshotId, deliveryId: delivery.deliveryId, partial };
}

function publicMailTest(audit) {
  return {
    ...audit,
    recipients: audit.recipients.map((value) => {
      const [local, domain] = value.split("@");
      return (local?.slice(0, 1) ?? "") + "***@" + domain;
    }),
  };
}

async function executeMailTest(body) {
  const settings = scheduler.getMailSettings();
  if (!settings.config) {
    const error = new Error("Mail settings are not configured");
    error.code = "MAIL_NOT_CONFIGURED";
    throw error;
  }
  const password = await mailSecretStore.read();
  if (!password) {
    const error = new Error("SMTP password is not configured");
    error.code = "MAIL_SECRET_MISSING";
    throw error;
  }
  const recipients = normalizeMailRecipients(body.recipients ?? body.to);
  const audit = scheduler.store.createMailTestAudit({ configVersion: settings.version, recipients });
  try {
    await sendSmtpMail(settings.config, password, {
      from: settings.config.from,
      recipients,
      subject: "Infolens SMTP test",
      textBody: "This is an Infolens SMTP configuration test.",
      htmlBody: "<p>This is an Infolens SMTP configuration test.</p>",
    });
    return publicMailTest(scheduler.store.updateMailTestAudit(audit.auditId, { state: "sent" }));
  } catch (error) {
    const state = error?.uncertain ? "unknown" : "failed";
    return publicMailTest(scheduler.store.updateMailTestAudit(audit.auditId, {
      state,
      error: { code: error?.code ?? "SMTP_FAILED", message: String(error?.message ?? error) },
    }));
  }
}

function createScheduler() {
  return new Scheduler({
    filename: schedulerDatabasePath,
    resolvePlugin: async (pluginId) => schedulerPluginState(pluginId),
    executeRefresh: executeScheduledRefresh,
    executeDigest: executeScheduledDigest,
    retry: SCHEDULER_RETRY,
    onEvent: async (event, details) => {
      emitDaemonEvent("scheduler-" + event, details);
      await runtimeLogger.info("scheduler-" + event, details).catch(() => {});
    },
  });
}

function reconcileSchedulerPlugins() {
  for (const schedule of scheduler.list()) {
    const ids = schedule.kind === "refresh" ? [schedule.pluginId] : schedule.pluginIds;
    if (ids.some((pluginId) => !findCompatible(pluginId))) {
      for (const pluginId of ids.filter((id) => !findCompatible(id))) scheduler.store.markSchedulesOrphaned(pluginId);
    }
  }
  scheduler.store.restoreOrphanedSchedules(compatiblePlugins.map((descriptor) => descriptor.validated.manifest.id));
}

async function deactivatePlugin(plugin, options = {}) {
  const deactivationGuard = typeof options.deactivationGuard === "function" ? options.deactivationGuard : () => true;
  const deferRouteCleanup = options.deferRouteCleanup === true;
  if (plugin.diagnostic) {
    plugin.diagnostic.phase = "cleanup";
    process.stdout.write(`${JSON.stringify({ type: "diagnostic-phase", pluginId: plugin.manifest.id, phase: "cleanup" })}\n`);
  }
  if (!options.skipTaskStop) await plugin.taskManager.stop(options);
  if (!deactivationGuard()) return { ok: false, phase: "cleanup", failure: { code: "PLUGIN_DEACTIVATION_TIMED_OUT", message: "Plugin deactivation finished after its Runtime deadline" } };
  if (!deferRouteCleanup) plugin.routes.clear();
  let cleanup;
  try {
    await plugin.lifecycle?.deactivate?.();
    if (!deactivationGuard()) return { ok: false, phase: "cleanup", failure: { code: "PLUGIN_DEACTIVATION_TIMED_OUT", message: "Plugin deactivation finished after its Runtime deadline" } };
    if (deferRouteCleanup) plugin.routes.clear();
    await plugin.logger.info("plugin-deactivated");
    emitStatus("deactivated", plugin.manifest.id);
    cleanup = { ok: true, phase: "cleanup" };
  } catch (error) {
    if (!deactivationGuard()) return { ok: false, phase: "cleanup", failure: { code: "PLUGIN_DEACTIVATION_TIMED_OUT", message: "Plugin deactivation finished after its Runtime deadline" } };
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

function requestHeader(request, name) {
  const value = request.headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

function uploadedDistributionFileName(request) {
  const raw = requestHeader(request, "x-infolens-distribution-file-name");
  if (!raw) return undefined;
  let decoded;
  try { decoded = decodeURIComponent(raw); } catch { throw new DistributionError("DISTRIBUTION_FILE_NAME_INVALID", "Distribution file name is invalid"); }
  return normalizeDistributionFileName(decoded);
}

async function receiveDistributionUpload(request, destination, maxBytes = DEFAULT_SOURCE_LIMITS.maxTemporaryBytes) {
  const declaredLength = Number(requestHeader(request, "content-length") ?? 0);
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    request.resume();
    throw new DistributionError("DISTRIBUTION_UPLOAD_TOO_LARGE", "Distribution upload exceeds the temporary storage limit");
  }
  await mkdir(path.dirname(destination), { recursive: true });
  const handle = await open(destination, "wx", 0o600);
  let received = 0;
  let complete = false;
  try {
    for await (const chunk of request) {
      const value = Buffer.from(chunk);
      received += value.length;
      if (received > maxBytes) throw new DistributionError("DISTRIBUTION_UPLOAD_TOO_LARGE", "Distribution upload exceeds the temporary storage limit");
      await handle.write(value);
    }
    if (!received) throw new DistributionError("DISTRIBUTION_UPLOAD_EMPTY", "Distribution upload is empty");
    complete = true;
    return received;
  } finally {
    await handle.close().catch(() => {});
    if (!complete) await rm(destination, { force: true });
  }
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

function safeDistributionSegment(value) {
  const raw = String(value);
  if (/^[A-Za-z0-9._-]{1,160}$/u.test(raw) && raw !== "." && raw !== "..") return raw;
  return "operation-" + createHash("sha256").update(raw).digest("hex").slice(0, 48);
}

function pathIsWithin(root, target) {
  const relation = path.relative(path.resolve(root), path.resolve(target));
  return relation === "" || (!relation.startsWith("..") && !path.isAbsolute(relation));
}

function isManagedPluginId(value) {
  return typeof value === "string" && /^[a-z0-9][a-z0-9-]*$/u.test(value);
}

function managedChildPath(root, target, label) {
  if (typeof target !== "string") throw new Error(`${label} is missing`);
  const resolved = path.resolve(target);
  const relation = path.relative(path.resolve(root), resolved);
  if (!relation || relation.startsWith("..") || path.isAbsolute(relation)) throw new Error(`${label} is outside its managed directory`);
  return resolved;
}

function maybeManagedChildPath(root, target, label) {
  if (typeof target !== "string") return undefined;
  try { return managedChildPath(root, target, label); } catch { return undefined; }
}

function journalOperationRoot(journal) {
  const target = journal.paths?.operationRoot
    ?? (typeof journal.operationId === "string" ? distributionOperationPath(journal.operationId) : undefined);
  return target ? maybeManagedChildPath(distributionOperationRoot, target, "Distribution operation") : undefined;
}

function distributionJournalPath(operationId) {
  return path.join(distributionJournalRoot, safeDistributionSegment(operationId) + ".json");
}

function distributionStatusPath(operationId) {
  return path.join(distributionStatusRoot, safeDistributionSegment(operationId) + ".json");
}

function distributionOperationPath(operationId) {
  return path.join(distributionOperationRoot, safeDistributionSegment(operationId));
}

function publicDistributionSource(source) {
  if (!source) return undefined;
  return {
    kind: source.kind,
    ...(source.url ? { url: source.url } : {}),
    ...(source.fileName ? { fileName: source.fileName } : {}),
    ...(source.expectedSha256 ? { expectedSha256: source.expectedSha256 } : {}),
  };
}

function publicDistributionOperation(operation) {
  if (!operation) return undefined;
  return {
    operationId: operation.operationId,
    intent: operation.intent,
    ...(operation.pluginId ? { pluginId: operation.pluginId } : {}),
    state: operation.state,
    phase: operation.phase,
    createdAt: operation.createdAt,
    updatedAt: operation.updatedAt,
    ...(publicDistributionSource(operation.source) ? { source: publicDistributionSource(operation.source) } : {}),
    ...(operation.progress ? { progress: structuredClone(operation.progress) } : {}),
    ...(operation.candidateVersion ? { candidateVersion: operation.candidateVersion } : {}),
    ...(operation.candidateSha256 ? { candidateSha256: operation.candidateSha256 } : {}),
    ...(operation.currentVersion ? { currentVersion: operation.currentVersion } : {}),
    ...(operation.currentSha256 ? { currentSha256: operation.currentSha256 } : {}),
    ...(operation.observedSha256 ? { observedSha256: operation.observedSha256 } : {}),
    ...(operation.previousOperationId ? { previousOperationId: operation.previousOperationId } : {}),
    ...(operation.revisionId ? { revisionId: operation.revisionId } : {}),
    ...(operation.result ? { result: structuredClone(operation.result) } : {}),
    ...(operation.error ? { error: structuredClone(operation.error) } : {}),
  };
}

async function writeJsonAtomically(filename, value) {
  await mkdir(path.dirname(filename), { recursive: true });
  const temporary = filename + "." + process.pid + "." + randomUUID() + ".tmp";
  try {
    await writeFile(temporary, JSON.stringify(value, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
    await rename(temporary, filename);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function persistDistributionStatus(operation) {
  const { promise: _promise, controller: _controller, signal: _signal, ...serializable } = operation;
  await writeJsonAtomically(distributionStatusPath(operation.operationId), serializable);
}

async function writeDistributionJournal(operation, extra = {}) {
  const journal = {
    version: 1,
    operationId: operation.operationId,
    intent: operation.intent,
    ...(operation.pluginId ? { pluginId: operation.pluginId } : {}),
    phase: operation.phase,
    state: operation.state,
    source: publicDistributionSource(operation.source),
    createdAt: operation.createdAt,
    updatedAt: operation.updatedAt,
    ...(operation.candidateVersion ? { candidateVersion: operation.candidateVersion } : {}),
    ...(operation.candidateSha256 ? { candidateSha256: operation.candidateSha256 } : {}),
    ...(operation.currentVersion ? { currentVersion: operation.currentVersion } : {}),
    ...(operation.currentSha256 ? { currentSha256: operation.currentSha256 } : {}),
    ...(operation.observedSha256 ? { observedSha256: operation.observedSha256 } : {}),
    ...(operation.previousOperationId ? { previousOperationId: operation.previousOperationId } : {}),
    ...(operation.paths ? { paths: structuredClone(operation.paths) } : {}),
    ...(operation.revision ? { revision: structuredClone(operation.revision) } : {}),
    ...(operation.oldInstallation ? { oldInstallation: structuredClone(operation.oldInstallation) } : {}),
    ...(operation.oldEnabled !== undefined ? { oldEnabled: operation.oldEnabled } : {}),
    ...(operation.oldStatusSnapshot ? { oldStatusSnapshot: structuredClone(operation.oldStatusSnapshot) } : {}),
    ...(operation.result ? { result: structuredClone(operation.result) } : {}),
    ...(operation.error ? { error: structuredClone(operation.error) } : {}),
    ...extra,
  };
  distributionJournals.set(operation.operationId, journal);
  await writeJsonAtomically(distributionJournalPath(operation.operationId), journal);
}

async function removeDistributionJournal(operationId) {
  distributionJournals.delete(operationId);
  await rm(distributionJournalPath(operationId), { force: true });
}

async function updateDistributionOperation(operation, state, phase, details = {}) {
  Object.assign(operation, details, { state, phase, updatedAt: new Date().toISOString() });
  await persistDistributionStatus(operation);
  await writeDistributionJournal(operation);
  emitDaemonEvent("distribution-progress", publicDistributionOperation(operation));
  return publicDistributionOperation(operation);
}

async function loadDistributionStatuses() {
  try {
    for (const entry of await readdir(distributionStatusRoot, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      try {
        const value = JSON.parse(await readFile(path.join(distributionStatusRoot, entry.name), "utf8"));
        if (typeof value.operationId === "string") distributionOperations.set(value.operationId, value);
      } catch {}
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

async function copyPathIfPresent(source, destination) {
  try {
    const details = await stat(source);
    await rm(destination, { recursive: true, force: true });
    if (details.isDirectory()) await cp(source, destination, { recursive: true, errorOnExist: true });
    else if (details.isFile()) {
      await mkdir(path.dirname(destination), { recursive: true });
      await copyFile(source, destination, { force: false });
    } else throw new Error("Managed distribution state must contain regular files or directories");
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

function revisionDescriptor(id, revisionId, installation, enabled, createdAt) {
  return {
    revisionId,
    id,
    version: installation?.version,
    origin: installation?.origin,
    ...(installation?.sourceUrl ? { sourceUrl: installation.sourceUrl } : {}),
    ...(installation?.sourceFileName ? { sourceFileName: installation.sourceFileName } : {}),
    ...(installation?.expectedSha256 ? { expectedSha256: installation.expectedSha256 } : {}),
    ...(installation?.observedSha256 ? { observedSha256: installation.observedSha256 } : {}),
    enabled: Boolean(enabled),
    createdAt,
  };
}

async function createRevisionSnapshot(id, packageRoot, installation, enabled, statusSnapshot) {
  if (!isManagedPluginId(id)) throw new ContractError("DISTRIBUTION_PLUGIN_ID_INVALID", "Plugin ID is not safe for a distribution revision");
  const revisionId = Date.now() + "-" + randomUUID();
  const root = path.join(distributionRevisionRoot, id, revisionId);
  const packageSnapshot = path.join(root, "package");
  const createdAt = new Date().toISOString();
  const descriptor = revisionDescriptor(id, revisionId, installation, enabled, createdAt);
  try {
    await mkdir(path.join(distributionRevisionRoot, id), { recursive: true });
    if (!await copyPathIfPresent(packageRoot, packageSnapshot)) throw new Error("Current Plugin package is missing");
    await copyPathIfPresent(path.join(dataRoot, id), path.join(root, "data"));
    await copyPathIfPresent(path.join(adapterRegistryRoot, "scopes", id), path.join(root, "adapter-scope"));
    await writeJsonAtomically(path.join(root, "metadata.json"), {
      version: 1,
      pluginId: id,
      revisionId,
      complete: true,
      installation: structuredClone(installation ?? {}),
      enabled: Boolean(enabled),
      ...(statusSnapshot ? { statusSnapshot: structuredClone(statusSnapshot) } : {}),
      descriptor,
      createdAt,
    });
    await writeFile(path.join(root, ".complete"), "complete\n", { flag: "wx" });
    return { root, revisionId, descriptor };
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    const failure = new ContractError("DISTRIBUTION_SNAPSHOT_FAILED", "Plugin revision snapshot could not be completed");
    failure.cause = error;
    throw failure;
  }
}

async function removeRevision(id, revision) {
  const revisionId = typeof revision === "string" ? revision : revision?.revisionId;
  if (!revisionId || !/^[A-Za-z0-9._-]+$/u.test(revisionId)) return;
  const root = path.join(distributionRevisionRoot, id, revisionId);
  if (!pathIsWithin(distributionRevisionRoot, root)) throw new Error("Refusing to remove a revision outside the distribution directory");
  await rm(root, { recursive: true, force: true });
  const parent = path.join(distributionRevisionRoot, id);
  try { if ((await readdir(parent)).length === 0) await rm(parent, { recursive: true, force: true }); } catch (error) { if (error?.code !== "ENOENT") throw error; }
}

async function readCompleteRevision(id, revision) {
  if (!isManagedPluginId(id)) throw new ContractError("DISTRIBUTION_PLUGIN_ID_INVALID", "Plugin ID is not safe for a distribution revision");
  const revisionId = typeof revision === "string" ? revision : revision?.revisionId;
  if (!revisionId || !/^[A-Za-z0-9._-]+$/u.test(revisionId)) throw new ContractError("DISTRIBUTION_REVISION_UNAVAILABLE", "The previous Plugin revision identity is invalid");
  const root = path.join(distributionRevisionRoot, id, revisionId);
  if (!pathIsWithin(distributionRevisionRoot, root) || path.relative(distributionRevisionRoot, root) === "") throw new ContractError("DISTRIBUTION_REVISION_UNAVAILABLE", "The previous Plugin revision path is invalid");
  try {
    const metadata = JSON.parse(await readFile(path.join(root, "metadata.json"), "utf8"));
    if (metadata.complete !== true || metadata.pluginId !== id || metadata.revisionId !== revisionId) throw new Error("revision metadata is incomplete");
    await access(path.join(root, ".complete"));
    const packageRoot = path.join(root, "package");
    if (!(await stat(packageRoot)).isDirectory()) throw new Error("revision package is missing");
    return { root, metadata, packageRoot };
  } catch (error) {
    const failure = new ContractError("DISTRIBUTION_REVISION_UNAVAILABLE", "The previous Plugin revision is missing or incomplete");
    failure.cause = error;
    throw failure;
  }
}

async function restoreStateSnapshot(id, root) {
  if (!isManagedPluginId(id)) throw new Error("Plugin ID is not safe for restoring distribution state");
  const revisionRoot = managedChildPath(distributionRevisionRoot, root, "Distribution revision snapshot");
  await rm(path.join(dataRoot, id), { recursive: true, force: true });
  await copyPathIfPresent(path.join(revisionRoot, "data"), path.join(dataRoot, id));
  const guard = path.join(adapterRegistryRoot, "scopes", ".recovery-" + safeDistributionSegment(id) + "-" + randomUUID());
  const hasScope = await copyPathIfPresent(path.join(revisionRoot, "adapter-scope"), guard);
  await removePluginAdapterScope(adapterRegistryRoot, id);
  if (hasScope) {
    const target = path.join(adapterRegistryRoot, "scopes", id);
    await rm(target, { recursive: true, force: true });
    await rename(guard, target);
  } else {
    await rm(guard, { recursive: true, force: true });
  }
  await garbageCollectAdapterStore(adapterRegistryRoot);
}

async function restoreJournalHostState(journal) {
  const id = journal.pluginId;
  if (!id) return;
  if (!isManagedPluginId(id)) throw new Error("Distribution journal Plugin ID is invalid");
  await hostState.update((state) => {
    const pluginInstallations = { ...(state.pluginInstallations ?? {}) };
    const statusSnapshots = { ...(state.statusSnapshots ?? {}) };
    const enabledPluginIds = state.enabledPluginIds.filter((pluginId) => pluginId !== id);
    if (journal.oldInstallation) pluginInstallations[id] = journal.oldInstallation;
    else delete pluginInstallations[id];
    if (journal.oldEnabled) enabledPluginIds.push(id);
    if (journal.oldStatusSnapshot) statusSnapshots[id] = journal.oldStatusSnapshot;
    else delete statusSnapshots[id];
    return { ...state, enabledPluginIds: [...new Set(enabledPluginIds)], pluginInstallations, statusSnapshots };
  });
}

function assertDistributionCandidate(id, { intent, pluginId, version, observedSha256 } = {}) {
  if (pluginId && pluginId !== id) throw new ContractError("DISTRIBUTION_PLUGIN_ID_MISMATCH", "The distribution archive Plugin ID does not match the requested Plugin ID");
  const descriptor = findCompatible(id);
  const rejection = rejectedPlugins.find((plugin) => plugin.id === id || plugin.package === id);
  if (intent === "install") {
    if (bundledPluginIds.has(id) || installationRecord(id)?.origin === "bundled") throw new ContractError("DISTRIBUTION_BUNDLED_CONFLICT", "An external distribution cannot install over a Bundled Plugin");
    if (descriptor || rejection || installingPluginIds.has(id)) throw new ContractError("DUPLICATE_PLUGIN_ID", "The Plugin ID is already installed; use explicit replacement");
    return;
  }
  if (!descriptor || rejection) throw new ContractError("PLUGIN_NOT_FOUND", "The external Plugin to replace is not installed and compatible");
  const current = installationRecord(id);
  if (bundledPluginIds.has(id) || current?.origin === "bundled") throw new ContractError("DISTRIBUTION_BUNDLED_REPLACE_FORBIDDEN", "A Bundled Plugin can only be updated by a Host release");
  if (intent === "replace" && version && observedSha256 && current?.version === version && current.observedSha256 && current.observedSha256 !== observedSha256) {
    throw new ContractError("DISTRIBUTION_SAME_VERSION_DIGEST_CONFLICT", "The same Plugin version has a different archive digest");
  }
}

function relocateValidated(validated, fromRoot, toRoot) {
  const relocate = (value) => path.join(toRoot, path.relative(fromRoot, value));
  return { ...validated, backendPath: relocate(validated.backendPath), workspaceEntry: relocate(validated.workspaceEntry), workspaceRoot: relocate(validated.workspaceRoot) };
}

async function preflightDistributionCandidate(packageRoot) {
  const preflightRegistryRoot = await mkdtemp(path.join(os.tmpdir(), "infolens-adapter-preflight-"));
  try { return await validatePluginPackage(packageRoot, validationRuntime, adapterScopeOptions(preflightRegistryRoot)); }
  finally { await rm(preflightRegistryRoot, { recursive: true, force: true }); }
}

function installationForDistribution(validated, source, observedSha256, operationId) {
  return {
    origin: source.kind,
    version: validated.manifest.version,
    contractVersion: String(validated.manifest.contractVersion),
    minHostVersion: validated.manifest.minHostVersion,
    ...(source.kind === "url" ? { sourceUrl: source.url } : { sourceFileName: source.fileName }),
    ...(source.expectedSha256 ? { expectedSha256: source.expectedSha256 } : {}),
    observedSha256,
    installedAt: new Date().toISOString(),
    operationId,
  };
}

async function disposePluginInstance(plugin) {
  if (!plugin) return;
  await plugin.taskManager.stop().catch(() => {});
  plugin.routes.clear();
  const index = activePlugins.indexOf(plugin);
  if (index >= 0) activePlugins.splice(index, 1);
  await plugin.logger.flush().catch(() => {});
}

async function deactivateForDistribution(id) {
  const active = findPlugin(id);
  if (!active) return;
  const graceMs = Number(process.env.INFOLENS_DEACTIVATION_GRACE_MS) || 2_500;
  let timedOut = false;
  let timer;
  const settled = await Promise.race([
    deactivatePlugin(active, { deferRouteCleanup: true, deactivationGuard: () => !timedOut }).then((cleanup) => cleanup?.ok !== false),
    new Promise((resolve) => { timer = setTimeout(() => { timedOut = true; resolve(false); }, graceMs); }),
  ]);
  if (timer) clearTimeout(timer);
  if (!settled) throw new ContractError("RUNTIME_RESTART_REQUIRED", "Plugin '" + id + "' did not deactivate within " + graceMs + "ms; restart Runtime before replacement");
}

async function withDistributionLock(id, action) {
  const previous = distributionLocks.get(id) ?? Promise.resolve();
  const current = previous.catch(() => {}).then(action);
  distributionLocks.set(id, current);
  try { return await current; }
  finally { if (distributionLocks.get(id) === current) distributionLocks.delete(id); }
}

async function commitInitialDistributionCandidate(operation, stageRoot, validated, sourceInfo) {
  const id = validated.manifest.id;
  assertDistributionCandidate(id, { intent: "install", pluginId: operation.pluginId, version: validated.manifest.version, observedSha256: sourceInfo.sha256 });
  const destination = path.join(pluginsRoot, id);
  const previousState = hostState.snapshot();
  operation.pluginId = id;
  operation.paths = { ...(operation.paths ?? {}), candidatePath: stageRoot, destinationPath: destination, packageCommitted: false };
  operation.candidateVersion = validated.manifest.version;
  operation.candidateSha256 = sourceInfo.sha256;
  installingPluginIds.add(id);
  let descriptor;
  let activated;
  try {
    await updateDistributionOperation(operation, "committing", "switching");
    await mkdir(pluginsRoot, { recursive: true });
    await rename(stageRoot, destination);
    operation.paths.packageCommitted = true;
    await updateDistributionOperation(operation, "committing", "package-switched");
    const relocated = relocateValidated(await validatePluginPackage(destination, validationRuntime, contractOptions), destination, destination);
    descriptor = { validated: relocated, packageRoot: destination, deactivated: false, unloaded: false };
    compatiblePlugins.push(descriptor);
    await updateDistributionOperation(operation, "committing", "activation");
    activated = await activatePlugin(relocated, destination);
    if (activated?.status.state === "failed") {
      const failure = activated.status.failure;
      throw new ContractError(failure?.code ?? "DISTRIBUTION_ACTIVATION_FAILED", failure?.message ?? "The Plugin failed during activation");
    }
    const installation = installationForDistribution(relocated, operation.source, sourceInfo.sha256, operation.operationId);
    await hostState.update((state) => ({
      ...state,
      enabledPluginIds: [...new Set([...state.enabledPluginIds, id])],
      pluginInstallations: { ...(state.pluginInstallations ?? {}), [id]: installation },
    }));
    const result = { pluginId: id, version: relocated.manifest.version, observedSha256: sourceInfo.sha256, intent: "install" };
    await updateDistributionOperation(operation, "completed", "completed", { result });
    return result;
  } catch (error) {
    if (activated) {
      await deactivatePlugin(activated).catch(() => disposePluginInstance(activated));
    }
    if (descriptor) {
      const index = compatiblePlugins.indexOf(descriptor);
      if (index >= 0) compatiblePlugins.splice(index, 1);
    }
    if (operation.paths.packageCommitted) await rm(destination, { recursive: true, force: true });
    await rm(path.join(dataRoot, id), { recursive: true, force: true });
    await removePluginAdapterScope(adapterRegistryRoot, id).catch(() => {});
    await hostState.update(() => previousState).catch(() => {});
    throw error;
  } finally {
    installingPluginIds.delete(id);
  }
}

async function restoreDistributionTransaction({ id, destination, backup, snapshotRoot, oldDescriptor, oldIndex, oldState, oldEnabled, candidateDescriptor, candidatePlugin, switched }) {
  if (candidatePlugin) await deactivatePlugin(candidatePlugin).catch(() => disposePluginInstance(candidatePlugin));
  if (candidateDescriptor) {
    const candidateIndex = compatiblePlugins.indexOf(candidateDescriptor);
    if (candidateIndex >= 0) compatiblePlugins.splice(candidateIndex, 1);
  }
  if (switched) {
    await rm(destination, { recursive: true, force: true });
    if (backup && await access(backup).then(() => true).catch(() => false)) await rename(backup, destination);
    if (snapshotRoot) await restoreStateSnapshot(id, snapshotRoot);
  }
  await hostState.update(() => oldState);
  if (oldIndex >= 0) compatiblePlugins[oldIndex] = oldDescriptor;
  else if (!compatiblePlugins.includes(oldDescriptor)) compatiblePlugins.push(oldDescriptor);
  oldDescriptor.packageRoot = destination;
  oldDescriptor.deactivated = !oldEnabled;
  oldDescriptor.unloaded = false;
  if (oldEnabled && !findPlugin(id)) {
    const restored = await activatePlugin(oldDescriptor.validated, destination);
    if (restored?.status.state === "failed") {
      const failure = restored.status.failure;
      throw new ContractError("DISTRIBUTION_RECOVERY_FAILED", failure?.message ?? "The previous Plugin could not be reactivated");
    }
  }
}

async function commitReplacementDistributionCandidate(operation, stageRoot, validated, sourceInfo) {
  const id = validated.manifest.id;
  assertDistributionCandidate(id, { intent: "replace", pluginId: operation.pluginId, version: validated.manifest.version, observedSha256: sourceInfo.sha256 });
  const oldDescriptor = findCompatible(id);
  const oldIndex = compatiblePlugins.indexOf(oldDescriptor);
  const oldState = hostState.snapshot();
  const oldRecord = installationRecord(id) ?? { origin: "local", version: oldDescriptor.validated.manifest.version };
  const oldEnabled = oldState.enabledPluginIds.includes(id) && !oldDescriptor.deactivated;
  operation.pluginId = id;
  operation.currentVersion = oldDescriptor.validated.manifest.version;
  operation.currentSha256 = oldRecord.observedSha256;
  operation.candidateVersion = validated.manifest.version;
  operation.candidateSha256 = sourceInfo.sha256;
  if (oldRecord.version === validated.manifest.version && oldRecord.observedSha256 === sourceInfo.sha256) {
    const result = { pluginId: id, version: validated.manifest.version, observedSha256: sourceInfo.sha256, intent: "replace", state: "already-current" };
    await updateDistributionOperation(operation, "completed", "completed", { result });
    return result;
  }
  let revision;
  let candidateDescriptor;
  let candidatePlugin;
  let switched = false;
  const destination = oldDescriptor.packageRoot;
  const backup = path.join(distributionOperationPath(operation.operationId), "current-package");
  try {
    operation.oldInstallation = oldRecord;
    operation.oldEnabled = oldEnabled;
    operation.oldStatusSnapshot = oldState.statusSnapshots[id];
    operation.paths = { ...(operation.paths ?? {}), candidatePath: stageRoot, destinationPath: destination, switchBackupPath: backup, packageCommitted: false };
    await updateDistributionOperation(operation, "committing", "deactivating");
    await deactivateForDistribution(id);
    await updateDistributionOperation(operation, "committing", "snapshotting");
    revision = await createRevisionSnapshot(id, destination, oldRecord, oldEnabled, oldState.statusSnapshots[id]);
    operation.revision = revision.descriptor;
    operation.paths.snapshotRoot = revision.root;
    await updateDistributionOperation(operation, "committing", "switching");
    await rename(destination, backup);
    switched = true;
    await rename(stageRoot, destination);
    operation.paths.packageCommitted = true;
    await updateDistributionOperation(operation, "committing", "package-switched");
    const relocated = relocateValidated(await validatePluginPackage(destination, validationRuntime, contractOptions), destination, destination);
    candidateDescriptor = { validated: relocated, packageRoot: destination, deactivated: !oldEnabled, unloaded: false };
    compatiblePlugins[oldIndex] = candidateDescriptor;
    await updateDistributionOperation(operation, "committing", "activation");
    if (oldEnabled) {
      candidatePlugin = await activatePlugin(relocated, destination);
      if (candidatePlugin?.status.state === "failed") {
        const failure = candidatePlugin.status.failure;
        throw new ContractError(failure?.code ?? "DISTRIBUTION_ACTIVATION_FAILED", failure?.message ?? "The replacement Plugin failed during activation");
      }
    }
    const installation = installationForDistribution(relocated, operation.source, sourceInfo.sha256, operation.operationId);
    installation.previousRevision = revision.descriptor;
    await hostState.update((state) => ({
      ...state,
      enabledPluginIds: oldEnabled ? [...new Set([...state.enabledPluginIds, id])] : state.enabledPluginIds.filter((pluginId) => pluginId !== id),
      statusSnapshots: oldEnabled ? state.statusSnapshots : {
        ...state.statusSnapshots,
        [id]: { ...(state.statusSnapshots[id] ?? {}), state: "disabled", updatedAt: new Date().toISOString() },
      },
      pluginInstallations: { ...(state.pluginInstallations ?? {}), [id]: installation },
    }));
    const result = {
      pluginId: id,
      version: relocated.manifest.version,
      observedSha256: sourceInfo.sha256,
      previousRevision: revision.descriptor,
      intent: "replace",
    };
    await updateDistributionOperation(operation, "completed", "completed", { result });
    await rm(backup, { recursive: true, force: true }).catch(() => {});
    await removeRevision(id, oldRecord.previousRevision).catch(() => {});
    await garbageCollectAdapterStore(adapterRegistryRoot).catch(() => {});
    return result;
  } catch (error) {
    try {
      await restoreDistributionTransaction({
        id,
        destination,
        backup,
        snapshotRoot: revision?.root,
        oldDescriptor,
        oldIndex,
        oldState,
        oldEnabled,
        candidateDescriptor,
        candidatePlugin,
        switched,
      });
      if (revision) await removeRevision(id, revision.descriptor);
    } catch (recoveryError) {
      const failure = new ContractError("DISTRIBUTION_RECOVERY_FAILED", "The previous Plugin could not be restored safely");
      failure.cause = recoveryError;
      throw failure;
    }
    throw error;
  }
}

async function commitRollbackDistributionCandidate(operation, pluginId) {
  const id = pluginId;
  const oldDescriptor = findCompatible(id);
  if (!oldDescriptor) throw new ContractError("PLUGIN_NOT_FOUND", "The Plugin to roll back is not installed and compatible");
  const oldRecord = installationRecord(id);
  if (!oldRecord || oldRecord.origin === "bundled") throw new ContractError("DISTRIBUTION_ROLLBACK_FORBIDDEN", "Bundled Plugins do not use personal distribution rollback");
  const previous = oldRecord.previousRevision;
  const previousRevision = await readCompleteRevision(id, previous);
  const previousValidated = await preflightDistributionCandidate(previousRevision.packageRoot);
  if (previousValidated.manifest.id !== id) throw new ContractError("DISTRIBUTION_REVISION_INVALID", "The previous revision Plugin ID does not match the installed Plugin");
  const oldIndex = compatiblePlugins.indexOf(oldDescriptor);
  const oldState = hostState.snapshot();
  const oldEnabled = oldState.enabledPluginIds.includes(id) && !oldDescriptor.deactivated;
  operation.currentVersion = oldDescriptor.validated.manifest.version;
  operation.currentSha256 = oldRecord.observedSha256;
  operation.candidateVersion = previousValidated.manifest.version;
  operation.candidateSha256 = previousRevision.metadata.installation?.observedSha256;
  operation.oldInstallation = oldRecord;
  operation.oldEnabled = oldEnabled;
  operation.oldStatusSnapshot = oldState.statusSnapshots[id];
  const destination = oldDescriptor.packageRoot;
  const operationRoot = distributionOperationPath(operation.operationId);
  const backup = path.join(operationRoot, "current-package");
  const candidateRoot = path.join(operationRoot, "rollback-package");
  let currentRevision;
  let candidateDescriptor;
  let candidatePlugin;
  let switched = false;
  try {
    await mkdir(operationRoot, { recursive: true });
    await updateDistributionOperation(operation, "committing", "deactivating", { paths: { operationRoot, destinationPath: destination, switchBackupPath: backup, candidatePath: candidateRoot } });
    await deactivateForDistribution(id);
    await updateDistributionOperation(operation, "committing", "snapshotting");
    currentRevision = await createRevisionSnapshot(id, destination, oldRecord, oldEnabled, oldState.statusSnapshots[id]);
    operation.revision = currentRevision.descriptor;
    operation.paths.snapshotRoot = currentRevision.root;
    await copyPathIfPresent(previousRevision.packageRoot, candidateRoot);
    await updateDistributionOperation(operation, "committing", "switching");
    await rename(destination, backup);
    switched = true;
    await copyPathIfPresent(candidateRoot, destination);
    operation.paths.packageCommitted = true;
    await restoreStateSnapshot(id, previousRevision.root);
    await updateDistributionOperation(operation, "committing", "package-switched");
    const relocated = relocateValidated(await validatePluginPackage(destination, validationRuntime, contractOptions), destination, destination);
    const enabled = Boolean(previousRevision.metadata.enabled);
    candidateDescriptor = { validated: relocated, packageRoot: destination, deactivated: !enabled, unloaded: false };
    compatiblePlugins[oldIndex] = candidateDescriptor;
    await updateDistributionOperation(operation, "committing", "activation");
    if (enabled) {
      candidatePlugin = await activatePlugin(relocated, destination);
      if (candidatePlugin?.status.state === "failed") {
        const failure = candidatePlugin.status.failure;
        throw new ContractError(failure?.code ?? "DISTRIBUTION_ACTIVATION_FAILED", failure?.message ?? "The rollback Plugin failed during activation");
      }
    }
    const { previousRevision: ignored, ...previousInstallation } = previousRevision.metadata.installation ?? {};
    const installation = { ...previousInstallation, previousRevision: currentRevision.descriptor };
    await hostState.update((state) => ({
      ...state,
      enabledPluginIds: enabled ? [...new Set([...state.enabledPluginIds, id])] : state.enabledPluginIds.filter((pluginId) => pluginId !== id),
      statusSnapshots: enabled ? state.statusSnapshots : {
        ...state.statusSnapshots,
        [id]: { ...(state.statusSnapshots[id] ?? {}), state: "disabled", updatedAt: new Date().toISOString() },
      },
      pluginInstallations: { ...(state.pluginInstallations ?? {}), [id]: installation },
    }));
    const result = { pluginId: id, version: relocated.manifest.version, ...(operation.candidateSha256 ? { observedSha256: operation.candidateSha256 } : {}), previousRevision: currentRevision.descriptor, intent: "rollback" };
    await updateDistributionOperation(operation, "completed", "completed", { result });
    await rm(backup, { recursive: true, force: true }).catch(() => {});
    await removeRevision(id, previous);
    await garbageCollectAdapterStore(adapterRegistryRoot).catch(() => {});
    return result;
  } catch (error) {
    try {
      await restoreDistributionTransaction({
        id,
        destination,
        backup,
        snapshotRoot: currentRevision?.root,
        oldDescriptor,
        oldIndex,
        oldState,
        oldEnabled,
        candidateDescriptor,
        candidatePlugin,
        switched,
      });
      if (currentRevision) await removeRevision(id, currentRevision.descriptor);
    } catch (recoveryError) {
      const failure = new ContractError("DISTRIBUTION_RECOVERY_FAILED", "The current Plugin could not be restored safely");
      failure.cause = recoveryError;
      throw failure;
    }
    throw error;
  }
}

function distributionSourceFromBody(body = {}) {
  if (body.source !== undefined) return body.source;
  if (body.url !== undefined) return { kind: "url", url: body.url, expectedSha256: body.expectedSha256 ?? body.sha256 };
  return { kind: "local", path: body.archivePath ?? body.path, expectedSha256: body.expectedSha256 ?? body.sha256 };
}

function assertDistributionNotCancelled(operation) {
  if (operation.signal?.aborted) throw new ContractError("DISTRIBUTION_CANCELLED", "The distribution operation was cancelled before commit");
}

async function executeDistributionOperation(operation) {
  const operationRoot = distributionOperationPath(operation.operationId);
  operation.paths = { ...(operation.paths ?? {}), operationRoot };
  try {
    await mkdir(operationRoot, { recursive: true });
    if (operation.intent === "rollback") {
      if (!operation.pluginId) throw new ContractError("DISTRIBUTION_PLUGIN_ID_REQUIRED", "Rollback requires a Plugin ID");
      assertDistributionNotCancelled(operation);
      return await withDistributionLock(operation.pluginId, () => {
        assertDistributionNotCancelled(operation);
        return commitRollbackDistributionCandidate(operation, operation.pluginId);
      });
    }
    const source = operation.source;
    if (source.kind === "local" && pathIsWithin(pluginsRoot, source.path)) {
      throw new ContractError("DISTRIBUTION_SOURCE_MANAGED", "Distribution archives must remain outside the managed Plugin Directory");
    }
    const sourceDestination = path.join(operationRoot, "source.zip");
    await updateDistributionOperation(operation, "preflight", "source-transfer", { progress: { received: 0 } });
    const sourceInfo = source.kind === "url"
      ? await downloadDistributionSource(source, sourceDestination, {
        signal: operation.signal,
        onProgress: (progress) => { operation.progress = progress; void persistDistributionStatus(operation).catch(() => {}); },
      })
      : await stageLocalDistributionSource(source, sourceDestination, {
        signal: operation.signal,
        onProgress: undefined,
      });
    operation.observedSha256 = sourceInfo.sha256;
    await updateDistributionOperation(operation, "preflight", "digest-verified", { progress: { received: sourceInfo.bytes, total: sourceInfo.bytes } });
    if (operation.signal.aborted) throw new ContractError("DISTRIBUTION_CANCELLED", "The distribution operation was cancelled before commit");
    const stageRoot = path.join(operationRoot, "candidate");
    await updateDistributionOperation(operation, "preflight", "archive-inspection");
    await extractZip(sourceInfo.path, stageRoot);
    await updateDistributionOperation(operation, "preflight", "package-validation");
    const validated = await preflightDistributionCandidate(stageRoot);
    const id = validated.manifest.id;
    operation.pluginId = operation.pluginId ?? id;
    assertDistributionNotCancelled(operation);
    assertDistributionCandidate(id, { intent: operation.intent, pluginId: operation.pluginId, version: validated.manifest.version, observedSha256: sourceInfo.sha256 });
    return await withDistributionLock(id, () => {
      assertDistributionNotCancelled(operation);
      return operation.intent === "install"
        ? commitInitialDistributionCandidate(operation, stageRoot, validated, sourceInfo)
        : commitReplacementDistributionCandidate(operation, stageRoot, validated, sourceInfo);
    });
  } finally {
    await rm(operationRoot, { recursive: true, force: true });
  }
}

async function startDistributionOperation({ operationId = randomUUID(), intent = "install", pluginId, source, signature, previousOperationId } = {}) {
  if (!["install", "replace", "rollback"].includes(intent)) throw new ContractError("DISTRIBUTION_INTENT_INVALID", "Unsupported Plugin Distribution intent");
  if (pluginId !== undefined && !isManagedPluginId(pluginId)) throw new ContractError("DISTRIBUTION_PLUGIN_ID_INVALID", "Plugin ID is invalid");
  if (intent === "replace" && !pluginId) throw new ContractError("DISTRIBUTION_PLUGIN_ID_REQUIRED", "Replacement requires a Plugin ID");
  return distributionModule.submit({ operationId, intent, pluginId, source, signature, previousOperationId });
}

async function waitForDistributionOperation(operationId) {
  const operation = distributionOperations.get(operationId);
  if (!operation) throw new ContractError("DISTRIBUTION_OPERATION_NOT_FOUND", "Distribution operation was not found");
  if (operation.promise) await operation.promise.catch(() => {});
  return publicDistributionOperation(operation);
}

function cancelDistributionOperation(operationId) {
  const operation = distributionOperations.get(operationId);
  if (!operation || ["completed", "failed", "cancelled"].includes(operation.state)) return false;
  if (["deactivating", "snapshotting", "switching", "package-switched", "activation", "completed"].includes(operation.phase)) return false;
  distributionControllers.get(operationId)?.abort();
  return true;
}

async function retryDistributionOperation(operationId) {
  const previous = distributionOperations.get(operationId);
  if (!previous) throw new ContractError("DISTRIBUTION_OPERATION_NOT_FOUND", "Distribution operation was not found");
  if (!["failed", "cancelled"].includes(previous.state)) throw new ContractError("DISTRIBUTION_RETRY_INVALID", "Only failed or cancelled distribution operations can be retried");
  if (!previous.source) throw new ContractError("DISTRIBUTION_RETRY_SOURCE_UNAVAILABLE", "The retry source is no longer available");
  return startDistributionOperation({
    intent: previous.intent,
    pluginId: previous.pluginId,
    source: previous.source,
    previousOperationId: operationId,
  });
}

async function recoverDistributionJournals() {
  let entries;
  try { entries = await readdir(distributionJournalRoot, { withFileTypes: true }); }
  catch (error) { if (error?.code === "ENOENT") return; throw error; }
  for (const entry of entries.filter((candidate) => candidate.isFile() && candidate.name.endsWith(".json"))) {
    let journal;
    try { journal = JSON.parse(await readFile(path.join(distributionJournalRoot, entry.name), "utf8")); }
    catch { continue; }
    if (typeof journal?.operationId !== "string" || !journal.operationId.trim()) continue;
    if (["completed", "committed"].includes(journal.phase) || journal.state === "completed") {
      const switchBackup = maybeManagedChildPath(distributionOperationRoot, journal.paths?.switchBackupPath, "Distribution switch backup");
      const operationRoot = journalOperationRoot(journal);
      if (switchBackup) await rm(switchBackup, { recursive: true, force: true }).catch(() => {});
      if (operationRoot) await rm(operationRoot, { recursive: true, force: true }).catch(() => {});
      await removeDistributionJournal(journal.operationId).catch(() => {});
      continue;
    }
    const operation = distributionOperations.get(journal.operationId) ?? {
      operationId: journal.operationId,
      intent: journal.intent,
      pluginId: journal.pluginId,
      source: journal.source,
      state: journal.state,
      phase: journal.phase,
      createdAt: journal.createdAt,
      updatedAt: journal.updatedAt,
    };
    try {
      const operationRoot = journalOperationRoot(journal);
      const snapshotRoot = journal.paths?.snapshotRoot ? managedChildPath(distributionRevisionRoot, journal.paths.snapshotRoot, "Distribution revision snapshot") : undefined;
      if (journal.intent === "install") {
        if (journal.paths?.destinationPath) await rm(managedChildPath(pluginsRoot, journal.paths.destinationPath, "Distribution destination"), { recursive: true, force: true });
        await restoreJournalHostState(journal);
      } else {
        const destination = managedChildPath(pluginsRoot, journal.paths?.destinationPath, "Distribution destination");
        const backup = maybeManagedChildPath(distributionOperationRoot, journal.paths?.switchBackupPath, "Distribution switch backup");
        const backupExists = backup
          ? await stat(backup).then((details) => details.isDirectory()).catch((error) => { if (error?.code === "ENOENT") return false; throw error; })
          : false;
        const destinationDetails = await stat(destination).catch(() => undefined);
        const preSwitchCrash = !journal.paths?.packageCommitted
          && !backupExists
          && ["deactivating", "snapshotting", "switching"].includes(journal.phase)
          && destinationDetails?.isDirectory();
        let completeSnapshot;
        if (snapshotRoot && !preSwitchCrash) {
          if (!isManagedPluginId(journal.pluginId)) throw new Error("replacement journal Plugin ID is invalid");
          completeSnapshot = await readCompleteRevision(journal.pluginId, path.basename(snapshotRoot));
          if (completeSnapshot.root !== snapshotRoot) throw new Error("replacement journal snapshot identity is invalid");
        }
        if (preSwitchCrash) {
          await restoreJournalHostState(journal);
        } else if (backupExists) {
          await rm(destination, { recursive: true, force: true });
          await rename(backup, destination);
        } else if (completeSnapshot) {
          await rm(destination, { recursive: true, force: true });
          if (!await copyPathIfPresent(path.join(completeSnapshot.root, "package"), destination)) throw new Error("snapshot package is missing");
        } else {
          throw new Error("replacement journal has no safe restore point");
        }
        if (!preSwitchCrash && completeSnapshot) await restoreStateSnapshot(journal.pluginId, completeSnapshot.root);
        if (!preSwitchCrash) await restoreJournalHostState(journal);
      }
      operation.state = "failed";
      operation.phase = "recovered";
      operation.error = { code: "DISTRIBUTION_RECOVERED_AFTER_CRASH", message: "An incomplete distribution operation was rolled back during Runtime startup" };
      await persistDistributionStatus(operation);
      if (operationRoot) await rm(operationRoot, { recursive: true, force: true }).catch(() => {});
      await removeDistributionJournal(journal.operationId);
    } catch (error) {
      const id = journal.pluginId;
      await hostState.update((state) => ({
        ...state,
        pluginInstallations: {
          ...(state.pluginInstallations ?? {}),
          ...(id ? { [id]: { ...(state.pluginInstallations?.[id] ?? { origin: "local" }), recoveryState: "unavailable" } } : {}),
        },
        statusSnapshots: id ? { ...state.statusSnapshots, [id]: { ...(state.statusSnapshots[id] ?? {}), state: "unavailable", failure: { code: "DISTRIBUTION_RECOVERY_AMBIGUOUS", message: "Distribution recovery requires explicit repair" }, updatedAt: new Date().toISOString() } } : state.statusSnapshots,
      }));
      operation.state = "failed";
      operation.phase = "recovery";
      operation.error = { code: "DISTRIBUTION_RECOVERY_AMBIGUOUS", message: "Distribution recovery requires explicit repair" };
      await persistDistributionStatus(operation).catch(() => {});
      await runtimeLogger.error("distribution-recovery-failed", { operationId: journal.operationId, pluginId: journal.pluginId, code: operation.error.code }).catch(() => {});
    }
  }
}

async function removeDistributionJournalsForPlugin(id) {
  let entries;
  try { entries = await readdir(distributionJournalRoot, { withFileTypes: true }); }
  catch (error) { if (error?.code === "ENOENT") return; throw error; }
  for (const entry of entries.filter((candidate) => candidate.isFile() && candidate.name.endsWith(".json"))) {
    const filename = path.join(distributionJournalRoot, entry.name);
    try {
      const journal = JSON.parse(await readFile(filename, "utf8"));
      if (journal.pluginId === id) await rm(filename, { force: true });
    } catch (error) {
      if (error?.code !== "ENOENT") continue;
    }
  }
}

async function removePluginUnsafe(identifier) {
  const descriptor = findCompatible(identifier);
  const rejection = rejectedPlugins.find((plugin) => plugin.id === identifier || plugin.package === identifier);
  if (!descriptor && !rejection) throw new ContractError("PLUGIN_NOT_FOUND", `plugin '${identifier}' is not installed`);
  const id = descriptor?.validated.manifest.id ?? rejection.id ?? rejection.package;
  const packageRoot = descriptor?.packageRoot ?? rejection.packagePath;
  scheduler.store.markSchedulesOrphaned(id);
  const relativePackage = path.relative(pluginsRoot, packageRoot);
  if (relativePackage.startsWith("..") || path.isAbsolute(relativePackage)) throw new Error("Refusing to remove a package outside the managed plugin directory");
  const active = findPlugin(id);
  if (active) {
    const graceMs = Number(process.env.INFOLENS_DEACTIVATION_GRACE_MS) || 2_500;
    let timedOut = false;
    let timer;
    const settled = await Promise.race([
      deactivatePlugin(active, { deferRouteCleanup: true, deactivationGuard: () => !timedOut }).then((cleanup) => cleanup?.ok !== false),
      new Promise((resolve) => { timer = setTimeout(() => { timedOut = true; resolve(false); }, graceMs); }),
    ]);
    if (timer) clearTimeout(timer);
    if (!settled) throw new ContractError("RUNTIME_RESTART_REQUIRED", `plugin '${id}' did not deactivate within ${graceMs}ms; restart Runtime before deletion`);
  }
  await rm(packageRoot, { recursive: true, force: true });
  await rm(path.join(dataRoot, id), { recursive: true, force: true });
  await removePluginAdapterScope(adapterRegistryRoot, id);
  await rm(path.join(distributionRevisionRoot, id), { recursive: true, force: true });
  await removeDistributionJournalsForPlugin(id);
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
  await runtimeLogger.info("distribution-revisions-removed", { pluginId: id }).catch(() => {});
  emitStatus("removed", id);
}

async function removePlugin(identifier) {
  const descriptor = findCompatible(identifier);
  const rejection = rejectedPlugins.find((plugin) => plugin.id === identifier || plugin.package === identifier);
  if (!descriptor && !rejection) throw new ContractError("PLUGIN_NOT_FOUND", `plugin '${identifier}' is not installed`);
  const id = descriptor?.validated.manifest.id ?? rejection.id ?? rejection.package;
  return withDistributionLock(id, () => removePluginUnsafe(identifier));
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
    ["/schedules", "/runtime/schedules"],
    ["/mail-settings", "/runtime/mail-settings"],
    ["/mail-test", "/runtime/mail-test"],
    ["/host/state", "/runtime/host-state"],
    ["/browser-status", "/runtime/browser-status"],
    ["/browser-status/check", "/runtime/browser-status/check"],
    ["/browser-status/reconnect", "/runtime/browser-status/reconnect"],
    ["/batches", "/runtime/batches"],
    ["/batches/active", "/runtime/batches/active"],
    ["/batches/targets", "/runtime/batches/targets"],
    ["/batch-refresh", "/runtime/batch-refresh"],
    ["/batch-refresh/targets", "/runtime/batch-refresh/targets"],
    ["/plugins/install-archive", "/runtime/plugins/install-archive"],
    ["/plugins/distribution", "/runtime/plugins/distribution"],
    ["/plugins/distribution/upload", "/runtime/plugins/distribution/upload"],
  ]);
  if (simple.has(suffix)) return simple.get(suffix);
  if (suffix.startsWith("/schedules/")) return "/runtime" + suffix;
  const distributionOperation = suffix.match(/^\/plugins\/distribution\/operations\/([^/]+)(?:\/(cancel|retry))?$/);
  if (distributionOperation) return `/runtime/plugins/distribution/operations/${distributionOperation[1]}${distributionOperation[2] ? `/${distributionOperation[2]}` : ""}`;
  const pluginDistribution = suffix.match(/^\/plugins\/([^/]+)\/(replace|rollback|revisions)$/);
  if (pluginDistribution) return `/runtime/plugins/${pluginDistribution[1]}/${pluginDistribution[2]}`;
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

await loadDistributionStatuses();
await recoverDistributionJournals();
await batchManager.load();
scheduler = createScheduler();
await scheduler.load();
await discoverPlugins();
reconcileSchedulerPlugins();
scheduler.start();

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
      await scheduler.stop({ waitForRuns: false, close: false });
      restoreQuiesced = true;
      for (const plugin of [...activePlugins]) await deactivatePlugin(plugin, { preserveInterrupted: daemonMode });
      await scheduler.stop({ waitForRuns: true, close: true });
      const result = await restoreBackup({ paths: configuredDaemonPaths, sourcePath: source });
      scheduler.reopen();
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
      reconcileSchedulerPlugins();
      scheduler.start();
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
          scheduler.reopen();
          reconcileSchedulerPlugins();
          scheduler.start();
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
  if (url.pathname === "/runtime/schedules" && request.method === "GET") {
    json(response, 200, {
      schedules: scheduler.list(),
      defaultTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone ?? null,
      mail: publicMailSettings(scheduler.getMailSettings(), await mailSecretStore.hasSecret()),
    });
    return;
  }
  if (url.pathname === "/runtime/schedules" && request.method === "POST") {
    const operationId = requestOperationId(request) || randomUUID();
    try {
      const body = await readJsonBody(request);
      const signature = "POST " + url.pathname + ":" + JSON.stringify(body);
      const result = await runIdempotentOperation(operationId, signature, async () => {
        try {
          return { status: 201, body: { schedule: scheduler.create(body), operationId } };
        } catch (error) {
          const failure = errorDetails(error);
          return { status: ["SCHEDULE_VERSION_CONFLICT", "REFRESH_SCHEDULE_EXISTS"].includes(failure.code) ? 409 : 400, body: { ...failure, ...(error.current ? { current: error.current } : {}), operationId } };
        }
      });
      json(response, result.status, result.body);
    } catch (error) {
      const failure = errorDetails(error);
      json(response, failure.code === "OPERATION_ID_REUSED" ? 409 : 400, { ...failure, operationId });
    }
    return;
  }
  const scheduleRunsMatch = url.pathname.match(/^\/runtime\/schedules\/([^/]+)\/runs$/u);
  if (scheduleRunsMatch && request.method === "GET") {
    try {
      json(response, 200, { runs: scheduler.listRuns(decodeURIComponent(scheduleRunsMatch[1]), url.searchParams.get("limit") ?? undefined) });
    } catch (error) {
      const failure = errorDetails(error);
      json(response, failure.code === "SCHEDULE_NOT_FOUND" ? 404 : 400, failure);
    }
    return;
  }
  const scheduleResendMatch = url.pathname.match(/^\/runtime\/schedules\/([^/]+)\/runs\/([^/]+)\/resend$/u);
  if (scheduleResendMatch && request.method === "POST") {
    const operationId = requestOperationId(request) || randomUUID();
    try {
      const result = await runIdempotentOperation(operationId, "POST " + url.pathname, async () => {
        try {
          const run = await scheduler.resend(decodeURIComponent(scheduleResendMatch[1]), decodeURIComponent(scheduleResendMatch[2]));
          return { status: 202, body: { run, operationId } };
        } catch (error) {
          const failure = errorDetails(error);
          return { status: ["SCHEDULE_NOT_FOUND", "RUN_NOT_FOUND"].includes(failure.code) ? 404 : 400, body: { ...failure, operationId } };
        }
      });
      json(response, result.status, result.body);
    } catch (error) {
      const failure = errorDetails(error);
      json(response, failure.code === "OPERATION_ID_REUSED" ? 409 : 400, { ...failure, operationId });
    }
    return;
  }
  const scheduleRunMatch = url.pathname.match(/^\/runtime\/schedules\/([^/]+)\/run$/u);
  if (scheduleRunMatch && request.method === "POST") {
    const operationId = requestOperationId(request) || randomUUID();
    try {
      const result = await runIdempotentOperation(operationId, "POST " + url.pathname, async () => {
        try {
          const run = await scheduler.runNow(decodeURIComponent(scheduleRunMatch[1]));
          return { status: 202, body: { run, operationId } };
        } catch (error) {
          const failure = errorDetails(error);
          return { status: failure.code === "SCHEDULE_NOT_FOUND" ? 404 : 400, body: { ...failure, operationId } };
        }
      });
      json(response, result.status, result.body);
    } catch (error) {
      const failure = errorDetails(error);
      json(response, failure.code === "OPERATION_ID_REUSED" ? 409 : 400, { ...failure, operationId });
    }
    return;
  }
  const scheduleMatch = url.pathname.match(/^\/runtime\/schedules\/([^/]+)$/u);
  if (scheduleMatch && request.method === "GET") {
    const schedule = scheduler.get(decodeURIComponent(scheduleMatch[1]));
    if (!schedule) json(response, 404, { error: "Schedule was not found", code: "SCHEDULE_NOT_FOUND" });
    else json(response, 200, { schedule });
    return;
  }
  if (scheduleMatch && request.method === "PATCH") {
    const operationId = requestOperationId(request) || randomUUID();
    try {
      const body = await readJsonBody(request);
      const expectedVersion = Number(body.version ?? body.expectedVersion);
      const signature = "PATCH " + url.pathname + ":" + JSON.stringify({ ...body, version: expectedVersion });
      const result = await runIdempotentOperation(operationId, signature, async () => {
        try {
          const schedule = scheduler.update(decodeURIComponent(scheduleMatch[1]), body, { expectedVersion });
          return { status: 200, body: { schedule, operationId } };
        } catch (error) {
          const failure = errorDetails(error);
          return { status: ["SCHEDULE_NOT_FOUND"].includes(failure.code) ? 404 : ["SCHEDULE_VERSION_CONFLICT", "REFRESH_SCHEDULE_EXISTS"].includes(failure.code) ? 409 : 400, body: { ...failure, ...(error.current ? { current: error.current } : {}), operationId } };
        }
      });
      json(response, result.status, result.body);
    } catch (error) {
      const failure = errorDetails(error);
      json(response, failure.code === "OPERATION_ID_REUSED" ? 409 : 400, { ...failure, operationId });
    }
    return;
  }
  if (scheduleMatch && request.method === "DELETE") {
    const operationId = requestOperationId(request) || randomUUID();
    try {
      const result = await runIdempotentOperation(operationId, "DELETE " + url.pathname, async () => {
        try {
          scheduler.delete(decodeURIComponent(scheduleMatch[1]));
          return { status: 200, body: { ok: true, operationId } };
        } catch (error) {
          const failure = errorDetails(error);
          return { status: failure.code === "SCHEDULE_NOT_FOUND" ? 404 : 400, body: { ...failure, operationId } };
        }
      });
      json(response, result.status, result.body);
    } catch (error) {
      const failure = errorDetails(error);
      json(response, failure.code === "OPERATION_ID_REUSED" ? 409 : 400, { ...failure, operationId });
    }
    return;
  }
  if (url.pathname === "/runtime/mail-settings" && request.method === "GET") {
    json(response, 200, { mail: publicMailSettings(scheduler.getMailSettings(), await mailSecretStore.hasSecret()) });
    return;
  }
  if (url.pathname === "/runtime/mail-settings" && ["POST", "PUT"].includes(request.method ?? "")) {
    const operationId = requestOperationId(request) || randomUUID();
    try {
      const body = await readJsonBody(request);
      const passwordFingerprint = body.password ? createHash("sha256").update(String(body.password)).digest("hex") : "";
      const signature = request.method + " " + url.pathname + ":" + JSON.stringify({ ...body, password: passwordFingerprint });
      const result = await runIdempotentOperation(operationId, signature, async () => {
        try {
          const config = normalizeMailSettings(body);
          const settings = scheduler.saveMailSettings(config, { expectedVersion: body.version === undefined ? undefined : Number(body.version) });
          if (body.password) await mailSecretStore.save(String(body.password));
          if (body.clearPassword === true) await mailSecretStore.clear();
          return { status: 200, body: { mail: publicMailSettings(settings, await mailSecretStore.hasSecret()), operationId } };
        } catch (error) {
          const failure = errorDetails(error);
          return { status: failure.code === "MAIL_SETTINGS_VERSION_CONFLICT" ? 409 : 400, body: { ...failure, ...(error.current ? { current: publicMailSettings(error.current, false) } : {}), operationId } };
        }
      });
      json(response, result.status, result.body);
    } catch (error) {
      const failure = errorDetails(error);
      json(response, failure.code === "OPERATION_ID_REUSED" ? 409 : 400, { ...failure, operationId });
    }
    return;
  }
  if (url.pathname === "/runtime/mail-test" && request.method === "POST") {
    const operationId = requestOperationId(request) || randomUUID();
    try {
      const body = await readJsonBody(request);
      const recipients = normalizeMailRecipients(body.recipients ?? body.to);
      const signature = "POST " + url.pathname + ":" + JSON.stringify({ recipients, version: scheduler.getMailSettings().version });
      const result = await runIdempotentOperation(operationId, signature, async () => {
        try {
          return { status: 200, body: { mailTest: await executeMailTest({ ...body, recipients }), operationId } };
        } catch (error) {
          const failure = errorDetails(error);
          return { status: 400, body: { ...failure, operationId } };
        }
      });
      json(response, result.status, result.body);
    } catch (error) {
      const failure = errorDetails(error);
      json(response, failure.code === "OPERATION_ID_REUSED" ? 409 : 400, { ...failure, operationId });
    }
    return;
  }
  if (url.pathname === "/runtime/daily-summary" && request.method === "GET") {
    const requestContext = requestAbortContext(request, response);
    try {
      const requestedPluginIds = url.searchParams.getAll("pluginId").filter(Boolean);
      const aggregate = await dailySummaryAggregate(requestContext.signal, {
        localDate: url.searchParams.get("localDate") || undefined,
        timeZone: url.searchParams.get("timeZone") || undefined,
        windowStart: url.searchParams.get("windowStart") || undefined,
        windowEnd: url.searchParams.get("windowEnd") || undefined,
        pluginIds: requestedPluginIds.length ? requestedPluginIds : undefined,
      });
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
  const distributionOperationMatch = url.pathname.match(/^\/runtime\/plugins\/distribution\/operations\/([^/]+)(?:\/(cancel|retry))?$/);
  if (distributionOperationMatch && request.method === "GET" && !distributionOperationMatch[2]) {
    const operation = distributionOperations.get(decodeURIComponent(distributionOperationMatch[1]));
    if (!operation) {
      json(response, 404, { error: "Distribution operation was not found", code: "DISTRIBUTION_OPERATION_NOT_FOUND" });
    } else {
      json(response, 200, publicDistributionOperation(operation));
    }
    return;
  }
  if (distributionOperationMatch && distributionOperationMatch[2] === "cancel" && request.method === "POST") {
    const operationId = decodeURIComponent(distributionOperationMatch[1]);
    const canceled = cancelDistributionOperation(operationId);
    json(response, canceled ? 202 : 409, { ok: canceled, operationId, ...(distributionOperations.get(operationId) ? { operation: publicDistributionOperation(distributionOperations.get(operationId)) } : {}) });
    return;
  }
  if (distributionOperationMatch && distributionOperationMatch[2] === "retry" && request.method === "POST") {
    try {
      const operation = await retryDistributionOperation(decodeURIComponent(distributionOperationMatch[1]));
      json(response, 202, operation);
    } catch (error) {
      const failure = errorDetails(error);
      json(response, 400, { error: failure.message, code: failure.code });
    }
    return;
  }
  const revisionsMatch = url.pathname.match(/^\/runtime\/plugins\/([^/]+)\/revisions$/);
  if (revisionsMatch && request.method === "GET") {
    const pluginId = decodeURIComponent(revisionsMatch[1]);
    const installation = installationRecord(pluginId);
    let rollbackAvailable = false;
    if (installation?.previousRevision) {
      try { await readCompleteRevision(pluginId, installation.previousRevision); rollbackAvailable = true; } catch {}
    }
    json(response, 200, {
      pluginId,
      current: installation ? structuredClone(installation) : null,
      previous: installation?.previousRevision ?? null,
      rollbackAvailable,
    });
    return;
  }
  const pluginReplaceMatch = url.pathname.match(/^\/runtime\/plugins\/([^/]+)\/(replace|rollback)$/);
  if (pluginReplaceMatch && request.method === "POST") {
    const pluginId = decodeURIComponent(pluginReplaceMatch[1]);
    const intent = pluginReplaceMatch[2];
    try {
      const body = await readJsonBody(request);
      const operationId = requestOperationId(request) || body.operationId || randomUUID();
      const source = intent === "rollback" ? undefined : distributionSourceFromBody(body);
      const signature = "POST " + url.pathname + ":" + JSON.stringify({ intent, pluginId, source });
      const operation = await startDistributionOperation({ operationId, intent, pluginId, source, signature });
      json(response, 202, operation);
    } catch (error) {
      const failure = errorDetails(error);
      json(response, failure.code === "OPERATION_ID_REUSED" ? 409 : 400, { error: failure.message, code: failure.code });
    }
    return;
  }
  if (url.pathname === "/runtime/plugins/distribution/upload" && request.method === "POST") {
    let operationRoot;
    let retained = false;
    try {
      const intent = requestHeader(request, "x-infolens-distribution-intent") ?? "install";
      const pluginId = requestHeader(request, "x-infolens-plugin-id")?.trim() || undefined;
      const operationId = requestOperationId(request) || randomUUID();
      const fileName = uploadedDistributionFileName(request);
      const expectedSha256 = requestHeader(request, "x-infolens-expected-sha256") || undefined;
      const signature = "POST " + url.pathname + ":" + JSON.stringify({ intent, pluginId, fileName, expectedSha256 });
      const existing = distributionOperations.get(operationId);
      if (existing) {
        request.resume();
        if (existing.signature && existing.signature !== signature) throw new ContractError("OPERATION_ID_REUSED", "Operation ID was already used for a different command");
        json(response, 202, publicDistributionOperation(existing));
        return;
      }
      operationRoot = distributionOperationPath(operationId);
      const uploadedPath = path.join(operationRoot, "uploaded.zip");
      await receiveDistributionUpload(request, uploadedPath);
      const source = {
        kind: "local",
        path: uploadedPath,
        fileName,
        ...(expectedSha256 ? { expectedSha256 } : {}),
      };
      const operation = await startDistributionOperation({ operationId, intent, pluginId, source, signature });
      retained = true;
      json(response, 202, operation);
    } catch (error) {
      const failure = errorDetails(error);
      json(response, failure.code === "OPERATION_ID_REUSED" ? 409 : 400, { error: failure.message, code: failure.code });
    } finally {
      if (operationRoot && !retained) await rm(operationRoot, { recursive: true, force: true }).catch(() => {});
    }
    return;
  }
  if (url.pathname === "/runtime/plugins/distribution" && request.method === "POST") {
    try {
      const body = await readJsonBody(request);
      const intent = body.intent ?? "install";
      const pluginId = typeof body.pluginId === "string" && body.pluginId.trim() ? body.pluginId.trim() : undefined;
      const operationId = requestOperationId(request) || body.operationId || randomUUID();
      const source = intent === "rollback" ? undefined : distributionSourceFromBody(body);
      const signature = "POST " + url.pathname + ":" + JSON.stringify({ intent, pluginId, source });
      const operation = await startDistributionOperation({ operationId, intent, pluginId, source, signature });
      json(response, 202, operation);
    } catch (error) {
      const failure = errorDetails(error);
      json(response, failure.code === "OPERATION_ID_REUSED" ? 409 : 400, { error: failure.message, code: failure.code });
    }
    return;
  }
  if (url.pathname === "/runtime/plugins/install-archive" && request.method === "POST") {
    try {
      const body = await readJsonBody(request);
      const operationId = requestOperationId(request) || body.operationId || randomUUID();
      const source = { kind: "local", path: body.archivePath ?? body.path, expectedSha256: body.expectedSha256 ?? body.sha256 };
      const signature = "POST " + url.pathname + ":" + JSON.stringify({ source });
      const operation = await startDistributionOperation({ operationId, intent: "install", source, signature });
      json(response, 202, operation);
    } catch (error) {
      const failure = errorDetails(error);
      json(response, failure.code === "OPERATION_ID_REUSED" ? 409 : 400, { error: failure.message, code: failure.code });
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
  await scheduler.stop({ waitForRuns: false, close: false });
  await batchManager.interruptActive(reason);
  browserBridge.stop();
  for (const plugin of [...activePlugins]) await plugin.taskManager.stop({ preserveInterrupted: daemonMode });
  await scheduler.stop({ waitForRuns: true, close: true });
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
