function joinUrl(origin, path) {
  return new URL(path, `${origin.replace(/\/$/, "")}/`).toString();
}

export const EXPORT_FORMATS = Object.freeze(["json", "csv", "markdown", "text"]);
const EXPORT_FORMAT_SET = new Set(EXPORT_FORMATS);
const EXPORT_MIME_TYPES = new Set([
  "application/json",
  "text/csv",
  "text/markdown",
  "text/plain",
]);
const MAX_COPY_BYTES = 1024 * 1024;

function exportError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function isIterable(value) {
  return Boolean(value) && (
    typeof value[Symbol.iterator] === "function" ||
    typeof value[Symbol.asyncIterator] === "function"
  );
}

function isByteSequence(value) {
  return value instanceof Uint8Array ||
    (typeof ArrayBuffer !== "undefined" && (value instanceof ArrayBuffer || ArrayBuffer.isView(value)));
}

function isStringBody(value) {
  if (isByteSequence(value) || !isIterable(value)) return false;
  if (Array.isArray(value)) return value.every((chunk) => typeof chunk === "string");
  return true;
}

function workspaceApiUrl(route) {
  const { pluginId, apiBaseUrl } = workspaceRuntimeConfig();
  if (typeof route !== "string" && !(route instanceof URL)) throw new TypeError("Plugin export route must be a string or URL");

  let base;
  try { base = new URL(apiBaseUrl); } catch { throw new TypeError("Plugin API base URL is invalid"); }
  const workspaceOrigin = globalThis.location?.origin;
  if (workspaceOrigin && workspaceOrigin !== "null" && base.origin !== workspaceOrigin) throw new TypeError("Plugin API base URL must share the Workspace origin");
  const expectedPath = `/plugins/${encodeURIComponent(pluginId)}/api/`;
  const basePath = base.pathname.endsWith("/") ? base.pathname : `${base.pathname}/`;
  if (basePath !== expectedPath) throw new TypeError("Plugin API base URL is outside the calling Plugin boundary");

  const rawRoute = String(route);
  let target;
  try {
    if (/^\/plugins\//i.test(rawRoute)) target = new URL(rawRoute, base);
    else if (/^(?:[a-z][a-z\d+.-]*:)?\/\//i.test(rawRoute) || /^[a-z][a-z\d+.-]*:/i.test(rawRoute)) target = new URL(rawRoute);
    else target = new URL(rawRoute.replace(/^\/+/, ""), base);
  } catch { throw new TypeError("Plugin export route is invalid"); }
  if (target.origin !== base.origin || !target.pathname.startsWith(basePath)) {
    throw new TypeError("Plugin export route must stay below the calling Plugin API");
  }
  return target;
}

async function readCopyPayload(response) {
  const encoder = new TextEncoder();
  let bytes = 0;
  if (!response.body || typeof response.body.getReader !== "function") {
    const value = await response.text();
    bytes = encoder.encode(value).byteLength;
    if (bytes > MAX_COPY_BYTES) throw exportError("EXPORT_TOO_LARGE", "Plugin export exceeds the clipboard size limit");
    return value;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let value = "";
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      const chunk = result.value instanceof Uint8Array ? result.value : new Uint8Array(result.value);
      bytes += chunk.byteLength;
      if (bytes > MAX_COPY_BYTES) {
        await reader.cancel().catch(() => {});
        throw exportError("EXPORT_TOO_LARGE", "Plugin export exceeds the clipboard size limit");
      }
      value += decoder.decode(chunk, { stream: true });
    }
    return value + decoder.decode();
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  }
}

async function fetchCopyBlob(target) {
  let response;
  try {
    response = await fetch(target, { credentials: "same-origin" });
  } catch (error) {
    throw exportError("EXPORT_REQUEST_FAILED", error instanceof Error ? error.message : String(error));
  }
  if (!response.ok) throw exportError("EXPORT_REQUEST_FAILED", `Plugin API returned ${response.status}`);
  const mimeType = (response.headers.get("content-type") ?? "").split(";", 1)[0].trim().toLowerCase();
  if (!EXPORT_MIME_TYPES.has(mimeType)) throw exportError("UNSUPPORTED_EXPORT_TYPE", `Plugin API returned unsupported type '${mimeType || "unknown"}'`);

  let value;
  try { value = await readCopyPayload(response); }
  catch (error) {
    if (error?.code === "EXPORT_TOO_LARGE") throw error;
    throw exportError("EXPORT_REQUEST_FAILED", error instanceof Error ? error.message : String(error));
  }
  return new Blob([value], { type: "text/plain" });
}

export function defineManifest(manifest) {
  return manifest;
}

export function defineBackend(activate) {
  return { activate };
}

export function healthResponse(state = "ready", details = {}) {
  return { state, ...details };
}

export function downloadableResponse(options) {
  if (arguments.length !== 1 || !options || typeof options !== "object" || Array.isArray(options)) {
    throw new TypeError("Download response requires { filenameBase, format, body }");
  }
  const { filenameBase, format, body } = options;
  if (typeof filenameBase !== "string" || !filenameBase.trim()) throw new TypeError("Download filenameBase must be a non-empty string");
  if (!EXPORT_FORMAT_SET.has(format)) throw new TypeError(`Unsupported download format '${String(format)}'`);
  if (!isStringBody(body)) throw new TypeError("Download body must be an iterable of strings");
  return { type: "infolens:download", filenameBase, format, body };
}

export async function downloadExport(route) {
  const target = workspaceApiUrl(route);
  const document = globalThis.document;
  if (!document || typeof document.createElement !== "function") throw exportError("EXPORT_REQUEST_FAILED", "Browser download APIs are unavailable");
  const anchor = document.createElement("a");
  anchor.href = target.toString();
  anchor.download = "";
  anchor.rel = "noopener";
  anchor.style.display = "none";
  document.body?.append(anchor);
  try {
    anchor.click();
  } catch (error) {
    throw exportError("EXPORT_REQUEST_FAILED", error instanceof Error ? error.message : String(error));
  } finally {
    anchor.remove();
  }
  return { initiated: true };
}

export async function copyDownloadable(route) {
  const target = workspaceApiUrl(route);
  const clipboard = globalThis.navigator?.clipboard;
  const ClipboardItemConstructor = globalThis.ClipboardItem;
  if (!clipboard || typeof clipboard.write !== "function" || typeof ClipboardItemConstructor !== "function" || typeof Blob !== "function") {
    throw exportError("CLIPBOARD_UNAVAILABLE", "Clipboard write is unavailable");
  }
  if (globalThis.navigator?.userActivation?.isActive !== true) throw exportError("CLIPBOARD_DENIED", "Clipboard write requires an explicit caller action");

  // Start Clipboard.write while the click's transient activation is still live;
  // ClipboardItem resolves the fetched text after the request completes.
  const payload = fetchCopyBlob(target);
  try {
    await clipboard.write([new ClipboardItemConstructor({ "text/plain": payload })]);
    await payload;
  } catch (error) {
    if (["EXPORT_REQUEST_FAILED", "EXPORT_TOO_LARGE", "UNSUPPORTED_EXPORT_TYPE"].includes(error?.code)) throw error;
    throw exportError("CLIPBOARD_DENIED", error instanceof Error ? error.message : String(error));
  }
  return { copied: true };
}

export function pluginHealthUrl(origin, pluginId) {
  return joinUrl(origin, `/plugins/${encodeURIComponent(pluginId)}/health`);
}

export function pluginWorkspaceUrl(origin, pluginId) {
  return joinUrl(origin, `/plugins/${encodeURIComponent(pluginId)}/workspace/`);
}

export function pluginApiUrl(origin, pluginId, route = "") {
  const suffix = route.replace(/^\/+/, "");
  return joinUrl(origin, `/plugins/${encodeURIComponent(pluginId)}/api/${suffix}`);
}

export function workspaceRuntimeConfig(location = globalThis.location) {
  const parameters = new URLSearchParams(location?.search ?? "");
  const pluginId = parameters.get("pluginId");
  const apiBaseUrl = parameters.get("apiBaseUrl");
  if (!pluginId || !apiBaseUrl) {
    throw new Error("Workspace runtime configuration requires pluginId and apiBaseUrl");
  }
  return { pluginId, apiBaseUrl };
}

export function workspaceTheme(location = globalThis.location) {
  const theme = new URLSearchParams(location?.search ?? "").get("theme");
  return theme === "dark" ? "dark" : "light";
}

export function observeWorkspaceTheme(listener, target = globalThis) {
  if (typeof listener !== "function") throw new TypeError("Theme listener must be a function");
  const handler = (event) => {
    if (event?.data?.type !== "infolens:theme" || !["light", "dark"].includes(event.data.theme)) return;
    listener(event.data.theme);
  };
  target.addEventListener("message", handler);
  return () => target.removeEventListener("message", handler);
}
