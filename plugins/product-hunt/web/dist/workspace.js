import { observeWorkspaceTheme, workspaceTheme } from "/runtime/plugin-sdk.js";
import { confirmQuestion, installHistoryControls } from "./history-controls.js";
import "./export-controls.js";

const applyInfolensTheme = (theme) => document.documentElement.dataset.theme = theme;
applyInfolensTheme(workspaceTheme());
observeWorkspaceTheme(applyInfolensTheme);

const api = new URLSearchParams(location.search).get("apiBaseUrl");
const $ = (selector) => document.querySelector(selector);
let data;
let historyControls;
let detailTrigger;

async function request(route, options) {
  const response = await fetch(new URL(route, api), options);
  if (!response.ok) throw new Error(`Plugin API returned ${response.status}`);
  return response.json();
}

function open(url) {
  window.open(url, "_blank", "noopener");
}

function showDetail(product, readOnly = false) {
  detailTrigger = document.activeElement;
  $("#detail-context").textContent = readOnly ? "Product Hunt - History" : "Product Hunt";
  $("#detail-title").textContent = product.name;
  $("#detail-meta").replaceChildren(...[
    `Rank ${product.rank}`,
    `${product.votes} votes`,
  ].map((value) => {
    const item = document.createElement("span");
    item.textContent = value;
    return item;
  }));
  $("#detail-description").textContent = "Product Hunt launch";
  $("#detail-open").onclick = () => open(product.url);
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
  if (trigger?.isConnected) trigger.focus(); else $(".product-link")?.focus();
}

function productRow(product, readOnly = false) {
  const li = document.createElement("li");
  li.className = `product${product.read ? " is-read" : ""}`;
  const rank = document.createElement("span");
  rank.className = "rank";
  rank.textContent = String(product.rank).padStart(2, "0");
  const content = document.createElement("button");
  content.className = "product-link";
  content.type = "button";
  content.innerHTML = `<strong></strong><span>producthunt.com</span>`;
  content.querySelector("strong").textContent = product.name;
  content.onclick = async () => {
    if(readOnly)return showDetail(product, true);
    showDetail(product);
    data = await request(`read?url=${encodeURIComponent(product.url)}`, { method: "POST" });
    render(data);
  };
  const votes = document.createElement("span");
  votes.className = "votes";
  votes.textContent = `\u25b2 ${product.votes}`;
  li.append(rank, content, votes);
  return li;
}

function render(next) {
  data = next;
  const products = next.products ?? [];
  const disconnected = next.dependencyState === "disconnected";
  $("#dependency").hidden = !disconnected;
  document.querySelector("main").hidden=disconnected;
  $("#products").replaceChildren(...products.map(productRow));
  $("#products").hidden = !products.length;
  $("#empty").hidden = Boolean(products.length);
  $("#warning").hidden = !next.lastError || disconnected;
  const date = next.lastSuccessfulRefresh && new Date(next.lastSuccessfulRefresh);
  $("#refresh-time").textContent = date ? `Updated ${new Intl.DateTimeFormat("en", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(date)}` : "Not refreshed yet";
  $("#refresh").disabled = next.settings?.policy === "disabled";
}

async function load() {
  if (!api) throw new Error("Missing plugin API configuration");
  render(await request("summary"));
}

async function refresh() {
  historyControls?.clear();
  const button = $("#refresh");
  button.disabled = true;
  button.classList.add("spinning");
  $("#refresh-time").textContent = "Queued for refresh...";
  try {
    const refreshed = await request("refresh", { method: "POST" });
    render(await request("summary").catch(() => refreshed));
  } catch (error) {
    const latest = await request("summary").catch(() => data);
    render({ ...latest, lastError: latest?.lastError ?? error.message });
  } finally {
    button.classList.remove("spinning");
    button.disabled = data?.settings?.policy === "disabled";
  }
}

function showSettings(show) {
  $(".workspace").inert = show;
  $("#sheet").hidden = !show;
  $("#scrim").hidden = !show;
  if (show) {
    document.querySelector(`[name=policy][value=${data.settings.policy}]`).checked = true;
    $("#interval").value = data.settings.intervalMinutes;
    $("#retention").value = data.settings.retentionDays;
    $("#interval").disabled = data.settings.policy !== "fixed";
    $("#sheet input:checked").focus();
  } else {
    $("#settings").focus();
  }
}

$("#refresh").onclick = $("#retry").onclick = $("#empty-refresh").onclick = $("#dependency-retry").onclick = refresh;
$("#settings").onclick = () => showSettings(true);
$("#close-settings").onclick = $("#cancel-settings").onclick = () => showSettings(false);
$("#close-detail").onclick = closeDetail;
$("#scrim").onclick = () => $("#detail-sheet").hidden ? showSettings(false) : closeDetail();
document.querySelectorAll("[name=policy]").forEach((radio) => radio.onchange = () => $("#interval").disabled = radio.value !== "fixed");
$("#settings-form").onsubmit = async (event) => {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  const retentionDays = Number(form.get("retentionDays"));
  const shorter = retentionDays < data.settings.retentionDays;
  if (shorter && !await confirmQuestion("Shortening retention permanently deletes older snapshots. Continue?", "Continue", "Cancel")) return;
  await request(`settings?policy=${form.get("policy")}&intervalMinutes=${form.get("intervalMinutes")}&retentionDays=${retentionDays}&acknowledgeRetentionCleanup=${shorter}`, { method: "POST" });
  render(await request("summary"));
  showSettings(false);
};
addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  if (!$("#detail-sheet").hidden) closeDetail();
  else if (!$("#sheet").hidden) showSettings(false);
});
const retentionLabel = document.createElement("label");
retentionLabel.htmlFor = "retention";
retentionLabel.textContent = "History retention";
const retention = document.createElement("select");
retention.id = "retention";
retention.name = "retentionDays";
retention.append(new Option("7 days", "7"), new Option("30 days", "30"), new Option("90 days", "90"));
$("#settings-form").insertBefore(retentionLabel, $(".sheet-actions"));
$("#settings-form").insertBefore(retention, $(".sheet-actions"));
historyControls = installHistoryControls({
  api,
  actions: document.querySelector(".actions"),
  locale: "en",
  onSnapshot: (detail) => {
    const products = detail.records ?? [];
    $("#products").replaceChildren(...products.map((product) => productRow(product, true)));
    $("#products").hidden = !products.length;
    $("#empty").hidden = !products.length;
    $("#warning").hidden = true;
  },
  onCurrent: () => render(data),
});
load().catch((error) => { $("#products").innerHTML = `<li class="loading">${error.message}</li>`; });
