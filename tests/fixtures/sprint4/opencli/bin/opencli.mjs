import { appendFile, readFile } from "node:fs/promises";

if(process.env.OPENCLI_REGISTRATION_REPORT==="1"){
  process.stdout.write(JSON.stringify({commands:[],hooks:[],collisions:[]}));
  process.exit(0);
}

const command=process.argv.slice(2,4).join(" ");
const state=JSON.parse(await readFile(process.env.INFOLENS_TEST_OPENCLI_STATE,"utf8"));
await appendFile(`${process.env.INFOLENS_TEST_OPENCLI_STATE}.calls`,`${JSON.stringify(process.argv.slice(2))}\n`);
if(command==="hackernews top")process.stdout.write(JSON.stringify([{id:1,rank:1,title:"Public sibling remains available",score:100,author:"tester",comments:12,url:"https://example.com/hn"}]));
else if(command==="github-trending repos")process.stdout.write(JSON.stringify([{rank:1,repo:"infolens/runtime",description:"Public sibling remains available",language:"JavaScript",stars:100,forks:10,starsSince:5,url:"https://github.com/infolens/runtime"}]));
else if(command==="zhihu whoami"){
  const mode=state.zhihu??"success";
  if(mode==="disconnected"){process.stderr.write("Browser Bridge extension not connected\n");process.exit(69)}
  process.stdout.write(JSON.stringify([{logged_in:mode!=="expired",site:"zhihu"}]));
}else if(command==="zhihu hot"){
  const mode=state.zhihu??"success";
  if(mode==="disconnected"){process.stderr.write("Browser Bridge extension not connected\n");process.exit(69)}
  if(mode==="expired"){process.stderr.write("AUTH_REQUIRED: Zhihu login required\n");process.exit(77)}
  if(mode==="malformed"){process.stdout.write(JSON.stringify([{rank:1,title:"missing fields"}]));process.exit(0)}
  const version=state.zhihuDataVersion??1;
  process.stdout.write(JSON.stringify(Array.from({length:15},(_,index)=>({rank:index+1,title:`知乎热榜问题 v${version}-${index+1}`,heat:`${900-index*17} 万热度`,answers:120-index,url:`https://www.zhihu.com/question/${version*10000+index}`}))));
}else{process.stderr.write("unexpected command\n");process.exit(8)}
