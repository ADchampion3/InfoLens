import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createReleaseManifest, verifyRelease } from "../scripts/verify-release.mjs";
import { loadBundledOpenCli } from "../packages/plugin-runtime/src/opencli-adapter.mjs";
import { diagnoseWorkspaceBundle } from "../packages/plugin-runtime/src/workspace-diagnostics.mjs";

const root = path.resolve(import.meta.dirname, "..");
const cli = path.join(root, "packages", "plugin-sdk", "bin", "infolens-plugin.mjs");
const officialIds = ["hn", "github-trending", "product-hunt", "zhihu-hot"];

async function runCli(cliPath, cwd, args, extraEnvironment = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      cwd,
      env: { ...process.env, ...extraEnvironment },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      let result;
      try { result = JSON.parse(stdout); }
      catch (error) { reject(new Error(`CLI did not return JSON (${code ?? signal}): ${error.message}\n${stdout}\n${stderr}`)); return; }
      resolve({ code, signal, result, stdout, stderr });
    });
  });
}

async function copyPackage(source, destination) {
  await mkdir(destination, { recursive: true });
  for (const entry of ["manifest.json", "package.json", "backend", "web", "opencli-adapters"]) {
    const sourcePath = path.join(source, entry);
    try { await cp(sourcePath, path.join(destination, entry), { recursive: true }); } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  return destination;
}

async function copyPackageBoundary(projectRoot) {
  const entries = [
    ["packages/plugin-sdk", "node_modules/@infolens/plugin-sdk"],
    ["packages/plugin-runtime", "node_modules/@infolens/plugin-runtime"],
    ["packages/release-metadata", "node_modules/@infolens/release-metadata"],
    ["packages/plugin-workspace", "node_modules/@infolens/plugin-workspace"],
    ["resources/opencli", "node_modules/@infolens/bundled-opencli"],
    ["node_modules/semver", "node_modules/semver"],
  ];
  for (const [source, destination] of entries) {
    const target = path.join(projectRoot, destination);
    await mkdir(path.dirname(target), { recursive: true });
    await cp(path.join(root, source), target, { recursive: true });
  }
}

async function createFixture(projectRoot, id, { backend, workspace = "<!doctype html><html><body>fixture</body></html>", commands = {} } = {}) {
  const packageRoot = path.join(projectRoot, id);
  await mkdir(path.join(packageRoot, "backend"), { recursive: true });
  await mkdir(path.join(packageRoot, "web"), { recursive: true });
  await writeFile(path.join(packageRoot, "package.json"), `${JSON.stringify({ name: `fixture-${id}`, version: "1.0.0", type: "module" }, null, 2)}\n`, "utf8");
  await writeFile(path.join(packageRoot, "manifest.json"), `${JSON.stringify({
    id,
    name: id,
    version: "1.0.0",
    contractVersion: "2",
    minHostVersion: "0.2.0",
    backend: { entry: "backend/index.mjs" },
    ui: { entry: "web/index.html" },
    openCliAdapters: {},
    openCliCommands: commands,
  }, null, 2)}\n`, "utf8");
  await writeFile(path.join(packageRoot, "backend", "index.mjs"), backend ?? "export async function activate(context) { context.setHealth({ state: \"ready\" }); }\n", "utf8");
  await writeFile(path.join(packageRoot, "web", "index.html"), workspace, "utf8");
  return packageRoot;
}

function failedCheck(result, code) {
  return result.checks.find((check) => check.code === code && check.severity === "error");
}

test("official Plugins pass the author command matrix and an independent project uses package boundaries", async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "infolens-author-matrix-"));
  try {
    for (const id of officialIds) {
      const packageRoot = path.join(root, "plugins", id);
      const validation = await runCli(cli, root, ["validate", packageRoot]);
      assert.equal(validation.code, 0, `${id} validate failed`);
      assert.equal(validation.result.ok, true);
      assert.equal(validation.result.environment.targetHost.value, "0.2.0");

      const doctor = await runCli(cli, root, ["doctor", packageRoot, "--timeout", "5000"]);
      assert.equal(doctor.code, 0, `${id} doctor failed: ${doctor.result.error?.code ?? "unknown"}`);
      assert.equal(doctor.result.ok, true);
      assert.equal(doctor.result.health.state, "ready");
      assert(doctor.result.registrations);
      assert(doctor.result.workspace.visited.length > 0);

      const output = path.join(temporaryRoot, `${id}.infolens-plugin`);
      const packed = await runCli(cli, root, ["pack", packageRoot, "--out", output, "--timeout", "5000"]);
      assert.equal(packed.code, 0, `${id} pack failed: ${packed.result.error?.code ?? "unknown"}`);
      assert.equal(packed.result.ok, true);
      const integrity = JSON.parse(await readFile(path.join(output, "adapter-integrity.json"), "utf8"));
      assert.equal(integrity.pluginId, id);
      if (id === "hn") {
        const before = await readFile(path.join(output, "adapter-integrity.json"), "utf8");
        const refused = await runCli(cli, root, ["pack", packageRoot, "--out", output, "--timeout", "5000"]);
        assert.notEqual(refused.code, 0);
        assert.equal(refused.result.error.code, "PACK_OUTPUT_EXISTS");
        assert.equal(await readFile(path.join(output, "adapter-integrity.json"), "utf8"), before);
      }
    }

    const independentRoot = path.join(temporaryRoot, "independent-project");
    await mkdir(independentRoot, { recursive: true });
    await writeFile(path.join(independentRoot, "package.json"), "{\"name\":\"independent-plugin-project\",\"private\":true,\"type\":\"module\"}\n", "utf8");
    await copyPackageBoundary(independentRoot);
    const independentPlugin = path.join(independentRoot, "plugins", "hn");
    await copyPackage(path.join(root, "plugins", "hn"), independentPlugin);
    const independentCli = path.join(independentRoot, "node_modules", "@infolens", "plugin-sdk", "bin", "infolens-plugin.mjs");
    const independentValidation = await runCli(independentCli, independentRoot, ["validate", independentPlugin]);
    assert.equal(independentValidation.code, 0);
    assert.equal(independentValidation.result.environment.opencli.value, "1.8.6");
    assert.equal(independentValidation.result.environment.opencli.source, "bundled-opencli-package");
    const independentAdapters = await runCli(independentCli, independentRoot, ["adapters", "list", independentPlugin]);
    assert.equal(independentAdapters.code, 0);
    const independentDoctor = await runCli(independentCli, independentRoot, ["doctor", independentPlugin, "--timeout", "5000"]);
    assert.equal(independentDoctor.code, 0, independentDoctor.result.error?.code);
    const independentDev = await runCli(independentCli, independentRoot, ["dev", independentPlugin]);
    assert.equal(independentDev.code, 0);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("author commands keep target overrides and bootstrap failures explicit", async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "infolens-author-envelope-"));
  try {
    const target = await runCli(cli, root, ["validate", path.join(root, "plugins", "hn"), "--target-host-version", "0.3.0"]);
    assert.equal(target.code, 0);
    assert.equal(target.result.environment.targetHost.value, "0.3.0");
    assert.equal(target.result.environment.targetHost.source, "cli-option");

    const invalidTarget = await runCli(cli, root, ["validate", path.join(root, "plugins", "hn"), "--target-host-version", "next"]);
    assert.notEqual(invalidTarget.code, 0);
    assert.equal(invalidTarget.result.error.code, "INVALID_TARGET_HOST_VERSION");

    const incompatible = await copyPackage(path.join(root, "plugins", "hn"), path.join(temporaryRoot, "contract-fixture"));
    const manifestPath = path.join(incompatible, "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.contractVersion = "99";
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    const contract = await runCli(cli, root, ["validate", incompatible, "--target-host-version", "9.0.0"]);
    assert.notEqual(contract.code, 0);
    assert.equal(contract.result.error.code, "INCOMPATIBLE_CONTRACT");

    const missingOpenCli = await runCli(cli, root, ["validate", path.join(root, "plugins", "hn")], { INFOLENS_BUNDLED_OPENCLI_ROOT: path.join(temporaryRoot, "missing-opencli") });
    assert.notEqual(missingOpenCli.code, 0);
    assert.equal(missingOpenCli.result.error.code, "OPENCLI_RUNTIME_UNAVAILABLE");
    assert.equal(missingOpenCli.result.environment.opencli.value, null);
    assert.equal(missingOpenCli.result.environment.contract.value, "2");
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("doctor reports lifecycle failures and static Workspace findings through the CLI", async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "infolens-author-doctor-"));
  try {
    const fixtures = [
      ["import-failure", "throw Object.assign(new Error(\"import fixture\"), { code: \"IMPORT_FIXTURE_FAILED\" });", "IMPORT_FIXTURE_FAILED", "backend-import"],
      ["missing-activate", "export const activateLater = () => {};", "BACKEND_ACTIVATE_EXPORT_MISSING", "backend-import"],
      ["activation-failure", "export async function activate() { throw Object.assign(new Error(\"activation fixture\"), { code: \"ACTIVATION_FIXTURE_FAILED\" }); }", "ACTIVATION_FIXTURE_FAILED", "activation"],
      ["health-failure", "export async function activate(context) { context.setHealth({ state: \"failed\", message: \"health fixture\" }); }", "PLUGIN_HEALTH_FAILED", "health"],
      ["cleanup-failure", "export async function activate(context) { context.setHealth({ state: \"ready\" }); return { async deactivate() { throw Object.assign(new Error(\"cleanup fixture\"), { code: \"CLEANUP_FIXTURE_FAILED\" }); } }; }", "CLEANUP_FIXTURE_FAILED", "cleanup"],
      ["duplicate-route", "export async function activate(context) { context.route(\"GET\", \"/same\", () => ({})); context.route(\"GET\", \"/same\", () => ({})); }", "DUPLICATE_ROUTE_REGISTRATION", "activation"],
      ["duplicate-task", "export async function activate(context) { context.task(\"same\", () => ({})); context.task(\"same\", () => ({})); }", "DUPLICATE_TASK_REGISTRATION", "activation"],
      ["invalid-task", "export async function activate(context) { context.task(\"bad name\", () => ({})); }", "INVALID_TASK_REGISTRATION", "activation"],
      ["activation-opencli", "export async function activate(context) { await context.opencli.run(\"topStories\"); }", "DIAGNOSTIC_OPENCLI_EXECUTION", "activation"],
      ["activation-timeout", "export async function activate() { await new Promise(() => {}); }", "DIAGNOSTIC_TIMEOUT", "activation", "1000"],
      ["shutdown-timeout", "export async function activate(context) { context.setHealth({ state: \"ready\" }); return { async deactivate() { await new Promise(() => {}); } }; }", "DIAGNOSTIC_TIMEOUT", "shutdown", "1000"],
    ];
    const openCliCommands = {
      topStories: { site: "hackernews", adapter: "builtin", command: ["hackernews", "top"], strategy: "PUBLIC", access: "read", outputFormat: "json" },
    };
    for (const [id, backend, expectedCode, expectedPhase, timeout] of fixtures) {
      const packageRoot = await createFixture(temporaryRoot, id, { backend, commands: id === "activation-opencli" ? openCliCommands : {} });
      const outcome = await runCli(cli, root, ["doctor", packageRoot, "--timeout", timeout ?? "1000"]);
      assert.notEqual(outcome.code, 0, `${id} unexpectedly passed`);
      const check = failedCheck(outcome.result, expectedCode);
      assert(check, `${id} did not report ${expectedCode}: ${JSON.stringify(outcome.result.checks)}`);
      assert.equal(check.phase, expectedPhase, `${id} reported phase ${check.phase}: ${outcome.result.error?.message ?? "no message"}`);
    }

    const valid = await createFixture(temporaryRoot, "registrations", {
      backend: "export async function activate(context) { context.route(\"GET\", \"/status\", () => ({})); context.task(\"idle\", async () => { throw new Error(\"must not run\"); }); context.schedule(\"idle\", { intervalMs: 100, runImmediately: true }); context.setHealth({ state: \"ready\" }); }",
    });
    const validOutcome = await runCli(cli, root, ["doctor", valid, "--timeout", "1000"]);
    assert.equal(validOutcome.code, 0);
    assert.equal(validOutcome.result.registrations.routes[0].path, "/status");
    assert.deepEqual(validOutcome.result.registrations.tasks, [{ name: "idle" }]);
    assert.deepEqual(validOutcome.result.registrations.schedules, [{ task: "idle", intervalMs: 100, runImmediately: true }]);

    const warning = await createFixture(temporaryRoot, "workspace-warning", {
      backend: "export async function activate(context) { context.setHealth({ state: \"ready\" }); }",
      workspace: "<!doctype html><script type=module src=\"./main.js\"></script><script src=\"https://cdn.example.test/app.js\"></script>",
    });
    await writeFile(path.join(warning, "web", "main.js"), "const asset = new URL(`./asset-${name}.js`, import.meta.url); import(loader); //# sourceMappingURL=missing.map\n", "utf8");
    const warningOutcome = await runCli(cli, root, ["doctor", warning, "--timeout", "1000"]);
    assert.equal(warningOutcome.code, 0);
    assert(warningOutcome.result.checks.some((check) => check.code === "WORKSPACE_EXTERNAL_REFERENCE" && check.severity === "warning"));
    assert(warningOutcome.result.checks.some((check) => check.code === "WORKSPACE_DYNAMIC_REFERENCE" && check.severity === "warning"));
    const warningOutput = path.join(temporaryRoot, "workspace-warning.infolens-plugin");
    const warningPack = await runCli(cli, root, ["pack", warning, "--out", warningOutput, "--timeout", "1000"]);
    assert.equal(warningPack.code, 0);
    assert(warningPack.result.checks.some((check) => check.code === "WORKSPACE_EXTERNAL_REFERENCE" && check.severity === "warning"));

    const missing = await createFixture(temporaryRoot, "workspace-missing", {
      backend: "export async function activate(context) { context.setHealth({ state: \"ready\" }); }",
      workspace: "<!doctype html><script type=module src=\"./does-not-exist-a.js\"></script><script type=module src=\"./does-not-exist-b.js\"></script>",
    });
    const missingOutcome = await runCli(cli, root, ["doctor", missing, "--timeout", "1000"]);
    assert.notEqual(missingOutcome.code, 0);
    assert.equal(missingOutcome.result.checks.filter((check) => check.code === "WORKSPACE_MISSING_DEPENDENCY").length, 2);
    const missingOutput = path.join(temporaryRoot, "workspace-missing.infolens-plugin");
    const missingPack = await runCli(cli, root, ["pack", missing, "--out", missingOutput, "--timeout", "1000"]);
    assert.notEqual(missingPack.code, 0);
    assert.equal(missingPack.result.checks.filter((check) => check.code === "WORKSPACE_MISSING_DEPENDENCY").length, 2);
    await assert.rejects(readFile(path.join(missingOutput, "manifest.json")), (error) => error.code === "ENOENT");

    const stagedDependency = await createFixture(temporaryRoot, "staged-dependency", {
      backend: "import \"fixture-dependency\"; export async function activate(context) { context.setHealth({ state: \"ready\" }); }",
    });
    await mkdir(path.join(stagedDependency, "node_modules", "fixture-dependency"), { recursive: true });
    await writeFile(path.join(stagedDependency, "node_modules", "fixture-dependency", "package.json"), "{\"name\":\"fixture-dependency\",\"type\":\"module\",\"main\":\"index.mjs\"}\n", "utf8");
    await writeFile(path.join(stagedDependency, "node_modules", "fixture-dependency", "index.mjs"), "export const present = true;\n", "utf8");
    const sourceValidation = await runCli(cli, root, ["validate", stagedDependency]);
    assert.equal(sourceValidation.code, 0);
    const stagedOutput = path.join(temporaryRoot, "staged-dependency.infolens-plugin");
    const stagedPack = await runCli(cli, root, ["pack", stagedDependency, "--out", stagedOutput, "--timeout", "1000"]);
    assert.notEqual(stagedPack.code, 0);
    assert(failedCheck(stagedPack.result, "BACKEND_IMPORT_FAILED"));
    assert.equal(await readdir(temporaryRoot).then((entries) => entries.some((entry) => entry.startsWith(".staged-dependency.infolens-plugin.stage-"))), false);
    await assert.rejects(readFile(path.join(stagedOutput, "manifest.json")), (error) => error.code === "ENOENT");
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("release verifier reports drift and validates a derived release manifest", async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "infolens-release-verifier-"));
  try {
    await cp(path.join(root, "package.json"), path.join(temporaryRoot, "package.json"));
    for (const relative of ["apps/desktop", "packages/plugin-runtime", "packages/plugin-sdk", "packages/release-metadata", "resources/opencli"]) {
      await cp(path.join(root, relative), path.join(temporaryRoot, relative), { recursive: true });
    }
    const desktopPath = path.join(temporaryRoot, "apps/desktop/package.json");
    const desktop = JSON.parse(await readFile(desktopPath, "utf8"));
    desktop.version = "0.3.0";
    await writeFile(desktopPath, `${JSON.stringify(desktop, null, 2)}\n`, "utf8");
    const drift = await verifyRelease({ root: temporaryRoot });
    assert.equal(drift.ok, false);
    assert.equal(drift.error.code, "RELEASE_HOST_VERSION_DRIFT");
    assert(drift.checks.find((check) => check.code === "RELEASE_HOST_VERSION_DRIFT").details.sources.some((entry) => entry.source === "desktop-package"));

    desktop.version = "0.2.0";
    await writeFile(desktopPath, `${JSON.stringify(desktop, null, 2)}\n`, "utf8");
    const sourceVerification = await verifyRelease({ root: temporaryRoot });
    assert.equal(sourceVerification.ok, true);
    const manifestPath = path.join(temporaryRoot, "release-manifest.json");
    await writeFile(manifestPath, `${JSON.stringify(createReleaseManifest(sourceVerification), null, 2)}\n`, "utf8");
    const manifestVerification = await verifyRelease({ root: temporaryRoot, releaseManifestPath: manifestPath });
    assert.equal(manifestVerification.ok, true);
    const releaseManifest = JSON.parse(await readFile(manifestPath, "utf8"));
    releaseManifest.pluginSdkVersion = "9.9.9";
    await writeFile(manifestPath, `${JSON.stringify(releaseManifest, null, 2)}\n`, "utf8");
    const manifestDrift = await verifyRelease({ root: temporaryRoot, releaseManifestPath: manifestPath });
    assert.equal(manifestDrift.error.code, "RELEASE_MANIFEST_SDK_DRIFT");
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("Workspace diagnosis traverses nested graphs without executing them", async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "infolens-workspace-graph-"));
  const workspaceRoot = path.join(temporaryRoot, "web");
  try {
    await mkdir(path.join(workspaceRoot, "nested"), { recursive: true });
    await writeFile(path.join(workspaceRoot, "index.html"), `
      <script type="module" src="./nested/a.js"></script>
      <script type="module" src="./nested/a.js"></script>
      <link rel="stylesheet" href="./nested/a.css">
      <script src="./missing.js"></script>
      <script src="../outside.js"></script>
      <script src="/absolute.js"></script>
      <script src="https://cdn.example.test/app.js"></script>
    `, "utf8");
    await writeFile(path.join(workspaceRoot, "nested", "a.js"), `import "./b.js"; import(loader); const computed = new URL(\`./asset-\${name}.js\`, import.meta.url); //# sourceMappingURL=a.js.map\n`, "utf8");
    await writeFile(path.join(workspaceRoot, "nested", "b.js"), "import \"./a.js\";\n", "utf8");
    await writeFile(path.join(workspaceRoot, "nested", "a.css"), "@import \"./nested.css\"; .icon { background: url(\"./asset.png\"); background-image: url(\"https://cdn.example.test/icon.png\"); }\n", "utf8");
    await writeFile(path.join(workspaceRoot, "nested", "nested.css"), ".nested {}\n", "utf8");
    await writeFile(path.join(workspaceRoot, "nested", "asset.png"), "not-a-real-image\n", "utf8");

    const report = await diagnoseWorkspaceBundle(path.join(workspaceRoot, "index.html"), workspaceRoot);
    assert(report.visited.some((filename) => filename.endsWith(path.join("nested", "a.js"))));
    assert(report.visited.some((filename) => filename.endsWith(path.join("nested", "b.js"))));
    assert(report.visited.some((filename) => filename.endsWith(path.join("nested", "nested.css"))));
    assert(report.checks.some((check) => check.code === "WORKSPACE_MISSING_DEPENDENCY"));
    assert(report.checks.some((check) => check.code === "WORKSPACE_PATH_ESCAPE"));
    assert(report.checks.some((check) => check.code === "WORKSPACE_ABSOLUTE_REFERENCE"));
    assert(report.checks.some((check) => check.code === "WORKSPACE_EXTERNAL_REFERENCE"));
    assert(report.checks.some((check) => check.code === "WORKSPACE_DYNAMIC_REFERENCE"));
    assert.equal(report.checks.some((check) => check.reference?.endsWith("a.js.map")), false);
    const keys = report.checks.map((check) => [check.id, check.source, check.reference].join("\0"));
    assert.equal(new Set(keys).size, keys.length);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("OpenCLI wrapper metadata is required outside an explicit fixture override", async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "infolens-opencli-wrapper-"));
  try {
    await mkdir(path.join(temporaryRoot, "bin"), { recursive: true });
    await writeFile(path.join(temporaryRoot, "runtime.json"), JSON.stringify({ version: "1.8.6", executable: "bin/opencli.mjs", commands: [] }), "utf8");
    await writeFile(path.join(temporaryRoot, "bin", "opencli.mjs"), "process.stdout.write('{}');\n", "utf8");
    await assert.rejects(loadBundledOpenCli(temporaryRoot), (error) => error.code === "OPENCLI_WRAPPER_UNAVAILABLE");
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
