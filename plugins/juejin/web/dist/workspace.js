import { observeWorkspaceTheme, workspaceRuntimeConfig, workspaceTheme } from "/runtime/plugin-sdk.js";
import { confirmQuestion, installHistoryControls } from "./history-controls.js";
import "./export-controls.js";

const { apiBaseUrl: api } = workspaceRuntimeConfig();
const applyTheme = (theme) => { document.documentElement.dataset.theme = theme; };
applyTheme(workspaceTheme());
observeWorkspaceTheme(applyTheme);

document.body.innerHTML = `
  <div id="workspace" class="workspace">
    <header class="workspace-header">
      <div class="brand"><span class="source-mark" aria-hidden="true">掘</span><div><strong>掘金</strong><span id="refresh-time">正在读取保留内容...</span></div></div>
      <div class="header-actions"><button id="refresh" class="icon-button" type="button" aria-label="刷新掘金" title="刷新">↻</button><button id="settings" class="icon-button" type="button" aria-label="打开刷新设置" title="刷新设置">⚙</button></div>
    </header>
    <main class="workspace-main">
      <section class="intro"><div><p class="eyebrow">SOURCE BOARD / JUEJIN</p><h1>把技术热榜变成可回看的文章清单。</h1><p class="lede">按分类保留掘金热门文章，记录热度变化和阅读状态；正文仍由掘金来源页打开，首版不引入浏览器依赖。</p></div><div class="model-note"><span>VIEW MODEL</span><strong>ranked articles</strong><small>category · metrics · retained snapshots</small></div></section>
      <div class="status" role="status" aria-live="polite"><i id="status-dot"></i><strong id="status-label">正在读取保留内容</strong><span id="status-detail"></span></div>
      <div id="warning" class="warning" role="alert" hidden><span><strong>刷新失败。</strong> 当前继续显示上次成功保留的文章。</span><button id="retry" type="button">重试</button></div>
      <section class="collection-head"><div><p class="section-kicker">01 / COLLECTION</p><h2>热门文章</h2></div><div><strong id="article-count">—</strong><span>篇保留</span></div></section>
      <ol id="article-list" class="article-list" aria-live="polite"><li class="loading">正在读取保留内容...</li></ol>
      <section id="empty" class="empty" hidden><span class="empty-mark">掘</span><h2 id="empty-title">还没有保留内容</h2><p id="empty-copy">首次刷新后，文章会保存在此设备上。</p><button id="empty-refresh" class="primary" type="button">立即刷新</button></section>
    </main>
  </div>
  <div id="scrim" class="scrim" hidden></div>
  <aside id="settings-sheet" class="sheet" role="dialog" aria-modal="true" aria-labelledby="settings-title" hidden><header><div><p class="section-kicker">WORKSPACE SETTINGS</p><h2 id="settings-title">刷新与内容设置</h2></div><button id="close-settings" class="icon-button" type="button" aria-label="关闭设置">×</button></header><form id="settings-form"><fieldset><legend>刷新策略</legend><label><input type="radio" name="policy" value="manual"><span>仅手动</span></label><label><input type="radio" name="policy" value="disabled"><span>停用刷新</span></label><label><input type="radio" name="policy" value="fixed"><span>固定间隔</span></label></fieldset><label for="interval">刷新间隔</label><select id="interval" name="intervalMinutes"><option value="15">每 15 分钟</option><option value="30">每 30 分钟</option><option value="60">每小时</option><option value="360">每 6 小时</option><option value="720">每 12 小时</option><option value="1440">每天</option></select><label for="category">内容分类</label><select id="category" name="category"><option value="backend">后端</option><option value="frontend">前端</option><option value="android">Android</option><option value="ios">iOS</option><option value="ai">人工智能</option></select><label for="limit">文章数量</label><select id="limit" name="limit"><option value="10">10 篇</option><option value="20">20 篇</option><option value="30">30 篇</option><option value="40">40 篇</option><option value="50">50 篇</option></select><label for="retention">历史保留</label><select id="retention" name="retentionDays"><option value="7">7 天</option><option value="30">30 天</option><option value="90">90 天</option></select><div class="sheet-actions"><button id="cancel-settings" class="button" type="button">取消</button><button class="button primary" type="submit">保存</button></div></form></aside>
  <aside id="detail-sheet" class="detail-sheet" role="dialog" aria-modal="true" aria-labelledby="detail-title" hidden><header><div><p id="detail-context" class="section-kicker">掘金</p><h2 id="detail-title">文章</h2></div><button id="close-detail" class="icon-button" type="button" aria-label="关闭详情">×</button></header><div class="detail-body"><div id="detail-meta" class="detail-meta"></div><p id="detail-brief"></p><button id="detail-open" class="button primary" type="button">打开掘金文章</button></div></aside>
`;

const $ = (selector) => document.querySelector(selector);
let data;
let historyView;
let refreshing = false;
let detailTrigger;
let historyControls;

async function request(route, options = {}) {
  const response = await fetch(new URL(route.replace(/^\/+/, ""), api), options);
  if (!response.ok) throw new Error(`插件 API 返回 ${response.status}`);
  return response.json();
}

function normalizeArticle(article) {
  const fields = article?.fields ?? {};
  return {
    id: article?.id ?? "",
    rank: article?.rank ?? 0,
    category: article?.category ?? fields.category ?? "backend",
    title: article?.title ?? "",
    brief: article?.brief ?? fields.brief ?? "",
    author: article?.author ?? fields.author ?? "匿名用户",
    views: article?.views ?? fields.views,
    likes: article?.likes ?? fields.likes,
    comments: article?.comments ?? fields.comments,
    hotRank: article?.hotRank ?? fields.hotRank,
    url: article?.url ?? "",
    read: Boolean(article?.read),
  };
}

function articles() { return (historyView ?? data?.articles ?? []).map(normalizeArticle); }
function formatNumber(value) { return value === null || value === undefined ? "—" : new Intl.NumberFormat("zh-CN", { notation: "compact", maximumFractionDigits: 1 }).format(value); }
function formatTime(value) { return value ? `上次刷新 ${new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(value))}` : "尚未刷新"; }

function showDetail(article, readOnly = false) {
  detailTrigger = document.activeElement;
  $("#detail-context").textContent = readOnly ? "掘金 / 历史快照" : "掘金 / 当前热榜";
  $("#detail-title").textContent = article.title;
  $("#detail-brief").textContent = article.brief || "这篇文章没有提供摘要。";
  $("#detail-meta").replaceChildren(...[
    `${article.category} · #${article.rank}`,
    `${formatNumber(article.likes)} 赞`,
    `${formatNumber(article.views)} 阅读`,
    article.author || "匿名用户",
  ].map((value) => { const item = document.createElement("span"); item.textContent = value; return item; }));
  $("#detail-open").onclick = () => window.open(article.url, "_blank", "noopener");
  $("#workspace").inert = true;
  $("#scrim").hidden = false;
  $("#detail-sheet").hidden = false;
  $("#close-detail").focus();
}

function closeDetail() {
  const trigger = detailTrigger;
  detailTrigger = undefined;
  $("#detail-sheet").hidden = true;
  $("#scrim").hidden = true;
  $("#workspace").inert = false;
  if (trigger?.isConnected) trigger.focus();
}

function articleCard(article, readOnly = false) {
  const item = document.createElement("li");
  item.className = `article-card${article.read ? " is-read" : ""}`;
  item.dataset.articleId = article.id;
  const rank = document.createElement("span");
  rank.className = "rank";
  rank.textContent = String(article.rank).padStart(2, "0");
  const content = document.createElement("div");
  content.className = "article-content";
  const title = document.createElement("button");
  title.className = "article-open";
  title.type = "button";
  title.textContent = article.title;
  title.onclick = async () => {
    showDetail(article, readOnly);
    if (!readOnly) {
      data = await request(`read?id=${encodeURIComponent(article.id)}`, { method: "POST" }).catch(() => data);
      render(data);
    }
  };
  const brief = document.createElement("p");
  brief.textContent = article.brief || "掘金技术文章";
  const meta = document.createElement("div");
  meta.className = "article-meta";
  meta.textContent = `${article.category} · ${article.author || "匿名用户"} · ${formatNumber(article.likes)} 赞 · ${formatNumber(article.comments)} 评论`;
  content.append(title, brief, meta);
  const state = document.createElement("span");
  state.className = "article-state";
  state.textContent = article.read ? "已读" : "未读";
  item.append(rank, content, state);
  return item;
}

function render(next) {
  data = next ?? data ?? { articles: [] };
  const current = articles();
  $("#article-list").replaceChildren(...current.map((article) => articleCard(article, Boolean(historyView))));
  $("#article-list").hidden = current.length === 0;
  $("#article-count").textContent = String(current.length);
  $("#refresh-time").textContent = formatTime(data.lastSuccessfulRefresh);
  $("#warning").hidden = !(data.lastError && current.length);
  $("#refresh").disabled = refreshing || data.settings?.policy === "disabled";
  $("#empty").hidden = current.length > 0;
  $("#empty-title").textContent = data.lastError ? "暂时无法读取文章" : "还没有保留内容";
  $("#empty-copy").textContent = data.lastError ? "请检查掘金来源后重试。" : "首次刷新后，文章会保存在此设备上。";
  $("#empty-refresh").textContent = data.lastError ? "重试" : "立即刷新";
  const state = refreshing ? "refreshing" : data.lastError ? "stale" : current.length ? "ready" : "empty";
  $("#status-dot").dataset.state = state;
  $("#status-label").textContent = { refreshing: "正在刷新", stale: "显示保留内容", ready: "已就绪", empty: "等待首次刷新" }[state];
  $("#status-detail").textContent = state === "stale" ? "刷新失败，保留上次成功结果" : state === "refreshing" ? "任务已排队" : formatTime(data.lastSuccessfulRefresh);
}

async function refresh() {
  if (refreshing) return;
  historyControls?.clear();
  historyView = undefined;
  refreshing = true;
  render(data);
  try {
    const refreshed = await request("refresh", { method: "POST" });
    data = await request("summary").catch(() => refreshed);
  } catch (error) {
    const latest = await request("summary").catch(() => data ?? { articles: [] });
    data = { ...latest, lastError: latest?.lastError ?? error.message };
  } finally {
    refreshing = false;
    render(data);
  }
}

function showSettings(show) {
  $("#workspace").inert = show;
  $("#settings-sheet").hidden = !show;
  $("#scrim").hidden = !show;
  if (show && data?.settings) {
    document.querySelector(`[name=policy][value=${data.settings.policy}]`).checked = true;
    $("#interval").value = data.settings.intervalMinutes;
    $("#category").value = data.settings.category;
    $("#limit").value = data.settings.limit;
    $("#retention").value = data.settings.retentionDays;
    $("#interval").disabled = data.settings.policy !== "fixed";
    $("#settings-sheet input:checked").focus();
  } else if (!show) $("#settings").focus();
}

$("#refresh").onclick = $("#retry").onclick = $("#empty-refresh").onclick = refresh;
$("#settings").onclick = () => showSettings(true);
$("#close-settings").onclick = $("#cancel-settings").onclick = () => showSettings(false);
$("#close-detail").onclick = closeDetail;
$("#scrim").onclick = () => $("#detail-sheet").hidden ? showSettings(false) : closeDetail();
document.querySelectorAll("[name=policy]").forEach((radio) => radio.onchange = () => { $("#interval").disabled = radio.value !== "fixed"; });
$("#settings-form").onsubmit = async (event) => {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  const retentionDays = Number(form.get("retentionDays"));
  const shorter = retentionDays < data.settings.retentionDays;
  if (shorter && !await confirmQuestion("缩短历史保留期会删除较早快照。继续？")) return;
  const route = `settings?policy=${form.get("policy")}&intervalMinutes=${form.get("intervalMinutes")}&category=${form.get("category")}&limit=${form.get("limit")}&retentionDays=${retentionDays}&acknowledgeRetentionCleanup=${shorter}`;
  await request(route, { method: "POST" });
  data = await request("summary");
  render(data);
  showSettings(false);
};
addEventListener("keydown", (event) => { if (event.key === "Escape") { if (!$("#detail-sheet").hidden) closeDetail(); else if (!$("#settings-sheet").hidden) showSettings(false); } });

historyControls = installHistoryControls({
  api,
  actions: document.querySelector(".header-actions"),
  onSnapshot: (detail) => { historyView = (detail.records ?? []).map(normalizeArticle); render(data); },
  onCurrent: () => { historyView = undefined; render(data); },
});

request("summary").then(render).catch((error) => { data = { articles: [], lastError: error.message }; render(data); });
