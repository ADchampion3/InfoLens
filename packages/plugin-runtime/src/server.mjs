import { createServer } from "node:http";
import { mkdir, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { HOST_VERSION, ContractError, validatePluginPackage } from "./contract.mjs";
import { createPluginLogger } from "./logger.mjs";
import { createOpenCliAdapter, loadBundledOpenCli } from "./opencli-adapter.mjs";
import { PluginTaskManager } from "./task-manager.mjs";

const projectRoot = process.env.INFOLENS_PROJECT_ROOT
  ? path.resolve(process.env.INFOLENS_PROJECT_ROOT)
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const pluginsRoot = path.resolve(process.env.INFOLENS_PLUGINS_ROOT ?? path.join(projectRoot, "plugins"));
const dataRoot = path.resolve(process.env.INFOLENS_PLUGIN_DATA_ROOT ?? path.join(projectRoot, ".infolens-data", "plugins"));
const openCliRoot = path.resolve(process.env.INFOLENS_BUNDLED_OPENCLI_ROOT ?? path.join(projectRoot, "resources", "opencli"));
const openCliRuntime = await loadBundledOpenCli(openCliRoot);
const openCliAdapter = createOpenCliAdapter(openCliRuntime);
const validationRuntime = {
  hostVersion: HOST_VERSION,
  openCliVersion: openCliRuntime.version,
  availableCommands: openCliRuntime.availableCommands,
};

const activePlugins = [];
const rejectedPlugins = [];
const statusEvents = [];
let eventSequence = 0;

function errorDetails(error) {
  return {
    code: error instanceof ContractError ? error.code : "PLUGIN_ERROR",
    message: error instanceof Error ? error.message : String(error),
  };
}

function emitStatus(type, pluginId, details = {}) {
  const event = {
    type: "plugin-status",
    event: type,
    sequence: ++eventSequence,
    timestamp: new Date().toISOString(),
    pluginId,
    ...details,
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
  const dataDir = path.join(dataRoot, manifest.id);
  await mkdir(dataDir, { recursive: true });
  const logger = await createPluginLogger(dataDir, {
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
  const taskManager = new PluginTaskManager(manifest.id, (type, details) => {
    const safeDetails = details.error ? { ...details, ...errorDetails(details.error), error: undefined } : details;
    if (type === "task-started") setPluginStatus(plugin, "refreshing");
    if (type === "task-completed") setPluginStatus(plugin, "running");
    if (type === "task-failed") setPluginStatus(plugin, "failed", { failure: errorDetails(details.error) });
    emitStatus(type, manifest.id, safeDetails);
    logger[type === "task-failed" ? "error" : "info"](type, safeDetails);
  });
  plugin.taskManager = taskManager;
  activePlugins.push(plugin);
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
          const result = await openCliAdapter.run(mapping, args, signal);
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
    await logger.info("plugin-activated", { version: manifest.version });
    emitStatus("activated", manifest.id, { state: plugin.status.state });
  } catch (error) {
    await taskManager.stop();
    plugin.routes.clear();
    setPluginStatus(plugin, "failed", { failure: errorDetails(error) });
    await logger.error("activation-failed", errorDetails(error));
    emitStatus("activation-failed", manifest.id, errorDetails(error));
  }
}

async function discoverPlugins() {
  await mkdir(dataRoot, { recursive: true });
  let entries = [];
  try { entries = await readdir(pluginsRoot, { withFileTypes: true }); }
  catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const packageRoot = path.join(pluginsRoot, entry.name);
    try {
      const validated = await validatePluginPackage(packageRoot, validationRuntime);
      if (activePlugins.some((plugin) => plugin.manifest.id === validated.manifest.id)) {
        throw new ContractError("DUPLICATE_PLUGIN_ID", `plugin id '${validated.manifest.id}' is already discovered`);
      }
      await activatePlugin(validated, packageRoot);
    } catch (error) {
      const rejection = { package: entry.name, ...errorDetails(error) };
      rejectedPlugins.push(rejection);
      emitStatus("package-rejected", entry.name, rejection);
    }
  }
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
  };
}

function findPlugin(id) {
  return activePlugins.find((plugin) => plugin.manifest.id === id);
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
  if (url.pathname === "/runtime/health") {
    json(response, 200, { state: "running", pluginCount: activePlugins.length, rejectedCount: rejectedPlugins.length });
    return;
  }
  if (url.pathname === "/runtime/events") {
    json(response, 200, { events: statusEvents });
    return;
  }
  if (url.pathname === "/runtime/info") {
    const origin = `http://${request.headers.host}`;
    response.setHeader("access-control-allow-origin", "*");
    json(response, 200, {
      type: "runtime-ready",
      origin,
      plugins: activePlugins.map((plugin) => publicPlugin(plugin, origin)),
      rejectedPlugins,
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
    setPluginStatus(plugin, "failed", { failure });
    await plugin.logger.error("route-failed", { route: tail, ...failure });
    emitStatus("route-failed", pluginId, { route: tail, ...failure });
    json(response, 500, { error: failure.message, code: failure.code });
  }
});

const port = Number(process.env.INFOLENS_RUNTIME_PORT ?? 0);
server.listen(port, "127.0.0.1", () => {
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Runtime did not bind a TCP port");
  const origin = `http://127.0.0.1:${address.port}`;
  process.stdout.write(`${JSON.stringify({
    type: "runtime-ready",
    origin,
    plugins: activePlugins.map((plugin) => publicPlugin(plugin, origin)),
    rejectedPlugins,
  })}\n`);
});

let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  await new Promise((resolve) => server.close(resolve));
  for (const plugin of activePlugins) {
    await plugin.taskManager.stop();
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
  }
  process.exitCode = 0;
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  if (chunk.split(/\r?\n/).some((line) => line.trim() === "shutdown")) shutdown();
});
