import { observeWorkspaceTheme, workspaceRuntimeConfig, workspaceTheme } from "/runtime/plugin-sdk.js";
import { confirmQuestion, installHistoryControls } from "./history-controls.js";
import "./export-controls.js";

const { apiBaseUrl: api } = workspaceRuntimeConfig();
const applyTheme = (theme) => { document.documentElement.dataset.theme = theme; };
applyTheme(workspaceTheme());
observeWorkspaceTheme(applyTheme);

document.body.innerHTML = `
  <div class="workspace" id="workspace">
    <header class="workspace-header"><div class="header-inner"><div class="brand-lockup"><span class="source-mark" aria-hidden="true">GH</span><div class="brand-copy"><strong>GitHub Trending</strong><span>趋势仓库 · 来源看板</span></div></div><div class="header-actions"><button id="refresh" class="icon-button" type="button" aria-label="刷新 GitHub Trending" title="刷新"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 11a8.1 8.1 0 0 0-15.5-2M4 4v5h5M4 13a8.1 8.1 0 0 0 15.5 2M20 20v-5h-5"/></svg></button><button id="settings" class="icon-button" type="button" aria-label="打开刷新设置" title="刷新设置"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.88l-2.83 2.83a1.7 1.7 0 0 0-1.88-.34A1.7 1.7 0 0 0 14 20.9h-4A1.7 1.7 0 0 0 9 19.36a1.7 1.7 0 0 0-1.88.34l-2.83-2.83A1.7 1.7 0 0 0 4.63 15 1.7 1.7 0 0 0 3.08 14v-4A1.7 1.7 0 0 0 4.64 9a1.7 1.7 0 0 0-.34-1.88l2.83-2.83A1.7 1.7 0 0 0 9 4.63 1.7 1.7 0 0 0 10 3.08h4A1.7 1.7 0 0 0 15 4.64a1.7 1.7 0 0 0 1.88-.34l2.83 2.83A1.7 1.7 0 0 0 19.37 9 1.7 1.7 0 0 0 20.92 10v4A1.7 1.7 0 0 0 19.4 15Z"/></svg></button></div></div></header>
    <div class="status-strip" role="status" aria-live="polite"><span id="status-dot" class="status-dot"></span><strong id="status-label">正在读取保留内容</strong><span id="status-detail"></span></div>
    <div id="warning" class="warning" role="alert" hidden><span><strong>刷新失败。</strong> 当前继续显示上次成功保留的仓库。</span><button id="retry" class="text-button" type="button">重试</button></div>
    <main class="workspace-main"><section class="board-toolbar" aria-label="趋势筛选"><h2>趋势仓库</h2><div class="filter-controls"><label><span>周期</span><select id="period"><option value="daily">今天</option><option value="weekly">本周</option><option value="monthly">本月</option></select></label><label><span>语言</span><select id="language"><option value="all">全部语言</option><option>TypeScript</option><option>Python</option><option>Rust</option><option>Go</option><option>C++</option></select></label></div></section><div class="board-meta"><span id="repo-count">—</span><span>个仓库已保留</span><span id="view-label">daily / all</span></div><section class="board-grid" id="repo-list" aria-live="polite"><div class="loading-card">正在读取保留内容…</div></section><section id="empty" class="state-panel" hidden><span class="state-mark" aria-hidden="true">GH</span><h2 id="empty-title">还没有趋势仓库</h2><p id="empty-copy">选择周期和语言，然后执行首次刷新。</p><button id="empty-refresh" class="button button--primary" type="button">立即刷新</button></section></main>
  </div>
  <div id="scrim" class="scrim" hidden></div>
  <aside id="settings-sheet" class="sheet" role="dialog" aria-modal="true" aria-labelledby="settings-title" hidden><header class="sheet-head"><div><h2 id="settings-title">刷新设置</h2></div><button id="close-settings" class="icon-button" type="button" aria-label="关闭设置">×</button></header><form id="settings-form"><fieldset><legend>刷新策略</legend><label><input type="radio" name="policy" value="manual"><span>仅手动</span></label><label><input type="radio" name="policy" value="disabled"><span>停用刷新</span></label><label><input type="radio" name="policy" value="fixed"><span>固定间隔</span></label></fieldset><label class="select-field" for="interval">刷新间隔</label><select id="interval" name="intervalMinutes"><option value="15">每 15 分钟</option><option value="30">每 30 分钟</option><option value="60">每小时</option><option value="360">每 6 小时</option><option value="720">每 12 小时</option><option value="1440">每天</option></select><label class="select-field" for="retention">历史保留</label><select id="retention" name="retentionDays"><option value="7">7 天</option><option value="30">30 天</option><option value="90">90 天</option></select><div class="sheet-actions"><button id="cancel-settings" class="button" type="button">取消</button><button class="button button--primary" type="submit">保存</button></div></form></aside>
  <aside id="readme-sheet" class="readme-sheet" role="dialog" aria-modal="true" aria-labelledby="readme-title" hidden><header class="readme-head"><div><p id="readme-owner">Repository</p><h2 id="readme-title">README</h2></div><div class="readme-head-actions"><button id="open-github" class="icon-button" type="button" aria-label="在 GitHub 打开" title="在 GitHub 打开"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 3h7v7M10 14 21 3M21 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5"/></svg></button><button id="close-readme" class="icon-button" type="button" aria-label="关闭 README">×</button></div></header><div class="readme-toolbar"><span id="readme-status">正在读取 README…</span><button id="reload-readme" class="button" type="button">重新抓取</button></div><div id="readme-loading" class="readme-state" role="status">正在从 GitHub 读取 README…</div><div id="readme-error" class="readme-state readme-error" role="alert" hidden><strong>无法显示 README</strong><p id="readme-error-message"></p><button id="retry-readme" class="button" type="button">重试</button></div><article id="readme-content" class="readme-content" aria-label="仓库 README 内容" hidden></article></aside>
`;

document.querySelector(".brand-copy span").id = "refresh-time";
const $ = (selector) => document.querySelector(selector);
let data;
let historyView;
let selectedRepository;
let readmeRequest = 0;
let refreshing = false;
let historyControls;

async function request(route, options = {}) {
  const response = await fetch(new URL(route.replace(/^\/+/, ""), api), options);
  if (!response.ok) throw new Error(`插件 API 返回 ${response.status}`);
  return response.json();
}

function normalizeRepository(repository) {
  const fields = repository?.fields ?? {};
  return {
    id: repository?.id ?? fields.repository ?? repository?.url ?? "",
    owner: repository?.owner ?? fields.owner ?? "—",
    name: repository?.name ?? repository?.title ?? (repository?.id ?? "").split("/").pop() ?? "Repository",
    description: repository?.description ?? fields.description ?? "暂无描述",
    language: repository?.language ?? fields.language ?? "未标注",
    rank: repository?.rank ?? 0,
    stars: repository?.stars ?? fields.stars ?? 0,
    forks: repository?.forks ?? fields.forks ?? 0,
    starsGained: repository?.starsGained ?? fields.starsGained ?? 0,
    url: repository?.url ?? "",
    read: Boolean(repository?.read),
  };
}

function repositories() { return (historyView ?? data?.repositories ?? []).map(normalizeRepository); }
function compact(value) { return new Intl.NumberFormat("zh-CN", { notation: "compact", maximumFractionDigits: 1 }).format(value ?? 0); }
function formatTime(value) { return value ? `上次刷新 ${new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(value))}` : "尚未刷新"; }

function modal(show, element) {
  $("#workspace").inert = show;
  $("#scrim").hidden = !show;
  element.hidden = !show;
}

function normalizeReadmeHtml(html, repository) {
  const parsed = new DOMParser().parseFromString(html, "text/html");
  parsed.querySelectorAll("script, iframe, object, embed, form, input, button, textarea, select, meta, link, base").forEach((node) => node.remove());
  const baseUrl = `https://github.com/${repository.id}/blob/HEAD/`;
  for (const element of parsed.body.querySelectorAll("*")) {
    for (const attribute of [...element.attributes]) {
      const name = attribute.name.toLowerCase();
      if (name.startsWith("on") || name.includes(":") || ["style", "srcdoc", "formaction"].includes(name)) element.removeAttribute(attribute.name);
    }
    if (element.hasAttribute("href")) {
      const href = element.getAttribute("href");
      if (!href?.startsWith("#")) {
        try { const url = new URL(href, baseUrl); if (url.protocol !== "https:") element.removeAttribute("href"); else element.setAttribute("href", url.href); } catch { element.removeAttribute("href"); }
      }
    }
    if (element.hasAttribute("src")) {
      const src = element.getAttribute("src");
      try { const url = new URL(src, baseUrl); if (url.protocol !== "https:" && !(element instanceof HTMLImageElement && url.protocol === "data:")) element.removeAttribute("src"); else element.setAttribute("src", url.href); } catch { element.removeAttribute("src"); }
    }
    if (element instanceof HTMLAnchorElement && !element.getAttribute("href")?.startsWith("#")) { element.target = "_blank"; element.rel = "noopener noreferrer"; }
  }
  return [...parsed.body.childNodes];
}

function showReadme(repository) {
  selectedRepository = repository;
  $("#readme-owner").textContent = repository.id;
  $("#readme-title").textContent = repository.name;
  $("#open-github").onclick = () => window.open(repository.url, "_blank", "noopener");
  modal(true, $("#readme-sheet"));
  $("#close-readme").focus();
  request(`read?id=${encodeURIComponent(repository.id)}`, { method: "POST" }).then((next) => { data = next; }).catch(() => {});
  loadReadme();
}

function closeReadme() {
  const id = selectedRepository?.id;
  readmeRequest += 1;
  selectedRepository = undefined;
  $("#readme-content").replaceChildren();
  modal(false, $("#readme-sheet"));
  render(data);
  document.querySelector(`[data-repository-id="${CSS.escape(id ?? "")}"]`)?.focus();
}

async function loadReadme(force = false) {
  if (!selectedRepository) return;
  const requestId = ++readmeRequest;
  $("#readme-loading").hidden = false;
  $("#readme-error").hidden = true;
  $("#readme-content").hidden = true;
  $("#reload-readme").disabled = true;
  $("#readme-status").textContent = force ? "正在重新抓取…" : "正在抓取 README…";
  try {
    const result = await request(`readme?id=${encodeURIComponent(selectedRepository.id)}${force ? "&refresh=true" : ""}`);
    if (requestId !== readmeRequest) return;
    if (!result.ok) throw new Error(result.error);
    $("#readme-content").replaceChildren(...normalizeReadmeHtml(result.readme.html, selectedRepository));
    $("#readme-content").hidden = false;
    const fetchedAt = new Date(result.readme.fetchedAt);
    const state = result.stale ? "缓存内容，更新失败" : result.cached ? "缓存内容" : "已从 GitHub 抓取";
    $("#readme-status").textContent = `${state} · ${new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(fetchedAt)}`;
  } catch (error) {
    if (requestId !== readmeRequest) return;
    $("#readme-error-message").textContent = error.message;
    $("#readme-error").hidden = false;
    $("#readme-status").textContent = "读取失败";
  } finally {
    if (requestId === readmeRequest) { $("#readme-loading").hidden = true; $("#reload-readme").disabled = false; }
  }
}

function repositoryCard(repository, index, readOnly = false) {
  const card = document.createElement("article");
  const variant = index === 0 ? " board-card--lead" : index === 1 ? " board-card--tall" : index === 2 ? " board-card--wide" : "";
  card.className = `board-card${variant}${repository.read ? " is-read" : ""}`;
  card.dataset.repositoryId = repository.id;
  const top = document.createElement("div"); top.className = "card-topline";
  const rank = document.createElement("span"); rank.textContent = `#${String(repository.rank).padStart(2, "0")}`;
  const gained = document.createElement("span"); gained.textContent = `+${compact(repository.starsGained)} 星`;
  top.append(rank, gained);
  const button = document.createElement("button"); button.className = "card-action"; button.type = "button"; button.dataset.repositoryId = repository.id; button.setAttribute("aria-label", `查看 ${repository.id}`);
  const title = document.createElement("h2"); title.textContent = repository.id;
  const description = document.createElement("p"); description.textContent = repository.description || "暂无描述";
  button.append(title, description);
  const footer = document.createElement("div"); footer.className = "card-footer";
  const language = document.createElement("span"); language.textContent = repository.language;
  const metrics = document.createElement("span"); metrics.textContent = `${compact(repository.stars)} 星 · ${compact(repository.forks)} fork`;
  footer.append(language, metrics);
  button.onclick = () => { if (readOnly) window.open(repository.url, "_blank", "noopener"); else showReadme(repository); };
  card.append(top, button, footer);
  return card;
}

function setStatus(items) {
  const state = refreshing ? "refreshing" : data?.lastError ? "stale" : items.length ? "ready" : "empty";
  const labels = { ready: "已就绪", refreshing: "正在刷新", stale: "显示保留内容", empty: "等待首次刷新" };
  const details = { ready: formatTime(data?.lastSuccessfulRefresh), refreshing: "任务已排队", stale: "刷新失败，保留上次成功结果", empty: "本地还没有仓库记录" };
  $("#status-label").textContent = labels[state]; $("#status-detail").textContent = details[state]; $("#status-dot").dataset.state = state;
}

function render(next) {
  data = next ?? data ?? { repositories: [], view: { period: "daily", language: "all" } };
  const items = repositories();
  $("#repo-list").replaceChildren(...items.map((repo, index) => repositoryCard(repo, index, Boolean(historyView))));
  $("#repo-list").hidden = items.length === 0;
  $("#empty").hidden = items.length > 0;
  $("#empty-title").textContent = data.lastError ? "暂时无法读取趋势" : "还没有趋势仓库";
  $("#empty-copy").textContent = data.lastError ? "请检查来源连接后重试。" : "选择周期和语言，然后执行首次刷新。";
  $("#empty-refresh").textContent = data.lastError ? "重试" : "立即刷新";
  $("#warning").hidden = !(data.lastError && items.length);
  $("#repo-count").textContent = String(items.length);
  $("#refresh-time").textContent = formatTime(data.lastSuccessfulRefresh);
  $("#period").value = data.view?.period ?? "daily";
  $("#language").value = data.view?.language ?? "all";
  $("#view-label").textContent = `${$("#period").value} / ${$("#language").value}`;
  $("#refresh").disabled = refreshing || data.settings?.policy === "disabled";
  $("#period").disabled = Boolean(historyView); $("#language").disabled = Boolean(historyView);
  setStatus(items);
}

async function refresh() {
  if (refreshing) return;
  historyControls?.clear(); historyView = undefined; refreshing = true; render(data);
  try { const refreshed = await request("refresh", { method: "POST" }); data = await request("summary").catch(() => refreshed); }
  catch (error) { const latest = await request("summary").catch(() => data ?? { repositories: [] }); data = { ...latest, lastError: latest?.lastError ?? error.message }; }
  finally { refreshing = false; render(data); }
}

async function viewChanged() {
  if (historyView) return;
  data = await request(`view?period=${encodeURIComponent($("#period").value)}&language=${encodeURIComponent($("#language").value)}`, { method: "POST" });
  render(data);
}

function showSettings(show) {
  const sheet = $("#settings-sheet"); modal(show, sheet);
  if (show && data?.settings) { document.querySelector(`[name=policy][value=${data.settings.policy}]`).checked = true; $("#interval").value = data.settings.intervalMinutes; $("#retention").value = data.settings.retentionDays; $("#interval").disabled = data.settings.policy !== "fixed"; $("#settings-sheet input:checked").focus(); }
  else if (!show) $("#settings").focus();
}

$("#refresh").onclick = $("#retry").onclick = $("#empty-refresh").onclick = refresh;
$("#period").onchange = $("#language").onchange = viewChanged;
$("#settings").onclick = () => showSettings(true);
$("#close-settings").onclick = $("#cancel-settings").onclick = () => showSettings(false);
$("#close-readme").onclick = closeReadme;
$("#scrim").onclick = () => $("#readme-sheet").hidden ? showSettings(false) : closeReadme();
$("#reload-readme").onclick = $("#retry-readme").onclick = () => loadReadme(true);
document.querySelectorAll("[name=policy]").forEach((radio) => radio.onchange = () => { $("#interval").disabled = radio.value !== "fixed"; });
$("#settings-form").onsubmit = async (event) => { event.preventDefault(); const form = new FormData(event.currentTarget); const retentionDays = Number(form.get("retentionDays")); const shorter = retentionDays < data.settings.retentionDays; if (shorter && !await confirmQuestion("缩短历史保留期会删除较早快照。继续？")) return; await request(`settings?policy=${form.get("policy")}&intervalMinutes=${form.get("intervalMinutes")}&retentionDays=${retentionDays}&acknowledgeRetentionCleanup=${shorter}`, { method: "POST" }); data = await request("summary"); render(data); showSettings(false); };
addEventListener("keydown", (event) => { if (event.key === "Escape") { if (!$("#readme-sheet").hidden) closeReadme(); else if (!$("#settings-sheet").hidden) showSettings(false); } });

historyControls = installHistoryControls({ api, actions: document.querySelector(".header-actions"), onSnapshot: (detail) => { historyView = (detail.records ?? []).map(normalizeRepository); render(data); }, onCurrent: () => { historyView = undefined; render(data); } });
request("summary").then(render).catch((error) => { data = { repositories: [], view: { period: "daily", language: "all" }, lastError: error.message }; render(data); });
