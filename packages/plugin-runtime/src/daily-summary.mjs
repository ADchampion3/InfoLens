const ISO_TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2})$/u;
const SAFE_STATES = new Set(["ready", "no-data"]);
const SAFE_PRIMITIVES = new Set(["string", "number", "boolean"]);
const RESERVED_FIELD_NAMES = new Set(["__proto__", "prototype", "constructor"]);

function daysInMonth(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

export function normalizeDailySummaryTimestamp(value) {
  if (typeof value !== "string") return undefined;
  const match = value.match(ISO_TIMESTAMP);
  if (!match) return undefined;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, fractionText, offset] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) return undefined;
  if (hour > 23 || minute > 59 || second > 59) return undefined;
  if (fractionText && fractionText.length > 3) return undefined;
  if (offset !== "Z") {
    const offsetHours = Number(offset.slice(1, 3));
    const offsetMinutes = Number(offset.slice(4, 6));
    if (offsetHours > 23 || offsetMinutes > 59) return undefined;
  }
  const timestamp = new Date(value);
  return Number.isFinite(timestamp.valueOf()) ? value : undefined;
}

export function localDayKey(value, timeZone) {
  const timestamp = value instanceof Date ? value : new Date(String(value));
  if (!Number.isFinite(timestamp.valueOf()) || typeof timeZone !== "string" || !timeZone.trim()) return undefined;
  let parts;
  try {
    parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(timestamp);
  } catch {
    return undefined;
  }
  const values = Object.fromEntries(parts.filter(({ type }) => type !== "literal").map(({ type, value }) => [type, value]));
  return values.year && values.month && values.day ? `${values.year}-${values.month}-${values.day}` : undefined;
}

export function createDailySummaryContext({ now = new Date(), timeZone } = {}) {
  const generatedAt = now instanceof Date ? now : new Date(now);
  if (!Number.isFinite(generatedAt.valueOf())) throw new TypeError("Daily Summary generation time is invalid");
  const resolvedTimeZone = timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  if (typeof resolvedTimeZone !== "string" || !resolvedTimeZone.trim() || !localDayKey(generatedAt, resolvedTimeZone)) {
    throw new TypeError("Daily Summary time zone is invalid");
  }
  return Object.freeze({
    localDate: localDayKey(generatedAt, resolvedTimeZone),
    timeZone: resolvedTimeZone,
    generatedAt: generatedAt.toISOString(),
  });
}

function invalid(message) {
  const error = new TypeError(message);
  error.code = "INVALID_DAILY_SUMMARY_RESULT";
  throw error;
}

function primitive(value, field) {
  if (!SAFE_PRIMITIVES.has(typeof value)) invalid(`${field} must be a primitive value`);
  if (typeof value === "number" && !Number.isFinite(value)) invalid(`${field} must be finite`);
  return value;
}

function normalizeFields(value, recordIndex) {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid(`records[${recordIndex}].fields must be an object`);
  const fields = {};
  for (const [label, fieldValue] of Object.entries(value)) {
    if (!label.trim() || label.length > 120 || RESERVED_FIELD_NAMES.has(label)) invalid(`records[${recordIndex}].fields has an invalid label`);
    fields[label] = primitive(fieldValue, `records[${recordIndex}].fields.${label}`);
  }
  return Object.keys(fields).length ? fields : undefined;
}

function normalizeRecord(value, index) {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid(`records[${index}] must be an object`);
  if (typeof value.title !== "string" || !value.title.trim()) invalid(`records[${index}].title must be a non-empty string`);
  const record = { title: value.title };
  if (value.url !== undefined) {
    if (typeof value.url !== "string" || !value.url.trim()) invalid(`records[${index}].url must be a non-empty string`);
    record.url = value.url;
  }
  if (value.rank !== undefined) {
    if (!Number.isInteger(value.rank) || value.rank < 0) invalid(`records[${index}].rank must be a non-negative integer`);
    record.rank = value.rank;
  }
  if (value.read !== undefined) {
    if (typeof value.read !== "boolean") invalid(`records[${index}].read must be boolean`);
    record.read = value.read;
  }
  const fields = normalizeFields(value.fields, index);
  if (fields) record.fields = fields;
  return record;
}

export function normalizeDailySummaryResult(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid("Daily Summary result must be an object");
  if (!SAFE_STATES.has(value.state)) invalid("Daily Summary result has an unsupported state");
  if (!Array.isArray(value.records)) invalid("Daily Summary result records must be an array");
  if (value.state === "no-data") {
    if (value.records.length !== 0 || (value.recordCount !== undefined && value.recordCount !== 0)) invalid("no-data Daily Summary result must be empty");
    return { state: "no-data", recordCount: 0, records: [] };
  }
  if (!normalizeDailySummaryTimestamp(value.collectedAt)) invalid("ready Daily Summary result requires a safe collectedAt timestamp");
  if (!Number.isInteger(value.recordCount) || value.recordCount < 0 || value.recordCount !== value.records.length) {
    invalid("ready Daily Summary result has an invalid recordCount");
  }
  return {
    state: "ready",
    collectedAt: value.collectedAt,
    recordCount: value.recordCount,
    records: value.records.map(normalizeRecord),
  };
}

function safeUnavailable() {
  return { state: "unavailable", reason: "Daily Summary data is unavailable" };
}

export async function aggregateDailySummary(plugins, { now, timeZone, signal } = {}) {
  if (!Array.isArray(plugins)) throw new TypeError("Daily Summary requires an ordered Plugin list");
  const shared = createDailySummaryContext({ now, timeZone });
  const requestSignal = signal ?? new AbortController().signal;
  const results = await Promise.all(plugins.map(async (plugin) => {
    const pluginId = plugin.pluginId;
    if (typeof pluginId !== "string" || !pluginId.trim()) throw new TypeError("Daily Summary Plugin requires pluginId");
    const base = {
      pluginId,
      name: typeof plugin.name === "string" ? plugin.name : pluginId,
      ...(typeof plugin.version === "string" ? { version: plugin.version } : {}),
      enabled: plugin.enabled !== false,
      pluginState: typeof plugin.state === "string" ? plugin.state : (plugin.enabled === false ? "disabled" : "running"),
      browserDependent: plugin.browserDependent === true,
      capability: typeof plugin.provider === "function" ? "supported" : "unsupported",
    };
    if (plugin.enabled === false) return { ...base, status: "disabled" };
    if (typeof plugin.provider !== "function") return { ...base, status: "unsupported" };
    if (plugin.active === false) {
      return { ...base, status: "unavailable", context: safeUnavailable() };
    }
    try {
      if (requestSignal.aborted) throw Object.assign(new Error("Daily Summary request cancelled"), { code: "REQUEST_ABORTED" });
      const value = await plugin.provider({ ...shared, signal: requestSignal });
      const context = normalizeDailySummaryResult(value);
      return { ...base, status: context.state, context };
    } catch {
      return { ...base, status: "unavailable", context: safeUnavailable() };
    }
  }));
  return { ...shared, plugins: results };
}
