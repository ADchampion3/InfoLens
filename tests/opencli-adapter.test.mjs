import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createOpenCliAdapter } from "../packages/plugin-runtime/src/opencli-adapter.mjs";

test("OpenCLI adapter owns browser lease options and keeps doctor probes backgrounded", async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "infolens-opencli-adapter-"));
  const executablePath = path.join(temporaryRoot, "fake-opencli.mjs");
  const doctorWindowStatePath = path.join(temporaryRoot, "doctor-window.state");
  await writeFile(executablePath, `
import { writeFileSync } from "node:fs";

const args = process.argv.slice(process.versions.electron ? 1 : 2);
if (args[0] === "doctor") {
  if (process.env.OPENCLI_WINDOW !== "background") process.exit(4);
  writeFileSync(${JSON.stringify(doctorWindowStatePath)}, "open");
  process.stdout.write([
    "opencli v1.8.6 doctor",
    "",
    "[OK] Daemon: running on port 19825 (v1.8.6)",
    "[OK] Extension: connected (v1.0.22)",
    "[OK] Connectivity: connected in 0.1s",
  ].join("\\n"));
} else if (args[0] === "browser" && args[1] === "__doctor__" && args[2] === "close") {
  writeFileSync(${JSON.stringify(doctorWindowStatePath)}, "closed");
  process.stdout.write("closed");
} else if (args[0] === "daemon" && args[1] === "restart") {
  process.stdout.write("daemon restarted");
} else if (args[0] === "oversized") {
  process.stdout.write("x".repeat(17 * 1024 * 1024));
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
    assert.equal(await readFile(doctorWindowStatePath, "utf8"), "closed");
    const restarted = await adapter.restartDaemon();
    assert.equal(restarted.stdout, "daemon restarted");
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("OpenCLI adapter terminates a child that exceeds the output capture limit", async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "infolens-opencli-output-limit-"));
  const executablePath = path.join(temporaryRoot, "fake-opencli.mjs");
  await writeFile(executablePath, `process.stdout.write("x".repeat(17 * 1024 * 1024));\n`, "utf8");
  try {
    const adapter = createOpenCliAdapter({ executablePath });
    await assert.rejects(
      adapter.run({ command: ["oversized"], strategy: "PUBLIC" }),
      (error) => error?.code === "OPENCLI_OUTPUT_TOO_LARGE",
    );
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
