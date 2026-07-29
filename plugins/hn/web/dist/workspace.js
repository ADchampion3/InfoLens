const infolensThemeParams=new URLSearchParams(location.search);const applyInfolensTheme=(theme)=>document.documentElement.dataset.theme=theme==="dark"?"dark":"light";applyInfolensTheme(infolensThemeParams.get("theme"));addEventListener("message",(event)=>{if(event.data?.type==="infolens:theme")applyInfolensTheme(event.data.theme)});
const api = new URLSearchParams(location.search).get("apiBaseUrl");
const $ = (selector) => document.querySelector(selector);
let data;

async function request(route, options) { const response = await fetch(new URL(route, api), options); if (!response.ok) throw new Error(`插件 API 返回 ${response.status}`); return response.json(); }
function open(url) { window.open(url, "_blank", "noopener"); }
function row(story) {
  const li=document.createElement("li"); li.className=`story-row${story.read?" is-read":""}`;
  const rank=document.createElement("span"); rank.className="rank"; rank.textContent=story.rank;
  const content=document.createElement("div"); content.className="story-content";
  const title=document.createElement("button"); title.className="story-title"; title.textContent=story.title; title.onclick=async()=>{ open(story.url); data=await request(`read?id=${encodeURIComponent(story.id)}`,{method:"POST"}); render(data); };
  const domain=document.createElement("span"); domain.className="domain"; domain.textContent=story.domain;
  const meta=document.createElement("div"); meta.className="metadata"; meta.textContent=`${story.points} 分 · 作者 ${story.author} · ${story.read?"已读":"未读"}`;
  const comments=document.createElement("button"); comments.className="comments"; comments.textContent=`${story.comments} 条评论`; comments.onclick=()=>open(story.discussionUrl);
  content.append(title,domain,meta); li.append(rank,content,comments); return li;
}
function render(next) {
  data=next; const stories=next.stories??[]; $("#story-list").replaceChildren(...stories.map(row)); $("#story-list").hidden=!stories.length; $("#empty").hidden=Boolean(stories.length);
  $("#warning").hidden=!next.lastError; const date=next.lastSuccessfulRefresh&&new Date(next.lastSuccessfulRefresh); $("#refresh-time").textContent=date?`上次刷新 ${new Intl.DateTimeFormat("zh-CN",{month:"numeric",day:"numeric",hour:"2-digit",minute:"2-digit"}).format(date)}`:"尚未刷新";
  $("#refresh").disabled=next.settings?.policy==="disabled";
}
async function load(){ if(!api) throw new Error("缺少插件 API 配置"); render(await request("summary")); }
async function refresh(){ const button=$("#refresh"); button.disabled=true; button.classList.add("spinning"); $("#refresh-time").textContent="正在刷新..."; try{await request("refresh",{method:"POST"});render(await request("summary"));}catch(error){const latest=await request("summary").catch(()=>data);render({...latest,lastError:latest?.lastError??error.message});}finally{button.classList.remove("spinning"); button.disabled=data?.settings?.policy==="disabled";} }
function showSettings(show){ $("#sheet").hidden=!show; $("#scrim").hidden=!show; if(show){ const settings=data.settings; document.querySelector(`[name=policy][value=${settings.policy}]`).checked=true; $("#interval").value=settings.intervalMinutes; $("#interval").disabled=settings.policy!=="fixed"; $("#sheet input:checked").focus(); } else $("#settings").focus(); }
$("#refresh").onclick=$("#retry").onclick=$("#empty-refresh").onclick=refresh; $("#settings").onclick=()=>showSettings(true); $("#close-settings").onclick=$("#cancel-settings").onclick=$("#scrim").onclick=()=>showSettings(false);
document.querySelectorAll("[name=policy]").forEach((radio)=>radio.onchange=()=>$("#interval").disabled=radio.value!=="fixed");
$("#settings-form").onsubmit=async(event)=>{event.preventDefault();const form=new FormData(event.currentTarget);await request(`settings?policy=${form.get("policy")}&intervalMinutes=${form.get("intervalMinutes")}`,{method:"POST"});data=await request("summary");render(data);showSettings(false);};
addEventListener("keydown",(event)=>{if(event.key==="Escape"&&!$("#sheet").hidden)showSettings(false);});
load().catch((error)=>{$("#story-list").innerHTML=`<li class="loading-row">${error.message}</li>`;});
