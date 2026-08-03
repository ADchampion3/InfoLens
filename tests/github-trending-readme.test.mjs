import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { validateReadmeCollection } from "../plugins/github-trending/backend/index.js";
import { openStore } from "../plugins/github-trending/backend/storage.js";

const repository = {
  id: "octo/example",
  rank: 1,
  owner: "octo",
  name: "example",
  description: "Example",
  language: "JavaScript",
  languageColor: "#f1e05a",
  stars: 10,
  forks: 2,
  starsGained: 3,
  url: "https://github.com/octo/example",
};

test("GitHub README collection validates and normalizes the OpenCLI result", () => {
  const result = validateReadmeCollection([{ repositoryId: repository.id, html: '<article class="markdown-body"><h1>Example</h1></article>', sourceUrl: `${repository.url}#readme` }], repository);
  assert.match(result.html, /<h1>Example<\/h1>/);
  assert.equal(result.sourceUrl, "https://github.com/octo/example#readme");
});

test("GitHub README collection rejects mismatched and oversized content", () => {
  assert.throws(() => validateReadmeCollection([], repository), /must contain one row/);
  assert.throws(() => validateReadmeCollection([{ repositoryId: "other/repo", html: "x", sourceUrl: "https://github.com/other/repo" }], repository), /repositoryId/);
  assert.throws(() => validateReadmeCollection([{ repositoryId: repository.id, html: "x", sourceUrl: "https://example.com/readme" }], repository), /sourceUrl/);
  assert.throws(() => validateReadmeCollection([{ repositoryId: repository.id, html: "x".repeat(2 * 1024 * 1024 + 1), sourceUrl: `${repository.url}#readme` }], repository), /内容过大/);
});

test("GitHub plugin store migrates and persists README cache", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "infolens-github-readme-"));
  try {
    const store = openStore(path.join(temp, "github.sqlite"));
    assert.equal(store.schemaVersion(), 3);
    store.replace([repository], "2026-07-31T00:00:00.000Z");
    const readme = { repositoryId: repository.id, html: "<h1>Cached</h1>", fetchedAt: "2026-07-31T01:00:00.000Z", sourceUrl: `${repository.url}#readme` };
    store.saveReadme(readme);
    assert.deepEqual({ ...store.readme(repository.id) }, readme);
    assert.deepEqual({ ...store.repository(repository.id) }, { id: repository.id, owner: repository.owner, name: repository.name, url: repository.url });
    store.close();
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("GitHub workspace renders README without a nested srcdoc frame", async () => {
  const root = path.resolve(import.meta.dirname, "..");
  const html = await readFile(path.join(root, "plugins/github-trending/web/dist/index.html"), "utf8");
  const script = await readFile(path.join(root, "plugins/github-trending/web/dist/workspace.js"), "utf8");
  assert.match(html, /id="readme-content"/);
  assert.doesNotMatch(html, /id="readme-frame"|\bsrcdoc=/);
  assert.match(script, /new DOMParser\(\)/);
  assert.match(script, /content\.hidden = false/);
});
