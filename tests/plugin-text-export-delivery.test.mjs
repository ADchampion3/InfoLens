import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { copyDownloadable, downloadExport } from "../packages/plugin-sdk/src/index.js";
import { openStore as openHn } from "../plugins/hn/backend/history-storage.js";
import { openStore as openGithub } from "../plugins/github-trending/backend/history-storage.js";
import { openStore as openZhihu } from "../plugins/zhihu-hot/backend/history-storage.js";
import { openStore as openProductHunt } from "../plugins/product-hunt/backend/history-storage.js";

function installGlobal(name, value) {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, name);
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  return () => descriptor ? Object.defineProperty(globalThis, name, descriptor) : delete globalThis[name];
}

function workspaceLocation(apiBaseUrl = "http://127.0.0.1:1234/plugins/demo/api/") {
  return { origin: "http://127.0.0.1:1234", search: `?pluginId=demo&apiBaseUrl=${encodeURIComponent(apiBaseUrl)}` };
}

test("SDK export helpers stay inside the calling Plugin API and stream clipboard text", async () => {
  const restoreLocation = installGlobal("location", workspaceLocation());
  const clicks = [];
  const restoreDocument = installGlobal("document", {
    body: { append(node) { node.parentNode = this; } },
    createElement() {
      return {
        style: {},
        click() { clicks.push(this.href); },
        remove() {},
      };
    },
  });
  const writes = [];
  const restoreNavigator = installGlobal("navigator", { userActivation: { isActive: true }, clipboard: { write(items) { return Promise.resolve(items[0].items["text/plain"]).then((blob) => blob.text()).then((value) => writes.push(value)); } } });
  const restoreClipboardItem = installGlobal("ClipboardItem", class ClipboardItem {
    constructor(items) { this.items = items; }
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("标题\n第二行", { headers: { "content-type": "text/plain; charset=utf-8" } });
  try {
    assert.deepEqual(await downloadExport("/export?format=text"), { initiated: true });
    assert.deepEqual(clicks, ["http://127.0.0.1:1234/plugins/demo/api/export?format=text"]);
    assert.deepEqual(await downloadExport("/plugins/demo/api/export?format=text"), { initiated: true });
    assert.deepEqual(clicks, [
      "http://127.0.0.1:1234/plugins/demo/api/export?format=text",
      "http://127.0.0.1:1234/plugins/demo/api/export?format=text",
    ]);
    assert.deepEqual(await copyDownloadable("export?format=text"), { copied: true });
    assert.deepEqual(writes, ["标题\n第二行"]);
    await assert.rejects(() => downloadExport("http://127.0.0.1:1234/plugins/other/api/export"), (error) => error instanceof TypeError);
    await assert.rejects(() => downloadExport("https://example.test/plugins/demo/api/export"), (error) => error instanceof TypeError);
  } finally {
    globalThis.fetch = originalFetch;
    restoreClipboardItem();
    restoreNavigator();
    restoreDocument();
    restoreLocation();
  }
});

test("copyDownloadable reports the transport error contract", async () => {
  const restoreLocation = installGlobal("location", workspaceLocation());
  const originalFetch = globalThis.fetch;
  const restoreNavigator = installGlobal("navigator", { userActivation: { isActive: true }, clipboard: { write(items) { return Promise.resolve(items[0].items["text/plain"]); } } });
  const restoreClipboardItem = installGlobal("ClipboardItem", class ClipboardItem {
    constructor(items) { this.items = items; }
  });
  try {
    globalThis.fetch = async () => new Response("too large", { headers: { "content-type": "application/octet-stream" } });
    await assert.rejects(() => copyDownloadable("export"), (error) => error.code === "UNSUPPORTED_EXPORT_TYPE");
    globalThis.fetch = async () => new Response("x".repeat(1024 * 1024 + 1), { headers: { "content-type": "text/plain" } });
    await assert.rejects(() => copyDownloadable("export"), (error) => error.code === "EXPORT_TOO_LARGE");
    globalThis.fetch = async () => { throw new Error("offline"); };
    await assert.rejects(() => copyDownloadable("export"), (error) => error.code === "EXPORT_REQUEST_FAILED");
    globalThis.fetch = async () => new Response("ok", { headers: { "content-type": "text/plain" } });
    globalThis.navigator = { userActivation: { isActive: true }, clipboard: { write() { throw new Error("denied"); } } };
    await assert.rejects(() => copyDownloadable("export"), (error) => error.code === "CLIPBOARD_DENIED");
    globalThis.navigator = { userActivation: { isActive: true } };
    await assert.rejects(() => copyDownloadable("export"), (error) => error.code === "CLIPBOARD_UNAVAILABLE");
    globalThis.navigator = { userActivation: { isActive: false }, clipboard: { write() { return Promise.resolve(); } } };
    await assert.rejects(() => copyDownloadable("export"), (error) => error.code === "CLIPBOARD_DENIED");
  } finally {
    globalThis.fetch = originalFetch;
    restoreClipboardItem();
    restoreNavigator();
    restoreLocation();
  }
});

test("copyDownloadable starts clipboard write during the caller activation", async () => {
  const restoreLocation = installGlobal("location", workspaceLocation());
  const restoreNavigator = installGlobal("navigator", {
    userActivation: { isActive: true },
    clipboard: {
      write(items) {
        assert.equal(globalThis.navigator.userActivation.isActive, true, "clipboard write lost caller activation");
        return Promise.resolve(items[0].items["text/plain"]).then((blob) => blob.text());
      },
      writeText() {
        if (!globalThis.navigator.userActivation.isActive) throw new Error("denied");
      },
    },
  });
  const restoreClipboardItem = installGlobal("ClipboardItem", class ClipboardItem {
    constructor(items) { this.items = items; }
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => new Promise((resolve) => {
    queueMicrotask(() => {
      globalThis.navigator.userActivation.isActive = false;
      resolve(new Response("copy me", { headers: { "content-type": "text/plain" } }));
    });
  });
  try {
    await assert.doesNotReject(() => copyDownloadable("export"));
  } finally {
    globalThis.fetch = originalFetch;
    restoreClipboardItem();
    restoreNavigator();
    restoreLocation();
  }
});

test("each Bundled Plugin serializer provides all four formats from one business snapshot", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "infolens-text-export-stores-"));
  const cases = [
    ["hn", openHn, { id: "1", rank: 1, title: "Story", domain: "example.com", points: 2, author: "author", createdAt: "2026-08-01T00:00:00.000Z", comments: 3, url: "https://example.com/1", discussionUrl: "https://news.ycombinator.com/item?id=1" }, "1"],
    ["github-trending", openGithub, { id: "owner/repo", rank: 1, owner: "owner", name: "repo", description: "Description", language: "JavaScript", languageColor: "#f1e05a", stars: 2, forks: 1, starsGained: 1, url: "https://github.com/owner/repo" }, "owner/repo"],
    ["zhihu-hot", openZhihu, { url: "https://www.zhihu.com/question/123/", rank: 1, title: "Question", excerpt: "Excerpt", heat: "100 heat", answers: 2, thumbnailUrl: null }, "https://www.zhihu.com/question/123"],
    ["product-hunt", openProductHunt, { url: "https://www.producthunt.com/products/demo/", rank: 1, name: "Demo", votes: 4 }, "https://www.producthunt.com/products/demo"],
  ];
  try {
    for (const [pluginId, openStore, value, stateId] of cases) {
      const store = openStore(path.join(temp, `${pluginId}.sqlite`));
      store.replace([value], "2026-08-01T00:00:00.000Z");
      store.markRead(stateId, true);
      for (const format of ["json", "csv", "markdown", "text"]) {
        const output = [...store.createExport("0.1.0", "2026-08-03T00:00:00.000Z", format)].join("");
        assert.ok(output.length > 0, `${pluginId} ${format}`);
        assert.doesNotMatch(output, /dependencyState|readme|authentication|cookies|refresh_settings/u, `${pluginId} redaction`);
        if (format === "json") {
          const envelope = JSON.parse(output);
          assert.equal(envelope.pluginId, pluginId);
          assert.equal(envelope.snapshots[0].records.length, 1);
          assert.equal(envelope.userState[stateId]?.read, true, `${pluginId} read state`);
        }
        if (format === "csv") assert.match(output, /snapshot_collected_at/u);
        if (format === "markdown") assert.match(output, /^#/u);
      }
      store.close();
    }
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
