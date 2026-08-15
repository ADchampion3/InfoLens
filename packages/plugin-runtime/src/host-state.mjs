import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { shortRefreshMessage } from "./refresh-outcome.mjs";

const THEMES = new Set(["system", "light", "dark"]);
const PLUGIN_ORIGINS = new Set(["market", "local", "bundled"]);
const RELEASE_STATUSES = new Set(["current", "retracted", "incompatible", "unknown"]);

function cleanFailure(failure) {
  if (!failure || typeof failure !== "object") return undefined;
  if (typeof failure.code !== "string" || !failure.code.trim()) return undefined;
  return {
    code: failure.code.trim().replace(/[^A-Za-z0-9_.-]/gu, "_").slice(0, 80),
    message: shortRefreshMessage(failure.message),
    ...(typeof failure.logId === "string" ? { logId: failure.logId } : {}),
    ...(typeof failure.operationId === "string" ? { operationId: failure.operationId } : {}),
    ...(typeof failure.batchId === "string" ? { batchId: failure.batchId } : {}),
    ...(typeof failure.timestamp === "string" ? { timestamp: failure.timestamp } : {}),
  };
}

function cleanSnapshot(snapshot = {}) {
  return {
    state: typeof snapshot.state === "string" ? snapshot.state : "disabled",
    ...(typeof snapshot.lastSuccessfulRefreshAt === "string" ? { lastSuccessfulRefreshAt: snapshot.lastSuccessfulRefreshAt } : {}),
    ...(cleanFailure(snapshot.failure) ? { failure: cleanFailure(snapshot.failure) } : {}),
    updatedAt: typeof snapshot.updatedAt === "string" ? snapshot.updatedAt : new Date().toISOString(),
  };
}

function cleanInstallation(record = {}) {
  if (!record || typeof record !== "object" || !PLUGIN_ORIGINS.has(record.origin)) return undefined;
  const list = (value) => Array.isArray(value) ? [...new Set(value.filter((item) => typeof item === "string" && item.trim()).map((item) => item.trim()))] : undefined;
  return {
    origin: record.origin,
    ...(typeof record.version === "string" ? { version: record.version } : {}),
    ...(typeof record.name === "string" ? { name: record.name } : {}),
    ...(typeof record.description === "string" ? { description: shortRefreshMessage(record.description) } : {}),
    ...(typeof record.registryUrl === "string" ? { registryUrl: record.registryUrl } : {}),
    ...(typeof record.indexUrl === "string" ? { indexUrl: record.indexUrl } : {}),
    ...(typeof record.artifactUrl === "string" ? { artifactUrl: record.artifactUrl } : {}),
    ...(Number.isSafeInteger(record.artifactSize) && record.artifactSize > 0 ? { artifactSize: record.artifactSize } : {}),
    ...(typeof record.publisher === "string" ? { publisher: record.publisher } : {}),
    ...(typeof record.license === "string" ? { license: record.license } : {}),
    ...(typeof record.changelog === "string" ? { changelog: shortRefreshMessage(record.changelog) } : {}),
    ...(typeof record.contractVersion === "string" ? { contractVersion: record.contractVersion } : {}),
    ...(typeof record.minHostVersion === "string" ? { minHostVersion: record.minHostVersion } : {}),
    ...(list(record.categories) ? { categories: list(record.categories) } : {}),
    ...(list(record.platforms) ? { platforms: list(record.platforms) } : {}),
    ...(list(record.architectures) ? { architectures: list(record.architectures) } : {}),
    ...(typeof record.publishedAt === "string" ? { publishedAt: record.publishedAt } : {}),
    ...(typeof record.expectedSha256 === "string" ? { expectedSha256: record.expectedSha256 } : {}),
    ...(typeof record.observedSha256 === "string" ? { observedSha256: record.observedSha256 } : {}),
    ...(typeof record.operationId === "string" ? { operationId: record.operationId } : {}),
    ...(RELEASE_STATUSES.has(record.releaseStatus) ? { releaseStatus: record.releaseStatus } : { releaseStatus: "unknown" }),
    ...(typeof record.retractionReason === "string" ? { retractionReason: shortRefreshMessage(record.retractionReason, "Release retracted") } : {}),
    ...(typeof record.installedAt === "string" ? { installedAt: record.installedAt } : {}),
  };
}

export class HostStateStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.state = { version: 2, enabledPluginIds: [], lastSelection: null, theme: "system", statusSnapshots: {}, pluginInstallations: {} };
    this.writes = Promise.resolve();
  }

  async load() {
    try {
      const value = JSON.parse(await readFile(this.filePath, "utf8"));
      this.state = {
        version: 2,
        enabledPluginIds: [...new Set(Array.isArray(value.enabledPluginIds) ? value.enabledPluginIds.filter((id) => typeof id === "string") : [])],
        lastSelection: typeof value.lastSelection === "string" ? value.lastSelection : null,
        theme: THEMES.has(value.theme) ? value.theme : "system",
        statusSnapshots: Object.fromEntries(Object.entries(value.statusSnapshots ?? {}).map(([id, snapshot]) => [id, cleanSnapshot(snapshot)])),
        pluginInstallations: Object.fromEntries(Object.entries(value.pluginInstallations ?? {}).map(([id, record]) => [id, cleanInstallation(record)]).filter(([, record]) => record)),
      };
    } catch (error) {
      if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
    }
    return this.snapshot();
  }

  snapshot() { return structuredClone(this.state); }

  async update(change) {
    const next = typeof change === "function" ? change(this.snapshot()) : { ...this.snapshot(), ...change };
    next.version = 2;
    next.enabledPluginIds = [...new Set(next.enabledPluginIds)];
    if (!THEMES.has(next.theme)) throw new Error(`Unsupported theme '${next.theme}'`);
    next.pluginInstallations = Object.fromEntries(Object.entries(next.pluginInstallations ?? {}).map(([id, record]) => [id, cleanInstallation(record)]).filter(([, record]) => record));
    this.state = next;
    this.writes = this.writes.then(async () => {
      await mkdir(path.dirname(this.filePath), { recursive: true });
      const temporaryPath = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
      await writeFile(temporaryPath, `${JSON.stringify(this.state, null, 2)}\n`, "utf8");
      await rename(temporaryPath, this.filePath);
    });
    await this.writes;
    return this.snapshot();
  }

  async flush() { await this.writes; }
}
