import { DatabaseSync } from "node:sqlite";

export function openStore(filename) {
  const db = new DatabaseSync(filename);
  db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);");
  const version = db.prepare("SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations").get().version;
  if (version < 1) db.exec(`
    BEGIN;
    CREATE TABLE products (
      url TEXT PRIMARY KEY, rank INTEGER NOT NULL, name TEXT NOT NULL, votes INTEGER NOT NULL,
      is_read INTEGER NOT NULL DEFAULT 0, collected_at TEXT NOT NULL
    );
    CREATE TABLE collection_snapshots (id INTEGER PRIMARY KEY AUTOINCREMENT, collected_at TEXT NOT NULL, record_count INTEGER NOT NULL, payload TEXT NOT NULL);
    CREATE TABLE refresh_settings (singleton INTEGER PRIMARY KEY CHECK(singleton=1), policy TEXT NOT NULL, interval_minutes INTEGER NOT NULL);
    CREATE TABLE plugin_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO refresh_settings VALUES (1, 'manual', 60);
    INSERT INTO plugin_metadata VALUES ('dependencyState', 'unknown');
    INSERT INTO schema_migrations VALUES (1, datetime('now'));
    COMMIT;
  `);
  const upsert = db.prepare(`
    INSERT INTO products (url,rank,name,votes,is_read,collected_at)
    VALUES (?,?,?,?,COALESCE((SELECT is_read FROM products WHERE url=?),0),?)
    ON CONFLICT(url) DO UPDATE SET rank=excluded.rank,name=excluded.name,votes=excluded.votes,collected_at=excluded.collected_at
  `);
  const setMeta = db.prepare("INSERT INTO plugin_metadata(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value");
  return {
    schemaVersion() { return db.prepare("SELECT MAX(version) AS version FROM schema_migrations").get().version; },
    list() { return db.prepare("SELECT url,rank,name,votes,is_read AS read FROM products ORDER BY rank").all().map((row) => ({ ...row, read: Boolean(row.read) })); },
    settings() { return db.prepare("SELECT policy,interval_minutes AS intervalMinutes FROM refresh_settings WHERE singleton=1").get(); },
    saveSettings(value) { db.prepare("UPDATE refresh_settings SET policy=?,interval_minutes=? WHERE singleton=1").run(value.policy,value.intervalMinutes); },
    metadata() { return Object.fromEntries(db.prepare("SELECT key,value FROM plugin_metadata").all().map(({key,value}) => [key,value])); },
    replace(products, collectedAt) {
      db.exec("BEGIN IMMEDIATE");
      try {
        for (const product of products) upsert.run(product.url,product.rank,product.name,product.votes,product.url,collectedAt);
        const urls = new Set(products.map(({url}) => url));
        for (const {url} of db.prepare("SELECT url FROM products").all()) if (!urls.has(url)) db.prepare("DELETE FROM products WHERE url=?").run(url);
        db.prepare("INSERT INTO collection_snapshots(collected_at,record_count,payload) VALUES (?,?,?)").run(collectedAt,products.length,JSON.stringify(products));
        setMeta.run("lastSuccessfulRefresh",collectedAt); setMeta.run("dependencyState","connected");
        db.prepare("DELETE FROM plugin_metadata WHERE key IN ('lastError','lastErrorAt')").run();
        db.exec("COMMIT");
      } catch (error) { db.exec("ROLLBACK"); throw error; }
    },
    recordFailure(message, at, dependencyState="connected") { setMeta.run("lastError",message); setMeta.run("lastErrorAt",at); setMeta.run("dependencyState",dependencyState); },
    markRead(url, read) { db.prepare("UPDATE products SET is_read=? WHERE url=?").run(read?1:0,url); },
    snapshotCount() { return db.prepare("SELECT COUNT(*) AS count FROM collection_snapshots").get().count; },
    close() { db.close(); },
  };
}
