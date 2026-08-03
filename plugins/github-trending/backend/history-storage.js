import { DatabaseSync } from "node:sqlite";
import { createExport as createTextExport } from "./export.js";

const RETENTION_DAYS = new Set([7, 30, 90]);

export function openStore(filename) {
  const db = new DatabaseSync(filename);
  db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);");
  const originalVersion = db.prepare("SELECT COALESCE(MAX(version),0) AS version FROM schema_migrations").get().version;
  if (originalVersion < 1) db.exec(`BEGIN;
    CREATE TABLE repositories (id TEXT PRIMARY KEY,rank INTEGER NOT NULL,owner TEXT NOT NULL,name TEXT NOT NULL,description TEXT NOT NULL,language TEXT,language_color TEXT,stars INTEGER NOT NULL,forks INTEGER NOT NULL,stars_gained INTEGER NOT NULL,url TEXT NOT NULL,is_read INTEGER NOT NULL DEFAULT 0,collected_at TEXT NOT NULL);
    CREATE TABLE collection_snapshots (id INTEGER PRIMARY KEY AUTOINCREMENT,collected_at TEXT NOT NULL,record_count INTEGER NOT NULL,payload TEXT NOT NULL);
    CREATE TABLE refresh_settings (singleton INTEGER PRIMARY KEY CHECK(singleton=1),policy TEXT NOT NULL,interval_minutes INTEGER NOT NULL);
    CREATE TABLE view_settings (singleton INTEGER PRIMARY KEY CHECK(singleton=1),period TEXT NOT NULL,language TEXT NOT NULL);
    CREATE TABLE plugin_metadata (key TEXT PRIMARY KEY,value TEXT NOT NULL);
    INSERT INTO refresh_settings VALUES(1,'manual',60); INSERT INTO view_settings VALUES(1,'daily','all'); INSERT INTO schema_migrations VALUES(1,datetime('now')); COMMIT;`);
  if (originalVersion < 2) db.exec(`BEGIN;
    CREATE TABLE repository_readmes (repository_id TEXT PRIMARY KEY REFERENCES repositories(id) ON DELETE CASCADE,html TEXT NOT NULL,fetched_at TEXT NOT NULL,source_url TEXT NOT NULL);
    INSERT INTO schema_migrations VALUES(2,datetime('now')); COMMIT;`);
  if (originalVersion < 3) {
    db.exec(`BEGIN;
      ALTER TABLE refresh_settings ADD COLUMN retention_days INTEGER NOT NULL DEFAULT 30;
      CREATE TABLE repository_user_state(repository_id TEXT PRIMARY KEY,is_read INTEGER NOT NULL CHECK(is_read IN(0,1)));
      INSERT INTO repository_user_state SELECT id,is_read FROM repositories;
      INSERT INTO schema_migrations VALUES(3,datetime('now')); COMMIT;`);
    if (originalVersion > 0) db.prepare("INSERT INTO plugin_metadata(key,value) VALUES('retentionCleanupDeferred','true') ON CONFLICT(key) DO UPDATE SET value='true'").run();
  }
  return createStore(db, filename);
}

function parseSnapshot(row) {
  try { const records=JSON.parse(row.payload); if(!Array.isArray(records)) throw new Error("payload is not an array"); return records; }
  catch(error){ throw new Error(`Snapshot ${row.id} is malformed: ${error.message}`); }
}

function createStore(db, filename) {
  const setMeta=db.prepare("INSERT INTO plugin_metadata(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value");
  const upsert=db.prepare(`INSERT INTO repositories(id,rank,owner,name,description,language,language_color,stars,forks,stars_gained,url,is_read,collected_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,0,?)
    ON CONFLICT(id) DO UPDATE SET rank=excluded.rank,owner=excluded.owner,name=excluded.name,description=excluded.description,language=excluded.language,language_color=excluded.language_color,stars=excluded.stars,forks=excluded.forks,stars_gained=excluded.stars_gained,url=excluded.url,collected_at=excluded.collected_at`);
  const findReadme=db.prepare("SELECT repository_id AS repositoryId,html,fetched_at AS fetchedAt,source_url AS sourceUrl FROM repository_readmes WHERE repository_id=?");
  const saveReadme=db.prepare("INSERT INTO repository_readmes(repository_id,html,fetched_at,source_url) VALUES(?,?,?,?) ON CONFLICT(repository_id) DO UPDATE SET html=excluded.html,fetched_at=excluded.fetched_at,source_url=excluded.source_url");
  let store;
  const stateMap=()=>new Map(db.prepare("SELECT repository_id,is_read FROM repository_user_state").all().map(({repository_id,is_read})=>[repository_id,Boolean(is_read)]));
  const decorate=(records)=>{const state=stateMap();return records.map(record=>({...record,read:state.get(String(record.id))??false}))};
  const cleanup=(now=new Date())=>{
    const latest=db.prepare("SELECT id FROM collection_snapshots ORDER BY collected_at DESC, id DESC LIMIT 1").get()?.id ?? null;
    const cutoff=new Date(now.getTime()-store.settings().retentionDays*86_400_000).toISOString();
    db.exec("BEGIN IMMEDIATE");try{
      if(latest!==null)db.prepare("DELETE FROM collection_snapshots WHERE id<>? AND collected_at<?").run(latest,cutoff);
      let valid=true;const referenced=new Set(db.prepare("SELECT id FROM repositories").all().map(({id})=>String(id)));
      for(const row of db.prepare("SELECT id,payload FROM collection_snapshots").iterate())try{for(const record of parseSnapshot(row))referenced.add(String(record.id))}catch{valid=false}
      if(valid)for(const {repository_id:id} of db.prepare("SELECT repository_id FROM repository_user_state").all())if(!referenced.has(id))db.prepare("DELETE FROM repository_user_state WHERE repository_id=?").run(id);
      db.prepare("DELETE FROM plugin_metadata WHERE key='retentionCleanupDeferred'").run();db.exec("COMMIT");
    }catch(error){db.exec("ROLLBACK");throw error}
  };
  store={
    schemaVersion(){return db.prepare("SELECT MAX(version) AS version FROM schema_migrations").get().version},
    list(){return decorate(db.prepare("SELECT id,rank,owner,name,description,language,language_color AS languageColor,stars,forks,stars_gained AS starsGained,url FROM repositories ORDER BY rank").all())},
    settings(){return db.prepare("SELECT policy,interval_minutes AS intervalMinutes,retention_days AS retentionDays FROM refresh_settings WHERE singleton=1").get()},
    saveSettings(value,{acknowledgeRetentionCleanup=false}={}){if(!RETENTION_DAYS.has(value.retentionDays))throw new Error("Unsupported retention setting");if(value.retentionDays<store.settings().retentionDays&&!acknowledgeRetentionCleanup)throw new Error("Shortening retention requires cleanup acknowledgement");db.prepare("UPDATE refresh_settings SET policy=?,interval_minutes=?,retention_days=? WHERE singleton=1").run(value.policy,value.intervalMinutes,value.retentionDays);cleanup()},
    view(){return db.prepare("SELECT period,language FROM view_settings WHERE singleton=1").get()},saveView(value){db.prepare("UPDATE view_settings SET period=?,language=? WHERE singleton=1").run(value.period,value.language)},
    metadata(){return Object.fromEntries(db.prepare("SELECT key,value FROM plugin_metadata").all().map(({key,value})=>[key,value]))},
    repository(id){return db.prepare("SELECT id,owner,name,url FROM repositories WHERE id=?").get(id)},readme(id){return findReadme.get(id)},saveReadme(value){saveReadme.run(value.repositoryId,value.html,value.fetchedAt,value.sourceUrl)},
    replace(records,collectedAt){db.exec("BEGIN IMMEDIATE");try{for(const r of records)upsert.run(r.id,r.rank,r.owner,r.name,r.description,r.language,r.languageColor,r.stars,r.forks,r.starsGained,r.url,collectedAt);const ids=new Set(records.map(r=>String(r.id)));for(const {id} of db.prepare("SELECT id FROM repositories").all())if(!ids.has(String(id)))db.prepare("DELETE FROM repositories WHERE id=?").run(id);db.prepare("INSERT INTO collection_snapshots(collected_at,record_count,payload) VALUES(?,?,?)").run(collectedAt,records.length,JSON.stringify(records));setMeta.run("lastSuccessfulRefresh",collectedAt);db.prepare("DELETE FROM plugin_metadata WHERE key IN('lastError','lastErrorAt')").run();db.exec("COMMIT")}catch(error){db.exec("ROLLBACK");throw error}cleanup(new Date(collectedAt))},
    recordFailure(message,at){setMeta.run("lastError",message);setMeta.run("lastErrorAt",at)},markRead(id,read){db.prepare("INSERT INTO repository_user_state(repository_id,is_read) VALUES(?,?) ON CONFLICT(repository_id) DO UPDATE SET is_read=excluded.is_read").run(String(id),read?1:0)},
    snapshots({limit=20,offset=0}={}){limit=Math.min(Math.max(Number(limit)||20,1),100);offset=Math.max(Number(offset)||0,0);const rows=db.prepare("SELECT id,collected_at AS collectedAt,record_count AS recordCount,payload FROM collection_snapshots ORDER BY collected_at DESC,id DESC LIMIT ? OFFSET ?").all(limit,offset);return{items:rows.map(({payload,...row})=>{try{parseSnapshot({...row,payload});return{...row,available:true}}catch{return{...row,available:false}}}),total:db.prepare("SELECT COUNT(*) AS count FROM collection_snapshots").get().count,limit,offset}},
    snapshot(id){const row=db.prepare("SELECT id,collected_at AS collectedAt,record_count AS recordCount,payload FROM collection_snapshots WHERE id=?").get(id);if(!row)return;try{return{id:row.id,collectedAt:row.collectedAt,recordCount:row.recordCount,available:true,records:decorate(parseSnapshot(row))}}catch{return{id:row.id,collectedAt:row.collectedAt,recordCount:row.recordCount,available:false}}},
    cleanup,cleanupOnActivation(){if(store.metadata().retentionCleanupDeferred!=="true")cleanup()},snapshotCount(){return db.prepare("SELECT COUNT(*) AS count FROM collection_snapshots").get().count},
    createExport(pluginVersion,exportedAt=new Date().toISOString()){const reader=new DatabaseSync(filename,{readOnly:true});reader.exec("PRAGMA query_only=ON; BEGIN;");try{for(const row of reader.prepare("SELECT id,payload FROM collection_snapshots ORDER BY collected_at,id").iterate())parseSnapshot(row)}catch(error){reader.exec("ROLLBACK");reader.close();throw error}return(function*(){try{yield`{"pluginId":"github-trending","pluginVersion":${JSON.stringify(pluginVersion)},"schemaVersion":1,"exportedAt":${JSON.stringify(exportedAt)},"snapshots":[`;let first=true;for(const row of reader.prepare("SELECT id,collected_at AS collectedAt,payload FROM collection_snapshots ORDER BY collected_at,id").iterate()){yield`${first?"":","}{"collectedAt":${JSON.stringify(row.collectedAt)},"records":${JSON.stringify(parseSnapshot(row))}}`;first=false}const state=Object.fromEntries(reader.prepare("SELECT repository_id,is_read FROM repository_user_state ORDER BY repository_id").all().map(({repository_id,is_read})=>[repository_id,{read:Boolean(is_read)}]));yield`],"userState":${JSON.stringify(state)}}`}finally{reader.exec("ROLLBACK");reader.close()}})()},
    close(){db.close()}
  };store.createExport=(pluginVersion,exportedAt=new Date().toISOString(),format="json")=>createTextExport(filename,{pluginId:"github-trending",pluginVersion,exportedAt,format});return store;
}
