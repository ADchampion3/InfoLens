import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const metadataPath = path.join(packageRoot, "release-metadata.json");
const packageManifestPath = path.join(packageRoot, "package.json");
const bootstrapMetadata = JSON.parse(readFileSync(metadataPath, "utf8"));

export const RELEASE_METADATA_SOURCE = "release-metadata-package";
export const RELEASE_METADATA_PATH = metadataPath;

let cached;

function readJson(filename) {
  return readFile(filename, "utf8").then((value) => JSON.parse(value));
}

export async function resolveReleaseMetadata() {
  if (!cached) {
    cached = Promise.all([readJson(metadataPath), readJson(packageManifestPath)]).then(([metadata, packageManifest]) => {
      const contractVersion = Number.isInteger(metadata.pluginContractVersion)
        ? String(metadata.pluginContractVersion)
        : null;
      const hostVersion = typeof metadata.hostVersion === "string" ? metadata.hostVersion : null;
      return Object.freeze({
        packageName: packageManifest.name,
        packageVersion: packageManifest.version,
        contractVersion,
        pluginContractVersion: contractVersion === null ? null : Number(contractVersion),
        hostVersion,
        source: RELEASE_METADATA_SOURCE,
        sourcePath: metadataPath,
        packageManifestPath,
      });
    });
  }
  return cached;
}

export const DEFAULT_TARGET_HOST_VERSION = bootstrapMetadata.hostVersion;
export const PLUGIN_CONTRACT_VERSION = String(bootstrapMetadata.pluginContractVersion);
