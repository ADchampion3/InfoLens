import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { test } from "node:test";
import { BatchManager } from "../packages/plugin-runtime/src/batch-manager.mjs";
import { normalizeRefreshOutcome } from "../packages/plugin-runtime/src/refresh-outcome.mjs";
import { normalizeRefreshInput } from "../packages/plugin-runtime/src/refresh-options.mjs";
import { createLogService } from "../packages/log-service/src/index.mjs";

const root = path.resolve(import.meta.dirname, "..");
const mockOpenCli = path.join(root, "tests/fixtures/runtime-opencli/opencli");
const runtimeTokens = new Map();

function target(pluginId, overrides = {}) {
  return { pluginId, targetId: `${pluginId}@1.0.0`, name: pluginId, version: "1.0.0", state: "ready", enabled: true, eligible: true, ...overrides };
}

async function startRuntime(dataRoot, stateFile, extraEnv = {}) {
  const sessionId = extraEnv.INFOLENS_APPLICATION_SESSION_ID ?? "batch-refresh-test-session";
  const child = spawn(process.execPath, [path.join(root, "packages/plugin-runtime/src/server.mjs")], {
    cwd: root,
    env: { ...process.env, INFOLENS_PROJECT_ROOT: root, INFOLENS_RUNTIME_PREVIEW: "1", INFOLENS_PLUGIN_DATA_ROOT: dataRoot, INFOLENS_BUNDLED_OPENCLI_ROOT: mockOpenCli, INFOLENS_TEST_OPENCLI_STATE: stateFile, INFOLENS_RUNTIME_PORT: "0", INFOLENS_APPLICATION_SESSION_ID: sessionId, ...extraEnv },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const lines = readline.createInterface({ input: child.stdout });
  return new Promise((resolve, reject) => {
    const errors = [];
    child.stderr.on("data", (chunk) => errors.push(chunk));
    child.once("error", reject);
    const timeout = setTimeout(() => reject(new Error(`Runtime start timed out: ${Buffer.concat(errors).toString()}`)), 5_000);
    lines.on("line", (line) => {
      const message = JSON.parse(line);
      if (message.type === "runtime-ready") {
        clearTimeout(timeout);
        runtimeTokens.set(message.origin, message.runtimeToken);
        resolve({ child, message });
      }
    });
  });
}

async function stopRuntime(child) {
  if (!child) return;
  if (child.exitCode !== null) return;
  if (!child.stdin.destroyed && child.stdin.writable) {
    try { child.stdin.write("shutdown\n"); } catch (error) { if (error?.code !== "EPIPE") throw error; }
  }
  if (child.exitCode === null) await new Promise((resolve) => child.once("exit", resolve));
}

async function request(origin, route, init) {
  const headers = { "content-type": "application/json", ...(runtimeTokens.get(origin) ? { authorization: `Bearer ${runtimeTokens.get(origin)}` } : {}), ...init?.headers };
  const response = await fetch(`${origin}${route}`, { ...init, headers });
  const body = await response.json();
  return { response, body };
}

async function waitForBatch(origin, batchId) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const { body } = await request(origin, `/runtime/batches/${batchId}`);
    if (["succeeded", "partial", "failed", "skipped", "interrupted"].includes(body.status)) return body;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Batch '${batchId}' did not finish`);
}

async function waitForManagerBatch(manager, batchId) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const batch = manager.get(batchId);
    if (batch && ["succeeded", "partial", "failed", "skipped", "interrupted"].includes(batch.status)) return batch;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`BatchManager batch '${batchId}' did not finish`);
}

test("refresh outcomes normalize returned failures, thrown errors, cancellation, and success timestamps", () => {
  assert.deepEqual(normalizeRefreshOutcome({ ok: true, lastSuccessfulRefresh: "2026-08-04T01:02:03.000Z" }, { completedAt: "2026-08-04T02:00:00.000Z" }), {
    status: "succeeded",
    timestamp: "2026-08-04T02:00:00.000Z",
    lastSuccessfulRefreshAt: "2026-08-04T01:02:03.000Z",
  });
  assert.deepEqual(normalizeRefreshOutcome({ ok: false, lastError: "cookie=private", code: "SOURCE_DOWN" }, { completedAt: "2026-08-04T02:00:00.000Z" }), {
    status: "failed",
    code: "SOURCE_DOWN",
    message: "cookie=[REDACTED]",
    timestamp: "2026-08-04T02:00:00.000Z",
  });
  const cancelled = Object.assign(new Error("stopped"), { code: "TASK_CANCELLED", outcome: "uncertain" });
  assert.equal(normalizeRefreshOutcome(undefined, { error: cancelled }).status, "cancelled");
  assert.equal(normalizeRefreshOutcome(undefined, { error: new Error("thrown") }).code, "PLUGIN_ERROR");
  assert.equal(normalizeRefreshOutcome(undefined, { error: "thrown" }).message, "thrown");
});

test("BatchManager snapshots targets, keeps independent outcomes, and retries only failed items", async () => {
  const events = [];
  const attempts = new Map();
  const manager = new BatchManager({
    getTarget: (pluginId) => target(pluginId, pluginId === "skipped" ? { eligible: false, reason: "disabled" } : {}),
    enqueueTarget: async (pluginId) => {
      attempts.set(pluginId, (attempts.get(pluginId) ?? 0) + 1);
      const failed = pluginId === "failed" && attempts.get(pluginId) === 1;
      return { operationId: `operation-${pluginId}-${attempts.get(pluginId)}`, coalesced: false, promise: Promise.resolve(failed ? { ok: false, code: "SOURCE_DOWN", lastError: "source unavailable" } : { ok: true }) };
    },
    onEvent: (event, details) => events.push({ event, ...details }),
  });
  const created = await manager.create(["good", "failed", "skipped"]);
  const result = await (async () => {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const current = manager.get(created.batch.batchId);
      if (current?.status === "partial") return current;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error("BatchManager did not finish");
  })();
  assert.equal(result.counts.succeeded, 1);
  assert.equal(result.counts.failed, 1);
  assert.equal(result.counts.skipped, 1);
  assert.equal(result.items.find(({ pluginId }) => pluginId === "failed").operationId, "operation-failed-1");
  assert(events.some(({ event, batchId }) => event === "target-skipped" && batchId === created.batch.batchId));
  const retry = await manager.retry(created.batch.batchId);
  assert.equal(retry.batch.parentBatchId, created.batch.batchId);
  const retried = await (async () => {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const current = manager.get(retry.batch.batchId);
      if (current?.status === "succeeded") return current;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error("Retry did not finish");
  })();
  assert.deepEqual(retried.items.map(({ pluginId }) => pluginId), ["failed"]);
});

test("BatchManager snapshots per-target refresh inputs and reuses them on retry", async () => {
  let attempts = 0;
  const received = [];
  const refreshOptions = {
    fields: [{ key: "period", label: "Period", type: "select", options: [{ value: "daily", label: "Today" }, { value: "weekly", label: "This week" }] }],
    values: { period: "daily" },
  };
  const manager = new BatchManager({
    getTarget: () => target("parameterized", { refreshOptions }),
    enqueueTarget: (pluginId, { refreshInput }) => {
      received.push({ pluginId, refreshInput });
      attempts += 1;
      return { operationId: `operation-${attempts}`, coalesced: false, promise: Promise.resolve(attempts === 1 ? { ok: false, code: "SOURCE_DOWN" } : { ok: true }) };
    },
  });
  const created = await manager.create([{ pluginId: "parameterized", refreshInput: { period: "weekly" } }]);
  assert.deepEqual(created.batch.items[0].refreshInput, { period: "weekly" });
  const failed = await waitForManagerBatch(manager, created.batch.batchId);
  const retried = await manager.retry(failed.batchId);
  await waitForManagerBatch(manager, retried.batch.batchId);
  assert.deepEqual(received, [
    { pluginId: "parameterized", refreshInput: { period: "weekly" } },
    { pluginId: "parameterized", refreshInput: { period: "weekly" } },
  ]);
  assert.deepEqual(normalizeRefreshInput(refreshOptions, undefined), { period: "daily" });
});

test("BatchManager revalidates the fixed target identity before enqueueing", async () => {
  let targetReads = 0;
  let enqueueCalls = 0;
  const manager = new BatchManager({
    getTarget: () => {
      targetReads += 1;
      return target("changing", targetReads === 1 ? {} : { targetId: "changing@2.0.0" });
    },
    enqueueTarget: () => {
      enqueueCalls += 1;
      return { operationId: "never-enqueued", coalesced: false, promise: Promise.resolve({ ok: true }) };
    },
  });
  const created = await manager.create(["changing"]);
  const result = await waitForManagerBatch(manager, created.batch.batchId);
  assert.equal(result.status, "skipped");
  assert.equal(result.items[0].state, "skipped");
  assert.match(result.items[0].reason, /changed since/);
  assert.equal(enqueueCalls, 0);
});

test("BatchManager serializes concurrent creates into one active Batch", async () => {
  let releaseSnapshot;
  let snapshotStarted;
  const snapshotStartedPromise = new Promise((resolve) => { snapshotStarted = resolve; });
  let targetReads = 0;
  const manager = new BatchManager({
    getTarget: async (pluginId) => {
      targetReads += 1;
      if (targetReads === 1) {
        snapshotStarted();
        await new Promise((resolve) => { releaseSnapshot = resolve; });
      }
      return target(pluginId);
    },
    enqueueTarget: (pluginId) => ({
      operationId: `operation-${pluginId}`,
      coalesced: false,
      promise: Promise.resolve({ ok: true }),
    }),
  });

  const firstCreate = manager.create(["first"]);
  await snapshotStartedPromise;
  const secondCreate = manager.create(["second"]);
  releaseSnapshot();

  const [first, second] = await Promise.all([firstCreate, secondCreate]);
  assert.equal(second.reused, true);
  assert.equal(second.batch.batchId, first.batch.batchId);
  assert.equal(manager.list().length, 1);
  await waitForManagerBatch(manager, first.batch.batchId);
});

test("BatchManager completion only releases its own active Batch", async () => {
  let releaseOld;
  let releaseNew;
  const manager = new BatchManager({
    getTarget: (pluginId) => target(pluginId),
    enqueueTarget: (pluginId) => ({
      operationId: `operation-${pluginId}`,
      coalesced: false,
      promise: new Promise((resolve) => {
        if (pluginId === "old") releaseOld = resolve;
        else releaseNew = resolve;
      }),
    }),
  });

  const old = await manager.create(["old"]);
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (manager.get(old.batch.batchId)?.items[0]?.operationId) break;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }

  // Model a new create taking ownership while the old execution is still settling.
  manager.activeBatchId = undefined;
  const newer = await manager.create(["new"]);
  assert.notEqual(newer.batch.batchId, old.batch.batchId);
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (manager.get(newer.batch.batchId)?.items[0]?.operationId) break;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }

  releaseOld({ ok: true });
  await waitForManagerBatch(manager, old.batch.batchId);
  assert.equal(manager.active()?.batchId, newer.batch.batchId);

  releaseNew({ ok: true });
  await waitForManagerBatch(manager, newer.batch.batchId);
});

test("BatchManager follows coalesced work, caps history, and marks a restarted batch interrupted", async () => {
  let release;
  const slow = new Promise((resolve) => { release = resolve; });
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "infolens-batch-lifecycle-"));
  const statePath = path.join(temporaryRoot, "batches.json");
  let manager;
  let historyManager;
  try {
    manager = new BatchManager({
      getTarget: (pluginId) => target(pluginId),
      enqueueTarget: (pluginId) => ({
        operationId: `operation-${pluginId}`,
        coalesced: pluginId === "coalesced",
        promise: pluginId === "slow" ? slow : pluginId === "coalesced" ? Promise.resolve({ ok: true }) : Promise.resolve({ ok: true }),
      }),
      statePath,
      sessionId: "application-session-1",
    });

    const coalesced = await manager.create(["coalesced"]);
    const coalescedResult = await waitForManagerBatch(manager, coalesced.batch.batchId);
    assert.equal(coalescedResult.status, "succeeded");
    assert.equal(coalescedResult.items[0].coalesced, true);
    assert.equal(coalescedResult.items[0].operationId, "operation-coalesced");

    const active = await manager.create(["slow", "done"]);
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const current = manager.get(active.batch.batchId);
      if (current?.items.find(({ pluginId }) => pluginId === "slow")?.operationId === "operation-slow" && current.items.find(({ pluginId }) => pluginId === "done")?.state === "succeeded") break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    await manager.flush();

    const restartEvents = [];
    const restarted = new BatchManager({
      getTarget: (pluginId) => target(pluginId),
      enqueueTarget: () => ({ operationId: "unused", coalesced: false, promise: Promise.resolve({ ok: true }) }),
      statePath,
      sessionId: "application-session-1",
      onEvent: (event, details) => restartEvents.push({ event, ...details }),
    });
    await restarted.load();
    const recovered = restarted.get(active.batch.batchId);
    assert.equal(recovered.status, "interrupted");
    assert.equal(recovered.items.find(({ pluginId }) => pluginId === "done").state, "succeeded");
    const interrupted = recovered.items.find(({ pluginId }) => pluginId === "slow");
    assert.equal(interrupted.state, "interrupted");
    assert.equal(interrupted.outcome.code, "RUNTIME_RESTARTED");
    assert.deepEqual(restartEvents.filter(({ event }) => event === "target-interrupted").map(({ pluginId, code }) => ({ pluginId, code })), [
      { pluginId: "slow", code: "RUNTIME_RESTARTED" },
    ]);
    assert.equal(restarted.active(), undefined);

    release({ ok: true });
    await manager.flush();
    await waitForManagerBatch(manager, active.batch.batchId);

    historyManager = new BatchManager({
      getTarget: (pluginId) => target(pluginId, { eligible: false, reason: "disabled" }),
      enqueueTarget: () => { throw new Error("should not enqueue skipped targets"); },
    });
    for (let index = 0; index < 6; index += 1) {
      const created = await historyManager.create([`history-${index}`]);
      await waitForManagerBatch(historyManager, created.batch.batchId);
    }
    assert.equal(historyManager.list().length, 5);
    assert.deepEqual(historyManager.list().map(({ items }) => items[0].pluginId), ["history-5", "history-4", "history-3", "history-2", "history-1"]);
    await historyManager.interruptActive();
    await assert.rejects(historyManager.create(["after-stop"]), (error) => error.code === "RUNTIME_STOPPING");
  } finally {
    await manager?.flush?.();
    await historyManager?.flush?.();
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("BatchManager emits target interruption events for cancellation errors and application exit", async () => {
  const cancelledEvents = [];
  const cancelled = new BatchManager({
    getTarget: (pluginId) => target(pluginId),
    enqueueTarget: () => ({
      operationId: "operation-cancelled",
      coalesced: false,
      promise: Promise.reject(Object.assign(new Error("refresh stopped"), { code: "TASK_CANCELLED", outcome: "uncertain" })),
    }),
    onEvent: (event, details) => cancelledEvents.push({ event, ...details }),
  });
  const cancelledBatch = await cancelled.create(["cancelled"]);
  const cancelledResult = await waitForManagerBatch(cancelled, cancelledBatch.batch.batchId);
  assert.equal(cancelledResult.items[0].state, "interrupted");
  assert.deepEqual(cancelledEvents.filter(({ event }) => event === "target-interrupted").map(({ pluginId, operationId, code }) => ({ pluginId, operationId, code })), [
    { pluginId: "cancelled", operationId: "operation-cancelled", code: "TASK_CANCELLED" },
  ]);

  let release;
  const exitEvents = [];
  const exiting = new BatchManager({
    getTarget: (pluginId) => target(pluginId),
    enqueueTarget: () => ({
      operationId: "operation-exit",
      coalesced: false,
      promise: new Promise((resolve) => { release = resolve; }),
    }),
    onEvent: (event, details) => exitEvents.push({ event, ...details }),
  });
  const exitBatch = await exiting.create(["exit-target"]);
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (exiting.get(exitBatch.batch.batchId)?.items[0]?.operationId) break;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  await exiting.interruptActive("APPLICATION_EXIT");
  assert.deepEqual(exitEvents.filter(({ event }) => event === "target-interrupted").map(({ pluginId, operationId, code }) => ({ pluginId, operationId, code })), [
    { pluginId: "exit-target", operationId: "operation-exit", code: "APPLICATION_EXIT" },
  ]);
  release({ ok: true });
  await waitForManagerBatch(exiting, exitBatch.batch.batchId);
});

test("Runtime exposes fixed multi-Workspace Batches and canonical failure recovery", async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "infolens-batch-contract-"));
  const stateFile = path.join(temporaryRoot, "opencli-state.json");
  await writeFile(stateFile, JSON.stringify({ hn: "success", producthunt: "success", delayMs: 20 }));
  let runtime;
  try {
    runtime = await startRuntime(path.join(temporaryRoot, "data"), stateFile);
    const origin = runtime.message.origin;
    const targets = await request(origin, "/runtime/batches/targets");
    assert.equal(targets.response.status, 200);
    assert.deepEqual(targets.body.targets.map(({ pluginId }) => pluginId), ["github-trending", "hn", "juejin", "product-hunt", "zhihu-hot"]);
    const githubTarget = targets.body.targets.find(({ pluginId }) => pluginId === "github-trending");
    assert.deepEqual(githubTarget.refreshOptions.values, { period: "daily", language: "all" });
    assert.deepEqual(githubTarget.refreshOptions.fields.map(({ key, type }) => ({ key, type })), [
      { key: "period", type: "select" },
      { key: "language", type: "select" },
    ]);

    const created = await request(origin, "/runtime/batches", { method: "POST", body: JSON.stringify({ pluginIds: ["hn", "juejin", "product-hunt"] }) });
    assert.equal(created.response.status, 202);
    assert.equal(created.body.batchId, created.body.batch.batchId);
    const activeReuse = await request(origin, "/runtime/batches", { method: "POST", body: JSON.stringify({ pluginIds: ["hn"] }) });
    assert.equal(activeReuse.body.reused, true);
    assert.equal(activeReuse.body.batchId, created.body.batchId);
    const finished = await waitForBatch(origin, created.body.batchId);
    assert.equal(finished.status, "succeeded");
    assert.equal(finished.counts.succeeded, 3);
    assert(finished.items.every(({ operationId }) => operationId));

    const parameterized = await request(origin, "/runtime/batches", { method: "POST", body: JSON.stringify({ targets: [{ pluginId: "github-trending", refreshInput: { period: "weekly", language: "Rust" } }] }) });
    const parameterizedFinished = await waitForBatch(origin, parameterized.body.batchId);
    assert.equal(parameterizedFinished.status, "succeeded");
    assert.deepEqual(parameterizedFinished.items[0].refreshInput, { period: "weekly", language: "Rust" });
    const calls = (await readFile(`${stateFile}.calls`, "utf8")).trim().split(/\r?\n/).map(JSON.parse);
    const githubCall = calls.find((call) => call.type === "start" && call.command === "github-trending repos" && call.args.includes("--since=weekly"));
    assert(githubCall);
    assert(githubCall.args.includes("--language=rust"));

    await writeFile(stateFile, JSON.stringify({ producthunt: "malformed" }));
    const failedRefresh = await request(origin, "/plugins/product-hunt/api/refresh", { method: "POST" });
    assert.equal(failedRefresh.body.ok, false);
    const failedInfo = await request(origin, "/runtime/info");
    const failedPlugin = failedInfo.body.plugins.find(({ id }) => id === "product-hunt");
    assert.equal(failedPlugin.statusSnapshot.failure.code, "REFRESH_FAILED");
    const retainedSuccess = failedPlugin.statusSnapshot.lastSuccessfulRefreshAt;
    assert(retainedSuccess);
    assert(!JSON.stringify(failedInfo.body).includes("malformed"));

    await writeFile(stateFile, JSON.stringify({ producthunt: "success" }));
    await request(origin, "/plugins/product-hunt/api/refresh", { method: "POST" });
    const recoveredInfo = await request(origin, "/runtime/info");
    const recovered = recoveredInfo.body.plugins.find(({ id }) => id === "product-hunt").statusSnapshot;
    assert.equal(recovered.failure, undefined);
    assert.notEqual(recovered.lastSuccessfulRefreshAt, retainedSuccess);
  } finally {
    await stopRuntime(runtime?.child);
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("Runtime batches use shared resource permits and recover interrupted work after restart", async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "infolens-batch-restart-"));
  const stateFile = path.join(temporaryRoot, "opencli-state.json");
  const batchStatePath = path.join(temporaryRoot, "batches.json");
  const sessionId = "application-session-contract";
  let runtime;
  try {
    await writeFile(stateFile, JSON.stringify({ producthunt: "success", delayMs: 250 }));
    runtime = await startRuntime(path.join(temporaryRoot, "data"), stateFile, { INFOLENS_BATCH_STATE_PATH: batchStatePath, INFOLENS_APPLICATION_SESSION_ID: sessionId });
    const created = await request(runtime.message.origin, "/runtime/batches", { method: "POST", body: JSON.stringify({ pluginIds: ["hn", "github-trending", "juejin", "product-hunt", "zhihu-hot"] }) });
    const finished = await waitForBatch(runtime.message.origin, created.body.batchId);
    assert.equal(finished.status, "succeeded");
    const calls = (await readFile(`${stateFile}.calls`, "utf8")).trim().split(/\r?\n/).map(JSON.parse);
    const browserCommands = new Set(["zhihu whoami", "zhihu hot", "infolens-producthunt today"]);
    let browserActive = 0;
    let browserPeak = 0;
    let publicActive = 0;
    let publicPeak = 0;
    for (const call of calls) {
      const browser = browserCommands.has(call.command);
      if (browser) browserActive += call.type === "start" ? 1 : -1;
      else if (call.type === "start") publicActive += 1;
      else publicActive -= 1;
      browserPeak = Math.max(browserPeak, browserActive);
      publicPeak = Math.max(publicPeak, publicActive);
    }
    assert.equal(browserPeak, 1);
    assert.equal(publicPeak, 3);

    await writeFile(stateFile, JSON.stringify({ producthunt: "success", delayMs: 5_000 }));
    const active = await request(runtime.message.origin, "/runtime/batches", { method: "POST", body: JSON.stringify({ pluginIds: ["hn", "product-hunt"] }) });
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const current = await request(runtime.message.origin, `/runtime/batches/${active.body.batchId}`);
      if (current.body.items.some(({ state }) => state === "running")) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try {
        const persisted = JSON.parse(await readFile(batchStatePath, "utf8"));
        if (persisted.batches?.some(({ batchId, status }) => batchId === active.body.batchId && status === "running")) break;
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const oldChild = runtime.child;
    await new Promise((resolve) => {
      oldChild.once("exit", resolve);
      oldChild.kill();
    });
    runtime = await startRuntime(path.join(temporaryRoot, "data"), stateFile, { INFOLENS_BATCH_STATE_PATH: batchStatePath, INFOLENS_APPLICATION_SESSION_ID: sessionId });
    const recovered = await request(runtime.message.origin, `/runtime/batches/${active.body.batchId}`);
    assert.equal(recovered.body.status, "interrupted");
    assert(recovered.body.items.every(({ state }) => ["succeeded", "failed", "skipped", "interrupted"].includes(state)));
    assert(recovered.body.items.some(({ state }) => state === "interrupted"));
  } finally {
    await stopRuntime(runtime?.child);
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("Runtime canonicalizes cancelled refresh outcomes in the Batch log", async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "infolens-batch-cancel-"));
  const stateFile = path.join(temporaryRoot, "opencli-state.json");
  const dataRoot = path.join(temporaryRoot, "data");
  let runtime;
  try {
    await writeFile(stateFile, JSON.stringify({ producthunt: "success", delayMs: 5_000 }));
    runtime = await startRuntime(dataRoot, stateFile);
    const created = await request(runtime.message.origin, "/runtime/batches", { method: "POST", body: JSON.stringify({ pluginIds: ["product-hunt"] }) });
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const current = await request(runtime.message.origin, `/runtime/batches/${created.body.batchId}`);
      if (current.body.items.some(({ state }) => state === "running")) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await stopRuntime(runtime.child);
    runtime = undefined;
    const entries = (await readFile(path.join(dataRoot, "product-hunt", "logs", "plugin.log"), "utf8"))
      .trim().split(/\r?\n/).filter(Boolean).map(JSON.parse);
    const cancelled = entries.find((entry) => entry.message.startsWith("task-cancelled") && entry.batchId === created.body.batchId);
    assert(cancelled, "expected a task-cancelled Runtime log entry for the Batch target");
    assert.match(cancelled.message, /\"outcome\":\"cancelled\"/);
    assert.equal(cancelled.code, "TASK_CANCELLED");
  } finally {
    await stopRuntime(runtime?.child);
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("Runtime Batch lifecycle logs are queryable by the real Batch ID", async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "infolens-batch-log-integration-"));
  const stateFile = path.join(temporaryRoot, "opencli-state.json");
  const dataRoot = path.join(temporaryRoot, "data");
  let runtime;
  try {
    await writeFile(stateFile, JSON.stringify({ hn: "success" }));
    runtime = await startRuntime(dataRoot, stateFile);
    const created = await request(runtime.message.origin, "/runtime/batches", { method: "POST", body: JSON.stringify({ pluginIds: ["hn"] }) });
    const finished = await waitForBatch(runtime.message.origin, created.body.batchId);
    assert.equal(finished.status, "succeeded");
    const logService = createLogService({ root: path.join(temporaryRoot, "host-logs"), sessionId: "host-session" });
    const sources = [{ source: "runtime", filePath: path.join(dataRoot, "_runtime", "logs", "runtime.log") }];
    let page;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      page = await logService.query({ sources, filters: { batchId: created.body.batchId } });
      const events = new Set(page.entries.map(({ message }) => message.split(" ", 1)[0]));
      if (events.has("batch-started") && events.has("batch-target-completed") && events.has("batch-completed")) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const events = new Set(page.entries.map(({ message }) => message.split(" ", 1)[0]));
    assert(events.has("batch-started"));
    assert(events.has("batch-submitted"));
    assert(events.has("batch-target-completed"));
    assert(events.has("batch-completed"));
    assert(page.entries.every(({ batchId }) => batchId === created.body.batchId));
  } finally {
    await stopRuntime(runtime?.child);
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("Runtime retains a successful refresh timestamp when a restarted Plugin omits it from health", async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "infolens-refresh-timestamp-restart-"));
  const pluginsRoot = path.join(temporaryRoot, "plugins");
  const dataRoot = path.join(temporaryRoot, "data");
  const hostStatePath = path.join(temporaryRoot, "host-state.json");
  const batchStatePath = path.join(temporaryRoot, "batches.json");
  const stateFile = path.join(temporaryRoot, "opencli-state.json");
  const pluginRoot = path.join(pluginsRoot, "stateless-health");
  await mkdir(path.join(pluginRoot, "backend"), { recursive: true });
  await mkdir(path.join(pluginRoot, "web"), { recursive: true });
  await writeFile(path.join(pluginRoot, "manifest.json"), JSON.stringify({
    id: "stateless-health", name: "Stateless Health", version: "1.0.0", contractVersion: "2", minHostVersion: "0.1.0",
    backend: { entry: "backend/index.mjs" }, ui: { entry: "web/index.html" }, openCliAdapters: {}, openCliCommands: {},
  }), "utf8");
  await writeFile(path.join(pluginRoot, "web", "index.html"), "<!doctype html><title>Stateless Health</title>", "utf8");
  await writeFile(path.join(pluginRoot, "backend", "index.mjs"), `
export function activate(context) {
  context.task("refresh", async () => ({ ok: true }));
  context.setHealth({ state: "ready" });
}
`, "utf8");
  let runtime;
  const environment = {
    INFOLENS_PLUGINS_ROOT: pluginsRoot,
    INFOLENS_HOST_STATE_PATH: hostStatePath,
    INFOLENS_BATCH_STATE_PATH: batchStatePath,
    INFOLENS_APPLICATION_SESSION_ID: "timestamp-session",
  };
  try {
    await writeFile(stateFile, "{}", "utf8");
    runtime = await startRuntime(dataRoot, stateFile, environment);
    const created = await request(runtime.message.origin, "/runtime/batches", { method: "POST", body: JSON.stringify({ pluginIds: ["stateless-health"] }) });
    await waitForBatch(runtime.message.origin, created.body.batchId);
    const firstInfo = await request(runtime.message.origin, "/runtime/info");
    const firstTimestamp = firstInfo.body.hostState.statusSnapshots["stateless-health"].lastSuccessfulRefreshAt;
    assert(firstTimestamp);
    await stopRuntime(runtime.child);
    runtime = await startRuntime(dataRoot, stateFile, environment);
    let restartedInfo;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      restartedInfo = await request(runtime.message.origin, "/runtime/info");
      if (restartedInfo.body.hostState.statusSnapshots["stateless-health"]?.state === "ready") break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(restartedInfo.body.hostState.statusSnapshots["stateless-health"].lastSuccessfulRefreshAt, firstTimestamp);
  } finally {
    await stopRuntime(runtime?.child);
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
