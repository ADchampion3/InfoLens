import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { createConnection } from "node:net";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createReleaseManifest, verifyRelease } from "../scripts/verify-release.mjs";
import { loadBundledOpenCli } from "../packages/plugin-runtime/src/opencli-adapter.mjs";
import { diagnoseWorkspaceBundle } from "../packages/plugin-runtime/src/workspace-diagnostics.mjs";
import { createPreviewSession, runWorkspaceBuild, workspaceBuildScript } from "../packages/plugin-sdk/src/preview.mjs";

const root = path.resolve(import.meta.dirname, "..");
const cli = path.join(root, "packages", "plugin-sdk", "bin", "infolens-plugin.mjs");
const officialIds = ["hn", "github-trending", "juejin", "product-hunt", "zhihu-hot"];

async function runCliProcess(cliPath, cwd, args, extraEnvironment = {}) {
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
    child.once("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

async function runCli(cliPath, cwd, args, extraEnvironment = {}) {
  const output = await runCliProcess(cliPath, cwd, args, extraEnvironment);
  let result;
  try { result = JSON.parse(output.stdout); }
  catch (error) { throw new Error(`CLI did not return JSON (${output.code ?? output.signal}): ${error.message}\n${output.stdout}\n${output.stderr}`); }
  return { ...output, result };
}

async function runCliText(cliPath, cwd, args, extraEnvironment = {}) {
  return runCliProcess(cliPath, cwd, args, extraEnvironment);
}

async function runNpmScript(cwd, script, args = []) {
  const pathKey = Object.keys(process.env).find((key) => key.toLowerCase() === "path") ?? "PATH";
  const env = {
    ...process.env,
    [pathKey]: `${path.join(root, "node_modules", ".bin")}${path.delimiter}${process.env[pathKey] ?? ""}`,
  };
  const command = process.platform === "win32" ? "npm.cmd" : "npm";
  const npmArgs = ["run", script, ...(args.length ? ["--", ...args] : [])];
  const executable = process.platform === "win32" ? (process.env.ComSpec ?? "cmd.exe") : command;
  const commandArgs = process.platform === "win32" ? ["/d", "/s", "/c", command, ...npmArgs] : npmArgs;
  return new Promise((resolve, reject) => {
    const child = spawn(executable, commandArgs, {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
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
    ["packages/plugin-market", "node_modules/@infolens/plugin-market"],
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

test("init creates a doctor-ready Plugin and text output stays useful for authors", async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "infolens-plugin-init-"));
  try {
    const help = await runCliText(cli, root, ["--help"]);
    assert.equal(help.code, 0);
    assert.match(help.stdout, /init <path>/);
    assert.match(help.stdout, /--format <json\|text>/);
    assert.match(help.stdout, /Omitted plugin paths default to the current directory/);
    assert.match(help.stdout, /pack defaults to a sibling .*infolens-plugin path/);

    const packageRoot = path.join(temporaryRoot, "reading-notes");
    const initialized = await runCli(cli, root, ["init", packageRoot]);
    assert.equal(initialized.code, 0, initialized.stderr);
    assert.equal(initialized.result.ok, true);
    assert.deepEqual(initialized.result.plugin, {
      id: "reading-notes",
      name: "Reading Notes",
      version: "0.1.0",
      path: packageRoot,
      packagePath: packageRoot,
    });
    assert.deepEqual(initialized.result.created.sort(), [
      "backend/index.mjs",
      "manifest.json",
      "package.json",
      "web/dist/index.html",
      "web/dist/styles.css",
      "web/dist/workspace.js",
    ]);

    const manifest = JSON.parse(await readFile(path.join(packageRoot, "manifest.json"), "utf8"));
    assert.deepEqual(manifest.openCliAdapters, {});
    assert.deepEqual(manifest.openCliCommands, {});
    assert.equal(manifest.ui.entry, "web/dist/index.html");
    const workspaceHtml = await readFile(path.join(packageRoot, "web/dist/index.html"), "utf8");
    const workspaceStyles = await readFile(path.join(packageRoot, "web/dist/styles.css"), "utf8");
    assert.match(workspaceHtml, /plugin-sdk-tokens\.css/);
    assert.match(workspaceHtml, /plugin-sdk-workspace\.css/);
    assert.match(workspaceHtml, /class="workspace-header"/);
    assert.match(workspaceHtml, /aria-busy="true"/);
    assert.match(workspaceStyles, /var\(--color-paper\)/);
    assert.match(workspaceStyles, /@media \(max-width: 40rem\)/);
    const packageManifest = JSON.parse(await readFile(path.join(packageRoot, "package.json"), "utf8"));
    assert.equal(packageManifest.private, true);
    assert.deepEqual(packageManifest.scripts, {
      validate: "infolens-plugin validate . --format text",
      doctor: "infolens-plugin doctor . --format text",
      dev: "infolens-plugin dev . --format text",
      preview: "infolens-plugin preview . --format text",
      pack: "infolens-plugin pack . --format text",
    });

    const scriptDoctor = await runNpmScript(packageRoot, "doctor", ["--timeout", "5000"]);
    assert.equal(scriptDoctor.code, 0, `${scriptDoctor.stdout}\n${scriptDoctor.stderr}`);
    assert.match(scriptDoctor.stdout, /doctor: passed/);
    const scriptPack = await runNpmScript(packageRoot, "pack");
    assert.equal(scriptPack.code, 0, `${scriptPack.stdout}\n${scriptPack.stderr}`);
    assert.match(scriptPack.stdout, /pack: passed/);
    assert.equal(await readdir(temporaryRoot).then((entries) => entries.includes("reading-notes.infolens-plugin")), true);

    const previewChild = spawn(process.execPath, [cli, "preview", packageRoot, "--format", "text", "--timeout", "5000"], {
      cwd: root,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    let previewStdout = "";
    let previewStderr = "";
    const previewReady = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Preview did not start:\n${previewStdout}\n${previewStderr}`)), 15_000);
      previewChild.stdout.on("data", (chunk) => {
        previewStdout += String(chunk);
        if (previewStdout.includes("Workspace: http://")) {
          clearTimeout(timer);
          resolve();
        }
      });
      previewChild.stderr.on("data", (chunk) => { previewStderr += String(chunk); });
      previewChild.once("error", (error) => { clearTimeout(timer); reject(error); });
      previewChild.once("exit", (code, signal) => {
        if (code !== null) reject(new Error(`Preview exited before ready (${code ?? signal})`));
      });
    });
    const previewExit = new Promise((resolve) => previewChild.once("close", (code, signal) => resolve({ code, signal })));
    await previewReady;
    assert.match(previewStdout, /API: http:\/\//);
    assert.match(previewStdout, /pluginId=reading-notes/);
    assert.match(previewStdout, /apiBaseUrl=http%3A%2F%2F/);
    assert.match(previewStdout, /Watch: /);
    previewChild.stdin.end("shutdown\n");
    const previewResult = await previewExit;
    assert.equal(previewResult.code, 0, `${previewStdout}\n${previewStderr}`);

    const targetedRoot = path.join(temporaryRoot, "targeted-plugin");
    const targeted = await runCli(cli, root, ["init", targetedRoot, "--target-host-version", "9.0.0"]);
    assert.equal(targeted.code, 0, targeted.result.error?.message);
    assert.equal(targeted.result.environment.targetHost.value, "9.0.0");
    assert.equal(JSON.parse(await readFile(path.join(targetedRoot, "manifest.json"), "utf8")).minHostVersion, "0.2.0");

    const checkedRoot = path.join(temporaryRoot, "checked-plugin");
    const checked = await runCli(cli, root, ["init", checkedRoot, "--check", "--timeout", "5000"]);
    assert.equal(checked.code, 0, checked.result.error?.message);
    assert.equal(checked.result.ok, true);
    assert.equal(checked.result.checked, true);
    assert.equal(checked.result.health.state, "ready");
    assert(checked.result.workspace.visited.includes("index.html"));

    const text = await runCliText(cli, root, ["doctor", packageRoot, "--format", "text", "--timeout", "5000"]);
    assert.equal(text.code, 0, text.stderr);
    assert.match(text.stdout, /^doctor: passed/m);
    assert.match(text.stdout, /Environment: Contract 2 \/ Host 0\.2\.0 \/ OpenCLI 1\.8\.6/);
    assert.match(text.stdout, /Checks: \d+ passed, \d+ warning\(s\), 0 error\(s\)/);
    assert.match(text.stdout, /WORKSPACE_DYNAMIC_REFERENCE/);
    assert.match(text.stdout, /Next: npm run plugin -- pack/);
    assert.doesNotMatch(text.stdout, /^\s*\{/m);

    const nonEmptyRoot = path.join(temporaryRoot, "non-empty");
    await mkdir(nonEmptyRoot, { recursive: true });
    await writeFile(path.join(nonEmptyRoot, "keep.txt"), "keep\n", "utf8");
    const refused = await runCli(cli, root, ["init", nonEmptyRoot]);
    assert.notEqual(refused.code, 0);
    assert.equal(refused.result.error.code, "INIT_DIRECTORY_NOT_EMPTY");
    assert.equal(await readFile(path.join(nonEmptyRoot, "keep.txt"), "utf8"), "keep\n");
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("preview restarts the isolated Runtime after package changes", async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "infolens-plugin-preview-"));
  let resolveRestart;
  let rejectRestart;
  const restart = new Promise((resolve, reject) => {
    resolveRestart = resolve;
    rejectRestart = reject;
  });
  const restartTimer = setTimeout(() => rejectRestart(new Error("Preview did not restart after the package changed")), 15_000);
  const events = [];
  const session = createPreviewSession({
    packageRoot: path.join(temporaryRoot, "fixture"),
    pluginId: "fixture",
    sdkRoot: path.join(root, "packages", "plugin-sdk"),
    runtimePackageRoot: path.join(root, "packages", "plugin-runtime"),
    bundledOpenCliRoot: path.join(root, "resources", "opencli"),
    timeoutMs: 5_000,
    onEvent: (event) => {
      events.push(event);
      if (event.type === "restarted") resolveRestart(event);
    },
  });
  try {
    const packageRoot = await createFixture(temporaryRoot, "fixture", {
      backend: "export async function activate(context) { context.route(\"GET\", \"/version\", () => ({ version: \"one\" })); context.setHealth({ state: \"ready\" }); }",
    });
    const started = await session.start();
    const readVersion = async () => {
      const response = await fetch(new URL("version", started.apiBaseUrl));
      assert.equal(response.status, 200);
      return response.json();
    };
    assert.deepEqual(await readVersion(), { version: "one" });

    await writeFile(path.join(packageRoot, "backend", "index.mjs"), "export async function activate(context) { context.route(\"GET\", \"/version\", () => ({ version: \"two\" })); context.setHealth({ state: \"ready\" }); }", "utf8");
    const restarted = await restart;
    assert.equal(restarted.origin, started.origin);
    assert.deepEqual(await readVersion(), { version: "two" });
    assert.equal(events.filter((event) => event.type === "restarted").length, 1);
  } finally {
    clearTimeout(restartTimer);
    await session.stop("test");
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("preview rebuilds the Workspace before restarting after source changes", async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "infolens-plugin-preview-build-"));
  const packageRoot = await createFixture(temporaryRoot, "fixture", {
    backend: "export async function activate(context) { context.setHealth({ state: \"ready\" }); }",
  });
  const manifestPath = path.join(packageRoot, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.ui.entry = "web/dist/index.html";
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  const sourcePath = path.join(packageRoot, "web", "src.txt");
  const workspaceRoot = path.join(packageRoot, "web", "dist");
  await mkdir(workspaceRoot, { recursive: true });
  await writeFile(sourcePath, "one", "utf8");
  await writeFile(path.join(packageRoot, "package.json"), `${JSON.stringify({
    name: "fixture-fixture",
    version: "1.0.0",
    type: "module",
    scripts: { "build:workspace": "node build.mjs" },
  }, null, 2)}\n`, "utf8");
  await writeFile(path.join(packageRoot, "build.mjs"), `import { readFile, writeFile } from "node:fs/promises";
const value = await readFile(new URL("./web/src.txt", import.meta.url), "utf8");
await writeFile(new URL("./web/dist/index.html", import.meta.url), "<!doctype html><body>" + value + "</body>", "utf8");
`, "utf8");
  assert.equal(await workspaceBuildScript(packageRoot), "node build.mjs");

  let builds = 0;
  const buildWorkspace = async () => {
    builds += 1;
    await runWorkspaceBuild(packageRoot);
  };
  await buildWorkspace();

  let resolveRestart;
  let rejectRestart;
  const restart = new Promise((resolve, reject) => {
    resolveRestart = resolve;
    rejectRestart = reject;
  });
  const restartTimer = setTimeout(() => rejectRestart(new Error("Preview did not rebuild the Workspace")), 15_000);
  const session = createPreviewSession({
    packageRoot,
    pluginId: "fixture",
    sdkRoot: path.join(root, "packages", "plugin-sdk"),
    runtimePackageRoot: path.join(root, "packages", "plugin-runtime"),
    bundledOpenCliRoot: path.join(root, "resources", "opencli"),
    buildWorkspace,
    workspaceRoot,
    timeoutMs: 5_000,
    onEvent: (event) => {
      if (event.type === "restarted") resolveRestart(event);
    },
  });
  try {
    const started = await session.start();
    const readWorkspace = async () => {
      const response = await fetch(started.workspaceUrl);
      assert.equal(response.status, 200);
      return response.text();
    };
    assert.equal(builds, 1);
    assert.match(await readWorkspace(), />one</);

    await writeFile(sourcePath, "two", "utf8");
    const restarted = await restart;
    assert.equal(restarted.origin, started.origin);
    assert.equal(builds, 2);
    assert.match(await readWorkspace(), />two</);
  } finally {
    clearTimeout(restartTimer);
    await session.stop("test");
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("preview dev proxy keeps Workspace, API, SDK, and HMR on one origin", async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "infolens-plugin-preview-dev-"));
  const requests = [];
  const devServer = createServer((request, response) => {
    requests.push(request.url);
    response.writeHead(200, { "content-type": "text/plain" });
    response.end(`dev:${request.url}`);
  });
  devServer.on("upgrade", (request, socket) => {
    requests.push(`ws:${request.url}`);
    socket.end("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n");
  });
  await new Promise((resolve) => devServer.listen(0, "127.0.0.1", resolve));
  const devPort = devServer.address().port;
  const packageRoot = await createFixture(temporaryRoot, "fixture", {
    backend: "export async function activate(context) { context.route(\"GET\", \"/version\", () => ({ version: \"dev\" })); context.setHealth({ state: \"ready\" }); }",
  });
  const manifestPath = path.join(packageRoot, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.ui.entry = "web/dist/index.html";
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  await rm(path.join(packageRoot, "web", "index.html"));
  const workspaceEntry = path.join(packageRoot, "web", "dist", "index.html");
  const session = createPreviewSession({
    packageRoot,
    pluginId: "fixture",
    sdkRoot: path.join(root, "packages", "plugin-sdk"),
    runtimePackageRoot: path.join(root, "packages", "plugin-runtime"),
    bundledOpenCliRoot: path.join(root, "resources", "opencli"),
    workspaceDev: { url: `http://127.0.0.1:${devPort}`, start: false },
    workspaceEntry,
    workspaceRoot: path.dirname(workspaceEntry),
    timeoutMs: 5_000,
  });
  try {
    const started = await session.start();
    const workspaceUrl = new URL(started.workspaceUrl);
    assert.equal(workspaceUrl.origin, started.origin);
    assert.equal(workspaceUrl.searchParams.get("pluginId"), "fixture");
    assert.equal(new URL(workspaceUrl.searchParams.get("apiBaseUrl")).origin, started.origin);
    assert.match(await fetch(started.workspaceUrl).then((response) => response.text()), /^dev:\/\?/);
    assert.match(await fetch(new URL("/@vite/client", started.origin)).then((response) => response.text()), /^dev:\/@vite\/client/);
    assert.deepEqual(await fetch(new URL("version", started.apiBaseUrl)).then((response) => response.json()), { version: "dev" });
    const sdkResponse = await fetch(new URL("/runtime/plugin-sdk.js", started.origin));
    if (sdkResponse.status !== 200) {
      const failure = await Promise.race([session.wait(), new Promise((resolve) => setTimeout(() => resolve({ timeout: true }), 250))]);
      assert.equal(sdkResponse.status, 200, `${await sdkResponse.text()} ${failure.error?.message ?? JSON.stringify(failure)}`);
    }
    assert.match(await fetch(new URL("/runtime/health", started.origin)).then((response) => response.text()), /^dev:\/runtime\/health/);

    const handshake = await new Promise((resolve, reject) => {
      const socket = createConnection(Number(new URL(started.origin).port), "127.0.0.1", () => {
        socket.write(`GET /@vite/client HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n`);
      });
      let output = "";
      socket.on("data", (chunk) => { output += String(chunk); });
      socket.once("end", () => resolve(output));
      socket.once("error", reject);
    });
    assert.match(handshake, /^HTTP\/1\.1 101/);
    assert(requests.includes("ws:/@vite/client"));
  } finally {
    await session.stop("test");
    await new Promise((resolve) => devServer.close(resolve));
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("preview --dev starts the configured server before a static Workspace exists", async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "infolens-plugin-preview-dev-start-"));
  const portServer = createServer();
  await new Promise((resolve) => portServer.listen(0, "127.0.0.1", resolve));
  const port = portServer.address().port;
  await new Promise((resolve) => portServer.close(resolve));
  const packageRoot = await createFixture(temporaryRoot, "fixture", {
    backend: "export async function activate(context) { context.setHealth({ state: \"ready\" }); }",
  });
  const manifestPath = path.join(packageRoot, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.ui.entry = "web/dist/index.html";
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  await rm(path.join(packageRoot, "web", "index.html"));
  await writeFile(path.join(packageRoot, "dev-server.mjs"), `import { createServer } from "node:http";
createServer((request, response) => { response.end("auto-dev"); }).listen(${port}, "127.0.0.1");
`, "utf8");
  const packageJsonPath = path.join(packageRoot, "package.json");
  const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8"));
  packageJson.scripts = { "dev:workspace": "node dev-server.mjs" };
  packageJson.infolens = { workspaceDev: { url: `http://127.0.0.1:${port}` } };
  await writeFile(packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`, "utf8");
  const session = createPreviewSession({
    packageRoot,
    pluginId: "fixture",
    sdkRoot: path.join(root, "packages", "plugin-sdk"),
    runtimePackageRoot: path.join(root, "packages", "plugin-runtime"),
    bundledOpenCliRoot: path.join(root, "resources", "opencli"),
    workspaceDev: { url: `http://127.0.0.1:${port}`, start: true },
    workspaceEntry: path.join(packageRoot, "web", "dist", "index.html"),
    workspaceRoot: path.join(packageRoot, "web", "dist"),
    timeoutMs: 5_000,
  });
  try {
    const started = await session.start();
    assert.equal(await fetch(started.workspaceUrl).then((response) => response.text()), "auto-dev");
  } finally {
    await session.stop("test");
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("preview runs build:workspace before validating the package", async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "infolens-plugin-preview-cli-build-"));
  const packageRoot = await createFixture(temporaryRoot, "fixture");
  const manifestPath = path.join(packageRoot, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.ui.entry = "web/dist/index.html";
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  await writeFile(path.join(packageRoot, "web", "src.txt"), "built", "utf8");
  await writeFile(path.join(packageRoot, "build.mjs"), `import { mkdir, readFile, writeFile } from "node:fs/promises";
const value = await readFile(new URL("./web/src.txt", import.meta.url), "utf8");
await mkdir(new URL("./web/dist/", import.meta.url), { recursive: true });
await writeFile(new URL("./web/dist/index.html", import.meta.url), "<!doctype html><body>" + value + "</body>", "utf8");
`, "utf8");
  const packageJsonPath = path.join(packageRoot, "package.json");
  const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8"));
  packageJson.scripts = { "build:workspace": "node build.mjs" };
  await writeFile(packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`, "utf8");

  const child = spawn(process.execPath, [cli, "preview", packageRoot, "--format", "text", "--timeout", "5000"], {
    cwd: root,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += String(chunk); });
  child.stderr.on("data", (chunk) => { stderr += String(chunk); });
  const workspaceUrl = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Preview did not start:\n${stdout}\n${stderr}`)), 15_000);
    const check = () => {
      const match = stdout.match(/Workspace: (http:\/\/[^\r\n]+)/);
      if (!match) return;
      clearTimeout(timer);
      resolve(match[1]);
    };
    child.stdout.on("data", check);
    child.once("error", reject);
  });
  try {
    const response = await fetch(workspaceUrl);
    assert.equal(response.status, 200);
    assert.match(await response.text(), />built</);
    child.stdin.end("shutdown\n");
    const [code] = await once(child, "close");
    assert.equal(code, 0, `${stdout}\n${stderr}`);
    assert.match(stdout, /Workspace build: enabled/);
    assert.doesNotMatch(stdout, /npm notice/);
  } finally {
    if (child.exitCode === null) child.kill();
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("preview stop cancels startup without leaving temporary state", async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "infolens-plugin-preview-stop-"));
  const packageRoot = await createFixture(temporaryRoot, "fixture");
  const prefix = "infolens-plugin-preview-";
  const before = new Set((await readdir(os.tmpdir())).filter((entry) => entry.startsWith(prefix)));
  const session = createPreviewSession({
    packageRoot,
    pluginId: "fixture",
    sdkRoot: path.join(root, "packages", "plugin-sdk"),
    runtimePackageRoot: path.join(root, "packages", "plugin-runtime"),
    bundledOpenCliRoot: path.join(root, "resources", "opencli"),
    timeoutMs: 5_000,
  });
  try {
    const starting = session.start();
    const stopped = await session.stop("signal");
    await assert.rejects(starting, (error) => {
      assert.equal(error.code, "PREVIEW_STOPPED");
      return true;
    });
    assert.deepEqual(stopped, { code: 0, reason: "signal" });
    assert.deepEqual(await session.wait(), stopped);
    const after = new Set((await readdir(os.tmpdir())).filter((entry) => entry.startsWith(prefix)));
    assert.deepEqual([...after].filter((entry) => !before.has(entry)), []);
  } finally {
    await session.stop("test");
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("preview accepts shutdown while Runtime startup is still pending", async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "infolens-plugin-preview-input-"));
  const packageRoot = await createFixture(temporaryRoot, "fixture", {
    backend: "await new Promise((resolve) => setTimeout(resolve, 2_000));\nexport async function activate(context) { context.setHealth({ state: \"ready\" }); }",
  });
  const prefix = "infolens-plugin-preview-";
  const before = new Set((await readdir(os.tmpdir())).filter((entry) => entry.startsWith(prefix)));
  const child = spawn(process.execPath, [cli, "preview", packageRoot, "--format", "text", "--timeout", "5000"], {
    cwd: root,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += String(chunk); });
  child.stderr.on("data", (chunk) => { stderr += String(chunk); });
  const exit = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  let previewDirectory;
  let exitTimer;
  try {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const entries = await readdir(os.tmpdir());
      previewDirectory = entries.find((entry) => entry.startsWith(prefix) && !before.has(entry));
      if (previewDirectory) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert(previewDirectory, `Preview did not create a temporary root:\n${stdout}\n${stderr}`);
    child.stdin.end("shutdown\n");
    exitTimer = setTimeout(() => child.kill(), 10_000);
    const result = await exit;
    assert.equal(result.code, 0, `${stdout}\n${stderr}`);
    assert.doesNotMatch(stdout, /Workspace: http:\/\//);
  } finally {
    clearTimeout(exitTimer);
    if (child.exitCode === null) child.kill();
    if (previewDirectory) await rm(path.join(os.tmpdir(), previewDirectory), { recursive: true, force: true });
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("preview cleans up when terminated during Runtime startup", { skip: process.platform === "win32" }, async () => {
  const packageRoot = path.join(root, "plugins", "hn");
  const prefix = "infolens-plugin-preview-";
  const before = new Set((await readdir(os.tmpdir())).filter((entry) => entry.startsWith(prefix)));
  const child = spawn(process.execPath, [cli, "preview", packageRoot, "--format", "text", "--timeout", "5000"], {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += String(chunk); });
  child.stderr.on("data", (chunk) => { stderr += String(chunk); });
  const exit = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  let previewDirectory;
  try {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const entries = await readdir(os.tmpdir());
      previewDirectory = entries.find((entry) => entry.startsWith(prefix) && !before.has(entry));
      if (previewDirectory) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert(previewDirectory, `Preview did not create a temporary root:\n${stdout}\n${stderr}`);
    child.kill("SIGTERM");
    const result = await exit;
    assert.equal(result.code, 0, `${stdout}\n${stderr}`);

    const cleanupDeadline = Date.now() + 5_000;
    while (Date.now() < cleanupDeadline && (await readdir(os.tmpdir())).includes(previewDirectory)) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.equal((await readdir(os.tmpdir())).includes(previewDirectory), false);
  } finally {
    if (child.exitCode === null) child.kill();
    if (previewDirectory) await rm(path.join(os.tmpdir(), previewDirectory), { recursive: true, force: true });
  }
});

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
