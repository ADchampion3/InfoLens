export async function activate(context) {
  context.setHealth({ state: "ready", badge: "New" });
  context.route("GET", "/summary", () => ({ title: "Reading Notes", message: "This compatible local package is running through Plugin Runtime." }));
  await context.logger.info("reading-notes-activated");
  return { async deactivate() { await context.logger.info("reading-notes-deactivated"); } };
}
