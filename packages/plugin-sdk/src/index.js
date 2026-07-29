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
