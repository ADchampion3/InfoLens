import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { preparePluginAdapterScope, removePluginAdapterScope } from "../packages/plugin-runtime/src/adapter-scope.mjs";

const runtime = {
  version: "1.8.6",
  availableCommands: new Set(["builtin read"]),
};

async function createPackage(root, { source = "export const ready = true;", command = ["vendor", "latest"] } = {}) {
  const adapterRoot = path.join(root, "opencli-adapters", "source");
  await mkdir(adapterRoot, { recursive: true });
  await writeFile(path.join(adapterRoot, "opencli-plugin.json"), JSON.stringify({
    name: "com.vendor.source",
    version: "1.2.0",
    opencli: ">=1.8.6 <2.0.0",
  }), "utf8");
  await writeFile(path.join(adapterRoot, "package.json"), JSON.stringify({ type: "module" }), "utf8");
  await writeFile(path.join(adapterRoot, "latest.js"), source, "utf8");
  return {
    id: "test-plugin",
    contractVersion: "2",
    openCliAdapters: {
      source: { id: "com.vendor.source", version: "1.2.0", path: "opencli-adapters/source" },
    },
    openCliCommands: {
      latest: { adapter: "source", site: command[0], command, strategy: "PUBLIC", access: "read", outputFormat: "json" },
    },
  };
}

function report(command = "vendor/latest") {
  return { commands: [{ command, strategy: "public", access: "read" }], hooks: [], collisions: [] };
}

test("provided adapters are content-addressed, deduplicated, and locked per plugin", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "infolens-scope-"));
  const packageRoot = path.join(root, "plugin");
  const registryRoot = path.join(root, "registry");
  try {
    const manifest = await createPackage(packageRoot);
    const first = await preparePluginAdapterScope({ packageRoot, manifest, runtime, registryRoot, inspect: async () => report() });
    const second = await preparePluginAdapterScope({ packageRoot, manifest, runtime, registryRoot, inspect: async () => report() });
    assert.equal(first.adapters[0].sha256, second.adapters[0].sha256);
    assert.equal(first.adapters[0].path, second.adapters[0].path);
    assert.deepEqual(first.commands.map(({ command }) => command), ["vendor latest"]);
    const persisted = JSON.parse(await readFile(path.join(registryRoot, "scopes", "test-plugin", "scope.lock.json"), "utf8"));
    assert.equal(persisted.openCliVersion, "1.8.6");
    assert.equal(persisted.adapters[0].id, "com.vendor.source");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the same adapter id and version cannot be replaced with different content", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "infolens-scope-conflict-"));
  const packageRoot = path.join(root, "plugin");
  const registryRoot = path.join(root, "registry");
  try {
    const manifest = await createPackage(packageRoot);
    await preparePluginAdapterScope({ packageRoot, manifest, runtime, registryRoot, inspect: async () => report() });
    await writeFile(path.join(packageRoot, "opencli-adapters", "source", "latest.js"), "export const changed = true;", "utf8");
    await assert.rejects(
      preparePluginAdapterScope({ packageRoot, manifest, runtime, registryRoot, inspect: async () => report() }),
      (error) => error.code === "ADAPTER_VERSION_CONFLICT",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("registration hooks and bundled command collisions are rejected", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "infolens-scope-invalid-"));
  const packageRoot = path.join(root, "plugin");
  const registryRoot = path.join(root, "registry");
  try {
    const hookManifest = await createPackage(packageRoot, { source: "onStartup(() => {});" });
    await assert.rejects(
      preparePluginAdapterScope({ packageRoot, manifest: hookManifest, runtime, registryRoot, inspect: async () => report() }),
      (error) => error.code === "UNSUPPORTED_OPENCLI_HOOK",
    );
    await rm(packageRoot, { recursive: true, force: true });
    const collisionManifest = await createPackage(packageRoot, { command: ["builtin", "read"] });
    await assert.rejects(
      preparePluginAdapterScope({ packageRoot, manifest: collisionManifest, runtime, registryRoot, inspect: async () => report("builtin/read") }),
      (error) => error.code === "OPENCLI_COMMAND_COLLISION",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a command mapping must name the adapter that actually registered it", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "infolens-scope-owner-"));
  const packageRoot = path.join(root, "plugin");
  const registryRoot = path.join(root, "registry");
  try {
    const manifest = await createPackage(packageRoot);
    manifest.openCliAdapters.other = { id: "com.vendor.other", version: "1.0.0", path: "opencli-adapters/other" };
    const otherRoot = path.join(packageRoot, "opencli-adapters", "other");
    await mkdir(otherRoot, { recursive: true });
    await writeFile(path.join(otherRoot, "opencli-plugin.json"), JSON.stringify({ name: "com.vendor.other", version: "1.0.0", opencli: ">=1.8.6 <2.0.0" }));
    await writeFile(path.join(otherRoot, "latest.js"), "export const ready = true;");
    manifest.openCliCommands.latest.adapter = "other";
    await assert.rejects(
      preparePluginAdapterScope({
        packageRoot,
        manifest,
        runtime,
        registryRoot,
        inspect: async ([adapterPath]) => adapterPath.includes("com.vendor.other") ? { commands: [], hooks: [], collisions: [] } : report(),
      }),
      (error) => error.code === "ADAPTER_COMMAND_MISMATCH",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("removing a scope garbage-collects only unreferenced adapter versions", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "infolens-scope-gc-"));
  const packageRoot = path.join(root, "plugin");
  const registryRoot = path.join(root, "registry");
  try {
    const manifest = await createPackage(packageRoot);
    const lock = await preparePluginAdapterScope({ packageRoot, manifest, runtime, registryRoot, inspect: async () => report() });
    await removePluginAdapterScope(registryRoot, manifest.id);
    await assert.rejects(readFile(path.join(lock.adapters[0].path, ".infolens-adapter.json")), (error) => error.code === "ENOENT");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("packaged adapter integrity is checked before registration", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "infolens-scope-integrity-"));
  const packageRoot = path.join(root, "plugin");
  const registryRoot = path.join(root, "registry");
  try {
    const manifest = await createPackage(packageRoot);
    manifest.version = "1.0.0";
    await writeFile(path.join(packageRoot, "adapter-integrity.json"), JSON.stringify({
      pluginId: manifest.id,
      version: manifest.version,
      adapters: [{ id: "com.vendor.source", version: "1.2.0", sha256: "incorrect" }],
    }));
    await assert.rejects(
      preparePluginAdapterScope({ packageRoot, manifest, runtime, registryRoot, inspect: async () => report() }),
      (error) => error.code === "ADAPTER_INTEGRITY_MISMATCH",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("provided adapters cannot register commands omitted from the plugin manifest", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "infolens-scope-undeclared-"));
  const packageRoot = path.join(root, "plugin");
  const registryRoot = path.join(root, "registry");
  try {
    const manifest = await createPackage(packageRoot);
    await assert.rejects(
      preparePluginAdapterScope({
        packageRoot,
        manifest,
        runtime,
        registryRoot,
        inspect: async () => ({
          commands: [
            { command: "vendor/latest", strategy: "public", access: "read" },
            { command: "vendor/hidden", strategy: "public", access: "read" },
          ],
          hooks: [],
          collisions: [],
        }),
      }),
      (error) => error.code === "UNDECLARED_ADAPTER_COMMAND",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("published adapter content is verified before an installed version is reused", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "infolens-scope-store-integrity-"));
  const packageRoot = path.join(root, "plugin");
  const registryRoot = path.join(root, "registry");
  try {
    const manifest = await createPackage(packageRoot);
    const lock = await preparePluginAdapterScope({ packageRoot, manifest, runtime, registryRoot, inspect: async () => report() });
    await writeFile(path.join(lock.adapters[0].path, "latest.js"), "export const tampered = true;", "utf8");
    await assert.rejects(
      preparePluginAdapterScope({ packageRoot, manifest, runtime, registryRoot, inspect: async () => report() }),
      (error) => error.code === "ADAPTER_STORE_CORRUPTED",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
