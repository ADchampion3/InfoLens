import { access, cp, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const electronDist = path.join(root, "node_modules", "electron", "dist");
const outputRoot = path.join(root, "release", "infolens-win32-x64");
const appRoot = path.join(outputRoot, "resources", "app");

if (process.platform !== "win32" || process.arch !== "x64") {
  throw new Error("Sprint 7 currently packages the Windows x64 release candidate");
}
await access(path.join(electronDist, "electron.exe"));
await access(path.join(root, "apps", "desktop", "dist", "index.html"));

await rm(outputRoot, { recursive: true, force: true });
await mkdir(path.dirname(outputRoot), { recursive: true });
await cp(electronDist, outputRoot, { recursive: true });
await rm(path.join(outputRoot, "resources", "default_app.asar"), { force: true });
await rename(path.join(outputRoot, "electron.exe"), path.join(outputRoot, "Infolens.exe"));

const copies = [
  ["apps/desktop/main.cjs", "apps/desktop/main.cjs"],
  ["apps/desktop/preload.cjs", "apps/desktop/preload.cjs"],
  ["apps/desktop/dist", "apps/desktop/dist"],
  ["packages/plugin-runtime", "packages/plugin-runtime"],
  ["packages/plugin-sdk", "packages/plugin-sdk"],
  ["plugins", "plugins"],
  ["resources/opencli", "resources/opencli"],
  ["node_modules/semver", "node_modules/semver"],
];
for (const [source, destination] of copies) {
  const target = path.join(appRoot, destination);
  await mkdir(path.dirname(target), { recursive: true });
  await cp(path.join(root, source), target, { recursive: true });
}

const sourcePackage = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
await writeFile(path.join(appRoot, "package.json"), `${JSON.stringify({
  name: "infolens",
  productName: "Infolens",
  version: sourcePackage.version,
  private: true,
  main: "apps/desktop/main.cjs",
}, null, 2)}\n`, "utf8");

const artifact = {
  name: "Infolens",
  version: sourcePackage.version,
  platform: "win32",
  arch: "x64",
  electronVersion: (await readFile(path.join(electronDist, "version"), "utf8")).trim(),
  openCli: JSON.parse(await readFile(path.join(appRoot, "resources", "opencli", "runtime.json"), "utf8")),
  plugins: ["hn", "github-trending", "zhihu-hot", "product-hunt"],
  executable: "Infolens.exe",
};
await writeFile(path.join(outputRoot, "release-manifest.json"), `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
process.stdout.write(`Sprint 7 release candidate: ${outputRoot}\n`);
