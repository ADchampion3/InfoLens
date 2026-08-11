import { createHash } from "node:crypto";
import { cp, link, mkdir, readFile, readdir, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import semver from "semver";
import { PLUGIN_CONTRACT_VERSION } from "@infolens/release-metadata";

const ADAPTER_ID = /^[a-z0-9]+(?:[.-][a-z0-9]+)+$/;

export class AdapterScopeError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "AdapterScopeError";
    this.code = code;
  }
}

function fail(condition, code, message) {
  if (condition) throw new AdapterScopeError(code, message);
}

function contained(root, relativePath, field) {
  fail(typeof relativePath !== "string" || !relativePath || path.isAbsolute(relativePath), "INVALID_ADAPTER_PATH", `${field} must be a relative path`);
  const resolved = path.resolve(root, relativePath);
  const relative = path.relative(root, resolved);
  fail(relative.startsWith("..") || path.isAbsolute(relative), "INVALID_ADAPTER_PATH", `${field} escapes the plugin package`);
  return resolved;
}

async function walk(root, current = root, { skipManagedRoot = false } = {}) {
  const entries = await readdir(current, { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (skipManagedRoot && current === root && [".infolens-adapter.json", "node_modules"].includes(entry.name)) continue;
    fail(entry.name === "node_modules", "ADAPTER_DEPENDENCIES_NOT_BUNDLED", `adapter '${root}' must not contain node_modules`);
    const absolute = path.join(current, entry.name);
    if (entry.isDirectory()) files.push(...await walk(root, absolute, { skipManagedRoot }));
    else if (entry.isFile()) files.push(absolute);
    else fail(true, "INVALID_ADAPTER_CONTENT", `adapter content must contain only files and directories: ${absolute}`);
  }
  return files;
}

export async function hashAdapterDirectory(root) {
  const digest = createHash("sha256");
  for (const filename of await walk(root)) {
    const relative = path.relative(root, filename).split(path.sep).join("/");
    digest.update(relative).update("\0").update(await readFile(filename)).update("\0");
  }
  return digest.digest("hex");
}

async function hashPublishedAdapter(root) {
  const digest = createHash("sha256");
  for (const filename of await walk(root, root, { skipManagedRoot: true })) {
    const relative = path.relative(root, filename).split(path.sep).join("/");
    digest.update(relative).update("\0").update(await readFile(filename)).update("\0");
  }
  return digest.digest("hex");
}

async function readAdapterManifest(adapterRoot, declaration, openCliVersion) {
  let adapterManifest;
  try { adapterManifest = JSON.parse(await readFile(path.join(adapterRoot, "opencli-plugin.json"), "utf8")); }
  catch (error) { throw new AdapterScopeError("INVALID_ADAPTER_MANIFEST", `adapter '${declaration.id}' has no valid opencli-plugin.json: ${error.message}`); }
  fail(adapterManifest.name !== declaration.id, "ADAPTER_ID_MISMATCH", `adapter path declares '${adapterManifest.name}', expected '${declaration.id}'`);
  fail(adapterManifest.version !== declaration.version, "ADAPTER_VERSION_MISMATCH", `adapter '${declaration.id}' declares version '${adapterManifest.version}', expected '${declaration.version}'`);
  fail(!semver.valid(declaration.version), "INVALID_ADAPTER_VERSION", `adapter '${declaration.id}' version '${declaration.version}' is invalid`);
  fail(!semver.validRange(adapterManifest.opencli), "INVALID_OPENCLI_RANGE", `adapter '${declaration.id}' has invalid OpenCLI range '${adapterManifest.opencli}'`);
  fail(!semver.satisfies(openCliVersion, adapterManifest.opencli), "INCOMPATIBLE_OPENCLI", `adapter '${declaration.id}' requires OpenCLI '${adapterManifest.opencli}'; bundled version is ${openCliVersion}`);
  let packageManifest = {};
  try { packageManifest = JSON.parse(await readFile(path.join(adapterRoot, "package.json"), "utf8")); } catch {}
  const runtimeDependencies = [packageManifest.dependencies, packageManifest.optionalDependencies]
    .filter(Boolean)
    .flatMap((dependencies) => Object.keys(dependencies));
  fail(runtimeDependencies.length > 0, "ADAPTER_RUNTIME_DEPENDENCIES", `adapter '${declaration.id}' must bundle runtime dependencies into its JavaScript output`);
  const files = await walk(adapterRoot);
  fail(!files.some((file) => file.endsWith(".js") || file.endsWith(".mjs")), "ADAPTER_BUILD_MISSING", `adapter '${declaration.id}' contains no ready-to-run JavaScript`);
  const sources = await Promise.all(files.filter((file) => /\.[cm]?js$/.test(file)).map((file) => readFile(file, "utf8")));
  fail(sources.some((source) => /\b(?:onStartup|onBeforeExecute|onAfterExecute)\s*\(/.test(source)), "UNSUPPORTED_OPENCLI_HOOK", `adapter '${declaration.id}' registers an unsupported OpenCLI lifecycle hook`);
  return adapterManifest;
}

async function linkOpenCliRuntime(target, openCliPackageRoot) {
  if (!openCliPackageRoot) return;
  const linkRoot = path.join(target, "node_modules", "@jackwener");
  const linkPath = path.join(linkRoot, "opencli");
  await mkdir(linkRoot, { recursive: true });
  await symlink(openCliPackageRoot, linkPath, process.platform === "win32" ? "junction" : "dir");
}

async function publishAdapter(storeRoot, adapter, sourceRoot, hash, openCliPackageRoot) {
  const target = path.join(storeRoot, "store", adapter.id, adapter.version);
  const metadataPath = path.join(target, ".infolens-adapter.json");
  try {
    const installed = JSON.parse(await readFile(metadataPath, "utf8"));
    fail(installed.sha256 !== hash, "ADAPTER_VERSION_CONFLICT", `adapter '${adapter.id}@${adapter.version}' is already installed with different content`);
    const installedHash = await hashPublishedAdapter(target);
    fail(installedHash !== installed.sha256, "ADAPTER_STORE_CORRUPTED", `adapter '${adapter.id}@${adapter.version}' content no longer matches its stored hash`);
    return target;
  } catch (error) {
    if (error instanceof AdapterScopeError) throw error;
    if (error.code !== "ENOENT") throw error;
  }
  await mkdir(path.dirname(target), { recursive: true });
  const temporary = path.join(path.dirname(target), `.install-${adapter.version}-${process.pid}-${Date.now()}`);
  await rm(temporary, { recursive: true, force: true });
  await cp(sourceRoot, temporary, { recursive: true, errorOnExist: true });
  await linkOpenCliRuntime(temporary, openCliPackageRoot);
  await writeFile(path.join(temporary, ".infolens-adapter.json"), `${JSON.stringify({ id: adapter.id, version: adapter.version, sha256: hash }, null, 2)}\n`, "utf8");
  try { await rename(temporary, target); }
  catch (error) {
    await rm(temporary, { recursive: true, force: true });
    if (error.code !== "EEXIST" && error.code !== "ENOTEMPTY") throw error;
    const installed = JSON.parse(await readFile(metadataPath, "utf8"));
    fail(installed.sha256 !== hash, "ADAPTER_VERSION_CONFLICT", `adapter '${adapter.id}@${adapter.version}' is already installed with different content`);
    const installedHash = await hashPublishedAdapter(target);
    fail(installedHash !== installed.sha256, "ADAPTER_STORE_CORRUPTED", `adapter '${adapter.id}@${adapter.version}' content no longer matches its stored hash`);
  }
  return target;
}

async function publishDevelopmentAdapter(registryRoot, pluginId, key, sourceRoot, openCliPackageRoot) {
  const target = path.join(registryRoot, "development", pluginId, key);
  await rm(target, { recursive: true, force: true });
  await mkdir(target, { recursive: true });
  for (const entry of await readdir(sourceRoot, { withFileTypes: true })) {
    const source = path.join(sourceRoot, entry.name);
    const destination = path.join(target, entry.name);
    if (entry.isDirectory()) await symlink(source, destination, process.platform === "win32" ? "junction" : "dir");
    else if (process.platform === "win32") await link(source, destination);
    else await symlink(source, destination, "file");
  }
  await linkOpenCliRuntime(target, openCliPackageRoot);
  return target;
}

function normalizedReportCommand(command) {
  return {
    command: command.command?.replace("/", " ") ?? `${command.site} ${command.name}`,
    strategy: String(command.strategy).toUpperCase(),
    access: command.access,
    source: command.source,
  };
}

export async function preparePluginAdapterScope({ packageRoot, manifest, runtime, registryRoot, inspect, development = false }) {
  const declarations = manifest.openCliAdapters ?? {};
  fail(!declarations || typeof declarations !== "object" || Array.isArray(declarations), "INVALID_ADAPTERS", "openCliAdapters must be an object");
  const resolved = [];
  for (const [key, declaration] of Object.entries(declarations)) {
    fail(!key || key === "builtin", "INVALID_ADAPTER_KEY", `'${key}' is not a valid provided adapter key`);
    fail(!declaration || typeof declaration !== "object" || Array.isArray(declaration), "INVALID_ADAPTER", `adapter '${key}' must be an object`);
    fail(!ADAPTER_ID.test(declaration.id), "INVALID_ADAPTER_ID", `adapter '${key}' id '${declaration.id}' must be a reverse-domain name`);
    const sourceRoot = contained(packageRoot, declaration.path, `openCliAdapters.${key}.path`);
    fail(!(await stat(sourceRoot)).isDirectory(), "INVALID_ADAPTER_PATH", `adapter '${key}' path must be a directory`);
    await readAdapterManifest(sourceRoot, declaration, runtime.version);
    const sha256 = await hashAdapterDirectory(sourceRoot);
    const installedPath = development
      ? await publishDevelopmentAdapter(registryRoot, manifest.id, key, sourceRoot, runtime.packageRoot)
      : await publishAdapter(registryRoot, declaration, sourceRoot, sha256, runtime.packageRoot);
    resolved.push({ key, id: declaration.id, version: declaration.version, sha256, path: installedPath });
  }

  try {
    const integrity = JSON.parse(await readFile(path.join(packageRoot, "adapter-integrity.json"), "utf8"));
    fail(integrity.pluginId !== manifest.id || integrity.version !== manifest.version, "ADAPTER_INTEGRITY_MISMATCH", "adapter integrity metadata does not match the plugin package");
    for (const adapter of resolved) {
      const expected = integrity.adapters?.find((entry) => entry.id === adapter.id && entry.version === adapter.version);
      fail(!expected || expected.sha256 !== adapter.sha256, "ADAPTER_INTEGRITY_MISMATCH", `adapter '${adapter.id}@${adapter.version}' does not match adapter-integrity.json`);
    }
  } catch (error) {
    if (error instanceof AdapterScopeError) throw error;
    if (error.code !== "ENOENT") throw new AdapterScopeError("INVALID_ADAPTER_INTEGRITY", `adapter-integrity.json is invalid: ${error.message}`);
  }

  const individualReports = await Promise.all(resolved.map(async (adapter) => ({
    adapter,
    report: await inspect([adapter.path]),
  })));
  const combinedReport = resolved.length > 1
    ? await inspect(resolved.map((adapter) => adapter.path)
    ) : individualReports[0]?.report ?? { commands: [], hooks: [], collisions: [] };
  fail(individualReports.some(({ report }) => (report.hooks?.length ?? 0) > 0), "UNSUPPORTED_OPENCLI_HOOK", "provided adapters register unsupported OpenCLI lifecycle hooks");
  fail((combinedReport.collisions?.length ?? 0) > 0, "OPENCLI_COMMAND_COLLISION", `provided adapters register duplicate commands: ${combinedReport.collisions.join(", ")}`);
  const providedCommands = new Map();
  for (const { adapter, report } of individualReports) {
    for (const command of report.commands ?? []) {
      const normalized = { ...normalizedReportCommand(command), adapter: adapter.key };
      fail(providedCommands.has(normalized.command), "OPENCLI_COMMAND_COLLISION", `provided adapters register duplicate command '${normalized.command}'`);
      providedCommands.set(normalized.command, normalized);
    }
  }
  for (const command of providedCommands.keys()) {
    fail(runtime.availableCommands.has(command), "OPENCLI_COMMAND_COLLISION", `provided command '${command}' collides with bundled OpenCLI`);
  }

  for (const [key, mapping] of Object.entries(manifest.openCliCommands)) {
    if (mapping.adapter === "builtin") continue;
    const declaration = declarations[mapping.adapter];
    fail(!declaration, "UNKNOWN_ADAPTER", `command '${key}' references unknown adapter '${mapping.adapter}'`);
    const commandName = mapping.command.join(" ");
    const actual = providedCommands.get(commandName);
    fail(!actual, "UNAVAILABLE_COMMAND", `command '${key}' is unavailable in adapter '${mapping.adapter}': ${commandName}`);
    fail(actual.adapter !== mapping.adapter, "ADAPTER_COMMAND_MISMATCH", `command '${key}' is registered by adapter '${actual.adapter}', not '${mapping.adapter}'`);
    fail(actual.strategy !== mapping.strategy || actual.access !== mapping.access, "ADAPTER_COMMAND_MISMATCH", `command '${key}' declaration does not match OpenCLI registration`);
  }
  const declaredCommands = new Set(Object.values(manifest.openCliCommands)
    .filter((mapping) => mapping.adapter !== "builtin")
    .map((mapping) => `${mapping.adapter}\0${mapping.command.join(" ")}`));
  for (const command of providedCommands.values()) {
    fail(!declaredCommands.has(`${command.adapter}\0${command.command}`), "UNDECLARED_ADAPTER_COMMAND", `adapter '${command.adapter}' registered undeclared command '${command.command}'`);
  }

  const lock = {
    contractVersion: PLUGIN_CONTRACT_VERSION,
    pluginId: manifest.id,
    openCliVersion: runtime.version,
    adapters: resolved,
    commands: [...providedCommands.values()],
  };
  const scopeRoot = path.join(registryRoot, "scopes", manifest.id);
  await mkdir(scopeRoot, { recursive: true });
  const temporary = path.join(scopeRoot, `scope.lock.${process.pid}.${Date.now()}.tmp`);
  await writeFile(temporary, `${JSON.stringify(lock, null, 2)}\n`, "utf8");
  await rename(temporary, path.join(scopeRoot, "scope.lock.json"));
  return lock;
}

export async function garbageCollectAdapterStore(registryRoot) {
  const referenced = new Set();
  const scopesRoot = path.join(registryRoot, "scopes");
  try {
    for (const entry of await readdir(scopesRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      try {
        const lock = JSON.parse(await readFile(path.join(scopesRoot, entry.name, "scope.lock.json"), "utf8"));
        for (const adapter of lock.adapters ?? []) referenced.add(path.resolve(adapter.path));
      } catch {}
    }
  } catch (error) { if (error.code !== "ENOENT") throw error; }

  const storeRoot = path.join(registryRoot, "store");
  try {
    for (const idEntry of await readdir(storeRoot, { withFileTypes: true })) {
      if (!idEntry.isDirectory()) continue;
      const idRoot = path.join(storeRoot, idEntry.name);
      for (const versionEntry of await readdir(idRoot, { withFileTypes: true })) {
        if (!versionEntry.isDirectory()) continue;
        const adapterRoot = path.resolve(idRoot, versionEntry.name);
        if (!referenced.has(adapterRoot)) await rm(adapterRoot, { recursive: true, force: true });
      }
      if ((await readdir(idRoot)).length === 0) await rm(idRoot, { recursive: true, force: true });
    }
  } catch (error) { if (error.code !== "ENOENT") throw error; }
}

export async function removePluginAdapterScope(registryRoot, pluginId) {
  await rm(path.join(registryRoot, "scopes", pluginId), { recursive: true, force: true });
  await rm(path.join(registryRoot, "development", pluginId), { recursive: true, force: true });
  await garbageCollectAdapterStore(registryRoot);
}
