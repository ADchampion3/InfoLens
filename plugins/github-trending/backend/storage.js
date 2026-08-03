import { DatabaseSync } from "node:sqlite";

export { openStore } from "./history-storage.js";

function openLegacyStore(filename) {
  const db = new DatabaseSync(filename);
  db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);");
  const version = db.prepare("SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations").get().version;
  if (version < 1) db.exec(`
    BEGIN;
    CREATE TABLE repositories (
      id TEXT PRIMARY KEY, rank INTEGER NOT NULL, owner TEXT NOT NULL, name TEXT NOT NULL,
      description TEXT NOT NULL, language TEXT, language_color TEXT, stars INTEGER NOT NULL,
      forks INTEGER NOT NULL, stars_gained INTEGER NOT NULL, url TEXT NOT NULL, is_read INTEGER NOT NULL DEFAULT 0,
      collected_at TEXT NOT NULL
    );
    CREATE TABLE collection_snapshots (id INTEGER PRIMARY KEY AUTOINCREMENT, collected_at TEXT NOT NULL, record_count INTEGER NOT NULL, payload TEXT NOT NULL);
    CREATE TABLE refresh_settings (singleton INTEGER PRIMARY KEY CHECK(singleton=1), policy TEXT NOT NULL, interval_minutes INTEGER NOT NULL);
    CREATE TABLE view_settings (singleton INTEGER PRIMARY KEY CHECK(singleton=1), period TEXT NOT NULL, language TEXT NOT NULL);
    CREATE TABLE plugin_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO refresh_settings VALUES (1, 'manual', 60);
    INSERT INTO view_settings VALUES (1, 'daily', 'all');
    INSERT INTO schema_migrations VALUES (1, datetime('now'));
    COMMIT;
  `);
  if (version < 2) db.exec(`
    BEGIN;
    CREATE TABLE repository_readmes (
      repository_id TEXT PRIMARY KEY REFERENCES repositories(id) ON DELETE CASCADE,
      html TEXT NOT NULL,
      fetched_at TEXT NOT NULL,
      source_url TEXT NOT NULL
    );
    INSERT INTO schema_migrations VALUES (2, datetime('now'));
    COMMIT;
  `);
  const upsert = db.prepare(`
    INSERT INTO repositories (id, rank, owner, name, description, language, language_color, stars, forks, stars_gained, url, is_read, collected_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE((SELECT is_read FROM repositories WHERE id=?), 0), ?)
    ON CONFLICT(id) DO UPDATE SET rank=excluded.rank, owner=excluded.owner, name=excluded.name,
      description=excluded.description, language=excluded.language, language_color=excluded.language_color,
      stars=excluded.stars, forks=excluded.forks, stars_gained=excluded.stars_gained, url=excluded.url, collected_at=excluded.collected_at
  `);
  const setMeta = db.prepare("INSERT INTO plugin_metadata(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value");
  const findReadme = db.prepare("SELECT repository_id AS repositoryId, html, fetched_at AS fetchedAt, source_url AS sourceUrl FROM repository_readmes WHERE repository_id=?");
  const saveReadme = db.prepare(`
    INSERT INTO repository_readmes(repository_id, html, fetched_at, source_url) VALUES (?, ?, ?, ?)
    ON CONFLICT(repository_id) DO UPDATE SET html=excluded.html, fetched_at=excluded.fetched_at, source_url=excluded.source_url
  `);
  return {
    schemaVersion() { return db.prepare("SELECT MAX(version) AS version FROM schema_migrations").get().version; },
    list() { return db.prepare("SELECT id, rank, owner, name, description, language, language_color AS languageColor, stars, forks, stars_gained AS starsGained, url, is_read AS read FROM repositories ORDER BY rank").all().map((row) => ({ ...row, read: Boolean(row.read) })); },
    settings() { return db.prepare("SELECT policy, interval_minutes AS intervalMinutes FROM refresh_settings WHERE singleton=1").get(); },
    saveSettings(value) { db.prepare("UPDATE refresh_settings SET policy=?, interval_minutes=? WHERE singleton=1").run(value.policy, value.intervalMinutes); },
    view() { return db.prepare("SELECT period, language FROM view_settings WHERE singleton=1").get(); },
    saveView(value) { db.prepare("UPDATE view_settings SET period=?, language=? WHERE singleton=1").run(value.period, value.language); },
    metadata() { return Object.fromEntries(db.prepare("SELECT key,value FROM plugin_metadata").all().map(({key,value}) => [key,value])); },
    repository(id) { return db.prepare("SELECT id, owner, name, url FROM repositories WHERE id=?").get(id); },
    readme(id) { return findReadme.get(id); },
    saveReadme(value) { saveReadme.run(value.repositoryId, value.html, value.fetchedAt, value.sourceUrl); },
    replace(repositories, collectedAt) {
      db.exec("BEGIN IMMEDIATE");
      try {
        for (const repo of repositories) upsert.run(repo.id, repo.rank, repo.owner, repo.name, repo.description, repo.language, repo.languageColor, repo.stars, repo.forks, repo.starsGained, repo.url, repo.id, collectedAt);
        const ids = new Set(repositories.map(({ id }) => id));
        for (const { id } of db.prepare("SELECT id FROM repositories").all()) if (!ids.has(id)) db.prepare("DELETE FROM repositories WHERE id=?").run(id);
        db.prepare("INSERT INTO collection_snapshots(collected_at,record_count,payload) VALUES (?,?,?)").run(collectedAt, repositories.length, JSON.stringify(repositories));
        setMeta.run("lastSuccessfulRefresh", collectedAt);
        db.prepare("DELETE FROM plugin_metadata WHERE key IN ('lastError','lastErrorAt')").run();
        db.exec("COMMIT");
      } catch (error) { db.exec("ROLLBACK"); throw error; }
    },
    recordFailure(message, at) { setMeta.run("lastError", message); setMeta.run("lastErrorAt", at); },
    markRead(id, read) { db.prepare("UPDATE repositories SET is_read=? WHERE id=?").run(read ? 1 : 0, id); },
    snapshotCount() { return db.prepare("SELECT COUNT(*) AS count FROM collection_snapshots").get().count; },
    close() { db.close(); },
  };
}
