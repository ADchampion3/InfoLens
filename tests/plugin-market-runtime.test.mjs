import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { writeDeterministicZip } from "@infolens/plugin-market/archive";

const root = path.resolve(import.meta.dirname, "..");
const openCliRoot = path.join(root, "tests", "fixtures", "plugin-contract", "opencli");
const officialUrl = "https://market.infolens.test/v1/index.json";

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function createPlugin(packageRoot, id, { valid = true } = {}) {
  await mkdir(path.join(packageRoot, "backend"), { recursive: true });
  await mkdir(path.join(packageRoot, "web"), { recursive: true });
  await writeFile(path.join(packageRoot, "manifest.json"), JSON.stringify({
    id,
    name: "Market Reader",
    version: "1.0.0",
    contractVersion: "2",
    minHostVersion: "0.1.0",
    backend: { entry: "backend/index.mjs" },
    ui: { entry: "web/index.html" },
    openCliAdapters: {},
    openCliCommands: { read: { adapter: "builtin", site: "fixture", command: ["fixture", "read"], strategy: "PUBLIC", access: "read", outputFormat: "json" } },
  }, null, 2));
  await writeFile(path.join(packageRoot, "web", "index.html"), "<!doctype html><title>Market Reader</title>\n");
  await writeFile(path.join(packageRoot, "backend", "index.mjs"), valid
    ? "export async function activate(context) { context.setHealth({ state: \"ready\" }); context.route(\"GET\", \"/summary\", () => ({ source: \"market\" })); return { deactivate() {} }; }\n"
    : "export {};\n");
}

async function createArtifact(temporaryRoot, id, options) {
  const packageRoot = path.join(temporaryRoot, `${id}-package`);
  await createPlugin(packageRoot, id, options);
  const archivePath = path.join(temporaryRoot, `${id}.zip`);
  const artifact = await writeDeterministicZip(packageRoot, archivePath);
  const release = {
    pluginId: id,
    name: "Market Reader",
    description: "A trusted market fixture",
    publisher: "Infolens Maintainer",
    license: "MIT",
    categories: ["Sources"],
    version: "1.0.0",
    changelog: "Initial release",
    contractVersion: "2",
    minHostVersion: "0.1.0",
    platforms: ["windows"],
    architectures: ["x64"],
    artifact: { url: new URL(`artifacts/${id}-1.0.0.zip`, officialUrl).toString(), size: artifact.size, sha256: artifact.sha256 },
    publishedAt: "2026-08-15T00:00:00.000Z",
    registryUrl: officialUrl,
    indexUrl: officialUrl,
  };
  return { packageRoot, archivePath, release };
}

function startRuntime(temporaryRoot, environment = {}) {
  const child = spawn(process.execPath, [path.join(root, "packages", "plugin-runtime", "src", "server.mjs")], {
    cwd: root,
    env: {
      ...process.env,
      INFOLENS_PROJECT_ROOT: root,
      INFOLENS_PLUGINS_ROOT: path.join(temporaryRoot, "plugins"),
      INFOLENS_PLUGIN_DATA_ROOT: path.join(temporaryRoot, "data", "plugins"),
      INFOLENS_HOST_STATE_PATH: path.join(temporaryRoot, "data", "host-state.json"),
      INFOLENS_ADAPTER_REGISTRY_ROOT: path.join(temporaryRoot, "data", "opencli-adapters"),
      INFOLENS_BUNDLED_OPENCLI_ROOT: openCliRoot,
      INFOLENS_RUNTIME_PORT: "0",
      ...environment,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const errors = [];
  child.stderr.on("data", (chunk) => errors.push(String(chunk)));
  const lines = readline.createInterface({ input: child.stdout });
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Runtime timed out: ${errors.join("")}`)), 5000);
    child.once("error", reject);
    child.once("exit", (code) => reject(new Error(`Runtime exited with ${code}: ${errors.join("")}`)));
    lines.on("line", (line) => {
      const message = JSON.parse(line);
      if (message.type === "runtime-ready") { clearTimeout(timeout); resolve({ child, info: message }); }
    });
  });
}

async function stopRuntime(child) {
  if (child.exitCode !== null) return;
  const exited = new Promise((resolve) => child.once("exit", resolve));
  child.stdin.write("shutdown\n");
  child.stdin.end();
  await exited;
}

async function request(origin, route, options = {}) {
  const response = await fetch(`${origin}${route}`, { headers: { "content-type": "application/json", ...options.headers }, ...options });
  let body = {};
  try { body = await response.json(); } catch {}
  return { response, body };
}

test("Market archives install through Runtime, retain provenance, reconcile retraction, and remove cleanly", async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "infolens-market-runtime-"));
  const archive = await createArtifact(temporaryRoot, "market-reader");
  const rejectedRoot = path.join(temporaryRoot, "plugins", "rejected-package");
  await mkdir(rejectedRoot, { recursive: true });
  await writeFile(path.join(rejectedRoot, "manifest.json"), "{}\n");
  let running;
  try {
    running = await startRuntime(temporaryRoot);
    const origin = running.info.origin;
    const install = await request(origin, "/runtime/plugins/install-market", {
      method: "POST",
      headers: { "x-infolens-operation-id": "market-install-1" },
      body: JSON.stringify({ archivePath: archive.archivePath, expectedSha256: archive.release.artifact.sha256, observedSha256: archive.release.artifact.sha256, release: archive.release }),
    });
    assert.equal(install.response.status, 201);
    assert.equal(install.body.pluginId, "market-reader");
    const info = await request(origin, "/runtime/info");
    const installed = info.body.plugins.find(({ id }) => id === "market-reader");
    assert.equal(installed.origin, "market");
    assert.equal(installed.provenance.publisher, "Infolens Maintainer");
    assert.equal(installed.provenance.expectedSha256, archive.release.artifact.sha256);
    assert.equal(installed.provenance.observedSha256, archive.release.artifact.sha256);
    assert.equal(installed.provenance.releaseStatus, "current");
    assert.equal(JSON.parse(await readFile(path.join(archive.packageRoot, "manifest.json"))).publisher, undefined);
    assert.deepEqual((await request(origin, "/plugins/market-reader/api/summary")).body, { source: "market" });

    const duplicate = await request(origin, "/runtime/plugins/install-market", {
      method: "POST",
      body: JSON.stringify({ archivePath: archive.archivePath, expectedSha256: archive.release.artifact.sha256, release: archive.release }),
    });
    assert.equal(duplicate.response.status, 409);
    assert.equal(duplicate.body.code, "DUPLICATE_PLUGIN_ID");
    await access(path.join(temporaryRoot, "plugins", "market-reader", "manifest.json"));

    const retracted = { ...archive.release, retraction: { reason: "Security issue" } };
    const reconciliation = await request(origin, "/runtime/plugins/reconcile-market", { method: "POST", body: JSON.stringify({ releases: [retracted] }) });
    assert.equal(reconciliation.response.status, 200);
    const afterRetraction = await request(origin, "/runtime/info");
    const retained = afterRetraction.body.plugins.find(({ id }) => id === "market-reader");
    assert.equal(retained.releaseStatus, "retracted");
    assert.equal(retained.provenance.retractionReason, "Security issue");
    assert.deepEqual((await request(origin, "/plugins/market-reader/api/summary")).body, { source: "market" });

    const removal = await request(origin, "/runtime/plugins/market-reader/remove", { method: "DELETE" });
    assert.equal(removal.response.status, 200);
    await assert.rejects(access(path.join(temporaryRoot, "plugins", "market-reader")));
    await assert.rejects(access(path.join(temporaryRoot, "data", "plugins", "market-reader")));
    const removedInfo = await request(origin, "/runtime/info");
    assert.equal(removedInfo.body.hostState.pluginInstallations["market-reader"], undefined);

    const rejectedRemoval = await request(origin, "/runtime/plugins/rejected-package/remove", { method: "DELETE" });
    assert.equal(rejectedRemoval.response.status, 200);
    await assert.rejects(access(rejectedRoot));
  } finally {
    if (running) await stopRuntime(running.child);
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("Market Runtime rejects digest, manifest, and Bundled identity conflicts without installing candidates", async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "infolens-market-runtime-reject-"));
  const valid = await createArtifact(temporaryRoot, "valid-reader");
  const mismatch = await createArtifact(temporaryRoot, "package-reader");
  const bundled = await createArtifact(temporaryRoot, "bundled-reader");
  let running;
  let bundledRunning;
  try {
    running = await startRuntime(temporaryRoot);
    const origin = running.info.origin;
    const digestFailure = await request(origin, "/runtime/plugins/install-market", {
      method: "POST",
      body: JSON.stringify({ archivePath: valid.archivePath, expectedSha256: "0".repeat(64), release: valid.release }),
    });
    assert.equal(digestFailure.response.status, 422);
    assert.equal(digestFailure.body.code, "MARKET_DIGEST_MISMATCH");
    assert.equal((await request(origin, "/runtime/info")).body.plugins.some(({ id }) => id === "valid-reader"), false);

    const mismatchedRelease = { ...mismatch.release, pluginId: "different-reader", artifact: { ...mismatch.release.artifact } };
    const manifestFailure = await request(origin, "/runtime/plugins/install-market", {
      method: "POST",
      body: JSON.stringify({ archivePath: mismatch.archivePath, expectedSha256: mismatch.release.artifact.sha256, release: mismatchedRelease }),
    });
    assert.equal(manifestFailure.response.status, 400);
    assert.equal(manifestFailure.body.code, "MARKET_MANIFEST_MISMATCH");
    assert.equal((await request(origin, "/runtime/info")).body.plugins.some(({ id }) => id === "package-reader"), false);
  } finally {
    if (running) await stopRuntime(running.child);
  }

  try {
    bundledRunning = await startRuntime(temporaryRoot, { INFOLENS_BUNDLED_PLUGIN_IDS: JSON.stringify(["bundled-reader"]) });
    const conflict = await request(bundledRunning.info.origin, "/runtime/plugins/install-market", {
      method: "POST",
      body: JSON.stringify({ archivePath: bundled.archivePath, expectedSha256: bundled.release.artifact.sha256, release: bundled.release }),
    });
    assert.equal(conflict.response.status, 409);
    assert.equal(conflict.body.code, "MARKET_BUNDLED_CONFLICT");
    assert.equal((await request(bundledRunning.info.origin, "/runtime/info")).body.plugins.some(({ id }) => id === "bundled-reader"), false);
  } finally {
    if (bundledRunning) await stopRuntime(bundledRunning.child);
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("local ZIP imports use the shared archive boundary without Market provenance", async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "infolens-local-archive-runtime-"));
  const archive = await createArtifact(temporaryRoot, "local-reader");
  let running;
  try {
    running = await startRuntime(temporaryRoot);
    const origin = running.info.origin;
    const imported = await request(origin, "/runtime/plugins/install-archive", {
      method: "POST",
      headers: { "x-infolens-operation-id": "local-import-1" },
      body: JSON.stringify({ archivePath: archive.archivePath }),
    });
    assert.equal(imported.response.status, 201, JSON.stringify(imported.body));
    assert.equal(imported.body.pluginId, "local-reader");

    const info = await request(origin, "/runtime/info");
    const installed = info.body.plugins.find(({ id }) => id === "local-reader");
    assert.equal(installed.origin, "local");
    assert.equal(installed.provenance.releaseStatus, "unknown");
    assert.equal(installed.provenance.observedSha256, archive.release.artifact.sha256);
    assert.equal(installed.provenance.expectedSha256, undefined);
    assert.equal(installed.provenance.publisher, undefined);

    const duplicate = await request(origin, "/runtime/plugins/install-archive", {
      method: "POST",
      body: JSON.stringify({ archivePath: archive.archivePath }),
    });
    assert.equal(duplicate.response.status, 409);
    assert.equal(duplicate.body.code, "DUPLICATE_PLUGIN_ID");

    await access(path.join(temporaryRoot, "plugins", "local-reader", "manifest.json"));
    const removal = await request(origin, "/runtime/plugins/local-reader/remove", { method: "DELETE" });
    assert.equal(removal.response.status, 200);
    await assert.rejects(access(path.join(temporaryRoot, "plugins", "local-reader")));
  } finally {
    if (running) await stopRuntime(running.child);
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
