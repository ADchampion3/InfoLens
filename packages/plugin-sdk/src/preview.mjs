import { watch } from "node:fs";
import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { createServer as createHttpServer, request as httpRequest } from "node:http";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { createConnection, createServer as createNetServer } from "node:net";

function previewError(code, message, phase = "preview") {
  const error = new Error(message);
  error.code = code;
  error.phase = phase;
  return error;
}

export async function workspaceBuildScript(packageRoot) {
  try {
    const manifest = JSON.parse(await readFile(path.join(packageRoot, "package.json"), "utf8"));
    const script = manifest?.scripts?.["build:workspace"];
    return typeof script === "string" && script.trim() ? script : undefined;
  } catch {
    return undefined;
  }
}

export async function workspaceDevConfig(packageRoot, { enabled = false, url } = {}) {
  let packageManifest;
  try { packageManifest = JSON.parse(await readFile(path.join(packageRoot, "package.json"), "utf8")); }
  catch { packageManifest = {}; }
  const configured = packageManifest?.infolens?.workspaceDev?.url;
  const devUrl = url ?? configured;
  if (!enabled && !url) return undefined;
  if (typeof devUrl !== "string" || !devUrl.trim()) throw previewError("PREVIEW_DEV_URL_REQUIRED", "Preview dev mode requires infolens.workspaceDev.url or --dev-url", "dev-server");
  return { url: devUrl.trim(), start: enabled };
}

export function runWorkspaceBuild(packageRoot) {
  const executable = process.platform === "win32" ? "npm.cmd" : "npm";
  const command = process.platform === "win32" ? (process.env.ComSpec ?? "cmd.exe") : executable;
  const args = process.platform === "win32"
    ? ["/d", "/s", "/c", executable, "run", "build:workspace"]
    : ["run", "build:workspace"];
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: packageRoot,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    child.stdout.on("data", (chunk) => process.stderr.write(chunk));
    child.stderr.on("data", (chunk) => process.stderr.write(chunk));
    child.once("error", (error) => reject(previewError("PREVIEW_WORKSPACE_BUILD_FAILED", error.message, "workspace-build")));
    child.once("close", (code, signal) => {
      if (code === 0) resolve();
      else reject(previewError("PREVIEW_WORKSPACE_BUILD_FAILED", `Workspace build failed (${code ?? signal ?? "unknown"})`, "workspace-build"));
    });
  });
}

function loopbackUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw previewError("PREVIEW_DEV_URL_INVALID", `Workspace dev URL is invalid: ${value}`, "dev-server"); }
  if (!(url.protocol === "http:" && ["localhost", "127.0.0.1", "::1"].includes(url.hostname))) {
    throw previewError("PREVIEW_DEV_URL_NOT_LOOPBACK", "Workspace dev URL must use localhost or a loopback address", "dev-server");
  }
  url.pathname = url.pathname.replace(/\/$/u, "");
  return url;
}

function childCommand() {
  const executable = process.platform === "win32" ? "npm.cmd" : "npm";
  return process.platform === "win32"
    ? { command: process.env.ComSpec ?? "cmd.exe", args: ["/d", "/s", "/c", executable] }
    : { command: executable, args: [] };
}

async function stopChildTree(child) {
  if (!child || child.exitCode !== null) return;
  if (process.platform === "win32") {
    await new Promise((resolve) => {
      const killer = spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore", windowsHide: true });
      killer.once("close", resolve);
      killer.once("error", resolve);
    });
  } else {
    try { process.kill(-child.pid, "SIGTERM"); } catch { try { child.kill("SIGTERM"); } catch {} }
  }
  await new Promise((resolve) => {
    if (child.exitCode !== null) return resolve();
    const timer = setTimeout(resolve, 1_000);
    child.once("exit", () => { clearTimeout(timer); resolve(); });
  });
}

async function waitForDevServer(url, child, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    if (child && child.exitCode !== null) throw previewError("PREVIEW_DEV_SERVER_EXITED", "Workspace dev server exited before becoming ready", "dev-server");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.min(500, Math.max(50, deadline - Date.now())));
    try {
      const response = await fetch(url, { signal: controller.signal });
      clearTimeout(timer);
      if (response.status < 500) return;
    } catch (error) { clearTimeout(timer); lastError = error; }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw previewError("PREVIEW_DEV_SERVER_TIMEOUT", `Workspace dev server did not respond within ${timeoutMs}ms${lastError ? `: ${lastError.message}` : ""}`, "dev-server");
}

function proxyPath(pathname, pluginId) {
  const prefix = `/__infolens_workspace_dev__/${encodeURIComponent(pluginId)}`;
  if (pathname === prefix || pathname === `${prefix}/`) return "/";
  if (pathname.startsWith(`${prefix}/`)) return pathname.slice(prefix.length) || "/";
  return pathname;
}

const PUBLIC_RUNTIME_PATHS = new Set([
  "/runtime/plugin-sdk.js",
  "/runtime/plugin-workspace-history.js",
  "/runtime/plugin-workspace-history.css",
  "/runtime/plugin-sdk-tokens.css",
  "/runtime/plugin-sdk-workspace.css",
]);

function runtimePath(pathname, pluginId) {
  const pluginRoot = `/api/v1/plugins/${encodeURIComponent(pluginId)}`;
  return PUBLIC_RUNTIME_PATHS.has(pathname) || pathname === `${pluginRoot}/health` || pathname === `${pluginRoot}/api` || pathname.startsWith(`${pluginRoot}/api/`);
}

function createWorkspaceProxy({ runtimeOrigin, runtimeToken, pluginId, devUrl }) {
  const target = loopbackUrl(devUrl);
  const server = createHttpServer((request, response) => {
    const incoming = new URL(request.url ?? "/", "http://127.0.0.1");
    if (runtimePath(incoming.pathname, pluginId)) {
      const targetUrl = new URL(incoming.pathname + incoming.search, runtimeOrigin);
      const headers = { ...request.headers };
      if (runtimeToken) headers.authorization = `Bearer ${runtimeToken}`;
      const upstream = httpRequest(targetUrl, { method: request.method, headers }, (upstreamResponse) => {
        response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
        upstreamResponse.pipe(response);
      });
      upstream.once("error", (error) => { if (!response.headersSent) response.writeHead(502); response.end(error.message); });
      request.pipe(upstream);
      return;
    }
    const relative = proxyPath(incoming.pathname, pluginId);
    const targetUrl = new URL(relative + incoming.search, target);
    const upstream = httpRequest(targetUrl, { method: request.method, headers: request.headers }, (upstreamResponse) => {
      response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
      upstreamResponse.pipe(response);
    });
    upstream.once("error", (error) => { if (!response.headersSent) response.writeHead(502); response.end(error.message); });
    request.pipe(upstream);
  });
  const sockets = new Set();
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  server.on("upgrade", (request, socket, head) => {
    const incoming = new URL(request.url ?? "/", "http://127.0.0.1");
    const relative = proxyPath(incoming.pathname, pluginId);
    const targetPort = Number(target.port || (target.protocol === "https:" ? 443 : 80));
    const targetSocket = createConnection({ host: target.hostname, port: targetPort }, () => {
      const requestTarget = `${relative}${incoming.search}`;
      const headers = Object.entries(request.headers).map(([key, value]) => `${key}: ${Array.isArray(value) ? value.join(", ") : value}`).join("\r\n");
      targetSocket.write(`${request.method} ${requestTarget} HTTP/${request.httpVersion}\r\n${headers}\r\n\r\n`);
      if (head.length) targetSocket.write(head);
      socket.pipe(targetSocket).pipe(socket);
    });
    targetSocket.once("error", () => socket.destroy());
  });
  return {
    server,
    target,
    close: () => new Promise((resolve) => {
      for (const socket of sockets) socket.destroy();
      server.close(() => resolve());
    }),
  };
}

function ignoredPath(sourceRoot, sourcePath) {
  const relative = path.relative(sourceRoot, sourcePath);
  const parts = relative.split(path.sep).filter(Boolean);
  return parts.some((part) => [".git", ".infolens-dev", "node_modules"].includes(part)) || relative === "adapter-integrity.json";
}

async function watchDirectories(sourceRoot) {
  const directories = [];
  async function visit(directory) {
    directories.push(directory);
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const child = path.join(directory, entry.name);
      if (ignoredPath(sourceRoot, child)) continue;
      await visit(child);
    }
  }
  await visit(sourceRoot);
  return directories;
}

async function createPortableWatcher(sourceRoot, onChange, onError) {
  const handles = new Map();
  let closed = false;
  let refreshPromise;

  const refresh = () => {
    if (refreshPromise) return refreshPromise;
    refreshPromise = (async () => {
      const directories = new Set(await watchDirectories(sourceRoot));
      for (const [directory, handle] of handles) {
        if (!directories.has(directory)) {
          handle.close();
          handles.delete(directory);
        }
      }
      for (const directory of directories) {
        if (closed || handles.has(directory)) continue;
        const handle = watch(directory, (event, filename) => {
          const changedPath = filename ? path.resolve(directory, String(filename)) : undefined;
          if (changedPath && ignoredPath(sourceRoot, changedPath)) return;
          onChange(changedPath);
          if (event === "rename") void refresh().catch(onError);
        });
        handle.on("error", onError);
        handles.set(directory, handle);
      }
    })().finally(() => {
      refreshPromise = undefined;
    });
    return refreshPromise;
  };

  const close = () => {
    closed = true;
    for (const handle of handles.values()) handle.close();
    handles.clear();
  };

  try {
    await refresh();
    return { close };
  } catch (error) {
    close();
    throw error;
  }
}

async function copyPackageSnapshot(sourceRoot, destinationRoot) {
  await rm(destinationRoot, { recursive: true, force: true });
  await mkdir(path.dirname(destinationRoot), { recursive: true });
  await cp(sourceRoot, destinationRoot, {
    recursive: true,
    filter: (sourcePath) => !ignoredPath(sourceRoot, sourcePath),
  });
}

async function findFreePort() {
  return new Promise((resolve, reject) => {
    const server = createNetServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(previewError("PREVIEW_PORT_UNAVAILABLE", "Preview Runtime did not expose a TCP port", "runtime-start")));
        return;
      }
      server.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
}

function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    let timer;
    const finish = () => {
      clearTimeout(timer);
      child.off("exit", finish);
      resolve();
    };
    child.once("exit", finish);
    timer = setTimeout(finish, timeoutMs);
  });
}

function waitForRuntimeReady(child, lines, errors, timeoutMs) {
  return new Promise((resolve, reject) => {
    let timer;
    const cleanup = () => {
      clearTimeout(timer);
      lines.off("line", onLine);
      child.off("exit", onExit);
    };
    const onLine = (line) => {
      try {
        const message = JSON.parse(line);
        if (message.type !== "runtime-ready") return;
        cleanup();
        resolve(message);
      } catch {
        errors.push(String(line));
      }
    };
    const onExit = (code, signal) => {
      cleanup();
      reject(previewError("PREVIEW_RUNTIME_EXITED", `Preview Runtime exited before ready (${code ?? signal ?? "unknown"})${errors.length ? `: ${errors.join("")}` : ""}`, "runtime-start"));
    };
    lines.on("line", onLine);
    child.once("exit", onExit);
    timer = setTimeout(() => {
      cleanup();
      reject(previewError("PREVIEW_RUNTIME_TIMEOUT", `Preview Runtime did not become ready within ${timeoutMs}ms`, "runtime-start"));
    }, timeoutMs);
  });
}

function previewUrls(ready, pluginId) {
  const plugin = ready.plugins?.find((entry) => entry.id === pluginId);
  if (!plugin) throw previewError("PREVIEW_PLUGIN_UNAVAILABLE", `Preview Plugin '${pluginId}' was not active in the Runtime`, "runtime-start");
  const workspaceUrl = new URL(plugin.workspaceUrl);
  workspaceUrl.searchParams.set("pluginId", pluginId);
  workspaceUrl.searchParams.set("apiBaseUrl", plugin.apiBaseUrl);
  return {
    origin: ready.origin,
    workspaceUrl: workspaceUrl.toString(),
    apiBaseUrl: plugin.apiBaseUrl,
    healthUrl: `${ready.origin}/api/v1/plugins/${encodeURIComponent(pluginId)}/health`,
    pluginId,
  };
}

export function createPreviewSession({
  packageRoot,
  pluginId,
  sdkRoot,
  runtimePackageRoot,
  bundledOpenCliRoot,
  buildWorkspace,
  workspaceRoot,
  workspaceDev,
  workspaceEntry,
  backendRoot,
  timeoutMs = 10_000,
  watchFiles = true,
  onEvent = () => {},
}) {
  let temporaryRoot;
  let targetRoot;
  let runtime;
  let runtimePort;
  let workspaceDevProcess;
  let workspaceProxy;
  let watcher;
  let restartTimer;
  let restartPromise;
  let terminationPromise;
  let terminationCode;
  let finalResult;
  let started = false;
  let stopping = false;
  let watchActive = false;
  const waiters = [];

  function notify(result) {
    finalResult = result;
    while (waiters.length) waiters.shift()(result);
  }

  function fail(error, reason = "preview-failed") {
    void terminate({ code: 1, reason, error }).catch(() => {});
  }

  function runtimeEnvironment() {
    return {
      ...process.env,
      INFOLENS_PROJECT_ROOT: temporaryRoot,
      INFOLENS_PLUGINS_ROOT: path.join(temporaryRoot, "plugins"),
      INFOLENS_PLUGIN_DATA_ROOT: path.join(temporaryRoot, "plugin-data"),
      INFOLENS_HOST_STATE_PATH: path.join(temporaryRoot, "host-state.json"),
      INFOLENS_ADAPTER_REGISTRY_ROOT: path.join(temporaryRoot, "managed-adapters"),
      INFOLENS_BATCH_STATE_PATH: path.join(temporaryRoot, "batches.json"),
      INFOLENS_APPLICATION_SESSION_ID: `preview-${randomUUID()}`,
      INFOLENS_BUNDLED_OPENCLI_ROOT: bundledOpenCliRoot,
      INFOLENS_RUNTIME_PORT: String(runtimePort),
      INFOLENS_RUNTIME_PREVIEW: "1",
    };
  }

  async function stopRuntime(entry) {
    if (!entry) return;
    entry.expectedExit = true;
    if (entry.child.exitCode === null) {
      try {
        entry.child.stdin.write("shutdown\n");
        entry.child.stdin.end();
      } catch {}
      await waitForExit(entry.child, timeoutMs);
      if (entry.child.exitCode === null) entry.child.kill();
      await waitForExit(entry.child, 250);
    }
    entry.lines.close();
    if (runtime === entry) runtime = undefined;
  }

  async function startWorkspaceDev() {
    if (!workspaceDev?.url) return;
    const targetUrl = loopbackUrl(workspaceDev.url);
    if (workspaceDev.start) {
      const command = childCommand();
      const child = spawn(command.command, [...command.args, "run", "dev:workspace"], {
        cwd: packageRoot,
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
      workspaceDevProcess = child;
      child.stdout.on("data", (chunk) => process.stderr.write(chunk));
      child.stderr.on("data", (chunk) => process.stderr.write(chunk));
      child.once("exit", (code, signal) => {
        if (!stopping) fail(previewError("PREVIEW_DEV_SERVER_EXITED", `Workspace dev server exited (${code ?? signal ?? "unknown"})`, "dev-server"), "dev-server-exit");
      });
    }
    await waitForDevServer(targetUrl, workspaceDevProcess, timeoutMs);
  }

  async function stopWorkspaceDev() {
    await stopChildTree(workspaceDevProcess);
    workspaceDevProcess = undefined;
    if (workspaceProxy) {
      await workspaceProxy.close();
      workspaceProxy = undefined;
    }
  }

  async function launchRuntime() {
    const child = spawn(process.execPath, [path.join(runtimePackageRoot, "src", "server.mjs")], {
      cwd: runtimePackageRoot,
      env: runtimeEnvironment(),
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    const lines = readline.createInterface({ input: child.stdout });
    const errors = [];
    const entry = { child, lines, errors, expectedExit: false };
    child.stdin.on("error", () => {});
    child.stderr.on("data", (chunk) => errors.push(String(chunk)));
    child.once("exit", (code, signal) => {
      if (entry.expectedExit || stopping || runtime !== entry) return;
      fail(previewError("PREVIEW_RUNTIME_EXITED", `Preview Runtime exited (${code ?? signal ?? "unknown"})${errors.length ? `: ${errors.join("")}` : ""}`, "runtime"), "runtime-exit");
    });
    runtime = entry;
    try {
      const ready = await waitForRuntimeReady(child, lines, errors, timeoutMs);
      const urls = previewUrls(ready, pluginId);
      return { ...entry, ready, urls };
    } catch (error) {
      await stopRuntime(entry);
      throw error;
    }
  }

  async function restartRuntime() {
    if (stopping || restartPromise) return restartPromise;
    restartPromise = (async () => {
      if (buildWorkspace) {
        try {
          await buildWorkspace();
        } catch (error) {
          onEvent({
            type: "workspace-build-failed",
            code: error?.code ?? "PREVIEW_WORKSPACE_BUILD_FAILED",
            message: error instanceof Error ? error.message : String(error),
          });
          return;
        }
      }
      await stopRuntime(runtime);
      await copyPackageSnapshot(packageRoot, targetRoot);
      if (workspaceDev && workspaceEntry) {
        const entry = path.join(targetRoot, path.relative(packageRoot, workspaceEntry));
        await mkdir(path.dirname(entry), { recursive: true });
        await writeFile(entry, "<!doctype html><title>Infolens Workspace dev server</title>", { flag: "a" });
      }
      const next = await launchRuntime();
      onEvent({ type: "restarted", ...next.urls });
    })().catch((error) => {
      fail(error, "restart-failed");
      throw error;
    }).finally(() => {
      restartPromise = undefined;
    });
    return restartPromise;
  }

  function ignoredWatchEvent(filename) {
    if (!filename) return false;
    const changedPath = path.resolve(packageRoot, String(filename));
    if (ignoredPath(packageRoot, changedPath)) return true;
    if (workspaceDev && workspaceRoot) {
      const backendRelation = path.relative(backendRoot ?? path.join(packageRoot, "backend"), changedPath);
      const relative = path.relative(packageRoot, changedPath);
      const backendChanged = backendRelation === "" || (!backendRelation.startsWith("..") && !path.isAbsolute(backendRelation));
      if (!backendChanged && relative !== "manifest.json") return true;
    }
    if (!buildWorkspace || !workspaceRoot) return false;
    const relative = path.relative(workspaceRoot, changedPath);
    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
  }

  function scheduleRestart(filename) {
    if (stopping) return;
    if (ignoredWatchEvent(filename)) return;
    clearTimeout(restartTimer);
    restartTimer = setTimeout(() => {
      Promise.resolve(restartRuntime()).catch(() => {});
    }, 150);
  }

  async function startWatcher() {
    if (!watchFiles) return;
    try {
      watcher = watch(packageRoot, { recursive: true }, (_event, filename) => {
        scheduleRestart(filename);
      });
      watchActive = true;
      watcher.on("error", (error) => fail(previewError("PREVIEW_WATCH_FAILED", error.message, "watch"), "watch-failed"));
      return;
    } catch (error) {
      onEvent({ type: "watch-fallback", code: error.code ?? "WATCH_RECURSIVE_UNAVAILABLE", message: error.message });
    }
    try {
      watcher = await createPortableWatcher(
        packageRoot,
        scheduleRestart,
        (error) => fail(previewError("PREVIEW_WATCH_FAILED", error.message, "watch"), "watch-failed"),
      );
      watchActive = true;
    } catch (error) {
      throw previewError("PREVIEW_WATCH_UNAVAILABLE", `Preview could not watch '${packageRoot}': ${error.message}`, "watch");
    }
  }

  async function terminate({ code, reason, error }) {
    if (terminationPromise) return terminationPromise;
    terminationCode = code;
    terminationPromise = (async () => {
      stopping = true;
      clearTimeout(restartTimer);
      watcher?.close();
      watcher = undefined;
      await restartPromise?.catch(() => {});
      let cleanupError;
      try { await stopRuntime(runtime); } catch (stopError) { cleanupError ??= stopError; }
      try { await stopWorkspaceDev(); } catch (stopError) { cleanupError ??= stopError; }
      try {
        if (temporaryRoot) await rm(temporaryRoot, { recursive: true, force: true });
      } catch (removeError) {
        cleanupError ??= removeError;
      }
      const result = {
        code,
        reason,
        ...(error ? { error } : {}),
        ...(cleanupError ? { cleanupError: { code: cleanupError.code, message: cleanupError.message } } : {}),
      };
      notify(result);
      return result;
    })();
    return terminationPromise;
  }

  async function start() {
    if (started) throw previewError("PREVIEW_ALREADY_STARTED", "Preview session has already started");
    started = true;
    const assertRunning = () => {
      if (stopping) throw previewError("PREVIEW_STOPPED", "Preview stopped during startup", "preview");
    };
    try {
      assertRunning();
      temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "infolens-plugin-preview-"));
      assertRunning();
      targetRoot = path.join(temporaryRoot, "plugins", pluginId);
      await copyPackageSnapshot(packageRoot, targetRoot);
      if (workspaceDev && workspaceEntry) {
        const entry = path.join(targetRoot, path.relative(packageRoot, workspaceEntry));
        await mkdir(path.dirname(entry), { recursive: true });
        await writeFile(entry, "<!doctype html><title>Infolens Workspace dev server</title>", { flag: "a" });
      }
      assertRunning();
      await mkdir(path.join(temporaryRoot, "node_modules", "@infolens"), { recursive: true });
      await cp(sdkRoot, path.join(temporaryRoot, "node_modules", "@infolens", "plugin-sdk"), { recursive: true });
      assertRunning();
      runtimePort = await findFreePort();
      assertRunning();
      await startWorkspaceDev();
      assertRunning();
      const current = await launchRuntime();
      assertRunning();
      if (workspaceDev) {
        workspaceProxy = createWorkspaceProxy({ runtimeOrigin: current.urls.origin, runtimeToken: current.ready.runtimeToken, pluginId, devUrl: workspaceDev.url });
        const address = await new Promise((resolve, reject) => {
          workspaceProxy.server.once("error", reject);
          workspaceProxy.server.listen(0, "127.0.0.1", () => resolve(workspaceProxy.server.address()));
        });
        const proxyOrigin = `http://127.0.0.1:${address.port}`;
        current.urls.workspaceUrl = `${proxyOrigin}/__infolens_workspace_dev__/${encodeURIComponent(pluginId)}/?pluginId=${encodeURIComponent(pluginId)}&apiBaseUrl=${encodeURIComponent(`${proxyOrigin}/api/v1/plugins/${encodeURIComponent(pluginId)}/api/`)}`;
        current.urls.apiBaseUrl = `${proxyOrigin}/api/v1/plugins/${encodeURIComponent(pluginId)}/api/`;
        current.urls.healthUrl = `${proxyOrigin}/api/v1/plugins/${encodeURIComponent(pluginId)}/health`;
        current.urls.origin = proxyOrigin;
      }
      await startWatcher();
      assertRunning();
      return { ...current.urls, build: Boolean(buildWorkspace), watch: watchActive };
    } catch (error) {
      if (terminationCode === 0) error = previewError("PREVIEW_STOPPED", "Preview stopped during startup", "preview");
      await terminate({ code: 1, reason: "startup-failed", error }).catch(() => {});
      if (temporaryRoot) await rm(temporaryRoot, { recursive: true, force: true }).catch(() => {});
      throw error;
    }
  }

  function stop(reason = "user") {
    return terminate({ code: 0, reason });
  }

  function wait() {
    if (finalResult) return Promise.resolve(finalResult);
    return new Promise((resolve) => waiters.push(resolve));
  }

  return { start, stop, wait };
}
