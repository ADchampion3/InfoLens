#!/usr/bin/env node
import { access, cp, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { createReleaseManifest, verifyRelease } from "./verify-release.mjs";

const root = path.resolve(import.meta.dirname, "..");
const electronDist = path.join(root, "node_modules", "electron", "dist");
const outputRoot = path.join(root, "release", "infolens-win32-x64");

if (process.platform !== "win32" || process.arch !== "x64") {
  throw new Error("Release packaging currently targets Windows x64");
}

const sourceVerification = await verifyRelease({ root });
if (!sourceVerification.ok) {
  throw new Error(`Release verification failed before packaging: ${sourceVerification.error?.code ?? "unknown"}`);
}
await access(path.join(electronDist, "electron.exe"));
await access(path.join(root, "apps", "desktop", "dist", "index.html"));

await mkdir(path.dirname(outputRoot), { recursive: true });
const stagingRoot = await mkdtemp(path.join(path.dirname(outputRoot), `.${path.basename(outputRoot)}.stage-`));
let published = false;
function releaseCopyFilter(source) {
  const relative = path.relative(root, source);
  return !relative.split(path.sep).includes(".infolens-dev") && !relative.split(path.sep).includes("node_modules");
}

async function atomicRename(source, destination) {
  let lastError;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      await rename(source, destination);
      return;
    } catch (error) {
      lastError = error;
      if (!['EPERM', 'EBUSY'].includes(error.code)) throw error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw lastError;
}

try {
  const appRoot = path.join(stagingRoot, "resources", "app");
  await cp(electronDist, stagingRoot, { recursive: true });
  await rm(path.join(stagingRoot, "resources", "default_app.asar"), { force: true });
  await rename(path.join(stagingRoot, "electron.exe"), path.join(stagingRoot, "Infolens.exe"));

  const copies = [
    ["apps/desktop/main.cjs", "apps/desktop/main.cjs"],
    ["apps/desktop/preload.cjs", "apps/desktop/preload.cjs"],
    ["apps/desktop/runtime-network.cjs", "apps/desktop/runtime-network.cjs"],
    ["apps/desktop/package.json", "apps/desktop/package.json"],
    ["apps/desktop/dist", "apps/desktop/dist"],
    ["packages/plugin-runtime", "packages/plugin-runtime"],
    ["packages/log-service", "packages/log-service"],
    ["packages/plugin-sdk", "packages/plugin-sdk"],
    ["packages/plugin-market", "packages/plugin-market"],
    ["packages/plugin-workspace", "packages/plugin-workspace"],
    ["packages/release-metadata", "packages/release-metadata"],
    ["plugins", "plugins"],
    ["resources/opencli", "resources/opencli"],
    ["node_modules/semver", "node_modules/semver"],
    ["packages/plugin-runtime", "node_modules/@infolens/plugin-runtime"],
    ["packages/plugin-sdk", "node_modules/@infolens/plugin-sdk"],
    ["packages/plugin-market", "node_modules/@infolens/plugin-market"],
    ["packages/plugin-workspace", "node_modules/@infolens/plugin-workspace"],
    ["packages/release-metadata", "node_modules/@infolens/release-metadata"],
    ["resources/opencli", "node_modules/@infolens/bundled-opencli"],
  ];
  for (const [source, destination] of copies) {
    const target = path.join(appRoot, destination);
    await mkdir(path.dirname(target), { recursive: true });
    if (source === "plugins") await cp(path.join(root, source), target, { recursive: true, filter: releaseCopyFilter });
    else await cp(path.join(root, source), target, { recursive: true });
  }

  const sourcePackage = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  await writeFile(path.join(appRoot, "package.json"), `${JSON.stringify({
    name: "infolens",
    productName: "Infolens",
    version: sourcePackage.version,
    private: true,
    main: "apps/desktop/main.cjs",
  }, null, 2)}\n`, "utf8");

  const artifact = createReleaseManifest(sourceVerification, {
    platform: "win32",
    arch: "x64",
    electronVersion: (await readFile(path.join(electronDist, "version"), "utf8")).trim(),
    plugins: ["hn", "github-trending", "juejin", "zhihu-hot", "product-hunt"],
    executable: "Infolens.exe",
  });
  const releaseManifestPath = path.join(stagingRoot, "release-manifest.json");
  await writeFile(releaseManifestPath, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");

  const packagedVerification = await verifyRelease({
    root: appRoot,
    releaseManifestPath,
    opencliRoot: path.join(appRoot, "resources", "opencli"),
  });
  if (!packagedVerification.ok) {
    throw new Error(`Packaged release verification failed: ${packagedVerification.error?.code ?? "unknown"}`);
  }

  await rm(outputRoot, { recursive: true, force: true });
  await atomicRename(stagingRoot, outputRoot);
  published = true;
  process.stdout.write(`Release candidate: ${outputRoot}\n`);
} finally {
  if (!published) await rm(stagingRoot, { recursive: true, force: true });
}
