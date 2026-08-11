#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import semver from "semver";
import { loadBundledOpenCli } from "../packages/plugin-runtime/src/opencli-adapter.mjs";

const DEFAULT_ROOT = path.resolve(import.meta.dirname, "..");

function source(pathname, value, logicalSource) {
  return {
    value: value ?? null,
    source: logicalSource,
    sourcePath: pathname,
  };
}

function valueRecord(value, sources = []) {
  return { value: value ?? null, sources };
}

function check(result, id, status, details = {}) {
  result.checks.push({
    id,
    severity: status === "failed" ? "error" : "info",
    status,
    phase: "release",
    ...details,
  });
}

function failure(result, id, code, message, details = {}) {
  check(result, id, "failed", { code, message, details });
  result.error ??= { code, phase: "release", checkId: id, message };
}

async function readJson(filename) {
  try {
    return JSON.parse(await readFile(filename, "utf8"));
  } catch {
    return undefined;
  }
}

function manifestVersion(manifest, filename, logicalSource) {
  return source(filename, typeof manifest?.version === "string" ? manifest.version : null, logicalSource);
}

function allEqual(values) {
  const present = values.filter((value) => value.value !== null).map((value) => value.value);
  return present.length > 0 && present.every((value) => value === present[0]);
}

function valuesFor(sources) {
  const resolved = sources.find((entry) => entry.value !== null)?.value ?? null;
  return valueRecord(resolved, sources);
}

function checkLockstep(result, id, code, sources) {
  if (!sources.every((entry) => entry.value !== null)) {
    failure(result, id, "RELEASE_SOURCE_UNAVAILABLE", "A required release version source is missing", { sources });
    return;
  }
  if (!allEqual(sources)) {
    failure(result, id, code, "Host-facing release versions are not lockstep", { sources });
    return;
  }
  check(result, id, "passed", { details: { value: sources[0].value, sources } });
}

function releaseManifestCandidates(root) {
  return [
    path.join(root, "release-manifest.json"),
    path.join(root, "release", "release-manifest.json"),
  ];
}

function firstFailedCheck(result) {
  return result.checks.find((entry) => entry.severity === "error" && entry.status === "failed");
}

export function createReleaseManifest(verification, extra = {}) {
  if (!verification?.ok) throw new Error("Cannot create a release manifest from a failed verification");
  const host = verification.values.host.value;
  const runtime = verification.values.pluginRuntime.value;
  const sdk = verification.values.pluginSdk.value;
  const contract = verification.values.contract.value;
  const opencli = verification.values.opencli.value;
  const runtimeDetails = verification.details.opencli;
  return {
    name: "Infolens",
    version: host,
    hostVersion: host,
    pluginRuntimeVersion: runtime,
    pluginSdkVersion: sdk,
    pluginContractVersion: Number(contract),
    openCliVersion: opencli,
    openCli: {
      version: opencli,
      packageName: runtimeDetails?.packageName,
      executable: runtimeDetails?.executable,
      inventoryPath: "resources/opencli/runtime.json",
    },
    ...extra,
  };
}

export async function verifyRelease({
  root = DEFAULT_ROOT,
  releaseManifestPath,
  requireReleaseManifest = false,
  opencliRoot,
} = {}) {
  const resolvedRoot = path.resolve(root);
  const result = {
    ok: false,
    command: "verify-release",
    root: resolvedRoot,
    values: {
      host: valueRecord(null),
      pluginRuntime: valueRecord(null),
      pluginSdk: valueRecord(null),
      contract: valueRecord(null),
      opencli: valueRecord(null),
      releaseManifest: valueRecord(null),
    },
    details: {},
    checks: [],
  };

  const rootPackagePath = path.join(resolvedRoot, "package.json");
  const desktopPackagePath = path.join(resolvedRoot, "apps", "desktop", "package.json");
  const runtimePackagePath = path.join(resolvedRoot, "packages", "plugin-runtime", "package.json");
  const sdkPackagePath = path.join(resolvedRoot, "packages", "plugin-sdk", "package.json");
  const metadataPackagePath = path.join(resolvedRoot, "packages", "release-metadata", "package.json");
  const metadataPath = path.join(resolvedRoot, "packages", "release-metadata", "release-metadata.json");
  const opencliPackagePath = path.join(resolvedRoot, "resources", "opencli", "package.json");
  const opencliRuntimePath = path.join(resolvedRoot, "resources", "opencli", "runtime.json");

  const [rootPackage, desktopPackage, runtimePackage, sdkPackage, metadataPackage, metadata, opencliPackage, opencliRuntime] = await Promise.all([
    readJson(rootPackagePath),
    readJson(desktopPackagePath),
    readJson(runtimePackagePath),
    readJson(sdkPackagePath),
    readJson(metadataPackagePath),
    readJson(metadataPath),
    readJson(opencliPackagePath),
    readJson(opencliRuntimePath),
  ]);

  const hostSources = [
    manifestVersion(rootPackage, rootPackagePath, "root-package"),
    manifestVersion(desktopPackage, desktopPackagePath, "desktop-package"),
    manifestVersion(runtimePackage, runtimePackagePath, "plugin-runtime-package"),
    manifestVersion(metadataPackage, metadataPackagePath, "release-metadata-package"),
    source(metadataPath, typeof metadata?.hostVersion === "string" ? metadata.hostVersion : null, "release-metadata-json"),
  ];
  result.values.host = valuesFor(hostSources);
  result.values.hostVersion = result.values.host;
  checkLockstep(result, "release.host-lockstep", "RELEASE_HOST_VERSION_DRIFT", hostSources);
  if (result.values.host.value !== null && !semver.valid(result.values.host.value)) {
    failure(result, "release.host-version", "RELEASE_HOST_VERSION_INVALID", "The resolved Host version is not semantic versioning", { value: result.values.host.value, sources: hostSources });
  } else if (result.values.host.value !== null) {
    check(result, "release.host-version", "passed", { details: { value: result.values.host.value } });
  }

  const runtimeVersion = manifestVersion(runtimePackage, runtimePackagePath, "plugin-runtime-package");
  result.values.pluginRuntime = valuesFor([runtimeVersion]);
  result.values.pluginRuntimeVersion = result.values.pluginRuntime;
  if (runtimeVersion.value === null) failure(result, "release.plugin-runtime", "RELEASE_SOURCE_UNAVAILABLE", "Plugin Runtime package version is missing", { source: runtimeVersion });
  else if (runtimeVersion.value !== result.values.host.value) failure(result, "release.plugin-runtime", "RELEASE_HOST_VERSION_DRIFT", "Plugin Runtime version does not match Host version", { source: runtimeVersion, host: result.values.host });
  else check(result, "release.plugin-runtime", "passed", { details: { source: runtimeVersion } });

  const sdkVersion = manifestVersion(sdkPackage, sdkPackagePath, "plugin-sdk-package");
  result.values.pluginSdk = valuesFor([sdkVersion]);
  result.values.pluginSdkVersion = result.values.pluginSdk;
  if (sdkVersion.value === null) failure(result, "release.plugin-sdk", "RELEASE_SOURCE_UNAVAILABLE", "Plugin SDK package version is missing", { source: sdkVersion });
  else if (!semver.valid(sdkVersion.value)) failure(result, "release.plugin-sdk", "RELEASE_SDK_VERSION_INVALID", "Plugin SDK version is not semantic versioning", { source: sdkVersion });
  else check(result, "release.plugin-sdk", "passed", { details: { source: sdkVersion } });

  const contractValue = Number.isInteger(metadata?.pluginContractVersion) ? String(metadata.pluginContractVersion) : null;
  const contractSources = [source(metadataPath, contractValue, "release-metadata-json")];
  result.values.contract = valuesFor(contractSources);
  result.values.contractVersion = result.values.contract;
  if (contractValue === null) failure(result, "release.plugin-contract", "RELEASE_CONTRACT_INVALID", "Plugin Contract Version must be an integer in release metadata", { sources: contractSources });
  else check(result, "release.plugin-contract", "passed", { details: { source: contractSources[0] } });

  const selectedOpenCliRoot = path.resolve(opencliRoot ?? path.join(resolvedRoot, "resources", "opencli"));
  const selectedOpenCliRuntimePath = path.join(selectedOpenCliRoot, "runtime.json");
  const selectedOpenCliRuntime = await readJson(selectedOpenCliRuntimePath);
  let runtime;
  try {
    runtime = await loadBundledOpenCli(selectedOpenCliRoot, { source: "release-verifier", sourcePath: opencliPackagePath });
    const installedPackagePath = path.join(runtime.packageRoot, "package.json");
    const installedPackage = await readJson(installedPackagePath);
    const dependency = runtime.declaredDependency;
    const opencliSources = [
      source(opencliPackagePath, dependency?.version ?? null, "opencli-exact-dependency"),
      source(installedPackagePath, installedPackage?.version ?? null, "opencli-installed-package"),
      source(selectedOpenCliRuntimePath, selectedOpenCliRuntime?.version ?? null, "opencli-generated-inventory"),
    ];
    result.values.opencli = valuesFor(opencliSources);
    result.values.openCli = result.values.opencli;
    result.details.opencli = {
      packageName: runtime.packageName,
      packageRoot: runtime.packageRoot,
      executable: path.relative(selectedOpenCliRoot, runtime.executablePath),
      distributionRoot: runtime.distributionRoot,
      inventoryPath: runtime.inventoryPath,
      inventory: runtime.inventory,
      declaredDependency: runtime.declaredDependency,
    };
    if (!opencliPackage || opencliPackage.version !== dependency.version) {
      failure(result, "release.opencli-wrapper", "RELEASE_OPENCLI_WRAPPER_DRIFT", "Bundled OpenCLI package version does not match its exact dependency", { sources: opencliSources });
    } else check(result, "release.opencli-authority", "passed", { details: { sources: opencliSources, inventory: runtime.inventory } });
  } catch (error) {
    const code = typeof error?.code === "string" ? error.code : "RELEASE_OPENCLI_UNAVAILABLE";
    const message = error instanceof Error ? error.message : String(error);
    const opencliSources = [
      source(opencliPackagePath, opencliPackage?.dependencies?.["@jackwener/opencli"] ?? null, "opencli-exact-dependency"),
      source(selectedOpenCliRuntimePath, selectedOpenCliRuntime?.version ?? null, "opencli-generated-inventory"),
    ];
    result.values.opencli = valuesFor(opencliSources);
    result.values.openCli = result.values.opencli;
    failure(result, "release.opencli-authority", code, message, { sources: opencliSources, sourcePath: error?.sourcePath });
  }

  let manifestPath = releaseManifestPath ? path.resolve(releaseManifestPath) : undefined;
  if (!manifestPath && !requireReleaseManifest) {
    for (const candidate of releaseManifestCandidates(resolvedRoot)) {
      if (await readJson(candidate)) {
        manifestPath = candidate;
        break;
      }
    }
  }
  if (!manifestPath) {
    if (requireReleaseManifest) failure(result, "release.manifest", "RELEASE_MANIFEST_MISSING", "Release manifest is required but missing", {});
    else check(result, "release.manifest", "skipped", { details: { reason: "No release manifest supplied for source verification" } });
  } else {
    const releaseManifest = await readJson(manifestPath);
    result.values.releaseManifest = valueRecord(releaseManifest ?? null, [source(manifestPath, releaseManifest ? "present" : null, "release-manifest")]);
    if (!releaseManifest || typeof releaseManifest !== "object" || Array.isArray(releaseManifest)) {
      failure(result, "release.manifest", "RELEASE_MANIFEST_INVALID", "Release manifest is missing or invalid JSON", { sourcePath: manifestPath });
    } else {
      const expected = {
        hostVersion: result.values.host.value,
        pluginRuntimeVersion: result.values.pluginRuntime.value,
        pluginSdkVersion: result.values.pluginSdk.value,
        pluginContractVersion: result.values.contract.value === null ? null : Number(result.values.contract.value),
        openCliVersion: result.values.opencli.value,
      };
      const actual = {
        hostVersion: releaseManifest.hostVersion,
        pluginRuntimeVersion: releaseManifest.pluginRuntimeVersion,
        pluginSdkVersion: releaseManifest.pluginSdkVersion,
        pluginContractVersion: releaseManifest.pluginContractVersion,
        openCliVersion: releaseManifest.openCliVersion,
      };
      const fields = [
        ["hostVersion", "RELEASE_MANIFEST_HOST_DRIFT"],
        ["pluginRuntimeVersion", "RELEASE_MANIFEST_RUNTIME_DRIFT"],
        ["pluginSdkVersion", "RELEASE_MANIFEST_SDK_DRIFT"],
        ["pluginContractVersion", "RELEASE_MANIFEST_CONTRACT_DRIFT"],
        ["openCliVersion", "RELEASE_MANIFEST_OPENCLI_DRIFT"],
      ];
      for (const [field, code] of fields) {
        if (expected[field] === null || actual[field] === undefined || String(actual[field]) !== String(expected[field])) {
          failure(result, `release.manifest.${field}`, code, `Release manifest field '${field}' does not match verified release metadata`, { expected: expected[field], actual: actual[field], sourcePath: manifestPath });
        } else check(result, `release.manifest.${field}`, "passed", { details: { value: actual[field], sourcePath: manifestPath } });
      }
      result.details.releaseManifest = { path: manifestPath, fields: actual };
    }
  }

  const failed = firstFailedCheck(result);
  result.ok = !failed;
  return result;
}

function parseOptions(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!["--root", "--manifest", "--opencli-root"].includes(value)) throw new Error(`Unknown option '${value}'`);
    if (index + 1 >= argv.length) throw new Error(`${value} requires a value`);
    options[value.slice(2).replaceAll("-", "_")] = argv[++index];
  }
  return options;
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  let result;
  try {
    const options = parseOptions(process.argv.slice(2));
    result = await verifyRelease({ root: options.root, releaseManifestPath: options.manifest, opencliRoot: options.opencli_root });
  } catch (error) {
    result = {
      ok: false,
      command: "verify-release",
      values: {},
      checks: [{ id: "release.arguments", severity: "error", status: "failed", phase: "arguments", code: "RELEASE_INVALID_ARGUMENTS", message: error instanceof Error ? error.message : String(error) }],
      error: { code: "RELEASE_INVALID_ARGUMENTS", phase: "arguments", checkId: "release.arguments", message: error instanceof Error ? error.message : String(error) },
    };
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!result.ok) process.exitCode = 1;
}
