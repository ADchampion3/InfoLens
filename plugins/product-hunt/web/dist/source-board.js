import { observeWorkspaceTheme, workspaceRuntimeConfig, workspaceTheme } from "/runtime/plugin-sdk.js";
import { confirmQuestion, installHistoryControls } from "./history-controls.js";
import "./export-controls.js";

const { apiBaseUrl: api } = workspaceRuntimeConfig();
const applyTheme = (theme) => { document.documentElement.dataset.theme = theme; };
applyTheme(workspaceTheme());
observeWorkspaceTheme(applyTheme);

document.body.innerHTML = `
  <div class="workspace" id="workspace">
    <header class="workspace-header"><div class="header-inner"><div class="brand-lockup"><span class="source-mark" aria-hidden="true">PH</span><div class="brand-copy"><strong>Product Hunt</strong><span>今日发布 · 来源看板</span></div></div><div class="header-actions"><button id="refresh" class="icon-button" type="button" aria-label="刷新 Product Hunt" title="刷新"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 11a8.1 8.1 0 0 0-15.5-2M4 4v5h5M4 13a8.1 8.1 0 0 0 15.5 2M20 20v-5h-5"/></svg></button><button id="settings" class="icon-button" type="button" aria-label="打开刷新设置" title="刷新设置"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.88l-2.83 2.83a1.7 1.7 0 0 0-1.88-.34A1.7 1.7 0 0 0 14 20.9h-4A1.7 1.7 0 0 0 9 19.36l-2.83 2.83A1.7 1.7 0 0 0 4.63 15 1.7 1.7 0 0 0 3.08 14v-4A1.7 1.7 0 0 0 4.64 9a1.7 1.7 0 0 0-.34-1.88l2.83-2.83A1.7 1.7 0 0 0 9 4.63 1.7 1.7 0 0 0 10 3.08h4A1.7 1.7 0 0 0 15 4.64l2.83-2.83A1.7 1.7 0 0 0 19.37 9 1.7 1.7 0 0 0 20.92 10v4A1.7 1.7 0 0 0 19.4 15Z"/></svg></button></div></div></header>
    <div class="status-strip" role="status" aria-live="polite"><span id="status-dot" class="status-dot"></span><strong id="status-label">正在读取保留内容</strong><span id="status-detail"></span></div>
    <div id="warning" class="warning" role="alert" hidden><span><strong>刷新失败。</strong> 当前继续显示上次成功保留的发布板。</span><button id="retry" class="text-button" type="button">重试</button></div>
    <main class="workspace-main"><section id="dependency" class="dependency" hidden><span class="state-mark" aria-hidden="true">PH</span><h2>需要浏览器连接</h2><p id="dependency-copy">连接 OpenCLI Browser Bridge 后，才能采集今日的发布排行。</p><div class="dependency-actions"><button id="dependency-retry" class="button button--primary" type="button">检查连接</button><button id="dependency-recover" class="button" type="button">打开 Product Hunt</button></div></section><section id="board-area"><div class="board-toolbar"><h2>今日发布</h2><div class="board-meta"><strong id="product-count">—</strong><span>个发布已保留</span></div></div><section id="products" class="board-grid" aria-live="polite"><div class="loading-card">正在读取保留内容…</div></section></section><section id="empty" class="state-panel" hidden><span class="state-mark" aria-hidden="true">PH</span><h2 id="empty-title">还没有保留的发布</h2><p id="empty-copy">刷新一次，今日排行会保存在此设备上。</p><button id="empty-refresh" class="button button--primary" type="button">立即刷新</button></section></main>
  </div>
  <div id="scrim" class="scrim" hidden></div>
  <aside id="sheet" class="sheet" role="dialog" aria-modal="true" aria-labelledby="settings-title" hidden><header class="sheet-head"><div><h2 id="settings-title">刷新设置</h2></div><button id="close-settings" class="icon-button" type="button" aria-label="关闭设置">×</button></header><form id="settings-form"><fieldset><legend>刷新策略</legend><label><input type="radio" name="policy" value="manual"><span>仅手动</span></label><label><input type="radio" name="policy" value="disabled"><span>停用刷新</span></label><label><input type="radio" name="policy" value="fixed"><span>固定间隔</span></label></fieldset><label class="select-field" for="interval">刷新间隔</label><select id="interval" name="intervalMinutes"><option value="15">每 15 分钟</option><option value="30">每 30 分钟</option><option value="60">每小时</option><option value="360">每 6 小时</option><option value="720">每 12 小时</option><option value="1440">每天</option></select><label class="select-field" for="retention">历史保留</label><select id="retention" name="retentionDays"><option value="7">7 天</option><option value="30">30 天</option><option value="90">90 天</option></select><div class="sheet-actions"><button id="cancel-settings" class="button" type="button">取消</button><button class="button button--primary" type="submit">保存</button></div></form></aside>
  <aside id="detail-sheet" class="detail-sheet" role="dialog" aria-modal="true" aria-labelledby="detail-title" hidden><header class="detail-head"><div><p id="detail-context">Product Hunt</p><h2 id="detail-title">发布</h2></div><button id="close-detail" class="icon-button" type="button" aria-label="关闭详情">×</button></header><div class="detail-body"><div id="detail-meta" class="detail-meta"></div><p id="detail-description" class="detail-description">Product Hunt 发布</p><div class="detail-actions"><button id="detail-open" class="button button--primary" type="button">打开来源页</button></div></div></aside>
`;

document.querySelector(".brand-copy span").id = "refresh-time";
const $ = (selector) => document.querySelector(selector);
let data;
let historyView;
let refreshing = false;
let detailTrigger;
let historyControls;

async function request(route, options = {}) { const response = await fetch(new URL(route.replace(/^\/+/, ""), api), options); if (!response.ok) throw new Error(`插件 API 返回 ${response.status}`); return response.json(); }
function normalizeProduct(product) { const fields = product?.fields ?? {}; return { name: product?.name ?? product?.title ?? "", url: product?.url ?? "", rank: product?.rank ?? 0, votes: product?.votes ?? fields.votes ?? 0, read: Boolean(product?.read) }; }
function products() { return (historyView ?? data?.products ?? []).map(normalizeProduct); }
function compact(value) { return new Intl.NumberFormat("zh-CN", { notation: "compact", maximumFractionDigits: 1 }).format(value ?? 0); }
function formatTime(value) { return value ? `上次刷新 ${new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(value))}` : "尚未刷新"; }

function modal(show, element) { $("#workspace").inert = show; $("#scrim").hidden = !show; element.hidden = !show; }
function showDetail(product, readOnly = false) { detailTrigger = document.activeElement; $("#detail-context").textContent = readOnly ? "Product Hunt · 历史快照" : "Product Hunt"; $("#detail-title").textContent = product.name; $("#detail-meta").replaceChildren(...[`第 ${product.rank} 名`, `${compact(product.votes)} 票`].map((value) => { const item = document.createElement("span"); item.textContent = value; return item; })); $("#detail-description").textContent = readOnly ? "历史发布记录。" : "今日 Product Hunt 发布。"; $("#detail-open").onclick = () => window.open(product.url, "_blank", "noopener"); modal(true, $("#detail-sheet")); $("#close-detail").focus(); }
function closeDetail() { const trigger = detailTrigger; detailTrigger = undefined; $("#detail-sheet").hidden = true; $("#scrim").hidden = true; $("#workspace").inert = false; if (trigger?.isConnected) trigger.focus(); }

function productCard(product, index, readOnly = false) {
  const card = document.createElement("article");
  const variant = index === 0 ? " board-card--lead" : index === 1 ? " board-card--tall" : index === 2 ? " board-card--wide" : "";
  card.className = `board-card${variant}${product.read ? " is-read" : ""}`;
  card.dataset.productUrl = product.url;
  const top = document.createElement("div"); top.className = "card-topline";
  const rank = document.createElement("span"); rank.textContent = `#${String(product.rank).padStart(2, "0")}`;
  const votes = document.createElement("span"); votes.textContent = `${compact(product.votes)} 票`;
  top.append(rank, votes);
  const action = document.createElement("button"); action.className = "card-action"; action.type = "button"; action.setAttribute("aria-label", `查看 ${product.name}`);
  const title = document.createElement("h2"); title.textContent = product.name;
  const description = document.createElement("p"); description.textContent = "Product Hunt 发布";
  action.append(title, description); action.onclick = async () => { showDetail(product, readOnly); if (!readOnly) { data = await request(`read?url=${encodeURIComponent(product.url)}`, { method: "POST" }).catch(() => data); render(data); } };
  const footer = document.createElement("div"); footer.className = "card-footer";
  const source = document.createElement("span"); source.textContent = "producthunt.com";
  const state = document.createElement("span"); state.textContent = product.read ? "已读" : "未读";
  footer.append(source, state); card.append(top, action, footer); return card;
}

function renderDependency() { const disconnected = data?.dependencyState === "disconnected"; $("#dependency").hidden = !disconnected; $("#board-area").hidden = disconnected; $("#empty").hidden = true; if (!disconnected) return; $("#dependency-copy").textContent = "连接 OpenCLI Browser Bridge 后，才能采集今日的发布排行。"; $("#dependency-recover").onclick = () => window.open("https://chromewebstore.google.com/detail/opencli/ildkmabpimmkaediidaifkhjpohdnifk", "_blank", "noopener"); }
function setStatus(items) { const state = refreshing ? "refreshing" : data?.lastError ? "stale" : items.length ? "ready" : "empty"; const labels = { ready: "已就绪", refreshing: "正在刷新", stale: "显示保留内容", empty: "等待首次刷新" }; const details = { ready: formatTime(data?.lastSuccessfulRefresh), refreshing: "任务已排队", stale: "刷新失败，保留上次成功结果", empty: "本地还没有发布记录" }; $("#status-label").textContent = labels[state]; $("#status-detail").textContent = details[state]; $("#status-dot").dataset.state = state; }
function render(next) { data = next ?? data ?? { products: [] }; const items = products(); renderDependency(); const disconnected = data.dependencyState === "disconnected"; $("#products").replaceChildren(...items.map((product, index) => productCard(product, index, Boolean(historyView)))); $("#products").hidden = !items.length; $("#empty").hidden = disconnected || items.length > 0; $("#empty-title").textContent = data.lastError ? "暂时无法读取发布" : "还没有保留的发布"; $("#empty-copy").textContent = data.lastError ? "请检查 Browser Bridge 连接后重试。" : "刷新一次，今日排行会保存在此设备上。"; $("#empty-refresh").textContent = data.lastError ? "重试" : "立即刷新"; $("#warning").hidden = !(data.lastError && items.length && !disconnected); $("#product-count").textContent = String(items.length); $("#refresh-time").textContent = formatTime(data.lastSuccessfulRefresh); $("#refresh").disabled = refreshing || data.settings?.policy === "disabled"; setStatus(items); }

async function refresh() { if (refreshing) return; historyControls?.clear(); historyView = undefined; refreshing = true; render(data); try { const refreshed = await request("refresh", { method: "POST" }); data = await request("summary").catch(() => refreshed); } catch (error) { const latest = await request("summary").catch(() => data ?? { products: [] }); data = { ...latest, lastError: latest?.lastError ?? error.message }; } finally { refreshing = false; render(data); } }
function showSettings(show) { $("#workspace").inert = show; $("#sheet").hidden = !show; $("#scrim").hidden = !show; if (show && data?.settings) { document.querySelector(`[name=policy][value=${data.settings.policy}]`).checked = true; $("#interval").value = data.settings.intervalMinutes; $("#retention").value = data.settings.retentionDays; $("#interval").disabled = data.settings.policy !== "fixed"; $("#sheet input:checked").focus(); } else if (!show) $("#settings").focus(); }

$("#refresh").onclick = $("#retry").onclick = $("#empty-refresh").onclick = $("#dependency-retry").onclick = refresh;
$("#settings").onclick = () => showSettings(true); $("#close-settings").onclick = $("#cancel-settings").onclick = () => showSettings(false); $("#close-detail").onclick = closeDetail; $("#scrim").onclick = () => $("#detail-sheet").hidden ? showSettings(false) : closeDetail();
document.querySelectorAll("[name=policy]").forEach((radio) => radio.onchange = () => { $("#interval").disabled = radio.value !== "fixed"; });
$("#settings-form").onsubmit = async (event) => { event.preventDefault(); const form = new FormData(event.currentTarget); const retentionDays = Number(form.get("retentionDays")); const shorter = retentionDays < data.settings.retentionDays; if (shorter && !await confirmQuestion("缩短历史保留期会删除较早快照。继续？")) return; await request(`settings?policy=${form.get("policy")}&intervalMinutes=${form.get("intervalMinutes")}&retentionDays=${retentionDays}&acknowledgeRetentionCleanup=${shorter}`, { method: "POST" }); data = await request("summary"); render(data); showSettings(false); };
addEventListener("keydown", (event) => { if (event.key === "Escape") { if (!$("#detail-sheet").hidden) closeDetail(); else if (!$("#sheet").hidden) showSettings(false); } });

historyControls = installHistoryControls({ api, actions: document.querySelector(".header-actions"), onSnapshot: (detail) => { historyView = (detail.records ?? []).map(normalizeProduct); render(data); }, onCurrent: () => { historyView = undefined; render(data); } });
request("summary").then(render).catch((error) => { data = { products: [], lastError: error.message }; render(data); });
