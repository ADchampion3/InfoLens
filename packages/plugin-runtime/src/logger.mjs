import { mkdir, readFile, rename, rm, stat, writeFile, appendFile } from "node:fs/promises";
import path from "node:path";

const LEVELS = ["debug", "info", "warn", "error"];

export async function createPluginLogger(dataDir, options = {}) {
  const maxBytes = options.maxBytes ?? 256 * 1024;
  const maxFiles = options.maxFiles ?? 3;
  const logsDir = path.join(dataDir, "logs");
  const logPath = path.join(logsDir, "plugin.log");
  await mkdir(logsDir, { recursive: true });
  let writes = Promise.resolve();

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
    const entry = `${JSON.stringify({ ...fields, timestamp: new Date().toISOString(), level, message })}\n`;
    writes = writes.then(async () => {
      await rotate(Buffer.byteLength(entry));
      await appendFile(logPath, entry, "utf8");
    });
    return writes;
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
