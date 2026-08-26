import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { test } from "node:test";
import { writeDeterministicZip } from "../packages/plugin-distribution/src/archive.mjs";

const root = path.resolve(import.meta.dirname, "..");
const openCliRoot = path.join(root, "tests", "fixtures", "plugin-contract", "opencli");
const RUNTIME_TOKEN = "plugin-distribution-runtime-test-session";

async function createPlugin(packageRoot, id, version, { failing = false, deactivateDelayMs = 0 } = {}) {
  await mkdir(path.join(packageRoot, "backend"), { recursive: true });
  await mkdir(path.join(packageRoot, "web"), { recursive: true });
  await writeFile(path.join(packageRoot, "manifest.json"), JSON.stringify({
    id,
    name: "Distribution Reader",
    version,
    contractVersion: "2",
    minHostVersion: "0.1.0",
    backend: { entry: "backend/index.mjs" },
    ui: { entry: "web/index.html" },
    openCliAdapters: {},
    openCliCommands: {},
  }, null, 2));
  await writeFile(path.join(packageRoot, "web", "index.html"), "<!doctype html><title>Distribution Reader</title>\n");
  const lifecycle = deactivateDelayMs > 0
    ? `deactivate() { return new Promise((resolve) => setTimeout(resolve, ${deactivateDelayMs})); }`
    : "deactivate() {}";
  await writeFile(path.join(packageRoot, "backend", "index.mjs"), failing
    ? "export async function activate() { throw Object.assign(new Error(\"replacement failed\"), { code: \"DISTRIBUTION_FIXTURE_ACTIVATION_FAILED\" }); }\n"
    : `export async function activate(context) { context.setHealth({ state: "ready" }); context.route("GET", "/summary", () => ({ version: "${version}" })); return { ${lifecycle} }; }\n`);
}

async function createArtifact(temporaryRoot, id, version, options = {}) {
  const packageRoot = path.join(temporaryRoot, `${id}-${version}-package`);
  await createPlugin(packageRoot, id, version, options);
  const archivePath = path.join(temporaryRoot, `${id}-${version}.zip`);
  const artifact = await writeDeterministicZip(packageRoot, archivePath);
  return { packageRoot, archivePath, ...artifact };
}

function startRuntime(temporaryRoot, environment = {}) {
  const child = spawn(process.execPath, [path.join(root, "packages", "plugin-runtime", "src", "server.mjs")], {
    cwd: root,
    env: {
      ...process.env,
      INFOLENS_PROJECT_ROOT: root,
      INFOLENS_RUNTIME_PREVIEW: "1",
      INFOLENS_PLUGINS_ROOT: path.join(temporaryRoot, "plugins"),
      INFOLENS_PLUGIN_DATA_ROOT: path.join(temporaryRoot, "data", "plugins"),
      INFOLENS_HOST_STATE_PATH: path.join(temporaryRoot, "data", "host-state.json"),
      INFOLENS_ADAPTER_REGISTRY_ROOT: path.join(temporaryRoot, "data", "opencli-adapters"),
      INFOLENS_DISTRIBUTION_ROOT: path.join(temporaryRoot, "data", "plugin-distribution"),
      INFOLENS_BUNDLED_OPENCLI_ROOT: openCliRoot,
      INFOLENS_RUNTIME_PORT: "0",
      INFOLENS_APPLICATION_SESSION_ID: RUNTIME_TOKEN,
      ...environment,
    },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  const errors = [];
  child.stderr.on("data", (chunk) => errors.push(String(chunk)));
  const lines = readline.createInterface({ input: child.stdout });
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Runtime timed out: ${errors.join("")}`)), 10_000);
    child.once("error", reject);
    child.once("exit", (code) => reject(new Error(`Runtime exited with ${code}: ${errors.join("")}`)));
    lines.on("line", (line) => {
      let message;
      try { message = JSON.parse(line); } catch { return; }
      if (message.type === "runtime-ready") { clearTimeout(timeout); resolve({ child, lines, info: message }); }
    });
  });
}

async function stopRuntime(runtime) {
  if (!runtime || runtime.child.exitCode !== null) return;
  const exited = new Promise((resolve) => runtime.child.once("exit", resolve));
  runtime.child.stdin.write("shutdown\n");
  runtime.child.stdin.end();
  await exited;
  runtime.lines.close();
}

async function request(origin, route, options = {}) {
  const response = await fetch(`${origin}${route}`, {
    ...options,
    headers: { "content-type": "application/json", authorization: `Bearer ${RUNTIME_TOKEN}`, ...options.headers },
  });
  let body = {};
  try { body = await response.json(); } catch {}
  return { response, body };
}

async function waitForOperation(origin, operationId) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const current = await request(origin, `/runtime/plugins/distribution/operations/${encodeURIComponent(operationId)}`);
    if (["completed", "failed", "cancelled"].includes(current.body.state)) return current.body;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Distribution operation ${operationId} did not finish`);
}

async function submit(origin, route, body, expectedStatus = 202) {
  const submitted = await request(origin, route, { method: "POST", body: JSON.stringify(body) });
  assert.equal(submitted.response.status, expectedStatus, JSON.stringify(submitted.body));
  return { submitted: submitted.body, operation: await waitForOperation(origin, submitted.body.operationId) };
}

async function submitUpload(origin, archivePath, { intent = "install", pluginId, expectedSha256 } = {}) {
  const response = await fetch(`${origin}/api/v1/plugins/distribution/upload`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${RUNTIME_TOKEN}`,
      "content-type": "application/zip",
      "x-infolens-distribution-intent": intent,
      ...(pluginId ? { "x-infolens-plugin-id": pluginId } : {}),
      ...(expectedSha256 ? { "x-infolens-expected-sha256": expectedSha256 } : {}),
      "x-infolens-distribution-file-name": encodeURIComponent(path.basename(archivePath)),
    },
    body: await readFile(archivePath),
  });
  const body = await response.json();
  assert.equal(response.status, 202, JSON.stringify(body));
  return { submitted: body, operation: await waitForOperation(origin, body.operationId) };
}

test("Runtime installs local ZIPs, replaces transactionally, and rolls back one revision", async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "infolens-distribution-runtime-"));
  const v1 = await createArtifact(temporaryRoot, "distribution-reader", "1.0.0");
  const v2 = await createArtifact(temporaryRoot, "distribution-reader", "2.0.0");
  const failed = await createArtifact(temporaryRoot, "distribution-reader", "3.0.0", { failing: true });
  let runtime;
  try {
    runtime = await startRuntime(temporaryRoot);
    const origin = runtime.info.origin;
    const installed = await submitUpload(origin, v1.outputPath, { expectedSha256: v1.sha256 });
    assert.equal(installed.operation.state, "completed", JSON.stringify(installed.operation));
    assert.equal(installed.operation.source.kind, "local");
    assert.equal(installed.operation.source.fileName, path.basename(v1.outputPath));
    assert.equal(installed.operation.result.version, "1.0.0");
    const infoAfterInstall = await request(origin, "/runtime/info");
    const first = infoAfterInstall.body.plugins.find(({ id }) => id === "distribution-reader");
    assert.equal(first.origin, "local");
    assert.equal(first.provenance.observedSha256, v1.sha256);
    assert.equal(first.provenance.expectedSha256, v1.sha256);
    assert.equal((await request(origin, "/plugins/distribution-reader/api/summary")).body.version, "1.0.0");

    const duplicate = await submit(origin, "/runtime/plugins/install-archive", { archivePath: v1.outputPath, expectedSha256: v1.sha256 });
    assert.equal(duplicate.operation.state, "failed", JSON.stringify(duplicate.operation));
    assert.equal(duplicate.operation.error.code, "DUPLICATE_PLUGIN_ID", JSON.stringify(duplicate.operation));

    const replaced = await submit(origin, "/runtime/plugins/distribution-reader/replace", { archivePath: v2.outputPath, expectedSha256: v2.sha256 });
    assert.equal(replaced.operation.state, "completed", JSON.stringify(replaced.operation));
    const infoAfterReplace = await request(origin, "/runtime/info");
    const current = infoAfterReplace.body.plugins.find(({ id }) => id === "distribution-reader");
    assert.equal(current.version, "2.0.0");
    assert.equal(current.provenance.previousRevision.version, "1.0.0");
    const revisions = await request(origin, "/runtime/plugins/distribution-reader/revisions");
    assert.equal(revisions.body.rollbackAvailable, true);
    assert.equal(revisions.body.current.version, "2.0.0");
    assert.equal(revisions.body.previous.version, "1.0.0");

    const failedReplace = await submit(origin, "/runtime/plugins/distribution-reader/replace", { archivePath: failed.outputPath, expectedSha256: failed.sha256 });
    assert.equal(failedReplace.operation.state, "failed");
    assert.equal(failedReplace.operation.error.code, "DISTRIBUTION_FIXTURE_ACTIVATION_FAILED");
    const afterFailure = await request(origin, "/runtime/info");
    assert.equal(afterFailure.body.plugins.find(({ id }) => id === "distribution-reader").version, "2.0.0");

    const rolledBack = await submit(origin, "/runtime/plugins/distribution-reader/rollback", {});
    assert.equal(rolledBack.operation.state, "completed", JSON.stringify(rolledBack.operation));
    const infoAfterRollback = await request(origin, "/runtime/info");
    const rolled = infoAfterRollback.body.plugins.find(({ id }) => id === "distribution-reader");
    assert.equal(rolled.version, "1.0.0");
    assert.equal((await request(origin, "/plugins/distribution-reader/api/summary")).body.version, "1.0.0");
    const afterRollbackRevisions = await request(origin, "/runtime/plugins/distribution-reader/revisions");
    assert.equal(afterRollbackRevisions.body.rollbackAvailable, true);
    assert.equal(afterRollbackRevisions.body.current.version, "1.0.0");
    assert.equal(afterRollbackRevisions.body.previous.version, "2.0.0");

    const removed = await request(origin, "/runtime/plugins/distribution-reader/remove", { method: "DELETE" });
    assert.equal(removed.response.status, 200, JSON.stringify(removed.body));
    await assert.rejects(access(path.join(temporaryRoot, "plugins", "distribution-reader")), { code: "ENOENT" });
    await assert.rejects(access(path.join(temporaryRoot, "data", "plugins", "distribution-reader")), { code: "ENOENT" });
    await assert.rejects(access(path.join(temporaryRoot, "data", "plugin-distribution", "revisions", "distribution-reader")), { code: "ENOENT" });
  } finally {
    await stopRuntime(runtime);
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("Runtime startup recovers an incomplete install journal before Plugin discovery", async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "infolens-distribution-recovery-"));
  const pluginsRoot = path.join(temporaryRoot, "plugins");
  const distributionRoot = path.join(temporaryRoot, "data", "plugin-distribution");
  const operationId = "crash-install-1";
  const operationRoot = path.join(distributionRoot, "operations", operationId);
  const destinationPath = path.join(pluginsRoot, "crash-reader");
  let runtime;
  try {
    await mkdir(destinationPath, { recursive: true });
    await writeFile(path.join(destinationPath, "manifest.json"), "{}\n");
    await mkdir(path.join(distributionRoot, "journals"), { recursive: true });
    await mkdir(operationRoot, { recursive: true });
    await writeFile(path.join(distributionRoot, "journals", `${operationId}.json`), JSON.stringify({
      version: 1,
      operationId,
      intent: "install",
      pluginId: "crash-reader",
      state: "committing",
      phase: "package-switched",
      createdAt: "2026-08-26T00:00:00.000Z",
      updatedAt: "2026-08-26T00:00:01.000Z",
       paths: { destinationPath, packageCommitted: false },
    }));
    runtime = await startRuntime(temporaryRoot);
    const info = await request(runtime.info.origin, "/runtime/info");
    assert.equal(info.body.plugins.some(({ id }) => id === "crash-reader"), false);
    await assert.rejects(access(destinationPath), { code: "ENOENT" });
    await assert.rejects(access(operationRoot), { code: "ENOENT" });
    const recoveredStatus = JSON.parse(await readFile(path.join(distributionRoot, "status", `${operationId}.json`), "utf8"));
    assert.equal(recoveredStatus.phase, "recovered");
    assert.equal(recoveredStatus.error.code, "DISTRIBUTION_RECOVERED_AFTER_CRASH");
    await assert.rejects(access(path.join(distributionRoot, "journals", `${operationId}.json`)), { code: "ENOENT" });
  } finally {
    await stopRuntime(runtime);
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("Runtime startup keeps the current Plugin after a pre-switch replacement crash", async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "infolens-distribution-pre-switch-recovery-"));
  const packageRoot = path.join(temporaryRoot, "plugins", "current-reader");
  const distributionRoot = path.join(temporaryRoot, "data", "plugin-distribution");
  const operationId = "crash-replace-before-switch";
  const operationRoot = path.join(distributionRoot, "operations", operationId);
  const backupPath = path.join(operationRoot, "current-package");
  let runtime;
  try {
    await createPlugin(packageRoot, "current-reader", "1.0.0");
    await mkdir(path.join(distributionRoot, "journals"), { recursive: true });
    await mkdir(operationRoot, { recursive: true });
    await writeFile(path.join(distributionRoot, "journals", `${operationId}.json`), JSON.stringify({
      version: 1,
      operationId,
      intent: "replace",
      pluginId: "current-reader",
      state: "committing",
      phase: "switching",
      createdAt: "2026-08-26T00:00:00.000Z",
      updatedAt: "2026-08-26T00:00:01.000Z",
      oldEnabled: true,
      paths: { destinationPath: packageRoot, switchBackupPath: backupPath, packageCommitted: false },
    }));
    runtime = await startRuntime(temporaryRoot);
    const info = await request(runtime.info.origin, "/runtime/info");
    const current = info.body.plugins.find(({ id }) => id === "current-reader");
    assert.equal(current.version, "1.0.0");
    assert.notEqual(current.state, "unavailable");
    await assert.rejects(access(backupPath), { code: "ENOENT" });
    await assert.rejects(access(path.join(distributionRoot, "journals", `${operationId}.json`)), { code: "ENOENT" });
  } finally {
    await stopRuntime(runtime);
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("Runtime deactivation timeout does not remove the current Plugin after failure", async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "infolens-distribution-timeout-"));
  const v1 = await createArtifact(temporaryRoot, "slow-reader", "1.0.0", { deactivateDelayMs: 100 });
  const v2 = await createArtifact(temporaryRoot, "slow-reader", "2.0.0");
  let runtime;
  try {
    runtime = await startRuntime(temporaryRoot, { INFOLENS_DEACTIVATION_GRACE_MS: "20" });
    const origin = runtime.info.origin;
    await submitUpload(origin, v1.outputPath, { expectedSha256: v1.sha256 });
    const replacement = await submit(origin, "/runtime/plugins/slow-reader/replace", { archivePath: v2.outputPath, expectedSha256: v2.sha256 });
    assert.equal(replacement.operation.state, "failed", JSON.stringify(replacement.operation));
    assert.equal(replacement.operation.error.code, "RUNTIME_RESTART_REQUIRED");
    await new Promise((resolve) => setTimeout(resolve, 140));
    assert.equal((await request(origin, "/plugins/slow-reader/api/summary")).body.version, "1.0.0");
  } finally {
    await stopRuntime(runtime);
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
