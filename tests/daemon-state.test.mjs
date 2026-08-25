import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  acquireDaemonLock,
  daemonPaths,
  defaultDaemonDataRoot,
  isLoopbackOrigin,
  loadDaemonCredentials,
  readDaemonDiscovery,
  readDaemonLock,
  rotateDaemonCredentials,
} from "../packages/plugin-runtime/src/daemon-state.mjs";

test("daemon state owns a temporary root, rotates credentials, and rejects duplicate locks", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "infolens-daemon-state-"));
  const paths = daemonPaths(root, {});
  try {
    const first = await acquireDaemonLock(paths, { sessionId: "state-test" });
    await assert.rejects(() => acquireDaemonLock(paths), { code: "DAEMON_ALREADY_RUNNING" });
    const credentials = await loadDaemonCredentials(paths);
    const rotated = await rotateDaemonCredentials(paths);
    assert.notEqual(rotated.bearerToken, credentials.bearerToken);
    assert.equal(JSON.parse(await readFile(paths.credentialPath, "utf8")).bearerToken, rotated.bearerToken);
    assert.equal(await readDaemonDiscovery(paths), undefined);
    assert.equal((await readDaemonLock(paths)).sessionId, "state-test");
    await first.release();
    assert.equal(await readDaemonLock(paths), undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("daemon defaults use the project-local root in development", () => {
  const projectRoot = path.join(os.tmpdir(), "infolens-development-project");
  assert.equal(
    defaultDaemonDataRoot({ INFOLENS_DAEMON_DEV_MODE: "1", INFOLENS_PROJECT_ROOT: projectRoot }),
    path.join(projectRoot, ".infolens-data", "daemon"),
  );
  assert.equal(
    defaultDaemonDataRoot({ INFOLENS_DAEMON_DATA_ROOT: path.join(projectRoot, "custom-daemon"), INFOLENS_DAEMON_DEV_MODE: "1", INFOLENS_PROJECT_ROOT: projectRoot }),
    path.join(projectRoot, "custom-daemon"),
  );
});

test("daemon discovery accepts only loopback HTTP origins", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "infolens-daemon-origin-"));
  const paths = daemonPaths(root, {});
  try {
    assert.equal(isLoopbackOrigin("http://127.0.0.1:61234"), true);
    assert.equal(isLoopbackOrigin("http://[::1]:61234"), true);
    for (const origin of [
      "https://127.0.0.1:61234",
      "http://192.0.2.10:61234",
      "http://127.0.0.1.example.test:61234",
      "http://127.0.0.1:61234/plugin",
    ]) {
      await writeFile(paths.discoveryPath, JSON.stringify({ version: 1, pid: process.pid, origin }));
      assert.equal(await readDaemonDiscovery(paths), undefined, origin);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
