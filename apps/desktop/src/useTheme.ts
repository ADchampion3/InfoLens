import { useEffect, useState } from "react";
import type { RefObject } from "react";
import { runtimeRequest } from "./runtime-api";
import type { HostView } from "./host-view";

/**
 * Theme source of truth for the host: resolves the stored preference against
 * the OS setting, applies [data-theme] to <html>, mirrors it into the open
 * plugin workspace iframe, and persists changes through host state.
 */
export function useTheme(
  runtime: RuntimeInfo | undefined,
  onRuntimeChange: (next: RuntimeInfo) => void,
  iframeRef: RefObject<HTMLIFrameElement | null>,
  view: HostView,
) {
  const [systemDark, setSystemDark] = useState(() => window.matchMedia("(prefers-color-scheme: dark)").matches);
  const theme = runtime?.hostState.theme ?? "system";
  const actualTheme = theme === "system" ? (systemDark ? "dark" : "light") : theme;

  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const update = () => setSystemDark(media.matches);
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = actualTheme;
    iframeRef.current?.contentWindow?.postMessage({ type: "infolens:theme", theme: actualTheme }, "*");
  }, [actualTheme, view]);

  const changeTheme = async (nextTheme: ThemePreference) => {
    if (!runtime) return;
    const hostState = await runtimeRequest<HostState>(runtime, "/api/v1/host/state", { method: "PATCH", body: JSON.stringify({ theme: nextTheme }) });
    onRuntimeChange({ ...runtime, hostState });
  };

  return { theme, actualTheme, changeTheme };
}
