import { observeWorkspaceTheme, workspaceTheme } from "/runtime/plugin-sdk.js";
import { confirmQuestion, installHistoryControls } from "./history-controls.js";
import "./export-controls.js";

const params = new URLSearchParams(location.search);
const applyInfolensTheme = (theme) => document.documentElement.dataset.theme = theme;
applyInfolensTheme(workspaceTheme());
observeWorkspaceTheme(applyInfolensTheme);
const api = params.get("apiBaseUrl") || "../api/";
const root = document.querySelector("#app");
let data;
let refreshing = false;
let settingsOpen = false;
let historyView;
let historyControls;
let detailTrigger;

const icons = {
  refresh: "<svg viewBox=\"0 0 24 24\"><path d=\"M20 12a8 8 0 1 1-2.3-5.7L20 8\"/><path d=\"M20 3v5h-5\"/></svg>",
  settings: "<svg viewBox=\"0 0 24 24\"><circle cx=\"12\" cy=\"12\" r=\"3\"/><path d=\"M19 15a2 2 0 0 0 .4 2l-2.4 2.4a2 2 0 0 0-2-.4 2 2 0 0 0-1 2h-4a2 2 0 0 0-1-2 2 2 0 0 0-2 .4L4.6 17A2 2 0 0 0 5 15a2 2 0 0 0-2-1v-4a2 2 0 0 0 2-1 2 2 0 0 0-.4-2L7 4.6A2 2 0 0 0 9 5a2 2 0 0 0 1-2h4a2 2 0 0 0 1 2 2 2 0 0 0 2-.4L19.4 7A2 2 0 0 0 19 9a2 2 0 0 0 2 1v4a2 2 0 0 0-2 1Z\"/></svg>",
};

async function request(route, method = "GET") {
  const response = await fetch(`${api}${route}`, { method });
  if (!response.ok) throw new Error("Zhihu Hot API is unavailable");
  return response.json();
}

function escape(value) {
  const node = document.createElement("span");
  node.textContent = value ?? "";
  return node.innerHTML;
}

function formatTime(value) {
  return value ? `Updated ${new Date(value).toLocaleString("en", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}` : "Not refreshed yet";
}

function header() {
  return `<header class="workspace-header"><div class="workspace-title"><span class="source-mark">Z</span><div><h1>Zhihu Hot</h1><span class="refresh-time">${formatTime(data?.lastSuccessfulRefresh)}</span></div></div><div class="header-actions"><button class="icon-button ${refreshing ? "spinning" : ""}" id="refresh" aria-label="Refresh" title="Refresh">${icons.refresh}</button><button class="icon-button" id="settings" aria-label="Refresh settings" title="Refresh settings">${icons.settings}</button></div></header>`;
}

function dependency() {
  const disconnected = data.dependencyState === "disconnected";
  return `<section class="dependency"><div class="dependency-icon">${disconnected ? "!" : "Z"}</div><h2>${disconnected ? "Browser connection unavailable" : "Zhihu login required"}</h2><p>${disconnected ? "Zhihu Hot needs an active Browser Bridge connection." : "Sign in to Zhihu in Chrome, then try again."}</p><div class="dependency-actions"><button class="primary" id="retry">Retry</button><button class="secondary" id="recover">${disconnected ? "Install Browser Bridge" : "Open Zhihu"}</button></div></section>`;
}

function content() {
  const questions = historyView?.records ?? data.questions;
  if (!questions.length) return `<section class="empty"><h2>No retained hot questions</h2><p>Refresh once to keep Zhihu Hot on this device.</p><button class="primary" id="empty-refresh">Refresh hot list</button></section>`;
  return `<ol class="question-list">${questions.map((item) => `<li class="question-row ${item.read ? "is-read" : ""}" data-url="${escape(item.url)}" tabindex="0"><span class="rank ${item.rank <= 3 ? "top" : ""}">${item.rank}</span><div><h2>${escape(item.title)}</h2>${item.excerpt ? `<p>${escape(item.excerpt)}</p>` : ""}</div><div class="metrics"><strong>${escape(item.heat)}</strong><span>${item.answers} answers</span></div></li>`).join("")}</ol>`;
}

function warning() {
  return data.lastError && data.dependencyState === "connected" ? `<div class="warning" role="alert"><span>Refresh failed. Showing the last retained list.</span><button id="warning-retry">Retry</button></div>` : "";
}

function sheet() {
  if (!settingsOpen) return "";
  const settings = data.settings;
  return `<div class="scrim" id="scrim"></div><aside class="sheet" role="dialog" aria-modal="true" aria-labelledby="settings-title"><header><h2 id="settings-title">Refresh settings</h2><button class="icon-button" id="close" aria-label="Close">\u00d7</button></header><form id="settings-form"><label><input type="radio" name="policy" value="manual" ${settings.policy === "manual" ? "checked" : ""}> Manual only</label><label><input type="radio" name="policy" value="disabled" ${settings.policy === "disabled" ? "checked" : ""}> Refresh disabled</label><label><input type="radio" name="policy" value="fixed" ${settings.policy === "fixed" ? "checked" : ""}> Fixed interval</label><select name="intervalMinutes" aria-label="Refresh interval"><option value="60">Every hour</option><option value="360">Every 6 hours</option><option value="720">Every 12 hours</option><option value="1440">Every day</option></select><div class="sheet-actions"><button class="secondary" type="button" id="cancel">Cancel</button><button class="primary" type="submit">Save</button></div></form></aside>`;
}

function render() {
  root.innerHTML = header() + warning() + (["disconnected", "login-required"].includes(data?.dependencyState) ? dependency() : content()) + sheet();
  root.querySelectorAll("svg").forEach((icon) => icon.setAttribute("aria-hidden", "true"));
  [...root.children].forEach((element) => { element.inert = settingsOpen && !element.matches(".sheet, .scrim"); });
  bind();
  historyBind();
}

function showDetail(question, readOnly = false) {
  if (!question) return;
  detailTrigger = document.activeElement;
  document.querySelector("#detail-context").textContent = readOnly ? "Zhihu Hot - History" : "Zhihu Hot";
  document.querySelector("#detail-title").textContent = question.title;
  document.querySelector("#detail-meta").replaceChildren(...[
    `Rank ${question.rank}`,
    `Heat ${question.heat}`,
    `${question.answers} answers`,
  ].map((value) => {
    const item = document.createElement("span");
    item.textContent = value;
    return item;
  }));
  document.querySelector("#detail-description").textContent = question.excerpt || "No excerpt retained for this question.";
  document.querySelector("#detail-open").onclick = () => window.open(question.url, "_blank", "noopener");
  root.inert = true;
  document.querySelector("#detail-scrim").hidden = false;
  document.querySelector("#detail-sheet").hidden = false;
  document.querySelector("#close-detail").focus();
}

function closeDetail() {
  const trigger = detailTrigger;
  detailTrigger = undefined;
  root.inert = false;
  document.querySelector("#detail-scrim").hidden = true;
  document.querySelector("#detail-sheet").hidden = true;
  if (trigger?.isConnected) trigger.focus();
}

function historyBind() {
  historyControls = installHistoryControls({
    api,
    actions: document.querySelector(".header-actions"),
    onSnapshot: (detail) => { historyView = detail; render(); },
    onCurrent: () => { historyView = undefined; render(); },
  });
  if (!settingsOpen) return;
  const form = document.querySelector("#settings-form");
  const label = document.createElement("label");
  label.htmlFor = "retention";
  label.textContent = "History retention";
  const select = document.createElement("select");
  select.id = "retention";
  select.value = String(data.settings.retentionDays);
  select.append(new Option("7 days", "7"), new Option("30 days", "30"), new Option("90 days", "90"));
  select.value = String(data.settings.retentionDays);
  select.onchange = async () => {
    const retentionDays = Number(select.value);
    const shorter = retentionDays < data.settings.retentionDays;
    if (shorter && !await confirmQuestion("Shortening retention permanently deletes older snapshots. Continue?")) { select.value = String(data.settings.retentionDays); return; }
    data.settings = await request(`settings?policy=${data.settings.policy}&intervalMinutes=${data.settings.intervalMinutes}&retentionDays=${retentionDays}&acknowledgeRetentionCleanup=${shorter}`, "POST");
  };
  form.insertBefore(label, form.querySelector(".sheet-actions"));
  form.insertBefore(select, form.querySelector(".sheet-actions"));
}

async function refresh() {
  if (refreshing) return;
  historyControls?.clear();
  historyView = undefined;
  refreshing = true;
  render();
  try {
    data = await request("refresh", "POST");
    data = await request("summary").catch(() => data);
  } catch (error) {
    const latest = await request("summary").catch(() => data);
    data = { ...latest, lastError: latest?.lastError ?? error.message };
  } finally {
    refreshing = false;
    render();
  }
}

function bind() {
  document.querySelector("#refresh")?.addEventListener("click", refresh);
  for (const id of ["retry", "empty-refresh", "warning-retry"]) document.querySelector(`#${id}`)?.addEventListener("click", refresh);
  document.querySelector("#settings")?.addEventListener("click", () => { settingsOpen = true; render(); document.querySelector("input[name=policy]:checked")?.focus(); });
  for (const id of ["close", "cancel", "scrim"]) document.querySelector(`#${id}`)?.addEventListener("click", () => { settingsOpen = false; render(); document.querySelector("#settings")?.focus(); });
  document.querySelector("#recover")?.addEventListener("click", () => window.open(data.dependencyState === "disconnected" ? "https://chromewebstore.google.com/detail/opencli/ildkmabpimmkaediidaifkhjpohdnifk" : "https://www.zhihu.com/", "_blank", "noopener"));
  document.querySelectorAll(".question-row").forEach((row) => {
    const open = async () => { if(!historyView){await request(`read?url=${encodeURIComponent(row.dataset.url)}`, "POST");data=await request("summary");} const question = (historyView?.records ?? data.questions).find((item) => item.url === row.dataset.url); showDetail(question, Boolean(historyView)); };
    row.addEventListener("click", open);
    row.addEventListener("keydown", (event) => { if (event.key === "Enter") open(); });
  });
  document.querySelector("#settings-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    data.settings = await request(`settings?policy=${encodeURIComponent(form.get("policy"))}&intervalMinutes=${encodeURIComponent(form.get("intervalMinutes"))}`, "POST");
    settingsOpen = false;
    render();
  });
  const interval = document.querySelector("[name=intervalMinutes]");
  if (interval) interval.value = String(data.settings.intervalMinutes);
}

document.querySelector("#close-detail").addEventListener("click", closeDetail);
document.querySelector("#detail-scrim").addEventListener("click", closeDetail);
document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  if (!document.querySelector("#detail-sheet").hidden) closeDetail();
  else if (settingsOpen) { settingsOpen = false; render(); }
});
request("summary").then((value) => { data = value; render(); }).catch((error) => { root.innerHTML = `<div class="loading">${escape(error.message)}</div>`; });
