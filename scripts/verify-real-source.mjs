import { spawn } from "node:child_process";
import { access, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { launchPackagedApp, waitFor } from "../tests/helpers/packaged-app.mjs";
import { renderEvidenceMarkdown, safeEvidence, releasePlugins } from "./release-evidence.mjs";

const root = path.resolve(import.meta.dirname, "..");
const releaseRoot = path.join(root, "release", "infolens-win32-x64");
const runId = new Date().toISOString().replace(/[:.]/g, "-");
const runRoot = path.join(root, ".infolens-acceptance", "real-source", "runs", runId);
const profile = path.join(runRoot, "profile");
const screenshotRoot = path.join(runRoot, "screenshots");
const manifest = JSON.parse(await readFile(path.join(releaseRoot, "release-manifest.json"), "utf8"));
const evidence = {
  schemaVersion: 1,
  runId,
  startedAt: new Date().toISOString(),
  release: manifest,
  browserBridge: { passed: false },
  plugins: releasePlugins.map(({ id, name, strategy, command }) => ({ id, name, strategy, command, result: "Pending" })),
  lifecycle: { cleanStart: true },
  result: "Failed",
};

await mkdir(screenshotRoot, { recursive: true });

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, windowsHide: true, ...options });
    let output = "";
    child.stdout?.on("data", (chunk) => { output += chunk; });
    child.stderr?.on("data", (chunk) => { output += chunk; });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve(output) : reject(Object.assign(new Error(`Command exited with code ${code}`), { code: "PREFLIGHT_FAILED" })));
  });
}

async function request(origin, route, options) {
  const response = await fetch(`${origin}${route}`, options);
  const body = await response.json();
  if (!response.ok) throw Object.assign(new Error(body.error ?? `${route} returned ${response.status}`), { code: body.code ?? "RUNTIME_REQUEST_FAILED" });
  return body;
}

async function runtimeInfo(app) {
  return app.cdp.evaluate("window.infolens.getRuntimeInfo()");
}

async function clickText(app, label) {
  return waitFor(() => app.cdp.evaluate(`(() => { const button=[...document.querySelectorAll('button')].find((item)=>item.textContent.trim().includes(${JSON.stringify(label)})); if(!button)return false; button.click(); return true; })()`), `Button not found: ${label}`);
}

async function openWorkspace(app, plugin) {
  await clickText(app, plugin.name);
  const frame = await waitFor(() => app.cdp.evaluate(`(() => { const frame=document.querySelector('iframe'); return frame?.src.includes(${JSON.stringify(`/plugins/${plugin.id}/workspace/`)}) ? frame.src : false; })()`), `${plugin.name} workspace did not load`);
  const targetPath = new URL(frame).pathname;
  await waitFor(() => app.cdp.evaluateTarget(targetPath, "(() => { const button=document.querySelector('#refresh'); return Boolean(button && (button.onclick || document.querySelector('.reader-list, .ledger-list, .board-grid, .empty, .dependency-panel'))); })()"), `${plugin.name} workspace did not become interactive`);
  return targetPath;
}

async function refreshPlugin(app, origin, plugin) {
  const targetPath = await openWorkspace(app, plugin);
  const started = Date.now();
  await app.cdp.evaluateTarget(targetPath, "document.querySelector('#refresh').click(); true");
  await waitFor(() => app.cdp.evaluateTarget(targetPath, "(() => { const button=document.querySelector('#refresh'); return button && !button.classList.contains('spinning') && !button.disabled; })()"), `${plugin.name} refresh did not finish`, 180_000);
  const summary = await request(origin, `/plugins/${plugin.id}/api/summary`);
  if (summary.lastError) throw Object.assign(new Error(`${plugin.name}: ${summary.lastError}`), { code: "REAL_SOURCE_COLLECTION_FAILED" });
  const refreshedAt = Date.parse(summary.lastSuccessfulRefresh ?? "");
  if (!(summary[plugin.field]?.length > 0) || refreshedAt < started - 1_000) {
    throw Object.assign(new Error(`${plugin.name} did not persist a fresh real-source result`), { code: "REAL_SOURCE_PERSISTENCE_FAILED" });
  }
  const workspaceRows = await waitFor(() => app.cdp.evaluateTarget(targetPath, `document.querySelectorAll(${JSON.stringify(plugin.rowSelector)}).length`), `${plugin.name} did not render retained rows`);
  await app.cdp.command("Page.enable");
  const screenshot = (await app.cdp.command("Page.captureScreenshot", { format: "png", fromSurface: true })).data;
  if (screenshot) await writeFile(path.join(screenshotRoot, `${plugin.id}.png`), Buffer.from(screenshot, "base64"));
  const databasePath = path.join(profile, "plugins-data", plugin.id, plugin.database);
  await access(databasePath);
  return {
    recordCount: summary[plugin.field].length,
    workspaceRows,
    lastSuccessfulRefresh: summary.lastSuccessfulRefresh,
    databaseBytes: (await stat(databasePath)).size,
    screenshot: `screenshots/${plugin.id}.png`,
  };
}

let app;
try {
  const openCli = path.join(releaseRoot, "resources", "app", "resources", "opencli", manifest.openCli.executable);
  await run(process.execPath, [openCli, "doctor"]);
  evidence.browserBridge.passed = true;

  const environment = { INFOLENS_USER_DATA_ROOT: profile, INFOLENS_TEST_CONTROL: "1" };
  app = await launchPackagedApp(root, environment);
  const initial = await waitFor(async () => {
    const info = await runtimeInfo(app);
    return info?.plugins?.length === releasePlugins.length ? info : undefined;
  }, "Packaged Runtime did not activate all official plugins", 20_000);

  for (const plugin of releasePlugins) {
    process.stdout.write(`Collecting ${plugin.name} through its packaged workspace...\n`);
    const record = evidence.plugins.find(({ id }) => id === plugin.id);
    record.result = "Running";
    try {
      Object.assign(record, await refreshPlugin(app, initial.origin, plugin), { result: "Passed" });
    } catch (error) {
      record.result = "Failed";
      throw error;
    }
  }

  await app.stop();
  evidence.lifecycle.shutdown = true;
  app = await launchPackagedApp(root, environment);
  const restarted = await waitFor(() => runtimeInfo(app), "Packaged application did not restart", 20_000);
  for (const plugin of releasePlugins) {
    const summary = await request(restarted.origin, `/plugins/${plugin.id}/api/summary`);
    const targetPath = await openWorkspace(app, plugin);
    const workspaceRows = await waitFor(() => app.cdp.evaluateTarget(targetPath, `document.querySelectorAll(${JSON.stringify(plugin.rowSelector)}).length`), `${plugin.name} retained rows did not render after restart`);
    const record = evidence.plugins.find(({ id }) => id === plugin.id);
    record.persistedAfterRestart = summary[plugin.field].length === record.recordCount && workspaceRows === record.workspaceRows;
    if (!record.persistedAfterRestart) throw Object.assign(new Error(`${plugin.name} records changed across restart`), { code: "RESTART_RETENTION_FAILED" });
  }

  const oldOrigin = restarted.origin;
  await app.cdp.evaluate("window.infolens.testTerminateRuntime()");
  const recovered = await waitFor(async () => {
    const info = await runtimeInfo(app);
    return info?.origin && info.origin !== oldOrigin && info.plugins.length === releasePlugins.length ? info : undefined;
  }, "Runtime did not recover", 20_000);
  for (const plugin of releasePlugins) {
    const summary = await request(recovered.origin, `/plugins/${plugin.id}/api/summary`);
    if (summary[plugin.field].length !== evidence.plugins.find(({ id }) => id === plugin.id).recordCount) {
      throw Object.assign(new Error(`${plugin.name} records changed during Runtime recovery`), { code: "RUNTIME_RECOVERY_FAILED" });
    }
  }
  evidence.lifecycle.runtimeRecovery = true;
  evidence.result = "Passed";
} catch (error) {
  evidence.failure = { code: error?.code ?? "SPRINT8_VERIFICATION_FAILED", message: error instanceof Error ? error.message : String(error) };
  process.exitCode = 1;
} finally {
  if (app) {
    await app.stop().catch(() => {});
    evidence.lifecycle.shutdown = app.child.exitCode !== null;
  }
  evidence.finishedAt = new Date().toISOString();
  const safe = safeEvidence(evidence);
  await writeFile(path.join(runRoot, "evidence.json"), `${JSON.stringify(safe, null, 2)}\n`, "utf8");
  await writeFile(path.join(runRoot, "evidence.md"), renderEvidenceMarkdown(safe), "utf8");
  await writeFile(path.join(root, ".infolens-acceptance", "real-source", "latest-run.txt"), `${runRoot}\n`, "utf8");
  process.stdout.write(`Real-source evidence: ${path.join(runRoot, "evidence.md")}\nResult: ${evidence.result}\n`);
}
