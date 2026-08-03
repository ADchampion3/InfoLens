function joinUrl(origin, path) {
  return new URL(path, `${origin.replace(/\/$/, "")}/`).toString();
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

export function downloadableResponse(filename, body) {
  if (typeof filename !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.json$/.test(filename)) {
    throw new TypeError("Download filename must be a safe JSON filename");
  }
  if (!body || (typeof body[Symbol.iterator] !== "function" && typeof body[Symbol.asyncIterator] !== "function")) {
    throw new TypeError("Download body must be iterable");
  }
  return { type: "infolens:download", filename, body };
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
