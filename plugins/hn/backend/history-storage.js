import { DatabaseSync } from "node:sqlite";

const DEFAULT_SETTINGS = { policy: "manual", intervalMinutes: 60, retentionDays: 30 };
const RETENTION_DAYS = new Set([7, 30, 90]);

export function openStore(filename) {
  const db = new DatabaseSync(filename);
  db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;");
  migrate(db);
  return createStore(db, filename);
}

function migrate(db) {
  db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);");
  const originalVersion = db.prepare("SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations").get().version;
  if (originalVersion < 1) db.exec(`
    BEGIN;
    CREATE TABLE stories (
      id TEXT PRIMARY KEY, rank INTEGER NOT NULL, title TEXT NOT NULL, domain TEXT NOT NULL,
      points INTEGER NOT NULL, author TEXT NOT NULL, created_at TEXT NOT NULL,
      comments INTEGER NOT NULL, url TEXT NOT NULL, discussion_url TEXT NOT NULL,
      is_read INTEGER NOT NULL DEFAULT 0, collected_at TEXT NOT NULL
    );
    CREATE TABLE collection_snapshots (id INTEGER PRIMARY KEY AUTOINCREMENT, collected_at TEXT NOT NULL, record_count INTEGER NOT NULL, payload TEXT NOT NULL);
    CREATE TABLE refresh_settings (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), policy TEXT NOT NULL, interval_minutes INTEGER NOT NULL);
    CREATE TABLE plugin_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO refresh_settings VALUES (1, 'manual', 60);
    INSERT INTO schema_migrations VALUES (1, datetime('now'));
    COMMIT;
  `);
  if (originalVersion < 2) {
    db.exec(`
      BEGIN;
      ALTER TABLE refresh_settings ADD COLUMN retention_days INTEGER NOT NULL DEFAULT 30;
      CREATE TABLE story_user_state (story_id TEXT PRIMARY KEY, is_read INTEGER NOT NULL CHECK(is_read IN (0, 1)));
      INSERT INTO story_user_state(story_id, is_read) SELECT id, is_read FROM stories;
      INSERT INTO schema_migrations VALUES (2, datetime('now'));
      COMMIT;
    `);
    if (originalVersion > 0) db.prepare("INSERT INTO plugin_metadata(key,value) VALUES ('retentionCleanupDeferred','true') ON CONFLICT(key) DO UPDATE SET value='true'").run();
  }
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
  const upsert = db.prepare(`
    INSERT INTO stories (id, rank, title, domain, points, author, created_at, comments, url, discussion_url, is_read, collected_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
    ON CONFLICT(id) DO UPDATE SET rank=excluded.rank, title=excluded.title, domain=excluded.domain,
      points=excluded.points, author=excluded.author, created_at=excluded.created_at, comments=excluded.comments,
      url=excluded.url, discussion_url=excluded.discussion_url, collected_at=excluded.collected_at
  `);
  const setMeta = db.prepare("INSERT INTO plugin_metadata(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value");
  const decorate = (records) => {
    const state = new Map(db.prepare("SELECT story_id, is_read FROM story_user_state").all().map((row) => [row.story_id, Boolean(row.is_read)]));
    return records.map((record) => ({ ...record, read: state.get(String(record.id)) ?? false }));
  };
  let store;
  const cleanup = (now = new Date()) => {
    const latest = db.prepare("SELECT MAX(id) AS id FROM collection_snapshots").get().id;
    const cutoff = new Date(now.getTime() - store.settings().retentionDays * 86_400_000).toISOString();
    db.exec("BEGIN IMMEDIATE");
    try {
      if (latest !== null) db.prepare("DELETE FROM collection_snapshots WHERE id <> ? AND collected_at < ?").run(latest, cutoff);
      let valid = true;
      const referenced = new Set(db.prepare("SELECT id FROM stories").all().map(({ id }) => String(id)));
      for (const row of db.prepare("SELECT id, payload FROM collection_snapshots").iterate()) {
        try { for (const record of parseSnapshot(row)) referenced.add(String(record.id)); } catch { valid = false; }
      }
      if (valid) for (const { story_id: id } of db.prepare("SELECT story_id FROM story_user_state").all()) if (!referenced.has(id)) db.prepare("DELETE FROM story_user_state WHERE story_id=?").run(id);
      db.prepare("DELETE FROM plugin_metadata WHERE key='retentionCleanupDeferred'").run();
      db.exec("COMMIT");
    } catch (error) { db.exec("ROLLBACK"); throw error; }
  };
  store = {
    schemaVersion() { return db.prepare("SELECT MAX(version) AS version FROM schema_migrations").get().version; },
    list() { return decorate(db.prepare("SELECT id, rank, title, domain, points, author, created_at AS createdAt, comments, url, discussion_url AS discussionUrl FROM stories ORDER BY rank").all()); },
    settings() { return db.prepare("SELECT policy, interval_minutes AS intervalMinutes, retention_days AS retentionDays FROM refresh_settings WHERE singleton=1").get() ?? DEFAULT_SETTINGS; },
    saveSettings(settings, { acknowledgeRetentionCleanup = false } = {}) {
      if (!RETENTION_DAYS.has(settings.retentionDays)) throw new Error("Unsupported retention setting");
      if (settings.retentionDays < store.settings().retentionDays && !acknowledgeRetentionCleanup) throw new Error("Shortening retention requires cleanup acknowledgement");
      db.prepare("UPDATE refresh_settings SET policy=?, interval_minutes=?, retention_days=? WHERE singleton=1").run(settings.policy, settings.intervalMinutes, settings.retentionDays);
      cleanup();
    },
    metadata() { return Object.fromEntries(db.prepare("SELECT key, value FROM plugin_metadata").all().map(({ key, value }) => [key, value])); },
    replace(stories, collectedAt) {
      db.exec("BEGIN IMMEDIATE");
      try {
        for (const story of stories) upsert.run(story.id, story.rank, story.title, story.domain, story.points, story.author, story.createdAt, story.comments, story.url, story.discussionUrl, collectedAt);
        const ids = new Set(stories.map((story) => String(story.id)));
        for (const { id } of db.prepare("SELECT id FROM stories").all()) if (!ids.has(String(id))) db.prepare("DELETE FROM stories WHERE id=?").run(id);
        db.prepare("INSERT INTO collection_snapshots(collected_at, record_count, payload) VALUES (?, ?, ?)").run(collectedAt, stories.length, JSON.stringify(stories));
        setMeta.run("lastSuccessfulRefresh", collectedAt);
        db.prepare("DELETE FROM plugin_metadata WHERE key IN ('lastError', 'lastErrorAt')").run();
        db.exec("COMMIT");
      } catch (error) { db.exec("ROLLBACK"); throw error; }
      cleanup(new Date(collectedAt));
    },
    recordFailure(message, at) { setMeta.run("lastError", message); setMeta.run("lastErrorAt", at); },
    markRead(id, read) { db.prepare("INSERT INTO story_user_state(story_id,is_read) VALUES (?,?) ON CONFLICT(story_id) DO UPDATE SET is_read=excluded.is_read").run(String(id), read ? 1 : 0); },
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
    cleanup,
    cleanupOnActivation() { if (store.metadata().retentionCleanupDeferred !== "true") cleanup(); },
    snapshotCount() { return db.prepare("SELECT COUNT(*) AS count FROM collection_snapshots").get().count; },
    createExport(pluginVersion, exportedAt = new Date().toISOString()) {
      const reader = new DatabaseSync(filename, { readOnly: true });
      reader.exec("PRAGMA query_only=ON; BEGIN;");
      try { for (const row of reader.prepare("SELECT id,payload FROM collection_snapshots ORDER BY collected_at,id").iterate()) parseSnapshot(row); }
      catch (error) { reader.exec("ROLLBACK"); reader.close(); throw error; }
      return (function* () {
        try {
          yield `{"pluginId":"hn","pluginVersion":${JSON.stringify(pluginVersion)},"schemaVersion":1,"exportedAt":${JSON.stringify(exportedAt)},"snapshots":[`;
          let first = true;
          for (const row of reader.prepare("SELECT id,collected_at AS collectedAt,payload FROM collection_snapshots ORDER BY collected_at,id").iterate()) {
            yield `${first ? "" : ","}{"collectedAt":${JSON.stringify(row.collectedAt)},"records":${JSON.stringify(parseSnapshot(row))}}`;
            first = false;
          }
          const userState = Object.fromEntries(reader.prepare("SELECT story_id,is_read FROM story_user_state ORDER BY story_id").all().map(({ story_id, is_read }) => [story_id, { read: Boolean(is_read) }]));
          yield `],"userState":${JSON.stringify(userState)}}`;
        } finally { reader.exec("ROLLBACK"); reader.close(); }
      })();
    },
    close() { db.close(); },
  };
  return store;
}
