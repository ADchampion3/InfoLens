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
