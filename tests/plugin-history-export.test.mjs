import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { test } from "node:test";
import { downloadableResponse } from "../packages/plugin-sdk/src/index.js";
import { openStore as openHn } from "../plugins/hn/backend/history-storage.js";
import { openStore as openGithub } from "../plugins/github-trending/backend/history-storage.js";
import { openStore as openZhihu } from "../plugins/zhihu-hot/backend/history-storage.js";
import { openStore as openProductHunt } from "../plugins/product-hunt/backend/history-storage.js";

const root=path.resolve(import.meta.dirname,"..");
const story=(id)=>({id:String(id),rank:1,title:`Story ${id}`,domain:"example.com",points:1,author:"author",createdAt:"2026-01-01T00:00:00.000Z",comments:0,url:`https://example.com/${id}`,discussionUrl:`https://news.ycombinator.com/item?id=${id}`});
const repo=(id)=>({id:`owner/repo${id}`,rank:1,owner:"owner",name:`repo${id}`,description:"desc",language:"JavaScript",languageColor:"#f1e05a",stars:1,forks:0,starsGained:1,url:`https://github.com/owner/repo${id}`});
const question=(id)=>({url:`https://www.zhihu.com/question/${id}`,rank:1,title:`Question ${id}`,excerpt:"excerpt",heat:"1 热度",answers:1,thumbnailUrl:null});
const product=(id)=>({url:`https://www.producthunt.com/products/product-${id}`,rank:1,name:`Product ${id}`,votes:1});

test("downloadable response convention rejects unsafe filenames and non-stream bodies",()=>{
  assert.throws(()=>downloadableResponse("../private.json",["{}"]),/filenameBase/);
  assert.throws(()=>downloadableResponse({filenameBase:"history",format:"xml",body:["{}"]}),/Unsupported download format/);
  assert.throws(()=>downloadableResponse({filenameBase:"history",format:"json",body:{}}),/iterable/);
  assert.throws(()=>downloadableResponse({filenameBase:"history",format:"json",body:[new Uint8Array([1])]}),/iterable of strings/);
  assert.throws(()=>downloadableResponse({filenameBase:"history",format:"json",body:["{}"]},"legacy"),/requires/);
  assert.equal(downloadableResponse({filenameBase:"history",format:"json",body:["{}"]}).type,"infolens:download");
});

test("all plugin stores retain snapshots, share read ledgers, and export only business history",async()=>{
  const temp=await mkdtemp(path.join(os.tmpdir(),"infolens-history-stores-"));
  const cases=[
    ["hn",openHn,story,"0.3.0",2],
    ["github-trending",openGithub,repo,"0.3.0",3],
    ["zhihu-hot",openZhihu,question,"0.2.0",2],
    ["product-hunt",openProductHunt,product,"0.2.0",2],
  ];
  try{for(const [pluginId,openStore,record,version,schema] of cases){
    const filename=path.join(temp,`${pluginId}.sqlite`);const store=openStore(filename);
    assert.equal(store.schemaVersion(),schema);assert.equal(store.settings().retentionDays,30);
    store.replace([record(1)],"2026-07-03T00:00:00.000Z");
    const identity=pluginId==="hn"?"1":pluginId==="github-trending"?"owner/repo1":record(1).url;
    store.markRead(identity,true);store.replace([record(2)],"2026-08-01T00:00:00.000Z");
    const history=store.snapshots({limit:1,offset:1});assert.equal(history.total,2);assert.equal(history.items.length,1);
    assert.equal(store.snapshot(history.items[0].id).records[0].read,true);
    const exported=JSON.parse([...store.createExport(version,"2026-08-01T01:00:00.000Z")].join(""));
    assert.equal(exported.pluginId,pluginId);assert.equal(exported.schemaVersion,1);assert.equal(exported.snapshots.length,2);assert.deepEqual(exported.userState[identity],{read:true});
    assert.equal("settings" in exported,false);assert.equal(JSON.stringify(exported).includes("dependencyState"),false);assert.equal(JSON.stringify(exported).includes("readme"),false);
    store.close();
  }}finally{await rm(temp,{recursive:true,force:true})}
});

test("existing stores migrate known read state and defer first activation cleanup",async()=>{
  const temp=await mkdtemp(path.join(os.tmpdir(),"infolens-history-migration-"));
  const cases=[
    ["hn",openHn,story,"stories","id","story_user_state",2],
    ["github-trending",openGithub,repo,"repositories","id","repository_user_state",3],
    ["zhihu-hot",openZhihu,question,"questions","url","question_user_state",2],
    ["product-hunt",openProductHunt,product,"products","url","product_user_state",2],
  ];
  try{for(const [pluginId,openStore,record,table,key,ledger,currentVersion] of cases){
    const filename=path.join(temp,`${pluginId}-migration.sqlite`);let store=openStore(filename);store.replace([record(1)],"2025-01-01T00:00:00.000Z");store.close();
    const raw=new DatabaseSync(filename);raw.prepare(`UPDATE ${table} SET is_read=1`).run();raw.exec(`DROP TABLE ${ledger}; ALTER TABLE refresh_settings DROP COLUMN retention_days; DELETE FROM schema_migrations WHERE version=${currentVersion};`);raw.close();
    store=openStore(filename);assert.equal(store.list()[0].read,true,pluginId);assert.equal(store.metadata().retentionCleanupDeferred,"true",pluginId);store.cleanupOnActivation();assert.equal(store.snapshotCount(),1,pluginId);store.replace([record(2)],"2026-08-01T00:00:00.000Z");assert.equal(store.snapshotCount(),1,pluginId);assert.equal("retentionCleanupDeferred" in store.metadata(),false,pluginId);store.close();
  }}finally{await rm(temp,{recursive:true,force:true})}
});

test("retention uses UTC, preserves latest, requires acknowledgement, and export is point-in-time",async()=>{
  const temp=await mkdtemp(path.join(os.tmpdir(),"infolens-history-retention-"));const filename=path.join(temp,"hn.sqlite");
  try{const store=openHn(filename);store.replace([story(1)],"2026-01-01T00:00:00.000Z");store.replace([story(2)],"2026-01-02T00:00:00.000Z");
    assert.throws(()=>store.saveSettings({policy:"manual",intervalMinutes:60,retentionDays:7}),/acknowledgement/);
    store.saveSettings({policy:"manual",intervalMinutes:60,retentionDays:7},{acknowledgeRetentionCleanup:true});assert.equal(store.snapshotCount(),1);
    const stream=store.createExport("0.3.0","2026-08-01T00:00:00.000Z");store.replace([story(3)],"2026-08-01T00:00:00.000Z");const exported=JSON.parse([...stream].join(""));assert.equal(exported.snapshots.length,1);assert.equal(exported.snapshots[0].records[0].id,"2");store.close();
  }finally{await rm(temp,{recursive:true,force:true})}
});

test("retention preserves the newest UTC collected_at snapshot when a backfill has the larger id",async()=>{
  const temp=await mkdtemp(path.join(os.tmpdir(),"infolens-history-backfill-retention-"));
  const cases=[
    ["hn",openHn,story],
    ["github-trending",openGithub,repo],
    ["zhihu-hot",openZhihu,question],
    ["product-hunt",openProductHunt,product],
  ];
  try{for(const [pluginId,openStore,record] of cases){
    const store=openStore(path.join(temp,`${pluginId}.sqlite`));
    try{
      store.saveSettings({policy:"manual",intervalMinutes:60,retentionDays:7},{acknowledgeRetentionCleanup:true});
      store.replace([record(1)],"2026-08-10T00:00:00.000Z");
      store.replace([record(2)],"2026-08-01T00:00:00.000Z");
      store.cleanup(new Date("2026-08-20T00:00:00.000Z"));
      const remaining=store.snapshots({limit:10}).items;
      assert.equal(remaining.length,1,pluginId);
      assert.equal(remaining[0].collectedAt,"2026-08-10T00:00:00.000Z",pluginId);
    }finally{store.close()}
  }}finally{await rm(temp,{recursive:true,force:true})}
});

test("malformed snapshots remain listed as unavailable and fail export without mutation",async()=>{
  const temp=await mkdtemp(path.join(os.tmpdir(),"infolens-history-malformed-"));const filename=path.join(temp,"hn.sqlite");
  try{const store=openHn(filename);store.replace([story(1)],"2026-08-01T00:00:00.000Z");const db=new DatabaseSync(filename);db.prepare("UPDATE collection_snapshots SET payload='not-json'").run();db.close();assert.equal(store.snapshots().items[0].available,false);assert.equal(store.snapshot(1).available,false);assert.throws(()=>store.createExport("0.3.0"),/malformed/);assert.equal(store.snapshotCount(),1);store.close()}finally{await rm(temp,{recursive:true,force:true})}
});

async function startRuntime(dataRoot,stateFile){const child=spawn(process.execPath,[path.join(root,"packages/plugin-runtime/src/server.mjs")],{cwd:root,env:{...process.env,INFOLENS_PROJECT_ROOT:root,INFOLENS_PLUGIN_DATA_ROOT:dataRoot,INFOLENS_BUNDLED_OPENCLI_ROOT:path.join(root,"tests/fixtures/runtime-opencli/opencli"),INFOLENS_TEST_OPENCLI_STATE:stateFile,INFOLENS_RUNTIME_PORT:"0",INFOLENS_APPLICATION_SESSION_ID:"plugin-history-export-test-session"},stdio:["pipe","pipe","pipe"]});const lines=readline.createInterface({input:child.stdout});return new Promise((resolve,reject)=>{const errors=[];child.stderr.on("data",chunk=>errors.push(chunk));child.once("error",reject);const timeout=setTimeout(()=>reject(new Error(`Runtime start timed out: ${Buffer.concat(errors).toString()}`)),5000);lines.on("line",line=>{const message=JSON.parse(line);if(message.type==="runtime-ready"){clearTimeout(timeout);resolve({child,message})}})})}
async function stopRuntime(child){if(child.exitCode!==null)return;child.stdin.write("shutdown\n");await new Promise(resolve=>child.once("exit",resolve))}

test("Runtime streams a versioned export with fixed safe download headers",async()=>{const temp=await mkdtemp(path.join(os.tmpdir(),"infolens-history-runtime-"));const stateFile=path.join(temp,"state.json");await writeFile(stateFile,JSON.stringify({hn:"success"}));let runtime;try{runtime=await startRuntime(path.join(temp,"data"),stateFile);const origin=runtime.message.origin;assert.equal((await fetch(`${origin}/plugins/hn/api/refresh`,{method:"POST"})).status,200);const response=await fetch(`${origin}/plugins/hn/api/export`);assert.equal(response.status,200);assert.match(response.headers.get("content-type")??"",/^application\/json/);assert.match(response.headers.get("content-disposition")??"",/^attachment; filename="hacker-news-history-\d{4}-\d{2}-\d{2}\.json"; filename\*=UTF-8''/);assert.equal(response.headers.get("cache-control"),"no-store");const exported=await response.json();assert.equal(exported.pluginId,"hn");assert.equal(exported.snapshots.length,1)}finally{if(runtime)await stopRuntime(runtime.child);await rm(temp,{recursive:true,force:true})}});
