import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { shortRefreshMessage } from "./refresh-outcome.mjs";

const THEMES = new Set(["system", "light", "dark"]);

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

export class HostStateStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.state = { version: 1, enabledPluginIds: [], lastSelection: null, theme: "system", statusSnapshots: {} };
    this.writes = Promise.resolve();
  }

  async load() {
    try {
      const value = JSON.parse(await readFile(this.filePath, "utf8"));
      this.state = {
        version: 1,
        enabledPluginIds: [...new Set(Array.isArray(value.enabledPluginIds) ? value.enabledPluginIds.filter((id) => typeof id === "string") : [])],
        lastSelection: typeof value.lastSelection === "string" ? value.lastSelection : null,
        theme: THEMES.has(value.theme) ? value.theme : "system",
        statusSnapshots: Object.fromEntries(Object.entries(value.statusSnapshots ?? {}).map(([id, snapshot]) => [id, cleanSnapshot(snapshot)])),
      };
    } catch (error) {
      if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
    }
    return this.snapshot();
  }

  snapshot() { return structuredClone(this.state); }

  async update(change) {
    const next = typeof change === "function" ? change(this.snapshot()) : { ...this.snapshot(), ...change };
    next.version = 1;
    next.enabledPluginIds = [...new Set(next.enabledPluginIds)];
    if (!THEMES.has(next.theme)) throw new Error(`Unsupported theme '${next.theme}'`);
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
