export type DailySummaryPluginStatus = "ready" | "no-data" | "unavailable" | "unsupported" | "disabled";

export interface DailySummaryRecord {
  title: string;
  url?: string;
  rank?: number;
  read?: boolean;
  fields?: Record<string, string | number | boolean>;
}

export interface DailySummaryPlugin {
  pluginId: string;
  name: string;
  version?: string;
  enabled: boolean;
  active?: boolean;
  pluginState?: string;
  browserDependent: boolean;
  capability?: "supported" | "unsupported";
  status: DailySummaryPluginStatus;
  context?: {
    state: "ready" | "no-data" | "unavailable";
    collectedAt?: string;
    recordCount?: number;
    records?: DailySummaryRecord[];
  };
}

export interface DailySummaryAggregate {
  localDate: string;
  timeZone: string;
  generatedAt: string;
  plugins: DailySummaryPlugin[];
}

export interface DailySummaryPreview {
  key: string;
  markdown: string;
  selectedPluginIds: string[];
}

export interface DailySummaryDeliveryDecision {
  allowed: boolean;
  text?: string;
  filename?: string;
  requiresPrivacyConfirmation?: boolean;
  privacySources?: string[];
  reason?: "empty-selection" | "preview-required" | "preview-stale";
}

function stableSelection(aggregate: DailySummaryAggregate, selectedPluginIds: Iterable<string>) {
  const selected = new Set(selectedPluginIds);
  return aggregate.plugins
    .filter((plugin) => selected.has(plugin.pluginId) && isDailySummarySelectable(plugin))
    .map((plugin) => plugin.pluginId);
}

export function isDailySummarySelectable(plugin: Pick<DailySummaryPlugin, "enabled" | "status">) {
  return plugin.enabled && plugin.status !== "unsupported" && plugin.status !== "disabled";
}

export function defaultDailySummarySelection(aggregate: DailySummaryAggregate) {
  return new Set(aggregate.plugins.filter((plugin) => plugin.status === "ready" && isDailySummarySelectable(plugin)).map(({ pluginId }) => pluginId));
}

export function normalizeDailySummarySelection(aggregate: DailySummaryAggregate, selectedPluginIds: Iterable<string>) {
  return new Set(stableSelection(aggregate, selectedPluginIds));
}

export function toggleDailySummarySelection(aggregate: DailySummaryAggregate, selectedPluginIds: Iterable<string>, pluginId: string) {
  const next = normalizeDailySummarySelection(aggregate, selectedPluginIds);
  const plugin = aggregate.plugins.find((candidate) => candidate.pluginId === pluginId);
  if (!plugin || !isDailySummarySelectable(plugin)) return next;
  if (next.has(pluginId)) next.delete(pluginId);
  else next.add(pluginId);
  return normalizeDailySummarySelection(aggregate, next);
}

export function preserveDailySummarySelection(aggregate: DailySummaryAggregate, selectedPluginIds: Iterable<string>) {
  return normalizeDailySummarySelection(aggregate, selectedPluginIds);
}

function controlText(value: unknown) {
  return String(value ?? "")
    .replace(/[\u0000-\u001f\u007f-\u009f]/gu, " ")
    .replace(/\\/gu, "\\\\")
    .replace(/([`*_[\]<>#|~])/gu, "\\$1")
    .replace(/\s+/gu, " ")
    .trim();
}

export function escapeDailySummaryMarkdown(value: unknown) {
  return controlText(value);
}

function safeUrl(value: unknown) {
  if (typeof value !== "string" || !value.trim()) return undefined;
  try {
    const parsed = new URL(value);
    if (!(["http:", "https:"].includes(parsed.protocol)) || parsed.username || parsed.password) return undefined;
    return parsed.toString();
  } catch {
    return undefined;
  }
}

function renderUrl(value: unknown) {
  const url = safeUrl(value);
  if (!url) return value === undefined ? undefined : controlText(value);
  return `[${controlText(url)}](${encodeURI(url).replace(/[()\\]/gu, (character) => `%${character.charCodeAt(0).toString(16).padStart(2, "0")}`)})`;
}

function exactTime(value: unknown) {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) return "Unknown";
  return value;
}

export function dailySummaryRelativeAge(collectedAt: string | undefined, generatedAt: string) {
  const collected = Date.parse(collectedAt ?? "");
  const generated = Date.parse(generatedAt);
  if (!Number.isFinite(collected) || !Number.isFinite(generated)) return "Unknown";
  const minutes = Math.max(0, Math.round((generated - collected) / 60_000));
  if (minutes < 2) return "just now";
  if (minutes < 60) return `${minutes} minutes`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hours`;
  const days = Math.round(hours / 24);
  return `${days} ${days === 1 ? "day" : "days"}`;
}

export function dailySummarySourceMetadata(plugin: Pick<DailySummaryPlugin, "context">, generatedAt: string) {
  const declaredRecordCount = plugin.context?.recordCount;
  const recordCount = typeof declaredRecordCount === "number" && Number.isInteger(declaredRecordCount) && declaredRecordCount >= 0
    ? declaredRecordCount
    : Array.isArray(plugin.context?.records) ? plugin.context.records.length : 0;
  return {
    collectedAt: exactTime(plugin.context?.collectedAt),
    relativeAge: dailySummaryRelativeAge(plugin.context?.collectedAt, generatedAt),
    recordCount,
  };
}

function statusLabel(status: DailySummaryPluginStatus) {
  return ({ ready: "Ready", "no-data": "No data", unavailable: "Unavailable", unsupported: "Unsupported", disabled: "Disabled" } as Record<DailySummaryPluginStatus, string>)[status];
}

function renderRecord(record: DailySummaryRecord, index: number) {
  const lines = [`### Record ${index + 1}`, `- Title: ${controlText(record.title)}`];
  const url = renderUrl(record.url);
  if (url) lines.push(`- URL: ${url}`);
  if (record.rank !== undefined) lines.push(`- Rank: ${controlText(record.rank)}`);
  if (record.read !== undefined) lines.push(`- Read: ${record.read ? "read" : "unread"}`);
  for (const [label, value] of Object.entries(record.fields ?? {})) lines.push(`- ${controlText(label)}: ${controlText(value)}`);
  return lines.join("\n");
}

export function renderDailySummaryMarkdown(aggregate: DailySummaryAggregate, selectedPluginIds: Iterable<string>) {
  const selected = new Set(stableSelection(aggregate, selectedPluginIds));
  if (!selected.size) {
    const error = new Error("Select at least one Plugin for the Daily Summary preview");
    error.name = "DailySummaryEmptySelectionError";
    throw error;
  }
  const lines = [
    "# Infolens Daily Summary",
    "",
    `- Local date: ${controlText(aggregate.localDate)}`,
    `- Time zone: ${controlText(aggregate.timeZone)}`,
    `- Generated at: ${exactTime(aggregate.generatedAt)}`,
  ];
  for (const plugin of aggregate.plugins) {
    if (!selected.has(plugin.pluginId)) continue;
    lines.push("", `## ${controlText(plugin.name)}`, `- Status: ${statusLabel(plugin.status)}`);
    const { collectedAt, relativeAge, recordCount } = dailySummarySourceMetadata(plugin, aggregate.generatedAt);
    lines.push(
      `- Snapshot collected at: ${collectedAt}`,
      `- Relative age: ${relativeAge}`,
      `- Record count: ${recordCount}`,
    );
    if (plugin.status === "ready" && plugin.context?.state === "ready") {
      lines.push(
        `- Snapshot state: ${plugin.context.state}`,
      );
      for (const [index, record] of (plugin.context.records ?? []).entries()) lines.push("", renderRecord(record, index));
    } else if (plugin.status === "no-data") {
      lines.push(`- No qualifying Collection Snapshot exists for ${controlText(aggregate.localDate)}.`);
    } else {
      lines.push("- Daily Summary data is unavailable.");
    }
  }
  return `${lines.join("\n")}\n`;
}

function previewKey(aggregate: DailySummaryAggregate, selectedPluginIds: Iterable<string>) {
  return JSON.stringify({ aggregate, selectedPluginIds: stableSelection(aggregate, selectedPluginIds) });
}

export function createDailySummaryPreview(aggregate: DailySummaryAggregate, selectedPluginIds: Iterable<string>): DailySummaryPreview {
  const selected = stableSelection(aggregate, selectedPluginIds);
  if (!selected.length) {
    const error = new Error("Select at least one Plugin for the Daily Summary preview");
    error.name = "DailySummaryEmptySelectionError";
    throw error;
  }
  return { key: previewKey(aggregate, selected), markdown: renderDailySummaryMarkdown(aggregate, selected), selectedPluginIds: selected };
}

export function isDailySummaryPreviewCurrent(preview: DailySummaryPreview | undefined, aggregate: DailySummaryAggregate, selectedPluginIds: Iterable<string>) {
  return Boolean(preview && preview.key === previewKey(aggregate, selectedPluginIds));
}

export function dailySummaryFilename(localDate: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(localDate)) throw new Error("Daily Summary local date is invalid");
  const parsed = new Date(`${localDate}T00:00:00.000Z`);
  if (!Number.isFinite(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== localDate) throw new Error("Daily Summary local date is invalid");
  return `infolens-daily-summary-${localDate}.md`;
}

export function browserDependentDailySummarySources(aggregate: DailySummaryAggregate, selectedPluginIds: Iterable<string>) {
  const selected = new Set(stableSelection(aggregate, selectedPluginIds));
  return aggregate.plugins.filter((plugin) => selected.has(plugin.pluginId) && plugin.browserDependent).map(({ name }) => name);
}

export function dailySummaryDeliveryDecision({
  aggregate,
  selectedPluginIds,
  preview,
  acknowledgedPreviewKey,
}: {
  aggregate: DailySummaryAggregate;
  selectedPluginIds: Iterable<string>;
  preview?: DailySummaryPreview;
  acknowledgedPreviewKey?: string;
}): DailySummaryDeliveryDecision {
  const selected = stableSelection(aggregate, selectedPluginIds);
  if (!selected.length) return { allowed: false, reason: "empty-selection" };
  if (!preview) return { allowed: false, reason: "preview-required" };
  if (!isDailySummaryPreviewCurrent(preview, aggregate, selected)) return { allowed: false, reason: "preview-stale" };
  const privacySources = browserDependentDailySummarySources(aggregate, selected);
  if (privacySources.length && acknowledgedPreviewKey !== preview.key) {
    return { allowed: false, requiresPrivacyConfirmation: true, privacySources };
  }
  return { allowed: true, text: preview.markdown, filename: dailySummaryFilename(aggregate.localDate) };
}
