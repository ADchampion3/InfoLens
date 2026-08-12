const ISO_TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2})$/u;

function daysInMonth(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

export function normalizeIsoTimestamp(value) {
  if (typeof value !== "string") return undefined;
  const match = value.match(ISO_TIMESTAMP);
  if (!match) return undefined;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, fractionText, offset] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) return undefined;
  if (hour > 23 || minute > 59 || second > 59) return undefined;
  if (offset !== "Z") {
    const offsetHours = Number(offset.slice(1, 3));
    const offsetMinutes = Number(offset.slice(4, 6));
    if (offsetHours > 23 || offsetMinutes > 59) return undefined;
  }
  const timestamp = new Date(value);
  if (!Number.isFinite(timestamp.valueOf())) return undefined;
  return timestamp.toISOString();
}

export function localDateKey(value, timeZone) {
  const timestamp = value instanceof Date ? value : new Date(String(value));
  if (!Number.isFinite(timestamp.valueOf()) || typeof timeZone !== "string" || !timeZone.trim()) return undefined;
  let parts;
  try {
    parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(timestamp);
  } catch {
    return undefined;
  }
  const values = Object.fromEntries(parts.filter(({ type }) => type !== "literal").map(({ type, value: part }) => [type, part]));
  if (!values.year || !values.month || !values.day) return undefined;
  return `${values.year}-${values.month}-${values.day}`;
}
