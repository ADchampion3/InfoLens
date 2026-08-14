import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";

const root = path.resolve(import.meta.dirname, "..");
const plugins = ["hn", "github-trending", "zhihu-hot", "product-hunt"];

test("history browsing uses a shared calendar popover instead of a snapshot page", async () => {
  const source = await readFile(path.join(root, "packages/plugin-workspace/src/history-controls.js"), "utf8");
  assert.match(source, /setAttribute\("popover", "auto"\)/);
  assert.match(source, /history-calendar-grid/);
  assert.match(source, /history\?limit=100&offset=/);
  assert.match(source, /history\/snapshot\?id=/);
  assert.match(source, /history-view-bar/);
  assert.match(source, /onSnapshot\(detail, snapshot\)/);
  assert.doesNotMatch(source, /collection-history-dialog/);
});

test("every Workspace renders selected snapshots in its main content and keeps them read-only", async () => {
  for (const pluginId of plugins) {
    const source = await readFile(path.join(root, "plugins", pluginId, "web", "dist", "workspace.js"), "utf8");
    assert.match(source, /onSnapshot:/, `${pluginId} does not render a selected snapshot`);
    assert.match(source, /onCurrent:/, `${pluginId} cannot return to current content`);
    assert.match(source, /historyControls\?\.clear\(\)/, `${pluginId} does not leave history mode before refresh`);
  }
  const hn = await readFile(path.join(root, "plugins/hn/web/dist/workspace.js"), "utf8");
  const github = await readFile(path.join(root, "plugins/github-trending/web/dist/workspace.js"), "utf8");
  const productHunt = await readFile(path.join(root, "plugins/product-hunt/web/dist/workspace.js"), "utf8");
  const zhihu = await readFile(path.join(root, "plugins/zhihu-hot/web/dist/workspace.js"), "utf8");
  assert.match(hn, /if\(readOnly\)return/);
  assert.match(github, /readOnly \? window\.open/);
  assert.match(productHunt, /if\(readOnly\)return/);
  assert.match(zhihu, /if\(!historyView\)\{await request\(`read\?/);
});

test("calendar controls preserve touch targets, focus, unavailable, and reduced-motion states", async () => {
  const styles = await readFile(path.join(root, "packages/plugin-workspace/src/history.css"), "utf8");
  assert.match(styles, /\.history-calendar button[^}]*min-height:\s*2\.75rem/s);
  assert.match(styles, /\.history-day\[data-unavailable="true"\]/);
  assert.match(styles, /\.history-day\[aria-current="date"\]/);
  assert.match(styles, /@media \(max-width: 24rem\)[\s\S]*\.history-calendar[^}]*width:\s*100vw/);
  assert.match(styles, /@media \(prefers-reduced-motion: reduce\)[\s\S]*\.history-calendar button/);
});

test("Thin Plugin SDK does not own Workspace history UI", async () => {
  await assert.rejects(
    readFile(path.join(root, "packages/plugin-sdk/src/workspace-history.js"), "utf8"),
    (error) => error.code === "ENOENT",
  );
  const sdkStyles = await readFile(path.join(root, "packages/plugin-sdk/src/workspace.css"), "utf8");
  assert.doesNotMatch(sdkStyles, /history-calendar|history-view-bar|infolens-confirm-dialog/);
  const packager = await readFile(path.join(root, "scripts/package-release.mjs"), "utf8");
  assert.match(packager, /\["packages\/plugin-workspace",\s*"packages\/plugin-workspace"\]/);
});
