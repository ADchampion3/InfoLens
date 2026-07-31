import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createLogService, serializeLogEntries } from "../packages/log-service/src/index.mjs";
import { createPluginLogger } from "../packages/plugin-runtime/src/logger.mjs";

test("Host log evidence survives Application Sessions without exposing sensitive values", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "infolens-host-logs-"));
  try {
    const firstSession = createLogService({
      root,
      sessionId: "session-one",
      clock: () => new Date("2026-07-31T08:30:00.000Z"),
      createId: () => "host-entry-1",
    });
    const written = await firstSession.write({
      level: "info",
      message: "Host Shell started token=top-secret https://example.test/?access_token=url-secret",
    });

    assert.deepEqual(written, {
      id: "host-entry-1",
      timestamp: "2026-07-31T08:30:00.000Z",
      level: "info",
      source: "host",
      message: "Host Shell started token=[REDACTED] https://example.test/?access_token=[REDACTED]",
      sessionId: "session-one",
    });

    const persisted = await readFile(path.join(root, "host.log"), "utf8");
    assert.doesNotMatch(persisted, /top-secret|url-secret/);

    const nextSession = createLogService({ root, sessionId: "session-two" });
    const page = await nextSession.query();
    assert.deepEqual(page, { entries: [written], nextCursor: null });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Host log rotation retains three encoded-byte-bounded files", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "infolens-host-rotation-"));
  let sequence = 0;
  try {
    const service = createLogService({
      root,
      sessionId: "rotation-session",
      maxBytes: 320,
      maxFiles: 3,
      clock: () => new Date(`2026-07-31T08:30:0${sequence}.000Z`),
      createId: () => `entry-${++sequence}`,
    });
    for (let index = 0; index < 7; index += 1) {
      await service.write({ level: "info", message: `Host lifecycle ${index} ${"x".repeat(100)}` });
    }

    const files = (await readdir(root)).filter((name) => name.startsWith("host.log"));
    assert.deepEqual(files.sort(), ["host.log", "host.log.1", "host.log.2"]);
    for (const name of files) assert((await stat(path.join(root, name))).size <= 320, `${name} exceeded the byte limit`);

    const retained = await service.query();
    assert.deepEqual(retained.entries.map(({ id }) => id), ["entry-7", "entry-6", "entry-5"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("global query adapts and merges Runtime and plugin JSONL without changing the plugin logger API", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "infolens-merged-logs-"));
  try {
    const host = createLogService({
      root: path.join(root, "host"), sessionId: "host-session",
      clock: () => new Date("2026-07-31T08:30:00.000Z"), createId: () => "host-1",
    });
    await host.write({ level: "info", message: "Host evidence" });

    const pluginData = path.join(root, "plugins", "fixture");
    const pluginLogger = await createPluginLogger(pluginData, {
      pluginId: "fixture", sessionId: "runtime-session",
      clock: () => new Date("2026-07-31T08:31:00.000Z"), createId: () => "plugin-1",
    });
    await pluginLogger.error("collection-failed", { zeta: 2, authorization: "Bearer private", alpha: 1 });

    const runtimeLogs = path.join(root, "plugins", "_runtime", "logs");
    await mkdir(runtimeLogs, { recursive: true });
    await writeFile(path.join(runtimeLogs, "runtime.log"), [
      JSON.stringify({ timestamp: "2026-07-31T08:32:00.000Z", level: "warn", message: "package-rejected token=legacy-secret", package: "future-reader", code: "INCOMPATIBLE_CONTRACT" }),
      "{partially-written",
      "",
    ].join("\n"), "utf8");

    const sources = [
      { source: "runtime", filePath: path.join(runtimeLogs, "runtime.log") },
      { source: "plugin:fixture", filePath: pluginLogger.path },
    ];
    const first = await host.query({ sources });
    const second = await host.query({ sources });

    assert.deepEqual(first.entries.map(({ source }) => source), ["runtime", "plugin:fixture", "host"]);
    assert.equal(first.entries[0].message, "package-rejected token=[REDACTED] {\"package\":\"future-reader\"}");
    assert.equal(first.entries[0].code, "INCOMPATIBLE_CONTRACT");
    assert.equal(first.entries[0].sessionId, "legacy");
    assert.equal(first.entries[1].message, "collection-failed {\"alpha\":1,\"authorization\":\"[REDACTED]\",\"zeta\":2}");
    assert.deepEqual(first.entries.map(({ id }) => id), second.entries.map(({ id }) => id), "adapted identifiers must be stable");
    assert.doesNotMatch(JSON.stringify(first), /private|legacy-secret/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("filtered log pages use a stable opaque cursor and deterministic boundary ordering", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "infolens-log-pages-"));
  const ids = ["entry-a", "entry-c", "entry-b", "entry-d"];
  let index = 0;
  try {
    const service = createLogService({
      root, sessionId: "page-session",
      clock: () => new Date(index < 3 ? "2026-07-31T09:00:00.000Z" : "2026-07-31T08:59:00.000Z"),
      createId: () => ids[index++],
    });
    await service.write({ level: "error", message: "collection failed alpha", operationId: "refresh-1" });
    await service.write({ level: "error", message: "collection failed beta", operationId: "refresh-1" });
    await service.write({ level: "warn", message: "collection delayed", operationId: "refresh-1" });
    await service.write({ level: "error", message: "unrelated", operationId: "refresh-2" });

    const filters = {
      sources: ["host"], levels: ["error"], keyword: "collection failed", operationId: "refresh-1",
      from: "2026-07-31T08:00:00.000Z", to: "2026-07-31T10:00:00.000Z",
    };
    const first = await service.query({ filters, limit: 1 });
    assert.deepEqual(first.entries.map(({ id }) => id), ["entry-c"]);
    assert.equal(typeof first.nextCursor, "string");
    assert(!first.nextCursor.includes("entry-c"), "cursor leaked its boundary representation");

    const second = await service.query({ filters, limit: 1, cursor: first.nextCursor });
    assert.deepEqual(second.entries.map(({ id }) => id), ["entry-a"]);
    assert.equal(second.nextCursor, null);
    await assert.rejects(
      service.query({ filters: { ...filters, keyword: "different" }, cursor: first.nextCursor }),
      (error) => error.code === "INVALID_LOG_CURSOR",
    );
    await assert.rejects(service.query({ filters, cursor: "not-a-cursor" }), (error) => error.code === "INVALID_LOG_CURSOR");

    const capped = await service.query({ limit: 500 });
    assert(capped.entries.length <= 200);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("shared JSONL serialization redacts again and emits only the minimal envelope", () => {
  const jsonl = serializeLogEntries([{
    id: "entry-1", timestamp: "2026-07-31T09:00:00.000Z", level: "error", source: "plugin:fixture",
    message: "Authorization: Bearer final-secret https://example.test/?api_key=url-secret",
    code: "PLUGIN_ERROR", sessionId: "application-session", operationId: "operation-1",
    arbitrary: "must-not-export",
  }]);
  assert.equal(jsonl, `${JSON.stringify({
    id: "entry-1", timestamp: "2026-07-31T09:00:00.000Z", level: "error", source: "plugin:fixture",
    message: "Authorization=[REDACTED]", code: "PLUGIN_ERROR", sessionId: "application-session", operationId: "operation-1",
  })}\n`);
  assert.doesNotMatch(jsonl, /final-secret|url-secret|must-not-export/);
});

test("security boundaries redact structured, textual, URL, Browser, and profile evidence", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "infolens-log-security-"));
  try {
    const pluginData = path.join(root, "plugins", "secure");
    const logger = await createPluginLogger(pluginData, { pluginId: "secure", sessionId: "runtime-session" });
    await logger.error(
      "Authorization: Bearer header-secret, cookie=session-secret; https://example.test/?api_key=url-secret C:\\Users\\alice\\Chrome /home/bob/profile",
      { nested: { token: "nested-secret" }, browserContextId: "context-secret", webSocketDebuggerUrl: "ws-secret", useful: "retained" },
    );
    const persisted = await readFile(logger.path, "utf8");
    assert.doesNotMatch(persisted, /header-secret|session-secret|url-secret|nested-secret|context-secret|ws-secret|alice|bob/);
    assert.match(persisted, /retained/);

    const legacyRoot = path.join(root, "legacy");
    await mkdir(legacyRoot, { recursive: true });
    const legacyPath = path.join(legacyRoot, "runtime.log");
    await writeFile(legacyPath, `${JSON.stringify({ timestamp: "2026-07-31T09:00:00.000Z", level: "error", message: "token=legacy-secret /Users/carol/Chrome", cookie: "legacy-cookie" })}\n`);
    const service = createLogService({ root: path.join(root, "host"), sessionId: "host-session" });
    const page = await service.query({ sources: [{ source: "runtime", filePath: legacyPath }] });
    const shared = serializeLogEntries(page.entries);
    assert.doesNotMatch(shared, /legacy-secret|legacy-cookie|carol/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
