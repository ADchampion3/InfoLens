import { openStore } from "./storage.js";
import { downloadableResponse } from "../../../packages/plugin-sdk/src/index.js";

const POLICIES = new Set(["manual", "disabled", "fixed"]);
const INTERVALS = new Set([15, 30, 60, 360, 720, 1440]);
const RETENTION_DAYS = new Set([7, 30, 90]);
const PLUGIN_VERSION = "0.3.0";

function text(value, field) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`Hacker News result has invalid ${field}`);
  return value;
}
function count(value, field) {
  if (!Number.isInteger(value) || value < 0) throw new Error(`Hacker News result has invalid ${field}`);
  return value;
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

export async function activate(context) {
  const store = openStore(context.resolveDataPath("hacker-news.sqlite"));
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
    if (settings.policy === "fixed") cancelSchedule = context.schedule("refresh", { intervalMs: settings.intervalMinutes * 60_000, reason: "schedule" });
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
      return { ok: false, ...summary() };
    }
  });
  context.route("GET", "/summary", summary);
  context.route("POST", "/refresh", async () => {
    if (store.settings().policy === "disabled") return { ok: false, disabled: true, ...summary() };
    return context.enqueue("refresh", undefined, { reason: "manual", coalesceKey: "collection" });
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
  context.route("GET", "/export", () => downloadableResponse(`hacker-news-history-${new Date().toISOString().slice(0, 10)}.json`, store.createExport(PLUGIN_VERSION)));
  configureSchedule();
  updateHealth();
  return { async deactivate() { cancelSchedule?.(); store.close(); } };
}
