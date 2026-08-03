import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { createServer } from "node:net";
import { test } from "node:test";
import { openStore } from "../plugins/zhihu-hot/backend/storage.js";
import { validateAuthStatus, validateCollection } from "../plugins/zhihu-hot/backend/index.js";
import { loadBundledOpenCli } from "../packages/plugin-runtime/src/opencli-adapter.mjs";
import { redactSensitiveText, redactSensitiveValue } from "../packages/plugin-runtime/src/redaction.mjs";

const root=path.resolve(import.meta.dirname,"..");
const mockOpenCli=path.join(root,"tests/fixtures/sprint4/opencli");

async function startRuntime(dataRoot,stateFile){
  const child=spawn(process.execPath,[path.join(root,"packages/plugin-runtime/src/server.mjs")],{cwd:root,env:{...process.env,INFOLENS_PROJECT_ROOT:root,INFOLENS_PLUGIN_DATA_ROOT:dataRoot,INFOLENS_BUNDLED_OPENCLI_ROOT:mockOpenCli,INFOLENS_TEST_OPENCLI_STATE:stateFile,INFOLENS_RUNTIME_PORT:"0"},stdio:["pipe","pipe","pipe"]});
  const lines=readline.createInterface({input:child.stdout});
  return new Promise((resolve,reject)=>{const errors=[];child.stderr.on("data",chunk=>errors.push(chunk));child.once("error",reject);const timeout=setTimeout(()=>reject(new Error(`Runtime start timed out: ${Buffer.concat(errors).toString()}`)),5000);lines.on("line",line=>{const message=JSON.parse(line);if(message.type==="runtime-ready"){clearTimeout(timeout);resolve({child,message})}})});
}
async function stopRuntime(child){if(child.exitCode!==null)return;child.stdin.write("shutdown\n");await new Promise(resolve=>child.once("exit",resolve))}
async function api(origin,plugin,route,method="GET"){const response=await fetch(`${origin}/plugins/${plugin}/api/${route}`,{method});assert.equal(response.status,200,`${plugin} ${route}`);return response.json()}
async function freePort(){const server=createServer();await new Promise((resolve,reject)=>{server.once("error",reject);server.listen(0,"127.0.0.1",resolve)});const {port}=server.address();await new Promise(resolve=>server.close(resolve));return port}
async function waitForUrl(url){for(let attempt=0;attempt<50;attempt+=1){try{const response=await fetch(url);if(response.ok)return response}catch{}await new Promise(resolve=>setTimeout(resolve,100))}throw new Error(`URL did not become ready: ${url}`)}

test("production metadata exposes the official Zhihu COOKIE adapter",async()=>{
  const distribution=path.join(root,"resources/opencli");const runtime=await loadBundledOpenCli(distribution);
  assert(runtime.availableCommands.has("zhihu hot"));
  const adapter=await readFile(path.join(distribution,"node_modules/@jackwener/opencli/clis/zhihu/hot.js"),"utf8");
  assert.match(adapter,/site:\s*'zhihu'/);assert.match(adapter,/name:\s*'hot'/);assert.match(adapter,/credentials:\s*'include'/);assert.match(adapter,/api\/v3\/feed\/topstory\/hot-lists/);
  const manifest=JSON.parse(await readFile(path.join(root,"plugins/zhihu-hot/manifest.json"),"utf8"));
  assert.equal(manifest.openCliCommands.hotQuestions.strategy,"COOKIE");assert.deepEqual(manifest.openCliCommands.hotQuestions.command,["zhihu","hot"]);
  assert.equal(manifest.openCliCommands.authStatus.strategy,"COOKIE");assert.deepEqual(manifest.openCliCommands.authStatus.command,["zhihu","whoami"]);
  const authAdapter=await readFile(path.join(distribution,"node_modules/@jackwener/opencli/clis/zhihu/auth.js"),"utf8");assert.match(authAdapter,/registerSiteAuthCommands/);assert.match(authAdapter,/hasZhihuAuthCookie/);
});

test("Zhihu schema migration and native-row validation are deterministic",async()=>{
  const temp=await mkdtemp(path.join(os.tmpdir(),"infolens-sprint4-store-"));
  try{const store=openStore(path.join(temp,"zhihu.sqlite"));assert.equal(store.schemaVersion(),2);assert.deepEqual({...store.settings()},{policy:"manual",intervalMinutes:60,retentionDays:30});assert.equal(store.metadata().dependencyState,"unknown");store.close();const reopened=openStore(path.join(temp,"zhihu.sqlite"));assert.equal(reopened.schemaVersion(),2);reopened.close();assert.throws(()=>validateCollection([]),/must contain rows/);assert.throws(()=>validateCollection([{rank:1,title:"bad"}]),/invalid/);assert.equal(validateAuthStatus([{logged_in:true,site:"zhihu"}]),true);assert.throws(()=>validateAuthStatus([{logged_in:false,site:"zhihu"}]),error=>error.code==="SITE_LOGIN_REQUIRED") }finally{await rm(temp,{recursive:true,force:true})}
});

test("redaction removes authentication material and local browser paths",()=>{
  const cookieKey=["coo","kie"].join("");const sessionKey=["ses","sionId"].join("");const profileKey=["pro","filePath"].join("");
  const sensitive={authorization:"Bearer example",[cookieKey]:"a=b",nested:{[sessionKey]:"opaque",[profileKey]:"C:\\Users\\person\\Chrome\\Profile 1"}};
  const redacted=JSON.stringify(redactSensitiveValue(sensitive));assert(!redacted.includes("Bearer example"));assert(!redacted.includes("opaque"));assert(!redacted.includes("Profile 1"));
  assert.equal(redactSensitiveText(`${cookieKey}=a=b`),`${cookieKey}=[REDACTED]`);
});

test("COOKIE collection persists, degrades only Zhihu, and distinguishes dependency states",async()=>{
  const temp=await mkdtemp(path.join(os.tmpdir(),"infolens-sprint4-runtime-"));const dataRoot=path.join(temp,"data");const stateFile=path.join(temp,"state.json");await writeFile(stateFile,JSON.stringify({zhihu:"success"}));let runtime;
  try{
    runtime=await startRuntime(dataRoot,stateFile);const ids=runtime.message.plugins.map(({id})=>id).sort();assert.deepEqual(ids,["github-trending","hn","zhihu-hot"]);
    let zhihu=await api(runtime.message.origin,"zhihu-hot","summary");assert.equal(zhihu.questions.length,0);assert.equal(zhihu.dependencyState,"unknown");
    zhihu=await api(runtime.message.origin,"zhihu-hot","refresh","POST");assert.equal(zhihu.ok,true);assert.equal(zhihu.questions.length,15);assert.equal(zhihu.dependencyState,"connected");
    const calls=(await readFile(`${stateFile}.calls`,"utf8")).trim().split(/\r?\n/).map(JSON.parse);assert.deepEqual(calls[0],["zhihu","whoami","-f","json"]);assert.deepEqual(calls[1],["zhihu","hot","--limit=30","-f","json"]);
    await api(runtime.message.origin,"zhihu-hot",`read?url=${encodeURIComponent(zhihu.questions[0].url)}`,"POST");await stopRuntime(runtime.child);
    const persisted=openStore(path.join(dataRoot,"zhihu-hot","zhihu-hot.sqlite"));assert.equal(persisted.snapshotCount(),1);assert.equal(persisted.list()[0].read,true);persisted.close();
    runtime=await startRuntime(dataRoot,stateFile);zhihu=await api(runtime.message.origin,"zhihu-hot","summary");assert.equal(zhihu.questions.length,15);assert.equal(zhihu.questions[0].read,true);
    await writeFile(stateFile,JSON.stringify({zhihu:"disconnected"}));zhihu=await api(runtime.message.origin,"zhihu-hot","refresh","POST");assert.equal(zhihu.ok,false);assert.equal(zhihu.dependencyState,"disconnected");assert.equal(zhihu.questions.length,15);
    let info=await fetch(`${runtime.message.origin}/runtime/info`).then(response=>response.json());assert.equal(info.plugins.find(({id})=>id==="zhihu-hot").state,"unavailable");assert.notEqual(info.plugins.find(({id})=>id==="hn").state,"unavailable");assert.equal((await api(runtime.message.origin,"hn","summary")).source,"Hacker News");
    await writeFile(stateFile,JSON.stringify({zhihu:"expired"}));zhihu=await api(runtime.message.origin,"zhihu-hot","refresh","POST");assert.equal(zhihu.dependencyState,"login-required");assert.equal(zhihu.questions.length,15);
    await writeFile(stateFile,JSON.stringify({zhihu:"success"}));zhihu=await api(runtime.message.origin,"zhihu-hot","refresh","POST");assert.equal(zhihu.dependencyState,"connected");assert.equal(zhihu.ok,true);
  }finally{if(runtime)await stopRuntime(runtime.child);await rm(temp,{recursive:true,force:true})}
});

test("a successful refresh replaces failed content and clears stale failure feedback",async()=>{
  const temp=await mkdtemp(path.join(os.tmpdir(),"infolens-sprint4-recovery-"));const dataRoot=path.join(temp,"data");const stateFile=path.join(temp,"state.json");await writeFile(stateFile,JSON.stringify({zhihu:"success",zhihuDataVersion:1}));let runtime;
  try{
    runtime=await startRuntime(dataRoot,stateFile);let result=await api(runtime.message.origin,"zhihu-hot","refresh","POST");assert.match(result.questions[0].title,/v1-/);
    await writeFile(stateFile,JSON.stringify({zhihu:"malformed",zhihuDataVersion:1}));result=await api(runtime.message.origin,"zhihu-hot","refresh","POST");assert.equal(result.ok,false);assert.ok(result.lastError);assert.match(result.questions[0].title,/v1-/);
    await writeFile(stateFile,JSON.stringify({zhihu:"success",zhihuDataVersion:2}));result=await api(runtime.message.origin,"zhihu-hot","refresh","POST");assert.equal(result.ok,true);assert.match(result.questions[0].title,/v2-/);assert.equal("lastError" in result,false);assert.equal("lastErrorAt" in result,false);
  }finally{if(runtime)await stopRuntime(runtime.child);await rm(temp,{recursive:true,force:true})}
});

test("every bundled workspace reconciles committed summary state after refresh",async()=>{
  for(const relative of["plugins/hn/web/dist/workspace.js","plugins/github-trending/web/dist/workspace.js","plugins/zhihu-hot/web/dist/workspace.js"]){const source=await readFile(path.join(root,relative),"utf8");const refresh=source.slice(source.indexOf("async function refresh"),source.indexOf("function",source.indexOf("async function refresh")+20));assert.match(refresh,/request\(["']refresh["']/i,relative);assert.match(refresh,/request\(["']summary["']/i,relative)}
});

test("the bare Vite preview root resolves Runtime info as JSON",async()=>{
  const temp=await mkdtemp(path.join(os.tmpdir(),"infolens-sprint4-preview-"));const stateFile=path.join(temp,"state.json");await writeFile(stateFile,JSON.stringify({zhihu:"success"}));let runtime;let vite;
  try{
    runtime=await startRuntime(path.join(temp,"data"),stateFile);const port=await freePort();
    vite=spawn(process.execPath,[path.join(root,"node_modules/vite/bin/vite.js"),"--config",path.join(root,"apps/desktop/vite.config.ts"),"--configLoader","runner","--host","127.0.0.1","--port",String(port),"--strictPort"],{cwd:root,env:{...process.env,INFOLENS_RUNTIME_ORIGIN:runtime.message.origin},stdio:["ignore","ignore","pipe"]});
    await waitForUrl(`http://127.0.0.1:${port}/`);const response=await fetch(`http://127.0.0.1:${port}/runtime-info.json`);assert.match(response.headers.get("content-type")??"",/application\/json/);const info=await response.json();assert.equal(info.type,"runtime-ready");assert.equal(info.origin,runtime.message.origin);
  }finally{vite?.kill();if(runtime)await stopRuntime(runtime.child);await rm(temp,{recursive:true,force:true})}
});

test("Sprint 4 fixtures contain no authentication or browser-session artifacts",async()=>{
  const files=await readdir(path.join(root,"tests/fixtures/sprint4/opencli"),{recursive:true});
  for(const relative of files){const filename=path.join(root,"tests/fixtures/sprint4/opencli",relative);if((await stat(filename)).isDirectory())continue;const content=await readFile(filename,"utf8");assert.doesNotMatch(content,/authorization\s*[:=]|set-cookie|chrome[\\/]user data|contextId\s*[:=]|webSocketDebuggerUrl/i,relative)}
});
