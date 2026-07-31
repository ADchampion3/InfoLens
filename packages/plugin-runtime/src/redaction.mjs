const SENSITIVE_KEY = /(?:authorization|cookie|set-cookie|token|secret|session|profile|contextid|websocket|wsurl)/i;
const WINDOWS_PROFILE = /[A-Z]:\\(?:Users|Documents and Settings)\\[^\s"']+(?:\\[^\s"']+)*/gi;
const UNIX_PROFILE = /\/(?:Users|home)\/[^\s"']+(?:\/[^\s"']+)*/g;
const HEADER_VALUE = /\b(authorization|cookie|set-cookie)\s*[:=]\s*([^\r\n,;}]+)/gi;
const ASSIGNMENT = /\b(token|secret|session(?:id)?|profile(?:path)?|contextid)\s*[:=]\s*["']?([^\s"',;}]+)/gi;
const URL_CREDENTIAL = /([?&](?:access_token|auth|authorization|api[_-]?key|cookie|secret|session(?:id)?|token)=)([^&#\s]+)/gi;

export function redactSensitiveText(value) {
  return String(value)
    .replace(URL_CREDENTIAL, "$1[REDACTED]")
    .replace(HEADER_VALUE, "$1=[REDACTED]")
    .replace(ASSIGNMENT, "$1=[REDACTED]")
    .replace(WINDOWS_PROFILE, "[REDACTED_PATH]")
    .replace(UNIX_PROFILE, "[REDACTED_PATH]");
}

export function redactSensitiveValue(value, seen = new WeakSet()) {
  if (typeof value === "string") return redactSensitiveText(value);
  if (!value || typeof value !== "object") return value;
  if (seen.has(value)) return "[CIRCULAR]";
  seen.add(value);
  if (Array.isArray(value)) return value.map((entry) => redactSensitiveValue(entry, seen));
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [
    key,
    SENSITIVE_KEY.test(key) ? "[REDACTED]" : redactSensitiveValue(entry, seen),
  ]));
}
