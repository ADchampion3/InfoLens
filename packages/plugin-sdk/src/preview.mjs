import { watch } from "node:fs";
import { cp, mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { createServer as createNetServer } from "node:net";

function previewError(code, message, phase = "preview") {
  const error = new Error(message);
  error.code = code;
  error.phase = phase;
  return error;
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
          if (filename) {
            const changedPath = path.resolve(directory, String(filename));
            if (ignoredPath(sourceRoot, changedPath)) return;
          }
          onChange();
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
    healthUrl: `${ready.origin}/plugins/${encodeURIComponent(pluginId)}/health`,
    pluginId,
  };
}

export function createPreviewSession({
  packageRoot,
  pluginId,
  sdkRoot,
  runtimePackageRoot,
  bundledOpenCliRoot,
  timeoutMs = 10_000,
  watchFiles = true,
  onEvent = () => {},
}) {
  let temporaryRoot;
  let targetRoot;
  let runtime;
  let runtimePort;
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
      await stopRuntime(runtime);
      await copyPackageSnapshot(packageRoot, targetRoot);
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
    return ignoredPath(packageRoot, path.resolve(packageRoot, String(filename)));
  }

  function scheduleRestart() {
    if (stopping) return;
    clearTimeout(restartTimer);
    restartTimer = setTimeout(() => {
      Promise.resolve(restartRuntime()).catch(() => {});
    }, 150);
  }

  async function startWatcher() {
    if (!watchFiles) return;
    try {
      watcher = watch(packageRoot, { recursive: true }, (_event, filename) => {
        if (ignoredWatchEvent(filename)) return;
        scheduleRestart();
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
      assertRunning();
      await mkdir(path.join(temporaryRoot, "node_modules", "@infolens"), { recursive: true });
      await cp(sdkRoot, path.join(temporaryRoot, "node_modules", "@infolens", "plugin-sdk"), { recursive: true });
      assertRunning();
      runtimePort = await findFreePort();
      assertRunning();
      const current = await launchRuntime();
      assertRunning();
      await startWatcher();
      assertRunning();
      return { ...current.urls, watch: watchActive };
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
