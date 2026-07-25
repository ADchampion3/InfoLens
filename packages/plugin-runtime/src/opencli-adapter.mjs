import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";

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
  return {
    version: metadata.version,
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
      if (args.some((argument) => argument === "--output" || argument.startsWith("--output="))) {
        throw new Error("OpenCLI output format is fixed by the plugin contract");
      }
      const command = processCommand(runtime.executablePath);
      const processArgs = [...command.prefix, ...mapping.command, ...args, "--output=json"];
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
            reject(new Error(`Bundled OpenCLI exited with code ${code}: ${stderr.trim() || "no error output"}`));
            return;
          }
          try { resolve(JSON.parse(stdout)); }
          catch { reject(new Error("Bundled OpenCLI did not return valid JSON")); }
        });
      });
    },
  };
}
