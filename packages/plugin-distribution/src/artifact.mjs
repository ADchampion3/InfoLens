import { createHash } from "node:crypto";
import { readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

export const DISTRIBUTION_DESCRIPTION_VERSION = 1;

export function sha256Buffer(value) {
  return createHash("sha256").update(value).digest("hex");
}

function validDigest(value) {
  return typeof value === "string" && /^[0-9a-f]{64}$/iu.test(value.trim());
}

export function normalizeSha256(value, code = "DISTRIBUTION_DIGEST_INVALID") {
  if (!validDigest(value)) {
    const error = new Error("SHA-256 must be exactly 64 hexadecimal characters");
    error.code = code;
    throw error;
  }
  return value.trim().toLowerCase();
}

export function digestCompanionPath(archivePath) {
  return `${path.resolve(archivePath)}.sha256`;
}

export function distributionDescriptionPath(archivePath) {
  return `${path.resolve(archivePath)}.distribution.json`;
}

export async function readDigestCompanion(archivePath, { required = false } = {}) {
  const companionPath = digestCompanionPath(archivePath);
  let value;
  try { value = await readFile(companionPath, "utf8"); }
  catch (error) {
    if (error?.code === "ENOENT" && !required) return undefined;
    if (error?.code === "ENOENT") {
      const missing = new Error("Distribution digest companion is missing");
      missing.code = "DISTRIBUTION_DIGEST_MISSING";
      throw missing;
    }
    throw error;
  }
  const token = value.trim().split(/\s+/u)[0];
  return { path: companionPath, sha256: normalizeSha256(token) };
}

export async function writeDistributionDescription(archivePath, description, { overwrite = false } = {}) {
  const target = distributionDescriptionPath(archivePath);
  const flags = overwrite ? "w" : "wx";
  await writeFile(target, `${JSON.stringify(description, null, 2)}\n`, { encoding: "utf8", flag: flags });
  return target;
}

export async function writeDigestCompanion(archivePath, sha256, { overwrite = false } = {}) {
  const target = digestCompanionPath(archivePath);
  const digest = normalizeSha256(sha256);
  const flags = overwrite ? "w" : "wx";
  await writeFile(target, `${digest}  ${path.basename(archivePath)}\n`, { encoding: "utf8", flag: flags });
  return target;
}

export async function describeDistributionArtifact(archivePath, metadata = {}) {
  const archive = path.resolve(archivePath);
  const details = await stat(archive);
  const sha256 = normalizeSha256(metadata.sha256);
  return {
    schemaVersion: DISTRIBUTION_DESCRIPTION_VERSION,
    plugin: {
      id: metadata.pluginId,
      version: metadata.version,
      contractVersion: String(metadata.contractVersion ?? ""),
      minHostVersion: metadata.minHostVersion,
    },
    artifact: { file: path.basename(archive), size: details.size, sha256 },
    compatibility: {
      ...(Array.isArray(metadata.platforms) ? { platforms: [...metadata.platforms] } : {}),
      ...(Array.isArray(metadata.architectures) ? { architectures: [...metadata.architectures] } : {}),
    },
    build: {
      ...(typeof metadata.builtAt === "string" ? { builtAt: metadata.builtAt } : { builtAt: new Date().toISOString() }),
      ...(metadata.tool ? { tool: metadata.tool } : { tool: "infolens-plugin" }),
      ...(metadata.toolVersion ? { toolVersion: metadata.toolVersion } : {}),
      ...(metadata.hostVersion ? { hostVersion: metadata.hostVersion } : {}),
      ...(metadata.openCliVersion ? { openCliVersion: metadata.openCliVersion } : {}),
    },
  };
}
