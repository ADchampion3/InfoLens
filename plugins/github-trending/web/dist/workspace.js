import { observeWorkspaceTheme, workspaceTheme } from "/runtime/plugin-sdk.js";
import { confirmQuestion, installHistoryControls } from "./history-controls.js";

const applyInfolensTheme = (theme) => document.documentElement.dataset.theme = theme;
applyInfolensTheme(workspaceTheme());
observeWorkspaceTheme(applyInfolensTheme);

const api = new URLSearchParams(location.search).get("apiBaseUrl");
const $ = (selector) => document.querySelector(selector);
let data;
let selectedRepository;
let readmeRequest = 0;
let historyControls;

async function request(route, options) {
  const response = await fetch(new URL(route, api), options);
  if (!response.ok) throw new Error(`插件 API 返回 ${response.status}`);
  return response.json();
}

function compact(number) {
  return new Intl.NumberFormat("zh-CN", { notation: "compact", maximumFractionDigits: 1 }).format(number);
}

function row(repo, readOnly = false) {
  const li = document.createElement("li");
  li.className = `repo-row${repo.read ? " is-read" : ""}`;
  const button = document.createElement("button");
  button.className = "repo-open";
  button.type = "button";
  button.dataset.repositoryId = repo.id;
  button.setAttribute("aria-label", `查看 ${repo.owner} / ${repo.name} 的 README`);
  button.onclick = () => readOnly ? window.open(repo.url, "_blank", "noopener") : showReadme(repo);
  const rank = document.createElement("span");
  rank.className = "rank";
  rank.textContent = repo.rank;
  const content = document.createElement("div");
  const name = document.createElement("h2");
  name.textContent = `${repo.owner} / ${repo.name}`;
  const description = document.createElement("p");
  description.textContent = repo.description || "暂无描述";
  const meta = document.createElement("div");
  meta.className = "metadata";
  if (repo.language) {
    const dot = document.createElement("i");
    dot.style.setProperty("--language-color", repo.languageColor || "var(--color-muted)");
    meta.append(dot, repo.language);
  }
  const metrics = document.createElement("span");
  metrics.textContent = `★ ${compact(repo.stars)}   分支 ${compact(repo.forks)}`;
  meta.append(metrics);
  const gained = document.createElement("strong");
  gained.textContent = `+${compact(repo.starsGained)} 星`;
  content.append(name, description, meta);
  button.append(rank, content, gained);
  li.append(button);
  return li;
}

function render(next) {
  data = next;
  const repos = next.repositories ?? [];
  $("#repo-list").replaceChildren(...repos.map(row));
  $("#repo-list").hidden = !repos.length;
  $("#empty").hidden = !!repos.length;
  $("#warning").hidden = !next.lastError;
  const date = next.lastSuccessfulRefresh && new Date(next.lastSuccessfulRefresh);
  $("#refresh-time").textContent = date ? `上次刷新 ${new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(date)}` : "尚未刷新";
  $("#period").value = next.view.period;
  $("#language").value = next.view.language;
  $("#refresh").disabled = next.settings.policy === "disabled";
  $("#period").disabled = false;
  $("#language").disabled = false;
}

function renderHistory(detail) {
  const repos = detail.records ?? [];
  $("#repo-list").replaceChildren(...repos.map((repo) => row(repo, true)));
  $("#repo-list").hidden = !repos.length;
  $("#empty").hidden = Boolean(repos.length);
  $("#warning").hidden = true;
  $("#period").disabled = true;
  $("#language").disabled = true;
}

async function refresh() {
  historyControls?.clear();
  const button = $("#refresh");
  button.disabled = true;
  button.classList.add("spinning");
  $("#refresh-time").textContent = "正在刷新...";
  try {
    const refreshed = await request("refresh", { method: "POST" });
    render(await request("summary").catch(() => refreshed));
  } catch (error) {
    const latest = await request("summary").catch(() => data);
    render({ ...latest, lastError: latest?.lastError ?? error.message });
  } finally {
    button.classList.remove("spinning");
    button.disabled = data?.settings.policy === "disabled";
  }
}

async function viewChanged() {
  data = await request(`view?period=${encodeURIComponent($("#period").value)}&language=${encodeURIComponent($("#language").value)}`, { method: "POST" });
  render(data);
}

function modal(show, element) {
  $(".workspace").inert = show;
  $("#scrim").hidden = !show;
  element.hidden = !show;
}

function showSettings(show) {
  const sheet = $("#settings-sheet");
  modal(show, sheet);
  if (show) {
    const settings = data.settings;
    document.querySelector(`[name=policy][value=${settings.policy}]`).checked = true;
    $("#interval").value = settings.intervalMinutes;
    $("#retention").value = settings.retentionDays;
    $("#interval").disabled = settings.policy !== "fixed";
    $("#settings-sheet input:checked").focus();
  } else {
    $("#settings").focus();
  }
}

function renderReadme(readme, repository) {
  const document = new DOMParser().parseFromString(readme.html, "text/html");
  document.querySelectorAll("script, iframe, object, embed, form, input, button, textarea, select, meta, link, base").forEach((node) => node.remove());
  const baseUrl = `https://github.com/${repository.id}/blob/HEAD/`;
  for (const element of document.body.querySelectorAll("*")) {
    for (const attribute of [...element.attributes]) {
      const name = attribute.name.toLowerCase();
      if (name.startsWith("on") || name.includes(":") || ["style", "srcdoc", "formaction"].includes(name)) element.removeAttribute(attribute.name);
    }
    if (element.hasAttribute("href")) {
      const href = element.getAttribute("href");
      if (!href?.startsWith("#")) {
        try {
          const url = new URL(href, baseUrl);
          if (url.protocol !== "https:") element.removeAttribute("href");
          else element.setAttribute("href", url.href);
        } catch { element.removeAttribute("href"); }
      }
    }
    if (element.hasAttribute("src")) {
      const src = element.getAttribute("src");
      try {
        const url = new URL(src, baseUrl);
        if (url.protocol !== "https:" && !(element instanceof HTMLImageElement && url.protocol === "data:")) element.removeAttribute("src");
        else element.setAttribute("src", url.href);
      } catch { element.removeAttribute("src"); }
    }
    if (element instanceof HTMLAnchorElement) {
      if (element.getAttribute("href")?.startsWith("#")) {
        element.removeAttribute("target");
        element.removeAttribute("rel");
      } else {
        element.target = "_blank";
        element.rel = "noopener noreferrer";
      }
    }
  }
  const content = $("#readme-content");
  content.replaceChildren(...document.body.childNodes);
  content.hidden = false;
}

async function loadReadme(force = false) {
  if (!selectedRepository) return;
  const requestId = ++readmeRequest;
  $("#readme-loading").hidden = false;
  $("#readme-error").hidden = true;
  $("#readme-content").hidden = true;
  $("#reload-readme").disabled = true;
  $("#readme-status").textContent = force ? "正在重新抓取..." : "正在抓取 README...";
  try {
    const result = await request(`readme?id=${encodeURIComponent(selectedRepository.id)}${force ? "&refresh=true" : ""}`);
    if (requestId !== readmeRequest) return;
    if (!result.ok) throw new Error(result.error);
    renderReadme(result.readme, selectedRepository);
    const date = new Date(result.readme.fetchedAt);
    const state = result.stale ? "缓存内容，更新失败" : result.cached ? "缓存内容" : "已从 GitHub 抓取";
    $("#readme-status").textContent = `${state} · ${new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(date)}`;
  } catch (error) {
    if (requestId !== readmeRequest) return;
    $("#readme-error-message").textContent = error.message;
    $("#readme-error").hidden = false;
    $("#readme-status").textContent = "抓取失败";
  } finally {
    if (requestId === readmeRequest) {
      $("#readme-loading").hidden = true;
      $("#reload-readme").disabled = false;
    }
  }
}

function showReadme(repository) {
  selectedRepository = repository;
  $("#readme-owner").textContent = repository.owner;
  $("#readme-title").textContent = repository.name;
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

$("#refresh").onclick = $("#retry").onclick = $("#empty-refresh").onclick = refresh;
$("#period").onchange = $("#language").onchange = viewChanged;
$("#settings").onclick = () => showSettings(true);
$("#close-settings").onclick = $("#cancel-settings").onclick = () => showSettings(false);
$("#close-readme").onclick = closeReadme;
$("#scrim").onclick = () => $("#readme-sheet").hidden ? showSettings(false) : closeReadme();
$("#reload-readme").onclick = $("#retry-readme").onclick = () => loadReadme(true);
$("#open-github").onclick = () => selectedRepository && window.open(selectedRepository.url, "_blank", "noopener");
document.querySelectorAll("[name=policy]").forEach((radio) => radio.onchange = () => $("#interval").disabled = radio.value !== "fixed");
$("#settings-form").onsubmit = async (event) => {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  const retentionDays = Number(form.get("retentionDays"));
  const shorter = retentionDays < data.settings.retentionDays;
  if (shorter && !await confirmQuestion("缩短保留期会永久删除较早快照。继续？")) return;
  await request(`settings?policy=${form.get("policy")}&intervalMinutes=${form.get("intervalMinutes")}&retentionDays=${retentionDays}&acknowledgeRetentionCleanup=${shorter}`, { method: "POST" });
  render(await request("summary"));
  showSettings(false);
};
addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  if (!$("#readme-sheet").hidden) closeReadme();
  else if (!$("#settings-sheet").hidden) showSettings(false);
});
historyControls = installHistoryControls({ api, actions: $(".header-actions"), onSnapshot: renderHistory, onCurrent: () => render(data) });
const retentionLabel=document.createElement("label");retentionLabel.className="select-field";retentionLabel.htmlFor="retention";retentionLabel.textContent="历史保留";const retention=document.createElement("select");retention.id="retention";retention.name="retentionDays";retention.innerHTML='<option value="7">7 天</option><option value="30">30 天</option><option value="90">90 天</option>';$("#settings-form").insertBefore(retentionLabel,$(".sheet-actions"));$("#settings-form").insertBefore(retention,$(".sheet-actions"));
request("summary").then(render).catch((error) => $("#repo-list").innerHTML = `<li class="loading">${error.message}</li>`);
