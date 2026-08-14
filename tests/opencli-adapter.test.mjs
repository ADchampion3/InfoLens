import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createOpenCliAdapter } from "../packages/plugin-runtime/src/opencli-adapter.mjs";

test("OpenCLI adapter owns browser lease options and keeps doctor probes backgrounded", async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "infolens-opencli-adapter-"));
  const executablePath = path.join(temporaryRoot, "fake-opencli.mjs");
  await writeFile(executablePath, `
const args = process.argv.slice(process.versions.electron ? 1 : 2);
if (args[0] === "doctor") {
  if (process.env.OPENCLI_WINDOW !== "background") process.exit(4);
  process.stdout.write([
    "opencli v1.8.6 doctor",
    "",
    "[OK] Daemon: running on port 19825 (v1.8.6)",
    "[OK] Extension: connected (v1.0.22)",
    "[OK] Connectivity: connected in 0.1s",
  ].join("\\n"));
} else if (args[0] === "daemon" && args[1] === "restart") {
  process.stdout.write("daemon restarted");
} else {
  process.stdout.write(JSON.stringify({ args }));
}
`, "utf8");

  try {
    const adapter = createOpenCliAdapter({ executablePath });
    const browserResult = await adapter.run(
      { command: ["fixture", "read"], strategy: "INTERCEPT" },
      ["--limit=3", "--window", "foreground", "--site-session=persistent", "--keep-tab", "true"],
    );
    assert.deepEqual(browserResult.args, [
      "fixture", "read", "--limit=3", "--window", "background", "--site-session", "ephemeral", "--keep-tab", "false", "-f", "json",
    ]);

    const doctor = await adapter.doctor();
    assert.equal(doctor.overall, "connected");
    const restarted = await adapter.restartDaemon();
    assert.equal(restarted.stdout, "daemon restarted");
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
