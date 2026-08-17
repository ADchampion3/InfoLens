import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import vm from "node:vm";
import { test } from "node:test";

const root = path.resolve(import.meta.dirname, "..");
const workspaces = ["hn", "github-trending", "zhihu-hot", "product-hunt"];

function refreshFunction(source) {
  const start = source.indexOf("async function refresh");
  assert.notEqual(start, -1, "workspace must define refresh()");
  const blockEnd = source.indexOf("\n}\n", start);
  if (blockEnd !== -1) return source.slice(start, blockEnd + 2);
  const lineEnd = source.indexOf("\n", start);
  return source.slice(start, lineEnd === -1 ? source.length : lineEnd);
}

for (const pluginId of workspaces) {
  test(`${pluginId} styles preserve the hidden attribute`, async () => {
    const styles = await readFile(path.join(root, "plugins", pluginId, "web", "dist", "styles.css"), "utf8");
    assert.match(styles, /\[hidden\]\{display:none!important\}/, `${pluginId} CSS overrides hidden elements back into the layout`);
  });

  test(`${pluginId} clears stale failure feedback from the successful refresh response`, async () => {
    const source = await readFile(path.join(root, "plugins", pluginId, "web", "dist", "workspace.js"), "utf8");
    const refresh = refreshFunction(source);
    const context = {
      data: { lastError: "old failure", settings: { policy: "manual" } },
      refreshing: false,
      rendered: undefined,
      button: { disabled: false, classList: { add() {}, remove() {} } },
    };
    vm.runInNewContext(`
      let data = globalThis.data;
      let refreshing = globalThis.refreshing;
      const historyControls = undefined;
      const $ = () => globalThis.button;
      const render = (next) => { if (next) data = next; globalThis.rendered = data; };
      const request = async (route) => {
        if (route === "refresh") return { ok: true, settings: { policy: "manual" } };
        throw new Error("summary unavailable");
      };
      ${refresh}
      globalThis.run = refresh;
    `, context);

    await context.run();
    assert.equal(context.rendered?.lastError, undefined, `${pluginId} kept the stale failure banner after a successful refresh`);
  });
}

test("Product Hunt connection recovery is a separate page from retained content", async () => {
  const source = await readFile(path.join(root, "plugins", "product-hunt", "web", "dist", "workspace.js"), "utf8");
  assert.match(source, /document\.querySelector\("main"\)\.hidden=disconnected;/);
  assert.doesNotMatch(source, /document\.querySelector\("main"\)\.hidden=disconnected&&!products\.length/);
});

test("workspaces use Plugin-owned export controls and streaming SDK delivery", async () => {
  const sharedControls = await readFile(path.join(root, "packages/plugin-workspace/src/history-controls.js"), "utf8");
  assert.doesNotMatch(sharedControls, /\bconfirm\(/);
  assert.doesNotMatch(sharedControls, /URL\.createObjectURL/);
  const hostSource = await readFile(path.join(root, "apps/desktop/src/App.tsx"), "utf8");
  assert.match(hostSource, /allow="clipboard-write"/, "Plugin Workspace iframe must grant clipboard write through Permissions Policy");
  const workspaces = ["hn", "github-trending", "zhihu-hot", "product-hunt"];
  for (const pluginId of workspaces) {
    const source = await readFile(path.join(root, "plugins", pluginId, "web", "dist", "workspace.js"), "utf8");
    assert.doesNotMatch(source, /\bconfirm\(/, `${pluginId} still calls the native confirm() dialog, which Blink blocks in the Electron sandboxed iframe`);
    assert.match(source, /export-controls\.js/, `${pluginId} must load its Plugin-owned export controls`);
    assert.doesNotMatch(source, /location\.href\s*=\s*new URL\("export"/, `${pluginId} must not navigate the workspace to the export endpoint`);
    const controls = await readFile(path.join(root, "plugins", pluginId, "web", "dist", "export-controls.js"), "utf8");
    assert.match(controls, /copyDownloadable/);
    assert.match(controls, /downloadExport/);
    assert.match(controls, /export-trigger/);
    assert.match(controls, /export-menu/);
    assert.match(controls, /aria-expanded/);
    assert.match(controls, /aria-label", "Export"/);
    assert.match(controls, /M12 3v12m0 0 4-4m-4 4-4-4M5 21h14/);
    assert.doesNotMatch(controls, /toggle\.textContent\s*=\s*"Export"/);
    assert.doesNotMatch(controls, /createObjectURL|response\.blob/);
  }
});

test("GitHub Trending export controls preview and filter retained snapshots by date", async () => {
  const controls = await readFile(path.join(root, "plugins/github-trending/web/dist/export-controls.js"), "utf8");
  assert.match(controls, /export\/dates/);
  assert.match(controls, /export-preview/);
  assert.match(controls, /params\.set\("date", dateSelect\.value\)/);
  assert.match(controls, /response\.text\(\)/);
  assert.match(controls, /copyDownloadable\(route\)/);
  assert.match(controls, /downloadExport\(route\)/);
});

test("non-GitHub workspaces provide internal details and external browser actions", async () => {
  for (const pluginId of ["hn", "product-hunt", "zhihu-hot"]) {
    const html = await readFile(path.join(root, "plugins", pluginId, "web", "dist", "index.html"), "utf8");
    const source = await readFile(path.join(root, "plugins", pluginId, "web", "dist", "workspace.js"), "utf8");
    assert.match(html, /id="detail-sheet"/, `${pluginId} has no internal detail view`);
    assert.match(source, /showDetail/, `${pluginId} has no internal detail action`);
    assert.match(source, /window\.open\(/, `${pluginId} has no external browser action`);
  }
  const hostSource = await readFile(path.join(root, "apps/desktop/main.cjs"), "utf8");
  assert.match(hostSource, /setWindowOpenHandler/);
  assert.match(hostSource, /shell\.openExternal/);
});

function fakeConfirmDialog() {
  const listeners = new Map();
  const nodes = {};
  return {
    opened: false,
    returnValue: "",
    listeners,
    nodes,
    querySelector(selector) {
      if (!nodes[selector]) nodes[selector] = { textContent: "" };
      return nodes[selector];
    },
    addEventListener(event, fn) { listeners.set(event, fn); },
    showModal() { this.opened = true; },
    close(value) { this.returnValue = value; listeners.get("close")?.(); },
  };
}

test("confirmQuestion resolves true on continue, false on cancel or Escape", async () => {
  const { confirmQuestion } = await import(pathToFileURL(path.join(root, "packages", "plugin-workspace", "src", "history-controls.js")).href);
  const dialog = fakeConfirmDialog();
  const previous = globalThis.document;
  globalThis.document = { querySelector: (selector) => selector === "#infolens-confirm-dialog" ? dialog : null };
  try {
    const accept = confirmQuestion("导出文件可能包含私有来源内容。继续下载？", "继续下载", "取消");
    assert.equal(dialog.opened, true);
    assert.equal(dialog.nodes[".confirm-message"].textContent, "导出文件可能包含私有来源内容。继续下载？");
    assert.equal(dialog.nodes["[data-confirm-ok]"].textContent, "继续下载");
    dialog.close("ok");
    assert.equal(await accept, true);

    const cancel = confirmQuestion("继续？");
    dialog.close("cancel");
    assert.equal(await cancel, false);

    const escaped = confirmQuestion("继续？");
    dialog.close("");
    assert.equal(await escaped, false);
  } finally {
    globalThis.document = previous;
  }
});
