import { spawn } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import semver from "semver";
import { redactSensitiveText } from "./redaction.mjs";
import { parseBrowserDoctorOutput } from "./browser-bridge.mjs";

const require = createRequire(import.meta.url);
const MAX_CAPTURED_OUTPUT_BYTES = 16 * 1024 * 1024;

export class BundledOpenCliError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "BundledOpenCliError";
    this.code = code;
    Object.assign(this, details);
  }
}

export class OpenCliError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "OpenCliError";
    this.code = code;
  }
}

function classifyFailure(stderr, code) {
  const details = String(stderr);
  if (code === 69 || /Browser Bridge extension not connected|Extension not connected|No Browser Bridge profiles connected|ECONNREFUSED[^\n]*19825/i.test(details)) {
    return new OpenCliError("BROWSER_BRIDGE_DISCONNECTED", "Browser Bridge is not connected");
  }
  if (code === 77 || /AUTH_REQUIRED|AuthRequiredError|not[_ -]?logged[_ -]?in|login (?:is )?required|requires? (?:an? )?(?:authenticated|logged-in) (?:browser )?session/i.test(details)) {
    return new OpenCliError("SITE_LOGIN_REQUIRED", "The source login is required");
  }
  return new OpenCliError("OPENCLI_FAILED", `Bundled OpenCLI exited with code ${code}: ${redactSensitiveText(details.trim() || "no error output")}`);
}

const OPENCLI_DOCTOR_SESSION = "__doctor__";

function processCommand(executablePath) {
  if (!executablePath.endsWith(".js") && !executablePath.endsWith(".mjs")) {
    return { file: executablePath, prefix: [], electronNodeMode: false };
  }
  if (process.versions.electron) {
    const launcherPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "electron-node-launcher.mjs");
    return { file: process.execPath, prefix: [launcherPath, executablePath], electronNodeMode: true };
  }
  return { file: process.execPath, prefix: [executablePath], electronNodeMode: false };
}

function runtimeFailure(code, message, details = {}) {
  return new BundledOpenCliError(code, message, details);
}

function exactDependency(packageManifest) {
  const dependencies = {
    ...(packageManifest.dependencies ?? {}),
    ...(packageManifest.optionalDependencies ?? {}),
  };
  const entries = Object.entries(dependencies).filter(([name]) => name === "@jackwener/opencli");
  if (entries.length !== 1 || !/^\d+\.\d+\.\d+$/.test(entries[0][1])) {
    throw runtimeFailure("OPENCLI_DECLARATION_INVALID", "Bundled OpenCLI package must declare one exact @jackwener/opencli dependency");
  }
  return { name: entries[0][0], version: entries[0][1] };
}

async function existingFile(filename, code, message, details = {}) {
  try { await stat(filename); }
  catch { throw runtimeFailure(code, message, { ...details, sourcePath: filename }); }
}

async function validateInventory(packageRoot, commands, inventoryPath) {
  const seen = new Set();
  for (const command of commands) {
    if (!Array.isArray(command) || command.length < 2 || command.some((part) => typeof part !== "string" || !part.trim())) {
      throw runtimeFailure("OPENCLI_INVENTORY_MISMATCH", "Generated OpenCLI command inventory contains an invalid command", { sourcePath: inventoryPath });
    }
    const key = command.join(" ");
    if (seen.has(key)) throw runtimeFailure("OPENCLI_INVENTORY_MISMATCH", `Generated OpenCLI command inventory contains duplicate '${key}'`, { sourcePath: inventoryPath });
    seen.add(key);
    const commandRoot = path.resolve(packageRoot, "clis", command[0]);
    const candidates = [
      path.join(commandRoot, `${command.slice(1).join("/")}.js`),
      path.join(commandRoot, `${command.slice(1).join("/")}.mjs`),
      ...(command.at(-1) === "whoami" ? [path.join(commandRoot, "auth.js"), path.join(commandRoot, "auth.mjs")] : []),
    ];
    let found = false;
    for (const candidate of candidates) {
      try { await stat(candidate); found = true; break; } catch {}
    }
    if (!found) throw runtimeFailure("OPENCLI_INVENTORY_MISMATCH", `Generated OpenCLI inventory references missing command '${key}'`, { sourcePath: inventoryPath, command: key });
  }
  return seen;
}

export function resolveBundledOpenCliRoot({ environment = process.env, fallbackRoot } = {}) {
  const override = environment.INFOLENS_BUNDLED_OPENCLI_ROOT;
  if (override) {
    const root = path.resolve(override);
    return { root, source: "bundled-opencli-override", sourcePath: root };
  }
  try {
    const manifestPath = require.resolve("@infolens/bundled-opencli/package.json");
    return { root: path.dirname(manifestPath), source: "bundled-opencli-package", sourcePath: manifestPath };
  } catch (error) {
    const root = path.resolve(fallbackRoot ?? path.join(path.dirname(fileURLToPath(import.meta.url)), "../../..", "resources", "opencli"));
    return { root, source: "monorepo-development-fallback", sourcePath: root, resolutionError: error };
  }
}

export async function loadBundledOpenCli(distributionRoot, { source, sourcePath } = {}) {
  const resolvedDistributionRoot = path.resolve(distributionRoot);
  const metadataPath = path.join(resolvedDistributionRoot, "runtime.json");
  let metadata;
  try { metadata = JSON.parse(await readFile(metadataPath, "utf8")); }
  catch (error) { throw runtimeFailure("OPENCLI_RUNTIME_UNAVAILABLE", `Bundled OpenCLI metadata could not be read: ${error.message}`, { sourcePath: metadataPath }); }
  if (typeof metadata.version !== "string" || !semver.valid(metadata.version) || typeof metadata.executable !== "string" || !Array.isArray(metadata.commands)) {
    throw runtimeFailure("OPENCLI_RUNTIME_METADATA_INVALID", `Bundled OpenCLI metadata is invalid: ${metadataPath}`, { sourcePath: metadataPath });
  }
  const executablePath = path.resolve(resolvedDistributionRoot, metadata.executable);
  const relative = path.relative(resolvedDistributionRoot, executablePath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw runtimeFailure("OPENCLI_RUNTIME_METADATA_INVALID", "Bundled OpenCLI executable escapes its distribution", { sourcePath: metadataPath });
  await existingFile(executablePath, "OPENCLI_RUNTIME_UNAVAILABLE", "Bundled OpenCLI executable is missing");
  let packageName;
  let packageRoot;
  let declaredDependency;
  let distributionManifest;
  try {
    distributionManifest = JSON.parse(await readFile(path.join(resolvedDistributionRoot, "package.json"), "utf8"));
  } catch (error) {
    if (source !== "bundled-opencli-override" || error.code !== "ENOENT") {
      throw runtimeFailure("OPENCLI_WRAPPER_UNAVAILABLE", `Bundled OpenCLI package metadata could not be read: ${error.message}`, { sourcePath: path.join(resolvedDistributionRoot, "package.json") });
    }
  }
  if (distributionManifest) {
    declaredDependency = exactDependency(distributionManifest);
    if (!metadata.package || metadata.package.name !== declaredDependency.name || metadata.package.version !== declaredDependency.version || metadata.version !== declaredDependency.version) {
      throw runtimeFailure("OPENCLI_PACKAGE_IDENTITY_MISMATCH", "Bundled OpenCLI metadata does not match its exact dependency declaration", { sourcePath: path.join(resolvedDistributionRoot, "package.json") });
    }
    const manifestPath = path.resolve(resolvedDistributionRoot, metadata.package.manifest ?? "");
    const manifestRelative = path.relative(resolvedDistributionRoot, manifestPath);
    if (manifestRelative.startsWith("..") || path.isAbsolute(manifestRelative)) throw runtimeFailure("OPENCLI_PACKAGE_IDENTITY_MISMATCH", "Bundled OpenCLI package manifest escapes its distribution", { sourcePath: metadataPath });
    let packageManifest;
    try { packageManifest = JSON.parse(await readFile(manifestPath, "utf8")); }
    catch (error) { throw runtimeFailure("OPENCLI_PACKAGE_UNAVAILABLE", `Installed OpenCLI package metadata could not be read: ${error.message}`, { sourcePath: manifestPath }); }
    if (packageManifest.name !== declaredDependency.name || packageManifest.version !== declaredDependency.version) {
      throw runtimeFailure("OPENCLI_PACKAGE_IDENTITY_MISMATCH", "Installed OpenCLI package identity does not match its exact dependency", { sourcePath: manifestPath });
    }
    packageName = packageManifest.name;
    packageRoot = path.dirname(manifestPath);
    const executableRelativeToPackage = path.relative(packageRoot, executablePath);
    if (executableRelativeToPackage.startsWith("..") || path.isAbsolute(executableRelativeToPackage)) {
      throw runtimeFailure("OPENCLI_RUNTIME_METADATA_INVALID", "Bundled OpenCLI executable is outside the installed package", { sourcePath: metadataPath });
    }
    const inventory = await validateInventory(packageRoot, metadata.commands, metadataPath);
    return {
      version: metadata.version,
      packageName,
      packageRoot,
      executablePath,
      distributionRoot: resolvedDistributionRoot,
      metadataPath,
      inventoryPath: metadataPath,
      inventory: [...inventory].map((command) => command.split(" ")),
      availableCommands: inventory,
      source: source ?? "explicit-distribution-path",
      sourcePath: sourcePath ?? resolvedDistributionRoot,
      declaredDependency,
    };
  }
  const inventory = new Set();
  for (const command of metadata.commands) {
    if (!Array.isArray(command) || command.length < 1 || command.some((part) => typeof part !== "string" || !part.trim())) {
      throw runtimeFailure("OPENCLI_INVENTORY_MISMATCH", "Bundled OpenCLI command inventory contains an invalid command", { sourcePath: metadataPath });
    }
    const key = command.join(" ");
    if (inventory.has(key)) throw runtimeFailure("OPENCLI_INVENTORY_MISMATCH", `Bundled OpenCLI command inventory contains duplicate '${key}'`, { sourcePath: metadataPath });
    inventory.add(key);
  }
  return {
    version: metadata.version,
    packageName,
    packageRoot,
    executablePath,
    distributionRoot: resolvedDistributionRoot,
    metadataPath,
    inventoryPath: metadataPath,
    inventory: [...inventory].map((command) => command.split(" ")),
    availableCommands: inventory,
    source: source ?? "explicit-distribution-path",
    sourcePath: sourcePath ?? resolvedDistributionRoot,
  };
}

export async function resolveBundledOpenCli(options = {}) {
  const location = resolveBundledOpenCliRoot(options);
  return loadBundledOpenCli(location.root, location);
}

export function createOpenCliAdapter(runtime) {
  function spawnCaptured(processArgs, signal, extraEnvironment = {}) {
    const command = processCommand(runtime.executablePath);
    return new Promise((resolve, reject) => {
      const child = spawn(command.file, [...command.prefix, ...processArgs], {
        cwd: path.dirname(runtime.executablePath),
        env: {
          ...process.env,
          INFOLENS_OPENCLI_BUNDLED: "1",
          ...extraEnvironment,
          ...(command.electronNodeMode ? { ELECTRON_RUN_AS_NODE: "1" } : {}),
        },
        signal,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
      let stdout = "";
      let stderr = "";
      let capturedBytes = 0;
      let settled = false;
      let outputError;
      const fail = (error) => {
        if (settled) return;
        settled = true;
        reject(error);
      };
      const capture = (target, chunk) => {
        capturedBytes += Buffer.byteLength(chunk);
        if (capturedBytes > MAX_CAPTURED_OUTPUT_BYTES) {
          if (!outputError) {
            outputError = new Error("Bundled OpenCLI output exceeded the capture limit");
            outputError.code = "OPENCLI_OUTPUT_TOO_LARGE";
            child.kill();
          }
          return target;
        }
        return target + chunk;
      };
      child.stdout.on("data", (chunk) => { stdout = capture(stdout, chunk); });
      child.stderr.on("data", (chunk) => { stderr = capture(stderr, chunk); });
      child.once("error", (error) => { if (!outputError) fail(error); });
      child.once("close", (code) => {
        if (settled) return;
        settled = true;
        if (outputError) { reject(outputError); return; }
        if (code !== 0) { reject(classifyFailure(`${stderr}\n${stdout}`, code)); return; }
        resolve({ stdout, stderr });
      });
    });
  }

  async function spawnJson(processArgs, signal, extraEnvironment = {}) {
    const output = await spawnCaptured(processArgs, signal, extraEnvironment);
    try { return JSON.parse(output.stdout); }
    catch { throw new Error("Bundled OpenCLI did not return valid JSON"); }
  }

  function stripManagedBrowserOptions(args) {
    const managed = new Set(["--window", "--site-session", "--keep-tab"]);
    const result = [];
    for (let index = 0; index < args.length; index += 1) {
      const argument = args[index];
      const name = argument.split("=", 1)[0];
      if (!managed.has(name)) {
        result.push(argument);
        continue;
      }
      if (argument === name) index += 1;
    }
    return result;
  }

  const browserLeaseOptions = Object.freeze([
    "--window", "background",
    "--site-session", "ephemeral",
    "--keep-tab", "false",
  ]);

  return {
    inspect(pluginPaths) {
      return spawnJson([], undefined, {
        OPENCLI_DISABLE_USER_DISCOVERY: "1",
        OPENCLI_PLUGIN_PATHS: pluginPaths.join(path.delimiter),
        OPENCLI_REGISTRATION_REPORT: "1",
      });
    },
    async doctor(signal) {
      try {
        const output = await spawnCaptured(["doctor"], signal, {
          OPENCLI_DISABLE_USER_DISCOVERY: "1",
          OPENCLI_WINDOW: "background",
        });
        return parseBrowserDoctorOutput(output.stdout);
      } finally {
        const cleanupSignal = AbortSignal.timeout(3_000);
        await spawnCaptured(["browser", OPENCLI_DOCTOR_SESSION, "close"], cleanupSignal, {
          OPENCLI_DISABLE_USER_DISCOVERY: "1",
          OPENCLI_WINDOW: "background",
        }).catch(() => {});
      }
    },
    async restartDaemon(signal) {
      return spawnCaptured(["daemon", "restart"], signal, {
        OPENCLI_DISABLE_USER_DISCOVERY: "1",
      });
    },
    run(mapping, args = [], signal, pluginPaths = []) {
      if (!Array.isArray(args) || args.some((argument) => typeof argument !== "string")) {
        throw new TypeError("OpenCLI arguments must be an array of strings");
      }
      if (args.some((argument) => argument === "--format" || argument === "-f" || argument.startsWith("--format="))) {
        throw new Error("OpenCLI output format is fixed by the plugin contract");
      }
      const commandArgs = mapping.strategy === "PUBLIC"
        ? [...args]
        : [...stripManagedBrowserOptions(args), ...browserLeaseOptions];
      return spawnJson([...mapping.command, ...commandArgs, "-f", "json"], signal, {
        OPENCLI_DISABLE_USER_DISCOVERY: "1",
        ...(pluginPaths.length > 0 ? { OPENCLI_PLUGIN_PATHS: pluginPaths.join(path.delimiter) } : {}),
      });
    },
  };
}
