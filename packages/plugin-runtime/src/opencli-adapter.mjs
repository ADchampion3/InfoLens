import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { redactSensitiveText } from "./redaction.mjs";

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

function processCommand(executablePath) {
  return executablePath.endsWith(".js") || executablePath.endsWith(".mjs")
    ? { file: process.execPath, prefix: [executablePath] }
    : { file: executablePath, prefix: [] };
}

export async function loadBundledOpenCli(distributionRoot) {
  const metadataPath = path.join(distributionRoot, "runtime.json");
  const metadata = JSON.parse(await readFile(metadataPath, "utf8"));
  if (typeof metadata.version !== "string" || typeof metadata.executable !== "string" || !Array.isArray(metadata.commands)) {
    throw new Error(`Bundled OpenCLI metadata is invalid: ${metadataPath}`);
  }
  const executablePath = path.resolve(distributionRoot, metadata.executable);
  const relative = path.relative(distributionRoot, executablePath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Bundled OpenCLI executable escapes its distribution");
  await readFile(executablePath);
  let packageName;
  if (metadata.package) {
    const manifestPath = path.resolve(distributionRoot, metadata.package.manifest ?? "");
    const manifestRelative = path.relative(distributionRoot, manifestPath);
    if (manifestRelative.startsWith("..") || path.isAbsolute(manifestRelative)) throw new Error("Bundled OpenCLI package manifest escapes its distribution");
    const packageManifest = JSON.parse(await readFile(manifestPath, "utf8"));
    if (packageManifest.name !== metadata.package.name || packageManifest.version !== metadata.package.version || packageManifest.version !== metadata.version) {
      throw new Error("Bundled OpenCLI package identity does not match pinned runtime metadata");
    }
    packageName = packageManifest.name;
  }
  return {
    version: metadata.version,
    packageName,
    executablePath,
    availableCommands: new Set(metadata.commands.map((command) => command.join(" "))),
  };
}

export function createOpenCliAdapter(runtime) {
  return {
    run(mapping, args = [], signal) {
      if (!Array.isArray(args) || args.some((argument) => typeof argument !== "string")) {
        throw new TypeError("OpenCLI arguments must be an array of strings");
      }
      if (args.some((argument) => argument === "--format" || argument === "-f" || argument.startsWith("--format="))) {
        throw new Error("OpenCLI output format is fixed by the plugin contract");
      }
      const command = processCommand(runtime.executablePath);
      const processArgs = [...command.prefix, ...mapping.command, ...args, "-f", "json"];
      return new Promise((resolve, reject) => {
        const child = spawn(command.file, processArgs, {
          cwd: path.dirname(runtime.executablePath),
          env: { ...process.env, INFOLENS_OPENCLI_BUNDLED: "1" },
          signal,
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true,
        });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (chunk) => { stdout += chunk; });
        child.stderr.on("data", (chunk) => { stderr += chunk; });
        child.once("error", reject);
        child.once("close", (code) => {
          if (code !== 0) {
            reject(classifyFailure(stderr, code));
            return;
          }
          try { resolve(JSON.parse(stdout)); }
          catch { reject(new Error("Bundled OpenCLI did not return valid JSON")); }
        });
      });
    },
  };
}
