import { createWriteStream } from "node:fs";
import { copyFile, mkdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { sha256File } from "./archive.mjs";
import { normalizeSha256, readDigestCompanion } from "./artifact.mjs";

export const DEFAULT_SOURCE_LIMITS = Object.freeze({
  maxArchiveBytes: 128 * 1024 * 1024,
  maxRedirects: 3,
  requestTimeoutMs: 30_000,
  maxTemporaryBytes: 128 * 1024 * 1024,
});

export class DistributionError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "DistributionError";
    this.code = code;
    Object.assign(this, details);
  }
}

function sourceFailure(code, message, details) { return new DistributionError(code, message, details); }

export function normalizeDistributionFileName(value, fallback) {
  const candidate = typeof value === "string" && value.trim() ? value.trim() : fallback;
  if (typeof candidate !== "string") throw sourceFailure("DISTRIBUTION_FILE_NAME_INVALID", "Distribution file name is invalid");
  const fileName = path.posix.basename(candidate.replaceAll("\\", "/"));
  if (!fileName || fileName === "." || fileName === ".." || fileName.length > 255) throw sourceFailure("DISTRIBUTION_FILE_NAME_INVALID", "Distribution file name is invalid");
  return fileName;
}

export function normalizeDistributionSource(source = {}) {
  const value = typeof source === "string" ? { kind: "local", path: source } : source;
  if (!value || typeof value !== "object") throw sourceFailure("DISTRIBUTION_SOURCE_INVALID", "Distribution source must be an object");
  const kind = value.kind ?? value.type;
  if (kind === "local" || kind === "file") {
    const sourcePath = value.path ?? value.archivePath ?? value.sourcePath;
    if (typeof sourcePath !== "string" || !path.isAbsolute(sourcePath)) throw sourceFailure("DISTRIBUTION_LOCAL_PATH_INVALID", "Local distribution source requires an absolute archive path");
    return {
      kind: "local",
      path: path.resolve(sourcePath),
      fileName: normalizeDistributionFileName(value.fileName, sourcePath),
      ...(value.expectedSha256 || value.sha256 ? { expectedSha256: normalizeSha256(value.expectedSha256 ?? value.sha256) } : {}),
    };
  }
  if (kind === "url" || kind === "https") {
    if (typeof value.url !== "string" || !value.url.trim()) throw sourceFailure("DISTRIBUTION_URL_INVALID", "Direct distribution source requires a URL");
    let parsed;
    try { parsed = new URL(value.url); } catch { throw sourceFailure("DISTRIBUTION_URL_INVALID", "Distribution URL is invalid"); }
    if (parsed.protocol !== "https:") throw sourceFailure("DISTRIBUTION_URL_UNSUPPORTED", "Distribution URL must use HTTPS");
    if (parsed.username || parsed.password) throw sourceFailure("DISTRIBUTION_URL_INVALID", "Distribution URL must not contain credentials");
    return { kind: "url", url: parsed.toString(), expectedSha256: normalizeSha256(value.expectedSha256 ?? value.sha256, "DISTRIBUTION_EXPECTED_DIGEST_REQUIRED") };
  }
  throw sourceFailure("DISTRIBUTION_SOURCE_INVALID", "Distribution source must be local or direct HTTPS URL");
}

function responseHeader(response, name) { return response.headers?.get?.(name) ?? response.headers?.[name.toLowerCase()] ?? response.headers?.[name]; }

function controlledRequest(signal, timeoutMs) {
  const controller = new AbortController();
  let timer;
  let timedOut = false;
  const onAbort = () => controller.abort(signal?.reason);
  if (signal) {
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  }
  if (Number.isFinite(timeoutMs) && timeoutMs > 0) timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  return { signal: controller.signal, timedOut: () => timedOut, cleanup: () => { if (timer) clearTimeout(timer); signal?.removeEventListener("abort", onAbort); } };
}

function distributionAbortError(request) {
  return sourceFailure(request.timedOut() ? "DISTRIBUTION_DOWNLOAD_TIMEOUT" : "DISTRIBUTION_CANCELLED", request.timedOut() ? "Distribution download timed out" : "Distribution operation was cancelled");
}

async function readResponseChunk(read, request) {
  if (request.signal.aborted) throw distributionAbortError(request);
  let abortHandler;
  try {
    return await Promise.race([
      read(),
      new Promise((_, reject) => {
        abortHandler = () => reject(distributionAbortError(request));
        request.signal.addEventListener("abort", abortHandler, { once: true });
      }),
    ]);
  } finally {
    if (abortHandler) request.signal.removeEventListener("abort", abortHandler);
  }
}

async function writeResponse(response, destination, request, limits, onProgress) {
  const maxBytes = limits.maxArchiveBytes ?? DEFAULT_SOURCE_LIMITS.maxArchiveBytes;
  const output = createWriteStream(destination, { flags: "wx" });
  let received = 0;
  const write = (chunk) => new Promise((resolve, reject) => {
    const value = Buffer.from(chunk);
    received += value.length;
    if (received > maxBytes || received > (limits.maxTemporaryBytes ?? maxBytes)) {
      reject(sourceFailure("DISTRIBUTION_DOWNLOAD_TOO_LARGE", "Distribution download exceeds the temporary storage limit"));
      return;
    }
    const onError = (error) => { output.off("drain", onDrain); reject(error); };
    const onDrain = () => { output.off("error", onError); resolve(); };
    output.once("error", onError);
    if (output.write(value)) { output.off("error", onError); resolve(); } else output.once("drain", onDrain);
    onProgress?.({ received, total: Number(responseHeader(response, "content-length")) || undefined });
  });
  try {
    if (response.body && typeof response.body[Symbol.asyncIterator] === "function") {
      const iterator = response.body[Symbol.asyncIterator]();
      let exhausted = false;
      try {
        while (true) {
          const next = await readResponseChunk(() => iterator.next(), request);
          if (next.done) { exhausted = true; break; }
          await write(next.value);
        }
      } finally { if (!exhausted) await iterator.return?.().catch?.(() => {}); }
    } else if (response.body && typeof response.body.getReader === "function") {
      const reader = response.body.getReader();
      let exhausted = false;
      try {
        while (true) {
          const next = await readResponseChunk(() => reader.read(), request);
          if (next.done) { exhausted = true; break; }
          await write(next.value);
        }
      } finally {
        if (!exhausted) await reader.cancel?.().catch?.(() => {});
        reader.releaseLock?.();
      }
    } else {
      throw sourceFailure("DISTRIBUTION_STREAM_UNAVAILABLE", "Distribution response does not expose a readable stream");
    }
    await new Promise((resolve, reject) => { output.once("error", reject); output.end(resolve); });
    return received;
  } finally {
    if (!output.closed) await new Promise((resolve) => {
      output.once("close", resolve);
      output.destroy();
    });
  }
}

export async function downloadDistributionSource(source, destination, { transport = fetch, signal, limits = {}, onProgress } = {}) {
  const normalized = normalizeDistributionSource(source);
  if (normalized.kind !== "url") throw sourceFailure("DISTRIBUTION_SOURCE_KIND_INVALID", "Download adapter requires a URL source");
  const options = { ...DEFAULT_SOURCE_LIMITS, ...limits };
  await mkdir(path.dirname(destination), { recursive: true });
  let current = normalized.url;
  let observedUrl = current;
  for (let redirect = 0; redirect <= options.maxRedirects; redirect += 1) {
    const request = controlledRequest(signal, options.requestTimeoutMs);
    let complete = false;
    try {
      let response;
      try { response = await transport(current, { signal: request.signal, redirect: "manual" }); }
      catch (error) {
        if (signal?.aborted) throw sourceFailure("DISTRIBUTION_CANCELLED", "Distribution operation was cancelled");
        if (request.timedOut()) throw sourceFailure("DISTRIBUTION_DOWNLOAD_TIMEOUT", "Distribution download timed out");
        throw sourceFailure("DISTRIBUTION_TRANSPORT_FAILED", error instanceof Error ? error.message : String(error));
      }
      const location = responseHeader(response, "location");
      if ([301, 302, 303, 307, 308].includes(response.status) && location) {
        if (redirect >= options.maxRedirects) throw sourceFailure("DISTRIBUTION_REDIRECT_LIMIT", "Distribution URL redirected too many times");
        let next;
        try { next = new URL(location, current); } catch { throw sourceFailure("DISTRIBUTION_URL_INVALID", "Distribution redirect URL is invalid"); }
        if (next.protocol !== "https:" || next.username || next.password) throw sourceFailure("DISTRIBUTION_URL_UNSUPPORTED", "Distribution redirects must remain HTTPS and credential-free");
        current = next.toString(); observedUrl = current; continue;
      }
      if (!response?.ok) throw sourceFailure("DISTRIBUTION_DOWNLOAD_HTTP_ERROR", `Distribution URL returned HTTP ${response?.status ?? "unknown"}`);
      const contentLength = Number(responseHeader(response, "content-length") ?? 0);
      if (Number.isFinite(contentLength) && contentLength > options.maxArchiveBytes) throw sourceFailure("DISTRIBUTION_DOWNLOAD_TOO_LARGE", "Distribution download exceeds the size limit");
      const received = await writeResponse(response, destination, request, options, onProgress);
      const sha256 = await sha256File(destination, { maxArchiveBytes: options.maxArchiveBytes });
      if (normalized.expectedSha256 && normalized.expectedSha256 !== sha256) throw sourceFailure("DISTRIBUTION_DIGEST_MISMATCH", "Distribution download does not match the expected SHA-256", { expectedSha256: normalized.expectedSha256, observedSha256: sha256 });
      complete = true;
      return { kind: "url", path: path.resolve(destination), url: observedUrl, bytes: received, sha256, expectedSha256: normalized.expectedSha256 };
    } catch (error) {
      if (signal?.aborted) throw sourceFailure("DISTRIBUTION_CANCELLED", "Distribution operation was cancelled");
      if (request.timedOut()) throw sourceFailure("DISTRIBUTION_DOWNLOAD_TIMEOUT", "Distribution download timed out");
      throw error instanceof DistributionError ? error : sourceFailure("DISTRIBUTION_TRANSPORT_FAILED", error instanceof Error ? error.message : String(error));
    } finally { request.cleanup(); if (!complete) await rm(destination, { force: true }); }
  }
  throw sourceFailure("DISTRIBUTION_REDIRECT_LIMIT", "Distribution URL redirected too many times");
}

export async function stageLocalDistributionSource(source, destination, { limits = {}, signal } = {}) {
  const normalized = normalizeDistributionSource(source);
  if (normalized.kind !== "local") throw sourceFailure("DISTRIBUTION_SOURCE_KIND_INVALID", "Local adapter requires a local source");
  if (signal?.aborted) throw sourceFailure("DISTRIBUTION_CANCELLED", "Distribution operation was cancelled");
  const options = { ...DEFAULT_SOURCE_LIMITS, ...limits };
  const details = await stat(normalized.path).catch((error) => { throw sourceFailure("DISTRIBUTION_SOURCE_UNAVAILABLE", `Local distribution source is unavailable: ${error.message}`); });
  if (!details.isFile()) throw sourceFailure("DISTRIBUTION_SOURCE_UNAVAILABLE", "Local distribution source is not a regular file");
  if (details.size > options.maxArchiveBytes || details.size > options.maxTemporaryBytes) throw sourceFailure("DISTRIBUTION_DOWNLOAD_TOO_LARGE", "Local distribution source exceeds the size limit");
  await mkdir(path.dirname(destination), { recursive: true });
  let complete = false;
  try {
    await copyFile(normalized.path, destination);
    if (signal?.aborted) throw sourceFailure("DISTRIBUTION_CANCELLED", "Distribution operation was cancelled");
    const companion = await readDigestCompanion(normalized.path);
    const expectedSha256 = normalized.expectedSha256 ?? companion?.sha256;
    const sha256 = await sha256File(destination, { maxArchiveBytes: options.maxArchiveBytes });
    if (signal?.aborted) throw sourceFailure("DISTRIBUTION_CANCELLED", "Distribution operation was cancelled");
    if (expectedSha256 && normalizeSha256(expectedSha256) !== sha256) throw sourceFailure("DISTRIBUTION_DIGEST_MISMATCH", "Local distribution digest does not match the expected SHA-256", { expectedSha256: normalizeSha256(expectedSha256), observedSha256: sha256 });
    complete = true;
    return { kind: "local", path: path.resolve(destination), sourcePath: normalized.path, fileName: normalized.fileName ?? path.basename(normalized.path), bytes: details.size, sha256, ...(expectedSha256 ? { expectedSha256: normalizeSha256(expectedSha256) } : {}) };
  } finally {
    if (!complete) await rm(destination, { force: true });
  }
}
