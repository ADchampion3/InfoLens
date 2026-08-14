export async function activate(context) {
  context.route("GET", "/ok", async () => ({ healthy: true }));
  return { async deactivate() { throw new Error("fixture cleanup exploded"); } };
}
