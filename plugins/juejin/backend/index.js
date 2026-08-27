import { downloadableResponse } from "@infolens/plugin-sdk";
import { readLatestDailySnapshot } from "@infolens/plugin-sdk/daily-summary-store";
import { createExport, normalizeExportDate } from "./export.js";
import { openStore } from "./history-storage.js";

const POLICIES = new Set(["manual", "disabled", "fixed"]);
const INTERVALS = new Set([15, 30, 60, 360, 720, 1440]);
const RETENTION_DAYS = new Set([7, 30, 90]);
const LIMITS = new Set([10, 20, 30, 40, 50]);
const CATEGORIES = new Map([
  ["backend", "后端"],
  ["frontend", "前端"],
  ["android", "Android"],
  ["ios", "iOS"],
  ["ai", "人工智能"],
]);
const PLUGIN_VERSION = "0.1.0";

function requiredString(value, field) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`Juejin result has invalid ${field}`);
  return value.trim();
}

function nonNegativeInteger(value, field) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`Juejin result has invalid ${field}`);
  return value;
}

function optionalNonNegativeNumber(value, field) {
  if (value === null || value === undefined || value === "") return null;
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(number) || number < 0) throw new Error(`Juejin result has invalid ${field}`);
  return number;
}

function normalizeCategory(value, fallback = "backend") {
  const category = value === undefined || value === null || value === "" ? fallback : String(value).trim().toLowerCase();
  if (!CATEGORIES.has(category)) throw new Error("Unsupported Juejin category");
  return category;
}

function normalizeLimit(value, fallback = 20) {
  const limit = value === undefined || value === null || value === "" ? fallback : Number(value);
  if (!Number.isSafeInteger(limit) || !LIMITS.has(limit)) throw new Error("Unsupported Juejin result limit");
  return limit;
}

function normalizeArticleUrl(id, value, field) {
  const expected = `https://juejin.cn/post/${id}`;
  if (value === undefined || value === null || value === "") return expected;
  let parsed;
  try { parsed = new URL(String(value)); } catch { throw new Error(`Juejin result has invalid ${field}`); }
  if (!/^juejin\.cn$/u.test(parsed.hostname.replace(/^www\./u, "")) || parsed.pathname.replace(/\/$/u, "") !== `/post/${id}`) {
    throw new Error(`Juejin result has invalid ${field}`);
  }
  return expected;
}

export function validateCollection(result, category = "backend") {
  if (!Array.isArray(result) || result.length === 0) throw new Error("Juejin OpenCLI result must contain rows");
  const normalizedCategory = normalizeCategory(category);
  return result.map((row, index) => {
    const id = requiredString(row?.article_id ?? row?.articleId ?? row?.id, `rows[${index}].article_id`);
    if (!/^\d{16,20}$/u.test(id)) throw new Error(`Juejin result has invalid rows[${index}].article_id`);
    const title = requiredString(row?.title, `rows[${index}].title`);
    return {
      id,
      rank: nonNegativeInteger(row?.rank, `rows[${index}].rank`),
      category: normalizedCategory,
      title,
      brief: typeof row?.brief === "string" ? row.brief.trim() : "",
      author: typeof row?.author === "string" ? row.author.trim() : "",
      views: optionalNonNegativeNumber(row?.views, `rows[${index}].views`),
      likes: optionalNonNegativeNumber(row?.likes, `rows[${index}].likes`),
      comments: optionalNonNegativeNumber(row?.comments, `rows[${index}].comments`),
      hotRank: optionalNonNegativeNumber(row?.hot_rank ?? row?.hotRank, `rows[${index}].hot_rank`),
      url: normalizeArticleUrl(id, row?.url, `rows[${index}].url`),
    };
  });
}

function dailySummary(filename, input) {
  const snapshot = readLatestDailySnapshot(filename, {
    ...input,
    stateQuery: "SELECT article_id AS id, is_read AS isRead FROM article_user_state",
    identity: (value) => value.id,
    parse: (row) => {
      let records;
      try { records = JSON.parse(row.payload); } catch { throw new Error("Juejin snapshot payload is malformed"); }
      if (!Array.isArray(records)) throw new Error("Juejin snapshot payload is malformed");
      return records;
    },
  });
  if (snapshot.state === "no-data") return { state: "no-data", records: [] };
  return {
    state: "ready",
    collectedAt: snapshot.collectedAt,
    recordCount: snapshot.records.length,
    records: snapshot.records.map((article) => {
      if (!article || typeof article !== "object" || typeof article.id !== "string" || !/^\d{16,20}$/u.test(article.id) || typeof article.title !== "string" || !article.title.trim()) throw new Error("Juejin snapshot article is malformed");
      if (!Number.isSafeInteger(article.rank) || article.rank < 0 || typeof article.url !== "string") throw new Error("Juejin snapshot article is malformed");
      return {
        title: article.title,
        url: article.url,
        rank: article.rank,
        read: Boolean(article.read),
        fields: {
          category: article.category,
          author: article.author,
          ...(article.brief ? { brief: article.brief } : {}),
          ...(article.views !== null ? { views: article.views } : {}),
          ...(article.likes !== null ? { likes: article.likes } : {}),
          ...(article.comments !== null ? { comments: article.comments } : {}),
          ...(article.hotRank !== null ? { hotRank: article.hotRank } : {}),
        },
      };
    }),
  };
}

function refreshInput(input, settings) {
  if (input === undefined || input === null) return { category: settings.category, limit: settings.limit };
  if (typeof input !== "object" || Array.isArray(input)) throw new Error("Juejin refresh input must be an object");
  return { category: normalizeCategory(input.category, settings.category), limit: normalizeLimit(input.limit, settings.limit) };
}

export async function activate(context) {
  const store = openStore(context.resolveDataPath("juejin.sqlite"));
  const storeFilename = context.resolveDataPath("juejin.sqlite");
  store.cleanupOnActivation();
  const summary = () => ({ source: "掘金", collection: "热门文章", articles: store.list(), settings: store.settings(), ...store.metadata() });
  const updateHealth = () => {
    const data = summary();
    context.setHealth({ state: "ready", badge: String(data.articles.filter((article) => !article.read).length), lastSuccessfulRefresh: data.lastSuccessfulRefresh, dependencyState: "not-required", dependencyWarning: false });
  };
  const refreshOptions = () => {
    const settings = store.settings();
    return {
      title: "掘金采集设置",
      fields: [
        { key: "category", label: "内容分类", type: "select", options: [...CATEGORIES].map(([value, label]) => ({ value, label })) },
        { key: "limit", label: "文章数量", type: "number", min: 10, max: 50, step: 10, default: 20 },
      ],
      values: { category: settings.category, limit: settings.limit },
    };
  };

  context.setRefreshOptions(refreshOptions);
  context.task("refresh", async (input, task) => {
    try {
      const selected = refreshInput(input, store.settings());
      const args = [`--category=${selected.category}`, `--limit=${selected.limit}`];
      const articles = validateCollection(await context.opencli.run("hotArticles", args, task.signal), selected.category);
      store.replace(articles, new Date().toISOString());
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
  context.registerDailySummaryProvider((input) => dailySummary(storeFilename, input));
  context.route("POST", "/refresh", () => store.settings().policy === "disabled" ? { ok: false, disabled: true, ...summary() } : context.enqueue("refresh", undefined, { reason: "manual", coalesceKey: "collection" }));
  context.route("POST", "/read", ({ url }) => {
    const id = requiredString(url.searchParams.get("id"), "article id");
    if (!/^\d{16,20}$/u.test(id)) throw new Error("Invalid Juejin article id");
    store.markRead(id, url.searchParams.get("read") !== "false");
    updateHealth();
    return summary();
  });
  context.route("GET", "/settings", () => store.settings());
  context.route("POST", "/settings", ({ url }) => {
    const current = store.settings();
    const policy = url.searchParams.get("policy") ?? current.policy;
    const intervalMinutes = Number(url.searchParams.get("intervalMinutes") ?? current.intervalMinutes);
    const retentionDays = Number(url.searchParams.get("retentionDays") ?? current.retentionDays);
    const category = normalizeCategory(url.searchParams.get("category"), current.category);
    const limit = normalizeLimit(url.searchParams.get("limit"), current.limit);
    if (!POLICIES.has(policy) || !INTERVALS.has(intervalMinutes) || !RETENTION_DAYS.has(retentionDays)) throw new Error("Unsupported refresh setting");
    store.saveSettings({ policy, intervalMinutes, retentionDays, category, limit }, { acknowledgeRetentionCleanup: url.searchParams.get("acknowledgeRetentionCleanup") === "true" });
    return store.settings();
  });
  context.route("GET", "/history", ({ url }) => store.snapshots({ limit: url.searchParams.get("limit"), offset: url.searchParams.get("offset") }));
  context.route("GET", "/history/snapshot", ({ url }) => store.snapshot(url.searchParams.get("id")) ?? { error: "Snapshot not found" });
  context.route("GET", "/export/dates", () => ({ dates: store.snapshotDates() }));
  context.route("GET", "/export", ({ url }) => {
    const format = url.searchParams.get("format") ?? "json";
    const exportedAt = new Date().toISOString();
    const date = normalizeExportDate(url.searchParams.get("date"));
    return downloadableResponse({
      filenameBase: `juejin-history-${date ?? exportedAt.slice(0, 10)}`,
      format,
      body: createExport(storeFilename, { pluginId: "juejin", pluginVersion: PLUGIN_VERSION, format, exportedAt, date }),
    });
  });
  updateHealth();
  return { async deactivate() { store.close(); } };
}
