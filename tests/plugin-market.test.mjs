import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  createDeterministicZip, extractZip, inspectZip,
  MarketError, PluginMarketService, publishMarketRelease,
  assertAllowedRegistryUrl, fetchMarketIndex, latestCompatibleRelease,
  validateMarketIndex,
} from "@infolens/plugin-market";

const officialUrl = "https://market.infolens.test/v1/index.json";

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

function approval(publisher = "Maintainer") {
  return { approvedBy: "Release Maintainer", approvedAt: "2026-08-15T00:00:00.000Z", publisher };
}

function release({ pluginId = "reader", version = "1.0.0", bytes = Buffer.from(`artifact-${pluginId}-${version}`), minHostVersion = "0.1.0", retraction } = {}) {
  return {
    pluginId,
    name: "Reader",
    description: "A small source reader",
    publisher: "Infolens Maintainer",
    license: "MIT",
    categories: ["Sources", "Tools"],
    version,
    changelog: `Changes for ${version}`,
    contractVersion: "2",
    minHostVersion,
    platforms: ["windows"],
    architectures: ["x64"],
    artifact: {
      url: new URL(`artifacts/${pluginId}-${version}.zip`, officialUrl).toString(),
      size: bytes.length,
      sha256: digest(bytes),
    },
    publishedAt: "2026-08-15T00:00:00.000Z",
    ...(retraction ? { retraction } : {}),
  };
}

function indexWith(...releases) {
  return { schemaVersion: 1, registry: { name: "Official" }, generatedAt: "2026-08-15T00:00:00.000Z", releases };
}

function response(url, bytes, headers = {}) {
  const body = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  return {
    ok: true,
    status: 200,
    url,
    headers: new Headers({ "content-length": String(body.length), ...headers }),
    arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
  };
}

test("deterministic archives are stable and unsafe archive entries are rejected", async () => {
  const first = createDeterministicZip([
    { path: "web/index.html", data: "<title>Market</title>" },
    { path: "manifest.json", data: "{}" },
  ]);
  const second = createDeterministicZip([
    { path: "manifest.json", data: "{}" },
    { path: "web/index.html", data: "<title>Market</title>" },
  ]);
  assert.deepEqual(first, second);
  assert.equal(inspectZip(first).entries.map(({ name }) => name).join(","), "manifest.json,web/index.html");
  assert.throws(() => createDeterministicZip([{ path: "../escape", data: "x" }]), (error) => error.code === "ARCHIVE_PATH_TRAVERSAL");
  assert.throws(() => createDeterministicZip([{ path: "same", data: "1" }, { path: "same", data: "2" }]), (error) => error.code === "ARCHIVE_DUPLICATE_ENTRY");

  const symlinkArchive = Buffer.from(first);
  const end = symlinkArchive.length - 22;
  const centralOffset = symlinkArchive.readUInt32LE(end + 16);
  symlinkArchive.writeUInt32LE(0xa0000000, centralOffset + 38);
  assert.throws(() => inspectZip(symlinkArchive), (error) => error.code === "ARCHIVE_SYMLINK");
  assert.throws(() => inspectZip(first.subarray(0, -1)), (error) => error.code === "ARCHIVE_INVALID");

  const bombArchive = createDeterministicZip([{ path: "bomb", data: Buffer.alloc(128, 0x41) }]);
  const bombEnd = bombArchive.length - 22;
  const bombCentralOffset = bombArchive.readUInt32LE(bombEnd + 16);
  bombArchive.writeUInt32LE(1, bombCentralOffset + 24);
  assert.throws(() => inspectZip(bombArchive, { maxEntryBytes: 16, maxTotalBytes: 16 }), (error) => error.code === "ARCHIVE_ENTRY_TOO_LARGE");

  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "infolens-market-archive-"));
  try {
    const extracted = await extractZip(first, path.join(temporaryRoot, "staged"));
    assert.equal(await readFile(path.join(extracted.destination, "manifest.json"), "utf8"), "{}");
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("Registry validation enforces HTTPS and the official artifact allowlist", async () => {
  assert.equal(assertAllowedRegistryUrl(officialUrl, { officialUrl }), officialUrl);
  assert.throws(() => assertAllowedRegistryUrl("http://market.infolens.test/v1/index.json", { officialUrl }), (error) => error.code === "REGISTRY_TRANSPORT_UNSUPPORTED");
  assert.throws(() => assertAllowedRegistryUrl("https://unknown.infolens.test/index.json", { officialUrl }), (error) => error.code === "REGISTRY_URL_BLOCKED");
  const invalid = indexWith({ ...release(), artifact: { ...release().artifact, url: "https://unknown.infolens.test/plugin.zip" } });
  assert.throws(() => validateMarketIndex(invalid, { indexUrl: officialUrl }), (error) => error.code === "REGISTRY_URL_BLOCKED");
  assert.throws(() => validateMarketIndex(indexWith({ ...release(), id: "reader" }), { indexUrl: officialUrl }), (error) => error.code === "REGISTRY_INVALID");
  assert.throws(() => validateMarketIndex({ version: 1, releases: [release()] }, { indexUrl: officialUrl }), (error) => error.code === "REGISTRY_SCHEMA_UNSUPPORTED");

  let calls = 0;
  const fetched = await fetchMarketIndex({
    registryUrl: officialUrl,
    transport: async (url) => { calls += 1; return response(url, JSON.stringify(indexWith(release()))); },
  });
  assert.equal(calls, 1);
  assert.equal(fetched.index.releases[0].pluginId, "reader");
});

test("Market publication creates an immutable artifact and rejects duplicate releases", async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "infolens-market-publish-"));
  const packageRoot = path.join(temporaryRoot, "reader");
  const registryRoot = path.join(temporaryRoot, "registry");
  try {
    await mkdir(path.join(packageRoot, "backend"), { recursive: true });
    await mkdir(path.join(packageRoot, "web"), { recursive: true });
    await mkdir(path.join(packageRoot, "node_modules", "ignored"), { recursive: true });
    await writeFile(path.join(packageRoot, "manifest.json"), JSON.stringify({ id: "reader", name: "Reader", version: "1.0.0", contractVersion: "2", minHostVersion: "0.1.0" }));
    await writeFile(path.join(packageRoot, "backend", "index.mjs"), "export {};\n");
    await writeFile(path.join(packageRoot, "web", "index.html"), "<!doctype html>\n");
    await writeFile(path.join(packageRoot, "node_modules", "ignored", "index.js"), "ignored\n");

    await assert.rejects(publishMarketRelease({
      packageRoot,
      registryRoot: path.join(temporaryRoot, "approval-registry"),
      indexUrl: officialUrl,
      metadata: { officialUrl, description: "A published reader", publisher: "Maintainer", license: "MIT", categories: ["Tools"], changelog: "Initial release", platforms: ["windows"], architectures: ["x64"] },
    }), (error) => error.code === "PUBLISH_APPROVAL_REQUIRED");

    const published = await publishMarketRelease({
      packageRoot,
      registryRoot,
      indexUrl: officialUrl,
      metadata: { officialUrl, description: "A published reader", publisher: "Maintainer", approval: approval(), license: "MIT", categories: ["Tools"], changelog: "Initial release", platforms: ["windows"], architectures: ["x64"] },
    });
    const index = JSON.parse(await readFile(path.join(registryRoot, "index.json"), "utf8"));
    const artifact = await readFile(published.artifactPath);
    assert.equal(index.releases[0].artifact.size, artifact.length);
    assert.equal(index.releases[0].artifact.sha256, digest(artifact));
    assert.equal(inspectZip(artifact).entries.some(({ name }) => name.startsWith("node_modules/")), false);
    await assert.rejects(publishMarketRelease({
      packageRoot,
      registryRoot,
      indexUrl: officialUrl,
      metadata: { officialUrl, description: "A published reader", publisher: "Maintainer", approval: approval(), license: "MIT", categories: ["Tools"], changelog: "Initial release", platforms: ["windows"], architectures: ["x64"] },
    }), (error) => error.code === "RELEASE_EXISTS");
    assert.equal((await readdir(path.join(registryRoot, "artifacts", "reader"))).length, 1);

    const orphanStage = path.join(registryRoot, ".publish-reader-2.0.0-interrupted");
    const orphanArtifact = path.join(registryRoot, "artifacts", "reader", "2.0.0.zip");
    const orphanBytes = Buffer.from("orphan artifact");
    await mkdir(orphanStage, { recursive: true });
    await writeFile(orphanArtifact, orphanBytes);
    await writeFile(path.join(orphanStage, "publication.json"), JSON.stringify({
      version: 1,
      releaseKey: "reader@2.0.0",
      artifactSha256: digest(orphanBytes),
      artifactPath: orphanArtifact,
      indexPath: path.join(registryRoot, "index.json"),
      previousIndexPath: path.join(orphanStage, "previous-index.json"),
      hadIndex: true,
      artifactPublished: true,
      indexPublished: false,
    }));
    await writeFile(path.join(packageRoot, "manifest.json"), JSON.stringify({ id: "reader", name: "Reader", version: "2.0.0", contractVersion: "2", minHostVersion: "0.1.0" }));
    const recovered = await publishMarketRelease({
      packageRoot,
      registryRoot,
      indexUrl: officialUrl,
      metadata: { officialUrl, description: "A recovered reader", publisher: "Maintainer", approval: approval(), license: "MIT", categories: ["Tools"], changelog: "Recovered release", platforms: ["windows"], architectures: ["x64"] },
    });
    assert.equal(recovered.release.version, "2.0.0");
    assert.equal(digest(await readFile(orphanArtifact)), recovered.release.artifact.sha256);
    assert.notEqual(recovered.release.artifact.sha256, digest(orphanBytes));
    await assert.rejects(access(orphanStage));

    await writeFile(path.join(packageRoot, "manifest.json"), JSON.stringify({ id: "reader", name: "Reader", version: "3.0.0", contractVersion: "2", minHostVersion: "0.1.0" }));
    await assert.rejects(publishMarketRelease({
      packageRoot,
      registryRoot,
      indexUrl: officialUrl,
      metadata: { officialUrl, description: "An impersonating reader", publisher: "Other Publisher", approval: approval("Other Publisher"), license: "MIT", categories: ["Tools"], changelog: "Impersonating release", platforms: ["windows"], architectures: ["x64"] },
    }), (error) => error.code === "PUBLISHER_BINDING_CONFLICT");
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("Market catalog uses a validated cache, explains compatibility, and requires a current connection to install", async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "infolens-market-catalog-"));
  const cachePath = path.join(temporaryRoot, "catalog.json");
  const tempRoot = path.join(temporaryRoot, "installations");
  const good = release({ version: "1.0.0" });
  const newer = release({ version: "2.0.0" });
  const retracted = release({ version: "3.0.0", retraction: { reason: "Security issue" } });
  const incompatible = release({ version: "4.0.0", minHostVersion: "9.0.0" });
  const index = indexWith(good, newer, retracted, incompatible);
  const payloads = new Map([[officialUrl, Buffer.from(JSON.stringify(index))], ...index.releases.map((candidate) => [candidate.artifact.url, Buffer.from(`artifact-${candidate.version}`)])]);
  const requested = [];
  let reachable = true;
  const reconciled = [];
  const transport = async (url) => {
    requested.push(url);
    if (!reachable) throw new Error("offline");
    const body = payloads.get(url);
    if (!body) throw new Error(`unexpected URL ${url}`);
    return response(url, body);
  };
  const service = new PluginMarketService({
    registryUrl: officialUrl,
    cachePath,
    tempRoot,
    transport,
    hostVersion: "1.0.0",
    contractVersion: "2",
    platform: "win32",
    architecture: "x64",
    runtimeClient: async () => ({ ok: true }),
    reconcileProvenance: async (value) => reconciled.push(value),
  });
  try {
    const initial = await service.initialize();
    assert.equal(initial.offline, true);
    await assert.rejects(service.install("reader", "1.0.0"), (error) => error.code === "MARKET_REGISTRY_CONNECTION_REQUIRED");
    const refreshed = await service.refreshCatalog();
    assert.equal(refreshed.connected, true);
    assert.equal(reconciled.length, 1);
    const catalog = service.catalog("tools reader");
    assert.equal(catalog.plugins[0].latestCompatible, "2.0.0");
    assert.equal(catalog.plugins[0].releases.find(({ version }) => version === "3.0.0").installable, false);
    assert.equal(catalog.plugins[0].releases.find(({ version }) => version === "4.0.0").compatibility.reasons[0].code, "INCOMPATIBLE_HOST");
    assert.equal(latestCompatibleRelease(catalog.plugins[0].releases, { hostVersion: "1.0.0", contractVersion: "2", platform: "win32", architecture: "x64" }).version, "2.0.0");

    reachable = false;
    await assert.rejects(service.refreshCatalog(), (error) => error.code === "REGISTRY_UNAVAILABLE");
    assert.equal(service.catalog().offline, true);
    await assert.rejects(service.install("reader", "1.0.0"), (error) => error.code === "MARKET_REGISTRY_CONNECTION_REQUIRED");

    const cachedService = new PluginMarketService({ registryUrl: officialUrl, cachePath, tempRoot: path.join(temporaryRoot, "cached-installations"), transport, hostVersion: "1.0.0", contractVersion: "2", platform: "win32", architecture: "x64", runtimeClient: async () => ({ ok: true }) });
    const cached = await cachedService.initialize();
    assert.equal(cached.offline, true);
    assert.equal(cached.index.releases.length, 4);
    assert.ok(Number.isFinite(cached.cacheAgeMs));
    assert.ok(requested.includes(officialUrl));
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("Market installation exposes stable phases, cleans temporary state, cancels, and retries from scratch", async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "infolens-market-install-"));
  const cachePath = path.join(temporaryRoot, "catalog.json");
  const installRoot = path.join(temporaryRoot, "installations");
  const artifact = Buffer.from("stable-artifact");
  const candidate = release({ pluginId: "installable", version: "1.0.0", bytes: artifact });
  const slowBytes = Buffer.from("slow-artifact");
  const slow = release({ pluginId: "slow", version: "1.0.0", bytes: slowBytes });
  let candidateCalls = 0;
  let runtimeCalls = 0;
  let runtimeFailure = false;
  const events = [];
  const transport = async (url) => {
    if (url === officialUrl) return response(url, JSON.stringify(indexWith(candidate, slow)));
    if (url === candidate.artifact.url) return response(url, candidateCalls++ === 1 ? Buffer.alloc(artifact.length, 0x78) : artifact);
    if (url === slow.artifact.url) {
      return {
        ok: true,
        status: 200,
        url,
        headers: new Headers({ "content-length": String(slowBytes.length) }),
        body: (async function* () {
          yield slowBytes.subarray(0, 4);
          await new Promise((resolve) => setTimeout(resolve, 80));
          yield slowBytes.subarray(4);
        })(),
      };
    }
    throw new Error(`unexpected URL ${url}`);
  };
  const service = new PluginMarketService({
    registryUrl: officialUrl,
    cachePath,
    tempRoot: installRoot,
    transport,
    hostVersion: "1.0.0",
    contractVersion: "2",
    platform: "win32",
    architecture: "x64",
    runtimeClient: async ({ archivePath }) => { runtimeCalls += 1; await access(archivePath); if (runtimeFailure) throw Object.assign(new Error("Plugin ID is already installed"), { code: "DUPLICATE_PLUGIN_ID" }); return { installed: true }; },
    logger: async (event) => events.push(event),
  });
  try {
    await service.initialize();
    await service.refreshCatalog();
    const phases = [];
    const successful = await service.install("installable", "1.0.0", { onProgress: (operation) => phases.push(operation.phase) });
    assert.equal(successful.result.installed, true);
    assert.deepEqual([...new Set(phases)], ["download", "verification", "extraction", "package-validation", "activation", "complete"]);
    assert.equal(runtimeCalls, 1);
    assert.equal((await readdir(installRoot)).length, 0);

    let cancelledOperation;
    await assert.rejects(service.install("slow", "1.0.0", { onProgress: (operation) => {
      if (operation.phase === "download" && !cancelledOperation) {
        cancelledOperation = operation.operationId;
        assert.equal(service.cancel(operation.operationId), true);
      }
    } }), (error) => error.code === "MARKET_INSTALL_CANCELLED");
    assert.equal(service.operation(cancelledOperation).state, "cancelled");
    assert.equal((await readdir(installRoot)).length, 0);

    let failedOperation;
    await assert.rejects(service.install("installable", "1.0.0"), (error) => { failedOperation = error.operationId; return error.code === "MARKET_DIGEST_MISMATCH"; });
    assert.equal(service.operation(failedOperation).state, "failed");
    const retried = await service.retry(failedOperation);
    assert.notEqual(retried.operationId, failedOperation);
    assert.equal(service.operation(retried.operationId).previousOperationId, failedOperation);
    assert.equal(events.some((event) => event.event === "market-install-retried" && event.previousOperationId === failedOperation), true);
    assert.equal(runtimeCalls, 2);
    assert.equal((await readdir(installRoot)).length, 0);

    runtimeFailure = true;
    let runtimeFailureOperation;
    await assert.rejects(service.install("installable", "1.0.0"), (error) => { runtimeFailureOperation = error.operationId; return error.code === "DUPLICATE_PLUGIN_ID"; });
    assert.equal(service.operation(runtimeFailureOperation).error.code, "DUPLICATE_PLUGIN_ID");
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("Market download timeout covers an async body that ignores AbortSignal", async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "infolens-market-timeout-"));
  const candidate = release({ pluginId: "timeout", version: "1.0.0", bytes: Buffer.from("timeout-artifact") });
  const transport = async (url) => {
    if (url === officialUrl) return response(url, JSON.stringify(indexWith(candidate)));
    return {
      ok: true,
      status: 200,
      url,
      headers: new Headers({ "content-length": String(candidate.artifact.size) }),
      body: (async function* () {
        yield Buffer.from("t");
        await new Promise((resolve) => setTimeout(resolve, 80));
        yield Buffer.from("imeout-artifact");
      })(),
    };
  };
  const service = new PluginMarketService({
    registryUrl: officialUrl,
    cachePath: path.join(temporaryRoot, "catalog.json"),
    tempRoot: path.join(temporaryRoot, "installations"),
    transport,
    limits: { requestTimeoutMs: 10 },
    hostVersion: "1.0.0",
    contractVersion: "2",
    platform: "win32",
    architecture: "x64",
    runtimeClient: async () => ({ ok: true }),
  });
  try {
    await service.initialize();
    await service.refreshCatalog();
    await assert.rejects(service.install("timeout", "1.0.0"), (error) => error.code === "MARKET_DOWNLOAD_TIMEOUT");
    assert.equal((await readdir(path.join(temporaryRoot, "installations"))).length, 0);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("Market startup preserves the default cache while clearing abandoned operations", async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "infolens-market-cache-restart-"));
  const candidate = release({ version: "1.0.0" });
  const transport = async (url) => response(url, JSON.stringify(indexWith(candidate)));
  try {
    const first = new PluginMarketService({ registryUrl: officialUrl, tempRoot: temporaryRoot, transport, hostVersion: "1.0.0", contractVersion: "2", platform: "win32", architecture: "x64" });
    await first.initialize();
    await first.refreshCatalog();
    const abandoned = path.join(temporaryRoot, "abandoned-operation");
    await mkdir(abandoned, { recursive: true });
    await writeFile(path.join(abandoned, "artifact.zip"), "partial");

    const restarted = new PluginMarketService({ registryUrl: officialUrl, tempRoot: temporaryRoot, transport: async () => { throw new Error("network should not be needed"); }, hostVersion: "1.0.0", contractVersion: "2", platform: "win32", architecture: "x64" });
    const snapshot = await restarted.initialize();
    assert.equal(snapshot.index.releases[0].version, "1.0.0");
    await assert.rejects(access(abandoned));
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("invalid cached indexes are ignored instead of replacing a valid catalog", async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "infolens-market-invalid-cache-"));
  try {
    const cachePath = path.join(temporaryRoot, "catalog.json");
    await writeFile(cachePath, JSON.stringify({ version: 1, cachedAt: new Date().toISOString(), indexUrl: officialUrl, index: { schemaVersion: 1, releases: [{ broken: true }] } }));
    const service = new PluginMarketService({ registryUrl: officialUrl, cachePath, tempRoot: path.join(temporaryRoot, "tmp") });
    assert.equal((await service.initialize()).index, undefined);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
