import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  createDeterministicZip,
  extractZip,
  inspectZip,
  sha256File,
} from "../packages/plugin-distribution/src/archive.mjs";
import {
  describeDistributionArtifact,
  distributionDescriptionPath,
  digestCompanionPath,
  normalizeSha256,
  readDigestCompanion,
  sha256Buffer,
  writeDigestCompanion,
  writeDistributionDescription,
} from "../packages/plugin-distribution/src/artifact.mjs";
import { PluginDistributionModule } from "../packages/plugin-distribution/src/module.mjs";
import {
  downloadDistributionSource,
  normalizeDistributionSource,
  stageLocalDistributionSource,
} from "../packages/plugin-distribution/src/source.mjs";
import { HostStateStore } from "../packages/plugin-runtime/src/host-state.mjs";

function response(url, bytes, { status = 200, headers = {} } = {}) {
  const body = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  return {
    ok: status >= 200 && status < 300,
    status,
    url,
    headers: new Headers({ "content-length": String(body.length), ...headers }),
    body: (async function* responseBody() { yield body; })(),
  };
}

test("Plugin ZIP artifacts are deterministic and enforce the archive safety boundary", async () => {
  const first = createDeterministicZip([
    { path: "web/index.html", data: "<title>Reader</title>" },
    { path: "manifest.json", data: "{}" },
  ]);
  const second = createDeterministicZip([
    { path: "manifest.json", data: "{}" },
    { path: "web/index.html", data: "<title>Reader</title>" },
  ]);
  assert.deepEqual(first, second);
  assert.deepEqual(inspectZip(first).entries.map(({ name }) => name), ["manifest.json", "web/index.html"]);
  assert.throws(() => createDeterministicZip([{ path: "../escape", data: "x" }]), { code: "ARCHIVE_PATH_TRAVERSAL" });
  assert.throws(() => createDeterministicZip([{ path: "same", data: "1" }, { path: "same", data: "2" }]), { code: "ARCHIVE_DUPLICATE_ENTRY" });
  assert.throws(() => inspectZip(first.subarray(0, -1)), { code: "ARCHIVE_INVALID" });
  const malformedCentral = Buffer.from(first);
  const malformedCentralEnd = malformedCentral.length - 22;
  malformedCentral.writeUInt32LE(malformedCentral.readUInt32LE(malformedCentralEnd + 12) - 1, malformedCentralEnd + 12);
  assert.throws(() => inspectZip(malformedCentral), { code: "ARCHIVE_INVALID" });

  const symlinkArchive = Buffer.from(first);
  const end = symlinkArchive.length - 22;
  const centralOffset = symlinkArchive.readUInt32LE(end + 16);
  symlinkArchive.writeUInt32LE(0xa0000000, centralOffset + 38);
  assert.throws(() => inspectZip(symlinkArchive), { code: "ARCHIVE_SYMLINK" });

  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "infolens-distribution-archive-"));
  try {
    const oversizedPath = path.join(temporaryRoot, "oversized.zip");
    await writeFile(oversizedPath, "12", "utf8");
    await assert.rejects(sha256File(oversizedPath, { maxArchiveBytes: 1 }), { code: "ARCHIVE_TOO_LARGE" });
    const extracted = await extractZip(first, path.join(temporaryRoot, "staged"));
    assert.equal(await readFile(path.join(extracted.destination, "manifest.json"), "utf8"), "{}");
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("distribution artifacts publish a digest companion and machine-readable description", async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "infolens-distribution-artifact-"));
  try {
    const archivePath = path.join(temporaryRoot, "reader.zip");
    const archive = createDeterministicZip([{ path: "manifest.json", data: "{}" }]);
    await writeFile(archivePath, archive);
    const digest = sha256Buffer(archive);
    assert.equal(normalizeSha256(digest.toUpperCase()), digest);
    await writeDigestCompanion(archivePath, digest);
    assert.equal((await readDigestCompanion(archivePath)).sha256, digest);
    assert.match(await readFile(digestCompanionPath(archivePath), "utf8"), new RegExp(`${digest}\\s+reader\\.zip`));

    const description = await describeDistributionArtifact(archivePath, {
      pluginId: "reader",
      version: "1.0.0",
      contractVersion: "2",
      minHostVersion: "0.2.0",
      sha256: digest,
      builtAt: "2026-08-26T00:00:00.000Z",
    });
    assert.equal(description.schemaVersion, 1);
    assert.deepEqual(description.plugin, { id: "reader", version: "1.0.0", contractVersion: "2", minHostVersion: "0.2.0" });
    assert.deepEqual(description.artifact, { file: "reader.zip", size: archive.length, sha256: digest });
    await writeDistributionDescription(archivePath, description);
    assert.deepEqual(JSON.parse(await readFile(distributionDescriptionPath(archivePath), "utf8")), description);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("local and HTTPS sources normalize, verify, and clean staged artifacts", async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "infolens-distribution-source-"));
  try {
    const archivePath = path.join(temporaryRoot, "reader.zip");
    const archive = createDeterministicZip([{ path: "manifest.json", data: "{}" }]);
    await writeFile(archivePath, archive);
    const digest = sha256Buffer(archive);
    await writeDigestCompanion(archivePath, digest);
    const staged = await stageLocalDistributionSource(archivePath, path.join(temporaryRoot, "stage", "source.zip"));
    assert.equal(staged.sha256, digest);
    assert.equal(staged.expectedSha256, digest);

    const mismatchDestination = path.join(temporaryRoot, "stage", "mismatch.zip");
    await assert.rejects(stageLocalDistributionSource({ kind: "local", path: archivePath, expectedSha256: "0".repeat(64) }, mismatchDestination), { code: "DISTRIBUTION_DIGEST_MISMATCH" });
    await assert.rejects(access(mismatchDestination), { code: "ENOENT" });
    assert.throws(() => normalizeDistributionSource({ kind: "url", url: "http://example.test/plugin.zip", expectedSha256: digest }), { code: "DISTRIBUTION_URL_UNSUPPORTED" });
    assert.throws(() => normalizeDistributionSource({ kind: "url", url: "https://example.test/plugin.zip" }), { code: "DISTRIBUTION_EXPECTED_DIGEST_REQUIRED" });

    const url = "https://downloads.example.test/reader.zip";
    const redirected = "https://cdn.example.test/reader.zip";
    const downloaded = await downloadDistributionSource({ kind: "url", url, expectedSha256: digest }, path.join(temporaryRoot, "stage", "download.zip"), {
      transport: async (requested) => requested === url
        ? response(requested, "", { status: 302, headers: { location: redirected } })
        : response(requested, archive),
    });
    assert.equal(downloaded.url, redirected);
    assert.equal(downloaded.sha256, digest);

    const badDestination = path.join(temporaryRoot, "stage", "bad-download.zip");
    await assert.rejects(downloadDistributionSource({ kind: "url", url, expectedSha256: "f".repeat(64) }, badDestination, {
      transport: async (requested) => response(requested, archive),
    }), { code: "DISTRIBUTION_DIGEST_MISMATCH" });
    await assert.rejects(access(badDestination), { code: "ENOENT" });

    const unboundedDestination = path.join(temporaryRoot, "stage", "unbounded.zip");
    await assert.rejects(downloadDistributionSource({ kind: "url", url, expectedSha256: digest }, unboundedDestination, {
      transport: async () => ({ ok: true, status: 200, headers: new Headers(), arrayBuffer: async () => archive.buffer }),
    }), { code: "DISTRIBUTION_STREAM_UNAVAILABLE" });
    await assert.rejects(access(unboundedDestination), { code: "ENOENT" });
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("the Distribution Module exposes idempotent operations and cancellation", async () => {
  const module = new PluginDistributionModule({
    idFactory: () => "distribution-operation-1",
    execute: async ({ update, source }) => {
      update({ phase: "source-transfer", progress: { received: 1, total: 1 } });
      return { source: source.kind };
    },
  });
  const submitted = await module.submit({ source: { kind: "local", path: path.resolve("reader.zip") } });
  assert.equal(submitted.operationId, "distribution-operation-1");
  assert.equal("promise" in submitted, false);
  assert.equal((await module.submit({ operationId: submitted.operationId, source: { kind: "local", path: path.resolve("reader.zip") } })).operationId, submitted.operationId);
  const completed = await module.wait(submitted.operationId);
  assert.equal(completed.state, "completed");
  assert.deepEqual(completed.result, { source: "local" });

  const slowModule = new PluginDistributionModule({
    execute: async ({ signal }) => new Promise((resolve, reject) => {
      const timer = setTimeout(() => resolve({ ok: true }), 5_000);
      signal.addEventListener("abort", () => { clearTimeout(timer); const error = new Error("cancelled"); error.code = "DISTRIBUTION_CANCELLED"; reject(error); }, { once: true });
    }),
  });
  const slow = await slowModule.submit({ source: { kind: "local", path: path.resolve("reader.zip") } });
  assert.equal(slowModule.cancel(slow.operationId), true);
  assert.equal((await slowModule.wait(slow.operationId)).state, "cancelled");
});

test("legacy Market provenance migrates once into the Distribution Host State contract", async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "infolens-distribution-state-"));
  try {
    const statePath = path.join(temporaryRoot, "host-state.json");
    await mkdir(temporaryRoot, { recursive: true });
    await writeFile(statePath, JSON.stringify({
      version: 2,
      enabledPluginIds: ["remote-reader", "local-reader"],
      lastSelection: "remote-reader",
      theme: "dark",
      statusSnapshots: {},
      pluginInstallations: {
        "remote-reader": {
          origin: "market",
          version: "1.0.0",
          artifactUrl: "https://downloads.example.test/remote-reader.zip",
          expectedSha256: "A".repeat(64),
          observedSha256: "B".repeat(64),
          publisher: "Legacy Registry",
          releaseStatus: "current",
          retractionReason: "obsolete",
          installedAt: "2026-08-01T00:00:00.000Z",
        },
        "local-reader": {
          origin: "market",
          version: "2.0.0",
          fileName: "local-reader.zip",
          categories: ["Tools"],
        },
      },
    }, null, 2));
    const store = new HostStateStore(statePath);
    const state = await store.load();
    assert.equal(state.distributionMigrationVersion, 1);
    assert.equal(state.pluginInstallations["remote-reader"].origin, "url");
    assert.equal(state.pluginInstallations["remote-reader"].sourceUrl, "https://downloads.example.test/remote-reader.zip");
    assert.equal(state.pluginInstallations["local-reader"].origin, "local");
    assert.equal(state.pluginInstallations["local-reader"].sourceFileName, "local-reader.zip");
    assert.equal("publisher" in state.pluginInstallations["remote-reader"], false);
    assert.equal("releaseStatus" in state.pluginInstallations["remote-reader"], false);
    const persisted = JSON.parse(await readFile(statePath, "utf8"));
    assert.equal(persisted.version, 3);
    assert.equal(persisted.pluginInstallations["remote-reader"].origin, "url");
    assert.equal(JSON.stringify(persisted).includes("market"), false);
    assert.deepEqual(await readdir(temporaryRoot), ["host-state.json"]);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
