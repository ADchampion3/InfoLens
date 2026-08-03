import { cli, Strategy } from "@jackwener/opencli/registry";
import { ArgumentError, CommandExecutionError, EmptyResultError } from "@jackwener/opencli/errors";

const REPOSITORY_ID = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

cli({
  site: "infolens-github",
  name: "readme",
  access: "read",
  description: "Rendered README for one public GitHub repository",
  domain: "api.github.com",
  strategy: Strategy.PUBLIC,
  browser: false,
  args: [{ name: "repository", type: "string", required: true, positional: true, help: "Repository owner/name" }],
  columns: ["repositoryId", "html", "sourceUrl"],
  func: async (args) => {
    const repositoryId = String(args.repository ?? "").trim();
    if (!REPOSITORY_ID.test(repositoryId)) throw new ArgumentError("repository must use owner/name format");
    const [owner, name] = repositoryId.split("/");
    const endpoint = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/readme`;
    let response;
    try {
      response = await fetch(endpoint, {
        headers: {
          Accept: "application/vnd.github.html+json",
          "User-Agent": "Infolens-GitHub-Trending",
          "X-GitHub-Api-Version": "2022-11-28",
        },
      });
    } catch (error) {
      throw new CommandExecutionError(`GitHub README request failed: ${error?.message || error}`);
    }
    if (response.status === 404) throw new EmptyResultError("infolens-github readme", `${repositoryId} has no README`);
    if (!response.ok) throw new CommandExecutionError(`GitHub README request failed: HTTP ${response.status}`);
    let html = await response.text();
    if (html.startsWith('"')) {
      try { html = JSON.parse(html); } catch { /* GitHub normally returns raw rendered HTML. */ }
    }
    if (typeof html !== "string" || !html.trim()) throw new CommandExecutionError("GitHub returned an empty README response");
    return [{ repositoryId, html, sourceUrl: `https://github.com/${repositoryId}#readme` }];
  },
});
