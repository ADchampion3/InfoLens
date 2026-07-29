import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertCircle, CheckCircle2, CircleOff, Copy, FolderPlus, LoaderCircle,
  Plug, Settings, Trash2, TriangleAlert, X,
} from "lucide-react";

type HostView = { kind: "plugin"; id: string } | { kind: "plugins" } | { kind: "settings" };
type Status = "loading" | "ready" | "error";

function previewOrigin() {
  return new URLSearchParams(window.location.search).get("runtimeOrigin");
}

async function getRuntimeInfo(): Promise<RuntimeInfo> {
  if (window.infolens) {
    const info = await window.infolens.getRuntimeInfo();
    if (info) return info;
  }
  const origin = previewOrigin();
  const response = await fetch(origin ? `${origin}/runtime/info` : "/runtime-info.json");
  if (!response.ok) throw new Error("Plugin services are unavailable.");
  return response.json();
}

async function runtimeRequest<T>(runtime: RuntimeInfo, route: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${runtime.origin}${route}`, {
    ...init,
    headers: { "content-type": "application/json", ...init?.headers },
  });
  const body = await response.json();
  if (!response.ok) throw Object.assign(new Error(body.error ?? "Operation failed"), { code: body.code });
  return body;
}

function available(plugin: RuntimePlugin) {
  return plugin.enabled && !["disabled", "failed", "unavailable", "cancelled"].includes(plugin.state);
}

function sourceInitial(plugin: RuntimePlugin) {
  if (plugin.id === "hn") return "Y";
  if (plugin.id === "github-trending") return "GH";
  return plugin.name.slice(0, 2);
}

function Lifecycle({ state }: { state: string }) {
  if (["refreshing", "queued", "starting"].includes(state)) return <LoaderCircle className="lifecycle spinner" aria-label={state} size={15} />;
  if (state === "failed") return <AlertCircle className="lifecycle danger" aria-label="Failed" size={15} />;
  if (state === "unavailable") return <CircleOff className="lifecycle danger" aria-label="Unavailable" size={15} />;
  if (state === "disabled") return <CircleOff className="lifecycle muted" aria-label="Disabled" size={15} />;
  return <span className="running-dot" aria-label="Running" />;
}

export function App() {
  const [status, setStatus] = useState<Status>("loading");
  const [message, setMessage] = useState("Starting plugin services...");
  const [runtime, setRuntime] = useState<RuntimeInfo>();
  const [view, setView] = useState<HostView>({ kind: "plugins" });
  const [managedKey, setManagedKey] = useState<string>();
  const [bridgeDialog, setBridgeDialog] = useState(false);
  const [bridgeStatus, setBridgeStatus] = useState<{ connected: boolean; affected: Array<{ id: string; name: string }> }>();
  const [runtimeRestarting, setRuntimeRestarting] = useState(false);
  const [removeKey, setRemoveKey] = useState<string>();
  const [toast, setToast] = useState<string>();
  const [systemDark, setSystemDark] = useState(() => window.matchMedia("(prefers-color-scheme: dark)").matches);
  const iframeRef = useRef<HTMLIFrameElement>(null);

  const refreshInfo = async () => {
    const info = await getRuntimeInfo();
    setRuntime(info);
    setStatus("ready");
    return info;
  };

  useEffect(() => {
    refreshInfo().then((info) => {
      const restored = info.plugins.find((plugin) => plugin.id === info.hostState.lastSelection && available(plugin));
      const selected = restored ?? info.plugins.find(available);
      setView(selected ? { kind: "plugin", id: selected.id } : { kind: "plugins" });
      setManagedKey(info.plugins[0]?.id ?? info.rejectedPlugins[0]?.package);
      if (info.plugins.some((plugin) => plugin.browserDependent)) {
        runtimeRequest<typeof bridgeStatus>(info, "/runtime/browser-status").then((result) => {
          setBridgeStatus(result);
          setBridgeDialog(true);
        }).catch(() => {});
      }
    }).catch((error: unknown) => {
      setMessage(error instanceof Error ? error.message : "Plugin services did not start.");
      setStatus("error");
    });
  }, []);

  useEffect(() => {
    if (status !== "ready") return;
    const timer = window.setInterval(() => refreshInfo().catch(() => setRuntimeRestarting(true)), 1_500);
    return () => window.clearInterval(timer);
  }, [status]);

  useEffect(() => window.infolens?.onRuntimeStatus((event) => {
    if (event.status === "running") {
      setRuntimeRestarting(false);
      refreshInfo().then(() => { if (iframeRef.current) iframeRef.current.src = iframeRef.current.src; }).catch(() => {});
    } else {
      setRuntimeRestarting(true);
      if (event.message) setMessage(event.message);
    }
  }), []);

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

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(undefined), 4500);
    return () => window.clearTimeout(timer);
  }, [toast]);

  useEffect(() => {
    const closeDialog = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (removeKey) setRemoveKey(undefined);
      else if (bridgeDialog) setBridgeDialog(false);
    };
    window.addEventListener("keydown", closeDialog);
    return () => window.removeEventListener("keydown", closeDialog);
  }, [bridgeDialog, removeKey]);

  const selected = useMemo(
    () => view.kind === "plugin" ? runtime?.plugins.find((plugin) => plugin.id === view.id) : undefined,
    [runtime, view],
  );
  const managed = runtime?.plugins.find((plugin) => plugin.id === managedKey);
  const rejected = runtime?.rejectedPlugins.find((plugin) => plugin.package === managedKey);
  const workspaceSrc = selected
    ? `${selected.workspaceUrl}?pluginId=${encodeURIComponent(selected.id)}&apiBaseUrl=${encodeURIComponent(selected.apiBaseUrl)}&theme=${actualTheme}`
    : undefined;

  const selectPlugin = async (plugin: RuntimePlugin) => {
    setView({ kind: "plugin", id: plugin.id });
    if (available(plugin) && runtime) {
      await runtimeRequest(runtime, "/runtime/host-state", { method: "PATCH", body: JSON.stringify({ lastSelection: plugin.id }) }).catch(() => {});
    }
  };

  const mutate = async (action: () => Promise<unknown>, success: string) => {
    try { await action(); await refreshInfo(); setToast(success); }
    catch (error) { setToast(error instanceof Error ? error.message : "Operation failed"); }
  };

  const install = async () => {
    if (!runtime) return;
    const sourcePath = window.infolens ? await window.infolens.selectPluginFolder() : window.prompt("Plugin folder path");
    if (!sourcePath) return;
    await mutate(async () => {
      const result = await runtimeRequest<{ pluginId: string }>(runtime, "/runtime/plugins/install", { method: "POST", body: JSON.stringify({ sourcePath }) });
      setManagedKey(result.pluginId);
      setView({ kind: "plugins" });
    }, "Plugin installed and enabled");
  };

  const changeTheme = async (nextTheme: ThemePreference) => {
    if (!runtime) return;
    const hostState = await runtimeRequest<HostState>(runtime, "/runtime/host-state", { method: "PATCH", body: JSON.stringify({ theme: nextTheme }) });
    setRuntime({ ...runtime, hostState });
  };

  const checkBridge = async () => {
    if (!runtime) return;
    setBridgeStatus(await runtimeRequest(runtime, "/runtime/browser-status"));
  };

  return (
    <div className="app-shell">
      <aside className="sidebar" aria-label="Infolens navigation">
        <header className="brand"><span className="brand-mark" aria-hidden="true">IL</span><span>Infolens</span></header>
        <nav className="plugin-nav" aria-label="Plugins">
          <div className="nav-caption">Sources</div>
          {runtime?.plugins.map((plugin) => (
            <button className={`nav-item ${view.kind === "plugin" && plugin.id === view.id ? "is-selected" : ""}`} key={plugin.id} onClick={() => selectPlugin(plugin)} type="button">
              <span className={`source-icon source-icon--${plugin.id}`} aria-hidden="true">{sourceInitial(plugin)}</span>
              <span className="nav-label">{plugin.name}</span>
              {plugin.badge ? <span className="nav-badge">{plugin.badge}</span> : <span />}
              <Lifecycle state={plugin.state} />
            </button>
          ))}
        </nav>
        <nav className="utility-nav" aria-label="Application">
          <button className={`nav-item utility ${view.kind === "plugins" ? "is-selected" : ""}`} onClick={() => setView({ kind: "plugins" })} type="button"><span className="utility-icon"><Plug size={17} /></span><span className="nav-label">Plugins</span></button>
          <button className={`nav-item utility ${view.kind === "settings" ? "is-selected" : ""}`} onClick={() => setView({ kind: "settings" })} type="button"><span className="utility-icon"><Settings size={17} /></span><span className="nav-label">Settings</span></button>
        </nav>
      </aside>

      <main className="main-area">
        {runtimeRestarting && <div className="restart-bar" role="status"><LoaderCircle className="spinner" size={15} /> Restarting plugin services...</div>}
        {status === "loading" && <div className="system-state" role="status"><LoaderCircle className="spinner" size={24} /><p>{message}</p></div>}
        {status === "error" && <div className="system-state system-state--error" role="alert"><h1>Plugin services unavailable</h1><p>{message}</p></div>}
        {status === "ready" && view.kind === "plugin" && selected && selected.state === "disabled" && (
          <div className="system-state"><CircleOff size={28} /><h1>{selected.name} is disabled</h1><button className="primary-button" onClick={() => runtime && mutate(() => runtimeRequest(runtime, `/runtime/plugins/${selected.id}/enabled`, { method: "POST", body: JSON.stringify({ enabled: true }) }), `${selected.name} enabled`)}>Enable in Plugins</button></div>
        )}
        {status === "ready" && view.kind === "plugin" && workspaceSrc && selected?.state !== "disabled" && <iframe ref={iframeRef} className="workspace-frame" src={workspaceSrc} title={`${selected?.name ?? "Plugin"} workspace`} />}
        {status === "ready" && view.kind === "plugins" && runtime && (
          <section className="host-page plugin-manager">
            <header className="page-header"><div><h1>Plugins</h1><p>Installed packages and local diagnostics</p></div><button className="primary-button" onClick={install}><FolderPlus size={17} />Install plugin</button></header>
            <div className="manager-layout">
              <div className="package-list" role="listbox" aria-label="Installed plugins">
                {runtime.plugins.map((plugin) => <button key={plugin.id} className={managedKey === plugin.id ? "package-row selected" : "package-row"} onClick={() => setManagedKey(plugin.id)}><span className={`source-icon source-icon--${plugin.id}`}>{sourceInitial(plugin)}</span><span><strong>{plugin.name}</strong><small>{plugin.version}</small></span><Lifecycle state={plugin.state} /></button>)}
                {runtime.rejectedPlugins.map((plugin) => <button key={plugin.package} className={managedKey === plugin.package ? "package-row selected" : "package-row"} onClick={() => setManagedKey(plugin.package)}><span className="source-icon"><TriangleAlert size={15} /></span><span><strong>{plugin.name ?? plugin.package}</strong><small>Incompatible</small></span><AlertCircle className="danger" size={15} /></button>)}
              </div>
              <div className="package-detail">
                {managed && <><div className="detail-title"><span><h2>{managed.name}</h2><p>{managed.id} · {managed.version}</p></span><label className="toggle"><input type="checkbox" checked={managed.enabled} onChange={(event) => mutate(() => runtimeRequest(runtime, `/runtime/plugins/${managed.id}/enabled`, { method: "POST", body: JSON.stringify({ enabled: event.target.checked }) }), event.target.checked ? `${managed.name} enabled` : `${managed.name} disabled`)} /><span />Enabled</label></div><dl><dt>State</dt><dd>{managed.state}</dd><dt>Package</dt><dd className="path-value">{managed.packagePath}</dd><dt>Last successful refresh</dt><dd>{managed.statusSnapshot?.lastSuccessfulRefreshAt ?? "Not yet recorded"}</dd>{managed.statusSnapshot?.failure && <><dt>Latest failure</dt><dd>{managed.statusSnapshot.failure.code}: {managed.statusSnapshot.failure.message}</dd></>}</dl><div className="detail-actions"><button onClick={() => mutate(async () => { const value = await runtimeRequest<{ diagnostics: string }>(runtime, `/runtime/plugins/${managed.id}/diagnostics`); if (window.infolens) await window.infolens.copyText(value.diagnostics); else await navigator.clipboard.writeText(value.diagnostics); }, "Diagnostics copied")}><Copy size={16} />Copy diagnostics</button><button className="danger-button" onClick={() => setRemoveKey(managed.id)}><Trash2 size={16} />Remove plugin</button></div></>}
                {rejected && <><div className="detail-title"><span><h2>{rejected.name ?? rejected.package}</h2><p>{rejected.version ?? "Invalid package"}</p></span><span className="incompatible">Incompatible</span></div><div className="failure-panel"><strong>{rejected.code}</strong><p>{rejected.message}</p></div><dl><dt>Package</dt><dd className="path-value">{rejected.packagePath}</dd></dl><div className="detail-actions"><button className="danger-button" onClick={() => setRemoveKey(rejected.package)}><Trash2 size={16} />Remove package</button></div></>}
              </div>
            </div>
          </section>
        )}
        {status === "ready" && view.kind === "settings" && (
          <section className="host-page"><header className="page-header"><div><h1>Settings</h1><p>Application preferences</p></div></header><div className="settings-section"><h2>Appearance</h2><div className="setting-row"><span><strong>Theme</strong><small>Applied to the host and open plugin workspace</small></span><div className="segmented" aria-label="Theme">{(["system", "light", "dark"] as ThemePreference[]).map((item) => <button aria-pressed={theme === item} className={theme === item ? "active" : ""} key={item} onClick={() => changeTheme(item)}>{item[0].toUpperCase() + item.slice(1)}</button>)}</div></div></div></section>
        )}
      </main>

      {bridgeDialog && bridgeStatus && <div className="dialog-scrim"><div className="dialog" role="dialog" aria-modal="true" aria-labelledby="bridge-title"><button className="dialog-close" aria-label="Close" onClick={() => setBridgeDialog(false)}><X size={17} /></button>{bridgeStatus.connected ? <CheckCircle2 className="dialog-symbol success" size={26} /> : <TriangleAlert className="dialog-symbol warning" size={26} />}<h2 id="bridge-title">Browser connection</h2><p>{bridgeStatus.connected ? "Browser Bridge is connected." : "Connect Browser Bridge to refresh browser-based plugins."}</p><small>Affects {bridgeStatus.affected.map((plugin) => plugin.name).join(" and ")} only.</small><div className="dialog-actions"><button onClick={() => setBridgeDialog(false)}>Continue</button><button className="primary-button" onClick={checkBridge}>Check again</button></div></div></div>}
      {removeKey && runtime && <div className="dialog-scrim"><div className="dialog" role="dialog" aria-modal="true" aria-labelledby="remove-title"><TriangleAlert className="dialog-symbol danger" size={26} /><h2 id="remove-title">Remove plugin?</h2><p>The plugin package, retained content, settings, and logs will be permanently deleted.</p><div className="dialog-actions"><button onClick={() => setRemoveKey(undefined)}>Cancel</button><button className="danger-button" onClick={() => mutate(async () => { if (window.infolens) await window.infolens.removePlugin(removeKey); else await runtimeRequest(runtime, `/runtime/plugins/${encodeURIComponent(removeKey)}/remove`, { method: "DELETE" }); setRemoveKey(undefined); setManagedKey(undefined); }, "Plugin removed")}>Remove plugin</button></div></div></div>}
      {toast && <div className="toast" role="status">{toast}</div>}
    </div>
  );
}
