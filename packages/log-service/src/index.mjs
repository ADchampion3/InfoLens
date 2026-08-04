import { createHash, randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, rename, rm, stat } from "node:fs/promises";
import path from "node:path";

const LEVELS = new Set(["debug", "info", "warn", "error"]);
const URL_CREDENTIAL = /([?&](?:access_token|auth|authorization|api[_-]?key|cookie|secret|session(?:id)?|token)=)([^&#\s]+)/gi;
const HEADER_VALUE = /\b(authorization|cookie|set-cookie)\s*[:=]\s*([^\r\n,;}]+)/gi;
const ASSIGNMENT = /\b(token|secret|session(?:id)?|profile(?:path)?|contextid)\s*[:=]\s*["']?([^\s"',;}]+)/gi;
const WINDOWS_PROFILE = /[A-Z]:\\(?:Users|Documents and Settings)\\[^\s"']+(?:\\[^\s"']+)*/gi;
const UNIX_PROFILE = /\/(?:Users|home)\/[^\s"']+(?:\/[^\s"']+)*/g;

export class LogQueryError extends Error {
  constructor(message) {
    super(message);
    this.name = "LogQueryError";
    this.code = "INVALID_LOG_CURSOR";
  }
}

function normalizedFilters(filters = {}) {
  return {
    sources: Array.isArray(filters.sources) ? [...new Set(filters.sources.map(String))].sort() : [],
    levels: Array.isArray(filters.levels) ? [...new Set(filters.levels.filter((level) => LEVELS.has(level)))].sort() : [],
    from: filters.from ? String(filters.from) : null,
    to: filters.to ? String(filters.to) : null,
    keyword: filters.keyword ? String(filters.keyword).toLocaleLowerCase() : "",
    operationId: filters.operationId ? String(filters.operationId) : null,
    batchId: filters.batchId ? String(filters.batchId) : null,
  };
}

function filterFingerprint(filters) {
  return createHash("sha256").update(JSON.stringify(filters)).digest("base64url");
}

function encodeCursor(filters, entry) {
  return Buffer.from(JSON.stringify({ v: 1, f: filterFingerprint(filters), t: entry.timestamp, i: entry.id })).toString("base64url");
}

function decodeCursor(cursor, filters) {
  try {
    const value = JSON.parse(Buffer.from(String(cursor), "base64url").toString("utf8"));
    if (value.v !== 1 || value.f !== filterFingerprint(filters) || typeof value.t !== "string" || typeof value.i !== "string") throw new Error();
    return value;
  } catch {
    throw new LogQueryError("The log cursor is invalid or does not match the active filters");
  }
}

export function redactLogText(value) {
  return String(value)
    .replace(URL_CREDENTIAL, "$1[REDACTED]")
    .replace(HEADER_VALUE, "$1=[REDACTED]")
    .replace(ASSIGNMENT, "$1=[REDACTED]")
    .replace(WINDOWS_PROFILE, "[REDACTED_PATH]")
    .replace(UNIX_PROFILE, "[REDACTED_PATH]");
}

export function serializeLogEntries(entries) {
  return entries.map((value) => {
    const entry = {
      id: String(value.id),
      timestamp: String(value.timestamp),
      level: LEVELS.has(value.level) ? value.level : "info",
      source: String(value.source),
      message: redactLogText(value.message),
      ...(value.code ? { code: String(value.code) } : {}),
      sessionId: String(value.sessionId),
      ...(value.operationId ? { operationId: String(value.operationId) } : {}),
      ...(value.batchId ? { batchId: String(value.batchId) } : {}),
    };
    return JSON.stringify(entry);
  }).join("\n") + (entries.length ? "\n" : "");
}

function redactLogValue(value, seen = new WeakSet()) {
  if (typeof value === "string") return redactLogText(value);
  if (!value || typeof value !== "object") return value;
  if (seen.has(value)) return "[CIRCULAR]";
  seen.add(value);
  if (Array.isArray(value)) return value.map((entry) => redactLogValue(entry, seen));
  return Object.fromEntries(Object.keys(value).sort().map((key) => [
    key,
    /(?:authorization|cookie|set-cookie|token|secret|session|profile|contextid|websocket|wsurl)/i.test(key)
      ? "[REDACTED]"
      : redactLogValue(value[key], seen),
  ]));
}

function publicEntry(value, fallbackSource = "host", rawLine = "") {
  const known = new Set(["id", "timestamp", "level", "source", "message", "code", "sessionId", "operationId", "batchId"]);
  const extra = Object.fromEntries(Object.entries(value).filter(([key]) => !known.has(key)));
  const safeExtra = redactLogValue(extra);
  const suffix = Object.keys(safeExtra).length ? ` ${JSON.stringify(safeExtra)}` : "";
  const timestamp = String(value.timestamp);
  const source = fallbackSource;
  const entry = {
    id: value.id ? String(value.id) : `legacy-${createHash("sha256").update(`${source}\0${timestamp}\0${rawLine}`).digest("hex").slice(0, 24)}`,
    timestamp,
    level: LEVELS.has(value.level) ? value.level : "info",
    source,
    message: redactLogText(`${value.message ?? "Legacy log entry"}${suffix}`),
    sessionId: value.sessionId ? String(value.sessionId) : "legacy",
  };
  if (value.code) entry.code = String(value.code);
  if (value.operationId) entry.operationId = String(value.operationId);
  if (value.batchId) entry.batchId = String(value.batchId);
  return entry;
}

async function readEntries(filePath, source = "host") {
  let content;
  try { content = await readFile(filePath, "utf8"); }
  catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  const entries = [];
  for (const line of content.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try { entries.push(publicEntry(JSON.parse(line), source, line)); } catch {}
  }
  return entries;
}

export function createLogService({
  root,
  sessionId,
  clock = () => new Date(),
  createId = randomUUID,
  maxBytes = 256 * 1024,
  maxFiles = 3,
}) {
  const filePath = path.join(path.resolve(root), "host.log");
  let writes = Promise.resolve();

  async function rotateIfNeeded(bytes) {
    let currentBytes = 0;
    try { currentBytes = (await stat(filePath)).size; }
    catch (error) { if (error?.code !== "ENOENT") throw error; }
    if (currentBytes === 0 || currentBytes + bytes <= maxBytes) return;
    await rm(`${filePath}.${maxFiles - 1}`, { force: true });
    for (let index = maxFiles - 2; index >= 1; index -= 1) {
      try { await rename(`${filePath}.${index}`, `${filePath}.${index + 1}`); }
      catch (error) { if (error?.code !== "ENOENT") throw error; }
    }
    await rename(filePath, `${filePath}.1`);
  }

  return {
    async write({ level, message, code, operationId, batchId }) {
      if (!LEVELS.has(level)) throw new TypeError(`Unsupported log level: ${level}`);
      const entry = publicEntry({
        id: createId(),
        timestamp: clock().toISOString(),
        level,
        source: "host",
        message,
        sessionId,
        code,
        operationId,
        batchId,
      });
      const line = `${JSON.stringify(entry)}\n`;
      if (Buffer.byteLength(line, "utf8") > maxBytes) throw new RangeError("Log entry exceeds the configured file size");
      const operation = writes.then(async () => {
        await mkdir(path.dirname(filePath), { recursive: true });
        await rotateIfNeeded(Buffer.byteLength(line, "utf8"));
        await appendFile(filePath, line, "utf8");
        return entry;
      });
      writes = operation.catch(() => {});
      return operation;
    },
    async query({ sources = [], filters: requestedFilters, cursor, limit: requestedLimit } = {}) {
      await writes;
      const retainedFiles = (basePath, source) => Array.from(
        { length: maxFiles },
        (_, index) => readEntries(index === 0 ? basePath : `${basePath}.${index}`, source),
      );
      const groups = await Promise.all([
        ...retainedFiles(filePath, "host"),
        ...sources.flatMap(({ filePath: sourcePath, source }) => retainedFiles(sourcePath, source)),
      ]);
      const entries = groups.flat();
      entries.sort((left, right) => right.timestamp.localeCompare(left.timestamp) || right.id.localeCompare(left.id));
      const filters = normalizedFilters(requestedFilters);
      const filtered = entries.filter((entry) => (
        (!filters.sources.length || filters.sources.includes(entry.source))
        && (!filters.levels.length || filters.levels.includes(entry.level))
        && (!filters.from || entry.timestamp >= filters.from)
        && (!filters.to || entry.timestamp <= filters.to)
        && (!filters.keyword || entry.message.toLocaleLowerCase().includes(filters.keyword))
        && (!filters.operationId || entry.operationId === filters.operationId)
        && (!filters.batchId || entry.batchId === filters.batchId)
      ));
      let start = 0;
      if (cursor) {
        const boundary = decodeCursor(cursor, filters);
        const boundaryIndex = filtered.findIndex((entry) => entry.timestamp === boundary.t && entry.id === boundary.i);
        if (boundaryIndex < 0) throw new LogQueryError("The log cursor is stale because its boundary entry is no longer retained");
        start = boundaryIndex + 1;
      }
      const limit = Math.min(200, Math.max(1, Number.isInteger(requestedLimit) ? requestedLimit : 200));
      const page = filtered.slice(start, start + limit);
      const nextCursor = start + page.length < filtered.length ? encodeCursor(filters, page.at(-1)) : null;
      return { entries: page, nextCursor };
    },
  };
}
