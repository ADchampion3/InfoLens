import { createServer } from "node:http";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

const projectRoot = process.env.INFOLENS_PROJECT_ROOT
  ? path.resolve(process.env.INFOLENS_PROJECT_ROOT)
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const pluginsRoot = path.join(projectRoot, "plugins");
const routeTable = new Map();
const activePlugins = [];

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

async function discoverPlugins() {
  const entries = await readdir(pluginsRoot, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const packageRoot = path.join(pluginsRoot, entry.name);
    let manifest;
    try {
      manifest = JSON.parse(await readFile(path.join(packageRoot, "manifest.json"), "utf8"));
    } catch {
      continue;
    }

    const backendPath = path.resolve(packageRoot, manifest.backend.entry);
    const workspaceRoot = path.resolve(packageRoot, path.dirname(manifest.ui.entry));
    const module = await import(pathToFileURL(backendPath).href);
    const pluginRoutes = new Map();
    const context = {
      pluginId: manifest.id,
      route(method, route, handler) {
        pluginRoutes.set(normalizeRoute(method, route), handler);
      },
    };
    const lifecycle = await module.activate(context);

    activePlugins.push({ manifest, packageRoot, workspaceRoot, lifecycle });
    routeTable.set(manifest.id, pluginRoutes);
  }
}

function publicPlugin(plugin, origin) {
  const id = plugin.manifest.id;
  return {
    id,
    name: plugin.manifest.name,
    version: plugin.manifest.version,
    icon: plugin.manifest.icon,
    badge: plugin.lifecycle?.badge,
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
    json(response, 200, { state: "running", pluginCount: activePlugins.length });
    return;
  }
  if (url.pathname === "/runtime/info") {
    const origin = `http://${request.headers.host}`;
    response.setHeader("access-control-allow-origin", "*");
    json(response, 200, {
      type: "runtime-ready",
      origin,
      plugins: activePlugins.map((plugin) => publicPlugin(plugin, origin)),
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
    json(response, 200, { pluginId, state: "running", badge: plugin.lifecycle?.badge });
    return;
  }

  if (section === "workspace") {
    await serveWorkspace(response, plugin, tail);
    return;
  }

  const handler = routeTable.get(pluginId)?.get(normalizeRoute(request.method ?? "GET", `/${tail}`));
  if (!handler) {
    json(response, 404, { error: "Plugin API route not found" });
    return;
  }

  try {
    const body = await handler({ method: request.method, url, headers: request.headers });
    json(response, 200, body);
  } catch (error) {
    json(response, 500, { error: error instanceof Error ? error.message : "Plugin route failed" });
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
  })}\n`);
});

let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  server.close();
  await Promise.allSettled(activePlugins.map((plugin) => plugin.lifecycle?.deactivate?.()));
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
