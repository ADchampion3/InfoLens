import { access, readFile } from "node:fs/promises";
import path from "node:path";
import semver from "semver";

export const CONTRACT_VERSION = "1";
export const HOST_VERSION = "0.1.0";
const SUPPORTED_STRATEGIES = new Set(["PUBLIC", "COOKIE", "INTERCEPT"]);

export class ContractError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ContractError";
    this.code = code;
  }
}

function reject(condition, code, message) {
  if (condition) throw new ContractError(code, message);
}

function requireString(value, field) {
  reject(typeof value !== "string" || value.trim() === "", "INVALID_MANIFEST", `${field} must be a non-empty string`);
}

function resolvePackagePath(packageRoot, relativePath, field) {
  requireString(relativePath, field);
  reject(path.isAbsolute(relativePath), "INVALID_PACKAGE_PATH", `${field} must be relative to the plugin package`);
  const resolved = path.resolve(packageRoot, relativePath);
  const relative = path.relative(packageRoot, resolved);
  reject(relative.startsWith("..") || path.isAbsolute(relative), "INVALID_PACKAGE_PATH", `${field} escapes the plugin package`);
  return resolved;
}

export async function validatePluginPackage(packageRoot, runtime) {
  let manifest;
  try {
    manifest = JSON.parse(await readFile(path.join(packageRoot, "manifest.json"), "utf8"));
  } catch (error) {
    throw new ContractError("INVALID_PACKAGE", `manifest.json is missing or invalid JSON: ${error.message}`);
  }

  reject(!manifest || typeof manifest !== "object" || Array.isArray(manifest), "INVALID_MANIFEST", "manifest.json must contain an object");
  for (const field of ["id", "name", "version", "contractVersion", "minHostVersion"]) requireString(manifest[field], field);
  reject(!/^[a-z0-9][a-z0-9-]*$/.test(manifest.id), "INVALID_PLUGIN_ID", "id must contain only lowercase letters, numbers, and hyphens");
  reject(!semver.valid(manifest.version), "INVALID_PLUGIN_VERSION", `version '${manifest.version}' is not semantic versioning`);
  reject(manifest.contractVersion !== CONTRACT_VERSION, "INCOMPATIBLE_CONTRACT", `contractVersion '${manifest.contractVersion}' is unsupported; expected '${CONTRACT_VERSION}'`);
  reject(!semver.valid(manifest.minHostVersion), "INVALID_HOST_VERSION", `minHostVersion '${manifest.minHostVersion}' is not semantic versioning`);
  reject(semver.gt(manifest.minHostVersion, runtime.hostVersion), "INCOMPATIBLE_HOST", `plugin requires host >=${manifest.minHostVersion}; current host is ${runtime.hostVersion}`);
  reject(!manifest.backend || typeof manifest.backend !== "object", "INVALID_MANIFEST", "backend must be an object");
  reject(!manifest.ui || typeof manifest.ui !== "object", "INVALID_MANIFEST", "ui must be an object");

  const backendPath = resolvePackagePath(packageRoot, manifest.backend.entry, "backend.entry");
  const workspaceEntry = resolvePackagePath(packageRoot, manifest.ui.entry, "ui.entry");
  try {
    await Promise.all([access(backendPath), access(workspaceEntry)]);
  } catch {
    throw new ContractError("INVALID_PACKAGE_STRUCTURE", "backend.entry and ui.entry must point to existing files");
  }

  reject(!manifest.openCliCommands || typeof manifest.openCliCommands !== "object" || Array.isArray(manifest.openCliCommands), "INVALID_COMMANDS", "openCliCommands must be an object");
  for (const [key, mapping] of Object.entries(manifest.openCliCommands)) {
    requireString(key, "openCliCommands key");
    reject(!mapping || typeof mapping !== "object" || Array.isArray(mapping), "INVALID_COMMAND", `command '${key}' must be an object`);
    requireString(mapping.site, `openCliCommands.${key}.site`);
    reject(!Array.isArray(mapping.command) || mapping.command.length === 0 || mapping.command.some((part) => typeof part !== "string" || !part), "INVALID_COMMAND", `command '${key}' must declare a non-empty command path`);
    reject(mapping.command.some((part) => part.startsWith("-")), "INVALID_COMMAND", `command '${key}' path cannot contain options`);
    reject(mapping.access !== "read", "UNSUPPORTED_ACCESS", `command '${key}' must declare access 'read'`);
    reject(mapping.outputFormat !== "json", "UNSUPPORTED_OUTPUT", `command '${key}' must declare outputFormat 'json'`);
    reject(!SUPPORTED_STRATEGIES.has(mapping.strategy), "UNSUPPORTED_STRATEGY", `command '${key}' uses unsupported strategy '${mapping.strategy}'`);
    reject(!semver.validRange(mapping.openCliVersionRange), "INVALID_OPENCLI_RANGE", `command '${key}' has invalid openCliVersionRange '${mapping.openCliVersionRange}'`);
    reject(!semver.satisfies(runtime.openCliVersion, mapping.openCliVersionRange), "INCOMPATIBLE_OPENCLI", `command '${key}' requires OpenCLI '${mapping.openCliVersionRange}'; bundled version is ${runtime.openCliVersion}`);
    reject(!runtime.availableCommands.has(mapping.command.join(" ")), "UNAVAILABLE_COMMAND", `command '${key}' is unavailable in bundled OpenCLI: ${mapping.command.join(" ")}`);
  }

  return { manifest, backendPath, workspaceEntry, workspaceRoot: path.dirname(workspaceEntry) };
}
