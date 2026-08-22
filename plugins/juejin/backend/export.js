import { DatabaseSync } from "node:sqlite";

const FORMATS = new Set(["json", "csv", "markdown", "text"]);
const EXPORT_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;

export function normalizeExportDate(value) {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" || !EXPORT_DATE_PATTERN.test(value)) throw new Error("Export date must use YYYY-MM-DD");
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== value) throw new Error("Export date is invalid");
  return value;
}

function parseSnapshot(row) {
  try {
    const records = JSON.parse(row.payload);
    if (!Array.isArray(records)) throw new Error("payload is not an array");
    return records;
  } catch (error) {
    throw new Error(`Snapshot ${row.id} is malformed: ${error.message}`);
  }
}

function record(value) {
  return {
    id: String(value?.id ?? ""),
    rank: value?.rank ?? "",
    category: String(value?.category ?? ""),
    title: String(value?.title ?? ""),
    brief: String(value?.brief ?? ""),
    author: String(value?.author ?? ""),
    views: value?.views ?? "",
    likes: value?.likes ?? "",
    comments: value?.comments ?? "",
    hotRank: value?.hotRank ?? "",
    url: String(value?.url ?? ""),
  };
}

function csv(value) {
  const text = value === null || value === undefined ? "" : String(value);
  return /[",\r\n]/u.test(text)
    ? String.fromCharCode(34) + text.replace(/"/gu, String.fromCharCode(34, 34)) + String.fromCharCode(34)
    : text;
}

function csvRow(values) { return `${values.map(csv).join(",")}\n`; }
function markdown(value) { return String(value ?? "").replace(/[|\r\n]/gu, (character) => character === "|" ? "\\|" : " "); }

function snapshotRows(reader, date) {
  const query = date
    ? "SELECT id,collected_at AS collectedAt,payload FROM collection_snapshots WHERE substr(collected_at,1,10)=? ORDER BY collected_at,id"
    : "SELECT id,collected_at AS collectedAt,payload FROM collection_snapshots ORDER BY collected_at,id";
  return date ? reader.prepare(query).iterate(date) : reader.prepare(query).iterate();
}

function stateMap(reader, date) {
  const states = new Map(reader.prepare("SELECT article_id AS id,is_read AS read FROM article_user_state ORDER BY article_id").all().map(({ id, read }) => [String(id), Boolean(read)]));
  if (!date) return states;
  const selectedIds = new Set();
  for (const row of snapshotRows(reader, date)) for (const item of parseSnapshot(row)) selectedIds.add(String(item?.id ?? ""));
  return new Map([...states].filter(([id]) => selectedIds.has(id)));
}

function openReader(filename, date) {
  const reader = new DatabaseSync(filename, { readOnly: true });
  reader.exec("PRAGMA query_only=ON; BEGIN;");
  try {
    for (const row of snapshotRows(reader, date)) parseSnapshot(row);
  } catch (error) {
    reader.exec("ROLLBACK");
    reader.close();
    throw error;
  }
  return reader;
}

function jsonExport(reader, pluginId, pluginVersion, exportedAt, date) {
  return (function* () {
    try {
      yield `{"pluginId":${JSON.stringify(pluginId)},"pluginVersion":${JSON.stringify(pluginVersion)},"schemaVersion":1,"exportedAt":${JSON.stringify(exportedAt)},"snapshots":[`;
      let first = true;
      for (const row of snapshotRows(reader, date)) {
        yield `${first ? "" : ","}{"collectedAt":${JSON.stringify(row.collectedAt)},"records":${JSON.stringify(parseSnapshot(row).map(record))}}`;
        first = false;
      }
      const userState = Object.fromEntries([...stateMap(reader, date)].map(([id, read]) => [id, { read }]));
      yield `],"userState":${JSON.stringify(userState)}}`;
    } finally {
      reader.exec("ROLLBACK");
      reader.close();
    }
  })();
}

function csvExport(reader, pluginId, pluginVersion, exportedAt, date) {
  return (function* () {
    try {
      yield csvRow([`# ${pluginId}`, `version ${pluginVersion}`, `exported ${exportedAt}`]);
      yield csvRow(["snapshot_collected_at", "id", "rank", "category", "title", "brief", "author", "views", "likes", "comments", "hot_rank", "url", "read"]);
      const states = stateMap(reader, date);
      for (const row of snapshotRows(reader, date)) {
        for (const item of parseSnapshot(row).map(record)) {
          yield csvRow([row.collectedAt, item.id, item.rank, item.category, item.title, item.brief, item.author, item.views, item.likes, item.comments, item.hotRank, item.url, states.get(item.id) ?? false]);
        }
      }
      yield "\n";
      yield csvRow(["user_state_id", "read"]);
      for (const [id, read] of states) yield csvRow([id, read]);
    } finally {
      reader.exec("ROLLBACK");
      reader.close();
    }
  })();
}

function markdownExport(reader, pluginId, pluginVersion, exportedAt, date) {
  return (function* () {
    try {
      yield `# Juejin history\n\n- Plugin: ${markdown(pluginId)} ${markdown(pluginVersion)}\n- Exported: ${markdown(exportedAt)}${date ? `\n- Date: ${markdown(date)}` : ""}\n\n`;
      const states = stateMap(reader, date);
      for (const row of snapshotRows(reader, date)) {
        yield `## ${markdown(row.collectedAt)}\n\n`;
        for (const item of parseSnapshot(row).map(record)) {
          yield `${item.rank}. [${markdown(item.title)}](${item.url}) — ${markdown(item.category)} · ${markdown(item.author || "匿名用户")} · ${item.likes} likes · ${states.get(item.id) ? "read" : "unread"}\n`;
          if (item.brief) yield `   ${markdown(item.brief)}\n`;
        }
        yield "\n";
      }
    } finally {
      reader.exec("ROLLBACK");
      reader.close();
    }
  })();
}

function textExport(reader, pluginId, pluginVersion, exportedAt, date) {
  return (function* () {
    try {
      yield `Juejin history · ${pluginId} ${pluginVersion}\nExported ${exportedAt}${date ? ` · ${date}` : ""}\n\n`;
      const states = stateMap(reader, date);
      for (const row of snapshotRows(reader, date)) {
        yield `Snapshot ${row.collectedAt}\n`;
        for (const item of parseSnapshot(row).map(record)) yield `${item.rank}. ${item.title} · ${item.category} · ${item.author || "匿名用户"} · ${item.likes} likes · ${states.get(item.id) ? "read" : "unread"}\n`;
        yield "\n";
      }
    } finally {
      reader.exec("ROLLBACK");
      reader.close();
    }
  })();
}

export function createExport(filename, { pluginId = "juejin", pluginVersion, format = "json", exportedAt = new Date().toISOString(), date } = {}) {
  if (!FORMATS.has(format)) throw new Error(`Unsupported export format '${format}'`);
  const selectedDate = normalizeExportDate(date);
  const reader = openReader(filename, selectedDate);
  if (format === "csv") return csvExport(reader, pluginId, pluginVersion, exportedAt, selectedDate);
  if (format === "markdown") return markdownExport(reader, pluginId, pluginVersion, exportedAt, selectedDate);
  if (format === "text") return textExport(reader, pluginId, pluginVersion, exportedAt, selectedDate);
  return jsonExport(reader, pluginId, pluginVersion, exportedAt, selectedDate);
}
