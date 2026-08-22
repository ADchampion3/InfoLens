import { copyDownloadable, downloadExport } from "/runtime/plugin-sdk.js";

const formats = ["json", "csv", "markdown", "text"];
const labels = { json: "JSON", csv: "CSV", markdown: "Markdown", text: "Text" };

export function installExportControls(actions) {
  if (!actions || actions.querySelector("[data-export-controls]")) return;
  const root = document.createElement("div");
  root.className = "export-controls";
  root.dataset.exportControls = "true";

  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "icon-button export-trigger";
  toggle.setAttribute("aria-label", "Export");
  toggle.setAttribute("aria-expanded", "false");
  toggle.setAttribute("aria-haspopup", "menu");
  toggle.title = "Export";
  toggle.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v12m0 0 4-4m-4 4-4-4M5 21h14"/></svg>';

  const menu = document.createElement("div");
  menu.className = "export-menu";
  menu.setAttribute("role", "menu");
  menu.hidden = true;
  const select = document.createElement("select");
  select.setAttribute("aria-label", "Export format");
  for (const format of formats) {
    const option = document.createElement("option");
    option.value = format;
    option.textContent = labels[format];
    select.append(option);
  }
  const copy = document.createElement("button");
  copy.type = "button";
  copy.textContent = "Copy";
  const download = document.createElement("button");
  download.type = "button";
  download.textContent = "Download";
  const status = document.createElement("span");
  status.setAttribute("role", "status");
  menu.append(select, copy, download, status);
  root.append(toggle, menu);
  actions.prepend(root);

  const close = () => {
    menu.hidden = true;
    toggle.setAttribute("aria-expanded", "false");
  };
  toggle.onclick = () => {
    menu.hidden = !menu.hidden;
    toggle.setAttribute("aria-expanded", String(!menu.hidden));
    if (!menu.hidden) select.focus();
  };
  document.addEventListener("pointerdown", (event) => {
    if (!root.contains(event.target)) close();
  });

  const run = async (operation) => {
    copy.disabled = true;
    download.disabled = true;
    status.textContent = "Working...";
    try {
      const route = `export?format=${encodeURIComponent(select.value)}`;
      if (operation === "copy") await copyDownloadable(route);
      else await downloadExport(route);
      status.textContent = operation === "copy" ? "Copied" : "Download started";
    } catch (error) {
      status.textContent = error?.message ?? "Export failed";
    } finally {
      copy.disabled = false;
      download.disabled = false;
    }
  };
  copy.onclick = () => run("copy");
  download.onclick = () => run("download");
}

const mount = () => installExportControls(document.querySelector(".header-actions"));
mount();
new MutationObserver(mount).observe(document.body, { childList: true, subtree: true });
