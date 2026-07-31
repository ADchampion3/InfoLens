import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { launchPackagedApp, waitFor } from "./helpers/sprint7-packaged-app.mjs";

const root = path.resolve(import.meta.dirname, "..");

async function openLogs(cdp) {
  await waitFor(() => cdp.evaluate(`(() => {
    const button = [...document.querySelectorAll("button")].find((item) => item.textContent.trim() === "Logs");
    if (!button) return false;
    button.click();
    return true;
  })()`), "Logs navigation was not available");
  return waitFor(() => cdp.evaluate(`(() => {
    const list = document.querySelector('[aria-label="Operational logs"]');
    return list ? { heading: document.querySelector("h1")?.textContent, text: list.textContent } : false;
  })()`), "Logs view did not render");
}

async function clickNavigation(cdp, label) {
  return waitFor(() => cdp.evaluate(`(() => {
    const button = [...document.querySelectorAll("button")].find((item) => item.textContent.trim() === ${JSON.stringify(label)});
    if (!button) return false;
    button.click();
    return true;
  })()`), `${label} navigation was not available`);
}

test("packaged Host Shell keeps retained logs available while Plugin Runtime restarts", { timeout: 75_000 }, async () => {
  const profile = await mkdtemp(path.join(os.tmpdir(), "infolens-log-center-"));
  const pluginsRoot = path.join(profile, "plugins");
  await mkdir(pluginsRoot, { recursive: true });
  await cp(path.join(root, "tests", "fixtures", "sprint6", "rejected-plugin"), path.join(pluginsRoot, "future-reader"), { recursive: true });
  const activationRoot = path.join(pluginsRoot, "activation-failure");
  await mkdir(path.join(activationRoot, "backend"), { recursive: true });
  await mkdir(path.join(activationRoot, "web"), { recursive: true });
  await cp(path.join(root, "tests", "fixtures", "sprint2", "manifests", "activation-failure.json"), path.join(activationRoot, "manifest.json"));
  await cp(path.join(root, "tests", "fixtures", "sprint2", "backends", "activation-failure.mjs"), path.join(activationRoot, "backend", "index.mjs"));
  await writeFile(path.join(activationRoot, "web", "index.html"), "<!doctype html><title>Activation Failure</title>");
  const environment = {
    INFOLENS_USER_DATA_ROOT: profile,
    INFOLENS_TEST_CONTROL: "1",
    INFOLENS_BUNDLED_OPENCLI_ROOT: path.join(root, "tests", "fixtures", "sprint5", "opencli"),
    INFOLENS_TEST_EXPORT_PATH: path.join(profile, "filtered-logs.jsonl"),
  };
  let app = await launchPackagedApp(root, environment);
  try {
    await waitFor(() => app.cdp.evaluate("window.infolens.getRuntimeInfo()"), "Plugin Runtime did not start");
    const initial = await openLogs(app.cdp);
    assert.equal(initial.heading, "Logs");
    assert.match(initial.text, /info/i);
    assert.match(initial.text, /host/i);
    assert.match(initial.text, /Host Shell started/);
    const severities = await app.cdp.evaluate(`[...document.querySelectorAll('.logs-toolbar fieldset label')].map((label) => ({ label: label.textContent, checked: label.querySelector('input').checked }))`);
    assert.deepEqual(severities, [
      { label: "Debug", checked: false }, { label: "Info", checked: true },
      { label: "Warning", checked: true }, { label: "Error", checked: true },
    ]);
    const merged = await app.cdp.evaluate("window.infolens.queryLogs()");
    assert(merged.entries.some((entry) => entry.source === "runtime" && entry.message.includes("package-rejected")), "Runtime rejection evidence was missing");
    assert(merged.entries.some((entry) => entry.source.startsWith("plugin:") && entry.message.includes("plugin-activated")), "plugin activation evidence was missing");

    await app.cdp.evaluate(`(() => {
      const input = document.querySelector('[aria-label="Keyword"]');
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
      setter.call(input, "package-rejected");
      input.dispatchEvent(new Event("input", { bubbles: true }));
      return true;
    })()`);
    await waitFor(() => app.cdp.evaluate(`(() => { const list=document.querySelector('[aria-label="Operational logs"]'); return list?.textContent.includes("package-rejected") && !list.textContent.includes("Host Shell started"); })()`), "keyword filter did not narrow visible logs");
    await app.cdp.evaluate("document.querySelector('.log-entry > .log-row').click(); true");
    assert.match(await app.cdp.evaluate("document.querySelector('.log-details')?.textContent"), /Canonical timestamp.*Session ID/);
    await clickNavigation(app.cdp, "Settings");
    await openLogs(app.cdp);
    assert.equal(await app.cdp.evaluate("document.querySelector('[aria-label=Keyword]').value"), "package-rejected");

    await app.cdp.evaluate(`(() => {
      const input = document.querySelector('[aria-label="Keyword"]');
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, "");
      input.dispatchEvent(new Event("input", { bubbles: true }));
      return true;
    })()`);
    await app.cdp.evaluate("Promise.all(Array.from({ length: 120 }, (_, index) => window.infolens.testWriteLog(`live-seed-${index}`)))");
    await waitFor(() => app.cdp.evaluate("document.querySelector('[aria-label=\"Operational logs\"]')?.textContent.includes('live-seed-119')"), "polling did not insert new logs at the newest position", 6_000);
    const scrollState = await app.cdp.evaluate("(() => { const list=document.querySelector('.log-table'); const page=document.querySelector('.logs-page'); list.scrollTop=list.scrollHeight; return { top:list.scrollTop, scrollHeight:list.scrollHeight, clientHeight:list.clientHeight, pageScrollHeight:page.scrollHeight, pageClientHeight:page.clientHeight }; })()");
    const readingPosition = scrollState.top;
    assert(readingPosition > 8, `log fixture did not create an older reading position: ${JSON.stringify(scrollState)}`);
    await app.cdp.evaluate("window.infolens.testWriteLog('live-while-reading')");
    await waitFor(() => app.cdp.evaluate("document.querySelector('[aria-label*=\"new log\"]')?.textContent"), "new-entry control did not appear while reading older logs", 6_000);
    assert.equal(await app.cdp.evaluate("document.querySelector('.log-table').scrollTop"), readingPosition, "live polling moved the reading position");
    assert.equal(await app.cdp.evaluate("document.querySelector('[aria-label=\"Operational logs\"]')?.textContent.includes('live-while-reading')"), false);
    await app.cdp.evaluate("document.querySelector('[aria-label*=\"new log\"]').click(); true");
    await waitFor(() => app.cdp.evaluate("document.querySelector('[aria-label=\"Operational logs\"]')?.textContent.includes('live-while-reading')"), "new-entry control did not move to newest logs");
    assert.equal(await app.cdp.evaluate("document.querySelectorAll('[data-log-id]').length === new Set([...document.querySelectorAll('[data-log-id]')].map((node) => node.dataset.logId)).size"), true, "polling duplicated visible entries");

    const activeQueries = await app.cdp.evaluate("window.infolens.testLogQueryCount()");
    await waitFor(async () => (await app.cdp.evaluate("window.infolens.testLogQueryCount()")) > activeQueries, "active Logs view did not poll", 4_000);
    await clickNavigation(app.cdp, "Settings");
    const stoppedQueries = await app.cdp.evaluate("window.infolens.testLogQueryCount()");
    await new Promise((resolve) => setTimeout(resolve, 2_500));
    assert.equal(await app.cdp.evaluate("window.infolens.testLogQueryCount()"), stoppedQueries, "polling continued after leaving Logs");
    await openLogs(app.cdp);

    await app.cdp.evaluate("Promise.all(Array.from({ length: 230 }, (_, index) => window.infolens.testWriteLog(`share-seed-${index} ${index === 0 ? 'token=copy-secret' : ''}`)))");
    await app.cdp.evaluate(`(() => { const input=document.querySelector('[aria-label="Keyword"]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, "share-seed"); input.dispatchEvent(new Event("input", { bubbles: true })); return true; })()`);
    await waitFor(() => app.cdp.evaluate("document.querySelector('[aria-label=\"Operational logs\"]')?.textContent.includes('share-seed-229')"), "share filter did not render");
    await app.cdp.evaluate("document.querySelector('.log-entry > .log-row').click(); true");
    const clipboardBeforeEntry = await app.cdp.evaluate("window.infolens.testReadClipboard()");
    await app.cdp.evaluate(`[...document.querySelectorAll('button')].find((item)=>item.textContent.trim()==="Copy entry").click(); true`);
    const copiedEntry = await waitFor(async () => { const value=await app.cdp.evaluate("window.infolens.testReadClipboard()"); return value !== clipboardBeforeEntry && value.includes("share-seed") && value.trim().split(/\r?\n/).length === 1 ? value : false; }, "single entry was not copied");
    assert.equal(copiedEntry.trim().split(/\r?\n/).length, 1);
    assert.deepEqual(Object.keys(JSON.parse(copiedEntry)).sort(), ["id", "level", "message", "sessionId", "source", "timestamp"]);
    assert.doesNotMatch(copiedEntry, /copy-secret/);
    await app.cdp.evaluate(`[...document.querySelectorAll('button')].find((item)=>item.textContent.trim()==="Copy filtered").click(); true`);
    const copiedFiltered = await waitFor(async () => { const value=await app.cdp.evaluate("window.infolens.testReadClipboard()"); return value.trim().split(/\r?\n/).length === 230 ? value : false; }, "complete filtered logs were not copied");
    assert.doesNotMatch(copiedFiltered, /copy-secret/);
    await app.cdp.evaluate(`[...document.querySelectorAll('button')].find((item)=>item.textContent.trim()==="Export JSONL").click(); true`);
    const exported = await waitFor(async () => readFile(environment.INFOLENS_TEST_EXPORT_PATH, "utf8").catch(() => ""), "filtered JSONL was not exported");
    assert.equal(exported.trim().split(/\r?\n/).length, 230);
    assert.doesNotMatch(exported, /copy-secret/);

    await app.cdp.evaluate("window.infolens.removePlugin('hn')");
    const afterRemoval = await app.cdp.evaluate("window.infolens.queryLogs()");
    assert(!afterRemoval.entries.some((entry) => entry.source === "plugin:hn"), "removed plugin logs remained queryable");
    assert(afterRemoval.entries.some((entry) => entry.source === "host" && entry.message === "Plugin removed id=hn"), "Host removal evidence was not retained");

    const failedInfo = await app.cdp.evaluate("window.infolens.getRuntimeInfo()");
    const activationFailure = failedInfo.plugins.find((plugin) => plugin.id === "activation-failure").statusSnapshot.failure;
    await clickNavigation(app.cdp, "Plugins");
    await waitFor(() => app.cdp.evaluate(`(() => { const button=[...document.querySelectorAll('.package-row')].find((item)=>item.textContent.includes("Activation Failure")); if(!button)return false; button.click(); return true; })()`), "failed plugin was not available in Plugin Manager");
    await waitFor(() => app.cdp.evaluate(`(() => { const button=[...document.querySelectorAll('button')].find((item)=>item.textContent.trim()==="View matching logs"); if(!button)return false; button.click(); return true; })()`), "Plugin Status did not offer contextual logs");
    await waitFor(() => app.cdp.evaluate(`document.querySelector('[data-log-id="${activationFailure.logId}"]')?.querySelector('.log-details')?.textContent`), "contextual Logs did not expand the canonical failure");
    assert.equal(await app.cdp.evaluate("document.querySelector('[aria-label=\"Operation ID\"]').value"), activationFailure.operationId);
    assert.match(await app.cdp.evaluate(`document.querySelector('[data-log-id="${activationFailure.logId}"] .log-guidance')?.textContent`), /could not complete the operation.*retry or restart/i);

    const exposed = await app.cdp.evaluate("Object.keys(window.infolens).sort()");
    assert(exposed.includes("queryLogs"));
    assert(!exposed.some((name) => /file|path|directory/i.test(name)), "preload exposed filesystem capability");

    await app.cdp.evaluate("window.infolens.testTerminateRuntime()");
    const duringRestart = await waitFor(async () => {
      const page = await app.cdp.evaluate("window.infolens.queryLogs()");
      return page.entries.some((entry) => entry.message.includes("Plugin Runtime exited")) ? page : false;
    }, "Host lifecycle evidence was not queryable during Runtime restart");
    assert(duringRestart.entries.some((entry) => entry.source === "host"));
    assert.equal(await app.cdp.evaluate("document.querySelector('h1')?.textContent"), "Logs");

    const previousIds = duringRestart.entries.map(({ id }) => id);
    await app.stop();
    app = await launchPackagedApp(root, environment);
    await openLogs(app.cdp);
    const restarted = await app.cdp.evaluate("window.infolens.queryLogs()");
    assert(previousIds.some((id) => restarted.entries.some((entry) => entry.id === id)), "retained Host evidence did not survive restart");
  } finally {
    await app.stop();
    await rm(profile, { recursive: true, force: true });
  }
});
