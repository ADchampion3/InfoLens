const STATUS_VALUES = new Set(["ok", "degraded", "failed", "unknown"]);
const OVERALL_VALUES = new Set(["connected", "degraded", "disconnected", "unknown"]);
const ACTION_VALUES = new Set([
  "check",
  "reconnect",
  "restart-daemon",
  "open-chrome",
  "enable-extension",
  "select-profile",
  "update-extension",
  "update-opencli",
  "retry",
]);

export const BROWSER_STATUS_TTL_MS = 5 * 60 * 1000;
export const BROWSER_DOCTOR_RETRY_DELAYS_MS = Object.freeze([1_000, 3_000, 8_000]);
export const BROWSER_COORDINATOR_PLUGIN_ID = "__runtime-browser-bridge__";

function safeCode(value, fallback = "BROWSER_STATUS_UNKNOWN") {
  if (typeof value !== "string" || !value.trim()) return fallback;
  return value.trim().replace(/[^A-Za-z0-9_.-]/gu, "_").slice(0, 80) || fallback;
}

function safeStatus(value) {
  return STATUS_VALUES.has(value) ? value : "unknown";
}

function safeAction(value, fallback = "check") {
  return ACTION_VALUES.has(value) ? value : fallback;
}

function safeAffected(values) {
  if (!Array.isArray(values)) return [];
  return values
    .filter((value) => value && typeof value === "object")
    .map((value) => ({
      ...(typeof value.id === "string" && value.id.trim() ? { id: value.id.trim() } : {}),
      ...(typeof value.name === "string" && value.name.trim() ? { name: value.name.trim() } : {}),
      ...(typeof value.state === "string" && value.state.trim() ? { state: value.state.trim() } : {}),
      ...(typeof value.dependencyState === "string" && value.dependencyState.trim() ? { dependencyState: value.dependencyState.trim() } : {}),
    }))
    .filter((value) => value.id && value.name);
}

function check(status = "unknown", code, retryable, action) {
  return {
    status: safeStatus(status),
    ...(code ? { code: safeCode(code) } : {}),
    ...(retryable !== undefined ? { retryable: retryable === true } : {}),
    ...(action ? { action: safeAction(action) } : {}),
  };
}

function emptyChecks() {
  return {
    daemon: check(),
    extension: check(),
    browser: check(),
    profile: check(),
  };
}

function unsupportedDoctorOutput() {
  const error = new Error("Bundled OpenCLI doctor output is not supported");
  error.code = "DOCTOR_OUTPUT_UNSUPPORTED";
  error.retryable = false;
  return error;
}

function createAbortError() {
  return Object.assign(new Error("Browser Bridge check was cancelled"), { name: "AbortError" });
}

function isAbortError(error) {
  return error?.name === "AbortError" || error?.code === "ABORT_ERR";
}

function throwIfAborted(signal, error) {
  if (!signal?.aborted && !isAbortError(error)) return;
  throw isAbortError(error) ? error : createAbortError();
}

function parseMarker(value) {
  if (value === "OK") return "ok";
  if (value === "WARN") return "degraded";
  if (value === "MISSING" || value === "FAIL") return "failed";
  return "unknown";
}

function parseDoctorChecks(output) {
  const lines = String(output).split(/\r?\n/u);
  const header = lines.some((line) => /^opencli v1\.8\.6 doctor(?:\s|$)/iu.test(line.trim()));
  if (!header) throw unsupportedDoctorOutput();

  const checks = emptyChecks();
  const markers = new Map();
  const markerPattern = /^\s*\[(OK|WARN|MISSING|FAIL)\]\s+(Daemon|Extension|Connectivity):\s*(.*?)\s*$/iu;
  for (const line of lines) {
    const match = line.match(markerPattern);
    if (match) markers.set(match[2].toLowerCase(), { marker: match[1].toUpperCase(), detail: match[3] });
  }
  if (!markers.has("daemon") || !markers.has("extension") || !markers.has("connectivity")) {
    throw unsupportedDoctorOutput();
  }

  const daemon = markers.get("daemon");
  const daemonDetail = daemon.detail.toLowerCase();
  if (/stale/u.test(daemonDetail)) {
    checks.daemon = check("degraded", "DAEMON_STALE", true, "restart-daemon");
  } else if (/unstable/u.test(daemonDetail)) {
    checks.daemon = check("degraded", "DAEMON_UNSTABLE", true, "restart-daemon");
  } else if (daemon.marker === "OK" && /running/u.test(daemonDetail)) {
    checks.daemon = check("ok", "DAEMON_CONNECTED", false, "check");
  } else if (daemon.marker === "MISSING" || /not running|stopped/u.test(daemonDetail)) {
    checks.daemon = check("failed", "DAEMON_STOPPED", true, "restart-daemon");
  } else {
    checks.daemon = check(parseMarker(daemon.marker), "DAEMON_UNAVAILABLE", true, "restart-daemon");
  }

  const extension = markers.get("extension");
  const extensionDetail = extension.detail.toLowerCase();
  if (/unstable/u.test(extensionDetail)) {
    checks.extension = check("degraded", "EXTENSION_UNSTABLE", true, "retry");
  } else if (/connected/u.test(extensionDetail)) {
    checks.extension = /version unknown/u.test(extensionDetail)
      ? check("degraded", "EXTENSION_VERSION_UNKNOWN", false, "update-extension")
      : check("ok", "EXTENSION_CONNECTED", false, "check");
  } else if (extension.marker === "MISSING" || /not connected|disconnected/u.test(extensionDetail)) {
    checks.extension = check("failed", "EXTENSION_DISCONNECTED", true, "enable-extension");
  } else {
    checks.extension = check(parseMarker(extension.marker), "EXTENSION_UNAVAILABLE", true, "retry");
  }

  const browser = markers.get("connectivity");
  const browserDetail = browser.detail.toLowerCase();
  if (browser.marker === "OK" && /connected/u.test(browserDetail)) {
    checks.browser = check("ok", "BROWSER_CONNECTED", false, "check");
  } else if (browser.marker === "FAIL" || /failed|unreachable/u.test(browserDetail)) {
    checks.browser = check("failed", "BROWSER_PROBE_FAILED", true, "retry");
  } else {
    checks.browser = check(parseMarker(browser.marker), "BROWSER_PROBE_UNKNOWN", true, "retry");
  }

  const text = lines.join("\n");
  const profileIssue = text.match(/(?:Multiple Chrome profiles[^\n]*no default profile|no default profile[^\n]*|Selected browser profile is not connected[^\n]*|requested profile not connected[^\n]*|Default browser profile is stale[^\n]*)/iu)?.[0]?.toLowerCase();
  if (profileIssue && /no default profile/u.test(profileIssue)) {
    checks.profile = check("failed", "PROFILE_SELECTION_REQUIRED", false, "select-profile");
  } else if (profileIssue && /not connected/u.test(profileIssue)) {
    checks.profile = check("failed", "PROFILE_DISCONNECTED", false, "select-profile");
  } else if (profileIssue && /stale/u.test(profileIssue)) {
    checks.profile = check("degraded", "PROFILE_STALE", true, "select-profile");
  } else if (["EXTENSION_CONNECTED", "EXTENSION_VERSION_UNKNOWN"].includes(checks.extension.code) && checks.browser.status === "ok") {
    checks.profile = check("ok", "PROFILE_CONNECTED", false, "check");
  }

  const statuses = Object.values(checks);
  const hasFailure = statuses.some(({ status }) => status === "failed");
  const hasDegraded = statuses.some(({ status }) => status === "degraded");
  const overall = hasFailure ? "disconnected" : hasDegraded ? "degraded" : "connected";
  const primary = [checks.daemon, checks.profile, checks.extension, checks.browser]
    .find(({ status }) => status === "failed" || status === "degraded") ?? checks.browser;
  return {
    overall,
    checks,
    code: primary.code ?? (overall === "connected" ? "BROWSER_CONNECTED" : "BROWSER_STATUS_UNKNOWN"),
    retryable: primary.retryable === true,
    action: safeAction(primary.action, overall === "connected" ? "check" : "retry"),
  };
}

export function parseBrowserDoctorOutput(output) {
  return parseDoctorChecks(output);
}

export function unknownBrowserStatus(affected = []) {
  return {
    overall: "unknown",
    checks: emptyChecks(),
    checkedAt: undefined,
    durationMs: 0,
    code: "BROWSER_STATUS_UNKNOWN",
    retryable: true,
    action: "check",
    affected: safeAffected(affected),
  };
}

function safeReport(report, affected, now, durationMs) {
  const normalizedOverall = OVERALL_VALUES.has(report?.overall) ? report.overall : "unknown";
  const rawChecks = report?.checks && typeof report.checks === "object" ? report.checks : {};
  const checks = Object.fromEntries(["daemon", "extension", "browser", "profile"].map((key) => {
    const value = rawChecks[key] && typeof rawChecks[key] === "object" ? rawChecks[key] : {};
    return [key, check(value.status, value.code, value.retryable, value.action)];
  }));
  return {
    overall: normalizedOverall,
    checks,
    checkedAt: now().toISOString(),
    durationMs: Math.max(0, Math.round(Number(durationMs) || 0)),
    code: safeCode(report?.code, normalizedOverall === "connected" ? "BROWSER_CONNECTED" : "BROWSER_STATUS_UNKNOWN"),
    retryable: report?.retryable === true,
    action: safeAction(report?.action, normalizedOverall === "connected" ? "check" : "retry"),
    affected: safeAffected(affected),
  };
}

function failureReport(error, affected, now, durationMs) {
  const code = safeCode(error?.code, "BROWSER_DOCTOR_FAILED");
  const unsupported = code === "DOCTOR_OUTPUT_UNSUPPORTED";
  const checks = emptyChecks();
  if (!unsupported && ["BROWSER_BRIDGE_DISCONNECTED", "BROWSER_DOCTOR_FAILED"].includes(code)) {
    checks.browser = check("failed", code, true, "retry");
  }
  return {
    overall: unsupported ? "unknown" : "disconnected",
    checks,
    checkedAt: now().toISOString(),
    durationMs: Math.max(0, Math.round(Number(durationMs) || 0)),
    code,
    retryable: unsupported ? false : error?.retryable !== undefined ? error.retryable === true : isRetryableDoctorFailure(code),
    action: unsupported ? "update-opencli" : "retry",
    affected: safeAffected(affected),
  };
}

function isDaemonRepairable(report) {
  const daemon = report?.checks?.daemon;
  return report?.retryable === true
    && daemon
    && ["DAEMON_STOPPED", "DAEMON_STALE", "DAEMON_UNSTABLE"].includes(daemon.code);
}

function isRetryableDoctorFailure(code) {
  return ["BROWSER_BRIDGE_DISCONNECTED", "BROWSER_DOCTOR_FAILED"].includes(code);
}

function wait(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(createAbortError());
      return;
    }
    let timer;
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(createAbortError());
    };
    timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export function createBrowserBridgeCoordinator({
  adapter,
  taskQueue,
  getAffected = () => [],
  now = () => new Date(),
  sleep = wait,
  retryDelays = BROWSER_DOCTOR_RETRY_DELAYS_MS,
  maxRetries = retryDelays.length,
  ttlMs = BROWSER_STATUS_TTL_MS,
  pluginId = BROWSER_COORDINATOR_PLUGIN_ID,
} = {}) {
  if (!adapter || typeof adapter.doctor !== "function" || typeof adapter.restartDaemon !== "function") {
    throw new TypeError("Browser Bridge coordinator requires doctor and restartDaemon adapters");
  }
  if (!taskQueue || typeof taskQueue.withPermit !== "function") {
    throw new TypeError("Browser Bridge coordinator requires a shared task queue");
  }

  let cached;
  let checkPromise;
  let reconnectPromise;
  let stopped = false;

  function affected() {
    return safeAffected(getAffected());
  }

  function snapshot() {
    if (!cached) return unknownBrowserStatus(affected());
    const checkedAt = Date.parse(cached.checkedAt ?? "");
    if (!Number.isFinite(checkedAt) || now().getTime() - checkedAt >= ttlMs) return unknownBrowserStatus(affected());
    return { ...cached, affected: affected() };
  }

  function cache(report) {
    cached = structuredClone({ ...report, affected: affected() });
    return snapshot();
  }

  async function doctorAttempts(signal, startedAt, { stopForDaemonRepair = false } = {}) {
    let last;
    const attempts = Math.max(0, Number(maxRetries) || 0);
    for (let attempt = 0; attempt <= attempts; attempt += 1) {
      try {
        const raw = await adapter.doctor(signal);
        last = safeReport(raw, affected(), now, now().getTime() - startedAt);
      } catch (error) {
        throwIfAborted(signal, error);
        last = failureReport(error, affected(), now, now().getTime() - startedAt);
      }
      if (!last.retryable || last.overall === "connected" || attempt === attempts || (stopForDaemonRepair && isDaemonRepairable(last))) return last;
      const delay = Number(retryDelays[attempt]);
      if (delay > 0) await sleep(delay, signal);
    }
    return last ?? unknownBrowserStatus(affected());
  }

  function check() {
    if (stopped) return Promise.reject(Object.assign(new Error("Browser Bridge coordinator is stopped"), { code: "RUNTIME_STOPPING" }));
    if (checkPromise) return checkPromise;
    const run = async () => {
      const startedAt = now().getTime();
      const result = await taskQueue.withPermit({ pluginId, resource: "BROWSER" }, async (signal) => {
        let report = await doctorAttempts(signal, startedAt, { stopForDaemonRepair: true });
        if (isDaemonRepairable(report)) {
          try {
            await adapter.restartDaemon(signal);
            report = await doctorAttempts(signal, startedAt);
          } catch (error) {
            throwIfAborted(signal, error);
            report = failureReport(Object.assign(new Error("Browser daemon restart failed"), {
              code: "DAEMON_RESTART_FAILED",
              retryable: true,
              cause: error,
            }), affected(), now, now().getTime() - startedAt);
          }
        }
        return report;
      });
      return cache(result);
    };
    checkPromise = run().finally(() => { checkPromise = undefined; });
    return checkPromise;
  }

  function reconnect() {
    if (stopped) return Promise.reject(Object.assign(new Error("Browser Bridge coordinator is stopped"), { code: "RUNTIME_STOPPING" }));
    if (reconnectPromise) return reconnectPromise;
    const run = async () => {
      const startedAt = now().getTime();
      const result = await taskQueue.withPermit({ pluginId, resource: "BROWSER" }, async (signal) => {
        try {
          await adapter.restartDaemon(signal);
        } catch (error) {
          throwIfAborted(signal, error);
          return failureReport(Object.assign(new Error("Browser daemon restart failed"), {
            code: "DAEMON_RESTART_FAILED",
            retryable: true,
            cause: error,
          }), affected(), now, now().getTime() - startedAt);
        }
        return doctorAttempts(signal, startedAt);
      });
      return cache(result);
    };
    reconnectPromise = run().finally(() => { reconnectPromise = undefined; });
    return reconnectPromise;
  }

  function bestEffortCheck() {
    return check().catch(() => snapshot());
  }

  function stop() {
    stopped = true;
  }

  return {
    getStatus: snapshot,
    check,
    reconnect,
    bestEffortCheck,
    stop,
  };
}
