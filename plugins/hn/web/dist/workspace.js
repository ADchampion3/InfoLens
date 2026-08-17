import { observeWorkspaceTheme, workspaceTheme } from "/runtime/plugin-sdk.js";
import { installHistoryControls } from "./history-controls.js";
import "./export-controls.js";
const applyInfolensTheme=(theme)=>document.documentElement.dataset.theme=theme;applyInfolensTheme(workspaceTheme());observeWorkspaceTheme(applyInfolensTheme);
document.querySelectorAll("svg").forEach((icon)=>icon.setAttribute("aria-hidden","true"));
const api = new URLSearchParams(location.search).get("apiBaseUrl");
const $ = (selector) => document.querySelector(selector);
let data;
let historyControls;
let detailTrigger;

async function request(route, options) { const response = await fetch(new URL(route, api), options); if (!response.ok) throw new Error(`插件 API 返回 ${response.status}`); return response.json(); }
function open(url) { window.open(url, "_blank", "noopener"); }
function showDetail(story, readOnly = false) {
  detailTrigger = document.activeElement;
  $("#detail-context").textContent = readOnly ? "Hacker News - History" : "Hacker News";
  $("#detail-title").textContent = story.title;
  $("#detail-meta").replaceChildren(...[
    story.domain || "news.ycombinator.com",
    `${story.points} points`,
    `by ${story.author}`,
    `${story.comments} comments`,
  ].map((value) => { const item = document.createElement("span"); item.textContent = value; return item; }));
  $("#detail-description").textContent = story.createdAt ? `Collected ${new Date(story.createdAt).toLocaleString()}.` : "";
  $("#detail-open").onclick = () => open(story.url);
  $("#detail-discussion").hidden = !story.discussionUrl;
  $("#detail-discussion").onclick = () => open(story.discussionUrl);
  $(".workspace").inert = true;
  $("#scrim").hidden = false;
  $("#detail-sheet").hidden = false;
  $("#close-detail").focus();
}
function closeDetail() {
  const trigger = detailTrigger;
  detailTrigger = undefined;
  $("#detail-sheet").hidden = true;
  $("#scrim").hidden = true;
  $(".workspace").inert = false;
  if (trigger?.isConnected) trigger.focus(); else $(".story-title")?.focus();
}
function row(story, readOnly=false) {
  const li=document.createElement("li"); li.className=`story-row${story.read?" is-read":""}`;
  const rank=document.createElement("span"); rank.className="rank"; rank.textContent=story.rank;
  const content=document.createElement("div"); content.className="story-content";
  const title=document.createElement("button"); title.className="story-title"; title.type="button"; title.textContent=story.title; title.onclick=async()=>{ if(readOnly)return showDetail(story,true); showDetail(story); data=await request(`read?id=${encodeURIComponent(story.id)}`,{method:"POST"}); render(data); };
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
async function refresh(){ historyControls?.clear(); const button=$("#refresh"); button.disabled=true; button.classList.add("spinning"); $("#refresh-time").textContent="正在刷新..."; try{const refreshed=await request("refresh",{method:"POST"});render(await request("summary").catch(()=>refreshed));}catch(error){const latest=await request("summary").catch(()=>data);render({...latest,lastError:latest?.lastError??error.message});}finally{button.classList.remove("spinning"); button.disabled=data?.settings?.policy==="disabled";} }
function showSettings(show){ $(".workspace").inert=show; $("#sheet").hidden=!show; $("#scrim").hidden=!show; if(show){ const settings=data.settings; document.querySelector(`[name=policy][value=${settings.policy}]`).checked=true; $("#interval").value=settings.intervalMinutes; $("#retention").value=settings.retentionDays; $("#interval").disabled=settings.policy!=="fixed"; $("#sheet input:checked").focus(); } else $("#settings").focus(); }
async function confirmQuestion(message,okLabel="继续",cancelLabel="取消"){let dialog=document.querySelector("#infolens-confirm-dialog");if(!dialog){dialog=document.createElement("dialog");dialog.id="infolens-confirm-dialog";dialog.innerHTML='<form method="dialog"><p class="confirm-message"></p><div class="confirm-actions"><button type="button" data-confirm-cancel></button><button type="submit" data-confirm-ok value="ok"></button></div></form>';dialog.querySelector("[data-confirm-cancel]").onclick=()=>dialog.close("cancel");document.body.append(dialog)}dialog.querySelector(".confirm-message").textContent=message;dialog.querySelector("[data-confirm-ok]").textContent=okLabel;dialog.querySelector("[data-confirm-cancel]").textContent=cancelLabel;dialog.showModal();return new Promise((resolve)=>dialog.addEventListener("close",()=>resolve(dialog.returnValue==="ok"),{once:true}))}
function installHistory(){historyControls=installHistoryControls({api,actions:$(".header-actions"),onSnapshot:(detail)=>{const stories=detail.records??[];$("#story-list").replaceChildren(...stories.map(story=>row(story,true)));$("#story-list").hidden=!stories.length;$("#empty").hidden=Boolean(stories.length);$("#warning").hidden=true},onCurrent:()=>render(data)});}
$("#refresh").onclick=$("#retry").onclick=$("#empty-refresh").onclick=refresh; $("#settings").onclick=()=>showSettings(true); $("#close-settings").onclick=$("#cancel-settings").onclick=()=>showSettings(false); $("#close-detail").onclick=closeDetail; $("#scrim").onclick=()=>$("#detail-sheet").hidden?showSettings(false):closeDetail();
document.querySelectorAll("[name=policy]").forEach((radio)=>radio.onchange=()=>$("#interval").disabled=radio.value!=="fixed");
$("#settings-form").onsubmit=async(event)=>{event.preventDefault();const form=new FormData(event.currentTarget);const retentionDays=Number(form.get("retentionDays"));const shorter=retentionDays<data.settings.retentionDays;if(shorter&&!await confirmQuestion("缩短保留期会永久删除较早快照。继续？"))return;await request(`settings?policy=${form.get("policy")}&intervalMinutes=${form.get("intervalMinutes")}&retentionDays=${retentionDays}&acknowledgeRetentionCleanup=${shorter}`,{method:"POST"});data=await request("summary");render(data);showSettings(false);};
addEventListener("keydown",(event)=>{if(event.key!=="Escape")return;if(!$("#detail-sheet").hidden)closeDetail();else if(!$("#sheet").hidden)showSettings(false);});
installHistory();load().catch((error)=>{$("#story-list").innerHTML=`<li class="loading-row">${error.message}</li>`;});
