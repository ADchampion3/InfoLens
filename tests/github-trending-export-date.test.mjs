import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createExport, normalizeExportDate } from "../plugins/github-trending/backend/export.js";
import { openStore } from "../plugins/github-trending/backend/storage.js";

const firstRepository = {
  id: "first/repository",
  rank: 1,
  owner: "first",
  name: "repository",
  description: "First snapshot",
  language: "JavaScript",
  languageColor: "#f1e05a",
  stars: 10,
  forks: 2,
  starsGained: 3,
  url: "https://github.com/first/repository",
};
const secondRepository = {
  id: "second/repository",
  rank: 1,
  owner: "second",
  name: "repository",
  description: "Second snapshot",
  language: "Rust",
  languageColor: "#dea584",
  stars: 20,
  forks: 4,
  starsGained: 5,
  url: "https://github.com/second/repository",
};

test("GitHub Trending export can preview one retained calendar date", async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "infolens-github-export-date-"));
  const filename = path.join(temporaryRoot, "github-trending.sqlite");
  const store = openStore(filename);
  try {
    store.replace([firstRepository], "2026-08-01T09:00:00.000Z");
    store.replace([secondRepository], "2026-08-02T09:00:00.000Z");
    store.markRead(firstRepository.id, true);
    store.markRead(secondRepository.id, false);

    assert.deepEqual(store.snapshotDates().map((item) => ({ ...item })), [
      { date: "2026-08-02", snapshotCount: 1 },
      { date: "2026-08-01", snapshotCount: 1 },
    ]);
    assert.equal(normalizeExportDate("2026-02-28"), "2026-02-28");
    assert.throws(() => normalizeExportDate("2026-02-30"), /invalid/u);
    assert.throws(() => normalizeExportDate("2026/08/01"), /YYYY-MM-DD/u);

    for (const format of ["json", "csv", "markdown", "text"]) {
      const output = [...createExport(filename, {
        pluginId: "github-trending",
        pluginVersion: "0.3.0",
        format,
        exportedAt: "2026-08-03T00:00:00.000Z",
        date: "2026-08-01",
      })].join("");
      assert.match(output, /first\/repository/u, `${format} includes the selected date`);
      assert.doesNotMatch(output, /second\/repository/u, `${format} excludes other dates`);
      if (format === "json") {
        const envelope = JSON.parse(output);
        assert.equal(envelope.snapshots.length, 1);
        assert.deepEqual(Object.keys(envelope.userState), [firstRepository.id]);
        assert.equal(envelope.userState[firstRepository.id].read, true);
      }
    }
  } finally {
    store.close();
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
