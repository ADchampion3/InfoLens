import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const OPENCLI_PACKAGE_NAME = "@jackwener/opencli";
const OPENCLI_PACKAGE_VERSION = "1.8.6";

export function patchOpenCliDiscovery(source) {
  if (source.includes("export async function discoverPluginPaths")) return source;
  const marker = "/**\n * Flat scan: read ts/js files directly in a plugin directory.";
  if (!source.includes(marker)) throw new Error("OpenCLI plugin discovery contract changed");
  const addition = `export async function discoverPluginPaths(paths) {\n    for (const pluginPath of paths) {\n        const name = path.basename(pluginPath);\n        await discoverPluginDir(path.resolve(pluginPath), name);\n    }\n}\n\n`;
  return source.replace(marker, `${addition}${marker}`);
}

export function patchOpenCliRegistry(source) {
  if (source.includes("getRegistrationCollisions")) return source;
  const registryMarker = "const _registry = globalThis.__opencli_registry__ ??= new Map();";
  const existingMarker = "    const existing = _registry.get(canonicalKey);";
  if (!source.includes(registryMarker) || !source.includes(existingMarker)) throw new Error("OpenCLI registry contract changed");
  return source
    .replace(registryMarker, `${registryMarker}\nconst _registrationCollisions = globalThis.__opencli_registration_collisions__ ??= [];\nexport function getRegistrationCollisions() { return [..._registrationCollisions]; }`)
    .replace(existingMarker, `${existingMarker}\n    if (existing) _registrationCollisions.push(canonicalKey);`);
}

export function patchOpenCliMain(source) {
  if (source.includes("OPENCLI_REGISTRATION_REPORT")) {
    return source.replace("[...new Set([...getRegistry().values())]\n        .values()]", "[...new Set(getRegistry().values())]");
  }
  const importMarker = "const { discoverClis, discoverPlugins, ensureUserCliCompatShims, ensureUserAdapters } = await import('./discovery.js');";
  const discoveryMarker = "    await discoverClis(USER_CLIS);\n    await discoverPlugins();";
  const afterDiscoveryMarker = "// Register exit hook: notice appears after command output (same as npm/gh/yarn)";
  if (!source.includes(importMarker) || !source.includes(discoveryMarker) || !source.includes(afterDiscoveryMarker)) throw new Error("OpenCLI startup discovery contract changed");
  const patchedImport = "const { discoverClis, discoverPlugins, discoverPluginPaths, ensureUserCliCompatShims, ensureUserAdapters } = await import('./discovery.js');";
  const patchedDiscovery = `    if (process.env.OPENCLI_DISABLE_USER_DISCOVERY !== '1') {\n        await discoverClis(USER_CLIS);\n        await discoverPlugins();\n    }\n    const pluginPaths = (process.env.OPENCLI_PLUGIN_PATHS ?? '').split(path.delimiter).filter(Boolean);\n    await discoverPluginPaths(pluginPaths);`;
  const report = `if (process.env.OPENCLI_REGISTRATION_REPORT === '1') {\n    const { getRegistry, getRegistrationCollisions, fullName } = await import('./registry.js');\n    const commands = [...new Set(getRegistry().values())]\n        .filter((command) => !BUILTIN_COMMANDS.has(fullName(command)))\n        .map((command) => ({ command: fullName(command), site: command.site, name: command.name, strategy: command.strategy, access: command.access }));\n    const hooks = [...(globalThis.__opencli_hooks__?.keys() ?? [])];\n    process.stdout.write(JSON.stringify({ commands, hooks, collisions: getRegistrationCollisions() }));\n    process.exit(EXIT_CODES.SUCCESS);\n}\n`;
  const builtinsMarker = "// Register exit hook: notice appears after command output (same as npm/gh/yarn)";
  let patched = source.replace(importMarker, patchedImport).replace(discoveryMarker, patchedDiscovery);
  const captureMarker = "const skipUserDiscovery = argv[0] === 'convention-audit';";
  patched = patched.replace(captureMarker, `const { getRegistry: getStartupRegistry, fullName: startupFullName } = await import('./registry.js');\nconst BUILTIN_COMMANDS = new Set();\n${captureMarker}`);
  patched = patched.replace("    await discoverClis(BUILTIN_CLIS);\n}\nelse {", "    await discoverClis(BUILTIN_CLIS);\n    for (const command of getStartupRegistry().values()) BUILTIN_COMMANDS.add(startupFullName(command));\n}\nelse {");
  patched = patched.replace("    const [, ,] = await Promise.all([\n        ensureUserCliCompatShims(),\n        ensureUserAdapters(),\n        discoverClis(BUILTIN_CLIS),\n    ]);", "    const [, ,] = await Promise.all([\n        ensureUserCliCompatShims(),\n        ensureUserAdapters(),\n        discoverClis(BUILTIN_CLIS),\n    ]);\n    for (const command of getStartupRegistry().values()) BUILTIN_COMMANDS.add(startupFullName(command));");
  return patched.replace(builtinsMarker, `${report}${builtinsMarker}`);
}

export async function applyOpenCliOverrides(root = path.resolve(import.meta.dirname, "..")) {
  const packageRoot = path.join(root, "resources", "opencli", "node_modules", "@jackwener", "opencli");
  const packageManifest = JSON.parse(await readFile(path.join(packageRoot, "package.json"), "utf8"));
  if (packageManifest.name !== OPENCLI_PACKAGE_NAME || packageManifest.version !== OPENCLI_PACKAGE_VERSION) {
    throw new Error(`OpenCLI override requires ${OPENCLI_PACKAGE_NAME} ${OPENCLI_PACKAGE_VERSION}; found ${packageManifest.name ?? "unknown"} ${packageManifest.version ?? "unknown"}`);
  }
  const sourceRoot = path.join(packageRoot, "dist", "src");
  for (const [filename, patcher] of [
    ["discovery.js", patchOpenCliDiscovery],
    ["registry.js", patchOpenCliRegistry],
    ["main.js", patchOpenCliMain],
  ]) {
    const target = path.join(sourceRoot, filename);
    const original = await readFile(target, "utf8");
    const next = patcher(original);
    if (next !== original) await writeFile(target, next, "utf8");
  }
}

if (fileURLToPath(import.meta.url) === path.resolve(process.argv[1] ?? "")) {
  await applyOpenCliOverrides();
}
