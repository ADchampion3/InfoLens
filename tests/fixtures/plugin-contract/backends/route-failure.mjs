export async function activate(context) {
  context.route("GET", "/fail", async () => { throw new Error("fixture route exploded"); });
  context.route("GET", "/ok", async () => ({ healthy: true }));
  return {};
}
