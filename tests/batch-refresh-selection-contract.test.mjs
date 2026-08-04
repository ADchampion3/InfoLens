import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import ts from "typescript";

const root = path.resolve(import.meta.dirname, "..");

async function loadHelpers() {
  const source = await readFile(path.join(root, "apps/desktop/src/batch-refresh.ts"), "utf8");
  const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const module = { exports: {} };
  new Function("exports", "module", output)(module.exports, module);
  return module.exports;
}

function target(pluginId, overrides = {}) {
  return {
    pluginId,
    targetId: `${pluginId}@1.0.0`,
    name: pluginId,
    version: "1.0.0",
    state: "ready",
    enabled: true,
    eligible: true,
    browserDependent: false,
    ...overrides,
  };
}

test("freshness uses the selected local timezone and treats invalid timestamps as unknown", async () => {
  const { isToday, localDayKey } = await loadHelpers();
  const now = new Date("2026-08-05T00:30:00.000Z");
  assert.equal(localDayKey("2026-08-04T23:30:00.000Z", "Asia/Shanghai"), "2026-08-05");
  assert.equal(localDayKey("2026-08-04T23:30:00.000Z", "America/Los_Angeles"), "2026-08-04");
  assert.equal(isToday("2026-08-04T23:30:00.000Z", now, "Asia/Shanghai"), true);
  assert.equal(isToday("not-a-timestamp", now, "Asia/Shanghai"), false);
  assert.equal(localDayKey("2026-02-30T12:00:00.000Z", "Asia/Shanghai"), undefined);
});

test("selection helpers include retryable failures and unknown dependencies but exclude unavailable workspaces", async () => {
  const { selectAllEligible, selectNotRefreshedToday, selectionEmptyState } = await loadHelpers();
  const now = new Date("2026-08-04T12:00:00.000Z");
  const targets = [
    target("never"),
    target("old", { lastSuccessfulRefreshAt: "2026-08-03T12:00:00.000Z" }),
    target("today", { lastSuccessfulRefreshAt: "2026-08-04T11:00:00.000Z" }),
    target("failed-today", { failure: { code: "SOURCE_DOWN", message: "temporary", timestamp: "2026-08-04T11:30:00.000Z" } }),
    target("disabled", { enabled: false }),
    target("queued", { state: "queued", eligible: false, reason: "busy" }),
    target("unavailable", { state: "unavailable", eligible: false, reason: "offline" }),
    target("unknown-browser", { browserDependent: true, dependencyState: "unknown", dependencyWarning: true }),
    target("failed-plugin", { state: "failed", failure: { code: "PLUGIN_ERROR", message: "retryable" } }),
  ];
  assert.deepEqual([...selectAllEligible(targets)].sort(), ["failed-plugin", "failed-today", "never", "old", "today", "unknown-browser"]);
  assert.deepEqual([...selectNotRefreshedToday(targets, now, "Asia/Shanghai")].sort(), ["failed-plugin", "failed-today", "never", "old", "unknown-browser"]);
  assert.equal(selectionEmptyState([target("today", { lastSuccessfulRefreshAt: "2026-08-04T11:00:00.000Z" })], now, "Asia/Shanghai"), "All executable Workspaces refreshed today");
  assert.equal(selectionEmptyState([target("disabled", { enabled: false })], now, "Asia/Shanghai"), "Nothing is currently executable");
});

test("completion notices are session-level, actionable, and emitted once per observed Batch", async () => {
  const { batchCompletionNotice } = await loadHelpers();
  const observed = new Set(["batch-1"]);
  const notified = new Set();
  const completed = {
    batchId: "batch-1",
    status: "succeeded",
    counts: { succeeded: 2, failed: 0, skipped: 0, interrupted: 0 },
  };

  assert.deepEqual(batchCompletionNotice(completed, observed, notified), {
    batchId: "batch-1",
    actionLabel: "View results",
    message: "Batch refresh completed: 2 succeeded, 0 failed, 0 skipped, 0 interrupted",
  });
  assert.equal(batchCompletionNotice(completed, observed, notified), undefined);
  assert.equal(batchCompletionNotice({ ...completed, batchId: "unobserved" }, observed, notified), undefined);

  const appSource = await readFile(path.join(root, "apps/desktop/src/App.tsx"), "utf8");
  assert.match(appSource, /batchCompletionNotice/);
  assert.match(appSource, /View results/);
});
