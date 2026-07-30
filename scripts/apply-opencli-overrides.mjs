import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const productHuntWaitHelper = `
async function waitForProductCards(page, timeoutMs = 30000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const ready = await page.evaluate(\`Boolean(document.querySelector('a[href^="/products/"]'))\`).catch(() => false);
        if (ready)
            return;
        await new Promise((resolve) => setTimeout(resolve, 500));
    }
    throw new CliError('NO_DATA', 'Product Hunt did not finish loading top posts', 'Complete any Product Hunt security verification in the connected browser, then retry');
}
`;

export function patchProductHuntHot(source) {
  if (source.includes("async function waitForProductCards")) return source;

  const importMarker = "import { pickVoteCount } from './utils.js';\n";
  if (!source.includes(importMarker)) throw new Error("Product Hunt adapter import contract changed");
  let patched = source.replace(importMarker, `${importMarker}${productHuntWaitHelper}\n`);

  const captureWait = "        await page.waitForCapture(5);\n";
  const navigation = "        await page.goto('https://www.producthunt.com');\n";
  if (!patched.includes(navigation)) throw new Error("Product Hunt adapter navigation contract changed");
  patched = patched.replace(captureWait, "");
  patched = patched.replace(navigation, `${navigation}        await waitForProductCards(page);\n`);
  return patched;
}

export async function applyOpenCliOverrides(root = path.resolve(import.meta.dirname, "..")) {
  const adapterPath = path.join(root, "resources", "opencli", "node_modules", "@jackwener", "opencli", "clis", "producthunt", "hot.js");
  const source = await readFile(adapterPath, "utf8");
  const patched = patchProductHuntHot(source);
  if (patched !== source) await writeFile(adapterPath, patched, "utf8");
}

if (fileURLToPath(import.meta.url) === path.resolve(process.argv[1] ?? "")) {
  await applyOpenCliOverrides();
}
