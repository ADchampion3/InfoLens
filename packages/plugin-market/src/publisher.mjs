import { access, copyFile, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { collectFiles, createDeterministicZip } from "./archive.mjs";
import { DEFAULT_REGISTRY_URL, normalizeRelease, validateMarketIndex, REGISTRY_SCHEMA_VERSION, MarketError } from "./registry.mjs";

async function exists(filePath) {
  try { await access(filePath); return true; } catch (error) { if (error.code === "ENOENT") return false; throw error; }
}

const PUBLICATION_JOURNAL = "publication.json";

function isWithin(root, target) {
  const relation = path.relative(path.resolve(root), path.resolve(target));
  return Boolean(relation) && !relation.startsWith("..") && !path.isAbsolute(relation);
}

async function writePublicationJournal(filePath, value) {
  const temporary = `${filePath}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: "w" });
  await rename(temporary, filePath);
}

async function readPublicationJournal(filePath) {
  try { return JSON.parse(await readFile(filePath, "utf8")); } catch { return undefined; }
}

async function artifactMatches(filePath, expectedSha256) {
  try { return sha256(await readFile(filePath)) === expectedSha256; } catch { return false; }
}

async function indexContainsRelease(filePath, releaseKey, expectedSha256) {
  try {
    const value = JSON.parse(await readFile(filePath, "utf8"));
    return Array.isArray(value.releases) && value.releases.some((release) => `${release.pluginId}@${release.version}` === releaseKey && release.artifact?.sha256 === expectedSha256);
  } catch { return false; }
}

function journalPaths(outputRoot, stageRoot, journal) {
  if (!journal || journal.version !== 1 || typeof journal.artifactPath !== "string" || typeof journal.indexPath !== "string" || typeof journal.releaseKey !== "string" || typeof journal.artifactSha256 !== "string") return undefined;
  const artifactPath = path.resolve(journal.artifactPath);
  const indexPath = path.resolve(journal.indexPath);
  const previousIndexPath = journal.previousIndexPath ? path.resolve(journal.previousIndexPath) : undefined;
  if (!isWithin(outputRoot, artifactPath) || !isWithin(outputRoot, indexPath) || (previousIndexPath && !isWithin(stageRoot, previousIndexPath))) return undefined;
  return { ...journal, artifactPath, indexPath, previousIndexPath };
}

async function rollbackPublication(journal) {
  const releaseVisible = await indexContainsRelease(journal.indexPath, journal.releaseKey, journal.artifactSha256);
  if (journal.indexPublished || releaseVisible) {
    if (journal.hadIndex && journal.previousIndexPath && await exists(journal.previousIndexPath)) await copyFile(journal.previousIndexPath, journal.indexPath);
    else await rm(journal.indexPath, { force: true });
  }
  if (journal.artifactPublished || await artifactMatches(journal.artifactPath, journal.artifactSha256)) {
    await rm(journal.artifactPath, { force: true });
  }
}

async function recoverInterruptedPublications(outputRoot) {
  const entries = await readdir(outputRoot, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith(".publish-")) continue;
    const stageRoot = path.join(outputRoot, entry.name);
    const rawJournal = await readPublicationJournal(path.join(stageRoot, PUBLICATION_JOURNAL));
    const journal = journalPaths(outputRoot, stageRoot, rawJournal);
    if (!journal) {
      await rm(stageRoot, { recursive: true, force: true });
      continue;
    }
    const artifactVisible = await artifactMatches(journal.artifactPath, journal.artifactSha256);
    const releaseVisible = await indexContainsRelease(journal.indexPath, journal.releaseKey, journal.artifactSha256);
    if (!(artifactVisible && releaseVisible)) await rollbackPublication({ ...journal, artifactPublished: artifactVisible, indexPublished: releaseVisible });
    await rm(stageRoot, { recursive: true, force: true });
  }
}

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u;

function isValidIsoTimestamp(value) {
  if (!ISO_TIMESTAMP.test(value) || Number.isNaN(Date.parse(value))) return false;
  const [datePart] = value.split("T");
  const [year, month, day] = datePart.split("-").map(Number);
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth;
}

function requirePublishApproval(metadata) {
  const approval = metadata?.approval;
  const publisher = typeof metadata?.publisher === "string" ? metadata.publisher.trim() : "";
  const approvedBy = approval && typeof approval === "object" && !Array.isArray(approval) ? approval.approvedBy : undefined;
  const approvedAt = approval && typeof approval === "object" && !Array.isArray(approval) ? approval.approvedAt : undefined;
  const approvedPublisher = approval && typeof approval === "object" && !Array.isArray(approval) ? approval.publisher : undefined;
  if (
    !publisher
    || typeof approvedBy !== "string"
    || !approvedBy.trim()
    || typeof approvedAt !== "string"
    || !isValidIsoTimestamp(approvedAt)
    || typeof approvedPublisher !== "string"
    || approvedPublisher.trim() !== publisher
  ) {
    throw new MarketError("PUBLISH_APPROVAL_REQUIRED", "Publication requires a valid maintainer approval record for the declared publisher");
  }
}

function assertPublisherBinding(index, release) {
  const historicalPublishers = new Set(
    index.releases
      .filter((candidate) => candidate.pluginId === release.pluginId)
      .map((candidate) => candidate.publisher),
  );
  if (historicalPublishers.size > 1 || (historicalPublishers.size === 1 && !historicalPublishers.has(release.publisher))) {
    throw new MarketError("PUBLISHER_BINDING_CONFLICT", `Plugin '${release.pluginId}' is bound to a different publisher`);
  }
}

function releaseMetadata(manifest, metadata, artifact, indexUrl) {
  const resolvedIndexUrl = indexUrl ?? DEFAULT_REGISTRY_URL;
  return normalizeRelease({
    pluginId: manifest.id,
    name: manifest.name,
    description: metadata.description,
    icon: metadata.icon ?? manifest.icon,
    publisher: metadata.publisher,
    license: metadata.license,
    categories: metadata.categories,
    version: manifest.version,
    changelog: metadata.changelog,
    contractVersion: manifest.contractVersion,
    minHostVersion: manifest.minHostVersion,
    platforms: metadata.platforms,
    architectures: metadata.architectures,
    artifact: { url: metadata.artifactUrl ?? new URL(`artifacts/${manifest.id}/${manifest.version}.zip`, resolvedIndexUrl).toString(), size: artifact.size, sha256: artifact.sha256 },
    publishedAt: metadata.publishedAt ?? new Date().toISOString(),
    ...(metadata.retraction ? { retraction: metadata.retraction } : {}),
  }, { indexUrl: resolvedIndexUrl, officialUrl: metadata.officialUrl ?? indexUrl ?? DEFAULT_REGISTRY_URL });
}

export async function publishMarketRelease({ packageRoot, registryRoot, manifest, metadata, indexUrl, validate } = {}) {
  const sourceRoot = path.resolve(packageRoot);
  const outputRoot = path.resolve(registryRoot);
  const publishMetadata = metadata ?? {};
  requirePublishApproval(publishMetadata);
  await mkdir(outputRoot, { recursive: true });
  await recoverInterruptedPublications(outputRoot);
  if (typeof validate === "function") await validate(sourceRoot);
  let resolvedManifest = manifest;
  if (!resolvedManifest) {
    try { resolvedManifest = JSON.parse(await readFile(path.join(sourceRoot, "manifest.json"), "utf8")); }
    catch (error) { throw new MarketError("INVALID_PACKAGE", `manifest.json is missing or invalid: ${error.message}`); }
  }
  if (!resolvedManifest?.id || !resolvedManifest?.version) throw new MarketError("INVALID_PACKAGE", "Validated package manifest must contain id and version");
  const files = await collectFiles(sourceRoot);
  const archive = createDeterministicZip(files);
  const sha256Value = sha256(archive);
  const fileName = `${resolvedManifest.id}-${resolvedManifest.version}.zip`;
  const artifact = { fileName, size: archive.length, sha256: sha256Value };
  const release = releaseMetadata(resolvedManifest, publishMetadata, artifact, indexUrl);
  const indexPath = path.join(outputRoot, "index.json");
  const artifactPath = path.join(outputRoot, "artifacts", release.pluginId, `${release.version}.zip`);
  if (await exists(artifactPath)) throw new MarketError("RELEASE_EXISTS", `Market artifact '${release.pluginId}@${release.version}' already exists`);
  let index = { schemaVersion: REGISTRY_SCHEMA_VERSION, registry: {}, releases: [] };
  if (await exists(indexPath)) index = validateMarketIndex(JSON.parse(await readFile(indexPath, "utf8")), { indexUrl });
  if (index.releases.some((candidate) => candidate.pluginId === release.pluginId && candidate.version === release.version)) throw new MarketError("RELEASE_EXISTS", `Market release '${release.pluginId}@${release.version}' already exists`);
  assertPublisherBinding(index, release);

  const stageRoot = path.join(outputRoot, `.publish-${release.pluginId}-${release.version}-${process.pid}-${Date.now()}`);
  const stageArtifact = path.join(stageRoot, "artifact.zip");
  const stageIndex = path.join(stageRoot, "index.json");
  const previousIndexPath = path.join(stageRoot, "previous-index.json");
  const journalPath = path.join(stageRoot, PUBLICATION_JOURNAL);
  const hadIndex = await exists(indexPath);
  const journal = {
    version: 1,
    releaseKey: `${release.pluginId}@${release.version}`,
    artifactSha256: release.artifact.sha256,
    artifactPath,
    indexPath,
    previousIndexPath: hadIndex ? previousIndexPath : undefined,
    hadIndex,
    artifactPublished: false,
    indexPublished: false,
  };
  let published = false;
  try {
    await mkdir(path.dirname(stageArtifact), { recursive: true });
    await writeFile(stageArtifact, archive, { flag: "wx" });
    const nextIndex = {
      schemaVersion: REGISTRY_SCHEMA_VERSION,
      registry: index.registry,
      generatedAt: new Date().toISOString(),
      releases: [...index.releases, release],
    };
    await writeFile(stageIndex, `${JSON.stringify(nextIndex, null, 2)}\n`, { flag: "wx" });
    await writePublicationJournal(journalPath, journal);
    if (journal.hadIndex) await copyFile(indexPath, previousIndexPath);
    await mkdir(path.dirname(artifactPath), { recursive: true });
    await rename(stageArtifact, artifactPath);
    journal.artifactPublished = true;
    await writePublicationJournal(journalPath, journal);
    await mkdir(path.dirname(indexPath), { recursive: true });
    await rename(stageIndex, indexPath);
    journal.indexPublished = true;
    await writePublicationJournal(journalPath, journal);
    published = true;
    return { release, artifactPath, indexPath };
  } finally {
    if (!published) {
      try { await rollbackPublication(journal); }
      finally { await rm(stageRoot, { recursive: true, force: true }); }
    } else {
      await rm(stageRoot, { recursive: true, force: true });
    }
  }
}
