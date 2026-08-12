import assert from "node:assert/strict";
import { test } from "node:test";
import { runTrendingRepositories } from "../plugins/github-trending/backend/index.js";

const rows = [{
  rank: 1,
  repo: "octo/example",
  description: "Example",
  language: "JavaScript",
  stars: 10,
  forks: 2,
  starsSince: 3,
  url: "https://github.com/octo/example",
}];

test("GitHub Trending retries one transient OpenCLI network failure", async () => {
  const calls = [];
  const result = await runTrendingRepositories({
    run: async (...args) => {
      calls.push(args);
      if (calls.length === 1) throw Object.assign(new Error("Bundled OpenCLI exited with code 1: read ECONNRESET"), { code: "OPENCLI_FAILED" });
      return rows;
    },
  }, ["--since=daily", "--limit=25"], new AbortController().signal);

  assert.deepEqual(result, rows);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].slice(0, 2), ["trendingRepositories", ["--since=daily", "--limit=25"]]);
});

test("GitHub Trending does not retry non-transient OpenCLI failures", async () => {
  let calls = 0;
  const error = Object.assign(new Error("The source login is required"), { code: "SITE_LOGIN_REQUIRED" });

  await assert.rejects(
    () => runTrendingRepositories({ run: async () => { calls += 1; throw error; } }, [], new AbortController().signal),
    error,
  );
  assert.equal(calls, 1);
});

test("GitHub Trending does not retry parser failures that mention no network cause", async () => {
  let calls = 0;
  const error = Object.assign(new Error("github-trending parser drift: no repository rows found"), { code: "OPENCLI_FAILED" });

  await assert.rejects(
    () => runTrendingRepositories({ run: async () => { calls += 1; throw error; } }, [], new AbortController().signal),
    error,
  );
  assert.equal(calls, 1);
});
