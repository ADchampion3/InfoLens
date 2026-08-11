import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { test } from "node:test";
import { openStore as openGithub } from "../plugins/github-trending/backend/storage.js";
import { openStore as openHn } from "../plugins/hn/backend/storage.js";
import { openStore as openProductHunt } from "../plugins/product-hunt/backend/storage.js";
import { openStore as openZhihu } from "../plugins/zhihu-hot/backend/storage.js";

const root = path.resolve(import.meta.dirname, "..");
const openCliRoot = path.join(root, "tests", "fixtures", "sprint5", "opencli");

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitFor(predicate, timeout = 2_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await delay(20);
  }
  throw new Error("Timed out waiting for Runtime export state");
}

function startRuntime({ pluginsRoot, dataRoot }) {
  const child = spawn(process.execPath, [path.join(root, "packages", "plugin-runtime", "src", "server.mjs")], {
    cwd: root,
    env: {
      ...process.env,
      INFOLENS_PROJECT_ROOT: root,
      INFOLENS_PLUGINS_ROOT: pluginsRoot,
      INFOLENS_PLUGIN_DATA_ROOT: dataRoot,
      INFOLENS_BUNDLED_OPENCLI_ROOT: openCliRoot,
      INFOLENS_RUNTIME_PORT: "0",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const lines = readline.createInterface({ input: child.stdout });
  return new Promise((resolve, reject) => {
    const errors = [];
    const timeout = setTimeout(() => reject(new Error(`Runtime start timed out: ${errors.join("")}`)), 5_000);
    child.stderr.on("data", (chunk) => errors.push(String(chunk)));
    child.once("error", reject);
    child.once("exit", (code) => reject(new Error(`Runtime exited before ready with ${code}: ${errors.join("")}`)));
    lines.on("line", (line) => {
      const message = JSON.parse(line);
      if (message.type !== "runtime-ready") return;
      clearTimeout(timeout);
      resolve({ child, message });
    });
  });
}

async function stopRuntime(child) {
  if (!child || child.exitCode !== null) return;
  const exited = new Promise((resolve) => child.once("exit", resolve));
  child.stdin.write("shutdown\n");
  child.stdin.end();
  await exited;
}

async function createExportFixture(rootDirectory) {
  const packageRoot = path.join(rootDirectory, "export-fixture");
  await mkdir(path.join(packageRoot, "backend"), { recursive: true });
  await mkdir(path.join(packageRoot, "web"), { recursive: true });
  await writeFile(path.join(packageRoot, "manifest.json"), JSON.stringify({
    id: "export-fixture",
    name: "Export Fixture",
    version: "1.0.0",
    contractVersion: "2",
    minHostVersion: "0.2.0",
    backend: { entry: "backend/index.mjs" },
    ui: { entry: "web/index.html" },
    openCliAdapters: {},
    openCliCommands: {},
  }), "utf8");
  await writeFile(path.join(packageRoot, "web", "index.html"), "<!doctype html><title>Export Fixture</title>", "utf8");
  await writeFile(path.join(packageRoot, "backend", "index.mjs"), `
const state = {
  cancel: { started: 0, closed: 0 },
  backpressure: { next: 0, closed: 0 },
};

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function stream(mode, format) {
  return (async function* () {
    try {
      if (mode === "cancel") {
        while (true) {
          state.cancel.started += 1;
          yield "chunk-" + String(state.cancel.started) + "\\n";
          await delay(10);
        }
      }
      if (mode === "backpressure") {
        for (let index = 0; index < 512; index += 1) {
          state.backpressure.next += 1;
          yield "x".repeat(64 * 1024);
        }
        return;
      }
      yield format + "-body\\n";
    } finally {
      if (mode === "cancel") state.cancel.closed += 1;
      if (mode === "backpressure") state.backpressure.closed += 1;
    }
  })();
}

export function activate(context) {
  context.setHealth({ state: "ready" });
  context.route("GET", "/state", () => ({
    cancel: { ...state.cancel },
    backpressure: { ...state.backpressure },
  }));
  context.route("GET", "/signal", ({ signal }) => ({ isAbortSignal: signal instanceof AbortSignal, aborted: signal.aborted }));
  context.route("GET", "/export", ({ url }) => {
    const format = url.searchParams.get("format") || "text";
    const mode = url.searchParams.get("mode");
    const filenameBase = url.searchParams.get("name") || "fixture";
    if (mode === "bad-body") return { type: "infolens:download", filenameBase, format, body: [new Uint8Array([1])] };
    return { type: "infolens:download", filenameBase, format, body: mode ? stream(mode, format) : [format + "-body\\n"] };
  });
  return { async deactivate() {} };
}
`, "utf8");
}

test("Runtime maps text export formats, validates filenames, and propagates cancellation", async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "infolens-runtime-export-"));
  const pluginsRoot = path.join(temporaryRoot, "plugins");
  const dataRoot = path.join(temporaryRoot, "data");
  await mkdir(pluginsRoot, { recursive: true });
  await createExportFixture(pluginsRoot);
  let runtime;
  try {
    runtime = await startRuntime({ pluginsRoot, dataRoot });
    const origin = runtime.message.origin;
    const base = `${origin}/plugins/export-fixture/api`;
    assert.deepEqual(await fetch(`${base}/signal`).then((response) => response.json()), { isAbortSignal: true, aborted: false });
    for (const [format, extension, mime] of [
      ["json", ".json", "application/json"],
      ["csv", ".csv", "text/csv"],
      ["markdown", ".md", "text/markdown"],
      ["text", ".txt", "text/plain"],
    ]) {
      const response = await fetch(`${base}/export?format=${format}&name=${encodeURIComponent("\u6d4b\u8bd5 export")}`);
      assert.equal(response.status, 200, format);
      assert.match(response.headers.get("content-type") || "", new RegExp(`^${mime};`));
      assert.equal(response.headers.get("cache-control"), "no-store");
      assert.equal(response.headers.get("x-content-type-options"), "nosniff");
      const disposition = response.headers.get("content-disposition") || "";
      assert.match(disposition, new RegExp(`^attachment; filename="export\\${extension}"; filename\\*=UTF-8''%E6%B5%8B%E8%AF%95%20export\\${extension}$`), format);
      assert.equal(await response.text(), `${format}-body\n`);
    }

    for (const name of ["../escape", "CON", "bad\nname"]) {
      const response = await fetch(`${base}/export?format=text&name=${encodeURIComponent(name)}`);
      assert.equal(response.status, 500, name);
    }
    assert.equal((await fetch(`${base}/export?format=xml`)).status, 500);
    await assert.rejects(async () => {
      const response = await fetch(`${base}/export?format=text&mode=bad-body`);
      await response.text();
    }, /fetch failed|terminated|closed/i);

    const cancelled = await fetch(`${base}/export?format=text&mode=cancel`);
    const reader = cancelled.body.getReader();
    await reader.read();
    await reader.cancel();
    await waitFor(async () => (await fetch(`${base}/state`).then((response) => response.json())).cancel.closed > 0);

    const backpressured = await fetch(`${base}/export?format=text&mode=backpressure`);
    await waitFor(async () => (await fetch(`${base}/state`).then((response) => response.json())).backpressure.next > 0);
    await delay(100);
    const state = await fetch(`${base}/state`).then((response) => response.json());
    assert.ok(state.backpressure.next < 512, `Runtime should wait for response drain, produced ${state.backpressure.next} chunks`);
    await backpressured.body.cancel();
    await waitFor(async () => (await fetch(`${base}/state`).then((response) => response.json())).backpressure.closed > 0);
  } finally {
    await stopRuntime(runtime?.child);
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("Bundled Plugin export routes serve all four formats with fixed transport headers", async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "infolens-bundled-export-"));
  const dataRoot = path.join(temporaryRoot, "data");
  const stores = [
    ["hn", "hacker-news.sqlite", openHn, { id: "1", rank: 1, title: "Story", domain: "example.com", points: 2, author: "author", createdAt: "2026-08-01T00:00:00.000Z", comments: 3, url: "https://example.com/1", discussionUrl: "https://news.ycombinator.com/item?id=1" }, "1"],
    ["github-trending", "github-trending.sqlite", openGithub, { id: "owner/repo", rank: 1, owner: "owner", name: "repo", description: "Description", language: "JavaScript", languageColor: "#f1e05a", stars: 2, forks: 1, starsGained: 1, url: "https://github.com/owner/repo" }, "owner/repo"],
    ["zhihu-hot", "zhihu-hot.sqlite", openZhihu, { url: "https://www.zhihu.com/question/123", rank: 1, title: "Question", excerpt: "Excerpt", heat: "100 heat", answers: 2, thumbnailUrl: null }, "https://www.zhihu.com/question/123"],
    ["product-hunt", "product-hunt.sqlite", openProductHunt, { url: "https://www.producthunt.com/products/demo", rank: 1, name: "Demo", votes: 4 }, "https://www.producthunt.com/products/demo"],
  ];
  for (const [pluginId, filename, openStore, record, stateId] of stores) {
    const pluginDataRoot = path.join(dataRoot, pluginId);
    await mkdir(pluginDataRoot, { recursive: true });
    const store = openStore(path.join(pluginDataRoot, filename));
    store.replace([record], "2026-08-01T00:00:00.000Z");
    store.markRead(stateId, true);
    store.close();
  }

  let runtime;
  try {
    runtime = await startRuntime({ pluginsRoot: path.join(root, "plugins"), dataRoot });
    const origin = runtime.message.origin;
    const formats = [
      ["json", ".json", "application/json"],
      ["csv", ".csv", "text/csv"],
      ["markdown", ".md", "text/markdown"],
      ["text", ".txt", "text/plain"],
    ];
    for (const [pluginId, , , record] of stores) {
      for (const [format, extension, mime] of formats) {
        const response = await fetch(`${origin}/plugins/${pluginId}/api/export?format=${format}`);
        assert.equal(response.status, 200, `${pluginId} ${format}`);
        assert.match(response.headers.get("content-type") || "", new RegExp(`^${mime};`));
        assert.match(response.headers.get("content-disposition") || "", new RegExp(`\\.${extension.slice(1)}"; filename\\*=UTF-8''`));
        const body = await response.text();
        assert.ok(body.includes(String(record.title ?? record.name ?? "Story")), `${pluginId} ${format} record`);
        if (format === "json") {
          const envelope = JSON.parse(body);
          assert.equal(envelope.snapshots.length, 1, `${pluginId} snapshots`);
          assert.equal(Object.values(envelope.userState)[0].read, true, `${pluginId} user state`);
        }
      }
    }
    const githubBase = `${origin}/plugins/github-trending/api`;
    assert.deepEqual(await fetch(`${githubBase}/export/dates`).then((response) => response.json()), {
      dates: [{ date: "2026-08-01", snapshotCount: 1 }],
    });
    const dated = await fetch(`${githubBase}/export?format=json&date=2026-08-01`);
    assert.equal(dated.status, 200);
    assert.match(dated.headers.get("content-disposition") || "", /github-trending-history-2026-08-01\.json/u);
    assert.equal(JSON.parse(await dated.text()).snapshots.length, 1);
    assert.equal((await fetch(`${githubBase}/export?format=json&date=2026-02-30`)).status, 500);
  } finally {
    await stopRuntime(runtime?.child);
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
