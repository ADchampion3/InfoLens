import assert from "node:assert/strict";
import { createServer as createHttpServer } from "node:http";
import { spawn } from "node:child_process";
import { createServer as createNetServer } from "node:net";
import path from "node:path";
import { test } from "node:test";
import { developmentLaunchConfig } from "../scripts/dev-config.mjs";

const root = path.resolve(import.meta.dirname, "..");

async function freePort() {
  const server = createNetServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  await new Promise((resolve) => server.close(resolve));
  return address.port;
}

async function waitForUrl(url) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`URL did not become ready: ${url}`);
}

test("development launch wires the same Runtime port to Vite and Electron", () => {
  const launch = developmentLaunchConfig({ rendererPort: 5173, runtimePort: 61234 });

  assert.equal(launch.runtimeOrigin, "http://127.0.0.1:61234");
  assert.deepEqual(launch.viteEnvironment, {
    INFOLENS_RUNTIME_ORIGIN: "http://127.0.0.1:61234",
    INFOLENS_APPLICATION_SESSION_ID: launch.electronEnvironment.INFOLENS_APPLICATION_SESSION_ID,
    VITE_INFOLENS_RUNTIME_TOKEN: launch.electronEnvironment.INFOLENS_APPLICATION_SESSION_ID,
  });
  assert.deepEqual(launch.electronEnvironment, {
    INFOLENS_RENDERER_URL: "http://127.0.0.1:5173",
    INFOLENS_RUNTIME_PORT: "61234",
    INFOLENS_APPLICATION_SESSION_ID: launch.viteEnvironment.INFOLENS_APPLICATION_SESSION_ID,
  });
});

test("development Vite serves Runtime info through its configured proxy", async () => {
  const runtimePort = await freePort();
  const rendererPort = await freePort();
  const launch = developmentLaunchConfig({ rendererPort, runtimePort });
  const runtime = createHttpServer((request, response) => {
    if (request.url !== "/api/v1/session/bootstrap") {
      response.writeHead(404);
      response.end();
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ type: "runtime-ready", origin: launch.runtimeOrigin }));
  });
  await new Promise((resolve, reject) => {
    runtime.once("error", reject);
    runtime.listen(runtimePort, "127.0.0.1", resolve);
  });

  const vite = spawn(process.execPath, [
    path.join(root, "node_modules", "vite", "bin", "vite.js"),
    "--config", path.join(root, "apps", "desktop", "vite.config.ts"),
    "--configLoader", "runner", "--host", "127.0.0.1", "--port", String(rendererPort), "--strictPort",
  ], {
    cwd: root,
    env: { ...process.env, ...launch.viteEnvironment },
    stdio: "ignore",
  });
  try {
    await waitForUrl(`http://127.0.0.1:${rendererPort}/`);
    const response = await fetch(`http://127.0.0.1:${rendererPort}/runtime-info.json`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { type: "runtime-ready", origin: launch.runtimeOrigin });
  } finally {
    vite.kill();
    await new Promise((resolve) => runtime.close(resolve));
  }
});
