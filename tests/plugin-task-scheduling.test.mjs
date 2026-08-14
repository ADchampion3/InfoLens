import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { test } from "node:test";
import { openStore } from "../plugins/product-hunt/backend/storage.js";
import { validateCollection } from "../plugins/product-hunt/backend/index.js";
import { PluginTaskManager, SharedTaskQueue } from "../packages/plugin-runtime/src/task-manager.mjs";

const root=path.resolve(import.meta.dirname,"..");
const mockOpenCli=path.join(root,"tests/fixtures/runtime-opencli/opencli");
const tick=()=>new Promise((resolve)=>setImmediate(resolve));

function controlledTask(counter, maximum, gates) {
  return async (signal) => {
    counter.active+=1;counter.peak=Math.max(counter.peak,counter.active);
    try { await new Promise((resolve,reject)=>{gates.push(resolve);signal.addEventListener("abort",()=>reject(signal.reason),{once:true})}); }
    finally { counter.active-=1; }
  };
}

test("shared queue enforces three PUBLIC permits and one combined browser permit",async()=>{
  const queue=new SharedTaskQueue();const publicCounter={active:0,peak:0};const browserCounter={active:0,peak:0};const publicGates=[];const browserGates=[];
  const publicRuns=Array.from({length:5},(_,index)=>queue.submit({pluginId:`public-${index}`,resource:"PUBLIC",run:controlledTask(publicCounter,3,publicGates)}));
  const browserRuns=Array.from({length:3},(_,index)=>queue.submit({pluginId:`browser-${index}`,resource:"BROWSER",run:controlledTask(browserCounter,1,browserGates)}));
  await tick();assert.equal(publicCounter.peak,3);assert.equal(browserCounter.peak,1);assert.deepEqual(queue.snapshot().active,{PUBLIC:3,BROWSER:1});
  while(publicRuns.length&&queue.snapshot().active.PUBLIC){publicGates.shift()?.();await tick()}while(browserRuns.length&&queue.snapshot().active.BROWSER){browserGates.shift()?.();await tick()}
  await Promise.all(publicRuns);await Promise.all(browserRuns);assert.equal(publicCounter.peak,3);assert.equal(browserCounter.peak,1);
});

test("plugin tasks coalesce, share schedules, cancel queued and active work, and report uncertain outcomes",async()=>{
  const queue=new SharedTaskQueue({publicLimit:1,browserLimit:1});const events=[];const gates=[];
  const firstRun=controlledTask({active:0,peak:0},1,gates);const first=new PluginTaskManager("first",queue,(event,details)=>events.push({event,details}));first.register("refresh",(_,task)=>firstRun(task.signal));
  const blocker=first.enqueue("refresh",null,{coalesceKey:"collection"});const duplicate=first.enqueue("refresh",null,{coalesceKey:"collection"});assert.equal(blocker,duplicate);assert(events.some(({event})=>event==="task-coalesced"));
  first.register("queued",async()=>"never");const queued=first.enqueue("queued");await tick();const firstStopped=first.stop();await assert.rejects(queued,(error)=>error.code==="TASK_CANCELLED"&&error.outcome==="not-started");await assert.rejects(blocker,(error)=>error.code==="TASK_CANCELLED"&&error.outcome==="uncertain");await firstStopped;assert(events.some(({event,details})=>event==="task-cancelled"&&details.outcome==="uncertain"));
  const scheduler=new SharedTaskQueue();const scheduledEvents=[];let calls=0;const scheduled=new PluginTaskManager("scheduled",scheduler,(event)=>scheduledEvents.push(event));scheduled.register("refresh",async()=>{calls+=1});scheduled.schedule("refresh",{intervalMs:100,runImmediately:true,coalesceKey:"collection"});await new Promise((resolve)=>setTimeout(resolve,130));await scheduled.stop();assert(calls>=1);assert(scheduledEvents.includes("task-queued"));
});

test("task failures release permits and leave sibling plugins operational",async()=>{
  const queue=new SharedTaskQueue({publicLimit:1});const failing=queue.submit({pluginId:"failing",resource:"PUBLIC",run:async()=>{throw new Error("source failed")}});const sibling=queue.submit({pluginId:"sibling",resource:"PUBLIC",run:async()=>"healthy"});await assert.rejects(failing,/source failed/);assert.equal(await sibling,"healthy");assert.deepEqual(queue.snapshot().active,{PUBLIC:0,BROWSER:0});
});

async function startRuntime(dataRoot,stateFile){
  const child=spawn(process.execPath,[path.join(root,"packages/plugin-runtime/src/server.mjs")],{cwd:root,env:{...process.env,INFOLENS_PROJECT_ROOT:root,INFOLENS_PLUGIN_DATA_ROOT:dataRoot,INFOLENS_BUNDLED_OPENCLI_ROOT:mockOpenCli,INFOLENS_TEST_OPENCLI_STATE:stateFile,INFOLENS_RUNTIME_PORT:"0"},stdio:["pipe","pipe","pipe"]});
  const lines=readline.createInterface({input:child.stdout});return new Promise((resolve,reject)=>{const errors=[];child.stderr.on("data",(chunk)=>errors.push(chunk));child.once("error",reject);const timeout=setTimeout(()=>reject(new Error(`Runtime start timed out: ${Buffer.concat(errors).toString()}`)),5000);lines.on("line",(line)=>{const message=JSON.parse(line);if(message.type==="runtime-ready"){clearTimeout(timeout);resolve({child,message})}})});
}
async function stopRuntime(child){if(child.exitCode!==null)return;child.stdin.write("shutdown\n");await new Promise((resolve)=>child.once("exit",resolve))}
async function api(origin,plugin,route,method="GET"){const response=await fetch(`${origin}/plugins/${plugin}/api/${route}`,{method});assert.equal(response.status,200);return response.json()}

test("Product Hunt INTERCEPT collection validates, persists, and serializes with COOKIE work",async()=>{
  const productionAdapter=await readFile(path.join(root,"plugins/product-hunt/opencli-adapters/producthunt/today.js"),"utf8");assert.match(productionAdapter,/strategy:\s*Strategy\.INTERCEPT/);assert.match(productionAdapter,/installInterceptor\("producthunt\.com"\)/);
  assert.throws(()=>validateCollection([{rank:1,name:"Bad",votes:"1",url:"https://example.com/product"}]),/invalid/);
  const temp=await mkdtemp(path.join(os.tmpdir(),"infolens-task-scheduling-runtime-"));const dataRoot=path.join(temp,"data");const stateFile=path.join(temp,"state.json");await writeFile(stateFile,JSON.stringify({delayMs:150}));let runtime;
  try {
    runtime=await startRuntime(dataRoot,stateFile);assert.deepEqual(runtime.message.plugins.map(({id})=>id).sort(),["github-trending","hn","product-hunt","zhihu-hot"]);
    const [productHunt,zhihu]=await Promise.all([api(runtime.message.origin,"product-hunt","refresh","POST"),api(runtime.message.origin,"zhihu-hot","refresh","POST")]);assert.equal(productHunt.ok,true);assert.equal(productHunt.products.length,12);assert.equal(zhihu.ok,true);
    const calls=(await readFile(`${stateFile}.calls`,"utf8")).trim().split(/\r?\n/).map(JSON.parse);let browserActive=0;let browserPeak=0;for(const call of calls.filter(({command})=>command.includes("producthunt")||command.startsWith("zhihu"))){browserActive+=call.type==="start"?1:-1;browserPeak=Math.max(browserPeak,browserActive)}assert.equal(browserPeak,1);
    await api(runtime.message.origin,"product-hunt",`read?url=${encodeURIComponent(productHunt.products[0].url)}`,"POST");await stopRuntime(runtime.child);const store=openStore(path.join(dataRoot,"product-hunt","product-hunt.sqlite"));assert.equal(store.schemaVersion(),2);assert.equal(store.snapshotCount(),1);assert.equal(store.list()[0].read,true);store.close();
    runtime=await startRuntime(dataRoot,stateFile);const retained=await api(runtime.message.origin,"product-hunt","summary");assert.equal(retained.products.length,12);assert.equal(retained.products[0].read,true);
  } finally {if(runtime)await stopRuntime(runtime.child);await rm(temp,{recursive:true,force:true})}
});

test("Runtime deactivation cancels active plugin work and unregisters future activity",async()=>{
  const temp=await mkdtemp(path.join(os.tmpdir(),"infolens-task-scheduling-deactivate-"));const stateFile=path.join(temp,"state.json");await writeFile(stateFile,JSON.stringify({delayMs:10000}));let runtime;
  try {
    runtime=await startRuntime(path.join(temp,"data"),stateFile);const refresh=fetch(`${runtime.message.origin}/plugins/product-hunt/api/refresh`,{method:"POST"});
    for(let attempt=0;attempt<50;attempt+=1){const tasks=await fetch(`${runtime.message.origin}/runtime/tasks`).then((response)=>response.json());if(tasks.activePlugins.includes("product-hunt"))break;await new Promise((resolve)=>setTimeout(resolve,20))}
    const removed=await fetch(`${runtime.message.origin}/runtime/plugins/product-hunt`,{method:"DELETE"});assert.equal(removed.status,200);assert.equal((await removed.json()).ok,true);await refresh;
    const info=await fetch(`${runtime.message.origin}/runtime/info`).then((response)=>response.json());assert(!info.plugins.some(({id})=>id==="product-hunt"));const tasks=await fetch(`${runtime.message.origin}/runtime/tasks`).then((response)=>response.json());assert(!tasks.activePlugins.includes("product-hunt"));assert(!tasks.queued.some(({pluginId})=>pluginId==="product-hunt"));
    const activeOnExit=fetch(`${runtime.message.origin}/plugins/zhihu-hot/api/refresh`,{method:"POST"}).catch(()=>undefined);for(let attempt=0;attempt<50;attempt+=1){const current=await fetch(`${runtime.message.origin}/runtime/tasks`).then((response)=>response.json());if(current.activePlugins.includes("zhihu-hot"))break;await new Promise((resolve)=>setTimeout(resolve,20))}const started=Date.now();await stopRuntime(runtime.child);assert(Date.now()-started<5000,"Runtime shutdown should cancel active source work");await activeOnExit;
  } finally {if(runtime)await stopRuntime(runtime.child);await rm(temp,{recursive:true,force:true})}
});
