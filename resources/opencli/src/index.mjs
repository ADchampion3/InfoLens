import path from "node:path";
import { fileURLToPath } from "node:url";

export const BUNDLED_OPENCLI_SOURCE = "bundled-opencli-package";
export const BUNDLED_OPENCLI_PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function resolveBundledOpenCliPackage() {
  return {
    root: BUNDLED_OPENCLI_PACKAGE_ROOT,
    source: BUNDLED_OPENCLI_SOURCE,
    sourcePath: path.join(BUNDLED_OPENCLI_PACKAGE_ROOT, "package.json"),
  };
}
