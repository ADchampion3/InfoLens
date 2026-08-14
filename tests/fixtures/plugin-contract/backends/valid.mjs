let executions = 0;

export async function activate(context) {
  const required = ["pluginId", "dataDir", "resolveDataPath", "route", "task", "enqueue", "schedule", "setHealth", "logger", "opencli"];
  const missing = required.filter((key) => context[key] === undefined);
  if (missing.length) throw new Error(`SDK context is missing: ${missing.join(", ")}`);

  context.task("refresh", async (input) => {
    executions += 1;
    await new Promise((resolve) => setTimeout(resolve, 75));
    return { executions, input };
  });
  const cancelSchedule = context.schedule("refresh", { intervalMs: 60_000, input: { scheduled: true } });
  context.route("GET", "/context", async () => ({
    pluginId: context.pluginId,
    dataDir: context.dataDir,
    resolvedDataPath: context.resolveDataPath("store.sqlite"),
    hasLogger: typeof context.logger.info === "function",
  }));
  context.route("GET", "/coalesce", async () => {
    const first = context.enqueue("refresh", { request: 1 }, { reason: "acceptance" });
    const second = context.enqueue("refresh", { request: 2 }, { reason: "acceptance" });
    return { samePromise: first === second, results: await Promise.all([first, second]), executions };
  });
  context.route("GET", "/opencli", async () => context.opencli.run("fixtureRead", ["--limit", "2"]));
  context.route("GET", "/undeclared", async () => context.opencli.run("notDeclared"));
  context.task("explode", async () => { throw new Error("fixture task exploded"); });
  context.route("GET", "/task-fail", async () => context.enqueue("explode", null, { reason: "acceptance" }));
  context.route("GET", "/log", async () => {
    for (let index = 0; index < 20; index += 1) await context.logger.info("fixture-log", { index });
    return { logged: 20 };
  });
  context.setHealth({ state: "ready", badge: "SDK" });
  await context.logger.info("fixture-activated");
  return {
    async deactivate() {
      cancelSchedule();
      await context.logger.info("fixture-cleanup");
    },
  };
}
