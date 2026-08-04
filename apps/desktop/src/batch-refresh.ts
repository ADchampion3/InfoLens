export interface BatchEligibility {
  eligible: boolean;
  reason?: string;
  warning?: string;
}

export interface BatchCompletionNotice {
  batchId: string;
  actionLabel: string;
  message: string;
}

const TERMINAL_BATCH_STATUSES = new Set(["succeeded", "partial", "failed", "skipped", "interrupted"]);

function completionLabel(status: string) {
  return ({ succeeded: "completed", partial: "partially completed", failed: "failed", skipped: "skipped", interrupted: "interrupted" } as Record<string, string>)[status] ?? status;
}

export function batchCompletionNotice(
  batch: Pick<BatchSummary, "batchId" | "status" | "counts">,
  observedBatchIds: Set<string>,
  notifiedBatchIds: Set<string>,
): BatchCompletionNotice | undefined {
  if (!TERMINAL_BATCH_STATUSES.has(batch.status)) {
    observedBatchIds.add(batch.batchId);
    return undefined;
  }
  if (!observedBatchIds.has(batch.batchId) || notifiedBatchIds.has(batch.batchId)) return undefined;
  notifiedBatchIds.add(batch.batchId);
  return {
    batchId: batch.batchId,
    actionLabel: "View results",
    message: `Batch refresh ${completionLabel(batch.status)}: ${batch.counts.succeeded} succeeded, ${batch.counts.failed} failed, ${batch.counts.skipped} skipped, ${batch.counts.interrupted} interrupted`,
  };
}

function validDate(value: unknown) {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const datePart = value.slice(0, 10);
  const match = datePart.match(/^(\d{4})-(\d{2})-(\d{2})$/u);
  if (!match || !value.includes("T")) return undefined;
  const probe = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  if (probe.getUTCFullYear() !== Number(match[1]) || probe.getUTCMonth() !== Number(match[2]) - 1 || probe.getUTCDate() !== Number(match[3])) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? undefined : date;
}

export function localDayKey(value: string | Date | undefined, timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone) {
  const date = value instanceof Date ? (Number.isNaN(value.valueOf()) ? undefined : value) : validDate(value);
  if (!date) return undefined;
  const parts = new Intl.DateTimeFormat("en", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(date);
  const fields = Object.fromEntries(parts.filter(({ type }) => ["year", "month", "day"].includes(type)).map(({ type, value: part }) => [type, part]));
  return `${fields.year}-${fields.month}-${fields.day}`;
}

export function isToday(value: string | undefined, now = new Date(), timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone) {
  const today = localDayKey(now, timeZone);
  const candidate = localDayKey(value, timeZone);
  return Boolean(today && candidate && today === candidate);
}

export function targetEligibility(target: BatchTarget): BatchEligibility {
  if (!target.enabled || target.state === "disabled") return { eligible: false, reason: "Disabled" };
  if (target.state === "unavailable") return { eligible: false, reason: target.reason ?? "Unavailable" };
  if (["queued", "refreshing"].includes(target.state)) return { eligible: false, reason: "Already refreshing" };
  if (target.state === "starting") return { eligible: false, reason: "Starting" };
  if (target.failure || target.state === "failed") return { eligible: true, warning: "Latest refresh failed; retry is available" };
  if (target.dependencyWarning || target.dependencyState === "unknown") return { eligible: true, warning: "Browser dependency state is unknown" };
  return target.eligible ? { eligible: true } : { eligible: false, reason: target.reason ?? "Unavailable" };
}

export function selectAllEligible(targets: BatchTarget[]) {
  return new Set(targets.filter((target) => targetEligibility(target).eligible).map(({ pluginId }) => pluginId));
}

export function selectNotRefreshedToday(targets: BatchTarget[], now = new Date(), timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone) {
  return new Set(targets.filter((target) => {
    if (!targetEligibility(target).eligible) return false;
    if (isToday(target.failure?.timestamp, now, timeZone)) return true;
    return !isToday(target.lastSuccessfulRefreshAt, now, timeZone);
  }).map(({ pluginId }) => pluginId));
}

export function hasExecutableSelection(targets: BatchTarget[], selected: Set<string>) {
  return targets.some((target) => selected.has(target.pluginId) && targetEligibility(target).eligible);
}

export function exactLocalTime(value: string | undefined) {
  const date = validDate(value);
  return date ? new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date) : "Unknown time";
}

export function freshnessLabel(target: Pick<BatchTarget, "lastSuccessfulRefreshAt" | "failure">, now = new Date(), timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone) {
  const success = validDate(target.lastSuccessfulRefreshAt);
  if (!success) return target.failure ? "Refresh failed; no successful refresh recorded" : "Not refreshed yet";
  if (target.failure && isToday(target.failure.timestamp, now, timeZone)) return `Refresh failed today; last success ${exactLocalTime(target.lastSuccessfulRefreshAt)}`;
  const deltaMinutes = Math.round((now.valueOf() - success.valueOf()) / 60_000);
  if (deltaMinutes < 2) return "Refreshed just now";
  if (deltaMinutes < 60) return `Refreshed ${deltaMinutes} minutes ago`;
  const deltaHours = Math.round(deltaMinutes / 60);
  if (deltaHours < 24) return `Refreshed ${deltaHours} hours ago`;
  const deltaDays = Math.round(deltaHours / 24);
  return `Refreshed ${deltaDays} ${deltaDays === 1 ? "day" : "days"} ago`;
}

export function selectionEmptyState(targets: BatchTarget[], now = new Date(), timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone) {
  const eligible = targets.filter((target) => targetEligibility(target).eligible);
  if (!eligible.length) return "Nothing is currently executable";
  return selectNotRefreshedToday(targets, now, timeZone).size ? "Select a Workspace to refresh" : "All executable Workspaces refreshed today";
}
