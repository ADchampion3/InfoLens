import { readFile, stat } from "node:fs/promises";
import path from "node:path";

const TEXT_EXTENSIONS = new Set([".html", ".htm", ".js", ".mjs", ".cjs", ".css"]);
const SOURCE_MAP_PATTERN = /(?:^|\s)(?:\/\/|\/\*#?)\s*[@#]?\s*sourceMappingURL\s*=\s*([^\s*]+)/g;

function normalizeReference(value) {
  return value.trim().replace(/^[\'"`]|[\'"`]$/g, "").split(/[?#]/, 1)[0];
}

function finding(id, severity, source, reference, message, details = {}) {
  return { id, severity, status: severity === "error" ? "failed" : "reported", source, reference, message, ...details };
}

function isExternal(reference) {
  if (/^[A-Za-z]:[\\/]/.test(reference)) return false;
  return /^(?:https?:)?\/\//i.test(reference) || /^[a-z][a-z\d+.-]*:/i.test(reference);
}

function isAbsoluteLocal(reference) {
  return reference.startsWith("/") || /^[A-Za-z]:[\\/]/.test(reference);
}

function isRuntimeMount(reference) {
  return reference.startsWith("/runtime/");
}

function staticReferences(filename, source) {
  const extension = path.extname(filename).toLowerCase();
  const references = [];
  const dynamic = [];
  const add = (reference, kind = "dependency") => {
    const normalized = normalizeReference(reference);
    if (!normalized || normalized.startsWith("#") || /^data:/i.test(normalized)) return;
    if (/sourceMappingURL/i.test(kind)) return;
    references.push({ reference: normalized, kind });
  };
  const addDynamic = (reference, kind = "dynamic") => {
    const normalized = normalizeReference(reference);
    if (normalized) dynamic.push({ reference: normalized, kind });
  };

  const withoutMaps = source.replace(SOURCE_MAP_PATTERN, "");
  if (extension === ".html" || extension === ".htm") {
    for (const match of withoutMaps.matchAll(/<(?:script|link|img|source|video|audio|iframe|object)\b[^>]*?(?:src|href|poster|data)\s*=\s*(["'])(.*?)\1/giu)) add(match[2], "html");
    for (const match of withoutMaps.matchAll(/\bsrcset\s*=\s*(["'])(.*?)\1/giu)) {
      for (const item of match[2].split(",")) add(item.trim().split(/\s+/, 1)[0], "html");
    }
  } else if (extension === ".css") {
    for (const match of withoutMaps.matchAll(/@import\s+(?:url\(\s*)?["']?([^"')\s]+)["']?\s*\)?/giu)) {
      if (/\bvar\s*\(|\$\{|\s[+]|[+]\s/u.test(match[1])) addDynamic(match[1], "computed");
      else add(match[1], "css");
    }
    for (const match of withoutMaps.matchAll(/url\(\s*([^)]*?)\s*\)/giu)) {
      if (/\bvar\s*\(|\$\{|\s[+]|[+]\s/u.test(match[1])) addDynamic(match[1], "computed");
      else add(match[1], "css");
    }
  } else if (TEXT_EXTENSIONS.has(extension)) {
    for (const match of withoutMaps.matchAll(/(?:^|[;\n])\s*(?:import|export)\s+(?:[^'"\n]*?\s+from\s+)?["']([^"']+)["']/gmu)) add(match[1], "module");
    for (const match of withoutMaps.matchAll(/\bimport\s*\(\s*(`[^`$]*`|["'][^"']+["'])\s*\)/gmu)) add(match[1], "module");
    for (const match of withoutMaps.matchAll(/\bimport\s*\(\s*(["'])(.*?)\1\s*\)/gmu)) add(match[2], "module");
    for (const match of withoutMaps.matchAll(/\bimport\s*\(\s*(`[^`]*\$\{[^`]+\}[^`]*`)\s*\)/gmu)) addDynamic(match[1], "computed");
    for (const match of withoutMaps.matchAll(/\bnew\s+URL\(\s*(["'])(.*?)\1\s*,\s*import\.meta\.url\s*\)/gmu)) add(match[2], "module");
    for (const match of withoutMaps.matchAll(/\bfetch\s*\(\s*(["'])(.*?)\1\s*\)/gmu)) add(match[2], "fetch");
    for (const match of withoutMaps.matchAll(/\bfetch\s*\(\s*([^"'`][^)]*)\)/gmu)) addDynamic(match[1], "computed");
    for (const match of withoutMaps.matchAll(/\brequire\s*\(\s*(["'])(.*?)\1\s*\)/gmu)) add(match[2], "module");
    for (const match of withoutMaps.matchAll(/\bimport\s*\(\s*([^"'`][^)]*)\)/gmu)) dynamic.push({ reference: match[1].trim(), kind: "dynamic" });
    for (const match of withoutMaps.matchAll(/\bnew\s+URL\(\s*(`[^`]*\$\{[^`]+\}[^`]*`|[^"'`][^,)]*)\s*,\s*import\.meta\.url\s*\)/gmu)) dynamic.push({ reference: match[1].trim(), kind: "computed" });
  }
  return { references, dynamic };
}

async function resolveLocalReference(workspaceRoot, sourceFile, reference) {
  if (isExternal(reference) || isRuntimeMount(reference)) return { kind: "external" };
  if (isAbsoluteLocal(reference)) return { kind: "absolute" };
  const candidate = path.resolve(path.dirname(sourceFile), reference);
  const relative = path.relative(workspaceRoot, candidate);
  if (relative.startsWith("..") || path.isAbsolute(relative)) return { kind: "escape", candidate };

  const candidates = [candidate];
  if (!path.extname(candidate)) {
    for (const extension of [".js", ".mjs", ".css", ".html"]) candidates.push(`${candidate}${extension}`);
    for (const extension of [".js", ".mjs", ".css", ".html"]) candidates.push(path.join(candidate, `index${extension}`));
  }
  for (const value of candidates) {
    try {
      const details = await stat(value);
      if (details.isFile()) return { kind: "local", candidate: value };
    } catch {}
  }
  return { kind: "missing", candidate };
}

export async function diagnoseWorkspaceBundle(workspaceEntry, workspaceRoot = path.dirname(workspaceEntry)) {
  const root = path.resolve(workspaceRoot);
  const entry = path.resolve(workspaceEntry);
  const checks = [];
  const visited = new Set();
  const reported = new Set();

  const report = (value) => {
    const key = [value.id, value.source, value.reference ?? ""].join("\0");
    if (reported.has(key)) return;
    reported.add(key);
    checks.push(value);
  };

  const entryRelative = path.relative(root, entry);
  if (entryRelative.startsWith("..") || path.isAbsolute(entryRelative)) {
    report(finding("workspace.path-escape", "error", entry, entry, "Workspace entry is outside the Workspace Bundle", { code: "WORKSPACE_PATH_ESCAPE" }));
    return { entry, workspaceRoot: root, visited: [], checks };
  }

  const visit = async (filename) => {
    const resolved = path.resolve(filename);
    if (visited.has(resolved)) return;
    visited.add(resolved);
    let source;
    try { source = await readFile(resolved, "utf8"); }
    catch (error) {
      report(finding("workspace.missing-dependency", "error", resolved, resolved, "Workspace dependency is missing", { code: "WORKSPACE_MISSING_DEPENDENCY", details: { reason: error.code ?? "READ_FAILED" } }));
      return;
    }
    const { references, dynamic } = staticReferences(resolved, source);
    for (const item of dynamic) {
      report(finding("workspace.dynamic-reference", "warning", resolved, item.reference, "Workspace reference cannot be resolved statically", { code: "WORKSPACE_DYNAMIC_REFERENCE", details: { kind: item.kind } }));
    }
    for (const item of references) {
      const reference = item.reference;
      if (isExternal(reference)) {
        report(finding("workspace.external-reference", "warning", resolved, reference, "External Workspace resource was not fetched", { code: "WORKSPACE_EXTERNAL_REFERENCE", details: { kind: item.kind } }));
        continue;
      }
      if (isRuntimeMount(reference)) {
        report(finding("workspace.runtime-reference", "info", resolved, reference, "Host Runtime resource reference", { code: "WORKSPACE_RUNTIME_REFERENCE", details: { kind: item.kind } }));
        continue;
      }
      const result = await resolveLocalReference(root, resolved, reference);
      if (result.kind === "absolute") {
        report(finding("workspace.absolute-reference", "error", resolved, reference, "Workspace uses a disallowed absolute local path", { code: "WORKSPACE_ABSOLUTE_REFERENCE", details: { kind: item.kind } }));
      } else if (result.kind === "escape") {
        report(finding("workspace.path-escape", "error", resolved, reference, "Workspace reference escapes the Workspace Bundle", { code: "WORKSPACE_PATH_ESCAPE", details: { candidate: result.candidate, kind: item.kind } }));
      } else if (result.kind === "missing") {
        report(finding("workspace.missing-dependency", "error", resolved, reference, "Workspace dependency is missing", { code: "WORKSPACE_MISSING_DEPENDENCY", details: { candidate: result.candidate, kind: item.kind } }));
      } else if (TEXT_EXTENSIONS.has(path.extname(result.candidate).toLowerCase())) {
        await visit(result.candidate);
      }
    }
  };

  await visit(entry);
  return { entry, workspaceRoot: root, visited: [...visited], checks };
}
