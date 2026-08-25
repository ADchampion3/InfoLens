import { observeWorkspaceTheme, workspaceRuntimeConfig, workspaceTheme } from "/runtime/plugin-sdk.js";
import { confirmQuestion, installHistoryControls } from "./history-controls.js";
import "./export-controls.js";

const { apiBaseUrl: api } = workspaceRuntimeConfig();
const applyTheme = (theme) => { document.documentElement.dataset.theme = theme; };
applyTheme(workspaceTheme());
observeWorkspaceTheme(applyTheme);

document.body.innerHTML = `
  <div class="workspace" id="workspace">
    <header class="workspace-header"><div class="header-inner"><div class="brand-lockup"><span class="source-mark" aria-hidden="true">ZH</span><div class="brand-copy"><strong>知乎热榜</strong><span>热榜问题 · 阅读桌</span></div></div><div class="header-actions"><button id="refresh" class="icon-button" type="button" aria-label="刷新知乎热榜" title="刷新"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 11a8.1 8.1 0 0 0-15.5-2M4 4v5h5M4 13a8.1 8.1 0 0 0 15.5 2M20 20v-5h-5"/></svg></button><button id="settings" class="icon-button" type="button" aria-label="打开刷新设置" title="刷新设置"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.88l-2.83 2.83A1.7 1.7 0 0 0 14 20.9h-4A1.7 1.7 0 0 0 9 19.36l-2.83 2.83A1.7 1.7 0 0 0 4.63 15 1.7 1.7 0 0 0 3.08 14v-4A1.7 1.7 0 0 0 4.64 9a1.7 1.7 0 0 0-.34-1.88l2.83-2.83A1.7 1.7 0 0 0 9 4.63 1.7 1.7 0 0 0 10 3.08h4A1.7 1.7 0 0 0 15 4.64l2.83-2.83A1.7 1.7 0 0 0 19.37 9 1.7 1.7 0 0 0 20.92 10v4A1.7 1.7 0 0 0 19.4 15Z"/></svg></button></div></div></header>
    <div class="status-strip" role="status" aria-live="polite"><span id="status-dot" class="status-dot"></span><strong id="status-label">正在读取保留内容</strong><span id="status-detail"></span></div>
    <div id="warning" class="warning" role="alert" hidden><span><strong>刷新失败。</strong> 当前继续显示上次成功保留的热榜。</span><button id="retry" class="text-button" type="button">重试</button></div>
    <main class="workspace-main"><section id="dependency" class="dependency" hidden><span class="state-mark" aria-hidden="true">ZH</span><h2 id="dependency-title">需要知乎登录</h2><p id="dependency-copy">请在 Chrome 中登录知乎，然后重试。</p><div class="dependency-actions"><button id="dependency-retry" class="button button--primary" type="button">重试</button><button id="dependency-recover" class="button" type="button">打开知乎</button></div></section><section id="reader-layout" class="reader-layout"><aside class="reader-rail" aria-label="知乎问题列表"><div class="reader-rail-head"><h2>热榜</h2><strong id="question-count">—</strong></div><div id="question-list" class="reader-list"></div></aside><article id="reader-content" class="reader-content" aria-live="polite"></article></section><section id="empty" class="state-panel" hidden><span class="state-mark" aria-hidden="true">ZH</span><h2 id="empty-title">还没有保留问题</h2><p id="empty-copy">首次刷新后，内容会保存在此设备上。</p><button id="empty-refresh" class="button button--primary" type="button">立即刷新</button></section></main>
  </div>
  <div id="scrim" class="scrim" hidden></div>
  <aside id="sheet" class="sheet" role="dialog" aria-modal="true" aria-labelledby="sheet-title" hidden><header class="sheet-head"><div><h2 id="sheet-title">刷新设置</h2></div><button id="close-settings" class="icon-button" type="button" aria-label="关闭设置">×</button></header><form id="settings-form"><fieldset><legend>刷新策略</legend><label><input type="radio" name="policy" value="manual"><span>仅手动</span></label><label><input type="radio" name="policy" value="disabled"><span>停用刷新</span></label><label><input type="radio" name="policy" value="fixed"><span>固定间隔</span></label></fieldset><label class="select-field" for="interval">刷新间隔</label><select id="interval" name="intervalMinutes"><option value="15">每 15 分钟</option><option value="30">每 30 分钟</option><option value="60">每小时</option><option value="360">每 6 小时</option><option value="720">每 12 小时</option><option value="1440">每天</option></select><label class="select-field" for="retention">历史保留</label><select id="retention" name="retentionDays"><option value="7">7 天</option><option value="30">30 天</option><option value="90">90 天</option></select><div class="sheet-actions"><button id="cancel-settings" class="button" type="button">取消</button><button class="button button--primary" type="submit">保存</button></div></form></aside>
`;

document.querySelector(".brand-copy span").id = "refresh-time";
const $ = (selector) => document.querySelector(selector);
let data;
let historyView;
let selectedUrl;
let refreshing = false;
let historyControls;

async function request(route, options = {}) {
  const response = await fetch(new URL(route.replace(/^\/+/, ""), api), options);
  if (!response.ok) throw new Error(`插件 API 返回 ${response.status}`);
  return response.json();
}

function normalizeQuestion(question) {
  const fields = question?.fields ?? {};
  return { title: question?.title ?? "", url: question?.url ?? "", rank: question?.rank ?? 0, heat: question?.heat ?? fields.heat ?? "—", answers: question?.answers ?? fields.answers ?? 0, excerpt: question?.excerpt ?? fields.excerpt ?? "", read: Boolean(question?.read) };
}
function questions() { return (historyView ?? data?.questions ?? []).map(normalizeQuestion); }
function formatTime(value) { return value ? `上次刷新 ${new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(value))}` : "尚未刷新"; }

function questionButton(question, readOnly) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `reader-list-item${question.url === selectedUrl ? " is-active" : ""}${question.read ? " is-read" : ""}`;
  button.dataset.questionUrl = question.url;
  const rank = document.createElement("span"); rank.className = "reader-rank"; rank.textContent = String(question.rank).padStart(2, "0");
  const title = document.createElement("strong"); title.textContent = question.title;
  const meta = document.createElement("small"); meta.textContent = `${question.heat} · ${question.answers} 回答`;
  button.append(rank, title, meta);
  button.onclick = () => openQuestion(question, readOnly);
  return button;
}

function renderReader(question, readOnly) {
  const reader = $("#reader-content");
  reader.replaceChildren();
  if (!question) return;
  const kicker = document.createElement("p"); kicker.className = "reader-kicker"; kicker.textContent = `${readOnly ? "历史快照" : "当前热榜"} · 第 ${String(question.rank).padStart(2, "0")} 位`;
  const title = document.createElement("h2"); title.textContent = question.title;
  const lede = document.createElement("p"); lede.className = "reader-lede"; lede.textContent = question.excerpt || "没有保留摘要。打开知乎查看完整问题。";
  const fields = document.createElement("dl"); fields.className = "field-grid";
  [["排名", `#${question.rank}`], ["热度", question.heat], ["回答", String(question.answers)]].forEach(([label, value]) => { const group = document.createElement("div"); const dt = document.createElement("dt"); dt.textContent = label; const dd = document.createElement("dd"); dd.textContent = value; group.append(dt, dd); fields.append(group); });
  const actions = document.createElement("div"); actions.className = "reader-actions";
  const open = document.createElement("button"); open.className = "button button--primary"; open.type = "button"; open.textContent = "在知乎打开"; open.onclick = () => window.open(question.url, "_blank", "noopener");
  const state = document.createElement("span"); state.className = "reader-state"; state.textContent = question.read ? "已读记录" : "未读记录";
  actions.append(open, state);
  const rule = document.createElement("div"); rule.className = "reader-rule";
  const note = document.createElement("p"); note.className = "reader-note"; note.textContent = readOnly ? "当前查看历史快照；打开链接不会修改快照。" : "选择左侧其他问题，工作区会保留当前阅读位置。";
  reader.append(kicker, title, lede, fields, actions, rule, note);
}

function renderDependency() {
  const disconnected = data?.dependencyState === "disconnected";
  const loginRequired = data?.dependencyState === "login-required";
  const visible = disconnected || loginRequired;
  $("#dependency").hidden = !visible;
  if (!visible) return;
  $("#dependency-title").textContent = disconnected ? "浏览器连接不可用" : "需要知乎登录";
  $("#dependency-copy").textContent = disconnected ? "知乎热榜需要可用的 Browser Bridge 连接。" : "请在 Chrome 中登录知乎，然后重试。";
  $("#dependency-recover").textContent = disconnected ? "安装 Browser Bridge" : "打开知乎";
  $("#dependency-recover").onclick = () => window.open(disconnected ? "https://chromewebstore.google.com/detail/opencli/ildkmabpimmkaediidaifkhjpohdnifk" : "https://www.zhihu.com/", "_blank", "noopener");
}

function setStatus(items) {
  const state = refreshing ? "refreshing" : data?.lastError ? "stale" : items.length ? "ready" : "empty";
  const labels = { ready: "已就绪", refreshing: "正在刷新", stale: "显示保留内容", empty: "等待首次刷新" };
  const details = { ready: formatTime(data?.lastSuccessfulRefresh), refreshing: "任务已排队", stale: "刷新失败，保留上次成功结果", empty: "本地还没有问题记录" };
  $("#status-label").textContent = labels[state]; $("#status-detail").textContent = details[state]; $("#status-dot").dataset.state = state;
}

function render(next) {
  data = next ?? data ?? { questions: [] };
  const items = questions();
  const dependencyVisible = ["disconnected", "login-required"].includes(data.dependencyState);
  renderDependency();
  $("#reader-layout").hidden = dependencyVisible || items.length === 0;
  $("#empty").hidden = dependencyVisible || items.length > 0;
  $("#empty-title").textContent = data.lastError ? "暂时无法读取热榜" : "还没有保留问题";
  $("#empty-copy").textContent = data.lastError ? "请检查来源连接后重试。" : "首次刷新后，内容会保存在此设备上。";
  $("#empty-refresh").textContent = data.lastError ? "重试" : "立即刷新";
  $("#warning").hidden = !(data.lastError && items.length && !dependencyVisible);
  $("#question-count").textContent = String(items.length);
  $("#refresh-time").textContent = formatTime(data.lastSuccessfulRefresh);
  $("#refresh").disabled = refreshing || data.settings?.policy === "disabled";
  $("#question-list").replaceChildren(...items.map((question) => questionButton(question, Boolean(historyView))));
  if (!selectedUrl || !items.some((question) => question.url === selectedUrl)) selectedUrl = items[0]?.url;
  renderReader(items.find((question) => question.url === selectedUrl), Boolean(historyView));
  setStatus(items);
}

async function openQuestion(question, readOnly = false) {
  selectedUrl = question.url;
  if (!readOnly) { data = await request(`read?url=${encodeURIComponent(question.url)}`, { method: "POST" }).catch(() => data); }
  render(data);
}

async function refresh() {
  if (refreshing) return;
  historyControls?.clear(); historyView = undefined; refreshing = true; render(data);
  try { const refreshed = await request("refresh", { method: "POST" }); data = await request("summary").catch(() => refreshed); }
  catch (error) { const latest = await request("summary").catch(() => data ?? { questions: [] }); data = { ...latest, lastError: latest?.lastError ?? error.message }; }
  finally { refreshing = false; render(data); }
}

function showSettings(show) {
  $("#workspace").inert = show; $("#sheet").hidden = !show; $("#scrim").hidden = !show;
  if (show && data?.settings) { document.querySelector(`[name=policy][value=${data.settings.policy}]`).checked = true; $("#interval").value = data.settings.intervalMinutes; $("#retention").value = data.settings.retentionDays; $("#interval").disabled = data.settings.policy !== "fixed"; $("#sheet input:checked").focus(); }
  else if (!show) $("#settings").focus();
}

$("#refresh").onclick = $("#retry").onclick = $("#empty-refresh").onclick = $("#dependency-retry").onclick = refresh;
$("#settings").onclick = () => showSettings(true);
$("#close-settings").onclick = $("#cancel-settings").onclick = () => showSettings(false);
$("#scrim").onclick = () => showSettings(false);
document.querySelectorAll("[name=policy]").forEach((radio) => radio.onchange = () => { $("#interval").disabled = radio.value !== "fixed"; });
$("#settings-form").onsubmit = async (event) => { event.preventDefault(); const form = new FormData(event.currentTarget); const retentionDays = Number(form.get("retentionDays")); const shorter = retentionDays < data.settings.retentionDays; if (shorter && !await confirmQuestion("缩短历史保留期会删除较早快照。继续？")) return; data.settings = await request(`settings?policy=${encodeURIComponent(form.get("policy"))}&intervalMinutes=${encodeURIComponent(form.get("intervalMinutes"))}&retentionDays=${encodeURIComponent(retentionDays)}&acknowledgeRetentionCleanup=${shorter}`, { method: "POST" }); showSettings(false); render(data); };
addEventListener("keydown", (event) => { if (event.key === "Escape" && !$("#sheet").hidden) showSettings(false); });

historyControls = installHistoryControls({ api, actions: document.querySelector(".header-actions"), onSnapshot: (detail) => { historyView = (detail.records ?? []).map(normalizeQuestion); render(data); }, onCurrent: () => { historyView = undefined; render(data); } });
request("summary").then(render).catch((error) => { data = { questions: [], lastError: error.message }; render(data); });
