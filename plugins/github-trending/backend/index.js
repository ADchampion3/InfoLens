import { openStore } from "./storage.js";

const POLICIES = new Set(["manual", "disabled", "fixed"]);
const INTERVALS = new Set([15, 30, 60, 360, 720, 1440]);
const PERIODS = new Set(["daily", "weekly", "monthly"]);
const LANGUAGE_COLORS = { TypeScript: "#3178c6", JavaScript: "#f1e05a", Python: "#3572A5", Rust: "#dea584", Go: "#00ADD8", "C++": "#f34b7d" };

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

export async function activate(context) {
  const store = openStore(context.resolveDataPath("github-trending.sqlite"));
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
  context.route("GET", "/settings", () => store.settings());
  context.route("POST", "/settings", ({ url }) => { const policy=url.searchParams.get("policy"); const intervalMinutes=Number(url.searchParams.get("intervalMinutes") ?? 60); if(!POLICIES.has(policy)||!INTERVALS.has(intervalMinutes)) throw new Error("Unsupported refresh setting"); store.saveSettings({policy,intervalMinutes}); configureSchedule(); return store.settings(); });
  context.route("POST", "/view", ({ url }) => { const period=url.searchParams.get("period"); const language=url.searchParams.get("language") ?? "all"; if(!PERIODS.has(period)||!/^[a-zA-Z0-9+#.-]{1,30}$|^all$/.test(language)) throw new Error("Unsupported GitHub Trending filter"); store.saveView({period,language}); return summary(); });
  configureSchedule(); updateHealth();
  return { async deactivate() { cancelSchedule?.(); store.close(); } };
}
