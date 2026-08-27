const TIMESTAMP_FIELDS = ["publishedAt", "updatedAt", "createdAt", "timestamp", "collectedAt"];
const EXCERPT_FIELDS = ["excerpt", "description", "brief", "summary", "text"];

function text(value, fallback = "") {
  return String(value ?? fallback)
    .replace(/[\u0000-\u001f\u007f-\u009f]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function markdown(value) {
  return text(value)
    .replace(/\\/gu, "\\\\")
    .replace(/([`*_[\]<>#|~])/gu, "\\$1");
}

function url(value) {
  if (typeof value !== "string" || !value.trim()) return undefined;
  try {
    const parsed = new URL(value);
    if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) return undefined;
    const normalized = parsed.toString();
    return normalized.length <= 2_048 ? normalized : undefined;
  } catch {
    return undefined;
  }
}

function truncate(value, limit) {
  const normalized = text(value);
  return normalized.length > limit ? normalized.slice(0, Math.max(0, limit - 1)) + "…" : normalized;
}

function recordTime(record, collectedAt) {
  for (const field of TIMESTAMP_FIELDS) {
    const value = record?.fields?.[field];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return collectedAt ?? "Unknown";
}

function recordExcerpt(record) {
  for (const field of EXCERPT_FIELDS) {
    const value = record?.fields?.[field];
    if (typeof value === "string" && value.trim()) return truncate(value, 280);
  }
  return "";
}

function recordLines(plugin, record, index, collectedAt) {
  const lines = [
    "### " + (index + 1) + ". " + markdown(truncate(record.title, 240)),
    "- Source: " + markdown(truncate(plugin.name ?? plugin.pluginId, 160)),
    "- Time: " + markdown(truncate(recordTime(record, collectedAt), 80)),
  ];
  const link = url(record.url);
  if (link) lines.push("- Link: " + link);
  const excerpt = recordExcerpt(record);
  if (excerpt) lines.push("- Excerpt: " + markdown(excerpt));
  if (record.rank !== undefined) lines.push("- Rank: " + markdown(record.rank));
  for (const [key, value] of Object.entries(record.fields ?? {})) {
    if (TIMESTAMP_FIELDS.includes(key) || EXCERPT_FIELDS.includes(key) || value === undefined || value === null || value === "") continue;
    lines.push("- " + markdown(key) + ": " + markdown(truncate(value, 280)));
  }
  return lines;
}

export function renderFactsMarkdown(aggregate, selectedPluginIds = aggregate?.plugins?.map((plugin) => plugin.pluginId), {
  maxPerPlugin = 50,
  maxTotal = 200,
} = {}) {
  const selected = new Set(selectedPluginIds ?? []);
  const lines = [
    "# Infolens Daily Summary",
    "",
    "- Local date: " + markdown(aggregate?.localDate),
    "- Time zone: " + markdown(aggregate?.timeZone),
    "- Generated at: " + markdown(aggregate?.generatedAt),
  ];
  let total = 0;
  let omittedTotal = 0;
  for (const plugin of aggregate?.plugins ?? []) {
    if (!selected.has(plugin.pluginId)) continue;
    lines.push("", "## " + markdown(plugin.name ?? plugin.pluginId), "- Status: " + markdown(plugin.status));
    if (plugin.status !== "ready" || plugin.context?.state !== "ready") {
      lines.push("- " + (plugin.status === "no-data" ? "No qualifying data was collected for this local date." : "Daily Summary data is unavailable."));
      continue;
    }
    const records = Array.isArray(plugin.context.records) ? plugin.context.records : [];
    const available = Math.max(0, Math.min(records.length, maxPerPlugin, maxTotal - total));
    for (let index = 0; index < available; index += 1) {
      lines.push("", ...recordLines(plugin, records[index], total, plugin.context.collectedAt));
      total += 1;
    }
    const omitted = records.length - available;
    if (omitted > 0) {
      omittedTotal += omitted;
      lines.push("", "- " + omitted + " additional item(s) omitted by the email limit.");
    }
  }
  if (omittedTotal > 0) lines.push("", "- Total omitted items: " + omittedTotal + ".");
  return lines.join("\n") + "\n";
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function renderFactsHtml(markdownText) {
  return "<!doctype html><html><body><pre style=\"white-space:pre-wrap;font-family:system-ui,sans-serif\">"
    + escapeHtml(markdownText)
    + "</pre></body></html>";
}
