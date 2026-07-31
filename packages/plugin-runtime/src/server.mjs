import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, readdir, rename, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { HOST_VERSION, ContractError, validatePluginPackage } from "./contract.mjs";
import { createPluginLogger } from "./logger.mjs";
import { createOpenCliAdapter, loadBundledOpenCli } from "./opencli-adapter.mjs";
import { PluginTaskManager, SharedTaskQueue } from "./task-manager.mjs";
import { redactSensitiveText, redactSensitiveValue } from "./redaction.mjs";
import { HostStateStore } from "./host-state.mjs";
import { garbageCollectAdapterStore, preparePluginAdapterScope, removePluginAdapterScope } from "./adapter-scope.mjs";

const projectRoot = process.env.INFOLENS_PROJECT_ROOT
  ? path.resolve(process.env.INFOLENS_PROJECT_ROOT)
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const pluginsRoot = path.resolve(process.env.INFOLENS_PLUGINS_ROOT ?? path.join(projectRoot, "plugins"));
const dataRoot = path.resolve(process.env.INFOLENS_PLUGIN_DATA_ROOT ?? path.join(projectRoot, ".infolens-data", "plugins"));
const openCliRoot = path.resolve(process.env.INFOLENS_BUNDLED_OPENCLI_ROOT ?? path.join(projectRoot, "resources", "opencli"));
const pluginSdkBrowserEntry = path.join(projectRoot, "packages", "plugin-sdk", "src", "index.js");
const pluginSdkTokenEntry = path.join(projectRoot, "packages", "plugin-sdk", "src", "workspace-tokens.css");
const pluginSdkWorkspaceStyles = path.join(projectRoot, "packages", "plugin-sdk", "src", "workspace.css");
const hostStatePath = path.resolve(process.env.INFOLENS_HOST_STATE_PATH ?? path.join(path.dirname(dataRoot), "host-state.json"));
const adapterRegistryRoot = path.resolve(process.env.INFOLENS_ADAPTER_REGISTRY_ROOT ?? path.join(path.dirname(dataRoot), "opencli-adapters"));
const openCliRuntime = await loadBundledOpenCli(openCliRoot);
const openCliAdapter = createOpenCliAdapter(openCliRuntime);
const validationRuntime = {
  hostVersion: HOST_VERSION,
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
const taskQueue = new SharedTaskQueue();
let eventSequence = 0;
const hostState = new HostStateStore(hostStatePath);
await hostState.load();

function errorDetails(error) {
  return {
    code: typeof error?.code === "string" ? error.code : error instanceof ContractError ? error.code : "PLUGIN_ERROR",
    message: redactSensitiveText(error instanceof Error ? error.message : String(error)),
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
  return event;
}

function json(response, status, body) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
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
  return "application/octet-stream";
}

function setPluginStatus(plugin, state, details = {}) {
  plugin.status = { ...plugin.status, state, ...details, updatedAt: new Date().toISOString() };
  const snapshot = {
    state,
    updatedAt: plugin.status.updatedAt,
    ...(plugin.status.lastSuccessfulRefresh ? { lastSuccessfulRefreshAt: plugin.status.lastSuccessfulRefresh } : {}),
    ...(plugin.status.failure ? { failure: plugin.status.failure } : {}),
  };
  void hostState.update((current) => ({
    ...current,
    statusSnapshots: { ...current.statusSnapshots, [plugin.manifest.id]: snapshot },
  })).catch((error) => process.stderr.write(`[host-state] ${error.message}\n`));
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

async function activatePlugin(validated, packageRoot) {
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
    lifecycle: undefined,
    logger,
    status: { state: "starting", updatedAt: new Date().toISOString() },
  };
  const taskManager = new PluginTaskManager(manifest.id, taskQueue, async (type, details) => {
    const safeDetails = details.error ? { ...details, ...errorDetails(details.error), error: undefined } : details;
    if (type === "task-queued") setPluginStatus(plugin, "queued");
    if (type === "task-started") setPluginStatus(plugin, "refreshing");
    if (type === "task-cancelled") setPluginStatus(plugin, "cancelled", { outcome: details.outcome });
    const entry = await logger[type === "task-failed" ? "error" : "info"](type, safeDetails);
    if (type === "task-completed" && plugin.status.state === "refreshing") setPluginStatus(plugin, "running");
    if (type === "task-failed") {
      const failure = { ...errorDetails(details.error), logId: entry.id, operationId: entry.operationId, timestamp: entry.timestamp };
      if (details.error && typeof details.error === "object") Object.assign(details.error, failure);
      setPluginStatus(plugin, "failed", { failure });
      emitStatus(type, manifest.id, { ...safeDetails, logId: entry.id });
      return;
    }
    emitStatus(type, manifest.id, { ...safeDetails, logId: entry.id });
  });
  plugin.taskManager = taskManager;
  activePlugins.push(plugin);
  await logger.info("plugin-activation-started", { operationId: activationOperationId });
  emitStatus("activating", manifest.id);

  const context = {
    pluginId: manifest.id,
    dataDir,
    resolveDataPath(relativePath) { return resolveDataPath(dataDir, relativePath); },
    route(method, route, handler) {
      if (typeof handler !== "function") throw new TypeError("Route handler must be a function");
      const key = normalizeRoute(method, route);
      if (plugin.routes.has(key)) throw new Error(`Route '${key}' is already registered`);
      plugin.routes.set(key, handler);
    },
    task(name, handler) { taskManager.register(name, handler); },
    enqueue(name, input, options) { return taskManager.enqueue(name, input, options); },
    schedule(name, options) { return taskManager.schedule(name, options); },
    setHealth(health) {
      if (!health || typeof health.state !== "string") throw new TypeError("Health must include a state");
      setPluginStatus(plugin, health.state, health);
      emitStatus("health-changed", manifest.id, { state: health.state });
    },
    logger,
    opencli: {
      async run(commandKey, args = [], signal) {
        const mapping = manifest.openCliCommands[commandKey];
        if (!mapping) throw new Error(`OpenCLI command '${commandKey}' is not declared by plugin '${manifest.id}'`);
        await logger.info("opencli-started", { commandKey, strategy: mapping.strategy });
        try {
          const resource = mapping.strategy === "PUBLIC" ? "PUBLIC" : "BROWSER";
          const result = await taskQueue.withPermit({ pluginId: manifest.id, resource, signal }, () => openCliAdapter.run(mapping, args, signal, validated.adapterScope.adapters.map((adapter) => adapter.path)));
          await logger.info("opencli-completed", { commandKey });
          return result;
        } catch (error) {
          await logger.error("opencli-failed", { commandKey, message: error instanceof Error ? error.message : String(error) });
          throw error;
        }
      },
    },
  };

  try {
    const module = await import(`${pathToFileURL(validated.backendPath).href}?runtime=${Date.now()}`);
    if (typeof module.activate !== "function") throw new Error("backend.entry must export activate(context)");
    plugin.lifecycle = await module.activate(context) ?? {};
    const initialHealth = plugin.lifecycle.health;
    if (initialHealth) setPluginStatus(plugin, initialHealth.state, initialHealth);
    else if (plugin.status.state === "starting") setPluginStatus(plugin, "running");
    await logger.info("plugin-activated", { operationId: activationOperationId, version: manifest.version });
    emitStatus("activated", manifest.id, { state: plugin.status.state });
  } catch (error) {
    await taskManager.stop();
    plugin.routes.clear();
    const failure = errorDetails(error);
    const entry = await logger.error("activation-failed", { ...failure, operationId: activationOperationId });
    const correlatedFailure = { ...failure, logId: entry.id, operationId: entry.operationId, timestamp: entry.timestamp };
    setPluginStatus(plugin, "failed", { failure: correlatedFailure });
    emitStatus("activation-failed", manifest.id, correlatedFailure);
  }
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
  return {
    id,
    name: plugin.manifest.name,
    version: plugin.manifest.version,
    icon: plugin.manifest.icon,
    badge: plugin.status.badge ?? plugin.lifecycle?.badge,
    state: plugin.status.state,
    failure: plugin.status.failure,
    workspaceUrl: `${origin}/plugins/${id}/workspace/`,
    apiBaseUrl: `${origin}/plugins/${id}/api/`,
    packagePath: plugin.packageRoot,
    enabled: true,
    browserDependent: Object.values(plugin.manifest.openCliCommands).some((mapping) => mapping.strategy !== "PUBLIC"),
    statusSnapshot: hostState.snapshot().statusSnapshots[id],
  };
}

function publicCompatiblePlugin(descriptor, origin) {
  const id = descriptor.validated.manifest.id;
  const active = findPlugin(id);
  if (active) return publicPlugin(active, origin);
  const manifest = descriptor.validated.manifest;
  return {
    id, name: manifest.name, version: manifest.version, icon: manifest.icon,
    state: "disabled", enabled: false, packagePath: descriptor.packageRoot,
    browserDependent: Object.values(manifest.openCliCommands).some((mapping) => mapping.strategy !== "PUBLIC"),
    workspaceUrl: `${origin}/plugins/${id}/workspace/`, apiBaseUrl: `${origin}/plugins/${id}/api/`,
    statusSnapshot: hostState.snapshot().statusSnapshots[id],
  };
}

function findPlugin(id) {
  return activePlugins.find((plugin) => plugin.manifest.id === id);
}

function findCompatible(id) {
  return compatiblePlugins.find((plugin) => plugin.validated.manifest.id === id);
}

async function deactivatePlugin(plugin) {
  await plugin.taskManager.stop();
  plugin.routes.clear();
  try {
    await plugin.lifecycle?.deactivate?.();
    await plugin.logger.info("plugin-deactivated");
    emitStatus("deactivated", plugin.manifest.id);
  } catch (error) {
    setPluginStatus(plugin, "failed", { failure: errorDetails(error) });
    await plugin.logger.error("cleanup-failed", errorDetails(error));
    emitStatus("cleanup-failed", plugin.manifest.id, errorDetails(error));
  }
  await plugin.logger.flush();
  const index = activePlugins.indexOf(plugin);
  if (index >= 0) activePlugins.splice(index, 1);
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
  descriptor.deactivated = false;
  if (enabled && !active) await activatePlugin(descriptor.validated, descriptor.packageRoot);
  if (!enabled && active) await deactivatePlugin(active);
  await hostState.update((state) => ({
    ...state,
    enabledPluginIds: enabled ? [...state.enabledPluginIds, id] : state.enabledPluginIds.filter((pluginId) => pluginId !== id),
    statusSnapshots: {
      ...state.statusSnapshots,
      [id]: enabled
        ? state.statusSnapshots[id] ?? { state: "starting", updatedAt: new Date().toISOString() }
        : { ...state.statusSnapshots[id], state: "disabled", updatedAt: new Date().toISOString() },
    },
  }));
}

async function installPlugin(sourcePath) {
  if (typeof sourcePath !== "string" || !path.isAbsolute(sourcePath)) {
    throw new ContractError("INVALID_INSTALL_PATH", "Select an absolute local plugin folder");
  }
  const sourceRoot = path.resolve(sourcePath);
  let candidateManifest;
  try { candidateManifest = JSON.parse(await readFile(path.join(sourceRoot, "manifest.json"), "utf8")); } catch {}
  const candidateId = candidateManifest?.id;
  if (typeof candidateId === "string" && (compatiblePlugins.some((plugin) => plugin.validated.manifest.id === candidateId) || rejectedPlugins.some((plugin) => plugin.id === candidateId))) {
    throw new ContractError("DUPLICATE_PLUGIN_ID", `plugin id '${candidateId}' is already installed; remove the installed plugin first`);
  }
  if (typeof candidateId === "string" && /^[a-z0-9][a-z0-9-]*$/.test(candidateId)) {
    try { await readFile(path.join(pluginsRoot, candidateId, "manifest.json")); throw new ContractError("DUPLICATE_PLUGIN_ID", `plugin id '${candidateId}' is already installed; remove the installed plugin first`); }
    catch (error) { if (error instanceof ContractError || error.code !== "ENOENT") throw error; }
  }
  const preflightRegistryRoot = await mkdtemp(path.join(os.tmpdir(), "infolens-adapter-preflight-"));
  let validated;
  try { validated = await validatePluginPackage(sourceRoot, validationRuntime, adapterScopeOptions(preflightRegistryRoot)); }
  finally { await rm(preflightRegistryRoot, { recursive: true, force: true }); }
  const id = validated.manifest.id;
  if (compatiblePlugins.some((plugin) => plugin.validated.manifest.id === id) || rejectedPlugins.some((plugin) => plugin.id === id) || installingPluginIds.has(id)) {
    throw new ContractError("DUPLICATE_PLUGIN_ID", `plugin id '${id}' is already installed; remove the installed plugin first`);
  }
  installingPluginIds.add(id);
  const destination = path.join(pluginsRoot, id);
  const temporary = path.join(pluginsRoot, `.install-${id}-${Date.now()}`);
  try {
    await cp(sourceRoot, temporary, { recursive: true, errorOnExist: true });
    const copied = await validatePluginPackage(temporary, validationRuntime, contractOptions);
    await rename(temporary, destination);
    const descriptor = { validated: { ...copied, backendPath: path.join(destination, path.relative(temporary, copied.backendPath)), workspaceEntry: path.join(destination, path.relative(temporary, copied.workspaceEntry)), workspaceRoot: path.join(destination, path.relative(temporary, copied.workspaceRoot)) }, packageRoot: destination };
    compatiblePlugins.push(descriptor);
    await hostState.update((state) => ({ ...state, enabledPluginIds: [...state.enabledPluginIds, id] }));
    await activatePlugin(descriptor.validated, destination);
    return id;
  } catch (error) {
    await rm(temporary, { recursive: true, force: true });
    await removePluginAdapterScope(adapterRegistryRoot, id);
    throw error;
  } finally {
    installingPluginIds.delete(id);
  }
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
    return {
      ...state,
      enabledPluginIds: state.enabledPluginIds.filter((pluginId) => pluginId !== id),
      lastSelection: state.lastSelection === id ? null : state.lastSelection,
      statusSnapshots,
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

await discoverPlugins();

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  response.setHeader("access-control-allow-origin", "*");
  response.setHeader("access-control-allow-headers", "content-type");
  response.setHeader("access-control-allow-methods", "GET,POST,PATCH,DELETE,OPTIONS");
  if (request.method === "OPTIONS") { response.writeHead(204); response.end(); return; }
  if (url.pathname === "/runtime/plugin-sdk.js" && request.method === "GET") {
    try {
      response.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store" });
      response.end(await readFile(pluginSdkBrowserEntry));
    } catch {
      json(response, 404, { error: "Plugin SDK browser entry not found" });
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
    json(response, 200, taskQueue.snapshot());
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
  if (url.pathname === "/runtime/browser-status") {
    const affected = compatiblePlugins
      .filter((plugin) => Object.values(plugin.validated.manifest.openCliCommands).some((mapping) => mapping.strategy !== "PUBLIC"))
      .map((plugin) => ({ id: plugin.validated.manifest.id, name: plugin.validated.manifest.name, state: findPlugin(plugin.validated.manifest.id)?.status.state ?? "disabled" }));
    json(response, 200, { connected: affected.every((plugin) => !["unavailable", "disconnected"].includes(plugin.state)), affected });
    return;
  }
  if (url.pathname === "/runtime/plugins/install" && request.method === "POST") {
    const operationId = request.headers["x-infolens-operation-id"] || randomUUID();
    await runtimeLogger.info("plugin-install-started", { operationId });
    try {
      const id = await installPlugin((await readJsonBody(request)).sourcePath);
      const entry = await runtimeLogger.info("plugin-install-completed", { operationId, pluginId: id });
      json(response, 201, { ok: true, pluginId: id, logId: entry.id, operationId });
    } catch (error) {
      const failure = errorDetails(error);
      const entry = await runtimeLogger.error("plugin-install-failed", { ...failure, operationId });
      json(response, failure.code === "DUPLICATE_PLUGIN_ID" ? 409 : 400, { error: failure.message, code: failure.code, logId: entry.id, operationId });
    }
    return;
  }
  const enabledMatch = url.pathname.match(/^\/runtime\/plugins\/([^/]+)\/enabled$/);
  if (enabledMatch && request.method === "POST") {
    try { await setPluginEnabled(decodeURIComponent(enabledMatch[1]), Boolean((await readJsonBody(request)).enabled)); json(response, 200, { ok: true }); }
    catch (error) { const failure = errorDetails(error); json(response, 400, { error: failure.message, code: failure.code }); }
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
    const operationId = request.headers["x-infolens-operation-id"] || randomUUID();
    await runtimeLogger.info("plugin-removal-started", { operationId, pluginId });
    try {
      await removePlugin(pluginId);
      const entry = await runtimeLogger.info("plugin-removal-completed", { operationId, pluginId });
      json(response, 200, { ok: true, pluginId, logId: entry.id, operationId });
    } catch (error) {
      const failure = errorDetails(error);
      const entry = await runtimeLogger.error("plugin-removal-failed", { ...failure, operationId, pluginId });
      json(response, failure.code === "RUNTIME_RESTART_REQUIRED" ? 503 : 404, { error: failure.message, code: failure.code, logId: entry.id, operationId });
    }
    return;
  }
  const deactivateMatch = url.pathname.match(/^\/runtime\/plugins\/([^/]+)$/);
  if (deactivateMatch && request.method === "DELETE") {
    const plugin = findPlugin(decodeURIComponent(deactivateMatch[1]));
    if (!plugin) { json(response, 404, { error: "Plugin not found" }); return; }
    await deactivatePlugin(plugin);
    const descriptor = findCompatible(decodeURIComponent(deactivateMatch[1]));
    if (descriptor) descriptor.deactivated = true;
    json(response, 200, { ok: true, pluginId: deactivateMatch[1] });
    return;
  }
  if (url.pathname === "/runtime/info") {
    const origin = `http://${request.headers.host}`;
    json(response, 200, {
      type: "runtime-ready",
      origin,
      plugins: compatiblePlugins.filter((plugin) => !plugin.deactivated).map((plugin) => publicCompatiblePlugin(plugin, origin)),
      rejectedPlugins,
      hostState: hostState.snapshot(),
    });
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
    json(response, plugin.status.state === "failed" ? 503 : 200, {
      pluginId,
      state: plugin.status.state,
      badge: plugin.status.badge ?? plugin.lifecycle?.badge,
      ...(plugin.status.failure ? { failure: plugin.status.failure } : {}),
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

  try {
    const body = await handler({ method: request.method, url, headers: request.headers });
    json(response, 200, body);
  } catch (error) {
    const failure = errorDetails(error);
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
  }
});

const port = Number(process.env.INFOLENS_RUNTIME_PORT ?? 0);
server.listen(port, "127.0.0.1", () => {
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Runtime did not bind a TCP port");
  const origin = `http://127.0.0.1:${address.port}`;
  runtimeLogger.info("runtime-started", { origin }).catch((error) => process.stderr.write(`[runtime-log] ${error.message}\n`));
  process.stdout.write(`${JSON.stringify({
    type: "runtime-ready",
    origin,
    plugins: compatiblePlugins.filter((plugin) => !plugin.deactivated).map((plugin) => publicCompatiblePlugin(plugin, origin)),
    rejectedPlugins,
    hostState: hostState.snapshot(),
  })}\n`);
});

let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  process.stdin.pause();
  taskQueue.stop();
  await new Promise((resolve) => server.close(resolve));
  for (const plugin of [...activePlugins]) await deactivatePlugin(plugin);
  await runtimeLogger.info("runtime-stopped");
  await runtimeLogger.flush();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  if (chunk.split(/\r?\n/).some((line) => line.trim() === "shutdown")) shutdown();
});
