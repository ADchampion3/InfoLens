import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  Scheduler,
  SchedulerStore,
  localDateTimeToInstant,
  nextOccurrence,
  normalizeScheduleInput,
} from "../packages/plugin-runtime/src/scheduler.mjs";

async function withTempScheduler(callback) {
  const root = await mkdtemp(path.join(os.tmpdir(), "infolens-scheduler-"));
  try {
    return await callback(path.join(root, "scheduler.sqlite"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("schedule validation keeps refresh intervals bounded and digest recipients explicit", () => {
  assert.deepEqual(normalizeScheduleInput({
    kind: "refresh",
    pluginId: "hn",
    spec: { type: "interval", intervalMinutes: 15 },
    timeZone: "Asia/Shanghai",
  }), {
    kind: "refresh",
    pluginId: "hn",
    spec: { type: "interval", intervalMinutes: 15 },
    timeZone: "Asia/Shanghai",
  });
  assert.throws(() => normalizeScheduleInput({
    kind: "refresh",
    pluginId: "hn",
    spec: { type: "interval", intervalMinutes: 1 },
    timeZone: "Asia/Shanghai",
  }), /between 5 and 10080/);
  assert.throws(() => normalizeScheduleInput({
    kind: "daily_digest",
    pluginIds: ["hn"],
    spec: { type: "daily", time: "08:30" },
    timeZone: "Asia/Shanghai",
  }), /recipients/);
});

test("wall-clock scheduling handles DST gaps and repeated times once", () => {
  const gap = localDateTimeToInstant("2026-03-08", "02:30", "America/New_York");
  assert.equal(new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(gap), "03:00");
  const repeated = localDateTimeToInstant("2026-11-01", "01:30", "America/New_York");
  assert.equal(repeated.toISOString(), "2026-11-01T05:30:00.000Z");
  const next = nextOccurrence({
    spec: { type: "daily", time: "01:30" },
    timeZone: "America/New_York",
  }, new Date("2026-11-01T05:31:00.000Z"));
  assert.equal(next.toISOString(), "2026-11-02T06:30:00.000Z");
});

test("scheduler persists schedules, anchors intervals, and detects version conflicts", async () => {
  await withTempScheduler(async (filename) => {
    let now = new Date("2026-08-27T00:00:00.000Z");
    const calls = [];
    const scheduler = new Scheduler({
      filename,
      now: () => now,
      resolvePlugin: async () => ({ installed: true, enabled: true, active: true }),
      executeRefresh: async ({ schedule, periodKey }) => {
        calls.push({ scheduleId: schedule.scheduleId, periodKey });
        return { ok: true };
      },
      retry: { maxAttempts: 1 },
    });
    await scheduler.load();
    const schedule = scheduler.create({
      kind: "refresh",
      pluginId: "hn",
      spec: { type: "interval", intervalMinutes: 5 },
      timeZone: "UTC",
    });
    assert.equal(schedule.nextRunAt, "2026-08-27T00:05:00.000Z");
    assert.throws(() => scheduler.create({
      kind: "refresh",
      pluginId: "hn",
      spec: { type: "interval", intervalMinutes: 30 },
      timeZone: "UTC",
    }), (error) => error.code === "REFRESH_SCHEDULE_EXISTS");
    now = new Date("2026-08-27T00:16:00.000Z");
    await scheduler.tick();
    assert.equal(calls.length, 1);
    assert.equal(scheduler.get(schedule.scheduleId).nextRunAt, "2026-08-27T00:20:00.000Z");
    assert.throws(() => scheduler.update(schedule.scheduleId, { name: "changed" }, { expectedVersion: 0 }), /invalid|changed/);
    const updated = scheduler.update(schedule.scheduleId, { name: "changed" }, { expectedVersion: 1, now });
    assert.equal(updated.version, 2);
    await scheduler.stop();

    const reopened = new SchedulerStore(filename);
    assert.equal(reopened.listSchedules()[0].name, "changed");
    reopened.close();
  });
});

test("daily digest period keys are idempotent and catch-up advances to the next occurrence", async () => {
  await withTempScheduler(async (filename) => {
    let now = new Date("2026-08-27T00:00:00.000Z");
    const calls = [];
    const scheduler = new Scheduler({
      filename,
      now: () => now,
      resolvePlugin: async () => ({ installed: true, enabled: true, active: true }),
      executeDigest: async ({ periodKey }) => {
        calls.push(periodKey);
        return { ok: true };
      },
      retry: { maxAttempts: 1 },
    });
    await scheduler.load();
    const schedule = scheduler.create({
      kind: "daily_digest",
      pluginIds: ["hn", "juejin"],
      recipients: ["reader@example.com"],
      spec: { type: "daily", time: "10:00" },
      timeZone: "Asia/Shanghai",
    });
    now = new Date("2026-08-27T02:00:01.000Z");
    await scheduler.tick();
    assert.deepEqual(calls, ["2026-08-26"]);
    assert.equal(scheduler.get(schedule.scheduleId).nextRunAt, "2026-08-28T02:00:00.000Z");
    await scheduler.tick();
    assert.deepEqual(calls, ["2026-08-26"]);
    const runs = scheduler.listRuns(schedule.scheduleId);
    assert.equal(runs.length, 1);
    assert.equal(runs[0].periodKey, "2026-08-26");
    await scheduler.stop();
  });
});

test("schedule updates can change task kind without retaining the opposite plugin shape", async () => {
  await withTempScheduler(async (filename) => {
    const scheduler = new Scheduler({ filename });
    await scheduler.load();
    const refresh = scheduler.create({
      kind: "refresh",
      pluginId: "hn",
      spec: { type: "interval", intervalMinutes: 15 },
      timeZone: "UTC",
    }, { now: new Date("2026-08-27T00:00:00.000Z") });
    const digest = scheduler.update(refresh.scheduleId, {
      kind: "daily_digest",
      pluginIds: ["hn"],
      recipients: ["reader@example.com"],
      spec: { type: "daily", time: "08:30" },
      timeZone: "UTC",
    }, { expectedVersion: refresh.version, now: new Date("2026-08-27T00:00:00.000Z") });
    assert.equal(digest.kind, "daily_digest");
    assert.equal(digest.pluginId, undefined);
    assert.deepEqual(digest.pluginIds, ["hn"]);
    await scheduler.stop();
  });
});

test("restart recovery marks unfinished runs interrupted and uncertain delivery unknown", async () => {
  await withTempScheduler(async (filename) => {
    const store = new SchedulerStore(filename);
    const schedule = store.createSchedule(normalizeScheduleInput({
      kind: "daily_digest",
      pluginIds: ["hn"],
      recipients: ["reader@example.com"],
      spec: { type: "daily", time: "10:00" },
      timeZone: "UTC",
    }), { now: new Date("2026-08-27T00:00:00.000Z") });
    const { run } = store.createRun(schedule, { periodKey: "2026-08-26" });
    store.markRunStarted(run.runId);
    const delivery = store.createDelivery({
      runId: run.runId,
      scheduleId: schedule.scheduleId,
      periodKey: "2026-08-26",
      recipients: ["reader@example.com"],
      subject: "subject",
      textBody: "text",
      htmlBody: "<p>text</p>",
      configVersion: 1,
    });
    store.updateDelivery(delivery.deliveryId, { state: "sending", attempts: 1 });
    const audit = store.createMailTestAudit({ configVersion: 1, recipients: ["reader@example.com"] });
    assert.deepEqual(audit.recipients, ["r***@example.com"]);
    store.close();

    const reopened = new SchedulerStore(filename);
    reopened.recoverAfterRestart(new Date("2026-08-27T01:00:00.000Z"));
    assert.equal(reopened.getRun(run.runId).state, "interrupted");
    assert.equal(reopened.getDelivery(delivery.deliveryId).state, "unknown");
    reopened.close();
  });
});
