const FIELD_TYPES = new Set(["select", "text", "number", "boolean"]);
const KEY_PATTERN = /^[a-z][a-zA-Z0-9_-]{0,63}$/u;
const MAX_FIELDS = 8;
const MAX_CHOICES = 50;
const MAX_TEXT_LENGTH = 240;

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function text(value, fallback = "") {
  const result = String(value ?? fallback).trim();
  return result.length > 120 ? result.slice(0, 120) : result;
}

function invalid(message) {
  throw Object.assign(new Error(message), { code: "BATCH_INVALID_REFRESH_INPUT" });
}

function normalizeValue(field, value, strict) {
  if (value === undefined || value === null) return undefined;
  if (field.type === "select") {
    if (typeof value !== "string" || !field.options.some((option) => option.value === value)) {
      if (strict) invalid(`Refresh option '${field.key}' must use one of the declared values`);
      return undefined;
    }
    return value;
  }
  if (field.type === "text") {
    if (typeof value !== "string" || value.length > field.maxLength) {
      if (strict) invalid(`Refresh option '${field.key}' must be text no longer than ${field.maxLength} characters`);
      return undefined;
    }
    return value;
  }
  if (field.type === "number") {
    if (typeof value !== "number" || !Number.isFinite(value) || (field.min !== undefined && value < field.min) || (field.max !== undefined && value > field.max)) {
      if (strict) invalid(`Refresh option '${field.key}' must be a number in the declared range`);
      return undefined;
    }
    return value;
  }
  if (typeof value !== "boolean") {
    if (strict) invalid(`Refresh option '${field.key}' must be boolean`);
    return undefined;
  }
  return value;
}

function normalizeField(value) {
  if (!isRecord(value) || !KEY_PATTERN.test(value.key) || !FIELD_TYPES.has(value.type)) return undefined;
  const field = {
    key: value.key,
    label: text(value.label, value.key),
    type: value.type,
    ...(value.required === true ? { required: true } : {}),
  };
  if (!field.label) return undefined;
  if (field.type === "select") {
    if (!Array.isArray(value.options) || !value.options.length || value.options.length > MAX_CHOICES) return undefined;
    const options = [];
    const seen = new Set();
    for (const option of value.options) {
      if (!isRecord(option) || typeof option.value !== "string" || !option.value || option.value.length > 80 || seen.has(option.value)) continue;
      seen.add(option.value);
      options.push({ value: option.value, label: text(option.label, option.value) });
    }
    if (!options.length) return undefined;
    field.options = options;
  }
  if (field.type === "text") {
    const maxLength = Number.isInteger(value.maxLength) ? Math.min(Math.max(value.maxLength, 1), MAX_TEXT_LENGTH) : MAX_TEXT_LENGTH;
    field.maxLength = maxLength;
    if (typeof value.placeholder === "string" && value.placeholder.length <= 120) field.placeholder = value.placeholder;
  }
  if (field.type === "number") {
    if (value.min !== undefined && (!Number.isFinite(value.min) || value.min < -1_000_000_000)) return undefined;
    if (value.max !== undefined && (!Number.isFinite(value.max) || value.max > 1_000_000_000)) return undefined;
    if (value.min !== undefined && value.max !== undefined && value.min > value.max) return undefined;
    if (value.step !== undefined && (!Number.isFinite(value.step) || value.step <= 0)) return undefined;
    if (value.min !== undefined) field.min = value.min;
    if (value.max !== undefined) field.max = value.max;
    if (value.step !== undefined) field.step = value.step;
  }
  const defaultValue = normalizeValue(field, value.default, false);
  if (defaultValue !== undefined) field.default = defaultValue;
  return field;
}

export function sanitizeRefreshOptions(value) {
  if (!isRecord(value) || !Array.isArray(value.fields)) return undefined;
  const fields = value.fields.slice(0, MAX_FIELDS).map(normalizeField).filter(Boolean);
  if (!fields.length) return undefined;
  const values = isRecord(value.values) ? value.values : {};
  const normalized = {
    ...(value.title ? { title: text(value.title) } : {}),
    fields,
    values: {},
  };
  for (const field of fields) {
    const current = normalizeValue(field, values[field.key], false) ?? normalizeValue(field, field.default, false);
    if (current !== undefined) normalized.values[field.key] = current;
  }
  return normalized;
}

export function normalizeRefreshInput(options, input) {
  const normalized = sanitizeRefreshOptions(options);
  if (!normalized) {
    if (isRecord(input) && Object.keys(input).length) invalid("This Plugin Workspace does not declare refresh parameters");
    return undefined;
  }
  if (input !== undefined && !isRecord(input)) invalid("Refresh parameters must be an object");
  const source = input ?? {};
  const declared = new Set(normalized.fields.map((field) => field.key));
  for (const key of Object.keys(source)) if (!declared.has(key)) invalid(`Refresh option '${key}' is not declared by the Plugin Workspace`);
  const result = {};
  for (const field of normalized.fields) {
    const candidate = Object.hasOwn(source, field.key)
      ? source[field.key]
      : normalized.values[field.key] ?? field.default ?? (field.type === "boolean" ? false : undefined);
    const value = normalizeValue(field, candidate, true);
    if (value === undefined && field.required) invalid(`Refresh option '${field.key}' is required`);
    if (value !== undefined) result[field.key] = value;
  }
  return Object.keys(result).length ? result : undefined;
}

export function refreshInputKey(input) {
  if (!isRecord(input) || !Object.keys(input).length) return "default";
  return JSON.stringify(Object.fromEntries(Object.keys(input).sort().map((key) => [key, input[key]])));
}
