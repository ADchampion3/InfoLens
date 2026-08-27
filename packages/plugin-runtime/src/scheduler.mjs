import { DatabaseSync } from "node:sqlite";
import { chmodSync, mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";

export const SCHEDULER_SCHEMA_VERSION = 1;
export const SCHEDULE_STATES = Object.freeze(["enabled", "paused", "orphaned"]);
export const SCHEDULE_RUN_STATES = Object.freeze(["queued", "running", "succeeded", "failed", "canceled", "interrupted", "skipped"]);
export const DELIVERY_STATES = Object.freeze(["not-sent", "sending", "sent", "failed", "unknown"]);
export const SCHEDULER_RETRY = Object.freeze({ maxAttempts: 3, backoffMs: 1_000, maxBackoffMs: 30_000, backoffMultiplier: 2 });

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/u;
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/u;
const TIME_ZONE_FORMATTERS = new Map();

function schedulerError(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  Object.assign(error, details);
  return error;
}

function iso(value, field = "timestamp") {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.valueOf())) throw schedulerError("INVALID_SCHEDULE", field + " is invalid");
  return date.toISOString();
}

function parseJson(value, fallback) {
  try {
    const parsed = JSON.parse(String(value));
    return parsed && typeof parsed === "object" ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function uniqueStrings(values, field, { max = 50 } = {}) {
  if (!Array.isArray(values) || values.length === 0 || values.length > max) {
    throw schedulerError("INVALID_SCHEDULE", field + " must contain between 1 and " + max + " values");
  }
  const normalized = [...new Set(values.map((value) => typeof value === "string" ? value.trim() : ""))];
  if (normalized.some((value) => !value || value.length > 200)) {
    throw schedulerError("INVALID_SCHEDULE", field + " contains an invalid value");
  }
  return normalized;
}

function redactRecipient(value) {
  const [local = "", ...domainParts] = String(value).split("@");
  if (!domainParts.length) return "***";
  return (local.slice(0, 1) || "") + "***@" + domainParts.join("@");
}

function assertLocalDate(value) {
  if (typeof value !== "string" || !DATE_RE.test(value)) throw schedulerError("INVALID_SCHEDULE", "localDate must use YYYY-MM-DD");
  const date = new Date(value + "T00:00:00.000Z");
  if (!Number.isFinite(date.valueOf()) || date.toISOString().slice(0, 10) !== value) throw schedulerError("INVALID_SCHEDULE", "localDate is invalid");
  return value;
}

function assertTime(value) {
  if (typeof value !== "string" || !TIME_RE.test(value)) throw schedulerError("INVALID_SCHEDULE", "time must use HH:MM");
  return value;
}

export function assertTimeZone(value) {
  if (typeof value !== "string" || !value.trim() || value.length > 120) {
    throw schedulerError("INVALID_TIME_ZONE", "An IANA time zone is required");
  }
  const timeZone = value.trim();
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format();
  } catch {
    throw schedulerError("INVALID_TIME_ZONE", "Unknown IANA time zone '" + timeZone + "'");
  }
  return timeZone;
}

export function defaultTimeZone() {
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  if (!timeZone) throw schedulerError("TIME_ZONE_UNAVAILABLE", "The operating system time zone could not be resolved");
  return assertTimeZone(timeZone);
}

function formatter(timeZone) {
  const key = assertTimeZone(timeZone);
  if (!TIME_ZONE_FORMATTERS.has(key)) {
    TIME_ZONE_FORMATTERS.set(key, new Intl.DateTimeFormat("en-US", {
      timeZone: key,
      calendar: "gregory",
      numberingSystem: "latn",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      weekday: "short",
      hourCycle: "h23",
    }));
  }
  return TIME_ZONE_FORMATTERS.get(key);
}

function localParts(value, timeZone) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.valueOf())) throw schedulerError("INVALID_SCHEDULE", "Date is invalid");
  const values = Object.fromEntries(formatter(timeZone).formatToParts(date)
    .filter(({ type }) => type !== "literal")
    .map(({ type, value }) => [type, value]));
  return {
    year: Number(values.year),
    month: Number(values.month),
    day: Number(values.day),
    hour: Number(values.hour),
    minute: Number(values.minute),
    second: Number(values.second),
    weekday: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(values.weekday),
  };
}

export function localDateKey(value, timeZone) {
  const parts = localParts(value, timeZone);
  return String(parts.year).padStart(4, "0") + "-" + String(parts.month).padStart(2, "0") + "-" + String(parts.day).padStart(2, "0");
}

function wallMilliseconds(parts) {
  return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second, 0);
}

function sameWallTime(parts, expected) {
  return parts.year === expected.year
    && parts.month === expected.month
    && parts.day === expected.day
    && parts.hour === expected.hour
    && parts.minute === expected.minute
    && parts.second === expected.second;
}

function offsetAt(instant, timeZone) {
  return wallMilliseconds(localParts(instant, timeZone)) - instant.valueOf();
}

function wallPartsFromMilliseconds(value) {
  const date = new Date(value);
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
    hour: date.getUTCHours(),
    minute: date.getUTCMinutes(),
    second: date.getUTCSeconds(),
    weekday: date.getUTCDay(),
  };
}

function wallCandidates(parts, timeZone) {
  const base = wallMilliseconds(parts);
  const offsets = new Set();
  for (let delta = -36 * 60 * 60 * 1000; delta <= 36 * 60 * 60 * 1000; delta += 30 * 60 * 1000) {
    offsets.add(offsetAt(new Date(base + delta), timeZone));
  }
  const candidates = [];
  for (const offset of offsets) {
    const candidate = new Date(base - offset);
    if (sameWallTime(localParts(candidate, timeZone), parts) && !candidates.some((value) => value.valueOf() === candidate.valueOf())) {
      candidates.push(candidate);
    }
  }
  return candidates.sort((left, right) => left.valueOf() - right.valueOf());
}

export function localDateTimeToInstant(localDate, time, timeZone) {
  assertLocalDate(localDate);
  assertTime(time);
  const [hour, minute] = time.split(":").map(Number);
  const date = new Date(localDate + "T00:00:00.000Z");
  const base = wallPartsFromMilliseconds(date.valueOf());
  base.hour = hour;
  base.minute = minute;
  base.second = 0;
  for (let delta = 0; delta <= 24 * 60; delta += 1) {
    const candidateParts = wallPartsFromMilliseconds(wallMilliseconds(base) + delta * 60 * 1000);
    const candidates = wallCandidates(candidateParts, timeZone);
    if (candidates.length) return candidates[0];
  }
  throw schedulerError("INVALID_SCHEDULE", "Local time " + localDate + " " + time + " cannot be resolved in " + timeZone);
}

function addLocalDays(localDate, days) {
  const date = new Date(assertLocalDate(localDate) + "T00:00:00.000Z");
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function localWeekday(localDate) {
  return new Date(assertLocalDate(localDate) + "T00:00:00.000Z").getUTCDay();
}

function normalizeSpec(input, kind) {
  const raw = input.spec && typeof input.spec === "object" ? input.spec : input;
  const type = raw.type ?? raw.cadence ?? raw.scheduleType;
  if (kind === "refresh" && type !== "interval") {
    throw schedulerError("INVALID_SCHEDULE", "Refresh schedules must use a fixed interval");
  }
  if (kind === "daily_digest" && !["daily", "weekly"].includes(type)) {
    throw schedulerError("INVALID_SCHEDULE", "Daily digest schedules must use daily or weekly wall-clock time");
  }
  if (type === "interval") {
    const intervalMinutes = Number(raw.intervalMinutes ?? (Number(raw.intervalMs) / 60_000));
    if (!Number.isInteger(intervalMinutes) || intervalMinutes < 5 || intervalMinutes > 7 * 24 * 60) {
      throw schedulerError("INVALID_SCHEDULE", "intervalMinutes must be between 5 and 10080");
    }
    return { type, intervalMinutes };
  }
  if (type === "daily") return { type, time: assertTime(raw.time) };
  if (type === "weekly") {
    const weekdays = [...new Set((Array.isArray(raw.weekdays) ? raw.weekdays : []).map(Number))].sort((left, right) => left - right);
    if (!weekdays.length || weekdays.some((day) => !Number.isInteger(day) || day < 0 || day > 6)) {
      throw schedulerError("INVALID_SCHEDULE", "weekly weekdays must contain values from 0 (Sunday) to 6 (Saturday)");
    }
    return { type, time: assertTime(raw.time), weekdays };
  }
  throw schedulerError("INVALID_SCHEDULE", "Unsupported schedule cadence");
}

export function normalizeScheduleInput(input, { defaultZone = defaultTimeZone } = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw schedulerError("INVALID_SCHEDULE", "Schedule body must be an object");
  const kind = input.kind === "daily-digest" ? "daily_digest" : input.kind;
  if (!["refresh", "daily_digest"].includes(kind)) throw schedulerError("INVALID_SCHEDULE", "kind must be refresh or daily_digest");
  const timeZone = assertTimeZone(input.timeZone ?? defaultZone());
  const spec = normalizeSpec(input, kind);
  const pluginId = typeof input.pluginId === "string" && input.pluginId.trim() ? input.pluginId.trim() : undefined;
  const pluginIds = input.pluginIds === undefined ? undefined : uniqueStrings(input.pluginIds, "pluginIds");
  if (kind === "refresh" && (!pluginId || pluginIds)) throw schedulerError("INVALID_SCHEDULE", "Refresh schedules require one pluginId");
  if (kind === "daily_digest" && (!pluginIds?.length || pluginId)) throw schedulerError("INVALID_SCHEDULE", "Daily digest schedules require pluginIds");
  const recipients = kind === "daily_digest"
    ? uniqueStrings(input.recipients ?? input.to, "recipients", { max: 20 })
    : undefined;
  if (recipients?.some((value) => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(value))) {
    throw schedulerError("INVALID_SCHEDULE", "Each digest recipient must be an email address");
  }
  const name = input.name === undefined ? undefined : String(input.name).trim().slice(0, 120);
  if (input.name !== undefined && !name) throw schedulerError("INVALID_SCHEDULE", "name must not be empty");
  return {
    kind,
    ...(pluginId ? { pluginId } : {}),
    ...(pluginIds ? { pluginIds } : {}),
    spec,
    timeZone,
    ...(recipients ? { recipients } : {}),
    ...(name ? { name } : {}),
  };
}

function isStrictlyAfter(value, after) {
  return value.valueOf() > after.valueOf();
}

export function nextOccurrence(config, afterValue, { strict = true } = {}) {
  const after = afterValue instanceof Date ? afterValue : new Date(afterValue);
  if (!Number.isFinite(after.valueOf())) throw schedulerError("INVALID_SCHEDULE", "Schedule reference time is invalid");
  if (config.spec.type === "interval") {
    const anchor = new Date(config.anchorAt);
    const interval = config.spec.intervalMinutes * 60_000;
    const elapsed = after.valueOf() - anchor.valueOf();
    let index = Math.floor(elapsed / interval) + (strict ? 1 : 0);
    if (index < 1) index = 1;
    let candidate = new Date(anchor.valueOf() + index * interval);
    if (strict && !isStrictlyAfter(candidate, after)) candidate = new Date(candidate.valueOf() + interval);
    return candidate;
  }
  const startDate = localDateKey(after, config.timeZone);
  for (let dayOffset = 0; dayOffset <= 8; dayOffset += 1) {
    const date = addLocalDays(startDate, dayOffset);
    const weekday = localWeekday(date);
    if (config.spec.type === "weekly" && !config.spec.weekdays.includes(weekday)) continue;
    const candidate = localDateTimeToInstant(date, config.spec.time, config.timeZone);
    if (strict ? isStrictlyAfter(candidate, after) : candidate.valueOf() >= after.valueOf()) return candidate;
  }
  throw schedulerError("INVALID_SCHEDULE", "Could not find the next wall-clock occurrence");
}

function periodForDigest(dueAt, timeZone) {
  return addLocalDays(localDateKey(dueAt, timeZone), -1);
}

function configForStorage(config, anchorAt) {
  return JSON.stringify({ ...config, anchorAt });
}

function scheduleFromRow(row) {
  if (!row) return undefined;
  const config = parseJson(row.config_json, {});
  return {
    scheduleId: String(row.schedule_id),
    ...config,
    state: String(row.state),
    version: Number(row.version),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    anchorAt: String(row.anchor_at),
    nextRunAt: row.next_run_at ? String(row.next_run_at) : undefined,
    lastDueAt: row.last_due_at ? String(row.last_due_at) : undefined,
    lastRunId: row.last_run_id ? String(row.last_run_id) : undefined,
    lastPeriodKey: row.last_period_key ? String(row.last_period_key) : undefined,
    lastError: parseJson(row.last_error_json, undefined),
  };
}

function runFromRow(row) {
  if (!row) return undefined;
  const result = parseJson(row.result_json, undefined);
  const error = parseJson(row.error_json, undefined);
  return {
    runId: String(row.run_id),
    scheduleId: String(row.schedule_id),
    ...(row.period_key ? { periodKey: String(row.period_key) } : {}),
    trigger: String(row.trigger),
    state: String(row.state),
    ...(row.reason ? { reason: String(row.reason) } : {}),
    ...(row.skip_reason ? { skipReason: String(row.skip_reason) } : {}),
    scheduleVersion: Number(row.schedule_version),
    schedule: parseJson(row.config_json, {}),
    createdAt: String(row.created_at),
    ...(row.started_at ? { startedAt: String(row.started_at) } : {}),
    ...(row.completed_at ? { completedAt: String(row.completed_at) } : {}),
    attempts: Number(row.attempts ?? 0),
    ...(result !== undefined ? { result } : {}),
    ...(error !== undefined ? { error } : {}),
    ...(row.snapshot_id ? { snapshotId: String(row.snapshot_id) } : {}),
    ...(row.delivery_id ? { deliveryId: String(row.delivery_id) } : {}),
    updatedAt: String(row.updated_at),
  };
}

function deliverySummaryFromRow(row) {
  if (!row) return undefined;
  const error = parseJson(row.error_json, undefined);
  return {
    deliveryId: String(row.delivery_id),
    state: String(row.state),
    attempts: Number(row.attempts ?? 0),
    configVersion: Number(row.config_version),
    ...(row.sent_at ? { sentAt: String(row.sent_at) } : {}),
    ...(error !== undefined ? { error } : {}),
  };
}

function deliveryFromRow(row) {
  if (!row) return undefined;
  const error = parseJson(row.error_json, undefined);
  return {
    deliveryId: String(row.delivery_id),
    runId: String(row.run_id),
    scheduleId: String(row.schedule_id),
    ...(row.period_key ? { periodKey: String(row.period_key) } : {}),
    state: String(row.state),
    attempts: Number(row.attempts ?? 0),
    recipients: parseJson(row.to_json, []),
    subject: String(row.subject),
    textBody: String(row.text_body),
    htmlBody: String(row.html_body),
    configVersion: Number(row.config_version),
    ...(row.sent_at ? { sentAt: String(row.sent_at) } : {}),
    ...(error !== undefined ? { error } : {}),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

export class SchedulerStore {
  constructor(filename) {
    this.filename = filename;
    this.closed = false;
    if (filename !== ":memory:") {
      const separator = Math.max(filename.lastIndexOf("/"), filename.lastIndexOf("\\"));
      if (separator > 0) mkdirSync(filename.slice(0, separator), { recursive: true });
      this.db = new DatabaseSync(filename);
      try { chmodSync(filename, 0o600); } catch {}
    } else {
      this.db = new DatabaseSync(filename);
    }
    this.db.exec("PRAGMA foreign_keys=ON; PRAGMA journal_mode=DELETE;");
    this.db.exec("CREATE TABLE IF NOT EXISTS scheduler_meta (key TEXT PRIMARY KEY,value TEXT NOT NULL);"
      + "CREATE TABLE IF NOT EXISTS schedules (schedule_id TEXT PRIMARY KEY,config_json TEXT NOT NULL,state TEXT NOT NULL CHECK(state IN ('enabled','paused','orphaned')),version INTEGER NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,anchor_at TEXT NOT NULL,next_run_at TEXT,last_due_at TEXT,last_run_id TEXT,last_period_key TEXT,last_error_json TEXT);"
      + "CREATE TABLE IF NOT EXISTS schedule_runs (run_id TEXT PRIMARY KEY,schedule_id TEXT NOT NULL REFERENCES schedules(schedule_id) ON DELETE CASCADE,period_key TEXT,trigger TEXT NOT NULL CHECK(trigger IN ('scheduled','manual','resend')),state TEXT NOT NULL CHECK(state IN ('queued','running','succeeded','failed','canceled','interrupted','skipped')),reason TEXT,skip_reason TEXT,schedule_version INTEGER NOT NULL,config_json TEXT NOT NULL,created_at TEXT NOT NULL,started_at TEXT,completed_at TEXT,attempts INTEGER NOT NULL DEFAULT 0,result_json TEXT,error_json TEXT,snapshot_id TEXT,delivery_id TEXT,updated_at TEXT NOT NULL);"
      + "CREATE UNIQUE INDEX IF NOT EXISTS schedule_runs_period ON schedule_runs(schedule_id,period_key) WHERE period_key IS NOT NULL;"
      + "CREATE TABLE IF NOT EXISTS digest_snapshots (snapshot_id TEXT PRIMARY KEY,run_id TEXT NOT NULL UNIQUE REFERENCES schedule_runs(run_id) ON DELETE CASCADE,schedule_id TEXT NOT NULL REFERENCES schedules(schedule_id) ON DELETE CASCADE,local_date TEXT NOT NULL,time_zone TEXT NOT NULL,aggregate_json TEXT NOT NULL,markdown TEXT NOT NULL,created_at TEXT NOT NULL);"
      + "CREATE TABLE IF NOT EXISTS deliveries (delivery_id TEXT PRIMARY KEY,run_id TEXT NOT NULL UNIQUE REFERENCES schedule_runs(run_id) ON DELETE CASCADE,schedule_id TEXT NOT NULL REFERENCES schedules(schedule_id) ON DELETE CASCADE,period_key TEXT,state TEXT NOT NULL CHECK(state IN ('not-sent','sending','sent','failed','unknown')),attempts INTEGER NOT NULL DEFAULT 0,to_json TEXT NOT NULL,subject TEXT NOT NULL,text_body TEXT NOT NULL,html_body TEXT NOT NULL,config_version INTEGER NOT NULL,sent_at TEXT,error_json TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);"
      + "CREATE TABLE IF NOT EXISTS mail_test_audits (audit_id TEXT PRIMARY KEY,config_version INTEGER NOT NULL,recipients_json TEXT NOT NULL,state TEXT NOT NULL CHECK(state IN ('sending','sent','failed','unknown')),tested_at TEXT NOT NULL,error_json TEXT);"
      + "CREATE TABLE IF NOT EXISTS mail_settings (singleton INTEGER PRIMARY KEY CHECK(singleton=1),config_json TEXT NOT NULL,version INTEGER NOT NULL,updated_at TEXT NOT NULL);");
    const version = this.db.prepare("SELECT value FROM scheduler_meta WHERE key='schemaVersion'").get()?.value;
    if (!version) this.db.prepare("INSERT INTO scheduler_meta(key,value) VALUES('schemaVersion',?)").run(String(SCHEDULER_SCHEMA_VERSION));
    else if (Number(version) !== SCHEDULER_SCHEMA_VERSION) throw schedulerError("SCHEDULER_SCHEMA_UNSUPPORTED", "Scheduler database schema is unsupported");
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }

  recoverAfterRestart(now = new Date()) {
    const timestamp = iso(now);
    this.db.exec("BEGIN IMMEDIATE;");
    try {
      const interrupted = { status: "interrupted", code: "RUNTIME_RESTARTED", message: "Scheduler restarted before the run completed", timestamp };
      this.db.prepare("UPDATE schedule_runs SET state='interrupted',completed_at=?,error_json=?,updated_at=? WHERE state IN ('queued','running')").run(timestamp, JSON.stringify(interrupted), timestamp);
      const unknown = { status: "unknown", code: "RUNTIME_RESTARTED", message: "Delivery state could not be confirmed after scheduler restart", timestamp };
      this.db.prepare("UPDATE deliveries SET state='unknown',error_json=?,updated_at=? WHERE state='sending'").run(JSON.stringify(unknown), timestamp);
      this.db.exec("COMMIT;");
    } catch (error) {
      try { this.db.exec("ROLLBACK;"); } catch {}
      throw error;
    }
  }

  listSchedules() {
    return this.db.prepare("SELECT * FROM schedules ORDER BY created_at ASC,schedule_id ASC").all().map(scheduleFromRow);
  }

  getSchedule(scheduleId) {
    return scheduleFromRow(this.db.prepare("SELECT * FROM schedules WHERE schedule_id=?").get(scheduleId));
  }

  assertRefreshScheduleAvailable(config, excludeScheduleId) {
    if (config.kind !== "refresh") return;
    const existing = this.listSchedules().find((schedule) => schedule.kind === "refresh"
      && schedule.pluginId === config.pluginId
      && schedule.scheduleId !== excludeScheduleId);
    if (existing) {
      throw schedulerError("REFRESH_SCHEDULE_EXISTS", "Each Plugin may have only one recurring refresh schedule", { current: existing });
    }
  }

  createSchedule(config, { state = "enabled", now = new Date() } = {}) {
    if (!SCHEDULE_STATES.includes(state) || state === "orphaned") throw schedulerError("INVALID_SCHEDULE_STATE", "New schedules may only be enabled or paused");
    this.assertRefreshScheduleAvailable(config);
    const createdAt = iso(now);
    const scheduleId = randomUUID();
    const anchorAt = createdAt;
    const withAnchor = { ...config, anchorAt };
    const nextRunAt = nextOccurrence(withAnchor, now, { strict: true }).toISOString();
    this.db.prepare("INSERT INTO schedules(schedule_id,config_json,state,version,created_at,updated_at,anchor_at,next_run_at) VALUES(?,?,?,?,?,?,?,?)")
      .run(scheduleId, configForStorage(config, anchorAt), state, 1, createdAt, createdAt, anchorAt, nextRunAt);
    return this.getSchedule(scheduleId);
  }

  updateSchedule(scheduleId, config, { state, expectedVersion, now = new Date() } = {}) {
    const current = this.getSchedule(scheduleId);
    if (!current) throw schedulerError("SCHEDULE_NOT_FOUND", "Schedule was not found");
    if (!Number.isInteger(expectedVersion) || expectedVersion !== current.version) {
      throw schedulerError("SCHEDULE_VERSION_CONFLICT", "Schedule was changed by another client", { current });
    }
    const nextState = state ?? current.state;
    if (!SCHEDULE_STATES.includes(nextState)) throw schedulerError("INVALID_SCHEDULE_STATE", "Schedule state is invalid");
    this.assertRefreshScheduleAvailable(config, scheduleId);
    const updatedAt = iso(now);
    const nextConfig = { ...config, anchorAt: current.anchorAt };
    const nextRunAt = nextOccurrence(nextConfig, now, { strict: true }).toISOString();
    const result = this.db.prepare("UPDATE schedules SET config_json=?,state=?,version=?,updated_at=?,next_run_at=?,last_due_at=NULL,last_run_id=NULL,last_period_key=NULL,last_error_json=NULL WHERE schedule_id=? AND version=?")
      .run(configForStorage(config, current.anchorAt), nextState, current.version + 1, updatedAt, nextRunAt, scheduleId, expectedVersion);
    if (result.changes !== 1) throw schedulerError("SCHEDULE_VERSION_CONFLICT", "Schedule was changed by another client");
    return this.getSchedule(scheduleId);
  }

  setScheduleState(scheduleId, state, { expectedVersion, now = new Date() } = {}) {
    const current = this.getSchedule(scheduleId);
    if (!current) throw schedulerError("SCHEDULE_NOT_FOUND", "Schedule was not found");
    if (!Number.isInteger(expectedVersion) || expectedVersion !== current.version) {
      throw schedulerError("SCHEDULE_VERSION_CONFLICT", "Schedule was changed by another client", { current });
    }
    if (!SCHEDULE_STATES.includes(state)) throw schedulerError("INVALID_SCHEDULE_STATE", "Schedule state is invalid");
    const updatedAt = iso(now);
    const nextRunAt = state === "enabled"
      ? nextOccurrence({ ...current, anchorAt: current.anchorAt }, now, { strict: true }).toISOString()
      : current.nextRunAt;
    this.db.prepare("UPDATE schedules SET state=?,version=?,updated_at=?,next_run_at=? WHERE schedule_id=? AND version=?")
      .run(state, current.version + 1, updatedAt, nextRunAt, scheduleId, expectedVersion);
    return this.getSchedule(scheduleId);
  }

  deleteSchedule(scheduleId) {
    const result = this.db.prepare("DELETE FROM schedules WHERE schedule_id=?").run(scheduleId);
    if (result.changes !== 1) throw schedulerError("SCHEDULE_NOT_FOUND", "Schedule was not found");
    return true;
  }

  dueSchedules(now = new Date()) {
    return this.db.prepare("SELECT * FROM schedules WHERE state='enabled' AND next_run_at IS NOT NULL AND next_run_at<=? ORDER BY next_run_at ASC")
      .all(iso(now)).map(scheduleFromRow);
  }

  advanceSchedule(scheduleId, dueAt, now = new Date(), { lastPeriodKey, lastRunId, error } = {}) {
    const schedule = this.getSchedule(scheduleId);
    if (!schedule) return undefined;
    const nextRunAt = nextOccurrence({ ...schedule, anchorAt: schedule.anchorAt }, now, { strict: true }).toISOString();
    const timestamp = iso(now);
    this.db.prepare("UPDATE schedules SET next_run_at=?,last_due_at=?,last_run_id=?,last_period_key=?,last_error_json=?,updated_at=? WHERE schedule_id=?")
      .run(nextRunAt, iso(dueAt, "dueAt"), lastRunId ?? null, lastPeriodKey ?? null, error ? JSON.stringify(error) : null, timestamp, scheduleId);
    return this.getSchedule(scheduleId);
  }

  setScheduleError(scheduleId, error, now = new Date()) {
    const timestamp = iso(now);
    this.db.prepare("UPDATE schedules SET last_error_json=?,updated_at=? WHERE schedule_id=?")
      .run(error ? JSON.stringify(error) : null, timestamp, scheduleId);
    return this.getSchedule(scheduleId);
  }

  createRun(schedule, { trigger = "scheduled", periodKey, reason, now = new Date() } = {}) {
    if (!["scheduled", "manual", "resend"].includes(trigger)) throw schedulerError("INVALID_RUN", "Run trigger is invalid");
    if (periodKey !== undefined && periodKey !== null) assertLocalDate(periodKey);
    if (periodKey) {
      const existing = this.db.prepare("SELECT * FROM schedule_runs WHERE schedule_id=? AND period_key=?").get(schedule.scheduleId, periodKey);
      if (existing) return { run: runFromRow(existing), reused: true };
    }
    const runId = randomUUID();
    const createdAt = iso(now);
    this.db.prepare("INSERT INTO schedule_runs(run_id,schedule_id,period_key,trigger,state,reason,schedule_version,config_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)")
      .run(runId, schedule.scheduleId, periodKey ?? null, trigger, "queued", reason ?? null, schedule.version, JSON.stringify(schedule), createdAt, createdAt);
    return { run: this.getRun(runId), reused: false };
  }

  getRun(runId) {
    const row = this.db.prepare("SELECT * FROM schedule_runs WHERE run_id=?").get(runId);
    const run = runFromRow(row);
    if (!run || !row.delivery_id) return run;
    const delivery = this.db.prepare("SELECT delivery_id,state,attempts,config_version,sent_at,error_json FROM deliveries WHERE delivery_id=?").get(row.delivery_id);
    return { ...run, ...(delivery ? { delivery: deliverySummaryFromRow(delivery) } : {}) };
  }

  listRuns(scheduleId, limit = 50) {
    const pageSize = Math.min(200, Math.max(1, Number(limit) || 50));
    return this.db.prepare("SELECT * FROM schedule_runs WHERE schedule_id=? ORDER BY created_at DESC LIMIT ?").all(scheduleId, pageSize).map((row) => {
      const run = runFromRow(row);
      if (!row.delivery_id) return run;
      const delivery = this.db.prepare("SELECT delivery_id,state,attempts,config_version,sent_at,error_json FROM deliveries WHERE delivery_id=?").get(row.delivery_id);
      return { ...run, ...(delivery ? { delivery: deliverySummaryFromRow(delivery) } : {}) };
    });
  }

  markRunStarted(runId, attempts = 1, now = new Date()) {
    const timestamp = iso(now);
    this.db.prepare("UPDATE schedule_runs SET state='running',started_at=COALESCE(started_at,?),attempts=?,updated_at=? WHERE run_id=? AND state='queued'")
      .run(timestamp, attempts, timestamp, runId);
    return this.getRun(runId);
  }

  updateRun(runId, fields = {}, now = new Date()) {
    const current = this.getRun(runId);
    if (!current) throw schedulerError("RUN_NOT_FOUND", "Run was not found");
    const nextState = fields.state ?? current.state;
    if (!SCHEDULE_RUN_STATES.includes(nextState)) throw schedulerError("INVALID_RUN", "Run state is invalid");
    const assignments = ["state=?"];
    const values = [nextState];
    if (fields.completedAt !== undefined) { assignments.push("completed_at=?"); values.push(fields.completedAt); }
    if (fields.attempts !== undefined) { assignments.push("attempts=?"); values.push(fields.attempts); }
    if (fields.result !== undefined) { assignments.push("result_json=?"); values.push(JSON.stringify(fields.result)); }
    if (fields.error !== undefined) { assignments.push("error_json=?"); values.push(fields.error ? JSON.stringify(fields.error) : null); }
    if (fields.skipReason !== undefined) { assignments.push("skip_reason=?"); values.push(fields.skipReason ?? null); }
    if (fields.snapshotId !== undefined) { assignments.push("snapshot_id=?"); values.push(fields.snapshotId ?? null); }
    if (fields.deliveryId !== undefined) { assignments.push("delivery_id=?"); values.push(fields.deliveryId ?? null); }
    assignments.push("updated_at=?");
    values.push(iso(now), runId);
    this.db.prepare("UPDATE schedule_runs SET " + assignments.join(",") + " WHERE run_id=?").run(...values);
    return this.getRun(runId);
  }

  saveSnapshot({ runId, scheduleId, localDate, timeZone, aggregate, markdown, now = new Date() }) {
    const snapshotId = randomUUID();
    const createdAt = iso(now);
    this.db.prepare("INSERT INTO digest_snapshots(snapshot_id,run_id,schedule_id,local_date,time_zone,aggregate_json,markdown,created_at) VALUES(?,?,?,?,?,?,?,?)")
      .run(snapshotId, runId, scheduleId, assertLocalDate(localDate), assertTimeZone(timeZone), JSON.stringify(aggregate), String(markdown), createdAt);
    this.db.prepare("UPDATE schedule_runs SET snapshot_id=?,updated_at=? WHERE run_id=?").run(snapshotId, createdAt, runId);
    return this.getSnapshot(snapshotId);
  }

  getSnapshot(snapshotId) {
    const row = this.db.prepare("SELECT * FROM digest_snapshots WHERE snapshot_id=?").get(snapshotId);
    if (!row) return undefined;
    return {
      snapshotId: String(row.snapshot_id),
      runId: String(row.run_id),
      scheduleId: String(row.schedule_id),
      localDate: String(row.local_date),
      timeZone: String(row.time_zone),
      aggregate: parseJson(row.aggregate_json, {}),
      markdown: String(row.markdown),
      createdAt: String(row.created_at),
    };
  }

  createDelivery({ runId, scheduleId, periodKey, recipients, subject, textBody, htmlBody, configVersion, now = new Date() }) {
    const deliveryId = randomUUID();
    const timestamp = iso(now);
    this.db.prepare("INSERT INTO deliveries(delivery_id,run_id,schedule_id,period_key,state,attempts,to_json,subject,text_body,html_body,config_version,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)")
      .run(deliveryId, runId, scheduleId, periodKey ?? null, "not-sent", 0, JSON.stringify(recipients), String(subject), String(textBody), String(htmlBody), configVersion, timestamp, timestamp);
    this.db.prepare("UPDATE schedule_runs SET delivery_id=?,updated_at=? WHERE run_id=?").run(deliveryId, timestamp, runId);
    return this.getDelivery(deliveryId);
  }

  getDelivery(deliveryId) {
    return deliveryFromRow(this.db.prepare("SELECT * FROM deliveries WHERE delivery_id=?").get(deliveryId));
  }

  updateDelivery(deliveryId, fields = {}, now = new Date()) {
    const current = this.getDelivery(deliveryId);
    if (!current) throw schedulerError("DELIVERY_NOT_FOUND", "Delivery was not found");
    if (fields.state !== undefined && !DELIVERY_STATES.includes(fields.state)) throw schedulerError("INVALID_DELIVERY", "Delivery state is invalid");
    const assignments = [];
    const values = [];
    const updates = [
      ["state", fields.state],
      ["attempts", fields.attempts],
      ["sent_at", fields.sentAt],
      ["error_json", fields.error === undefined ? undefined : fields.error ? JSON.stringify(fields.error) : null],
    ];
    for (const [column, value] of updates) {
      if (value === undefined) continue;
      assignments.push(column + "=?");
      values.push(value);
    }
    assignments.push("updated_at=?");
    values.push(iso(now), deliveryId);
    this.db.prepare("UPDATE deliveries SET " + assignments.join(",") + " WHERE delivery_id=?").run(...values);
    return this.getDelivery(deliveryId);
  }

  getMailSettings() {
    const row = this.db.prepare("SELECT * FROM mail_settings WHERE singleton=1").get();
    if (!row) return { version: 0, config: undefined, updatedAt: undefined };
    return { version: Number(row.version), config: parseJson(row.config_json, {}), updatedAt: String(row.updated_at) };
  }

  saveMailSettings(config, { expectedVersion, now = new Date() } = {}) {
    const current = this.getMailSettings();
    if (expectedVersion !== undefined && Number(expectedVersion) !== current.version) {
      throw schedulerError("MAIL_SETTINGS_VERSION_CONFLICT", "Mail settings were changed by another client", { current });
    }
    const version = current.version + 1;
    const updatedAt = iso(now);
    if (!current.version) {
      this.db.prepare("INSERT INTO mail_settings(singleton,config_json,version,updated_at) VALUES(1,?,?,?)").run(JSON.stringify(config), version, updatedAt);
    } else {
      this.db.prepare("UPDATE mail_settings SET config_json=?,version=?,updated_at=? WHERE singleton=1").run(JSON.stringify(config), version, updatedAt);
    }
    return this.getMailSettings();
  }

  createMailTestAudit({ configVersion, recipients, state = "sending", now = new Date() }) {
    const auditId = randomUUID();
    const testedAt = iso(now);
    const redactedRecipients = recipients.map(redactRecipient);
    this.db.prepare("INSERT INTO mail_test_audits(audit_id,config_version,recipients_json,state,tested_at) VALUES(?,?,?,?,?)")
      .run(auditId, configVersion, JSON.stringify(redactedRecipients), state, testedAt);
    return { auditId, configVersion, recipients: redactedRecipients, state, testedAt };
  }

  updateMailTestAudit(auditId, { state, error } = {}) {
    if (!["sending", "sent", "failed", "unknown"].includes(state)) throw schedulerError("INVALID_MAIL_TEST", "Mail test state is invalid");
    this.db.prepare("UPDATE mail_test_audits SET state=?,error_json=? WHERE audit_id=?")
      .run(state, error ? JSON.stringify(error) : null, auditId);
    const row = this.db.prepare("SELECT * FROM mail_test_audits WHERE audit_id=?").get(auditId);
    if (!row) throw schedulerError("MAIL_TEST_NOT_FOUND", "Mail test audit was not found");
    const parsed = parseJson(row.error_json, undefined);
    return {
      auditId: String(row.audit_id),
      configVersion: Number(row.config_version),
      recipients: parseJson(row.recipients_json, []),
      state: String(row.state),
      testedAt: String(row.tested_at),
      ...(parsed ? { error: parsed } : {}),
    };
  }

  markSchedulesOrphaned(pluginId, now = new Date()) {
    const timestamp = iso(now);
    for (const schedule of this.listSchedules()) {
      const ids = schedule.kind === "refresh" ? [schedule.pluginId] : schedule.pluginIds;
      if (!ids.includes(pluginId) || schedule.state === "orphaned") continue;
      this.db.prepare("UPDATE schedules SET state='orphaned',version=?,updated_at=? WHERE schedule_id=?")
        .run(schedule.version + 1, timestamp, schedule.scheduleId);
    }
  }

  restoreOrphanedSchedules(pluginIds, now = new Date()) {
    const available = new Set(pluginIds);
    for (const schedule of this.listSchedules()) {
      if (schedule.state !== "orphaned") continue;
      const ids = schedule.kind === "refresh" ? [schedule.pluginId] : schedule.pluginIds;
      if (ids.some((pluginId) => !available.has(pluginId))) continue;
      const timestamp = iso(now);
      const nextRunAt = nextOccurrence({ ...schedule, anchorAt: schedule.anchorAt }, now, { strict: true }).toISOString();
      this.db.prepare("UPDATE schedules SET state='enabled',version=?,updated_at=?,next_run_at=? WHERE schedule_id=?")
        .run(schedule.version + 1, timestamp, nextRunAt, schedule.scheduleId);
    }
  }
}

export class Scheduler {
  constructor({
    filename,
    now = () => new Date(),
    resolvePlugin = () => ({ installed: true, enabled: true, active: true }),
    executeRefresh,
    executeDigest,
    onEvent = () => {},
    retry = SCHEDULER_RETRY,
  } = {}) {
    if (!filename) throw new TypeError("Scheduler filename is required");
    this.filename = filename;
    this.store = new SchedulerStore(filename);
    this.now = now;
    this.resolvePlugin = resolvePlugin;
    this.executeRefresh = executeRefresh;
    this.executeDigest = executeDigest;
    this.onEvent = onEvent;
    this.retry = normalizeRetry(retry);
    this.timer = undefined;
    this.activeRuns = new Map();
    this.loaded = false;
    this.stopped = false;
  }

  async load() {
    this.store.recoverAfterRestart(this.now());
    this.loaded = true;
    return this.list();
  }

  start({ intervalMs = 1_000 } = {}) {
    if (!this.loaded) throw new Error("Scheduler must be loaded before it starts");
    if (this.timer || this.stopped) return;
    this.stopped = false;
    this.timer = setInterval(() => { void this.tick(); }, Math.max(250, intervalMs));
    this.timer.unref?.();
    void this.tick();
  }

  async stop({ waitForRuns = true, close = true } = {}) {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    for (const entry of this.activeRuns.values()) entry.controller.abort();
    if (waitForRuns) await Promise.allSettled([...this.activeRuns.values()].map((entry) => entry.promise));
    if (close) this.store.close();
  }

  close() {
    this.store.close();
  }

  reopen() {
    this.store.close();
    this.store = new SchedulerStore(this.filename);
    this.store.recoverAfterRestart(this.now());
    this.loaded = true;
    this.stopped = false;
  }

  list() {
    return this.store.listSchedules();
  }

  get(scheduleId) {
    return this.store.getSchedule(scheduleId);
  }

  activeRefreshPromises(pluginId) {
    return [...this.activeRuns.values()]
      .filter((entry) => entry.kind === "refresh" && entry.pluginIds.includes(pluginId))
      .map((entry) => entry.promise);
  }

  create(input, options = {}) {
    const config = normalizeScheduleInput(input, options);
    return this.store.createSchedule(config, { state: input.state === "paused" ? "paused" : "enabled", now: options.now ?? this.now() });
  }

  update(scheduleId, input, { expectedVersion, now = this.now() } = {}) {
    const current = this.get(scheduleId);
    if (!current) throw schedulerError("SCHEDULE_NOT_FOUND", "Schedule was not found");
    const nextKind = input.kind ?? current.kind;
    const merged = {
      ...current,
      ...input,
      kind: nextKind,
      spec: input.spec ?? current.spec,
    };
    if (nextKind === "refresh") {
      delete merged.pluginIds;
      delete merged.recipients;
      merged.pluginId = input.pluginId ?? current.pluginId;
    } else {
      delete merged.pluginId;
      merged.pluginIds = input.pluginIds ?? current.pluginIds;
      merged.recipients = input.recipients ?? current.recipients;
    }
    const config = normalizeScheduleInput(merged);
    return this.store.updateSchedule(scheduleId, config, { expectedVersion, state: input.state ?? current.state, now });
  }

  setState(scheduleId, state, { expectedVersion, now = this.now() } = {}) {
    return this.store.setScheduleState(scheduleId, state, { expectedVersion, now });
  }

  delete(scheduleId) {
    return this.store.deleteSchedule(scheduleId);
  }

  listRuns(scheduleId, limit) {
    if (!this.get(scheduleId)) throw schedulerError("SCHEDULE_NOT_FOUND", "Schedule was not found");
    return this.store.listRuns(scheduleId, limit);
  }

  getRun(runId) {
    return this.store.getRun(runId);
  }

  getSnapshot(snapshotId) {
    return this.store.getSnapshot(snapshotId);
  }

  getDelivery(deliveryId) {
    return this.store.getDelivery(deliveryId);
  }

  getMailSettings() {
    return this.store.getMailSettings();
  }

  saveMailSettings(config, options) {
    return this.store.saveMailSettings(config, options);
  }

  async tick(now = this.now()) {
    if (this.stopped || !this.loaded) return [];
    const due = this.store.dueSchedules(now);
    const work = [];
    for (const schedule of due) {
      const dueAt = schedule.nextRunAt;
      const periodKey = schedule.kind === "daily_digest" ? periodForDigest(now, schedule.timeZone) : undefined;
      const running = [...this.activeRuns.values()].some((entry) => entry.scheduleId === schedule.scheduleId);
      const created = this.store.createRun(schedule, { trigger: "scheduled", periodKey, reason: "schedule", now });
      this.store.advanceSchedule(schedule.scheduleId, dueAt, now, { lastPeriodKey: periodKey, lastRunId: created.run.runId });
      if (created.reused) {
        await this.onEvent("schedule-period-reused", { scheduleId: schedule.scheduleId, runId: created.run.runId, periodKey });
        continue;
      }
      if (running) {
        const skipped = this.store.updateRun(created.run.runId, {
          state: "skipped",
          skipReason: "SCHEDULE_ALREADY_RUNNING",
          completedAt: iso(now),
        }, now);
        await this.onEvent("schedule-run-skipped", { scheduleId: schedule.scheduleId, runId: skipped.runId, skipReason: skipped.skipReason });
        continue;
      }
      work.push(this.executeRun(schedule, created.run, { dueAt, periodKey, scheduled: true }));
    }
    return Promise.allSettled(work);
  }

  async runNow(scheduleId, { reason = "manual", awaitCompletion = false } = {}) {
    const schedule = this.get(scheduleId);
    if (!schedule) throw schedulerError("SCHEDULE_NOT_FOUND", "Schedule was not found");
    const now = this.now();
    const created = this.store.createRun(schedule, { trigger: "manual", reason, now });
    if (!created.reused) {
      const promise = this.executeRun(schedule, created.run, { scheduled: false });
      if (awaitCompletion) await promise;
    }
    return { ...created.run, reused: created.reused };
  }

  async resend(scheduleId, runId, { awaitCompletion = false } = {}) {
    const schedule = this.get(scheduleId);
    const source = this.getRun(runId);
    if (!schedule) throw schedulerError("SCHEDULE_NOT_FOUND", "Schedule was not found");
    if (!source || source.scheduleId !== scheduleId) throw schedulerError("RUN_NOT_FOUND", "Run was not found");
    if (schedule.kind !== "daily_digest" || !source.snapshotId) throw schedulerError("DELIVERY_NOT_AVAILABLE", "This run has no stored digest snapshot");
    const now = this.now();
    const created = this.store.createRun(schedule, { trigger: "resend", reason: "manual-resend", now });
    if (!created.reused) {
      const promise = this.executeRun(schedule, created.run, { sourceRun: source, scheduled: false, resend: true });
      if (awaitCompletion) await promise;
    }
    return { ...created.run, reused: created.reused, sourceRunId: source.runId };
  }

  async executeRun(schedule, run, { dueAt, periodKey, sourceRun, resend = false } = {}) {
    if (this.stopped) return this.store.updateRun(run.runId, { state: "interrupted", completedAt: iso(this.now()), error: { code: "RUNTIME_STOPPING", message: "Scheduler is stopping" } });
    const controller = new AbortController();
    let resolveCompletion;
    const completion = new Promise((resolve) => { resolveCompletion = resolve; });
    this.activeRuns.set(run.runId, {
      scheduleId: schedule.scheduleId,
      kind: schedule.kind,
      pluginIds: schedule.kind === "refresh" ? [schedule.pluginId] : schedule.pluginIds,
      controller,
      promise: completion,
    });
    try {
      const availability = await this.scheduleAvailability(schedule);
      if (!availability.ok) {
        const skipped = this.store.updateRun(run.runId, {
          state: "skipped",
          skipReason: availability.reason,
          completedAt: iso(this.now()),
          error: availability.error,
        });
        this.store.setScheduleError(schedule.scheduleId, availability.error, this.now());
        await this.onEvent("schedule-run-skipped", { scheduleId: schedule.scheduleId, runId: run.runId, skipReason: availability.reason });
        return skipped;
      }
      this.store.markRunStarted(run.runId, 1, this.now());
      const callback = resend ? this.executeDigest : schedule.kind === "refresh" ? this.executeRefresh : this.executeDigest;
      if (typeof callback !== "function") throw schedulerError("SCHEDULER_HANDLER_UNAVAILABLE", "No handler is registered for " + schedule.kind);
      let result;
      for (let attempt = 1; attempt <= this.retry.maxAttempts; attempt += 1) {
        if (controller.signal.aborted) throw schedulerError("SCHEDULER_CANCELED", "Scheduled run was canceled");
        this.store.updateRun(run.runId, { attempts: attempt }, this.now());
        try {
          result = await callback({
            schedule,
            run: this.store.getRun(run.runId),
            periodKey,
            dueAt,
            sourceRun,
            signal: controller.signal,
            resend,
          });
          if (result?.retryable === true && attempt < this.retry.maxAttempts) {
            await this.retryDelay(attempt, controller.signal);
            continue;
          }
          if (result?.ok === false && result?.status !== "partial") {
            const error = schedulerError(result.code ?? "SCHEDULE_RUN_FAILED", result.message ?? "Scheduled task returned ok:false");
            error.retryable = result.retryable === true;
            throw error;
          }
          break;
        } catch (error) {
          if (error?.code === "SCHEDULER_CANCELED" || error?.code === "TASK_CANCELLED") throw error;
          if (error?.retryable !== true || attempt >= this.retry.maxAttempts) throw error;
          await this.retryDelay(attempt, controller.signal);
        }
      }
      const final = this.store.updateRun(run.runId, {
        state: result?.status === "skipped" ? "skipped" : "succeeded",
        skipReason: result?.skipReason,
        result: result ?? { ok: true },
        completedAt: iso(this.now()),
      }, this.now());
      this.store.setScheduleError(schedule.scheduleId, undefined, this.now());
      await this.onEvent("schedule-run-completed", { scheduleId: schedule.scheduleId, runId: run.runId, state: final.state, periodKey });
      return final;
    } catch (error) {
      const failure = {
        code: typeof error?.code === "string" ? error.code : "SCHEDULE_RUN_FAILED",
        message: String(error?.message ?? error),
      };
      const state = error?.code === "SCHEDULER_CANCELED" || error?.code === "TASK_CANCELLED" ? "canceled" : "failed";
      const final = this.store.updateRun(run.runId, { state, completedAt: iso(this.now()), error: failure }, this.now());
      this.store.setScheduleError(schedule.scheduleId, failure, this.now());
      await this.onEvent("schedule-run-failed", { scheduleId: schedule.scheduleId, runId: run.runId, state, error: failure, periodKey });
      return final;
    } finally {
      this.activeRuns.delete(run.runId);
      resolveCompletion();
    }
  }

  async scheduleAvailability(schedule) {
    const ids = schedule.kind === "refresh" ? [schedule.pluginId] : schedule.pluginIds;
    const values = [];
    for (const pluginId of ids) {
      let state;
      try { state = await this.resolvePlugin(pluginId); }
      catch (error) { state = { installed: true, enabled: true, active: false, error: { code: "PLUGIN_UNAVAILABLE", message: String(error?.message ?? error) } }; }
      values.push({ pluginId, ...(state && typeof state === "object" ? state : {}) });
    }
    if (values.some((value) => value.installed === false)) {
      return { ok: false, reason: "PLUGIN_ORPHANED", error: { code: "PLUGIN_ORPHANED", message: "A scheduled Plugin is no longer installed" } };
    }
    if (schedule.kind === "refresh" && values.some((value) => value.enabled === false || value.active === false)) {
      return { ok: false, reason: "PLUGIN_UNAVAILABLE", error: { code: "PLUGIN_UNAVAILABLE", message: "A scheduled Plugin is disabled or unavailable" } };
    }
    if (schedule.kind === "daily_digest" && values.every((value) => value.enabled === false || value.active === false)) {
      return { ok: false, reason: "PLUGIN_UNAVAILABLE", error: { code: "PLUGIN_UNAVAILABLE", message: "All Daily Summary Plugins are disabled or unavailable" } };
    }
    return { ok: true, plugins: values };
  }

  async retryDelay(attempt, signal) {
    const delay = Math.min(this.retry.maxBackoffMs, this.retry.backoffMs * (this.retry.backoffMultiplier ** (attempt - 1)));
    if (!delay) return;
    await new Promise((resolve, reject) => {
      let timer;
      const onAbort = () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        reject(schedulerError("SCHEDULER_CANCELED", "Scheduled retry was canceled"));
      };
      timer = setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      }, delay);
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }
}

function normalizeRetry(value) {
  const input = value && typeof value === "object" ? value : SCHEDULER_RETRY;
  return {
    maxAttempts: Math.min(3, Math.max(1, Number(input.maxAttempts) || 3)),
    backoffMs: Math.max(0, Number(input.backoffMs) || 0),
    maxBackoffMs: Math.max(0, Number(input.maxBackoffMs) || 30_000),
    backoffMultiplier: Math.min(10, Math.max(1, Number(input.backoffMultiplier) || 2)),
  };
}
