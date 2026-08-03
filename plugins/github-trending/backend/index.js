import { openStore } from "./storage.js";
import { downloadableResponse } from "../../../packages/plugin-sdk/src/index.js";
import { createExport } from "./export.js";

const POLICIES = new Set(["manual", "disabled", "fixed"]);
const INTERVALS = new Set([15, 30, 60, 360, 720, 1440]);
const RETENTION_DAYS = new Set([7, 30, 90]);
const PERIODS = new Set(["daily", "weekly", "monthly"]);
const LANGUAGE_COLORS = { TypeScript: "#3178c6", JavaScript: "#f1e05a", Python: "#3572A5", Rust: "#dea584", Go: "#00ADD8", "C++": "#f34b7d" };
const README_CACHE_MS = 6 * 60 * 60 * 1000;
const MAX_README_BYTES = 2 * 1024 * 1024;

function requiredString(value, field) { if (typeof value !== "string" || !value.trim()) throw new Error(`GitHub Trending result has invalid ${field}`); return value; }
function nonNegative(value, field) { if (!Number.isInteger(value) || value < 0) throw new Error(`GitHub Trending result has invalid ${field}`); return value; }

export function validateCollection(result) {
  if (!Array.isArray(result) || result.length === 0) throw new Error("GitHub Trending OpenCLI result must contain rows");
  return result.map((repo, index) => {
    const id = requiredString(repo?.repo, `rows[${index}].repo`);
    const identity = id.match(/^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/);
    if (!identity) throw new Error(`GitHub Trending result has invalid rows[${index}].repo`);
    const language = typeof repo.language === "string" && repo.language ? repo.language : null;
    return {
      id, rank: nonNegative(repo.rank, `rows[${index}].rank`), owner: identity[1], name: identity[2],
      description: typeof repo.description === "string" ? repo.description : "", language,
      languageColor: language ? LANGUAGE_COLORS[language] ?? "#8b949e" : null,
      stars: nonNegative(repo.stars, `rows[${index}].stars`), forks: nonNegative(repo.forks, `rows[${index}].forks`),
      starsGained: nonNegative(repo.starsSince, `rows[${index}].starsSince`), url: requiredString(repo.url, `rows[${index}].url`),
    };
  });
}

export function validateReadmeCollection(result, repository) {
  if (!Array.isArray(result) || result.length !== 1) throw new Error("GitHub README OpenCLI result must contain one row");
  const row = result[0];
  if (row?.repositoryId !== repository.id) throw new Error("GitHub README result has an invalid repositoryId");
  const html = requiredString(row.html, "html");
  if (Buffer.byteLength(html, "utf8") > MAX_README_BYTES) throw new Error("README 内容过大，无法在插件中预览");
  const sourceUrl = `${repository.url}#readme`;
  if (row.sourceUrl !== sourceUrl) throw new Error("GitHub README result has an invalid sourceUrl");
  return {
    repositoryId: repository.id,
    html,
    fetchedAt: new Date().toISOString(),
    sourceUrl,
  };
}

export async function activate(context) {
  const store = openStore(context.resolveDataPath("github-trending.sqlite"));
  store.cleanupOnActivation();
  let cancelSchedule;
  const summary = () => ({ source: "GitHub Trending", repositories: store.list(), settings: store.settings(), view: store.view(), ...store.metadata() });
  const updateHealth = () => { const data = summary(); context.setHealth({ state: "ready", badge: String(data.repositories.filter((repo) => !repo.read).length), lastSuccessfulRefresh: data.lastSuccessfulRefresh }); };
  const configureSchedule = () => { cancelSchedule?.(); cancelSchedule = undefined; const settings = store.settings(); if (settings.policy === "fixed") cancelSchedule = context.schedule("refresh", { intervalMs: settings.intervalMinutes * 60_000, reason: "schedule" }); };
  context.task("refresh", async (_, task) => {
    try {
      const view = store.view();
      const args = [`--since=${view.period}`, "--limit=25"];
      if (view.language !== "all") args.push(`--language=${view.language.toLowerCase()}`);
      const repositories = validateCollection(await context.opencli.run("trendingRepositories", args, task.signal));
      store.replace(repositories, new Date().toISOString()); updateHealth(); return { ok: true, ...summary() };
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
  context.route("GET", "/readme", async ({ url }) => {
    const id = url.searchParams.get("id");
    const repository = store.repository(id);
    if (!repository) return { ok: false, error: "找不到该趋势仓库" };
    const cached = store.readme(id);
    const force = url.searchParams.get("refresh") === "true";
    if (!force && cached && Date.now() - Date.parse(cached.fetchedAt) < README_CACHE_MS) return { ok: true, cached: true, readme: cached };
    try {
      const readme = validateReadmeCollection(await context.opencli.run("repositoryReadme", [repository.id]), repository);
      store.saveReadme(readme);
      return { ok: true, cached: false, readme };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await context.logger.warn("readme-fetch-failed", { repositoryId: id, message });
      return cached ? { ok: true, cached: true, stale: true, warning: message, readme: cached } : { ok: false, error: message };
    }
  });
  context.route("GET", "/settings", () => store.settings());
  context.route("POST", "/settings", ({ url }) => { const policy=url.searchParams.get("policy"); const intervalMinutes=Number(url.searchParams.get("intervalMinutes") ?? 60); const retentionDays=Number(url.searchParams.get("retentionDays")??store.settings().retentionDays); if(!POLICIES.has(policy)||!INTERVALS.has(intervalMinutes)||!RETENTION_DAYS.has(retentionDays)) throw new Error("Unsupported refresh setting"); store.saveSettings({policy,intervalMinutes,retentionDays},{acknowledgeRetentionCleanup:url.searchParams.get("acknowledgeRetentionCleanup")==="true"}); configureSchedule(); return store.settings(); });
  context.route("POST", "/view", ({ url }) => { const period=url.searchParams.get("period"); const language=url.searchParams.get("language") ?? "all"; if(!PERIODS.has(period)||!/^[a-zA-Z0-9+#.-]{1,30}$|^all$/.test(language)) throw new Error("Unsupported GitHub Trending filter"); store.saveView({period,language}); return summary(); });
  context.route("GET", "/history", ({url}) => store.snapshots({limit:url.searchParams.get("limit"),offset:url.searchParams.get("offset")}));
  context.route("GET", "/history/snapshot", ({url}) => store.snapshot(url.searchParams.get("id"))??{error:"Snapshot not found"});
  context.route("GET", "/export", ({ url }) => {
    const format = url.searchParams.get("format") ?? "json";
    const exportedAt = new Date().toISOString();
    return downloadableResponse({
      filenameBase: `github-trending-history-${exportedAt.slice(0, 10)}`,
      format,
      body: createExport(context.resolveDataPath("github-trending.sqlite"), { pluginId: "github-trending", pluginVersion: "0.3.0", format, exportedAt }),
    });
  });
  configureSchedule(); updateHealth();
  return { async deactivate() { cancelSchedule?.(); store.close(); } };
}
