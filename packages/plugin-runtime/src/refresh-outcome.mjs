import { redactSensitiveText } from "./redaction.mjs";

const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u;
const MAX_MESSAGE_LENGTH = 240;

function timestamp(value, fallback) {
  if (typeof value !== "string" || !ISO_TIMESTAMP.test(value)) return fallback;
  const parsed = new Date(value);
  return Number.isNaN(parsed.valueOf()) ? fallback : parsed.toISOString();
}

function code(value, fallback) {
  if (typeof value !== "string" || !value.trim()) return fallback;
  const normalized = value.trim().replace(/[^A-Za-z0-9_.-]/gu, "_").slice(0, 80);
  return normalized || fallback;
}

export function shortRefreshMessage(value, fallback = "Plugin refresh failed") {
  const redacted = redactSensitiveText(typeof value === "string" ? value : String(value ?? fallback)).trim();
  if (!redacted) return fallback;
  return redacted.length > MAX_MESSAGE_LENGTH ? `${redacted.slice(0, MAX_MESSAGE_LENGTH - 1)}...` : redacted;
}

function failureDetails(value, fallbackCode = "REFRESH_FAILED") {
  const failure = value?.failure && typeof value.failure === "object" ? value.failure : undefined;
  const candidate = failure ?? value;
  return {
    code: code(candidate?.code ?? value?.error?.code, fallbackCode),
    message: shortRefreshMessage(candidate?.message ?? value?.lastError ?? value?.error?.message ?? (typeof value === "string" ? value : undefined)),
  };
}

function successTimestamp(value, completedAt) {
  return timestamp(value?.lastSuccessfulRefreshAt, timestamp(value?.lastSuccessfulRefresh, completedAt));
}

export function normalizeRefreshOutcome(value, { error, completedAt = new Date().toISOString() } = {}) {
  const at = timestamp(completedAt, new Date().toISOString());
  if (error) {
    if (error.code === "TASK_CANCELLED") {
      return {
        status: "cancelled",
        code: "TASK_CANCELLED",
        message: shortRefreshMessage(error.message, "Plugin refresh was cancelled"),
        timestamp: at,
        cancellationOutcome: typeof error.outcome === "string" ? error.outcome : "uncertain",
      };
    }
    const failure = failureDetails(error, "PLUGIN_ERROR");
    return { status: "failed", ...failure, timestamp: at };
  }

  const explicitStatus = typeof value?.status === "string" ? value.status.toLowerCase() : undefined;
  if (value?.ok === true || ["success", "succeeded", "completed"].includes(explicitStatus)) {
    return { status: "succeeded", timestamp: at, lastSuccessfulRefreshAt: successTimestamp(value, at) };
  }
  if (value?.ok === false || ["failure", "failed", "error"].includes(explicitStatus)) {
    return { status: "failed", ...failureDetails(value), timestamp: at };
  }

  // A legacy task result without an explicit flag is still a completed refresh.
  return { status: "succeeded", timestamp: at, lastSuccessfulRefreshAt: successTimestamp(value, at) };
}

export function normalizeTaskRefreshOutcome(type, details = {}) {
  if (details.task !== "refresh") return undefined;
  if (type === "task-completed") return normalizeRefreshOutcome(details.result);
  if (type === "task-failed") return normalizeRefreshOutcome(undefined, { error: details.error });
  if (type !== "task-cancelled") return undefined;
  const error = details.error && typeof details.error === "object"
    ? details.error
    : Object.assign(new Error("Plugin refresh was cancelled"), {
      code: "TASK_CANCELLED",
      outcome: details.outcome,
    });
  return normalizeRefreshOutcome(undefined, { error });
}
