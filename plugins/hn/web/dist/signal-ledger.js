import { observeWorkspaceTheme, workspaceRuntimeConfig, workspaceTheme } from "/runtime/plugin-sdk.js";
import { confirmQuestion, installHistoryControls } from "./history-controls.js";
import "./export-controls.js";

const { apiBaseUrl: api } = workspaceRuntimeConfig();
const applyTheme = (theme) => { document.documentElement.dataset.theme = theme; };
applyTheme(workspaceTheme());
observeWorkspaceTheme(applyTheme);

document.body.innerHTML = `
  <div class="workspace" id="workspace">
    <header class="workspace-header">
      <div class="header-inner">
        <div class="brand-lockup">
          <span class="source-mark" aria-hidden="true">HN</span>
          <div class="brand-copy"><strong>Hacker News</strong><span>Top Stories · 信号台账</span></div>
        </div>
        <div class="header-actions">
          <button id="refresh" class="icon-button" type="button" aria-label="刷新 Hacker News" title="刷新"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 11a8.1 8.1 0 0 0-15.5-2M4 4v5h5M4 13a8.1 8.1 0 0 0 15.5 2M20 20v-5h-5"/></svg></button>
          <button id="settings" class="icon-button" type="button" aria-label="打开刷新设置" title="刷新设置"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.88l-2.83 2.83a1.7 1.7 0 0 0-1.88-.34A1.7 1.7 0 0 0 14 20.9h-4A1.7 1.7 0 0 0 9 19.36a1.7 1.7 0 0 0-1.88.34l-2.83-2.83A1.7 1.7 0 0 0 4.63 15 1.7 1.7 0 0 0 3.08 14v-4A1.7 1.7 0 0 0 4.64 9a1.7 1.7 0 0 0-.34-1.88l2.83-2.83A1.7 1.7 0 0 0 9 4.63 1.7 1.7 0 0 0 10 3.08h4A1.7 1.7 0 0 0 15 4.64a1.7 1.7 0 0 0 1.88-.34l2.83 2.83A1.7 1.7 0 0 0 19.37 9 1.7 1.7 0 0 0 20.92 10v4A1.7 1.7 0 0 0 19.4 15Z"/></svg></button>
        </div>
      </div>
    </header>
    <div class="status-strip" role="status" aria-live="polite"><span id="status-dot" class="status-dot"></span><strong id="status-label">正在读取保留内容</strong><span id="status-detail"></span></div>
    <div id="warning" class="warning" role="alert" hidden><span><strong>刷新失败。</strong> 当前继续显示上次成功保留的内容。</span><button id="retry" type="button" class="text-button">重试</button></div>
    <main class="workspace-main">
      <section class="section-head"><h2>Top Stories</h2><p class="section-count"><strong id="story-count">—</strong> 条已保留</p></section>
      <div class="ledger-layout">
        <aside class="filter-rail" aria-label="故事筛选"><span class="rail-label">筛选</span><button class="filter-button is-active" data-filter="all" type="button">全部 <span id="all-count">—</span></button><button class="filter-button" data-filter="unread" type="button">未读 <span id="unread-count">—</span></button><p class="rail-note">视图模型由插件持有，筛选只保存在工作区本地。</p></aside>
        <div class="ledger-column"><ol id="story-list" class="ledger-list" aria-live="polite"><li class="loading-row">正在读取保留内容…</li></ol><section id="empty" class="state-panel" hidden><span class="state-mark" aria-hidden="true">HN</span><h2 id="empty-title">还没有保留内容</h2><p id="empty-copy">首次刷新后，内容会保存在此设备上。</p><button id="empty-refresh" class="button button--primary" type="button">立即刷新</button></section></div>
      </div>
    </main>
  </div>
  <div id="scrim" class="scrim" hidden></div>
  <aside id="sheet" class="sheet" role="dialog" aria-modal="true" aria-labelledby="sheet-title" hidden><header class="sheet-head"><div><h2 id="sheet-title">刷新与历史</h2></div><button id="close-settings" class="icon-button" type="button" aria-label="关闭设置">×</button></header><form id="settings-form"><fieldset><legend>刷新策略</legend><label><input type="radio" name="policy" value="manual"><span>仅手动</span></label><label><input type="radio" name="policy" value="disabled"><span>停用刷新</span></label><label><input type="radio" name="policy" value="fixed"><span>固定间隔</span></label></fieldset><label class="select-field" for="interval">刷新间隔</label><select id="interval" name="intervalMinutes"><option value="15">每 15 分钟</option><option value="30">每 30 分钟</option><option value="60">每小时</option><option value="360">每 6 小时</option><option value="720">每 12 小时</option><option value="1440">每天</option></select><label class="select-field" for="retention">历史保留</label><select id="retention" name="retentionDays"><option value="7">7 天</option><option value="30">30 天</option><option value="90">90 天</option></select><div class="sheet-actions"><button id="cancel-settings" class="button" type="button">取消</button><button class="button button--primary" type="submit">保存</button></div></form></aside>
  <aside id="detail-sheet" class="detail-sheet" role="dialog" aria-modal="true" aria-labelledby="detail-title" hidden><header class="detail-head"><div><p id="detail-context">Hacker News</p><h2 id="detail-title">Story</h2></div><button id="close-detail" class="icon-button" type="button" aria-label="关闭详情">×</button></header><div class="detail-body"><div id="detail-meta" class="detail-meta"></div><p id="detail-description" class="detail-description"></p><div class="detail-actions"><button id="detail-open" class="button button--primary" type="button">打开原文</button><button id="detail-discussion" class="button" type="button">打开讨论</button></div></div></aside>
`;

document.querySelector(".brand-copy span").id = "refresh-time";
const $ = (selector) => document.querySelector(selector);
let data;
let historyView;
let filter = "all";
let refreshing = false;
let detailTrigger;
let historyControls;

async function request(route, options = {}) {
  const response = await fetch(new URL(route.replace(/^\/+/, ""), api), options);
  if (!response.ok) throw new Error(`插件 API 返回 ${response.status}`);
  return response.json();
}

function normalizeStory(story) {
  const fields = story?.fields ?? {};
  return {
    id: story?.id ?? story?.url ?? "",
    title: story?.title ?? "",
    url: story?.url ?? fields.url ?? "",
    rank: story?.rank ?? 0,
    read: Boolean(story?.read),
    domain: story?.domain ?? fields.domain ?? "news.ycombinator.com",
    points: story?.points ?? fields.points ?? 0,
    author: story?.author ?? fields.author ?? "—",
    comments: story?.comments ?? fields.comments ?? 0,
    createdAt: story?.createdAt ?? fields.createdAt,
    discussionUrl: story?.discussionUrl ?? fields.discussionUrl ?? story?.url ?? "",
  };
}

function stories() {
  return (historyView ?? data?.stories ?? []).map(normalizeStory);
}

function formatTime(value) {
  if (!value) return "尚未刷新";
  return `上次刷新 ${new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(value))}`;
}

function showDetail(story, readOnly = false) {
  detailTrigger = document.activeElement;
  $("#detail-context").textContent = readOnly ? "Hacker News · 历史快照" : "Hacker News";
  $("#detail-title").textContent = story.title;
  $("#detail-meta").replaceChildren(...[
    story.domain || "news.ycombinator.com",
    `${story.points} 分`,
    story.author,
    `${story.comments} 评论`,
  ].map((value) => { const item = document.createElement("span"); item.textContent = value; return item; }));
  $("#detail-description").textContent = story.createdAt ? `采集于 ${new Date(story.createdAt).toLocaleString("zh-CN")}。` : "已保留的故事记录。";
  $("#detail-open").onclick = () => window.open(story.url, "_blank", "noopener");
  $("#detail-discussion").hidden = !story.discussionUrl;
  $("#detail-discussion").onclick = () => window.open(story.discussionUrl, "_blank", "noopener");
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

function storyRow(story, readOnly = false) {
  const item = document.createElement("li");
  item.className = `ledger-row${story.read ? " is-read" : ""}`;
  item.dataset.storyId = story.id;
  const rank = document.createElement("span");
  rank.className = "rank";
  rank.textContent = String(story.rank).padStart(2, "0");
  const content = document.createElement("div");
  content.className = "row-content";
  const title = document.createElement("button");
  title.className = "row-title";
  title.type = "button";
  title.textContent = story.title;
  title.onclick = async () => {
    showDetail(story, readOnly);
    if (!readOnly) {
      data = await request(`read?id=${encodeURIComponent(story.id)}`, { method: "POST" }).catch(() => data);
      render(data);
    }
  };
  const domain = document.createElement("span");
  domain.className = "domain";
  domain.textContent = story.domain || "news.ycombinator.com";
  const meta = document.createElement("div");
  meta.className = "row-meta";
  meta.textContent = `${story.points} 分 · ${story.author} · ${story.read ? "已读" : "未读"}`;
  content.append(title, domain, meta);
  const comments = document.createElement("button");
  comments.className = "row-affordance";
  comments.type = "button";
  comments.textContent = `${story.comments} 评论`;
  comments.onclick = () => window.open(story.discussionUrl, "_blank", "noopener");
  item.append(rank, content, comments);
  return item;
}

function setStatus(storyList) {
  const state = refreshing ? "refreshing" : data?.lastError ? "stale" : storyList.length ? "ready" : "empty";
  const labels = { ready: "已就绪", refreshing: "正在刷新", stale: "显示保留内容", empty: "等待首次刷新" };
  const details = { ready: formatTime(data?.lastSuccessfulRefresh), refreshing: "任务已排队", stale: "刷新失败，保留上次成功结果", empty: "本地还没有故事记录" };
  $("#status-label").textContent = labels[state];
  $("#status-detail").textContent = details[state];
  $("#status-dot").dataset.state = state;
}

function render(next) {
  data = next ?? data ?? { stories: [] };
  const allStories = stories();
  const visibleStories = filter === "unread" ? allStories.filter((story) => !story.read) : allStories;
  $("#story-list").replaceChildren(...visibleStories.map((story) => storyRow(story, Boolean(historyView))));
  $("#story-list").hidden = visibleStories.length === 0;
  $("#story-count").textContent = String(allStories.length);
  $("#all-count").textContent = String(allStories.length);
  $("#unread-count").textContent = String(allStories.filter((story) => !story.read).length);
  $("#refresh-time").textContent = formatTime(data.lastSuccessfulRefresh);
  $("#warning").hidden = !(data.lastError && allStories.length);
  $("#refresh").disabled = refreshing || data.settings?.policy === "disabled";
  const noRows = allStories.length === 0 || visibleStories.length === 0;
  $("#empty").hidden = !noRows;
  $("#empty-title").textContent = allStories.length ? "没有符合筛选的故事" : data.lastError ? "暂时无法读取故事" : "还没有保留内容";
  $("#empty-copy").textContent = allStories.length ? "切换筛选条件查看全部保留内容。" : data.lastError ? "请检查来源连接后重试。" : "首次刷新后，内容会保存在此设备上。";
  $("#empty-refresh").textContent = data.lastError ? "重试" : "立即刷新";
  setStatus(allStories);
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
    const latest = await request("summary").catch(() => data ?? { stories: [] });
    data = { ...latest, lastError: latest?.lastError ?? error.message };
  } finally {
    refreshing = false;
    render(data);
  }
}

function showSettings(show) {
  $("#workspace").inert = show;
  $("#sheet").hidden = !show;
  $("#scrim").hidden = !show;
  if (show && data?.settings) {
    document.querySelector(`[name=policy][value=${data.settings.policy}]`).checked = true;
    $("#interval").value = data.settings.intervalMinutes;
    $("#retention").value = data.settings.retentionDays;
    $("#interval").disabled = data.settings.policy !== "fixed";
    $("#sheet input:checked").focus();
  } else if (!show) $("#settings").focus();
}

$("#refresh").onclick = $("#retry").onclick = $("#empty-refresh").onclick = refresh;
$("#settings").onclick = () => showSettings(true);
$("#close-settings").onclick = $("#cancel-settings").onclick = () => showSettings(false);
$("#close-detail").onclick = closeDetail;
$("#scrim").onclick = () => $("#detail-sheet").hidden ? showSettings(false) : closeDetail();
document.querySelectorAll("[name=policy]").forEach((radio) => radio.onchange = () => { $("#interval").disabled = radio.value !== "fixed"; });
document.querySelectorAll("[data-filter]").forEach((button) => button.onclick = () => { filter = button.dataset.filter; document.querySelectorAll("[data-filter]").forEach((item) => item.classList.toggle("is-active", item === button)); render(data); });
$("#settings-form").onsubmit = async (event) => {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  const retentionDays = Number(form.get("retentionDays"));
  const shorter = retentionDays < data.settings.retentionDays;
  if (shorter && !await confirmQuestion("缩短历史保留期会删除较早快照。继续？")) return;
  await request(`settings?policy=${form.get("policy")}&intervalMinutes=${form.get("intervalMinutes")}&retentionDays=${retentionDays}&acknowledgeRetentionCleanup=${shorter}`, { method: "POST" });
  data = await request("summary");
  render(data);
  showSettings(false);
};
addEventListener("keydown", (event) => { if (event.key === "Escape") { if (!$("#detail-sheet").hidden) closeDetail(); else if (!$("#sheet").hidden) showSettings(false); } });

historyControls = installHistoryControls({
  api,
  actions: document.querySelector(".header-actions"),
  onSnapshot: (detail) => { historyView = (detail.records ?? []).map(normalizeStory); render(data); },
  onCurrent: () => { historyView = undefined; render(data); },
});

request("summary").then(render).catch((error) => { data = { stories: [], lastError: error.message }; render(data); });
