import { DatabaseSync } from "node:sqlite";

const DEFAULT_SETTINGS = { policy: "manual", intervalMinutes: 60 };

export { openStore } from "./history-storage.js";

function openLegacyStore(filename) {
  const db = new DatabaseSync(filename);
  db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;");
  migrate(db);
  return createStore(db);
}

function migrate(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
  `);
  const version = db.prepare("SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations").get().version;
  if (version < 1) {
    db.exec(`
      BEGIN;
      CREATE TABLE stories (
        id TEXT PRIMARY KEY, rank INTEGER NOT NULL, title TEXT NOT NULL, domain TEXT NOT NULL,
        points INTEGER NOT NULL, author TEXT NOT NULL, created_at TEXT NOT NULL,
        comments INTEGER NOT NULL, url TEXT NOT NULL, discussion_url TEXT NOT NULL,
        is_read INTEGER NOT NULL DEFAULT 0, collected_at TEXT NOT NULL
      );
      CREATE TABLE collection_snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT, collected_at TEXT NOT NULL,
        record_count INTEGER NOT NULL, payload TEXT NOT NULL
      );
      CREATE TABLE refresh_settings (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1), policy TEXT NOT NULL,
        interval_minutes INTEGER NOT NULL
      );
      CREATE TABLE plugin_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO refresh_settings VALUES (1, 'manual', 60);
      INSERT INTO schema_migrations VALUES (1, datetime('now'));
      COMMIT;
    `);
  }
}

function createStore(db) {
  const upsert = db.prepare(`
    INSERT INTO stories (id, rank, title, domain, points, author, created_at, comments, url, discussion_url, is_read, collected_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE((SELECT is_read FROM stories WHERE id = ?), 0), ?)
    ON CONFLICT(id) DO UPDATE SET rank=excluded.rank, title=excluded.title, domain=excluded.domain,
      points=excluded.points, author=excluded.author, created_at=excluded.created_at, comments=excluded.comments,
      url=excluded.url, discussion_url=excluded.discussion_url, collected_at=excluded.collected_at
  `);
  const setMeta = db.prepare("INSERT INTO plugin_metadata(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value");
  return {
    schemaVersion() { return db.prepare("SELECT MAX(version) AS version FROM schema_migrations").get().version; },
    list() { return db.prepare("SELECT id, rank, title, domain, points, author, created_at AS createdAt, comments, url, discussion_url AS discussionUrl, is_read AS read FROM stories ORDER BY rank").all().map((row) => ({ ...row, read: Boolean(row.read) })); },
    settings() { return db.prepare("SELECT policy, interval_minutes AS intervalMinutes FROM refresh_settings WHERE singleton=1").get() ?? DEFAULT_SETTINGS; },
    saveSettings(settings) { db.prepare("UPDATE refresh_settings SET policy=?, interval_minutes=? WHERE singleton=1").run(settings.policy, settings.intervalMinutes); },
    metadata() { return Object.fromEntries(db.prepare("SELECT key, value FROM plugin_metadata").all().map(({ key, value }) => [key, value])); },
    replace(stories, collectedAt) {
      db.exec("BEGIN IMMEDIATE");
      try {
        for (const story of stories) upsert.run(story.id, story.rank, story.title, story.domain, story.points, story.author, story.createdAt, story.comments, story.url, story.discussionUrl, story.id, collectedAt);
        const ids = new Set(stories.map((story) => String(story.id)));
        for (const { id } of db.prepare("SELECT id FROM stories").all()) if (!ids.has(String(id))) db.prepare("DELETE FROM stories WHERE id=?").run(id);
        db.prepare("INSERT INTO collection_snapshots(collected_at, record_count, payload) VALUES (?, ?, ?)").run(collectedAt, stories.length, JSON.stringify(stories));
        setMeta.run("lastSuccessfulRefresh", collectedAt);
        db.prepare("DELETE FROM plugin_metadata WHERE key IN ('lastError', 'lastErrorAt')").run();
        db.exec("COMMIT");
      } catch (error) { db.exec("ROLLBACK"); throw error; }
    },
    recordFailure(message, at) { setMeta.run("lastError", message); setMeta.run("lastErrorAt", at); },
    markRead(id, read) { db.prepare("UPDATE stories SET is_read=? WHERE id=?").run(read ? 1 : 0, id); },
    snapshotCount() { return db.prepare("SELECT COUNT(*) AS count FROM collection_snapshots").get().count; },
    close() { db.close(); },
  };
}
