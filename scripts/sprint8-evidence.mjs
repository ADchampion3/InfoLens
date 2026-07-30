import { redactSensitiveValue } from "../packages/plugin-runtime/src/redaction.mjs";

export const sprint8Plugins = [
  { id: "hn", name: "Hacker News", strategy: "PUBLIC", command: "hackernews top", field: "stories", rowSelector: ".story-row", database: "hacker-news.sqlite" },
  { id: "github-trending", name: "GitHub Trending", strategy: "PUBLIC", command: "github-trending repos", field: "repositories", rowSelector: ".repo-row", database: "github-trending.sqlite" },
  { id: "zhihu-hot", name: "Zhihu Hot List", strategy: "COOKIE", command: "zhihu whoami + zhihu hot", field: "questions", rowSelector: ".question-row", database: "zhihu-hot.sqlite" },
  { id: "product-hunt", name: "Product Hunt", strategy: "INTERCEPT", command: "producthunt hot", field: "products", rowSelector: ".product", database: "product-hunt.sqlite" },
];

export function safeEvidence(value) {
  return redactSensitiveValue(value);
}

export function renderEvidenceMarkdown(evidence) {
  const state = (value) => value === true ? "Passed" : value === false ? "Failed" : "Not run";
  const rows = evidence.plugins.map((plugin) =>
    `| ${plugin.name} | \`${plugin.strategy}\` | \`${plugin.command}\` | ${plugin.recordCount ?? 0} | ${plugin.workspaceRows ?? 0} | ${state(plugin.persistedAfterRestart)} | ${plugin.result} |`,
  );
  return `# Sprint 8 Real-Source Evidence

- Run: \`${evidence.runId}\`
- Started: ${evidence.startedAt}
- Finished: ${evidence.finishedAt ?? "Incomplete"}
- Release: Infolens ${evidence.release?.version ?? "unknown"}, Electron ${evidence.release?.electronVersion ?? "unknown"}, OpenCLI ${evidence.release?.openCli?.version ?? "unknown"}
- Browser Bridge preflight: ${evidence.browserBridge?.passed ? "Passed" : "Failed"}
- Overall result: **${evidence.result}**

| Plugin | Strategy | Declared command | Persisted rows | Rendered rows | Restart retention | Result |
| --- | --- | --- | ---: | ---: | --- | --- |
${rows.join("\n")}

## Lifecycle Evidence

- Runtime recovery retained all official plugin records: ${state(evidence.lifecycle?.runtimeRecovery)}
- Application shutdown completed: ${state(evidence.lifecycle?.shutdown)}
- Fresh profile: ${state(evidence.lifecycle?.cleanStart)}

## Failure

${evidence.failure ? `\`${evidence.failure.code}\`: ${evidence.failure.message}` : "None."}

Screenshots and the redacted JSON record are stored beside this file. No raw command payloads, cookies, authentication records, or browser profile details are retained.
`;
}
