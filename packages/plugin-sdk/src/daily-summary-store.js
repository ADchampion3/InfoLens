import { DatabaseSync } from "node:sqlite";
import { localDateKey, normalizeIsoTimestamp } from "./daily-summary.js";

function assertLocalDate(localDate) {
  if (typeof localDate !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(localDate)) {
    throw new Error("Daily Summary local date is invalid");
  }
  const parsed = new Date(`${localDate}T00:00:00.000Z`);
  if (!Number.isFinite(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== localDate) {
    throw new Error("Daily Summary local date is invalid");
  }
}

function compareSnapshotIds(left, right) {
  const leftNumber = Number(left);
  const rightNumber = Number(right);
  if (Number.isSafeInteger(leftNumber) && Number.isSafeInteger(rightNumber)) return leftNumber - rightNumber;
  return String(left).localeCompare(String(right));
}

export function readLatestDailySnapshot(filename, {
  localDate,
  timeZone,
  snapshotQuery = "SELECT id, collected_at AS collectedAt, record_count AS recordCount, payload FROM collection_snapshots ORDER BY collected_at DESC, id DESC",
  stateQuery,
  identity,
  signal,
  parse,
}) {
  if (signal?.aborted) throw Object.assign(new Error("Daily Summary request cancelled"), { code: "REQUEST_ABORTED" });
  assertLocalDate(localDate);
  if (typeof timeZone !== "string" || !timeZone.trim()) throw new Error("Daily Summary time zone is invalid");
  if (typeof stateQuery !== "string" || typeof identity !== "function" || typeof parse !== "function") {
    throw new TypeError("Daily Summary snapshot reader requires stateQuery, identity, and parse");
  }

  const reader = new DatabaseSync(filename, { readOnly: true });
  reader.exec("PRAGMA query_only=ON; BEGIN;");
  try {
    const rows = reader.prepare(snapshotQuery).all();
    let selected;
    for (const row of rows) {
      const collectedAt = normalizeIsoTimestamp(row.collectedAt);
      if (!collectedAt) throw new Error("Daily Summary snapshot has an invalid collection timestamp");
      if (localDateKey(collectedAt, timeZone) !== localDate) continue;
      const timestamp = Date.parse(collectedAt);
      if (!selected || timestamp > selected.timestamp || (timestamp === selected.timestamp && compareSnapshotIds(row.id, selected.row.id) > 0)) {
        selected = { row, collectedAt, timestamp };
      }
    }
    if (!selected) return { state: "no-data", records: [] };
    const records = parse(selected.row);
    if (!Array.isArray(records) || !Number.isInteger(selected.row.recordCount) || selected.row.recordCount < 0 || selected.row.recordCount !== records.length) {
      throw new Error("Daily Summary snapshot payload is malformed");
    }
    const state = new Map(reader.prepare(stateQuery).all().map((value) => [String(identity(value)), Boolean(value.isRead)]));
    return {
      state: "ready",
      collectedAt: selected.collectedAt,
      records: records.map((record) => ({ ...record, read: state.get(String(identity(record))) ?? false })),
    };
  } finally {
    try { reader.exec("ROLLBACK"); } catch {}
    reader.close();
  }
}
