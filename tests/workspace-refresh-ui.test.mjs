import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import vm from "node:vm";
import { test } from "node:test";

const root = path.resolve(import.meta.dirname, "..");
const workspaces = ["hn", "github-trending", "zhihu-hot", "product-hunt"];

function refreshFunction(source) {
  const start = source.indexOf("async function refresh");
  assert.notEqual(start, -1, "workspace must define refresh()");
  const end = source.indexOf("\n", start);
  return source.slice(start, end === -1 ? source.length : end);
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
