import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";

const root=path.resolve(import.meta.dirname,"..");
const profile=path.join(root,".infolens-acceptance","sprint3");
const stateFile=path.join(profile,"opencli-state.json");
await mkdir(profile,{recursive:true});
await writeFile(stateFile,JSON.stringify({hn:"success",github:"success"}));

const runtime=spawn(process.execPath,[path.join(root,"packages/plugin-runtime/src/server.mjs")],{cwd:root,env:{...process.env,INFOLENS_PROJECT_ROOT:root,INFOLENS_PLUGIN_DATA_ROOT:path.join(profile,"data"),INFOLENS_BUNDLED_OPENCLI_ROOT:path.join(root,"tests/fixtures/sprint3/opencli"),INFOLENS_TEST_OPENCLI_STATE:stateFile,INFOLENS_RUNTIME_PORT:"0"},stdio:["pipe","pipe","ignore"]});
const lines=readline.createInterface({input:runtime.stdout});
let origin;
for await (const line of lines){const message=JSON.parse(line);if(message.type==="runtime-ready"){origin=message.origin;break;}}
for(const plugin of ["hn","github-trending"]){const summary=await fetch(`${origin}/plugins/${plugin}/api/summary`).then(r=>r.json());const empty=plugin==="hn"?summary.stories.length===0:summary.repositories.length===0;if(empty)await fetch(`${origin}/plugins/${plugin}/api/refresh`,{method:"POST"});}
const npmCli=path.join(path.dirname(process.execPath),"node_modules","npm","bin","npm-cli.js");
const vite=spawn(process.execPath,[npmCli,"run","dev:web","--","--host","127.0.0.1","--port","4173"],{cwd:root,stdio:"ignore",windowsHide:true});
const acceptanceUrl=`http://127.0.0.1:4173/?runtimeOrigin=${encodeURIComponent(origin)}`;
await writeFile(path.join(profile,"url.txt"),acceptanceUrl);
let stopping=false;async function stop(){if(stopping)return;stopping=true;vite.kill();runtime.stdin.write("shutdown\n");}
process.on("SIGINT",stop);process.on("SIGTERM",stop);runtime.on("exit",()=>{vite.kill();process.exit(0)});vite.on("exit",()=>{if(!stopping)runtime.stdin.write("shutdown\n")});
