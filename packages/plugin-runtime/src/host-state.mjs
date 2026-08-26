import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { shortRefreshMessage } from "./refresh-outcome.mjs";

const THEMES = new Set(["system", "light", "dark"]);
const PLUGIN_ORIGINS = new Set(["url", "local", "bundled"]);
const DISTRIBUTION_MIGRATION_VERSION = 1;

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

function cleanRevision(revision) {
  if (!revision || typeof revision !== "object" || typeof revision.id !== "string" || !revision.id.trim()) return undefined;
  return {
    id: revision.id.trim(),
    ...(typeof revision.revisionId === "string" && revision.revisionId.trim() ? { revisionId: revision.revisionId.trim() } : {}),
    ...(typeof revision.version === "string" ? { version: revision.version } : {}),
    ...(typeof revision.observedSha256 === "string" ? { observedSha256: revision.observedSha256.toLowerCase() } : {}),
    ...(typeof revision.origin === "string" && PLUGIN_ORIGINS.has(revision.origin) ? { origin: revision.origin } : {}),
    ...(typeof revision.sourceUrl === "string" && revision.sourceUrl.trim() ? { sourceUrl: revision.sourceUrl.trim() } : {}),
    ...(typeof revision.sourceFileName === "string" && revision.sourceFileName.trim() ? { sourceFileName: path.basename(revision.sourceFileName.trim()) } : {}),
    ...(typeof revision.expectedSha256 === "string" ? { expectedSha256: revision.expectedSha256.toLowerCase() } : {}),
    ...(typeof revision.enabled === "boolean" ? { enabled: revision.enabled } : {}),
    ...(typeof revision.createdAt === "string" ? { createdAt: revision.createdAt } : {}),
  };
}

function cleanInstallation(record = {}) {
  if (!record || typeof record !== "object") return undefined;
  const legacyMarket = record.origin === "market";
  const origin = legacyMarket ? (typeof record.artifactUrl === "string" && record.artifactUrl.trim() ? "url" : "local") : record.origin;
  if (!PLUGIN_ORIGINS.has(origin)) return undefined;
  return {
    origin,
    ...(typeof record.version === "string" ? { version: record.version } : {}),
    ...(typeof record.contractVersion === "string" ? { contractVersion: record.contractVersion } : {}),
    ...(typeof record.minHostVersion === "string" ? { minHostVersion: record.minHostVersion } : {}),
    ...(typeof record.expectedSha256 === "string" ? { expectedSha256: record.expectedSha256 } : {}),
    ...(typeof record.observedSha256 === "string" ? { observedSha256: record.observedSha256 } : {}),
    ...(origin === "url" && typeof (record.sourceUrl ?? record.artifactUrl) === "string" ? { sourceUrl: String(record.sourceUrl ?? record.artifactUrl) } : {}),
    ...(origin === "local" && typeof (record.sourceFileName ?? record.fileName) === "string" ? { sourceFileName: path.basename(String(record.sourceFileName ?? record.fileName)) } : {}),
    ...(typeof record.operationId === "string" ? { operationId: record.operationId } : {}),
    ...(typeof record.installedAt === "string" ? { installedAt: record.installedAt } : {}),
    ...(cleanRevision(record.previousRevision) ? { previousRevision: cleanRevision(record.previousRevision) } : {}),
    ...(typeof record.recoveryState === "string" ? { recoveryState: record.recoveryState } : {}),
  };
}

export class HostStateStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.state = { version: 3, distributionMigrationVersion: DISTRIBUTION_MIGRATION_VERSION, enabledPluginIds: [], lastSelection: null, theme: "system", statusSnapshots: {}, pluginInstallations: {} };
    this.writes = Promise.resolve();
  }

  async load() {
    let value;
    try {
      value = JSON.parse(await readFile(this.filePath, "utf8"));
      this.state = {
        version: 3,
        distributionMigrationVersion: DISTRIBUTION_MIGRATION_VERSION,
        enabledPluginIds: [...new Set(Array.isArray(value.enabledPluginIds) ? value.enabledPluginIds.filter((id) => typeof id === "string") : [])],
        lastSelection: typeof value.lastSelection === "string" ? value.lastSelection : null,
        theme: THEMES.has(value.theme) ? value.theme : "system",
        statusSnapshots: Object.fromEntries(Object.entries(value.statusSnapshots ?? {}).map(([id, snapshot]) => [id, cleanSnapshot(snapshot)])),
        pluginInstallations: Object.fromEntries(Object.entries(value.pluginInstallations ?? {}).map(([id, record]) => [id, cleanInstallation(record)]).filter(([, record]) => record)),
      };
    } catch (error) {
      if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
    }
    if (value && JSON.stringify(value) !== JSON.stringify(this.state)) await this.persist();
    return this.snapshot();
  }

  snapshot() { return structuredClone(this.state); }

  async update(change) {
    const next = typeof change === "function" ? change(this.snapshot()) : { ...this.snapshot(), ...change };
    next.version = 3;
    next.distributionMigrationVersion = DISTRIBUTION_MIGRATION_VERSION;
    next.enabledPluginIds = [...new Set(next.enabledPluginIds)];
    if (!THEMES.has(next.theme)) throw new Error(`Unsupported theme '${next.theme}'`);
    next.pluginInstallations = Object.fromEntries(Object.entries(next.pluginInstallations ?? {}).map(([id, record]) => [id, cleanInstallation(record)]).filter(([, record]) => record));
    this.state = next;
    this.writes = this.writes.catch(() => {}).then(() => this.persist());
    await this.writes;
    return this.snapshot();
  }

  async persist() {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    try {
      await writeFile(temporaryPath, `${JSON.stringify(this.state, null, 2)}\n`, "utf8");
      await rename(temporaryPath, this.filePath);
    } finally {
      await rm(temporaryPath, { force: true });
    }
  }

  async flush() { await this.writes; }
}
