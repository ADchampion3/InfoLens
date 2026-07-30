import { cli, Strategy } from "@jackwener/opencli/registry";
import { CliError } from "@jackwener/opencli/errors";

function pickVoteCount(candidates) {
  const scored = candidates
    .map((candidate) => {
      const text = String(candidate.text ?? "").trim();
      if (!/^\d+$/.test(text) || candidate.inReviewLink) return null;
      const value = Number.parseInt(text, 10);
      if (!Number.isFinite(value) || value <= 0) return null;
      const signal = `${candidate.tagName ?? ""} ${candidate.className ?? ""} ${candidate.role ?? ""}`.toLowerCase();
      let score = candidate.inButton ? 4 : 0;
      if (signal.includes("vote") || signal.includes("upvote")) score += 3;
      if (signal.includes("button")) score += 1;
      return { text, score, value };
    })
    .filter(Boolean)
    .sort((left, right) => right.score - left.score || right.value - left.value || left.text.localeCompare(right.text));
  return scored[0]?.text ?? "";
}

async function waitForProductCards(page, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ready = await page.evaluate(`Boolean(document.querySelector('a[href^="/products/"]'))`).catch(() => false);
    if (ready) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new CliError("NO_DATA", "Product Hunt did not finish loading top posts", "Complete any Product Hunt security verification in the connected browser, then retry");
}

cli({
  site: "infolens-producthunt",
  name: "today",
  access: "read",
  description: "Today's top Product Hunt launches with vote counts",
  domain: "www.producthunt.com",
  strategy: Strategy.INTERCEPT,
  args: [{ name: "limit", type: "int", default: 20, help: "Number of results (max 50)" }],
  columns: ["rank", "name", "votes", "url"],
  func: async (page, args) => {
    const count = Math.min(Number(args.limit) || 20, 50);
    await page.installInterceptor("producthunt.com");
    await page.goto("https://www.producthunt.com");
    await waitForProductCards(page);
    const domItems = await page.evaluate(`
      (() => {
        const seen = new Set();
        const results = [];
        const links = Array.from(document.querySelectorAll('a[href^="/products/"]')).filter((element) => {
          const href = element.getAttribute('href') || '';
          const text = element.textContent?.trim() || '';
          return href && !href.includes('/reviews') && text.length > 0 && text.length < 120;
        });
        const normalizeName = (text) => text
          .replace(/^\\d+\\.\\s*/, '')
          .replace(/\\s*Launched\\s+this\\s+(month|week|year|day)\\s*/gi, '')
          .replace(/\\s*Featured\\s*/gi, '')
          .trim();
        for (const link of links) {
          const href = link.getAttribute('href') || '';
          if (!href || seen.has(href)) continue;
          let card = link;
          let node = link.parentElement;
          for (let index = 0; index < 6 && node; index += 1) {
            const hasReviewLink = Boolean(node.querySelector('a[href="' + href + '/reviews"]'));
            const hasNumericNode = Array.from(node.querySelectorAll('button, [role="button"], p, span, div'))
              .some((element) => /^\\d+$/.test(element.textContent?.trim() || ''));
            if (hasReviewLink || hasNumericNode) { card = node; break; }
            node = node.parentElement;
          }
          const name = normalizeName(link.textContent?.trim() || '');
          if (!name) continue;
          const voteCandidates = Array.from(card.querySelectorAll('button, [role="button"], a, p, span, div'))
            .map((element) => ({
              text: element.textContent?.trim() || '',
              tagName: element.tagName,
              className: element.className || '',
              role: element.getAttribute('role') || '',
              inButton: Boolean(element.closest('button, [role="button"]')),
              inReviewLink: Boolean(element.closest('a[href="' + href + '/reviews"]')),
            }))
            .filter((candidate) => /^\\d+$/.test(candidate.text));
          if (voteCandidates.length === 0) continue;
          seen.add(href);
          results.push({ name, voteCandidates, url: 'https://www.producthunt.com' + href });
        }
        return results;
      })()
    `);
    if (!Array.isArray(domItems) || domItems.length === 0) {
      throw new CliError("NO_DATA", "Could not retrieve Product Hunt top posts", "Product Hunt may have changed its layout");
    }
    const ranked = domItems
      .map((item) => ({ name: item.name, url: item.url, votes: pickVoteCount(item.voteCandidates ?? []) }))
      .filter((item) => item.name && item.url && item.votes)
      .sort((left, right) => Number.parseInt(right.votes, 10) - Number.parseInt(left.votes, 10));
    if (ranked.length === 0) throw new CliError("NO_DATA", "Could not retrieve Product Hunt vote counts", "Product Hunt may have changed its vote button structure");
    return ranked.slice(0, count).map((item, index) => ({ rank: index + 1, ...item }));
  },
});
