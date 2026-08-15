import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { deflateRawSync, inflateRawSync } from "node:zlib";
import path from "node:path";

export const ARCHIVE_LIMITS = Object.freeze({
  maxArchiveBytes: 128 * 1024 * 1024,
  maxEntries: 10_000,
  maxEntryBytes: 64 * 1024 * 1024,
  maxTotalBytes: 128 * 1024 * 1024,
});

export class ArchiveError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ArchiveError";
    this.code = code;
  }
}

function fail(condition, code, message) {
  if (condition) throw new ArchiveError(code, message);
}

function compareNames(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function normalizeArchivePath(value, { directory = false } = {}) {
  fail(typeof value !== "string" || !value, "ARCHIVE_PATH_INVALID", "Archive entry path must be non-empty");
  fail(value.includes("\0") || value.includes("\\"), "ARCHIVE_PATH_INVALID", `Archive entry path '${value}' is not a portable POSIX path`);
  fail(value.startsWith("/") || /^[A-Za-z]:/u.test(value), "ARCHIVE_PATH_ABSOLUTE", `Archive entry path '${value}' is absolute`);
  const pathValue = directory && value.endsWith("/") ? value.slice(0, -1) : value;
  const parts = pathValue.split("/");
  fail(parts.some((part) => !part || part === "." || part === ".."), "ARCHIVE_PATH_TRAVERSAL", `Archive entry path '${value}' is unsafe`);
  return `${parts.join("/")}${directory ? "/" : ""}`;
}

function packageRelativePath(root, filename) {
  const relative = path.relative(root, filename);
  fail(!relative || relative.startsWith("..") || path.isAbsolute(relative), "PACKAGE_PATH_INVALID", "Package entry escapes the package root");
  return normalizeArchivePath(relative.split(path.sep).join("/"));
}

export function packageArchiveFilter(_source, relative, entry) {
  const parts = relative.split(path.sep).filter(Boolean);
  if (parts.some((part) => ["node_modules", ".git", ".infolens-dev", ".infolens-market"].includes(part))) return false;
  return true;
}

export async function collectFiles(root, filter = packageArchiveFilter) {
  const files = [];
  async function visit(current) {
    const entries = await readdir(current, { withFileTypes: true });
    entries.sort((left, right) => compareNames(left.name, right.name));
    for (const entry of entries) {
      const source = path.join(current, entry.name);
      const relative = path.relative(root, source);
      if (!filter(source, relative, entry)) continue;
      if (entry.isSymbolicLink()) throw new ArchiveError("ARCHIVE_SYMLINK", `Package contains symbolic link '${relative}'`);
      if (entry.isDirectory()) {
        await visit(source);
        continue;
      }
      if (!entry.isFile()) throw new ArchiveError("ARCHIVE_ENTRY_TYPE", `Package entry '${relative}' is not a regular file`);
      files.push({ path: packageRelativePath(root, source), data: await readFile(source) });
    }
  }
  await visit(root);
  return files;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < table.length; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) value = (value & 1) ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(data) {
  let value = 0xffffffff;
  for (const byte of data) value = CRC_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

function decompressedSizeError(name, limits, previousTotalBytes) {
  const remainingTotalBytes = Math.max(0, limits.maxTotalBytes - previousTotalBytes);
  if (limits.maxEntryBytes <= remainingTotalBytes) {
    return new ArchiveError("ARCHIVE_ENTRY_TOO_LARGE", `Archive entry '${name}' exceeds the per-file size limit`);
  }
  return new ArchiveError("ARCHIVE_TOO_LARGE", "Plugin archive expands beyond the total size limit");
}

function inflateEntry(name, compressed, method, outputLimit, limits, previousTotalBytes) {
  if (method === 0) {
    if (compressed.length > outputLimit) throw decompressedSizeError(name, limits, previousTotalBytes);
    return Buffer.from(compressed);
  }
  try {
    return inflateRawSync(compressed, { maxOutputLength: Math.max(1, outputLimit) });
  } catch (error) {
    if (error?.code === "ERR_BUFFER_TOO_LARGE") throw decompressedSizeError(name, limits, previousTotalBytes);
    throw new ArchiveError("ARCHIVE_DECOMPRESSION_FAILED", `Archive entry '${name}' could not be decompressed: ${error.message}`);
  }
}

function zipLocalHeader(name, compressed, data, method) {
  const header = Buffer.alloc(30 + Buffer.byteLength(name));
  header.writeUInt32LE(0x04034b50, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(0x0800, 6);
  header.writeUInt16LE(method, 8);
  header.writeUInt16LE(0, 10);
  header.writeUInt16LE(0, 12);
  header.writeUInt32LE(crc32(data), 14);
  header.writeUInt32LE(compressed.length, 18);
  header.writeUInt32LE(data.length, 22);
  header.writeUInt16LE(Buffer.byteLength(name), 26);
  header.writeUInt16LE(0, 28);
  header.write(name, 30, "utf8");
  return header;
}

function zipCentralHeader(name, compressed, data, method, offset) {
  const header = Buffer.alloc(46 + Buffer.byteLength(name));
  header.writeUInt32LE(0x02014b50, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(20, 6);
  header.writeUInt16LE(0x0800, 8);
  header.writeUInt16LE(method, 10);
  header.writeUInt16LE(0, 12);
  header.writeUInt16LE(0, 14);
  header.writeUInt32LE(crc32(data), 16);
  header.writeUInt32LE(compressed.length, 20);
  header.writeUInt32LE(data.length, 24);
  header.writeUInt16LE(Buffer.byteLength(name), 28);
  header.writeUInt16LE(0, 30);
  header.writeUInt16LE(0, 32);
  header.writeUInt16LE(0, 34);
  header.writeUInt16LE(0, 36);
  header.writeUInt32LE(0, 38);
  header.writeUInt32LE(offset, 42);
  header.write(name, 46, "utf8");
  return header;
}

export function createDeterministicZip(entries, options = {}) {
  const limits = { ...ARCHIVE_LIMITS, ...options };
  const normalized = entries.map((entry) => {
    const name = normalizeArchivePath(entry.path ?? entry.name);
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data ?? "");
    fail(data.length > limits.maxEntryBytes, "ARCHIVE_ENTRY_TOO_LARGE", `Archive entry '${name}' exceeds the per-file size limit`);
    return { name, data };
  }).sort((left, right) => compareNames(left.name, right.name));
  fail(normalized.length === 0, "ARCHIVE_EMPTY", "Cannot publish an empty Plugin archive");
  fail(normalized.length > limits.maxEntries, "ARCHIVE_TOO_MANY_ENTRIES", "Plugin archive contains too many files");
  const names = new Set();
  let totalBytes = 0;
  for (const entry of normalized) {
    fail(names.has(entry.name), "ARCHIVE_DUPLICATE_ENTRY", `Archive contains duplicate entry '${entry.name}'`);
    names.add(entry.name);
    totalBytes += entry.data.length;
  }
  fail(totalBytes > limits.maxTotalBytes, "ARCHIVE_TOO_LARGE", "Plugin archive expands beyond the total size limit");

  const localParts = [];
  const centralParts = [];
  let offset = 0;
  for (const entry of normalized) {
    const compressed = deflateRawSync(entry.data, { level: 9 });
    const method = 8;
    const local = zipLocalHeader(entry.name, compressed, entry.data, method);
    localParts.push(local, compressed);
    centralParts.push(zipCentralHeader(entry.name, compressed, entry.data, method, offset));
    offset += local.length + compressed.length;
  }
  const central = Buffer.concat(centralParts);
  fail(normalized.length > 0xffff || central.length > 0xffffffff || offset > 0xffffffff, "ARCHIVE_TOO_LARGE", "ZIP64 archives are not supported");
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(normalized.length, 8);
  end.writeUInt16LE(normalized.length, 10);
  end.writeUInt32LE(central.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  const archive = Buffer.concat([...localParts, central, end]);
  fail(archive.length > limits.maxArchiveBytes, "ARCHIVE_TOO_LARGE", "Plugin archive exceeds the archive size limit");
  return archive;
}

export async function writeDeterministicZip(packageRoot, outputPath, options = {}) {
  const entries = await collectFiles(path.resolve(packageRoot), options.filter ?? packageArchiveFilter);
  const archive = createDeterministicZip(entries, options);
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, archive, { flag: options.overwrite ? "w" : "wx" });
  return { outputPath, size: archive.length, sha256: sha256Buffer(archive), entries: entries.map((entry) => entry.path) };
}

function sha256Buffer(data) {
  return createHash("sha256").update(data).digest("hex");
}

export async function sha256File(filePath) {
  return sha256Buffer(await readFile(filePath));
}

function readUInt32(buffer, offset, code, message) {
  if (offset < 0 || offset + 4 > buffer.length) throw new ArchiveError(code, message);
  return buffer.readUInt32LE(offset);
}

function readUInt16(buffer, offset, code, message) {
  if (offset < 0 || offset + 2 > buffer.length) throw new ArchiveError(code, message);
  return buffer.readUInt16LE(offset);
}

function findEndOfCentralDirectory(buffer) {
  if (buffer.length < 22) throw new ArchiveError("ARCHIVE_INVALID", "ZIP end-of-central-directory record is missing");
  const start = Math.max(0, buffer.length - 22 - 0xffff);
  for (let offset = buffer.length - 22; offset >= start; offset -= 1) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) return offset;
  }
  throw new ArchiveError("ARCHIVE_INVALID", "ZIP end-of-central-directory record is missing");
}

export function inspectZip(input, options = {}) {
  const buffer = Buffer.isBuffer(input) ? input : Buffer.from(input);
  const limits = { ...ARCHIVE_LIMITS, ...options };
  fail(buffer.length > limits.maxArchiveBytes, "ARCHIVE_TOO_LARGE", "Plugin archive exceeds the archive size limit");
  const end = findEndOfCentralDirectory(buffer);
  const disk = readUInt16(buffer, end + 4, "ARCHIVE_INVALID", "ZIP disk metadata is invalid");
  const centralDisk = readUInt16(buffer, end + 6, "ARCHIVE_INVALID", "ZIP central directory disk metadata is invalid");
  const entriesOnDisk = readUInt16(buffer, end + 8, "ARCHIVE_INVALID", "ZIP entry count is invalid");
  const entriesTotal = readUInt16(buffer, end + 10, "ARCHIVE_INVALID", "ZIP entry count is invalid");
  const centralSize = readUInt32(buffer, end + 12, "ARCHIVE_INVALID", "ZIP central directory size is invalid");
  const centralOffset = readUInt32(buffer, end + 16, "ARCHIVE_INVALID", "ZIP central directory offset is invalid");
  fail(disk !== 0 || centralDisk !== 0 || entriesOnDisk !== entriesTotal, "ARCHIVE_UNSUPPORTED", "Multi-disk ZIP archives are not supported");
  fail(entriesTotal > limits.maxEntries, "ARCHIVE_TOO_MANY_ENTRIES", "Plugin archive contains too many files");
  fail(centralOffset + centralSize > end || centralOffset > buffer.length, "ARCHIVE_INVALID", "ZIP central directory is outside the archive");

  const entries = [];
  const names = new Set();
  let cursor = centralOffset;
  let totalBytes = 0;
  for (let index = 0; index < entriesTotal; index += 1) {
    fail(readUInt32(buffer, cursor, "ARCHIVE_INVALID", "ZIP central directory record is truncated") !== 0x02014b50, "ARCHIVE_INVALID", "ZIP central directory record is invalid");
    const flags = readUInt16(buffer, cursor + 8, "ARCHIVE_INVALID", "ZIP flags are invalid");
    const method = readUInt16(buffer, cursor + 10, "ARCHIVE_INVALID", "ZIP compression method is invalid");
    const crc = readUInt32(buffer, cursor + 16, "ARCHIVE_INVALID", "ZIP CRC is invalid");
    const compressedSize = readUInt32(buffer, cursor + 20, "ARCHIVE_INVALID", "ZIP compressed size is invalid");
    const uncompressedSize = readUInt32(buffer, cursor + 24, "ARCHIVE_INVALID", "ZIP uncompressed size is invalid");
    const nameLength = readUInt16(buffer, cursor + 28, "ARCHIVE_INVALID", "ZIP filename length is invalid");
    const extraLength = readUInt16(buffer, cursor + 30, "ARCHIVE_INVALID", "ZIP extra field length is invalid");
    const commentLength = readUInt16(buffer, cursor + 32, "ARCHIVE_INVALID", "ZIP comment length is invalid");
    const externalAttrs = readUInt32(buffer, cursor + 38, "ARCHIVE_INVALID", "ZIP attributes are invalid");
    const localOffset = readUInt32(buffer, cursor + 42, "ARCHIVE_INVALID", "ZIP local header offset is invalid");
    const recordLength = 46 + nameLength + extraLength + commentLength;
    fail(cursor + recordLength > buffer.length, "ARCHIVE_INVALID", "ZIP central directory record is truncated");
    const rawName = buffer.subarray(cursor + 46, cursor + 46 + nameLength).toString("utf8");
    const directory = rawName.endsWith("/");
    const name = normalizeArchivePath(rawName, { directory });
    const nameKey = name.toLocaleLowerCase("en-US");
    fail(names.has(nameKey), "ARCHIVE_DUPLICATE_ENTRY", `Archive contains duplicate entry '${name}'`);
    names.add(nameKey);
    fail(flags & 0x1, "ARCHIVE_ENCRYPTED", `Archive entry '${name}' is encrypted`);
    fail(flags & 0x8, "ARCHIVE_UNSUPPORTED", `Archive entry '${name}' uses a data descriptor`);
    fail(method !== 0 && method !== 8, "ARCHIVE_COMPRESSION_UNSUPPORTED", `Archive entry '${name}' uses unsupported compression`);
    fail(uncompressedSize > limits.maxEntryBytes, "ARCHIVE_ENTRY_TOO_LARGE", `Archive entry '${name}' exceeds the per-file size limit`);
    const previousTotalBytes = totalBytes;
    const outputLimit = Math.min(limits.maxEntryBytes, limits.maxTotalBytes - previousTotalBytes);
    totalBytes += uncompressedSize;
    fail(totalBytes > limits.maxTotalBytes, "ARCHIVE_TOO_LARGE", "Plugin archive expands beyond the total size limit");
    const unixMode = externalAttrs >>> 16;
    fail((unixMode & 0xf000) === 0xa000, "ARCHIVE_SYMLINK", `Archive entry '${name}' is a symbolic link`);
    fail(localOffset + 30 > buffer.length, "ARCHIVE_INVALID", `Archive entry '${name}' has no local header`);
    fail(readUInt32(buffer, localOffset, "ARCHIVE_INVALID", `Archive entry '${name}' local header is invalid`) !== 0x04034b50, "ARCHIVE_INVALID", `Archive entry '${name}' local header is invalid`);
    const localNameLength = readUInt16(buffer, localOffset + 26, "ARCHIVE_INVALID", `Archive entry '${name}' local filename is invalid`);
    const localExtraLength = readUInt16(buffer, localOffset + 28, "ARCHIVE_INVALID", `Archive entry '${name}' local extra field is invalid`);
    const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
    fail(dataOffset + compressedSize > buffer.length, "ARCHIVE_INVALID", `Archive entry '${name}' data is truncated`);
    const compressed = buffer.subarray(dataOffset, dataOffset + compressedSize);
    let data;
    data = inflateEntry(name, compressed, method, outputLimit, limits, previousTotalBytes);
    fail(data.length !== uncompressedSize, "ARCHIVE_SIZE_MISMATCH", `Archive entry '${name}' has an invalid uncompressed size`);
    fail(crc32(data) !== crc, "ARCHIVE_CRC_MISMATCH", `Archive entry '${name}' failed its CRC check`);
    entries.push({ name, data, directory, compressedSize, uncompressedSize });
    cursor += recordLength;
  }
  return { entries, totalBytes, archiveBytes: buffer.length };
}

function safeDestination(root, name) {
  const relative = name.endsWith("/") ? name.slice(0, -1) : name;
  const target = path.resolve(root, ...relative.split("/"));
  const boundary = path.resolve(root);
  const relation = path.relative(boundary, target);
  fail(!relation || relation.startsWith("..") || path.isAbsolute(relation), "ARCHIVE_PATH_TRAVERSAL", `Archive entry path '${name}' escapes the staging directory`);
  return target;
}

export async function extractZip(input, destinationRoot, options = {}) {
  const buffer = Buffer.isBuffer(input) ? input : await readFile(input);
  const inspected = inspectZip(buffer, options);
  const destination = path.resolve(destinationRoot);
  await mkdir(destination, { recursive: true });
  for (const entry of inspected.entries) {
    const target = safeDestination(destination, entry.name);
    if (entry.directory) {
      await mkdir(target, { recursive: true });
      continue;
    }
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, entry.data, { flag: "wx", mode: 0o644 });
  }
  return { ...inspected, destination };
}
