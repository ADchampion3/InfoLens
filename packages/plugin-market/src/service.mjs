import { createHash, randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  assertAllowedRegistryUrl, DEFAULT_REGISTRY_URL, fetchMarketIndex, latestCompatibleRelease,
  MarketError, readMarketCache, releaseCompatibility, searchReleases, writeMarketCache,
} from "./registry.mjs";
import { sha256File } from "./archive.mjs";

const DEFAULT_ARTIFACT_LIMITS = Object.freeze({ maxArtifactBytes: 128 * 1024 * 1024, maxRedirects: 3, requestTimeoutMs: 30_000 });

function operationError(error, fallbackCode = "MARKET_INSTALL_FAILED") {
  if (error instanceof MarketError) return error;
  if (typeof error?.code === "string" && error.code.trim()) {
    const wrapped = new MarketError(error.code.trim(), error instanceof Error ? error.message : String(error));
    if (error.body && typeof error.body === "object") Object.assign(wrapped, { body: error.body });
    return wrapped;
  }
  const wrapped = new MarketError(fallbackCode, error instanceof Error ? error.message : String(error));
  if (error?.name === "AbortError") wrapped.code = "MARKET_INSTALL_CANCELLED";
  return wrapped;
}

function responseHeader(response, name) {
  return response.headers?.get?.(name) ?? response.headers?.[name.toLowerCase()] ?? response.headers?.[name];
}

function requestSignal(signal, timeoutMs) {
  const controller = new AbortController();
  let timedOut = false;
  let rejectControl;
  const timeout = Number(timeoutMs);
  const hasControl = Boolean(signal) || (Number.isFinite(timeout) && timeout > 0);
  const control = hasControl ? new Promise((_, reject) => { rejectControl = reject; }) : undefined;
  const cancel = (error) => {
    controller.abort(signal?.reason);
    rejectControl?.(error);
  };
  const onAbort = () => cancel(new MarketError("MARKET_INSTALL_CANCELLED", "Market installation was cancelled"));
  if (signal) {
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  }
  const timer = Number.isFinite(timeout) && timeout > 0
    ? setTimeout(() => {
      timedOut = true;
      cancel(new MarketError("MARKET_DOWNLOAD_TIMEOUT", "Market artifact download timed out"));
    }, timeout)
    : undefined;
  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    control,
    cleanup: () => {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    },
  };
}

function raceWithRequest(value, request) {
  return request.control ? Promise.race([value, request.control]) : value;
}

function closeAsyncIterator(iterator) {
  try {
    const result = iterator?.return?.();
    if (result && typeof result.then === "function") void result.catch(() => {});
  } catch {}
}

async function consumeResponseBody(response, request, { maxBytes, expectedSize, onChunk }) {
  let received = 0;
  const accept = async (chunk) => {
    const value = Buffer.from(chunk);
    received += value.length;
    if (received > maxBytes) throw new MarketError("MARKET_ARTIFACT_TOO_LARGE", "Market artifact exceeds the download size limit");
    if (expectedSize && received > expectedSize) throw new MarketError("MARKET_ARTIFACT_SIZE_MISMATCH", "Market artifact is larger than the Registry record");
    await raceWithRequest(Promise.resolve().then(() => onChunk(value, received)), request);
  };

  if (response.body && typeof response.body[Symbol.asyncIterator] === "function") {
    const iterator = response.body[Symbol.asyncIterator]();
    try {
      while (true) {
        const next = await raceWithRequest(Promise.resolve().then(() => iterator.next()), request);
        if (next.done) break;
        await accept(next.value);
      }
    } catch (error) {
      closeAsyncIterator(iterator);
      throw error;
    }
  } else {
    const value = await raceWithRequest(Promise.resolve().then(() => response.arrayBuffer()), request);
    await accept(value);
  }
  if (expectedSize && received !== expectedSize) throw new MarketError("MARKET_ARTIFACT_SIZE_MISMATCH", "Market artifact size differs from the Registry record");
  return received;
}

async function downloadArtifact({ url, destination, expectedSize, limits, transport, signal, onProgress, officialUrl, cdnAllowlist }) {
  let current = assertAllowedRegistryUrl(url, { officialUrl, cdnAllowlist });
  const maxRedirects = limits.maxRedirects ?? DEFAULT_ARTIFACT_LIMITS.maxRedirects;
  if (Number.isSafeInteger(expectedSize) && expectedSize > limits.maxArtifactBytes) throw new MarketError("MARKET_ARTIFACT_TOO_LARGE", "Market artifact exceeds the download size limit");
  for (let redirect = 0; redirect <= maxRedirects; redirect += 1) {
    const request = requestSignal(signal, limits.requestTimeoutMs ?? DEFAULT_ARTIFACT_LIMITS.requestTimeoutMs);
    let response;
    let output;
    let completed = false;
    try {
      response = await raceWithRequest(Promise.resolve().then(() => transport(current, { signal: request.signal, redirect: "manual" })), request);
      const location = responseHeader(response, "location");
      if ([301, 302, 303, 307, 308].includes(response.status) && location) {
        if (redirect >= maxRedirects) throw new MarketError("MARKET_REDIRECT_LIMIT", "Market artifact redirected too many times");
        current = assertAllowedRegistryUrl(new URL(location, current).toString(), { officialUrl, cdnAllowlist });
        continue;
      }
      if (response.url && response.url !== current) assertAllowedRegistryUrl(response.url, { officialUrl, cdnAllowlist });
      if (!response.ok) throw new MarketError("MARKET_DOWNLOAD_HTTP_ERROR", `Market artifact returned HTTP ${response.status}`);
      const declaredSize = Number(responseHeader(response, "content-length") ?? 0);
      if (Number.isFinite(declaredSize) && declaredSize > limits.maxArtifactBytes) throw new MarketError("MARKET_ARTIFACT_TOO_LARGE", "Market artifact exceeds the download size limit");
      if (Number.isSafeInteger(expectedSize) && declaredSize > 0 && declaredSize !== expectedSize) throw new MarketError("MARKET_ARTIFACT_SIZE_MISMATCH", "Market artifact size differs from the Registry record");
      output = createWriteStream(destination, { flags: "wx" });
      const write = (chunk) => new Promise((resolve, reject) => {
        const onError = (error) => {
          output.off("drain", onDrain);
          reject(error);
        };
        const onDrain = () => {
          output.off("error", onError);
          resolve();
        };
        output.once("error", onError);
        if (output.write(chunk)) {
          output.off("error", onError);
          resolve();
        } else output.once("drain", onDrain);
      });
      try {
        const received = await consumeResponseBody(response, request, {
          maxBytes: limits.maxArtifactBytes,
          expectedSize,
          onChunk: (value, totalReceived) => write(value).then(() => onProgress?.({ phase: "download", received: totalReceived, total: expectedSize ?? declaredSize ?? undefined })),
        });
        await raceWithRequest(new Promise((resolve, reject) => {
          const onError = (error) => reject(error);
          output.once("error", onError);
          output.end(() => {
            output.off("error", onError);
            resolve();
          });
        }), request);
        const observedSha256 = await sha256File(destination);
        completed = true;
        return { bytes: received, sha256: observedSha256, url: current };
      } catch (error) {
        if (request.timedOut()) throw new MarketError("MARKET_DOWNLOAD_TIMEOUT", "Market artifact download timed out");
        if (signal?.aborted) throw new MarketError("MARKET_INSTALL_CANCELLED", "Market installation was cancelled");
        throw operationError(error, "MARKET_DOWNLOAD_FAILED");
      }
    } catch (error) {
      if (error instanceof MarketError) throw error;
      if (request.timedOut()) throw new MarketError("MARKET_DOWNLOAD_TIMEOUT", "Market artifact download timed out");
      if (signal?.aborted) throw new MarketError("MARKET_INSTALL_CANCELLED", "Market installation was cancelled");
      throw operationError(error, "MARKET_DOWNLOAD_FAILED");
    } finally {
      if (output && !completed) output.destroy();
      if (!completed) await rm(destination, { force: true });
      request.cleanup();
    }
  }
  throw new MarketError("MARKET_REDIRECT_LIMIT", "Market artifact redirected too many times");
}

export class PluginMarketService {
  constructor({
    registryUrl = DEFAULT_REGISTRY_URL,
    officialUrl = registryUrl,
    cdnAllowlist = [],
    cachePath,
    tempRoot = path.join(os.tmpdir(), "infolens-market"),
    transport = fetch,
    runtimeClient,
    logger,
    hostVersion,
    contractVersion,
    platform = process.platform,
    architecture = process.arch,
    limits = {},
    now = () => new Date(),
    reconcileProvenance,
  } = {}) {
    this.registryUrl = assertAllowedRegistryUrl(registryUrl, { officialUrl, cdnAllowlist });
    this.officialUrl = officialUrl;
    this.cdnAllowlist = cdnAllowlist;
    this.tempRoot = path.resolve(tempRoot);
    this.cachePath = cachePath ? path.resolve(cachePath) : path.join(this.tempRoot, "catalog.json");
    this.transport = transport;
    this.runtimeClient = runtimeClient;
    this.logger = logger;
    this.hostVersion = hostVersion;
    this.contractVersion = contractVersion;
    this.platform = platform;
    this.architecture = architecture;
    this.limits = { ...DEFAULT_ARTIFACT_LIMITS, ...limits };
    this.now = now;
    this.reconcileProvenance = reconcileProvenance;
    this.cache = undefined;
    this.connection = undefined;
    this.operations = new Map();
    this.controllers = new Map();
  }

  async initialize() {
    await mkdir(this.tempRoot, { recursive: true });
    const cachePath = path.resolve(this.cachePath);
    for (const entry of await readdir(this.tempRoot, { withFileTypes: true }).catch(() => [])) {
      const entryPath = path.resolve(this.tempRoot, entry.name);
      if (entryPath === cachePath) continue;
      await rm(entryPath, { recursive: true, force: true });
    }
    this.cache = await readMarketCache(cachePath, { officialUrl: this.officialUrl, cdnAllowlist: this.cdnAllowlist });
    return this.snapshotCatalog();
  }

  snapshotCatalog() {
    if (!this.cache) return { index: undefined, cachedAt: undefined, cacheAgeMs: undefined, offline: true, connected: false };
    const age = Math.max(0, this.now().valueOf() - new Date(this.cache.cachedAt).valueOf());
    return { index: this.cache.index, cachedAt: this.cache.cachedAt, cacheAgeMs: age, offline: !this.connection, connected: Boolean(this.connection) };
  }

  async refreshCatalog() {
    let result;
    try {
      result = await fetchMarketIndex({ registryUrl: this.registryUrl, officialUrl: this.officialUrl, cdnAllowlist: this.cdnAllowlist, transport: this.transport, limits: this.limits });
    } catch (error) {
      this.connection = undefined;
      throw error;
    }
    this.cache = await writeMarketCache(this.cachePath, { index: result.index, indexUrl: result.url, cachedAt: result.fetchedAt, officialUrl: this.officialUrl, cdnAllowlist: this.cdnAllowlist });
    this.connection = { connectedAt: result.fetchedAt, indexUrl: result.url };
    try { await this.reconcileProvenance?.(result.index); }
    catch (error) { await this.logger?.({ event: "market-provenance-reconciliation-failed", code: error?.code ?? "MARKET_RECONCILIATION_FAILED" }); }
    await this.logger?.({ event: "market-catalog-refreshed", indexUrl: result.url });
    return this.snapshotCatalog();
  }

  catalog(query = "") {
    const snapshot = this.snapshotCatalog();
    if (!snapshot.index) return { ...snapshot, releases: [], plugins: [] };
    const releases = searchReleases(snapshot.index, query);
    const groups = new Map();
    for (const release of releases) {
      const group = groups.get(release.pluginId) ?? { pluginId: release.pluginId, name: release.name, description: release.description, icon: release.icon, publisher: release.publisher, license: release.license, categories: release.categories, releases: [] };
      const compatibility = releaseCompatibility(release, { hostVersion: this.hostVersion, contractVersion: this.contractVersion, platform: this.platform, architecture: this.architecture });
      group.releases.push({ ...release, compatibility, installable: compatibility.compatible && !release.retraction });
      groups.set(release.pluginId, group);
    }
    const plugins = [...groups.values()].map((group) => ({
      ...group,
      releases: group.releases.sort((left, right) => right.version.localeCompare(left.version, undefined, { numeric: true })),
      latestCompatible: latestCompatibleRelease(group.releases, { hostVersion: this.hostVersion, contractVersion: this.contractVersion, platform: this.platform, architecture: this.architecture })?.version,
    }));
    return { ...snapshot, releases, plugins };
  }

  operation(operationId) {
    const operation = this.operations.get(operationId);
    return operation ? structuredClone(operation) : undefined;
  }

  cancel(operationId) {
    const controller = this.controllers.get(operationId);
    if (!controller) return false;
    controller.abort();
    return true;
  }

  release(pluginId, version) {
    const candidate = this.cache?.index.releases.find((release) => release.pluginId === pluginId && release.version === version);
    if (!candidate) throw new MarketError("MARKET_RELEASE_NOT_FOUND", `Market release '${pluginId}@${version}' was not found`);
    const compatibility = releaseCompatibility(candidate, { hostVersion: this.hostVersion, contractVersion: this.contractVersion, platform: this.platform, architecture: this.architecture });
    if (!compatibility.compatible || candidate.retraction) throw new MarketError(compatibility.reasons[0]?.code ?? "MARKET_RELEASE_UNAVAILABLE", compatibility.reasons[0]?.message ?? "Market release is unavailable", { reasons: compatibility.reasons });
    return candidate;
  }

  async install(pluginId, version, { signal, onProgress, previousOperationId, operationId: requestedOperationId } = {}) {
    if (!this.connection || !this.cache) throw new MarketError("MARKET_REGISTRY_CONNECTION_REQUIRED", "Refresh the official Market Registry before installing a Plugin");
    if (typeof this.runtimeClient !== "function") throw new MarketError("MARKET_RUNTIME_UNAVAILABLE", "Plugin Runtime installation boundary is unavailable");
    const release = this.release(pluginId, version);
    const operationId = requestedOperationId ?? randomUUID();
    const controller = new AbortController();
    const combinedSignal = controller.signal;
    const abortFromCaller = () => controller.abort();
    signal?.addEventListener("abort", abortFromCaller, { once: true });
    if (signal?.aborted) controller.abort();
    const operation = {
      operationId,
      pluginId,
      version,
      phase: "download",
      state: "running",
      progress: { received: 0, total: release.artifact.size },
      startedAt: this.now().toISOString(),
      ...(previousOperationId ? { previousOperationId } : {}),
    };
    this.operations.set(operationId, operation);
    this.controllers.set(operationId, controller);
    const stageRoot = path.join(this.tempRoot, operationId);
    const archivePath = path.join(stageRoot, "artifact.zip");
    const update = (change) => {
      Object.assign(operation, change);
      onProgress?.(structuredClone(operation));
    };
    try {
      await mkdir(stageRoot, { recursive: true });
      if (previousOperationId) await this.logger?.({ event: "market-install-retried", operationId, previousOperationId, pluginId, version, code: "MARKET_INSTALL_RETRY" });
      await this.logger?.({ event: "market-install-started", operationId, pluginId, version });
      const downloaded = await downloadArtifact({ url: release.artifact.url, destination: archivePath, expectedSize: release.artifact.size, limits: this.limits, transport: this.transport, signal: combinedSignal, onProgress: (progress) => update({ phase: "download", progress }), officialUrl: this.officialUrl, cdnAllowlist: this.cdnAllowlist });
      if (downloaded.sha256 !== release.artifact.sha256) throw new MarketError("MARKET_DIGEST_MISMATCH", "Market artifact SHA-256 does not match the Registry record", { expected: release.artifact.sha256, observed: downloaded.sha256 });
      update({ phase: "verification", observedSha256: downloaded.sha256 });
      if (combinedSignal.aborted) throw new MarketError("MARKET_INSTALL_CANCELLED", "Market installation was cancelled");
      update({ phase: "extraction" });
      update({ phase: "package-validation" });
      update({ phase: "activation" });
      const runtimeRelease = { ...release, registryUrl: this.registryUrl, indexUrl: this.cache.indexUrl };
      const result = await this.runtimeClient({ archivePath, expectedSha256: release.artifact.sha256, observedSha256: downloaded.sha256, release: runtimeRelease, operationId, signal: combinedSignal });
      update({ phase: "complete", state: "succeeded", completedAt: this.now().toISOString(), result });
      await this.logger?.({ event: "market-install-completed", operationId, pluginId, version });
      return { operationId, release, result, observedSha256: downloaded.sha256 };
    } catch (error) {
      const failure = operationError(error, "MARKET_INSTALL_FAILED");
      const cancelled = failure.code === "MARKET_INSTALL_CANCELLED" || combinedSignal.aborted;
      update({ phase: cancelled ? "cancelled" : "failed", state: cancelled ? "cancelled" : "failed", completedAt: this.now().toISOString(), error: { code: cancelled ? "MARKET_INSTALL_CANCELLED" : failure.code, message: failure.message } });
      await this.logger?.({ event: cancelled ? "market-install-cancelled" : "market-install-failed", operationId, pluginId, version, code: operation.error.code });
      throw Object.assign(failure, { operationId });
    } finally {
      signal?.removeEventListener("abort", abortFromCaller);
      this.controllers.delete(operationId);
      await rm(stageRoot, { recursive: true, force: true });
    }
  }

  async retry(operationId, options = {}) {
    const previous = this.operations.get(operationId);
    if (!previous) throw new MarketError("MARKET_OPERATION_NOT_FOUND", `Market operation '${operationId}' was not found`);
    return this.install(previous.pluginId, previous.version, {
      ...options,
      operationId: randomUUID(),
      previousOperationId: operationId,
    });
  }
}
