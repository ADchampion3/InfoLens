import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createBackup, restoreBackup } from "../packages/plugin-runtime/src/backup.mjs";
import { daemonPaths } from "../packages/plugin-runtime/src/daemon-state.mjs";

test("daemon backup restores owned state without credentials or operational logs", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "infolens-daemon-backup-"));
  const paths = daemonPaths(root, {});
  try {
    await mkdir(path.join(paths.pluginDataRoot, "hn", "logs"), { recursive: true });
    await writeFile(paths.hostStatePath, JSON.stringify({ lastSelection: "hn" }));
    await writeFile(paths.batchStatePath, JSON.stringify({ batches: [] }));
    await writeFile(path.join(paths.pluginDataRoot, "hn", "state.json"), "owned-state");
    await writeFile(path.join(paths.pluginDataRoot, "hn", "logs", "plugin.log"), "should-not-be-backed-up");
    await writeFile(paths.credentialPath, JSON.stringify({ bearerToken: "credential-value" }));

    const destination = path.join(root, "backup.json");
    const created = await createBackup({ paths, outputPath: destination, metadata: { pluginIds: ["hn"] } });
    assert.equal(created.fileCount, 3);
    const backup = await readFile(destination, "utf8");
    assert.doesNotMatch(backup, /credential-value/u);
    assert.doesNotMatch(backup, /should-not-be-backed-up/u);

    await writeFile(paths.hostStatePath, JSON.stringify({ lastSelection: "juejin" }));
    await writeFile(path.join(paths.pluginDataRoot, "hn", "state.json"), "changed");
    const restored = await restoreBackup({ paths, sourcePath: destination });
    assert.equal(restored.ok, true);
    assert.deepEqual(JSON.parse(await readFile(paths.hostStatePath, "utf8")), { lastSelection: "hn" });
    assert.equal(await readFile(path.join(paths.pluginDataRoot, "hn", "state.json"), "utf8"), "owned-state");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("daemon backup rejects non-canonical encoded files", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "infolens-daemon-backup-invalid-"));
  const paths = daemonPaths(root, {});
  try {
    const source = path.join(root, "invalid.json");
    await writeFile(source, JSON.stringify({ format: "infolens-daemon-backup", version: 1, files: [{ path: "host-state.json", encoding: "base64", data: "a" }] }));
    await assert.rejects(() => restoreBackup({ paths, sourcePath: source }), /not valid base64/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("daemon backup rejects semantically invalid host state", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "infolens-daemon-backup-state-"));
  const paths = daemonPaths(root, {});
  try {
    const invalidHostState = Buffer.from(JSON.stringify({ theme: "neon" }), "utf8").toString("base64");
    const source = path.join(root, "invalid-state.json");
    await writeFile(source, JSON.stringify({ format: "infolens-daemon-backup", version: 1, files: [{ path: "host-state.json", encoding: "base64", data: invalidHostState }] }));
    await assert.rejects(() => restoreBackup({ paths, sourcePath: source }), (error) => error?.code === "BACKUP_STATE_INVALID");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("daemon backup rejects task records with a mismatched plugin identity", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "infolens-daemon-backup-task-state-"));
  const paths = daemonPaths(root, {});
  try {
    const invalidTaskState = Buffer.from(JSON.stringify({ version: 1, pluginId: "other", records: [] }), "utf8").toString("base64");
    const source = path.join(root, "invalid-task-state.json");
    await writeFile(source, JSON.stringify({ format: "infolens-daemon-backup", version: 1, files: [{ path: "task-records/hn.json", encoding: "base64", data: invalidTaskState }] }));
    await assert.rejects(() => restoreBackup({ paths, sourcePath: source }), (error) => error?.code === "BACKUP_STATE_INVALID");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
