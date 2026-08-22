import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { renderEvidenceMarkdown, safeEvidence, releasePlugins } from "../scripts/release-evidence.mjs";
import { applyOpenCliOverrides, patchOpenCliDiscovery } from "../scripts/apply-opencli-overrides.mjs";

const require = createRequire(import.meta.url);
const { firstHttpProxy, runtimeProxyEnvironment } = require("../apps/desktop/runtime-network.cjs");

test("Runtime enables Node environment proxy support without overriding explicit configuration", () => {
  assert.equal(firstHttpProxy("DIRECT; PROXY 127.0.0.1:7890"), "127.0.0.1:7890");
  assert.deepEqual(runtimeProxyEnvironment({}, "PROXY 127.0.0.1:7890"), {
    NODE_USE_ENV_PROXY: "1", HTTPS_PROXY: "http://127.0.0.1:7890", HTTP_PROXY: "http://127.0.0.1:7890",
  });
  assert.deepEqual(runtimeProxyEnvironment({ HTTPS_PROXY: "http://explicit:8080" }, "PROXY ignored:1"), { NODE_USE_ENV_PROXY: "1" });
  assert.deepEqual(runtimeProxyEnvironment({}, "DIRECT"), {});
});

test("Release evidence covers every strategy and redacts authentication material", () => {
  assert.deepEqual(releasePlugins.map(({ strategy }) => strategy), ["PUBLIC", "PUBLIC", "PUBLIC", "COOKIE", "INTERCEPT"]);
  const evidence = safeEvidence({ cookie: "secret", profilePath: "C:\\Users\\person\\Chrome", failure: "token=abc" });
  assert.equal(evidence.cookie, "[REDACTED]");
  assert.equal(evidence.profilePath, "[REDACTED]");
  assert.doesNotMatch(evidence.failure, /abc|person/);
  const markdown = renderEvidenceMarkdown({ runId: "run", startedAt: "now", result: "Passed", browserBridge: { passed: true }, release: {}, plugins: releasePlugins.map((plugin) => ({ ...plugin, result: "Passed" })), lifecycle: {} });
  assert.match(markdown, /Hacker News/);
  assert.match(markdown, /INTERCEPT/);
});

test("Product Hunt ships a portable provided adapter and OpenCLI discovery patch is idempotent", async () => {
  const adapter = await readFile(new URL("../plugins/product-hunt/opencli-adapters/producthunt/today.js", import.meta.url), "utf8");
  assert.match(adapter, /site: "infolens-producthunt"/);
  assert.match(adapter, /name: "today"/);
  assert.match(adapter, /await waitForProductCards\(page\)/);
  const upstream = `/**\n * Flat scan: read ts/js files directly in a plugin directory.\n */`;
  const patched = patchOpenCliDiscovery(upstream);
  assert.match(patched, /discoverPluginPaths/);
  assert.equal(patchOpenCliDiscovery(patched), patched);
});

test("OpenCLI overrides reject an unpinned package version before patching source", async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "infolens-opencli-version-"));
  try {
    const wrapperRoot = path.join(temporaryRoot, "resources", "opencli");
    await mkdir(wrapperRoot, { recursive: true });
    await writeFile(path.join(wrapperRoot, "package.json"), JSON.stringify({
      name: "@infolens/bundled-opencli",
      version: "1.8.6",
      dependencies: { "@jackwener/opencli": "1.8.6" },
    }));
    const packageRoot = path.join(temporaryRoot, "resources", "opencli", "node_modules", "@jackwener", "opencli");
    await mkdir(packageRoot, { recursive: true });
    await writeFile(path.join(packageRoot, "package.json"), JSON.stringify({ name: "@jackwener/opencli", version: "1.8.7" }));
    await assert.rejects(
      applyOpenCliOverrides(temporaryRoot),
      /requires @jackwener\/opencli 1\.8\.6; found @jackwener\/opencli 1\.8\.7/,
    );
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
