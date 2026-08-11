import assert from "node:assert/strict";
import { access, cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { launchPackagedApp, waitFor } from "./helpers/sprint7-packaged-app.mjs";

const root = path.resolve(import.meta.dirname, "..");
const releaseRoot = path.join(root, "release", "infolens-win32-x64");
const officialIds = ["github-trending", "hn", "product-hunt", "zhihu-hot"];

async function request(origin, route, options) {
  const response = await fetch(`${origin}${route}`, options);
  const body = await response.json();
  assert(response.ok, `${route}: ${body.error ?? response.status}`);
  return body;
}

async function runtimeInfo(cdp) {
  return cdp.evaluate("window.infolens.getRuntimeInfo()");
}

async function clickText(cdp, text) {
  return waitFor(() => cdp.evaluate(`(() => { const button=[...document.querySelectorAll('button')].find((item)=>item.textContent.trim().includes(${JSON.stringify(text)})); if(!button) return false; button.click(); return true; })()`), `Button not found: ${text}`);
}

async function clickWorkspaceRefresh(cdp, plugin) {
  await clickText(cdp, plugin.name);
  const frame = await waitFor(() => cdp.evaluate(`(() => { const frame=document.querySelector('iframe'); return frame?.src.includes(${JSON.stringify(`/plugins/${plugin.id}/workspace/`)}) ? { src: frame.src } : false; })()`), `${plugin.name} host iframe did not load`);
  const targetPath = new URL(frame.src).pathname;
  const workspace = await waitFor(() => cdp.evaluateTarget(targetPath, "(() => { const button=document.querySelector('#refresh'); if(!button || (button.onclick === null && !document.querySelector('#app'))) return false; button.click(); return { title: document.title, url: location.href }; })()"), `${plugin.name} isolated workspace target did not load`);
  return { ...workspace, src: frame.src };
}

test("release candidate contains the pinned production assembly", async () => {
  const manifest = JSON.parse(await readFile(path.join(releaseRoot, "release-manifest.json"), "utf8"));
  assert.equal(manifest.version, "0.2.0");
  assert.equal(manifest.hostVersion, "0.2.0");
  assert.equal(manifest.pluginRuntimeVersion, "0.2.0");
  assert.equal(manifest.pluginSdkVersion, "0.1.0");
  assert.equal(manifest.pluginContractVersion, 2);
  assert.equal(manifest.openCliVersion, "1.8.6");
  assert.equal(manifest.electronVersion, "43.2.0");
  assert.equal(manifest.openCli.version, "1.8.6");
  assert.equal(manifest.openCli.packageName, "@jackwener/opencli");
  assert.deepEqual([...manifest.plugins].sort(), officialIds);
  await access(path.join(releaseRoot, "Infolens.exe"));
  await access(path.join(releaseRoot, "resources", "app", "apps", "desktop", "dist", "index.html"));
  await access(path.join(releaseRoot, "resources", "app", "resources", "opencli", manifest.openCli.executable));
  for (const id of officialIds) await access(path.join(releaseRoot, "resources", "app", "plugins", id, "manifest.json"));
});

test("packaged Electron executes the full Sprint 7 integration matrix", { timeout: 90_000 }, async () => {
  const profile = await mkdtemp(path.join(os.tmpdir(), "infolens-sprint7-"));
  const pluginsRoot = path.join(profile, "plugins");
  const stateFile = path.join(profile, "opencli-state.json");
  await mkdir(pluginsRoot, { recursive: true });
  await cp(path.join(root, "tests", "fixtures", "sprint6", "rejected-plugin"), path.join(pluginsRoot, "future-reader"), { recursive: true });
  await writeFile(stateFile, `${JSON.stringify({ producthunt: "success" }, null, 2)}\n`, "utf8");
  const environment = {
    INFOLENS_USER_DATA_ROOT: profile,
    INFOLENS_BUNDLED_OPENCLI_ROOT: path.join(root, "tests", "fixtures", "sprint5", "opencli"),
    INFOLENS_TEST_OPENCLI_STATE: stateFile,
    INFOLENS_TEST_CONTROL: "1",
    INFOLENS_TEST_INSTALL_PATH: path.join(root, "tests", "fixtures", "sprint6", "installable-plugin"),
  };
  let app = await launchPackagedApp(root, environment);
  try {
    const initial = await waitFor(async () => {
      const info = await runtimeInfo(app.cdp);
      return info?.plugins?.length === 4 ? info : undefined;
    }, "packaged Runtime did not activate all official plugins");
    assert.deepEqual(initial.plugins.map(({ id }) => id).sort(), officialIds);
    assert.equal(initial.rejectedPlugins[0].code, "INCOMPATIBLE_CONTRACT");
    assert(initial.plugins.every(({ packagePath }) => packagePath.startsWith(pluginsRoot)), "bundled packages must be seeded into writable profile storage");
    await app.cdp.evaluate("document.querySelector('button[aria-label=Close]')?.click(); true");

    for (const plugin of initial.plugins) {
      const workspace = await clickWorkspaceRefresh(app.cdp, plugin);
      assert(workspace.src.includes(`/plugins/${plugin.id}/workspace/`));
    }
    const summaries = {
      hn: await waitFor(async () => { const value=await request(initial.origin, "/plugins/hn/api/summary"); return value.stories.length ? value : undefined; }, "Hacker News workspace refresh did not persist"),
      github: await waitFor(async () => { const value=await request(initial.origin, "/plugins/github-trending/api/summary"); return value.repositories.length ? value : undefined; }, "GitHub workspace refresh did not persist"),
      zhihu: await waitFor(async () => { const value=await request(initial.origin, "/plugins/zhihu-hot/api/summary"); return value.questions.length ? value : undefined; }, "Zhihu workspace refresh did not persist"),
      productHunt: await waitFor(async () => { const value=await request(initial.origin, "/plugins/product-hunt/api/summary"); return value.products.length ? value : undefined; }, "Product Hunt workspace refresh did not persist"),
    };
    assert.equal(summaries.hn.stories.length, 1);
    assert.equal(summaries.github.repositories.length, 1);
    assert.equal(summaries.zhihu.questions.length, 1);
    assert.equal(summaries.productHunt.products.length, 12);

    await request(initial.origin, "/plugins/hn/api/settings?policy=fixed&intervalMinutes=15", { method: "POST" });
    assert.equal((await request(initial.origin, "/plugins/hn/api/settings")).policy, "fixed");

    await clickText(app.cdp, "Settings");
    await clickText(app.cdp, "Dark");
    await clickText(app.cdp, "Hacker News");
    assert.equal(await waitFor(() => app.cdp.evaluateTarget("/workspace/", "document.documentElement.dataset.theme"), "workspace theme did not update"), "dark");

    await clickText(app.cdp, "Plugins");
    await clickText(app.cdp, "Install plugin");
    await waitFor(async () => (await runtimeInfo(app.cdp)).plugins.some(({ id }) => id === "reading-notes"), "compatible plugin was not installed through Electron UI");
    await waitFor(() => app.cdp.evaluate("(() => { const button=[...document.querySelectorAll('.package-list button')].find((item)=>item.textContent.includes('Reading Notes')); if(!button)return false; button.click(); return true; })()"), "installed plugin did not appear in Plugin Manager");
    await clickText(app.cdp, "Copy diagnostics");
    const diagnostics = await waitFor(async () => { const value=await app.cdp.evaluate("window.infolens.testReadClipboard()"); return value.includes("reading-notes-activated") ? value : undefined; }, "diagnostics were not copied through Electron clipboard IPC");
    assert.match(diagnostics, /reading-notes-activated/);
    assert.doesNotMatch(diagnostics, /cookie|authorization/i);
    await clickText(app.cdp, "Remove plugin");
    await app.cdp.evaluate("(() => { const button=document.querySelector('[role=dialog] .danger-button'); if(!button)throw new Error('Removal confirmation not found'); button.click(); return true; })()");
    await waitFor(async () => !(await runtimeInfo(app.cdp)).plugins.some(({ id }) => id === "reading-notes"), "installed plugin was not removed through Electron UI");
    await assert.rejects(access(path.join(pluginsRoot, "reading-notes")));

    await writeFile(stateFile, `${JSON.stringify({ producthunt: "malformed" }, null, 2)}\n`, "utf8");
    const failedRefresh = await request(initial.origin, "/plugins/product-hunt/api/refresh", { method: "POST" });
    assert.equal(failedRefresh.ok, false);
    assert.equal(failedRefresh.products.length, 12, "failed plugin must preserve retained records");
    assert.equal((await request(initial.origin, "/plugins/hn/api/summary")).stories.length, 1, "sibling must remain available");
    await writeFile(stateFile, `${JSON.stringify({ producthunt: "disconnected" }, null, 2)}\n`, "utf8");
    await request(initial.origin, "/plugins/product-hunt/api/refresh", { method: "POST" });
    const bridge = await request(initial.origin, "/runtime/browser-status");
    assert.equal(bridge.connected, false);
    assert.deepEqual(bridge.affected.map(({ id }) => id).sort(), ["product-hunt", "zhihu-hot"]);

    const oldOrigin = initial.origin;
    await app.cdp.evaluate("window.infolens.testTerminateRuntime()");
    const recovered = await waitFor(async () => {
      const info = await runtimeInfo(app.cdp);
      return info?.origin && info.origin !== oldOrigin && info.plugins.length === 4 ? info : undefined;
    }, "host did not recover and reactivate all plugins", 15_000);
    assert.equal((await request(recovered.origin, "/plugins/hn/api/summary")).stories.length, 1);
    assert.equal(recovered.hostState.theme, "dark");
    assert.equal(recovered.hostState.lastSelection, "hn");

    await app.stop();
    app = await launchPackagedApp(root, environment);
    const restarted = await waitFor(() => runtimeInfo(app.cdp), "application restart did not restore Runtime");
    assert.equal(restarted.hostState.theme, "dark");
    assert.equal(restarted.hostState.lastSelection, "hn");
    assert.equal((await request(restarted.origin, "/plugins/hn/api/summary")).stories.length, 1);
    assert.equal((await request(restarted.origin, "/plugins/product-hunt/api/summary")).products.length, 12);
    for (const id of officialIds) await access(path.join(profile, "plugins-data", id));
  } finally {
    await app.stop();
    await rm(profile, { recursive: true, force: true });
  }
});
