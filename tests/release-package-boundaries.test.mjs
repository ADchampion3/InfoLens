import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { test } from "node:test";

const root = path.resolve(import.meta.dirname, "..");
const releaseRoot = path.join(root, "release", "infolens-win32-x64");
const appRoot = path.join(releaseRoot, "resources", "app");

function runNode(filename, args, options) {
  return new Promise((resolve, reject) => {
    execFile(process.execPath, [filename, ...args], options, (error, stdout, stderr) => {
      if (error) resolve({ code: error.code, stdout, stderr });
      else resolve({ code: 0, stdout, stderr });
    });
  });
}

test("packaged release contains the installed @infolens package boundaries", async () => {
  const boundaries = [
    ["plugin-runtime", "@infolens/plugin-runtime"],
    ["plugin-sdk", "@infolens/plugin-sdk"],
    ["plugin-distribution", "@infolens/plugin-distribution"],
    ["plugin-workspace", "@infolens/plugin-workspace"],
    ["release-metadata", "@infolens/release-metadata"],
    ["bundled-opencli", "@infolens/bundled-opencli"],
  ];
  for (const [, packageName] of boundaries) {
    const packagePath = path.join(appRoot, "node_modules", ...packageName.split("/"), "package.json");
    await access(packagePath);
    const manifest = JSON.parse(await readFile(packagePath, "utf8"));
    assert.equal(manifest.name, packageName);
  }

  const runtimeContract = await import(pathToFileURL(path.join(appRoot, "packages", "plugin-runtime", "src", "contract.mjs")).href);
  assert.equal(runtimeContract.HOST_VERSION, "0.2.0");
  assert.equal(runtimeContract.CONTRACT_VERSION, "2");
  const openCliAdapter = await import(pathToFileURL(path.join(appRoot, "packages", "plugin-runtime", "src", "opencli-adapter.mjs")).href);
  const openCliLocation = openCliAdapter.resolveBundledOpenCliRoot({ environment: {} });
  assert.equal(openCliLocation.source, "bundled-opencli-package");
  assert.equal((await openCliAdapter.loadBundledOpenCli(openCliLocation.root, openCliLocation)).version, "1.8.6");
  await import(pathToFileURL(path.join(appRoot, "plugins", "hn", "backend", "index.js")).href);

  const cli = path.join(appRoot, "node_modules", "@infolens", "plugin-sdk", "bin", "infolens-plugin.mjs");
  const validation = await runNode(cli, ["validate", path.join(appRoot, "plugins", "hn")], { cwd: appRoot, windowsHide: true });
  assert.equal(validation.code, 0, validation.stderr);
  const result = JSON.parse(validation.stdout);
  assert.equal(result.ok, true);
  assert.equal(result.environment.targetHost.value, "0.2.0");
});
