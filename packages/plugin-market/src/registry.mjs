import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import semver from "semver";

export const REGISTRY_SCHEMA_VERSION = 1;
export const DEFAULT_REGISTRY_URL = "https://market.infolens.app/v1/index.json";
export const REGISTRY_LIMITS = Object.freeze({
  maxIndexBytes: 8 * 1024 * 1024,
  maxRedirects: 3,
  maxArtifactBytes: 128 * 1024 * 1024,
  maxCacheAgeMs: 30 * 24 * 60 * 60 * 1000,
  requestTimeoutMs: 15_000,
});

export class MarketError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "MarketError";
    this.code = code;
    Object.assign(this, details);
  }
}

const LEGACY_RELEASE_FIELDS = Object.freeze([
  "id",
  "artifactUrl",
  "artifactSize",
  "sha256",
  "supportedPlatforms",
  "supportedArchitectures",
  "retracted",
  "retractionReason",
]);

function fail(condition, code, message, details) {
  if (condition) throw new MarketError(code, message, details);
}

function stringValue(value, field) {
  fail(typeof value !== "string" || !value.trim(), "REGISTRY_INVALID", `${field} must be a non-empty string`);
  return value.trim();
}

function stringList(value, field) {
  fail(!Array.isArray(value) || value.length === 0 || value.some((item) => typeof item !== "string" || !item.trim()), "REGISTRY_INVALID", `${field} must be a non-empty string array`);
  return [...new Set(value.map((item) => item.trim()))];
}

function artifactValue(release) {
  const artifact = release.artifact && typeof release.artifact === "object" && !Array.isArray(release.artifact) ? release.artifact : {};
  return {
    url: artifact.url,
    size: artifact.size,
    sha256: artifact.sha256,
  };
}

function retractionValue(release) {
  if (release.retraction === undefined) return undefined;
  fail(!release.retraction || typeof release.retraction !== "object" || Array.isArray(release.retraction), "REGISTRY_INVALID", "retraction must be an object");
  return {
    reason: stringValue(release.retraction.reason ?? "Retracted by the Registry", "retraction.reason"),
    ...(release.retraction.at ? { at: stringValue(release.retraction.at, "retraction.at") } : {}),
  };
}

function assertCanonicalReleaseFields(release) {
  for (const field of LEGACY_RELEASE_FIELDS) {
    fail(Object.hasOwn(release, field), "REGISTRY_INVALID", `release.${field} is not supported by the canonical Market schema`);
  }
}

export function normalizeRelease(release, { indexUrl, officialUrl, cdnAllowlist = [] } = {}) {
  fail(!release || typeof release !== "object" || Array.isArray(release), "REGISTRY_INVALID", "Each Registry release must be an object");
  assertCanonicalReleaseFields(release);
  const artifact = artifactValue(release);
  const pluginId = stringValue(release.pluginId, "pluginId");
  fail(!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.test(pluginId), "REGISTRY_INVALID", `pluginId '${pluginId}' is invalid`);
  const version = stringValue(release.version, "version");
  fail(!semver.valid(version), "REGISTRY_INVALID", `release '${pluginId}' has invalid version '${version}'`);
  fail(Boolean(semver.prerelease(version)), "REGISTRY_PRERELEASE", `release '${pluginId}@${version}' is a pre-release and cannot enter the V1 Market`);
  const contractVersion = String(release.contractVersion ?? "");
  fail(!/^\d+$/u.test(contractVersion), "REGISTRY_INVALID", `release '${pluginId}@${version}' has invalid contractVersion`);
  const minHostVersion = stringValue(release.minHostVersion, "minHostVersion");
  fail(!semver.valid(minHostVersion), "REGISTRY_INVALID", `release '${pluginId}@${version}' has invalid minHostVersion`);
  const platforms = stringList(release.platforms, "platforms");
  const architectures = stringList(release.architectures, "architectures");
  const artifactUrl = stringValue(artifact.url, "artifact.url");
  assertAllowedRegistryUrl(artifactUrl, { officialUrl: officialUrl ?? indexUrl ?? DEFAULT_REGISTRY_URL, cdnAllowlist });
  const artifactSize = Number(artifact.size);
  fail(!Number.isSafeInteger(artifactSize) || artifactSize < 1, "REGISTRY_INVALID", `release '${pluginId}@${version}' has invalid artifact size`);
  const sha256 = stringValue(artifact.sha256, "artifact.sha256").toLowerCase();
  fail(!/^[0-9a-f]{64}$/u.test(sha256), "REGISTRY_INVALID", `release '${pluginId}@${version}' has invalid SHA-256`);
  const publishedAt = stringValue(release.publishedAt, "publishedAt");
  fail(Number.isNaN(Date.parse(publishedAt)), "REGISTRY_INVALID", `release '${pluginId}@${version}' has invalid publication time`);
  const normalized = {
    pluginId,
    name: stringValue(release.name, "name"),
    description: stringValue(release.description, "description"),
    ...(typeof release.icon === "string" && release.icon.trim() ? { icon: release.icon.trim() } : {}),
    publisher: stringValue(release.publisher, "publisher"),
    license: stringValue(release.license, "license"),
    categories: stringList(release.categories, "categories"),
    version,
    changelog: stringValue(release.changelog ?? "No changelog provided", "changelog"),
    contractVersion,
    minHostVersion,
    platforms,
    architectures,
    artifact: { url: artifactUrl, size: artifactSize, sha256 },
    publishedAt: new Date(publishedAt).toISOString(),
    ...(indexUrl ? { indexUrl } : {}),
    ...(retractionValue(release) ? { retraction: retractionValue(release) } : {}),
  };
  return normalized;
}

export function validateMarketIndex(value, { indexUrl, officialUrl, cdnAllowlist = [] } = {}) {
  fail(!value || typeof value !== "object" || Array.isArray(value), "REGISTRY_INVALID", "Market index must be a JSON object");
  const schemaVersion = Number(value.schemaVersion);
  fail(schemaVersion !== REGISTRY_SCHEMA_VERSION || Object.hasOwn(value, "version"), "REGISTRY_SCHEMA_UNSUPPORTED", `Market index schema '${String(value.schemaVersion)}' is unsupported`);
  fail(!Array.isArray(value.releases), "REGISTRY_INVALID", "Market index releases must be an array");
  const seen = new Set();
  const releases = value.releases.map((release) => {
    const normalized = normalizeRelease(release, { indexUrl, officialUrl, cdnAllowlist });
    const key = `${normalized.pluginId}@${normalized.version}`;
    fail(seen.has(key), "REGISTRY_DUPLICATE_RELEASE", `Market index contains duplicate release '${key}'`);
    seen.add(key);
    return normalized;
  });
  const registry = value.registry && typeof value.registry === "object" ? {
    ...(typeof value.registry.name === "string" ? { name: value.registry.name } : {}),
    ...(typeof value.registry.source === "string" ? { source: value.registry.source } : {}),
  } : {};
  return {
    schemaVersion,
    ...(typeof value.generatedAt === "string" && !Number.isNaN(Date.parse(value.generatedAt)) ? { generatedAt: new Date(value.generatedAt).toISOString() } : {}),
    registry,
    releases,
  };
}

function parseRegistryUrl(value) {
  try { return new URL(value); }
  catch { throw new MarketError("REGISTRY_URL_INVALID", `Registry URL '${String(value)}' is invalid`); }
}

function allowedOriginSet(officialUrl, cdnAllowlist = []) {
  const official = parseRegistryUrl(officialUrl);
  fail(official.protocol !== "https:", "REGISTRY_TRANSPORT_UNSUPPORTED", "The official Market Registry must use HTTPS");
  const values = [official.origin, ...cdnAllowlist].map((value) => parseRegistryUrl(value)).map((url) => {
    fail(url.protocol !== "https:", "REGISTRY_TRANSPORT_UNSUPPORTED", "Market sources must use HTTPS");
    return url.origin;
  });
  return new Set(values);
}

export function isAllowedRegistryUrl(value, { officialUrl = DEFAULT_REGISTRY_URL, cdnAllowlist = [] } = {}) {
  const url = parseRegistryUrl(value);
  if (url.protocol !== "https:") return false;
  return allowedOriginSet(officialUrl, cdnAllowlist).has(url.origin);
}

export function assertAllowedRegistryUrl(value, options = {}) {
  const url = parseRegistryUrl(value);
  fail(url.protocol !== "https:", "REGISTRY_TRANSPORT_UNSUPPORTED", "Market sources must use HTTPS");
  fail(!isAllowedRegistryUrl(value, options), "REGISTRY_URL_BLOCKED", `Market URL '${String(value)}' is outside the official Registry allowlist`);
  return url.toString();
}

function requestSignal(signal, timeoutMs) {
  const controller = new AbortController();
  let timedOut = false;
  const onAbort = () => controller.abort(signal?.reason);
  if (signal) {
    if (signal.aborted) controller.abort(signal.reason);
    else signal.addEventListener("abort", onAbort, { once: true });
  }
  const timeout = Number(timeoutMs);
  const timer = Number.isFinite(timeout) && timeout > 0
    ? setTimeout(() => { timedOut = true; controller.abort(); }, timeout)
    : undefined;
  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    cleanup: () => {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    },
  };
}

async function responseBytes(response, maxBytes) {
  const contentLength = Number(response.headers?.get?.("content-length") ?? response.headers?.["content-length"] ?? 0);
  fail(Number.isFinite(contentLength) && contentLength > maxBytes, "REGISTRY_RESPONSE_TOO_LARGE", "Market Registry response exceeds the size limit");
  if (response.body && typeof response.body[Symbol.asyncIterator] === "function") {
    const chunks = [];
    let total = 0;
    for await (const chunk of response.body) {
      const buffer = Buffer.from(chunk);
      total += buffer.length;
      fail(total > maxBytes, "REGISTRY_RESPONSE_TOO_LARGE", "Market Registry response exceeds the size limit");
      chunks.push(buffer);
    }
    return Buffer.concat(chunks);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  fail(bytes.length > maxBytes, "REGISTRY_RESPONSE_TOO_LARGE", "Market Registry response exceeds the size limit");
  return bytes;
}

export async function fetchMarketIndex({ registryUrl = DEFAULT_REGISTRY_URL, officialUrl = registryUrl, cdnAllowlist = [], transport = fetch, signal, limits = {} } = {}) {
  const policy = { officialUrl, cdnAllowlist };
  let url = assertAllowedRegistryUrl(registryUrl, policy);
  const maxRedirects = limits.maxRedirects ?? REGISTRY_LIMITS.maxRedirects;
  for (let redirect = 0; redirect <= maxRedirects; redirect += 1) {
    const request = requestSignal(signal, limits.requestTimeoutMs ?? REGISTRY_LIMITS.requestTimeoutMs);
    try {
      const response = await transport(url, { signal: request.signal, redirect: "manual" });
      const location = response.headers?.get?.("location") ?? response.headers?.location;
      if ([301, 302, 303, 307, 308].includes(response.status) && location) {
        fail(redirect >= maxRedirects, "REGISTRY_REDIRECT_LIMIT", "Market Registry redirected too many times");
        url = assertAllowedRegistryUrl(new URL(location, url).toString(), policy);
        continue;
      }
      fail(response.url && !isAllowedRegistryUrl(response.url, policy), "REGISTRY_REDIRECT_BLOCKED", "Market Registry response resolved outside the official allowlist");
      fail(!response.ok, "REGISTRY_HTTP_ERROR", `Market Registry returned HTTP ${response.status}`);
      const bytes = await responseBytes(response, limits.maxIndexBytes ?? REGISTRY_LIMITS.maxIndexBytes);
      let parsed;
      try { parsed = JSON.parse(bytes.toString("utf8")); }
      catch { throw new MarketError("REGISTRY_INVALID_JSON", "Market Registry returned invalid JSON"); }
      return { index: validateMarketIndex(parsed, { indexUrl: url, officialUrl, cdnAllowlist }), url, fetchedAt: new Date().toISOString() };
    } catch (error) {
      if (error instanceof MarketError) throw error;
      if (request.timedOut()) throw new MarketError("REGISTRY_TIMEOUT", "Market Registry request timed out");
      if (signal?.aborted) throw new MarketError("REGISTRY_CANCELLED", "Market Registry request was cancelled");
      throw new MarketError("REGISTRY_UNAVAILABLE", `Market Registry could not be reached: ${error?.message ?? String(error)}`);
    } finally {
      request.cleanup();
    }
  }
  throw new MarketError("REGISTRY_REDIRECT_LIMIT", "Market Registry redirected too many times");
}

export async function readMarketCache(filePath, { officialUrl, cdnAllowlist = [] } = {}) {
  try {
    const cached = JSON.parse(await readFile(filePath, "utf8"));
    const indexUrl = assertAllowedRegistryUrl(cached.indexUrl, { officialUrl, cdnAllowlist });
    const index = validateMarketIndex(cached.index, { indexUrl, officialUrl, cdnAllowlist });
    const cachedAt = new Date(cached.cachedAt);
    fail(Number.isNaN(cachedAt.valueOf()), "MARKET_CACHE_INVALID", "Market cache timestamp is invalid");
    return { index, indexUrl, cachedAt: cachedAt.toISOString() };
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    if (error instanceof MarketError) return undefined;
    return undefined;
  }
}

export async function writeMarketCache(filePath, { index, indexUrl, cachedAt = new Date().toISOString(), officialUrl, cdnAllowlist = [] }) {
  const normalizedIndexUrl = assertAllowedRegistryUrl(indexUrl, { officialUrl, cdnAllowlist });
  const normalized = validateMarketIndex(index, { indexUrl: normalizedIndexUrl, officialUrl, cdnAllowlist });
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(temporary, `${JSON.stringify({ version: 1, cachedAt, indexUrl: normalizedIndexUrl, index: normalized }, null, 2)}\n`, "utf8");
  await rename(temporary, filePath);
  return { index: normalized, indexUrl: normalizedIndexUrl, cachedAt };
}

function platformMatches(value, target) {
  const aliases = new Map([["win32", "windows"], ["windows", "windows"], ["darwin", "macos"], ["macos", "macos"], ["linux", "linux"]]);
  return aliases.get(value) === aliases.get(target) || value === target;
}

export function releaseCompatibility(release, { hostVersion, contractVersion, platform = process.platform, architecture = process.arch } = {}) {
  const reasons = [];
  if (String(release.contractVersion) !== String(contractVersion)) reasons.push({ code: "INCOMPATIBLE_CONTRACT", message: `Requires Plugin Contract ${release.contractVersion}; this Host supports ${contractVersion}` });
  if (!semver.valid(hostVersion) || semver.gt(release.minHostVersion, hostVersion)) reasons.push({ code: "INCOMPATIBLE_HOST", message: `Requires Host ${release.minHostVersion} or newer; this Host is ${hostVersion}` });
  if (!release.platforms.some((value) => platformMatches(value, platform))) reasons.push({ code: "UNSUPPORTED_PLATFORM", message: `Does not support platform '${platform}'` });
  if (!release.architectures.includes(architecture) && !(architecture === "x64" && release.architectures.includes("amd64"))) reasons.push({ code: "UNSUPPORTED_ARCHITECTURE", message: `Does not support architecture '${architecture}'` });
  if (release.retraction) reasons.push({ code: "RETRACTED", message: release.retraction.reason });
  return { compatible: reasons.length === 0, reasons };
}

export function searchReleases(index, query = "") {
  const terms = String(query).trim().toLocaleLowerCase("en-US").split(/\s+/u).filter(Boolean);
  if (!terms.length) return [...index.releases];
  return index.releases.filter((release) => {
    const haystack = [release.pluginId, release.name, release.description, release.publisher, ...release.categories].join(" ").toLocaleLowerCase("en-US");
    return terms.every((term) => haystack.includes(term));
  });
}

export function latestCompatibleRelease(releases, context) {
  return [...releases]
    .filter((release) => release.version && !release.retraction && releaseCompatibility(release, context).compatible)
    .sort((left, right) => semver.rcompare(left.version, right.version))[0];
}
