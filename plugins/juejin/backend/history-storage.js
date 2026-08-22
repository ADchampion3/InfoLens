import { DatabaseSync } from "node:sqlite";
import { createExport as createTextExport } from "./export.js";

const DEFAULT_SETTINGS = { policy: "manual", intervalMinutes: 60, retentionDays: 30, category: "backend", limit: 20 };
const RETENTION_DAYS = new Set([7, 30, 90]);

export function openStore(filename) {
  const db = new DatabaseSync(filename);
  db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);");
  const originalVersion = db.prepare("SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations").get().version;
  if (originalVersion < 1) db.exec(`BEGIN;
    CREATE TABLE articles (
      id TEXT PRIMARY KEY,
      rank INTEGER NOT NULL,
      category TEXT NOT NULL,
      title TEXT NOT NULL,
      brief TEXT NOT NULL,
      author TEXT NOT NULL,
      views REAL,
      likes REAL,
      comments REAL,
      hot_rank REAL,
      url TEXT NOT NULL,
      collected_at TEXT NOT NULL
    );
    CREATE TABLE collection_snapshots (id INTEGER PRIMARY KEY AUTOINCREMENT, collected_at TEXT NOT NULL, record_count INTEGER NOT NULL, payload TEXT NOT NULL);
    CREATE TABLE refresh_settings (singleton INTEGER PRIMARY KEY CHECK(singleton = 1), policy TEXT NOT NULL, interval_minutes INTEGER NOT NULL, retention_days INTEGER NOT NULL, category TEXT NOT NULL, result_limit INTEGER NOT NULL);
    CREATE TABLE article_user_state (article_id TEXT PRIMARY KEY, is_read INTEGER NOT NULL CHECK(is_read IN (0, 1)));
    CREATE TABLE plugin_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO refresh_settings VALUES (1, 'manual', 60, 30, 'backend', 20);
    INSERT INTO plugin_metadata VALUES ('dependencyState', 'not-required');
    INSERT INTO schema_migrations VALUES (1, datetime('now'));
    COMMIT;`);
  return createStore(db, filename);
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

function createStore(db, filename) {
  const setMeta = db.prepare("INSERT INTO plugin_metadata(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value");
  const upsert = db.prepare(`
    INSERT INTO articles (id, rank, category, title, brief, author, views, likes, comments, hot_rank, url, collected_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET rank=excluded.rank, category=excluded.category, title=excluded.title,
      brief=excluded.brief, author=excluded.author, views=excluded.views, likes=excluded.likes,
      comments=excluded.comments, hot_rank=excluded.hot_rank, url=excluded.url, collected_at=excluded.collected_at
  `);
  let store;
  const stateMap = () => new Map(db.prepare("SELECT article_id, is_read FROM article_user_state").all().map(({ article_id, is_read }) => [String(article_id), Boolean(is_read)]));
  const decorate = (records) => {
    const states = stateMap();
    return records.map((record) => ({ ...record, read: states.get(String(record.id)) ?? false }));
  };
  const cleanup = (now = new Date()) => {
    const latest = db.prepare("SELECT id FROM collection_snapshots ORDER BY collected_at DESC, id DESC LIMIT 1").get()?.id ?? null;
    const cutoff = new Date(now.getTime() - store.settings().retentionDays * 86_400_000).toISOString();
    db.exec("BEGIN IMMEDIATE");
    try {
      if (latest !== null) db.prepare("DELETE FROM collection_snapshots WHERE id <> ? AND collected_at < ?").run(latest, cutoff);
      let valid = true;
      const referenced = new Set(db.prepare("SELECT id FROM articles").all().map(({ id }) => String(id)));
      for (const row of db.prepare("SELECT id, payload FROM collection_snapshots").iterate()) {
        try { for (const record of parseSnapshot(row)) referenced.add(String(record.id)); } catch { valid = false; }
      }
      if (valid) for (const { article_id: id } of db.prepare("SELECT article_id FROM article_user_state").all()) if (!referenced.has(String(id))) db.prepare("DELETE FROM article_user_state WHERE article_id=?").run(id);
      db.prepare("DELETE FROM plugin_metadata WHERE key='retentionCleanupDeferred'").run();
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  };
  store = {
    schemaVersion() { return db.prepare("SELECT MAX(version) AS version FROM schema_migrations").get().version; },
    list() {
      return decorate(db.prepare("SELECT id, rank, category, title, brief, author, views, likes, comments, hot_rank AS hotRank, url FROM articles ORDER BY rank, id").all());
    },
    settings() {
      return db.prepare("SELECT policy, interval_minutes AS intervalMinutes, retention_days AS retentionDays, category, result_limit AS \"limit\" FROM refresh_settings WHERE singleton=1").get() ?? DEFAULT_SETTINGS;
    },
    saveSettings(settings, { acknowledgeRetentionCleanup = false } = {}) {
      const next = { ...store.settings(), ...settings };
      if (!RETENTION_DAYS.has(next.retentionDays)) throw new Error("Unsupported retention setting");
      if (next.retentionDays < store.settings().retentionDays && !acknowledgeRetentionCleanup) throw new Error("Shortening retention requires cleanup acknowledgement");
      db.prepare("UPDATE refresh_settings SET policy=?, interval_minutes=?, retention_days=?, category=?, result_limit=? WHERE singleton=1").run(next.policy, next.intervalMinutes, next.retentionDays, next.category, next.limit);
      cleanup();
    },
    metadata() { return Object.fromEntries(db.prepare("SELECT key, value FROM plugin_metadata").all().map(({ key, value }) => [key, value])); },
    replace(records, collectedAt) {
      db.exec("BEGIN IMMEDIATE");
      try {
        for (const article of records) upsert.run(article.id, article.rank, article.category, article.title, article.brief, article.author, article.views, article.likes, article.comments, article.hotRank, article.url, collectedAt);
        const ids = new Set(records.map((article) => String(article.id)));
        for (const { id } of db.prepare("SELECT id FROM articles").all()) if (!ids.has(String(id))) db.prepare("DELETE FROM articles WHERE id=?").run(id);
        db.prepare("INSERT INTO collection_snapshots(collected_at, record_count, payload) VALUES (?, ?, ?)").run(collectedAt, records.length, JSON.stringify(records));
        setMeta.run("lastSuccessfulRefresh", collectedAt);
        setMeta.run("dependencyState", "not-required");
        db.prepare("DELETE FROM plugin_metadata WHERE key IN ('lastError', 'lastErrorAt')").run();
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
      cleanup(new Date(collectedAt));
    },
    recordFailure(message, at) { setMeta.run("lastError", message); setMeta.run("lastErrorAt", at); setMeta.run("dependencyState", "not-required"); },
    markRead(id, read) { db.prepare("INSERT INTO article_user_state(article_id, is_read) VALUES (?, ?) ON CONFLICT(article_id) DO UPDATE SET is_read=excluded.is_read").run(String(id), read ? 1 : 0); },
    snapshots({ limit = 20, offset = 0 } = {}) {
      const boundedLimit = Math.min(Math.max(Number(limit) || 20, 1), 100);
      const boundedOffset = Math.max(Number(offset) || 0, 0);
      const rows = db.prepare("SELECT id, collected_at AS collectedAt, record_count AS recordCount, payload FROM collection_snapshots ORDER BY collected_at DESC, id DESC LIMIT ? OFFSET ?").all(boundedLimit, boundedOffset);
      return { items: rows.map(({ payload, ...row }) => { try { parseSnapshot({ ...row, payload }); return { ...row, available: true }; } catch { return { ...row, available: false }; } }), total: db.prepare("SELECT COUNT(*) AS count FROM collection_snapshots").get().count, limit: boundedLimit, offset: boundedOffset };
    },
    snapshot(id) {
      const row = db.prepare("SELECT id, collected_at AS collectedAt, record_count AS recordCount, payload FROM collection_snapshots WHERE id=?").get(id);
      if (!row) return undefined;
      try { return { id: row.id, collectedAt: row.collectedAt, recordCount: row.recordCount, available: true, records: decorate(parseSnapshot(row)) }; }
      catch { return { id: row.id, collectedAt: row.collectedAt, recordCount: row.recordCount, available: false }; }
    },
    snapshotDates() {
      return db.prepare("SELECT substr(collected_at,1,10) AS date, COUNT(*) AS snapshotCount FROM collection_snapshots GROUP BY substr(collected_at,1,10) ORDER BY date DESC").all();
    },
    cleanup,
    cleanupOnActivation() { if (store.metadata().retentionCleanupDeferred !== "true") cleanup(); },
    snapshotCount() { return db.prepare("SELECT COUNT(*) AS count FROM collection_snapshots").get().count; },
    close() { db.close(); },
  };
  store.createExport = (pluginVersion, exportedAt = new Date().toISOString(), format = "json", date) => createTextExport(filename, { pluginId: "juejin", pluginVersion, exportedAt, format, date });
  return store;
}
