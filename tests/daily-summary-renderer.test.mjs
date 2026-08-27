import assert from "node:assert/strict";
import { test } from "node:test";
import { renderFactsHtml, renderFactsMarkdown } from "../packages/plugin-runtime/src/daily-summary-renderer.mjs";

test("Daily Summary email facts are bounded and escaped", () => {
  const aggregate = {
    localDate: "2026-08-26",
    timeZone: "Asia/Shanghai",
    generatedAt: "2026-08-27T00:00:00.000Z",
    plugins: [{
      pluginId: "fixture",
      name: "Fixture <source>",
      status: "ready",
      context: {
        state: "ready",
        collectedAt: "2026-08-26T08:00:00.000Z",
        records: [
          { title: "<script>alert(1)</script>", url: "javascript:alert(1)", rank: 0, fields: { excerpt: "first" } },
          { title: "Second", rank: 1, fields: { value: "second" } },
        ],
      },
    }],
  };
  const markdown = renderFactsMarkdown(aggregate, ["fixture"], { maxPerPlugin: 1, maxTotal: 1 });
  assert.match(markdown, /\\<script\\>alert\(1\)\\<\/script\\>/u);
  assert.doesNotMatch(markdown, /javascript:/u);
  assert.match(markdown, /additional item\(s\) omitted/u);
  const html = renderFactsHtml(markdown);
  assert.doesNotMatch(html, /<script>/iu);
  assert.match(html, /&lt;script\\&gt;/u);
});
