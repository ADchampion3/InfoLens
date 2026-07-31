import { mkdir, readFile, rename, rm, stat, writeFile, appendFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { redactSensitiveText, redactSensitiveValue } from "./redaction.mjs";

const LEVELS = ["debug", "info", "warn", "error"];

export async function createPluginLogger(dataDir, options = {}) {
  const maxBytes = options.maxBytes ?? 256 * 1024;
  const maxFiles = options.maxFiles ?? 3;
  const logsDir = path.join(dataDir, "logs");
  const logPath = path.join(logsDir, options.fileName ?? "plugin.log");
  await mkdir(logsDir, { recursive: true });
  let writes = Promise.resolve();
  const clock = options.clock ?? (() => new Date());
  const createId = options.createId ?? randomUUID;
  const sessionId = options.sessionId ?? "legacy";
  const source = options.source ?? `plugin:${options.pluginId ?? path.basename(dataDir)}`;

  function sortValue(value) {
    if (Array.isArray(value)) return value.map(sortValue);
    if (!value || typeof value !== "object") return value;
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortValue(value[key])]));
  }

  async function rotate(nextBytes) {
    let size = 0;
    try { size = (await stat(logPath)).size; } catch {}
    if (size + nextBytes <= maxBytes) return;
    for (let index = maxFiles - 1; index >= 1; index -= 1) {
      const source = index === 1 ? logPath : `${logPath}.${index - 1}`;
      const destination = `${logPath}.${index}`;
      await rm(destination, { force: true });
      try { await rename(source, destination); } catch {}
    }
    await writeFile(logPath, "", "utf8");
  }

  function write(level, message, fields = {}) {
    const safeFields = sortValue(redactSensitiveValue(fields));
    const { code, operationId, ...messageFields } = safeFields;
    const suffix = Object.keys(messageFields).length ? ` ${JSON.stringify(messageFields)}` : "";
    const value = {
      id: createId(), timestamp: clock().toISOString(), level, source,
      message: redactSensitiveText(`${message}${suffix}`), sessionId,
      ...(code ? { code: String(code) } : {}),
      ...(operationId ? { operationId: String(operationId) } : {}),
    };
    const entry = `${JSON.stringify(value)}\n`;
    const operation = writes.then(async () => {
      await rotate(Buffer.byteLength(entry));
      await appendFile(logPath, entry, "utf8");
      return value;
    });
    writes = operation.then(() => undefined);
    return operation;
  }

  const logger = Object.fromEntries(LEVELS.map((level) => [level, (message, fields) => write(level, message, fields)]));
  logger.flush = () => writes;
  logger.readRecent = async () => {
    await writes;
    try { return await readFile(logPath, "utf8"); } catch { return ""; }
  };
  logger.path = logPath;
  return logger;
}
