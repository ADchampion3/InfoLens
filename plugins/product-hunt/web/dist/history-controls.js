export { confirmQuestion, installHistoryControls } from "/runtime/plugin-sdk-history.js";
/*
export async function confirmQuestion(message, okLabel="继续", cancelLabel="取消") {
  let dialog=document.querySelector("#infolens-confirm-dialog");
  if(!dialog){dialog=document.createElement("dialog");dialog.id="infolens-confirm-dialog";dialog.innerHTML=`<form method="dialog"><p class="confirm-message"></p><div class="confirm-actions"><button type="button" data-confirm-cancel></button><button type="submit" data-confirm-ok value="ok"></button></div></form>`;dialog.querySelector("[data-confirm-cancel]").onclick=()=>dialog.close("cancel");document.body.append(dialog)}
  dialog.querySelector(".confirm-message").textContent=message;
  dialog.querySelector("[data-confirm-ok]").textContent=okLabel;
  dialog.querySelector("[data-confirm-cancel]").textContent=cancelLabel;
  dialog.showModal();
  return new Promise((resolve)=>dialog.addEventListener("close",()=>resolve(dialog.returnValue==="ok"),{once:true}));
}
*/

/*
export function installHistoryControls({api,actions,label,locale="zh-CN"}) {
  if (!actions || actions.querySelector("[data-history-control]")) return;
  let offset=0;
  const request=async(route)=>{const response=await fetch(new URL(route,api));if(!response.ok)throw new Error(`Plugin API returned ${response.status}`);return response.json()};
  const history=document.createElement("button");history.type="button";history.dataset.historyControl="true";history.className=actions.firstElementChild?.classList.contains("icon")?"icon":"icon-button";history.title=locale==="en"?"History":"历史";history.setAttribute("aria-label",history.title);history.textContent="◷";
  const download=document.createElement("button");download.type="button";download.dataset.historyControl="true";download.className=history.className;download.title=locale==="en"?"Export":"导出";download.setAttribute("aria-label",download.title);download.textContent="⇩";
  let dialog=document.querySelector("#collection-history-dialog");
  if(!dialog){dialog=document.createElement("dialog");dialog.id="collection-history-dialog";dialog.innerHTML=`<header><h2>${locale==="en"?"Collection history":"历史快照"}</h2><button type="button" aria-label="${locale==="en"?"Close":"关闭"}">×</button></header><p class="history-privacy">${locale==="en"?"Exports may contain private source content.":"导出文件可能包含私有来源内容。"}</p><div class="history-items"></div><button class="history-more" type="button">${locale==="en"?"Load more":"加载更多"}</button>`;document.body.append(dialog);dialog.querySelector("header button").onclick=()=>dialog.close()}
  const load=async(reset=false)=>{if(reset){offset=0;dialog.querySelector(".history-items").replaceChildren()}const page=await request(`history?limit=20&offset=${offset}`);for(const snapshot of page.items){const button=document.createElement("button");button.type="button";button.disabled=!snapshot.available;button.textContent=snapshot.available?`${new Date(snapshot.collectedAt).toLocaleString(locale)} · ${snapshot.recordCount}`:`${new Date(snapshot.collectedAt).toLocaleString(locale)} · ${locale==="en"?"Unavailable":"不可用"}`;button.onclick=async()=>{const detail=await request(`history/snapshot?id=${snapshot.id}`);const list=document.createElement("ol");for(const record of detail.records??[]){const item=document.createElement("li");item.textContent=`${label(record)}${record.read?(locale==="en"?" · Read":" · 已读"):""}`;list.append(item)}dialog.querySelector(".history-items").replaceChildren(list)};dialog.querySelector(".history-items").append(button)}offset+=page.items.length;dialog.querySelector(".history-more").hidden=offset>=page.total};
  const triggerDownload=async()=>{
    const anchor=document.createElement("a");
    try{
      const response=await fetch(new URL("export",api));
      if(!response.ok)throw new Error(`Plugin API returned ${response.status}`);
      const filename=/filename="?([^";]+)"?/.exec(response.headers.get("content-disposition")??"")?.[1]??`history-${new Date().toISOString().slice(0,10)}.json`;
      anchor.href=URL.createObjectURL(await response.blob());
      anchor.download=filename;
      document.body.append(anchor);anchor.click();anchor.remove();
      URL.revokeObjectURL(anchor.href);
    }catch(error){
      await confirmQuestion(locale==="en"?`Export failed: ${error.message}`:`导出失败：${error.message}`,locale==="en"?"OK":"知道了",locale==="en"?"Close":"关闭");
    }
  };
  dialog.querySelector(".history-more").onclick=()=>load();
  history.onclick=async()=>{dialog.showModal();await load(true)};
  download.onclick=async()=>{if(await confirmQuestion(locale==="en"?"The export may contain private source content. Continue?":"导出文件可能包含私有来源内容。继续下载？",locale==="en"?"Continue":"继续下载",locale==="en"?"Cancel":"取消"))await triggerDownload()};
  actions.prepend(history,download);
  if(!document.querySelector("#collection-history-style")){const style=document.createElement("style");style.id="collection-history-style";style.textContent="#collection-history-dialog{width:min(36rem,calc(100% - 2rem));max-height:80vh;padding:1rem}.history-items{display:grid;gap:.5rem;margin:1rem 0}.history-items>button{min-height:2.75rem;text-align:start}.history-items ol{padding-inline-start:1.5rem}#collection-history-dialog header{display:flex;justify-content:space-between;align-items:center}.history-privacy{font-size:.875rem}#infolens-confirm-dialog{width:min(22rem,calc(100% - 2rem));padding:1rem}#infolens-confirm-dialog .confirm-message{margin:0}#infolens-confirm-dialog .confirm-actions{display:flex;justify-content:flex-end;gap:.5rem;margin-top:1rem}";document.head.append(style)}
}
*/
