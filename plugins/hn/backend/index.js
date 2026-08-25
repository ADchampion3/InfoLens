import { openStore } from "./history-storage.js";
import { downloadableResponse } from "@infolens/plugin-sdk";
import { readLatestDailySnapshot } from "@infolens/plugin-sdk/daily-summary-store";
import { createExport } from "./export.js";

const POLICIES = new Set(["manual", "disabled", "fixed"]);
const INTERVALS = new Set([15, 30, 60, 360, 720, 1440]);
const RETENTION_DAYS = new Set([7, 30, 90]);
const PLUGIN_VERSION = "0.3.0";
const REFRESH_RETRY = Object.freeze({ maxAttempts: 3, backoffMs: 250, maxBackoffMs: 2_000, backoffMultiplier: 2 });

function text(value, field) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`Hacker News result has invalid ${field}`);
  return value;
}
function count(value, field) {
  if (!Number.isInteger(value) || value < 0) throw new Error(`Hacker News result has invalid ${field}`);
  return value;
}

function retryable(error) {
  return error?.retryable === true || ["ETIMEDOUT", "ECONNRESET", "ECONNREFUSED", "EAI_AGAIN", "NETWORK_ERROR", "OPENCLI_NETWORK_ERROR"].includes(error?.code);
}

export function validateCollection(result) {
  if (!Array.isArray(result) || result.length === 0) throw new Error("Hacker News OpenCLI result must contain rows");
  const collectedAt = new Date().toISOString();
  return result.map((story, index) => {
    const id = text(String(story?.id ?? ""), `rows[${index}].id`);
    const discussionUrl = `https://news.ycombinator.com/item?id=${encodeURIComponent(id)}`;
    const url = typeof story.url === "string" && story.url ? story.url : discussionUrl;
    let domain = "";
    try { const hostname = new URL(url).hostname.replace(/^www\./, ""); if (hostname !== "news.ycombinator.com") domain = hostname; } catch { throw new Error(`Hacker News result has invalid rows[${index}].url`); }
    return {
      id, rank: count(story.rank, `rows[${index}].rank`), title: text(story.title, `rows[${index}].title`), domain,
      points: count(story.score, `rows[${index}].score`), author: text(story.author, `rows[${index}].author`),
      createdAt: collectedAt, comments: count(story.comments ?? 0, `rows[${index}].comments`), url, discussionUrl,
    };
  });
}

function dailySummary(filename, input) {
  const snapshot = readLatestDailySnapshot(filename, {
    ...input,
    stateQuery: "SELECT story_id AS id, is_read AS isRead FROM story_user_state",
    identity: (value) => value.id,
    parse: (row) => {
      let records;
      try { records = JSON.parse(row.payload); } catch { throw new Error("Hacker News snapshot payload is malformed"); }
      if (!Array.isArray(records)) throw new Error("Hacker News snapshot payload is malformed");
      return records;
    },
  });
  if (snapshot.state === "no-data") return snapshot;
  return {
    state: "ready",
    collectedAt: snapshot.collectedAt,
    recordCount: snapshot.records.length,
    records: snapshot.records.map((story) => {
      if (!story || typeof story !== "object" || typeof story.title !== "string" || !story.title.trim()) throw new Error("Hacker News snapshot story is malformed");
      if (typeof story.id !== "string" || !story.id.trim() || !Number.isInteger(story.rank) || story.rank < 0) throw new Error("Hacker News snapshot story is malformed");
      const fields = {
        id: story.id,
        ...(story.domain ? { domain: story.domain } : {}),
        points: story.points,
        author: story.author,
        createdAt: story.createdAt,
        comments: story.comments,
        discussionUrl: story.discussionUrl,
      };
      if (![story.points, story.comments].every((value) => Number.isInteger(value) && value >= 0)) throw new Error("Hacker News snapshot story is malformed");
      if (typeof story.author !== "string" || typeof story.createdAt !== "string" || typeof story.discussionUrl !== "string") throw new Error("Hacker News snapshot story is malformed");
      return { title: story.title, url: story.url, rank: story.rank, read: story.read, fields };
    }),
  };
}

export async function activate(context) {
  const store = openStore(context.resolveDataPath("hacker-news.sqlite"));
  const storeFilename = context.resolveDataPath("hacker-news.sqlite");
  store.cleanupOnActivation();
  let cancelSchedule;
  const summary = () => {
    const stories = store.list();
    const metadata = store.metadata();
    return { source: "Hacker News", collection: "Top Stories", stories, settings: store.settings(), ...metadata };
  };
  const updateHealth = () => {
    const data = summary();
    context.setHealth({ state: "ready", badge: String(data.stories.filter((story) => !story.read).length), lastSuccessfulRefresh: data.lastSuccessfulRefresh });
  };
  const configureSchedule = () => {
    cancelSchedule?.();
    cancelSchedule = undefined;
    const settings = store.settings();
    if (settings.policy === "fixed") {
      const lastSuccessfulRefresh = Date.parse(store.metadata().lastSuccessfulRefresh ?? "");
      const intervalMs = settings.intervalMinutes * 60_000;
      const runImmediately = !Number.isFinite(lastSuccessfulRefresh) || Date.now() - lastSuccessfulRefresh >= intervalMs;
      cancelSchedule = context.schedule("refresh", { intervalMs, runImmediately, reason: "schedule", retry: REFRESH_RETRY });
    }
  };

  context.task("refresh", async (_, task) => {
    try {
      const stories = validateCollection(await context.opencli.run("topStories", ["--limit=30"], task.signal));
      store.replace(stories, new Date().toISOString());
      updateHealth();
      return { ok: true, ...summary() };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      store.recordFailure(message, new Date().toISOString());
      await context.logger.warn("collection-failed-retained-content-preserved", { message });
      updateHealth();
      return { ok: false, retryable: retryable(error), ...summary() };
    }
  });
  context.route("GET", "/summary", summary);
  context.registerDailySummaryProvider((input) => dailySummary(storeFilename, input));
  context.route("POST", "/refresh", async () => {
    if (store.settings().policy === "disabled") return { ok: false, disabled: true, ...summary() };
    return context.enqueue("refresh", undefined, { reason: "manual", coalesceKey: "collection", retry: REFRESH_RETRY });
  });
  context.route("POST", "/read", ({ url }) => { store.markRead(url.searchParams.get("id"), url.searchParams.get("read") !== "false"); updateHealth(); return summary(); });
  context.route("GET", "/settings", () => store.settings());
  context.route("POST", "/settings", ({ url }) => {
    const policy = url.searchParams.get("policy");
    const intervalMinutes = Number(url.searchParams.get("intervalMinutes") ?? 60);
    const retentionDays = Number(url.searchParams.get("retentionDays") ?? store.settings().retentionDays);
    if (!POLICIES.has(policy) || !INTERVALS.has(intervalMinutes) || !RETENTION_DAYS.has(retentionDays)) throw new Error("Unsupported refresh setting");
    store.saveSettings({ policy, intervalMinutes, retentionDays }, { acknowledgeRetentionCleanup: url.searchParams.get("acknowledgeRetentionCleanup") === "true" });
    configureSchedule();
    return store.settings();
  });
  context.route("GET", "/history", ({ url }) => store.snapshots({ limit: url.searchParams.get("limit"), offset: url.searchParams.get("offset") }));
  context.route("GET", "/history/snapshot", ({ url }) => store.snapshot(url.searchParams.get("id")) ?? { error: "Snapshot not found" });
  context.route("GET", "/export", ({ url }) => {
    const format = url.searchParams.get("format") ?? "json";
    const exportedAt = new Date().toISOString();
    return downloadableResponse({
      filenameBase: `hacker-news-history-${exportedAt.slice(0, 10)}`,
      format,
      body: createExport(context.resolveDataPath("hacker-news.sqlite"), { pluginId: "hn", pluginVersion: PLUGIN_VERSION, format, exportedAt }),
    });
  });
  configureSchedule();
  updateHealth();
  return { async deactivate() { cancelSchedule?.(); store.close(); } };
}
