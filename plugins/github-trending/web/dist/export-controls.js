import { copyDownloadable, downloadExport } from "/runtime/plugin-sdk.js";

const formats = ["json", "csv", "markdown", "text"];
const formatLabels = { json: "JSON", csv: "CSV", markdown: "Markdown", text: "纯文本" };
const errorMessages = {
  EXPORT_REQUEST_FAILED: "导出失败，请重试。",
  EXPORT_TOO_LARGE: "导出内容过大，无法复制。",
  UNSUPPORTED_EXPORT_TYPE: "此格式不支持复制。",
  CLIPBOARD_UNAVAILABLE: "剪贴板不可用。",
  CLIPBOARD_DENIED: "剪贴板权限被拒绝。",
};
const previewLimit = 12_000;
const datePattern = /^\d{4}-\d{2}-\d{2}$/u;

function formatDate(value) {
  if (!datePattern.test(value)) return value;
  return new Intl.DateTimeFormat("zh-CN", { timeZone: "UTC", year: "numeric", month: "short", day: "numeric" }).format(new Date(`${value}T00:00:00.000Z`));
}

export function installExportControls(actions, api) {
  if (!actions || !api || actions.querySelector("[data-export-controls]")) return;
  const controls = document.createElement("div");
  controls.className = "export-controls";
  controls.dataset.exportControls = "true";

  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "icon-button export-trigger";
  toggle.setAttribute("aria-label", "Export");
  toggle.title = "导出";
  toggle.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v12m0 0 4-4m-4 4-4-4M5 21h14"/></svg>';
  toggle.setAttribute("aria-haspopup", "true");
  toggle.setAttribute("aria-expanded", "false");

  const menu = document.createElement("div");
  menu.className = "export-menu";
  menu.hidden = true;
  menu.setAttribute("aria-label", "导出选项");

  const fields = document.createElement("div");
  fields.className = "export-menu-fields";

  const formatLabel = document.createElement("label");
  formatLabel.className = "export-format";
  formatLabel.textContent = "格式";
  const formatSelect = document.createElement("select");
  formatSelect.setAttribute("aria-label", "导出格式");
  for (const format of formats) {
    const option = document.createElement("option");
    option.value = format;
    option.textContent = formatLabels[format];
    formatSelect.append(option);
  }
  formatLabel.append(formatSelect);

  const dateLabel = document.createElement("label");
  dateLabel.className = "export-format";
  dateLabel.textContent = "按日期";
  const dateSelect = document.createElement("select");
  dateSelect.setAttribute("aria-label", "导出日期");
  const allDates = document.createElement("option");
  allDates.value = "";
  allDates.textContent = "全部保留日期";
  dateSelect.append(allDates);
  dateLabel.append(dateSelect);
  fields.append(formatLabel, dateLabel);

  const previewPanel = document.createElement("section");
  previewPanel.className = "export-preview-panel";
  previewPanel.setAttribute("aria-label", "导出预览");
  const previewHead = document.createElement("div");
  previewHead.className = "export-preview-head";
  const previewTitle = document.createElement("strong");
  previewTitle.textContent = "预览";
  const previewMeta = document.createElement("span");
  previewMeta.className = "export-preview-meta";
  previewMeta.setAttribute("role", "status");
  previewHead.append(previewTitle, previewMeta);
  const preview = document.createElement("pre");
  preview.className = "export-preview";
  preview.setAttribute("aria-label", "导出内容预览");
  preview.textContent = "打开导出菜单后生成预览。";
  previewPanel.append(previewHead, preview);

  const copy = document.createElement("button");
  copy.type = "button";
  copy.className = "export-action";
  copy.textContent = "复制";
  copy.title = "复制当前筛选的导出内容";
  const download = document.createElement("button");
  download.type = "button";
  download.className = "export-action";
  download.textContent = "下载";
  download.title = "下载当前筛选的导出内容";
  const menuActions = document.createElement("div");
  menuActions.className = "export-menu-actions";
  const status = document.createElement("span");
  status.className = "export-status";
  status.setAttribute("role", "status");
  menuActions.append(copy, download);
  menu.append(fields, previewPanel, menuActions, status);
  controls.append(toggle, menu);
  actions.prepend(controls);

  let datesLoaded = false;
  let datesRequest;
  let previewRequest = 0;

  function routeForSelection() {
    const params = new URLSearchParams({ format: formatSelect.value });
    if (dateSelect.value) params.set("date", dateSelect.value);
    return `export?${params.toString()}`;
  }

  function setActionBusy(busy) {
    copy.disabled = busy;
    download.disabled = busy;
  }

  function loadDates(force = false) {
    if (!force && datesLoaded) return Promise.resolve();
    if (datesRequest) return datesRequest;
    datesRequest = (async () => {
      const response = await fetch(new URL("export/dates", api), { credentials: "same-origin" });
      if (!response.ok) throw new Error(`插件 API 返回 ${response.status}`);
      const result = await response.json();
      const dates = Array.isArray(result?.dates)
        ? result.dates.filter((item) => datePattern.test(item?.date))
        : [];
      const selectedDate = dateSelect.value;
      dateSelect.replaceChildren(allDates, ...dates.map((item) => {
        const option = document.createElement("option");
        option.value = item.date;
        option.textContent = `${formatDate(item.date)}（${item.snapshotCount} 个快照）`;
        return option;
      }));
      if (dates.some((item) => item.date === selectedDate)) dateSelect.value = selectedDate;
      datesLoaded = true;
    })().finally(() => { datesRequest = undefined; });
    return datesRequest;
  }

  async function refreshPreview() {
    const requestId = ++previewRequest;
    setActionBusy(true);
    preview.classList.remove("is-error");
    preview.textContent = "正在生成预览...";
    previewMeta.textContent = "读取筛选后的导出内容";
    try {
      const response = await fetch(new URL(routeForSelection(), api), { credentials: "same-origin" });
      if (!response.ok) throw new Error(`插件 API 返回 ${response.status}`);
      const value = await response.text();
      if (requestId !== previewRequest) return;
      const clipped = value.length > previewLimit;
      preview.textContent = value ? value.slice(0, previewLimit) : "暂无可导出的快照。";
      previewMeta.textContent = `${dateSelect.value ? formatDate(dateSelect.value) : "全部保留日期"} · ${formatLabels[formatSelect.value]} · ${value.length.toLocaleString("zh-CN")} 字符${clipped ? ` · 仅显示前 ${previewLimit.toLocaleString("zh-CN")} 字符` : ""}`;
    } catch (error) {
      if (requestId !== previewRequest) return;
      preview.classList.add("is-error");
      preview.textContent = "无法生成预览，请重试。";
      previewMeta.textContent = error?.message ?? "导出请求失败";
    } finally {
      if (requestId === previewRequest) setActionBusy(false);
    }
  }

  async function preparePreview(refreshDates = false) {
    try {
      await loadDates(refreshDates);
    } catch (error) {
      previewMeta.textContent = `日期列表读取失败：${error?.message ?? "请求失败"}`;
    }
    if (!menu.hidden) await refreshPreview();
  }

  function setOpen(open) {
    menu.hidden = !open;
    toggle.setAttribute("aria-expanded", String(open));
    if (open) {
      formatSelect.focus();
      void preparePreview(true);
    } else {
      previewRequest += 1;
    }
  }

  toggle.onclick = () => setOpen(menu.hidden);
  formatSelect.onchange = () => { status.textContent = ""; void refreshPreview(); };
  dateSelect.onchange = () => { status.textContent = ""; void refreshPreview(); };
  document.addEventListener("pointerdown", (event) => {
    if (!controls.contains(event.target)) setOpen(false);
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !menu.hidden) {
      setOpen(false);
      toggle.focus();
    }
  });

  async function run(action) {
    setActionBusy(true);
    status.textContent = "正在处理...";
    const route = routeForSelection();
    try {
      if (action === "copy") {
        await copyDownloadable(route);
        status.textContent = "已复制。";
      } else {
        await downloadExport(route);
        status.textContent = "已开始下载。";
      }
    } catch (error) {
      status.textContent = errorMessages[error?.code] ?? "导出失败，请重试。";
    } finally {
      setActionBusy(false);
    }
  }

  copy.onclick = () => { void run("copy"); };
  download.onclick = () => { void run("download"); };
}

const api = new URLSearchParams(location.search).get("apiBaseUrl");
const mount = () => installExportControls(document.querySelector(".header-actions"), api);
mount();
new MutationObserver(mount).observe(document.body, { childList: true, subtree: true });
