import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";
import { renderEvidenceMarkdown, safeEvidence, sprint8Plugins } from "../scripts/sprint8-evidence.mjs";
import { patchProductHuntHot } from "../scripts/apply-opencli-overrides.mjs";

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

test("Sprint 8 evidence covers every strategy and redacts authentication material", () => {
  assert.deepEqual(sprint8Plugins.map(({ strategy }) => strategy), ["PUBLIC", "PUBLIC", "COOKIE", "INTERCEPT"]);
  const evidence = safeEvidence({ cookie: "secret", profilePath: "C:\\Users\\person\\Chrome", failure: "token=abc" });
  assert.equal(evidence.cookie, "[REDACTED]");
  assert.equal(evidence.profilePath, "[REDACTED]");
  assert.doesNotMatch(evidence.failure, /abc|person/);
  const markdown = renderEvidenceMarkdown({ runId: "run", startedAt: "now", result: "Passed", browserBridge: { passed: true }, release: {}, plugins: sprint8Plugins.map((plugin) => ({ ...plugin, result: "Passed" })), lifecycle: {} });
  assert.match(markdown, /Hacker News/);
  assert.match(markdown, /INTERCEPT/);
});

test("Product Hunt override waits for real cards and applies idempotently", () => {
  const upstream = `import { pickVoteCount } from './utils.js';\ncli({\n    func: async (page) => {\n        await page.goto('https://www.producthunt.com');\n        await page.waitForCapture(5);\n    },\n});\n`;
  const patched = patchProductHuntHot(upstream);
  assert.match(patched, /async function waitForProductCards/);
  assert.match(patched, /await waitForProductCards\(page\)/);
  assert.doesNotMatch(patched, /waitForCapture/);
  assert.equal(patchProductHuntHot(patched), patched);
});
