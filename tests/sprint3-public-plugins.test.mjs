import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { test } from "node:test";
import { openStore as openHnStore } from "../plugins/hn/backend/storage.js";
import { openStore as openGithubStore } from "../plugins/github-trending/backend/storage.js";
import { validateCollection as validateHn } from "../plugins/hn/backend/index.js";
import { validateCollection as validateGithub } from "../plugins/github-trending/backend/index.js";
import { loadBundledOpenCli } from "../packages/plugin-runtime/src/opencli-adapter.mjs";

const root = path.resolve(import.meta.dirname, "..");
const mockOpenCli = path.join(root, "tests/fixtures/sprint3/opencli");

test("production distribution pins official OpenCLI and its two built-in PUBLIC adapters", async () => {
  const distribution=path.join(root,"resources/opencli");
  const runtime=await loadBundledOpenCli(distribution);
  assert.equal(runtime.version,"1.8.6"); assert.equal(runtime.packageName,"@jackwener/opencli");
  assert.match(runtime.executablePath,/node_modules[\\/]@jackwener[\\/]opencli[\\/]dist[\\/]src[\\/]main\.js$/);
  const hackerNewsAdapter=await readFile(path.join(distribution,"node_modules/@jackwener/opencli/clis/hackernews/top.js"),"utf8");
  const githubAdapter=await readFile(path.join(distribution,"node_modules/@jackwener/opencli/clis/github-trending/repos.js"),"utf8");
  assert.match(hackerNewsAdapter,/site:\s*'hackernews'/); assert.match(hackerNewsAdapter,/name:\s*'top'/); assert.match(hackerNewsAdapter,/Strategy\.PUBLIC/);
  assert.match(githubAdapter,/site:\s*'github-trending'/); assert.match(githubAdapter,/name:\s*'repos'/); assert.match(githubAdapter,/Strategy\.PUBLIC/);
  const githubReadmeAdapter=await readFile(path.join(root,"plugins/github-trending/opencli-adapters/github-readme/readme.js"),"utf8");
  assert.match(githubReadmeAdapter,/name:\s*"readme"/); assert.match(githubReadmeAdapter,/Strategy\.PUBLIC/); assert.match(githubReadmeAdapter,/EmptyResultError/);
});

async function startRuntime(dataRoot, stateFile) {
  const child = spawn(process.execPath, [path.join(root, "packages/plugin-runtime/src/server.mjs")], { cwd: root, env: { ...process.env, INFOLENS_PROJECT_ROOT: root, INFOLENS_PLUGIN_DATA_ROOT: dataRoot, INFOLENS_BUNDLED_OPENCLI_ROOT: mockOpenCli, INFOLENS_TEST_OPENCLI_STATE: stateFile, INFOLENS_RUNTIME_PORT: "0" }, stdio: ["pipe", "pipe", "pipe"] });
  const lines = readline.createInterface({ input: child.stdout });
  return new Promise((resolve, reject) => {
    const errors=[]; child.stderr.on("data",chunk=>errors.push(chunk)); child.once("error",reject);
    const timeout=setTimeout(()=>reject(new Error(`Runtime start timed out: ${Buffer.concat(errors).toString()}`)),5000);
    lines.on("line",line=>{ const message=JSON.parse(line); if(message.type==="runtime-ready"){clearTimeout(timeout);resolve({child,message});} });
  });
}
async function stopRuntime(child){if(child.exitCode!==null)return; child.stdin.write("shutdown\n"); await new Promise(resolve=>child.once("exit",resolve));}
async function api(origin, plugin, route, method="GET"){const response=await fetch(`${origin}/plugins/${plugin}/api/${route}`,{method});assert.equal(response.status,200,`${plugin} ${route}`);return response.json();}

test("plugin-owned SQLite migrations and validators reject malformed public results", async () => {
  const temp=await mkdtemp(path.join(os.tmpdir(),"infolens-sprint3-store-"));
  try {
    const hn=openHnStore(path.join(temp,"hn.sqlite")); const gh=openGithubStore(path.join(temp,"github.sqlite"));
    assert.equal(hn.schemaVersion(),2); assert.equal(gh.schemaVersion(),3); assert.deepEqual({...hn.settings()},{policy:"manual",intervalMinutes:60,retentionDays:30}); assert.deepEqual({...gh.settings()},{policy:"manual",intervalMinutes:60,retentionDays:30});
    hn.close(); gh.close();
    const reopened=openHnStore(path.join(temp,"hn.sqlite")); assert.equal(reopened.schemaVersion(),2); reopened.close();
    assert.throws(()=>validateHn([{}]),/invalid/); assert.throws(()=>validateGithub("bad"),/must contain/);
  } finally { await rm(temp,{recursive:true,force:true}); }
});

test("Hacker News validator accepts native job rows with missing or null comments", () => {
  const stories = validateHn([{
    rank: 27,
    id: 49072523,
    title: "UpCodes is hiring",
    score: 1,
    author: "whoishiring",
    url: "https://up.codes/careers",
  }, {
    rank: 28,
    id: 49072524,
    title: "Another team is hiring",
    score: 1,
    author: "whoishiring",
    comments: null,
    url: "https://example.com/careers",
  }]);
  assert.deepEqual(stories.map(({ comments }) => comments), [0, 0]);
});

test("both PUBLIC plugins persist independently, reopen retained content, and preserve it after failures", async () => {
  const temp=await mkdtemp(path.join(os.tmpdir(),"infolens-sprint3-runtime-")); const dataRoot=path.join(temp,"data"); const stateFile=path.join(temp,"state.json"); await writeFile(stateFile,JSON.stringify({hn:"success",github:"success"}));
  let runtime;
  try {
    runtime=await startRuntime(dataRoot,stateFile); const {origin,plugins}=runtime.message; assert.deepEqual(plugins.map(({id})=>id).sort(),["github-trending","hn"]);
    let hn=await api(origin,"hn","summary"); let gh=await api(origin,"github-trending","summary"); assert.equal(hn.stories.length,0); assert.equal(gh.repositories.length,0);
    hn=await api(origin,"hn","refresh","POST"); gh=await api(origin,"github-trending","refresh","POST"); assert.equal(hn.ok,true); assert.equal(hn.stories.length,15); assert.equal(gh.repositories.length,12);
    const calls=(await readFile(`${stateFile}.calls`,"utf8")).trim().split(/\r?\n/).map(JSON.parse);
    assert.deepEqual(calls[0],["hackernews","top","--limit=30","-f","json"]); assert.deepEqual(calls[1],["github-trending","repos","--since=daily","--limit=25","-f","json"]);
    hn=await api(origin,"hn","read?id=1","POST"); assert.equal(hn.stories[0].read,true); gh=await api(origin,"github-trending","read?id=owner0%2Frepo0","POST"); assert.equal(gh.repositories[0].read,true);
    const readme=await api(origin,"github-trending","readme?id=owner0%2Frepo0"); assert.equal(readme.ok,true); assert.equal(readme.cached,false); assert.match(readme.readme.html,/Fixture README/);
    assert.deepEqual(await api(origin,"hn","settings?policy=fixed&intervalMinutes=360","POST"),{policy:"fixed",intervalMinutes:360,retentionDays:30}); assert.deepEqual(await api(origin,"github-trending","settings"),{policy:"manual",intervalMinutes:60,retentionDays:30});
    await api(origin,"github-trending","settings?policy=disabled&intervalMinutes=60","POST"); const disabled=await api(origin,"github-trending","refresh","POST"); assert.equal(disabled.disabled,true);
    await stopRuntime(runtime.child);
    const persistedHn=openHnStore(path.join(dataRoot,"hn","hacker-news.sqlite")); const persistedGithub=openGithubStore(path.join(dataRoot,"github-trending","github-trending.sqlite"));
    assert.equal(persistedHn.snapshotCount(),1); assert.equal(persistedGithub.snapshotCount(),1); persistedHn.close(); persistedGithub.close();
    runtime=await startRuntime(dataRoot,stateFile);
    hn=await api(runtime.message.origin,"hn","summary"); gh=await api(runtime.message.origin,"github-trending","summary"); assert.equal(hn.stories.length,15); assert.equal(hn.stories[0].read,true); assert.equal(hn.settings.policy,"fixed"); assert.equal(gh.repositories.length,12); assert.equal(gh.repositories[0].read,true); assert.equal(gh.settings.policy,"disabled");
    const cachedReadme=await api(runtime.message.origin,"github-trending","readme?id=owner0%2Frepo0"); assert.equal(cachedReadme.cached,true); assert.match(cachedReadme.readme.html,/Fixture README/);
    await writeFile(stateFile,JSON.stringify({hn:"malformed",github:"exit"})); const hnFailed=await api(runtime.message.origin,"hn","refresh","POST"); assert.equal(hnFailed.ok,false); assert.equal(hnFailed.stories.length,15); assert.match(hnFailed.lastError,/invalid/);
    await api(runtime.message.origin,"github-trending","settings?policy=manual&intervalMinutes=60","POST"); const ghFailed=await api(runtime.message.origin,"github-trending","refresh","POST"); assert.equal(ghFailed.ok,false); assert.equal(ghFailed.repositories.length,12); assert.match(ghFailed.lastError,/source unavailable/);
    const hnDb=await readFile(path.join(dataRoot,"hn","hacker-news.sqlite")); const ghDb=await readFile(path.join(dataRoot,"github-trending","github-trending.sqlite")); assert.notDeepEqual(hnDb,ghDb);
  } finally { if(runtime)await stopRuntime(runtime.child); await rm(temp,{recursive:true,force:true}); }
});
