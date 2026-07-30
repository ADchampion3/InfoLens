#!/usr/bin/env node
import { cp, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { preparePluginAdapterScope } from "../../plugin-runtime/src/adapter-scope.mjs";
import { validatePluginPackage } from "../../plugin-runtime/src/contract.mjs";
import { createOpenCliAdapter, loadBundledOpenCli } from "../../plugin-runtime/src/opencli-adapter.mjs";

const sdkRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const command = process.argv[2];
const packagePathArgument = command === "adapters" ? process.argv[4] : process.argv[3];
const packageRoot = path.resolve(packagePathArgument && !packagePathArgument.startsWith("--") ? packagePathArgument : process.cwd());
const openCliRoot = path.resolve(process.env.INFOLENS_BUNDLED_OPENCLI_ROOT ?? path.join(sdkRoot, "resources", "opencli"));

function option(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function runtimeContext() {
  const runtime = await loadBundledOpenCli(openCliRoot);
  const adapter = createOpenCliAdapter(runtime);
  return { runtime, adapter };
}

async function validateAt(registryRoot, development = false) {
  const { runtime, adapter } = await runtimeContext();
  return validatePluginPackage(packageRoot, {
    hostVersion: "0.1.0",
    openCliVersion: runtime.version,
    availableCommands: runtime.availableCommands,
  }, {
    prepareAdapterScope: ({ packageRoot: root, manifest }) => preparePluginAdapterScope({
      packageRoot: root,
      manifest,
      runtime,
      registryRoot,
      inspect: (paths) => adapter.inspect(paths),
      development,
    }),
  });
}

async function validate() {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "infolens-plugin-validate-"));
  try {
    const result = await validateAt(temporary);
    process.stdout.write(`${JSON.stringify({ ok: true, plugin: result.manifest.id, adapters: result.adapterScope.adapters.length }, null, 2)}\n`);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

async function dev() {
  const registryRoot = path.join(packageRoot, ".infolens-dev", "opencli-adapters");
  const result = await validateAt(registryRoot, true);
  process.stdout.write(`${JSON.stringify({ ok: true, plugin: result.manifest.id, scope: path.join(registryRoot, "scopes", result.manifest.id, "scope.lock.json") }, null, 2)}\n`);
}

async function pack() {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "infolens-plugin-pack-"));
  try {
    const result = await validateAt(temporary);
    const output = path.resolve(option("--out") ?? path.join(path.dirname(packageRoot), `${path.basename(packageRoot)}.infolens-plugin`));
    try { await stat(output); throw new Error(`output already exists: ${output}`); } catch (error) { if (error.code !== "ENOENT") throw error; }
    await cp(packageRoot, output, {
      recursive: true,
      filter(source) {
        const relative = path.relative(packageRoot, source);
        return !relative.split(path.sep).some((part) => ["node_modules", ".git", ".infolens-dev"].includes(part));
      },
    });
    const integrity = {
      pluginId: result.manifest.id,
      version: result.manifest.version,
      adapters: result.adapterScope.adapters.map(({ id, version, sha256 }) => ({ id, version, sha256 })),
    };
    await writeFile(path.join(output, "adapter-integrity.json"), `${JSON.stringify(integrity, null, 2)}\n`, "utf8");
    process.stdout.write(`${JSON.stringify({ ok: true, output, ...integrity }, null, 2)}\n`);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

async function listAdapters() {
  const manifest = JSON.parse(await readFile(path.join(packageRoot, "manifest.json"), "utf8"));
  const runtimeMetadata = JSON.parse(await readFile(path.join(openCliRoot, "runtime.json"), "utf8"));
  const rows = [
    ...runtimeMetadata.commands.map((parts) => ({ command: parts.join(" "), source: "builtin", version: runtimeMetadata.version })),
    ...Object.values(manifest.openCliAdapters ?? {}).map((adapter) => ({ adapter: adapter.id, source: "provided", version: adapter.version, path: adapter.path })),
  ];
  process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
}

try {
  if (command === "validate") await validate();
  else if (command === "dev") await dev();
  else if (command === "pack") await pack();
  else if (command === "adapters" && process.argv[3] === "list") await listAdapters();
  else throw new Error("usage: infolens-plugin <validate|dev|pack|adapters list> [plugin-path] [--out path]");
} catch (error) {
  process.stderr.write(`${JSON.stringify({ ok: false, code: error.code ?? "PLUGIN_TOOL_FAILED", error: error.message }, null, 2)}\n`);
  process.exitCode = 1;
}
