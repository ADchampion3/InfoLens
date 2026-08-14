import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BROWSER_STATUS_TTL_MS,
  createBrowserBridgeCoordinator,
  parseBrowserDoctorOutput,
} from "../packages/plugin-runtime/src/browser-bridge.mjs";
import { SharedTaskQueue } from "../packages/plugin-runtime/src/task-manager.mjs";

const connectedChecks = {
  daemon: { status: "ok", code: "DAEMON_CONNECTED", retryable: false, action: "check" },
  extension: { status: "ok", code: "EXTENSION_CONNECTED", retryable: false, action: "check" },
  browser: { status: "ok", code: "BROWSER_CONNECTED", retryable: false, action: "check" },
  profile: { status: "ok", code: "PROFILE_CONNECTED", retryable: false, action: "check" },
};

function connectedReport() {
  return { overall: "connected", checks: structuredClone(connectedChecks), code: "BROWSER_CONNECTED", retryable: false, action: "check" };
}

function coordinator(adapter, options = {}) {
  return createBrowserBridgeCoordinator({
    adapter,
    taskQueue: options.taskQueue ?? new SharedTaskQueue(),
    getAffected: () => [{ id: "zhihu-hot", name: "Zhihu Hot", dependencyState: "unknown" }],
    sleep: async () => {},
    retryDelays: [],
    maxRetries: 0,
    ...options,
  });
}

test("doctor output is reduced to a safe structured status", () => {
  const report = parseBrowserDoctorOutput([
    "opencli v1.8.6 doctor (node)",
    "",
    "[OK] Daemon: running on port 19825 (v1.8.6)",
    "[OK] Extension: connected (v1.0.22)",
    "[OK] Connectivity: connected in 0.1s",
    "Profiles:",
    "  context-id-is-not-public-api: connected v1.0.22, default",
  ].join("\n"));

  assert.equal(report.overall, "connected");
  assert.equal(report.checks.profile.code, "PROFILE_CONNECTED");
  assert.equal("contextId" in report, false);
  assert.equal("issues" in report, false);
});

test("unsupported doctor output fails closed", () => {
  assert.throws(
    () => parseBrowserDoctorOutput("opencli v1.8.6 doctor\nEverything looks good!"),
    (error) => error.code === "DOCTOR_OUTPUT_UNSUPPORTED",
  );
});

test("doctor output from a different OpenCLI version fails closed", () => {
  assert.throws(
    () => parseBrowserDoctorOutput([
      "opencli v1.8.7 doctor",
      "[OK] Daemon: running",
      "[OK] Extension: connected",
      "[OK] Connectivity: connected",
    ].join("\n")),
    (error) => error.code === "DOCTOR_OUTPUT_UNSUPPORTED",
  );
});

test("doctor keeps actionable extension and profile states without exposing profile identity", () => {
  const report = parseBrowserDoctorOutput([
    "opencli v1.8.6 doctor",
    "",
    "[OK] Daemon: running on port 19825 (v1.8.6)",
    "[WARN] Extension: connected (version unknown)",
    "[OK] Connectivity: connected in 0.1s",
    "Profiles:",
    "  private-context-id: connected version unknown, default",
    "Issues:",
    "  - Extension is connected but did not report a version.",
  ].join("\n"));

  assert.equal(report.overall, "degraded");
  assert.deepEqual(report.checks.extension, { status: "degraded", code: "EXTENSION_VERSION_UNKNOWN", retryable: false, action: "update-extension" });
  assert.equal(report.checks.profile.code, "PROFILE_CONNECTED");
  assert.doesNotMatch(JSON.stringify(report), /private-context-id/u);
});

test("doctor maps profile selection failures to a user action", () => {
  const report = parseBrowserDoctorOutput([
    "opencli v1.8.6 doctor",
    "",
    "[OK] Daemon: running on port 19825 (v1.8.6)",
    "[MISSING] Extension: not connected",
    "[FAIL] Connectivity: failed (profile required)",
    "Issues:",
    "  - Multiple Chrome profiles are connected to the daemon, but no default profile was selected.",
  ].join("\n"));

  assert.equal(report.overall, "disconnected");
  assert.equal(report.checks.profile.code, "PROFILE_SELECTION_REQUIRED");
  assert.equal(report.action, "select-profile");
});

test("status starts unknown, merges concurrent checks, and expires after the TTL", async () => {
  let current = Date.parse("2026-08-14T00:00:00.000Z");
  let calls = 0;
  const bridge = coordinator({
    doctor: async () => { calls += 1; return connectedReport(); },
    restartDaemon: async () => {},
  }, {
    now: () => new Date(current),
  });

  assert.equal(bridge.getStatus().overall, "unknown");
  const first = bridge.check();
  const second = bridge.check();
  assert.strictEqual(first, second);
  assert.equal((await first).overall, "connected");
  assert.equal(calls, 1);

  current += BROWSER_STATUS_TTL_MS;
  assert.equal(bridge.getStatus().overall, "unknown");
  assert.equal(calls, 1);
});

test("daemon stopped or unstable status is repaired through the shared permit", async () => {
  let doctorCalls = 0;
  let restartCalls = 0;
  const bridge = coordinator({
    doctor: async () => {
      doctorCalls += 1;
      if (doctorCalls === 1) return {
        overall: "disconnected",
        checks: { ...structuredClone(connectedChecks), daemon: { status: "failed", code: "DAEMON_STOPPED", retryable: true, action: "restart-daemon" } },
        code: "DAEMON_STOPPED",
        retryable: true,
        action: "restart-daemon",
      };
      return connectedReport();
    },
    restartDaemon: async () => { restartCalls += 1; },
  });

  const result = await bridge.check();
  assert.equal(result.overall, "connected");
  assert.equal(doctorCalls, 2);
  assert.equal(restartCalls, 1);
});

test("daemon repair is immediate even when generic retries are configured", async () => {
  let sleepCalls = 0;
  let doctorCalls = 0;
  let restartCalls = 0;
  const bridge = coordinator({
    doctor: async () => {
      doctorCalls += 1;
      if (doctorCalls === 1) return {
        overall: "disconnected",
        checks: { ...structuredClone(connectedChecks), daemon: { status: "failed", code: "DAEMON_STOPPED", retryable: true, action: "restart-daemon" } },
        code: "DAEMON_STOPPED",
        retryable: true,
        action: "restart-daemon",
      };
      return connectedReport();
    },
    restartDaemon: async () => { restartCalls += 1; },
  }, {
    retryDelays: [10_000],
    maxRetries: 1,
    sleep: async () => { sleepCalls += 1; },
  });

  assert.equal((await bridge.check()).overall, "connected");
  assert.equal(restartCalls, 1);
  assert.equal(sleepCalls, 0);
});

test("extension failure does not restart the daemon automatically", async () => {
  let restartCalls = 0;
  const bridge = coordinator({
    doctor: async () => ({
      overall: "disconnected",
      checks: { ...structuredClone(connectedChecks), extension: { status: "failed", code: "EXTENSION_DISCONNECTED", retryable: true, action: "enable-extension" } },
      code: "EXTENSION_DISCONNECTED",
      retryable: true,
      action: "enable-extension",
    }),
    restartDaemon: async () => { restartCalls += 1; },
  });

  const result = await bridge.check();
  assert.equal(result.code, "EXTENSION_DISCONNECTED");
  assert.equal(restartCalls, 0);
});

test("reconnect explicitly restarts the daemon and then checks it", async () => {
  let restartCalls = 0;
  let doctorCalls = 0;
  const bridge = coordinator({
    doctor: async () => { doctorCalls += 1; return connectedReport(); },
    restartDaemon: async () => { restartCalls += 1; },
  });

  assert.equal((await bridge.reconnect()).overall, "connected");
  assert.equal(restartCalls, 1);
  assert.equal(doctorCalls, 1);
});

test("checks wait behind another browser operation", async () => {
  const queue = new SharedTaskQueue();
  let release;
  let doctorCalls = 0;
  const occupied = queue.withPermit({ pluginId: "refreshing-plugin", resource: "BROWSER" }, () => new Promise((resolve) => { release = resolve; }));
  const bridge = coordinator({
    doctor: async () => { doctorCalls += 1; return connectedReport(); },
    restartDaemon: async () => {},
  }, {
    taskQueue: queue,
  });
  const check = bridge.check();
  await Promise.resolve();
  assert.equal(doctorCalls, 0);
  release();
  await occupied;
  await check;
  assert.equal(doctorCalls, 1);
});

test("stopping the coordinator does not call external lifecycle operations", async () => {
  let restartCalls = 0;
  const bridge = coordinator({
    doctor: async () => connectedReport(),
    restartDaemon: async () => { restartCalls += 1; },
  });
  bridge.stop();
  await assert.rejects(bridge.check(), (error) => error.code === "RUNTIME_STOPPING");
  await assert.rejects(bridge.reconnect(), (error) => error.code === "RUNTIME_STOPPING");
  assert.equal(restartCalls, 0);
});

test("cancellation propagates without caching a failure report", async () => {
  const cancelled = () => Object.assign(new Error("cancelled"), { name: "AbortError" });
  const bridge = coordinator({
    doctor: async () => { throw cancelled(); },
    restartDaemon: async () => {},
  });

  await assert.rejects(bridge.check(), (error) => error.name === "AbortError");
  assert.equal(bridge.getStatus().overall, "unknown");

  const reconnect = coordinator({
    doctor: async () => connectedReport(),
    restartDaemon: async () => { throw cancelled(); },
  });
  await assert.rejects(reconnect.reconnect(), (error) => error.name === "AbortError");
  assert.equal(reconnect.getStatus().overall, "unknown");
});
