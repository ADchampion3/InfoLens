import { appendFile, readFile } from "node:fs/promises";

if(process.env.OPENCLI_REGISTRATION_REPORT==="1"){
  const paths=process.env.OPENCLI_PLUGIN_PATHS??"";
  const commands=paths.includes("io.infolens.github-readme")?[{command:"infolens-github/readme",strategy:"public",access:"read"}]:[{command:"infolens-producthunt/today",strategy:"intercept",access:"read"}];
  process.stdout.write(JSON.stringify({commands,hooks:[],collisions:[]}));
  process.exit(0);
}

const command=process.argv.slice(2,4).join(" ");
const stateFile=process.env.INFOLENS_TEST_OPENCLI_STATE;
const state=JSON.parse(await readFile(stateFile,"utf8"));
const delay=(milliseconds)=>new Promise((resolve)=>setTimeout(resolve,milliseconds));
await appendFile(`${stateFile}.calls`,`${JSON.stringify({type:"start",command,at:Date.now(),args:process.argv.slice(2)})}\n`);
if(state.delayMs)await delay(state.delayMs);
if(command==="hackernews top")process.stdout.write(JSON.stringify([{id:1,rank:1,title:"Public sibling remains available",score:100,author:"tester",comments:12,url:"https://example.com/hn"}]));
else if(command==="github-trending repos")process.stdout.write(JSON.stringify([{rank:1,repo:"infolens/runtime",description:"Public sibling remains available",language:"JavaScript",stars:100,forks:10,starsSince:5,url:"https://github.com/infolens/runtime"}]));
else if(command==="zhihu whoami")process.stdout.write(JSON.stringify([{logged_in:true,site:"zhihu"}]));
else if(command==="zhihu hot")process.stdout.write(JSON.stringify([{rank:1,title:"Browser sibling",heat:"1000 heat",answers:12,url:"https://www.zhihu.com/question/10001"}]));
else if(command==="infolens-producthunt today"){
  if(state.producthunt==="disconnected"){process.stderr.write("Browser Bridge extension not connected\n");process.exitCode=69}
  else if(state.producthunt==="malformed")process.stdout.write(JSON.stringify([{rank:1,name:"Missing votes"}]));
  else process.stdout.write(JSON.stringify(Array.from({length:12},(_,index)=>({rank:index+1,name:`Launch ${index+1}`,votes:String(900-index*31),url:`https://www.producthunt.com/products/launch-${index+1}`}))));
}else{process.stderr.write("unexpected command\n");process.exitCode=8}
await appendFile(`${stateFile}.calls`,`${JSON.stringify({type:"end",command,at:Date.now()})}\n`);
