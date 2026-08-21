import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";

const root = path.resolve(import.meta.dirname, "..");
const plugins = [
  { id: "hn", entry: "signal-ledger.js", field: "stories", row: "ledger-row" },
  { id: "github-trending", entry: "source-board.js", field: "repositories", row: "board-card" },
  { id: "zhihu-hot", entry: "reading-desk.js", field: "questions", row: "reader-list-item" },
  { id: "product-hunt", entry: "source-board.js", field: "products", row: "board-card" },
];

test("official production workspaces consume their real Plugin API", async () => {
  for (const plugin of plugins) {
    const directory = path.join(root, "plugins", plugin.id);
    const html = await readFile(path.join(directory, "web", "dist", "index.html"), "utf8");
    const workspace = await readFile(path.join(directory, "web", "dist", plugin.entry), "utf8");
    const backend = await readFile(path.join(directory, "backend", "index.js"), "utf8");

    assert.match(html, new RegExp(`src=["']\\./${plugin.entry}["']`), `${plugin.id} does not load its production Workspace entry`);
    assert.match(workspace, /workspaceRuntimeConfig\(\)/, `${plugin.id} does not use the Runtime Workspace configuration`);
    assert.match(workspace, /fetch\(new URL\(/, `${plugin.id} does not call its Plugin API`);
    assert.match(workspace, /request\(["']summary["']\)/, `${plugin.id} does not read persisted summary data`);
    assert.match(workspace, /request\(["']refresh["']/, `${plugin.id} does not enqueue a real refresh`);
    assert.match(workspace, new RegExp(plugin.row), `${plugin.id} has no record renderer`);
    assert.doesNotMatch(workspace, /Fixture data|const fixture|example\.source|mock data/i, `${plugin.id} still ships fixture records`);

    assert.match(backend, /context\.opencli\.run\(/, `${plugin.id} Backend does not collect through declared OpenCLI`);
    assert.match(backend, /store\.replace\(/, `${plugin.id} Backend does not persist collected records`);
    assert.match(backend, /context\.route\(["']GET["'][,\s]*["']\/summary["']/, `${plugin.id} Backend has no summary API`);
  }
});
