import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { test } from "node:test";
import { aggregateDailySummary, normalizeDailySummaryResult } from "../packages/plugin-runtime/src/daily-summary.mjs";
import { readLatestDailySnapshot } from "../packages/plugin-sdk/src/daily-summary-store.js";
import { openStore as openGithub } from "../plugins/github-trending/backend/history-storage.js";
import { activate as activateGithub } from "../plugins/github-trending/backend/index.js";
import { openStore as openHn } from "../plugins/hn/backend/history-storage.js";
import { activate as activateHn } from "../plugins/hn/backend/index.js";
import { openStore as openProductHunt } from "../plugins/product-hunt/backend/history-storage.js";
import { activate as activateProductHunt } from "../plugins/product-hunt/backend/index.js";
import { openStore as openJuejin } from "../plugins/juejin/backend/history-storage.js";
import { activate as activateJuejin } from "../plugins/juejin/backend/index.js";
import { openStore as openZhihu } from "../plugins/zhihu-hot/backend/history-storage.js";
import { activate as activateZhihu } from "../plugins/zhihu-hot/backend/index.js";
import {
  createDailySummaryPreview,
  dailySummaryDeliveryDecision,
  dailySummaryFilename,
  dailySummaryPromptFilename,
  dailySummaryRelativeAge,
  dailySummarySourceMetadata,
  dailySummaryWrittenFilename,
  defaultDailySummarySelection,
  groupDailySummaryEntries,
  isDailySummaryPreviewCurrent,
  normalizeDailySummarySelection,
  renderDailySummaryPrompt,
  renderDailySummaryMarkdown,
  renderDailySummaryWrittenMarkdown,
  toggleDailySummarySelection,
} from "../apps/desktop/src/daily-summary.ts";

const root = path.resolve(import.meta.dirname, "..");
const mockOpenCli = path.join(root, "tests", "fixtures", "runtime-opencli", "opencli");
const GENERATED_AT = "2026-08-12T03:00:00.000Z";
const TIME_ZONE = "Asia/Shanghai";
const LOCAL_DATE = "2026-08-12";
const RUNTIME_TOKEN = "daily-summary-test-session";

async function withTempDirectory(callback) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "infolens-daily-summary-"));
  try {
    return await callback(directory);
  } finally {
    for (let attempt = 0; attempt < 12; attempt += 1) {
      try {
        await rm(directory, { recursive: true, force: true });
        break;
      } catch (error) {
        if (!(["EBUSY", "EPERM"].includes(error?.code)) || attempt === 11) throw error;
        await delay(25);
      }
    }
  }
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function startRuntime({ pluginsRoot, dataRoot, extraEnv = {} }) {
  const stateFile = path.join(dataRoot, "opencli-state.json");
  await mkdir(path.dirname(stateFile), { recursive: true });
  await writeFile(stateFile, "{}", "utf8");
  const child = spawn(process.execPath, [path.join(root, "packages", "plugin-runtime", "src", "server.mjs")], {
    cwd: root,
    env: {
      ...process.env,
      INFOLENS_PROJECT_ROOT: root,
      INFOLENS_PLUGINS_ROOT: pluginsRoot,
      INFOLENS_PLUGIN_DATA_ROOT: dataRoot,
      INFOLENS_HOST_STATE_PATH: path.join(path.dirname(dataRoot), "host-state.json"),
      INFOLENS_ADAPTER_REGISTRY_ROOT: path.join(path.dirname(dataRoot), "adapter-registry"),
      INFOLENS_BUNDLED_OPENCLI_ROOT: mockOpenCli,
      INFOLENS_TEST_OPENCLI_STATE: stateFile,
      INFOLENS_RUNTIME_PORT: "0",
      INFOLENS_APPLICATION_SESSION_ID: RUNTIME_TOKEN,
      ...extraEnv,
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
      let message;
      try { message = JSON.parse(line); } catch { return; }
      if (message.type !== "runtime-ready") return;
      clearTimeout(timeout);
      resolve({ child, lines, message });
    });
  });
}

async function stopRuntime(runtime) {
  if (!runtime?.child || runtime.child.exitCode !== null) return;
  const exited = new Promise((resolve) => runtime.child.once("exit", resolve));
  runtime.child.stdin.write("shutdown\n");
  runtime.child.stdin.end();
  await exited;
  runtime.lines.close();
}

async function request(origin, route, init) {
  const response = await fetch(`${origin}${route}`, { headers: { "content-type": "application/json", authorization: `Bearer ${RUNTIME_TOKEN}` }, ...init });
  const body = await response.json();
  return { response, body };
}

function createPluginContext(filename, providers) {
  const noopLogger = {
    debug: async () => undefined,
    info: async () => ({ id: "test-log", operationId: "test-operation", timestamp: GENERATED_AT }),
    warn: async () => undefined,
    error: async () => ({ id: "test-log", operationId: "test-operation", timestamp: GENERATED_AT }),
  };
  return {
    pluginId: "daily-summary-test",
    dataDir: path.dirname(filename),
    resolveDataPath: () => filename,
    route: () => undefined,
    task: () => undefined,
    enqueue: () => undefined,
    schedule: () => () => undefined,
    setHealth: () => undefined,
    setRefreshOptions: () => undefined,
    registerDailySummaryProvider: (provider) => { providers.push(provider); },
    logger: noopLogger,
    opencli: { run: async () => { throw new Error("OpenCLI must not run while reading Daily Summary"); } },
  };
}

const officialProviders = [
  {
    id: "hn",
    filename: "hacker-news.sqlite",
    openStore: openHn,
    activate: activateHn,
    identity: "story-1",
    makeRecords(label) {
      return [{
        id: "story-1",
        rank: label === "latest" ? 1 : 9,
        title: label === "latest" ? "Latest HN story" : "Old HN story",
        domain: "example.com",
        points: label === "latest" ? 125 : 1,
        author: "author",
        createdAt: "2026-08-12T02:30:00.000Z",
        comments: 14,
        url: "https://example.com/story-1",
        discussionUrl: "https://news.ycombinator.com/item?id=story-1",
      }];
    },
     expectedFields: ["id", "domain", "points", "author", "createdAt", "comments", "discussionUrl"],
  },
  {
    id: "github-trending",
    filename: "github-trending.sqlite",
    openStore: openGithub,
    activate: activateGithub,
    identity: "infolens/runtime",
    makeRecords(label) {
      return [{
        id: "infolens/runtime",
        rank: label === "latest" ? 1 : 9,
        owner: "infolens",
        name: "runtime",
        description: "Runtime repository",
        language: "JavaScript",
        languageColor: "#f1e05a",
        stars: 500,
        forks: 20,
        starsGained: 30,
        url: "https://github.com/infolens/runtime",
      }];
    },
    expectedFields: ["owner", "repository", "stars", "forks", "starsGained", "description", "language", "languageColor"],
  },
  {
    id: "juejin",
    filename: "juejin.sqlite",
    openStore: openJuejin,
    activate: activateJuejin,
    identity: "1234567890123456789",
    makeRecords(label) {
      return [{
        id: "1234567890123456789",
        category: "backend",
        rank: label === "latest" ? 1 : 9,
        title: label === "latest" ? "Latest Juejin article" : "Old Juejin article",
        brief: "Article brief",
        author: "author",
        views: 100,
        likes: 20,
        comments: 3,
        hotRank: 99,
        url: "https://juejin.cn/post/1234567890123456789",
      }];
    },
    expectedFields: ["category", "author", "brief", "views", "likes", "comments", "hotRank"],
  },
  {
    id: "zhihu-hot",
    filename: "zhihu-hot.sqlite",
    openStore: openZhihu,
    activate: activateZhihu,
    identity: "https://www.zhihu.com/question/10001",
    makeRecords(label) {
      return [{
        rank: label === "latest" ? 1 : 9,
        title: label === "latest" ? "最新问题" : "旧问题",
        excerpt: "问题摘要",
        heat: "1.2M",
        answers: 88,
        thumbnailUrl: "https://www.zhihu.com/image.png",
        url: "https://www.zhihu.com/question/10001",
      }];
    },
    expectedFields: ["heat", "answers", "excerpt", "thumbnailUrl"],
  },
  {
    id: "product-hunt",
    filename: "product-hunt.sqlite",
    openStore: openProductHunt,
    activate: activateProductHunt,
    identity: "https://www.producthunt.com/products/infolens",
    makeRecords(label) {
      return [{
        rank: label === "latest" ? 1 : 9,
        name: label === "latest" ? "Latest Launch" : "Old Launch",
        votes: 321,
        url: "https://www.producthunt.com/products/infolens",
      }];
    },
    expectedFields: ["votes"],
  },
];

async function seedStore(definition, filename, snapshots) {
  const store = definition.openStore(filename);
  for (const snapshot of snapshots) store.replace(snapshot.records, snapshot.collectedAt);
  if (snapshots.at(-1)?.records.length) store.markRead(definition.identity, true);
  store.close();
}

async function readProvider(definition, filename) {
  const providers = [];
  const lifecycle = await definition.activate(createPluginContext(filename, providers));
  assert.equal(providers.length, 1, `${definition.id} must register one Daily Summary provider`);
  return { provider: providers[0], lifecycle };
}

test("Runtime Daily Summary normalizes the provider contract and isolates failures", async () => {
  const seen = [];
  const controller = new AbortController();
  const aggregate = await aggregateDailySummary([
    {
      pluginId: "alpha",
      name: "Alpha",
       state: "running",
      provider: async (input) => {
        seen.push(input);
        return { state: "ready", collectedAt: input.generatedAt, recordCount: 1, records: [{ title: "Alpha", fields: { localDate: input.localDate, timeZone: input.timeZone, generatedAt: input.generatedAt } }] };
      },
      browserDependent: true,
    },
    {
      pluginId: "broken",
      name: "Broken",
      state: "running",
      provider: () => { throw new Error("C:\\private\\cookie=secret"); },
    },
    { pluginId: "unsupported", name: "Unsupported", state: "running" },
    { pluginId: "disabled", name: "Disabled", enabled: false, state: "disabled", provider: () => { throw new Error("must not run"); } },
  ], { now: GENERATED_AT, timeZone: TIME_ZONE, signal: controller.signal });

  assert.equal(aggregate.localDate, LOCAL_DATE);
  assert.equal(aggregate.timeZone, TIME_ZONE);
  assert.equal(aggregate.generatedAt, GENERATED_AT);
  assert.deepEqual(aggregate.plugins.map(({ pluginId, status }) => [pluginId, status]), [
    ["alpha", "ready"], ["broken", "unavailable"], ["unsupported", "unsupported"], ["disabled", "disabled"],
  ]);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].signal, controller.signal);
  assert.deepEqual(aggregate.plugins[1].context, { state: "unavailable", reason: "Daily Summary data is unavailable" });
  assert(!JSON.stringify(aggregate).includes("cookie"));
  assert(!JSON.stringify(aggregate).includes("secret"));
  assert.deepEqual(normalizeDailySummaryResult({ state: "no-data", records: [] }), { state: "no-data", recordCount: 0, records: [] });
  assert.throws(() => normalizeDailySummaryResult({ state: "ready", collectedAt: "not-a-time", recordCount: 0, records: [] }), /safe collectedAt/);
  assert.throws(() => normalizeDailySummaryResult(JSON.parse('{"state":"ready","collectedAt":"2026-08-12T03:00:00.000Z","recordCount":1,"records":[{"title":"x","fields":{"__proto__":"bad"}}]}')), /invalid label/);
});

test("Runtime passes an AbortSignal when a caller does not provide one", async () => {
  let received;
  await aggregateDailySummary([{ pluginId: "signal", provider: (input) => { received = input.signal; return { state: "no-data", records: [] }; } }], { now: GENERATED_AT, timeZone: TIME_ZONE });
  assert(received instanceof AbortSignal);
});

test("Runtime requires plugin.pluginId instead of accepting a legacy id", async () => {
  await assert.rejects(
    () => aggregateDailySummary([{ id: "legacy", provider: () => ({ state: "no-data", records: [] }) }], { now: GENERATED_AT, timeZone: TIME_ZONE }),
    /requires pluginId/,
  );
});

test("Daily Summary snapshot reader chooses the latest instant inside the local day", async () => {
  await withTempDirectory(async (directory) => {
    const filename = path.join(directory, "snapshots.sqlite");
    const db = new DatabaseSync(filename);
    db.exec("CREATE TABLE collection_snapshots (id INTEGER PRIMARY KEY, collected_at TEXT NOT NULL, record_count INTEGER NOT NULL, payload TEXT NOT NULL); CREATE TABLE user_state (id TEXT PRIMARY KEY, is_read INTEGER NOT NULL);");
    db.prepare("INSERT INTO collection_snapshots VALUES (?, ?, ?, ?)").run(1, "2026-08-12T00:30:00+08:00", 1, JSON.stringify([{ id: "earlier", title: "Earlier" }]));
    db.prepare("INSERT INTO collection_snapshots VALUES (?, ?, ?, ?)").run(2, "2026-08-11T17:00:00Z", 1, JSON.stringify([{ id: "later", title: "Later" }]));
    db.close();
    const result = readLatestDailySnapshot(filename, {
      localDate: LOCAL_DATE,
      timeZone: TIME_ZONE,
      stateQuery: "SELECT id, is_read AS isRead FROM user_state",
      identity: (record) => record.id,
      parse: (row) => JSON.parse(row.payload),
    });
    assert.equal(result.state, "ready");
    assert.equal(result.collectedAt, "2026-08-11T17:00:00.000Z");
    assert.equal(result.records[0].id, "later");
  });
});

test("the official Plugins expose only their latest current-day business snapshot", async (t) => {
  for (const definition of officialProviders) {
    await t.test(definition.id, async () => {
      await withTempDirectory(async (directory) => {
        const filename = path.join(directory, definition.filename);
        await seedStore(definition, filename, [
          { collectedAt: "2026-08-11T15:00:00.000Z", records: definition.makeRecords("old") },
          { collectedAt: "2026-08-11T16:01:00.000Z", records: definition.makeRecords("boundary") },
          { collectedAt: "2026-08-12T02:00:00.000Z", records: definition.makeRecords("latest") },
        ]);
        const { provider, lifecycle } = await readProvider(definition, filename);
        try {
          const result = await provider({ localDate: LOCAL_DATE, timeZone: TIME_ZONE, generatedAt: GENERATED_AT, signal: new AbortController().signal });
          assert.equal(result.state, "ready");
          assert.equal(result.collectedAt, "2026-08-12T02:00:00.000Z");
          assert.equal(result.recordCount, 1);
          assert.equal(result.records[0].read, true);
          assert.equal(result.records[0].title, definition.makeRecords("latest")[0].title ?? definition.makeRecords("latest")[0].name);
          assert.deepEqual(Object.keys(result.records[0].fields), definition.expectedFields);
          const serialized = JSON.stringify(result);
          for (const privateValue of ["settings", "failure", "logs", "cookie", "dependencyState", "payload", "sqlite", "README", "adapter"]) assert(!serialized.includes(privateValue), `${definition.id} leaked ${privateValue}`);
        } finally {
          await lifecycle?.deactivate?.();
        }
      });
    });
  }
});

test("official Plugin Context returns no-data without falling back to a previous local day", async (t) => {
  for (const definition of officialProviders) {
    await t.test(definition.id, async () => {
      await withTempDirectory(async (directory) => {
        const filename = path.join(directory, definition.filename);
        await seedStore(definition, filename, [{ collectedAt: "2026-08-11T15:00:00.000Z", records: definition.makeRecords("old") }]);
        const { provider, lifecycle } = await readProvider(definition, filename);
        try {
          assert.deepEqual(await provider({ localDate: LOCAL_DATE, timeZone: TIME_ZONE, generatedAt: GENERATED_AT, signal: new AbortController().signal }), { state: "no-data", records: [] });
        } finally {
          await lifecycle?.deactivate?.();
        }
      });
    });
  }
});

test("a malformed official snapshot is normalized by Runtime at the provider seam", async () => {
  await withTempDirectory(async (directory) => {
    const filename = path.join(directory, "hacker-news.sqlite");
    const store = openHn(filename);
    store.close();
    const db = new DatabaseSync(filename);
    db.prepare("INSERT INTO collection_snapshots(collected_at, record_count, payload) VALUES (?, ?, ?)").run(GENERATED_AT, 1, "{");
    db.close();
    const { provider, lifecycle } = await readProvider(officialProviders[0], filename);
    try {
      const result = await aggregateDailySummary([{ pluginId: "hn", name: "Hacker News", state: "running", provider }], { now: GENERATED_AT, timeZone: TIME_ZONE });
      assert.equal(result.plugins[0].status, "unavailable");
      assert.deepEqual(result.plugins[0].context, { state: "unavailable", reason: "Daily Summary data is unavailable" });
    } finally {
      await lifecycle?.deactivate?.();
    }
  });
});

function fixtureManifest(id, name) {
  return {
    id,
    name,
    version: "1.0.0",
    contractVersion: "2",
    minHostVersion: "0.2.0",
    backend: { entry: "backend/index.mjs" },
    ui: { entry: "web/index.html" },
    openCliAdapters: {},
    openCliCommands: {},
  };
}

async function writeFixturePlugin(pluginsRoot, id, behavior) {
  const packageRoot = path.join(pluginsRoot, id);
  await mkdir(path.join(packageRoot, "backend"), { recursive: true });
  await mkdir(path.join(packageRoot, "web"), { recursive: true });
  await writeFile(path.join(packageRoot, "manifest.json"), JSON.stringify(fixtureManifest(id, id)), "utf8");
  await writeFile(path.join(packageRoot, "web", "index.html"), "<!doctype html><title>Daily Summary fixture</title>", "utf8");
  let backend;
  if (behavior === "unsupported") {
    backend = "export async function activate() { return { async deactivate() {} }; }";
  } else if (behavior === "duplicate") {
    backend = "export async function activate(context) { const provider = () => ({ state: 'no-data', records: [] }); context.registerDailySummaryProvider(provider); context.registerDailySummaryProvider(provider); }";
  } else if (behavior === "failure") {
    backend = "export async function activate(context) { context.registerDailySummaryProvider(() => { throw new Error('C:\\\\private\\\\cookie=secret'); }); }";
  } else if (behavior === "malformed") {
    backend = "export async function activate(context) { context.registerDailySummaryProvider(() => ({ state: 'ready', collectedAt: 'unsafe', recordCount: 0, records: [] })); }";
  } else {
    backend = "export async function activate(context) { context.registerDailySummaryProvider((input) => ({ state: 'ready', collectedAt: input.generatedAt, recordCount: 1, records: [{ title: 'Fixture record', fields: { localDate: input.localDate, timeZone: input.timeZone, generatedAt: input.generatedAt } }] })); }";
  }
  await writeFile(path.join(packageRoot, "backend", "index.mjs"), backend, "utf8");
}

test("Runtime aggregates dynamically registered and disabled capabilities in package order", async () => {
  await withTempDirectory(async (directory) => {
    const pluginsRoot = path.join(directory, "plugins");
    const dataRoot = path.join(directory, "data", "plugins");
    await mkdir(pluginsRoot, { recursive: true });
    await Promise.all([
      writeFixturePlugin(pluginsRoot, "aaa-good", "good"),
      writeFixturePlugin(pluginsRoot, "bbb-failure", "failure"),
      writeFixturePlugin(pluginsRoot, "ccc-unsupported", "unsupported"),
      writeFixturePlugin(pluginsRoot, "ddd-disabled", "good"),
      writeFixturePlugin(pluginsRoot, "eee-duplicate", "duplicate"),
      writeFixturePlugin(pluginsRoot, "fff-malformed", "malformed"),
    ]);
    await mkdir(path.join(directory, "data"), { recursive: true });
    await writeFile(path.join(directory, "data", "host-state.json"), JSON.stringify({
      version: 1,
      enabledPluginIds: ["aaa-good", "bbb-failure", "ccc-unsupported", "eee-duplicate", "fff-malformed"],
      lastSelection: null,
      theme: "system",
      statusSnapshots: { "ddd-disabled": { state: "disabled", updatedAt: GENERATED_AT } },
    }), "utf8");
    const runtime = await startRuntime({ pluginsRoot, dataRoot, extraEnv: { INFOLENS_DAILY_SUMMARY_NOW: GENERATED_AT, INFOLENS_DAILY_SUMMARY_TIME_ZONE: TIME_ZONE } });
    try {
      const { response, body } = await request(runtime.message.origin, "/runtime/daily-summary");
      assert.equal(response.status, 200);
      assert.deepEqual(body.plugins.map(({ pluginId, status }) => [pluginId, status]), [
        ["aaa-good", "ready"], ["bbb-failure", "unavailable"], ["ccc-unsupported", "unsupported"],
        ["ddd-disabled", "disabled"], ["eee-duplicate", "unavailable"], ["fff-malformed", "unavailable"],
      ]);
      assert.equal(body.localDate, LOCAL_DATE);
      assert.equal(body.timeZone, TIME_ZONE);
      assert.equal(body.plugins[0].context.records[0].fields.localDate, LOCAL_DATE);
      assert.equal(body.plugins[0].context.records[0].fields.timeZone, TIME_ZONE);
      assert.equal(body.plugins[0].context.records[0].fields.generatedAt, GENERATED_AT);
      const serialized = JSON.stringify(body);
      for (const privateValue of ["secret", "cookie", "private", "C:\\", "stack"]) assert(!serialized.includes(privateValue));
      assert.equal(body.plugins.find(({ pluginId }) => pluginId === "ddd-disabled").enabled, false);
    } finally {
      await stopRuntime(runtime);
    }
  });
});

function hostAggregate() {
  return {
    localDate: LOCAL_DATE,
    timeZone: TIME_ZONE,
    generatedAt: GENERATED_AT,
    plugins: [
      {
        pluginId: "alpha", name: "Alpha", version: "1.0.0", enabled: true, pluginState: "running", browserDependent: true, status: "ready",
        context: { state: "ready", collectedAt: "2026-08-12T01:00:00.000Z", recordCount: 1, records: [{ title: "标题 <script>\nsecond", url: "https://example.com/a(b)", rank: 1, read: true, fields: { points: 4, "metric|label": "值 * with # marks" } }] },
      },
      { pluginId: "beta", name: "Beta", enabled: true, pluginState: "running", browserDependent: false, status: "no-data", context: { state: "no-data", recordCount: 0, records: [] } },
      { pluginId: "gamma", name: "Gamma", enabled: true, pluginState: "failed", browserDependent: false, status: "unavailable", context: { state: "unavailable" } },
      { pluginId: "delta", name: "Delta", enabled: true, pluginState: "running", browserDependent: false, status: "unsupported" },
      { pluginId: "epsilon", name: "Epsilon", enabled: false, pluginState: "disabled", browserDependent: false, status: "disabled" },
    ],
  };
}

test("Host Daily Summary selection, deterministic Markdown, escaping, and preview invalidation", () => {
  const aggregate = hostAggregate();
  assert.deepEqual([...defaultDailySummarySelection(aggregate)], ["alpha"]);
  const selected = normalizeDailySummarySelection(aggregate, ["epsilon", "gamma", "beta", "delta", "alpha"]);
  assert.deepEqual([...selected], ["alpha", "beta", "gamma"]);
  assert.deepEqual([...toggleDailySummarySelection(aggregate, selected, "beta")], ["alpha", "gamma"]);
  assert.deepEqual([...toggleDailySummarySelection(aggregate, selected, "delta")], ["alpha", "beta", "gamma"]);
  const markdown = renderDailySummaryMarkdown(aggregate, selected);
  assert.match(markdown, /# Infolens Daily Summary/);
  assert.match(markdown, /- Local date: 2026-08-12/);
  assert.match(markdown, /- Time zone: Asia\/Shanghai/);
  assert.match(markdown, /## Alpha[\s\S]*## Beta[\s\S]*## Gamma/);
  assert.match(markdown, /No qualifying Collection Snapshot exists for 2026-08-12/);
  assert.match(markdown, /Daily Summary data is unavailable/);
  assert.match(markdown, /标题/);
  assert.match(markdown, /\\<script\\>/);
  assert.match(markdown, /metric\\\|label: 值 \\\* with \\\# marks/);
  assert.match(markdown, /https:\/\/example\.com\/a%28b%29/);
  assert(!markdown.includes("<script>"));
  assert(!markdown.includes("summarize"));
  assert.equal(dailySummaryRelativeAge("2026-08-12T01:00:00.000Z", GENERATED_AT), "2 hours");
  assert.deepEqual(dailySummarySourceMetadata(aggregate.plugins[1], GENERATED_AT), { collectedAt: "Unknown", relativeAge: "Unknown", recordCount: 0 });
  assert.deepEqual(dailySummarySourceMetadata(aggregate.plugins[2], GENERATED_AT), { collectedAt: "Unknown", relativeAge: "Unknown", recordCount: 0 });
  assert.match(markdown, /Beta[\s\S]*Snapshot collected at: Unknown[\s\S]*Relative age: Unknown[\s\S]*Record count: 0/);
  assert.match(markdown, /Gamma[\s\S]*Snapshot collected at: Unknown[\s\S]*Relative age: Unknown[\s\S]*Record count: 0/);
  const preview = createDailySummaryPreview(aggregate, selected);
  assert.equal(preview.markdown, markdown);
  assert(isDailySummaryPreviewCurrent(preview, aggregate, selected));
  const changed = toggleDailySummarySelection(aggregate, selected, "beta");
  assert(!isDailySummaryPreviewCurrent(preview, aggregate, changed));
  assert.throws(() => createDailySummaryPreview(aggregate, ["delta", "epsilon"]), /Select at least one/);
});

test("Host Daily Summary Generate preview invokes the preview workflow", async () => {
  const appSource = await readFile(path.join(root, "apps", "desktop", "src", "App.tsx"), "utf8");
  assert.doesNotMatch(appSource, /onClick=\{\(\) => void generatePreview\}/u);
  assert.match(appSource, /onClick=\{\(\) => void generatePreview\(\)\}/u);
});

test("Host Daily Summary keeps the prompt copy action enabled for the current selection", async () => {
  const appSource = await readFile(path.join(root, "apps", "desktop", "src", "App.tsx"), "utf8");
  assert.match(appSource, /setPreview\(nextSelection\.size \? createDailySummaryPreview\(next, nextSelection\) : undefined\);/u);
  assert.match(appSource, /setPreview\(nextSelection\.size \? createDailySummaryPreview\(aggregate, nextSelection\) : undefined\);/u);
});

test("Host Daily Summary prepares a topic-based writing prompt and authored export", () => {
  const aggregate = hostAggregate();
  aggregate.plugins[0].context.records[0].fields.topic = "AI tooling";
  aggregate.plugins[0].context.records.push({ title: "Second topic item", fields: { category: "AI tooling" } });
  const groups = groupDailySummaryEntries(aggregate, ["alpha"]);
  assert.deepEqual(groups.map(({ topic }) => topic), ["AI tooling"]);
  assert.equal(groups[0].entries.length, 2);

  const prompt = renderDailySummaryPrompt(aggregate, ["alpha", "beta"]);
  assert.match(prompt, /按内容主题/);
  assert.match(prompt, /每个 entry 只能在一个最合适的主题/);
  assert.match(prompt, /今日信息素材/);
  assert.match(prompt, /AI tooling/);
  assert.match(prompt, /No qualifying Collection Snapshot exists/);

  const written = renderDailySummaryWrittenMarkdown(aggregate, ["alpha"], "## AI tooling\n- 今日有一个值得跟进的变化。");
  assert.match(written, /## Written summary/);
  assert.match(written, /今日有一个值得跟进的变化/);
  assert.equal(dailySummaryPromptFilename(LOCAL_DATE), "infolens-daily-summary-prompt-2026-08-12.md");
  assert.equal(dailySummaryWrittenFilename(LOCAL_DATE), "infolens-daily-summary-written-2026-08-12.md");
  assert.throws(() => renderDailySummaryWrittenMarkdown(aggregate, ["alpha"], "  \n  "), /Write a Daily Summary/);

  const preview = createDailySummaryPreview(aggregate, ["alpha"]);
  const exportedPrompt = dailySummaryDeliveryDecision({ aggregate, selectedPluginIds: ["alpha"], preview, acknowledgedPreviewKey: preview.key, deliveryText: prompt, deliveryFilename: dailySummaryPromptFilename(LOCAL_DATE) });
  assert.equal(exportedPrompt.allowed, true);
  assert.equal(exportedPrompt.text, prompt);
  assert.equal(exportedPrompt.filename, "infolens-daily-summary-prompt-2026-08-12.md");
});

test("Host delivery decisions gate privacy and reuse one frozen UTF-8 Markdown value", () => {
  const aggregate = hostAggregate();
  const preview = createDailySummaryPreview(aggregate, ["alpha", "beta"]);
  const gated = dailySummaryDeliveryDecision({ aggregate, selectedPluginIds: ["alpha", "beta"], preview });
  assert.equal(gated.allowed, false);
  assert.equal(gated.requiresPrivacyConfirmation, true);
  assert.deepEqual(gated.privacySources, ["Alpha"]);
  const acknowledged = dailySummaryDeliveryDecision({ aggregate, selectedPluginIds: ["alpha", "beta"], preview, acknowledgedPreviewKey: preview.key });
  assert.equal(acknowledged.allowed, true);
  assert.equal(acknowledged.text, preview.markdown);
  assert.equal(acknowledged.filename, "infolens-daily-summary-2026-08-12.md");
  const copied = acknowledged.text;
  const downloaded = acknowledged.text;
  assert.equal(copied, downloaded);
  assert(copied.includes("标题"));
  assert.equal(dailySummaryFilename(LOCAL_DATE), acknowledged.filename);
  assert.deepEqual(dailySummaryDeliveryDecision({ aggregate, selectedPluginIds: [], preview }), { allowed: false, reason: "empty-selection" });
  assert.equal(dailySummaryDeliveryDecision({ aggregate, selectedPluginIds: ["alpha"], preview: undefined }).reason, "preview-required");
  assert.equal(dailySummaryDeliveryDecision({ aggregate, selectedPluginIds: ["alpha", "beta"], preview: { ...preview, key: "stale" }, acknowledgedPreviewKey: "stale" }).reason, "preview-stale");
  const changedPreview = createDailySummaryPreview({ ...aggregate, generatedAt: "2026-08-12T03:01:00.000Z" }, ["alpha", "beta"]);
  assert.equal(dailySummaryDeliveryDecision({ aggregate: { ...aggregate, generatedAt: "2026-08-12T03:01:00.000Z" }, selectedPluginIds: ["alpha", "beta"], preview: changedPreview }).requiresPrivacyConfirmation, true);
});
