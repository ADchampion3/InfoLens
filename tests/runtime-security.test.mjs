import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { test } from "node:test";
import { readJsonResponse } from "../apps/desktop/src/runtime-api.ts";

const root = path.resolve(import.meta.dirname, "..");
const openCliRoot = path.join(root, "tests", "fixtures", "runtime-opencli", "opencli");

async function startRuntime(temporaryRoot, token) {
  const pluginsRoot = path.join(temporaryRoot, "plugins");
  const dataRoot = path.join(temporaryRoot, "data");
  await mkdir(pluginsRoot, { recursive: true });
  await mkdir(dataRoot, { recursive: true });
  const child = spawn(process.execPath, [path.join(root, "packages", "plugin-runtime", "src", "server.mjs")], {
    cwd: root,
    env: {
      ...process.env,
      INFOLENS_PROJECT_ROOT: root,
      INFOLENS_PLUGINS_ROOT: pluginsRoot,
      INFOLENS_PLUGIN_DATA_ROOT: dataRoot,
      INFOLENS_BUNDLED_OPENCLI_ROOT: openCliRoot,
      INFOLENS_APPLICATION_SESSION_ID: token,
      INFOLENS_RENDERER_URL: "http://127.0.0.1:5173",
      INFOLENS_RUNTIME_PORT: "0",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const lines = readline.createInterface({ input: child.stdout });
  return new Promise((resolve, reject) => {
    const errors = [];
    const timeout = setTimeout(() => reject(new Error(`Runtime start timed out: ${errors.join("")}`)), 5_000);
    child.stderr.on("data", (chunk) => errors.push(String(chunk)));
    child.once("error", reject);
    child.once("exit", (code) => reject(new Error(`Runtime exited before ready with ${code}: ${errors.join("")}`)));
    lines.on("line", (line) => {
      let message;
      try { message = JSON.parse(line); } catch { return; }
      if (message.type !== "runtime-ready") return;
      clearTimeout(timeout);
      resolve({ child, lines, message });
    });
  });
}

async function stopRuntime(runtime) {
  if (!runtime?.child || runtime.child.exitCode !== null) return;
  const exited = new Promise((resolve) => runtime.child.once("exit", resolve));
  runtime.child.stdin.write("shutdown\n");
  runtime.child.stdin.end();
  await exited;
  runtime.lines.close();
}

test("Runtime protects stateful APIs with the application session token and scopes CORS", async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "infolens-runtime-security-"));
  const token = "runtime-security-test-token";
  let runtime;
  try {
    runtime = await startRuntime(temporaryRoot, token);
    const origin = runtime.message.origin;
    assert.equal(runtime.message.runtimeToken, token);

    const staticResponse = await fetch(`${origin}/runtime/plugin-sdk.js`);
    assert.equal(staticResponse.status, 200);

    const pluginResponse = await fetch(`${origin}/plugins/untrusted/api/summary`, { headers: { Origin: "http://127.0.0.1:5173" } });
    assert.equal(pluginResponse.headers.get("access-control-allow-origin"), null);

    const attackerOrigin = "http://attacker.test";
    const unauthorized = await fetch(`${origin}/runtime/info`, { headers: { Origin: attackerOrigin } });
    assert.equal(unauthorized.status, 401);
    assert.equal((await unauthorized.json()).code, "RUNTIME_UNAUTHORIZED");
    assert.equal(unauthorized.headers.get("access-control-allow-origin"), null);

    const preflight = await fetch(`${origin}/runtime/host-state`, {
      method: "OPTIONS",
      headers: { Origin: "http://127.0.0.1:5173", "Access-Control-Request-Headers": "authorization, content-type" },
    });
    assert.equal(preflight.status, 204);
    assert.match(preflight.headers.get("access-control-allow-headers") ?? "", /authorization/i);

    const unauthorizedMutation = await fetch(`${origin}/runtime/host-state`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ theme: "dark" }),
    });
    assert.equal(unauthorizedMutation.status, 401);

    const authorized = await fetch(`${origin}/runtime/info`, {
      headers: { Authorization: `Bearer ${token}`, Origin: "http://127.0.0.1:5173" },
    });
    assert.equal(authorized.status, 200);
    assert.equal((await authorized.json()).runtimeToken, token);
    assert.equal(authorized.headers.get("access-control-allow-origin"), "http://127.0.0.1:5173");

    const authorizedMutation = await fetch(`${origin}/runtime/host-state`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ theme: "dark" }),
    });
    assert.equal(authorizedMutation.status, 200);
  } finally {
    await stopRuntime(runtime);
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("renderer Runtime JSON reads reject responses above the memory limit", async () => {
  const response = new Response("x".repeat(8 * 1024 * 1024 + 1));
  await assert.rejects(readJsonResponse(response, "invalid"), /oversized response/);

  const valid = new Response(JSON.stringify({ ok: true }));
  assert.deepEqual(await readJsonResponse(valid, "invalid"), { ok: true });
});
