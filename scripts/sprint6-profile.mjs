import { access, cp, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

export const root = path.resolve(import.meta.dirname, "..");
export const profile = path.join(root, ".infolens-acceptance", "sprint6");
export const managedPlugins = path.join(profile, "plugins");
export const dataRoot = path.join(profile, "data", "plugins");
export const hostStatePath = path.join(profile, "data", "host-state.json");
export const openCliStatePath = path.join(profile, "opencli-state.json");

async function copyIfMissing(source, destination) {
  try { await access(destination); } catch { await cp(source, destination, { recursive: true }); }
}

export async function prepareSprint6Profile() {
  await mkdir(managedPlugins, { recursive: true });
  for (const plugin of ["hn", "github-trending", "zhihu-hot", "product-hunt"]) {
    await copyIfMissing(path.join(root, "plugins", plugin), path.join(managedPlugins, plugin));
  }
  await copyIfMissing(path.join(root, "tests", "fixtures", "sprint6", "rejected-plugin"), path.join(managedPlugins, "future-reader"));
  await writeFile(openCliStatePath, `${JSON.stringify({ producthunt: "success" }, null, 2)}\n`, "utf8");
}

export function sprint6Environment() {
  return {
    ...process.env,
    INFOLENS_PROJECT_ROOT: root,
    INFOLENS_PLUGINS_ROOT: managedPlugins,
    INFOLENS_PLUGIN_DATA_ROOT: dataRoot,
    INFOLENS_HOST_STATE_PATH: hostStatePath,
    INFOLENS_BUNDLED_OPENCLI_ROOT: path.join(root, "tests", "fixtures", "sprint5", "opencli"),
    INFOLENS_TEST_OPENCLI_STATE: openCliStatePath,
  };
}
