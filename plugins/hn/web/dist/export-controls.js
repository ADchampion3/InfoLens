import { copyDownloadable, downloadExport } from "/runtime/plugin-sdk.js";

const formats = ["json", "csv", "markdown", "text"];
const formatLabels = { json: "JSON", csv: "CSV", markdown: "Markdown", text: "Plain text" };
const errorMessages = {
  EXPORT_REQUEST_FAILED: "Export failed. Try again.",
  EXPORT_TOO_LARGE: "This export is too large to copy.",
  UNSUPPORTED_EXPORT_TYPE: "This format cannot be copied.",
  CLIPBOARD_UNAVAILABLE: "Clipboard access is unavailable.",
  CLIPBOARD_DENIED: "Clipboard access was denied.",
};

export function installExportControls(actions, api) {
  if (!actions || actions.querySelector("[data-export-controls]")) return;
  const controls = document.createElement("div");
  controls.className = "export-controls";
  controls.dataset.exportControls = "true";
  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "icon-button export-trigger";
  toggle.setAttribute("aria-label", "Export");
  toggle.title = "Export";
  toggle.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v12m0 0 4-4m-4 4-4-4M5 21h14"/></svg>';
  toggle.setAttribute("aria-haspopup", "true");
  toggle.setAttribute("aria-expanded", "false");
  const menu = document.createElement("div");
  menu.className = "export-menu";
  menu.hidden = true;
  menu.setAttribute("aria-label", "Export options");
  const formatLabel = document.createElement("label");
  formatLabel.className = "export-format";
  formatLabel.textContent = "Format";
  const select = document.createElement("select");
  select.setAttribute("aria-label", "Export format");
  for (const format of formats) {
    const option = document.createElement("option");
    option.value = format;
    option.textContent = formatLabels[format];
    select.append(option);
  }
  formatLabel.append(select);
  const copy = document.createElement("button");
  copy.type = "button";
  copy.className = "export-action";
  copy.textContent = "Copy";
  copy.title = "Copy the selected export";
  const download = document.createElement("button");
  download.type = "button";
  download.className = "export-action";
  download.textContent = "Download";
  download.title = "Download the selected export";
  const menuActions = document.createElement("div");
  menuActions.className = "export-menu-actions";
  const status = document.createElement("span");
  status.className = "export-status";
  status.setAttribute("role", "status");
  menuActions.append(copy, download);
  menu.append(formatLabel, menuActions, status);
  controls.append(toggle, menu);
  actions.prepend(controls);

  function setOpen(open) {
    menu.hidden = !open;
    toggle.setAttribute("aria-expanded", String(open));
    if (open) select.focus();
  }

  toggle.onclick = () => setOpen(menu.hidden);
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
    copy.disabled = true;
    download.disabled = true;
    status.textContent = "Working...";
    const route = `export?format=${encodeURIComponent(select.value)}`;
    try {
      if (action === "copy") {
        await copyDownloadable(route);
        status.textContent = "Copied.";
      } else {
        await downloadExport(route);
        status.textContent = "Download started.";
      }
    } catch (error) {
      status.textContent = errorMessages[error?.code] ?? "Export failed. Try again.";
    } finally {
      copy.disabled = false;
      download.disabled = false;
    }
  }
  copy.onclick = () => run("copy");
  download.onclick = () => run("download");
}

const api = new URLSearchParams(location.search).get("apiBaseUrl");
const mount = () => installExportControls(document.querySelector(".header-actions"), api);
mount();
new MutationObserver(mount).observe(document.body, { childList: true, subtree: true });
