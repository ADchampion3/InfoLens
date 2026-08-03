import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertCircle, CheckCircle2, CircleOff, Copy, Download, FolderPlus, LoaderCircle,
  Plug, ScrollText, Settings, Trash2, TriangleAlert, X,
} from "lucide-react";

type HostView = { kind: "plugin"; id: string } | { kind: "plugins" } | { kind: "logs" } | { kind: "settings" };
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

const INITIAL_LOG_FILTERS: LogFilters = { sources: [], levels: ["info", "warn", "error"], from: "", to: "", keyword: "", operationId: "" };
const ERROR_GUIDANCE: Record<string, { explanation: string; action: string }> = {
  INCOMPATIBLE_CONTRACT: { explanation: "This plugin uses a package contract that this Host does not support.", action: "Install a compatible plugin version." },
  INCOMPATIBLE_HOST: { explanation: "This plugin requires a newer Infolens Host.", action: "Update Infolens, then try the plugin again." },
  PLUGIN_ERROR: { explanation: "The plugin could not complete the operation.", action: "Review the redacted message, then retry or restart the plugin." },
  RUNTIME_RESTART_REQUIRED: { explanation: "Plugin Runtime could not finish the lifecycle operation safely.", action: "Allow Plugin Runtime to restart, then retry." },
};

function LogsView({ filters, setFilters, focusEntryId, onNotice }: { filters: LogFilters; setFilters: (filters: LogFilters) => void; focusEntryId?: string; onNotice: (message: string) => void }) {
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [cursor, setCursor] = useState<string | null>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [expanded, setExpanded] = useState<string>();
  const [pendingCount, setPendingCount] = useState(0);
  const [liveError, setLiveError] = useState<string>();
  const [sharing, setSharing] = useState(false);
  const tableRef = useRef<HTMLDivElement>(null);
  const entriesRef = useRef<LogEntry[]>([]);
  const pendingIdsRef = useRef(new Set<string>());
  const atNewestRef = useRef(true);

  const requestFilters = useMemo(() => ({
    sources: filters.sources,
    levels: filters.levels,
    from: filters.from ? new Date(filters.from).toISOString() : "",
    to: filters.to ? new Date(filters.to).toISOString() : "",
    keyword: filters.keyword,
    operationId: filters.operationId,
  }), [filters]);

  useEffect(() => { entriesRef.current = entries; }, [entries]);
  useEffect(() => {
    if (!focusEntryId || !entries.some((entry) => entry.id === focusEntryId)) return;
    setExpanded(focusEntryId);
    window.requestAnimationFrame(() => document.querySelector(`[data-log-id="${CSS.escape(focusEntryId)}"]`)?.scrollIntoView({ block: "center" }));
  }, [entries, focusEntryId]);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(undefined);
    if (!window.infolens) {
      setEntries([]);
      setCursor(null);
      setLoading(false);
      return;
    }
    pendingIdsRef.current.clear();
    setPendingCount(0);
    atNewestRef.current = true;
    window.infolens.queryLogs({ filters: requestFilters }).then((page) => {
      if (!active) return;
      setEntries(page.entries);
      setCursor(page.nextCursor);
    }).catch((reason: unknown) => {
      if (active) setError(reason instanceof Error ? reason.message : "Logs could not be loaded.");
    }).finally(() => { if (active) setLoading(false); });

    const timer = window.setInterval(async () => {
      try {
        const page = await window.infolens!.queryLogs({ filters: requestFilters });
        if (!active) return;
        setLiveError(undefined);
        const visibleIds = new Set(entriesRef.current.map((entry) => entry.id));
        const unseen = page.entries.filter((entry) => !visibleIds.has(entry.id));
        if (!unseen.length) return;
        const atNewest = (tableRef.current?.scrollTop ?? 0) <= 8;
        atNewestRef.current = atNewest;
        if (atNewest) {
          setEntries(page.entries);
          setCursor(page.nextCursor);
          pendingIdsRef.current.clear();
          setPendingCount(0);
        } else {
          for (const entry of unseen) pendingIdsRef.current.add(entry.id);
          setPendingCount(pendingIdsRef.current.size);
        }
      } catch (reason) {
        if (active) setLiveError(reason instanceof Error ? reason.message : "Live updates are temporarily unavailable.");
      }
    }, 2_000);
    return () => { active = false; window.clearInterval(timer); };
  }, [requestFilters]);

  const showNewest = async () => {
    if (!window.infolens) return;
    try {
      const page = await window.infolens.queryLogs({ filters: requestFilters });
      setEntries(page.entries);
      setCursor(page.nextCursor);
      pendingIdsRef.current.clear();
      setPendingCount(0);
      atNewestRef.current = true;
      tableRef.current?.scrollTo({ top: 0 });
      setLiveError(undefined);
    } catch (reason) {
      setLiveError(reason instanceof Error ? reason.message : "Newest logs could not be loaded.");
    }
  };

  const loadOlder = async () => {
    if (!window.infolens || !cursor) return;
    setLoadingOlder(true);
    setError(undefined);
    try {
      const page = await window.infolens.queryLogs({ filters: requestFilters, cursor });
      setEntries((current) => [...current, ...page.entries]);
      setCursor(page.nextCursor);
    } catch (reason) {
      setLiveError(reason instanceof Error ? reason.message : "Older logs could not be loaded.");
    } finally { setLoadingOlder(false); }
  };

  const updateLevel = (level: LogLevel, checked: boolean) => setFilters({
    ...filters,
    levels: checked ? [...filters.levels, level] : filters.levels.filter((item) => item !== level),
  });
  const share = async (action: () => Promise<{ count: number; canceled?: boolean }>, success: (count: number) => string) => {
    setSharing(true);
    try {
      const result = await action();
      if (!result.canceled) onNotice(success(result.count));
    } catch (reason) {
      onNotice(reason instanceof Error ? reason.message : "Logs could not be shared.");
    } finally { setSharing(false); }
  };
  const sources = [...new Set(["host", "runtime", ...filters.sources, ...entries.map((entry) => entry.source)])].sort();

  return (
    <section className="host-page logs-page">
      <header className="page-header"><div><h1>Logs</h1><p>Operational evidence from this device</p></div></header>
      <div className="logs-toolbar" aria-label="Log filters">
        <label>Source<select aria-label="Source" value={filters.sources[0] ?? ""} onChange={(event) => setFilters({ ...filters, sources: event.target.value ? [event.target.value] : [] })}><option value="">All sources</option>{sources.map((source) => <option value={source} key={source}>{source}</option>)}</select></label>
        <fieldset><legend>Severity</legend>{(["debug", "info", "warn", "error"] as LogLevel[]).map((level) => <label key={level}><input type="checkbox" checked={filters.levels.includes(level)} onChange={(event) => updateLevel(level, event.target.checked)} />{level === "warn" ? "Warning" : level[0].toUpperCase() + level.slice(1)}</label>)}</fieldset>
        <label>From<input aria-label="From time" type="datetime-local" value={filters.from} onChange={(event) => setFilters({ ...filters, from: event.target.value })} /></label>
        <label>To<input aria-label="To time" type="datetime-local" value={filters.to} onChange={(event) => setFilters({ ...filters, to: event.target.value })} /></label>
        <label className="log-search">Keyword<input aria-label="Keyword" type="search" value={filters.keyword} onChange={(event) => setFilters({ ...filters, keyword: event.target.value })} placeholder="Search messages" /></label>
        <label className="operation-search">Operation ID<input aria-label="Operation ID" value={filters.operationId} onChange={(event) => setFilters({ ...filters, operationId: event.target.value })} /></label>
        <div className="log-share-actions"><button type="button" disabled={sharing || !window.infolens} onClick={() => share(() => window.infolens!.copyFilteredLogs(requestFilters), (count) => `${count} filtered log entries copied`)}><Copy size={15} />Copy filtered</button><button type="button" disabled={sharing || !window.infolens} onClick={() => share(() => window.infolens!.exportFilteredLogs(requestFilters), (count) => `${count} log entries exported`)}><Download size={15} />Export JSONL</button></div>
      </div>
      {pendingCount > 0 && <button className="new-logs-button" type="button" aria-label={`${pendingCount} new log ${pendingCount === 1 ? "entry" : "entries"}; move to newest`} onClick={showNewest}>{pendingCount} new {pendingCount === 1 ? "entry" : "entries"}</button>}
      {liveError && <div className="live-log-status" role="status">Live updates paused: {liveError}</div>}
      {error && <div className="logs-state" role="alert"><AlertCircle size={20} /><strong>Logs unavailable</strong><span>{error}</span></div>}
      {!error && loading && <div className="logs-state" role="status"><LoaderCircle className="spinner" size={20} /><span>Loading logs...</span></div>}
      {!error && !loading && entries.length === 0 && <div className="logs-state"><ScrollText size={20} /><strong>No logs match these filters</strong></div>}
      {!loading && entries.length > 0 && (
        <div className="log-table" aria-label="Operational logs" ref={tableRef} onScroll={(event) => { atNewestRef.current = event.currentTarget.scrollTop <= 8; }}>
          <div className="log-row log-header" aria-hidden="true">
            <span>Time</span><span>Severity</span><span>Source</span><span>Message</span>
          </div>
          {entries.map((entry) => (
            <div className="log-entry" key={entry.id} data-log-id={entry.id}>
              <button className="log-row" type="button" aria-expanded={expanded === entry.id} onClick={() => setExpanded(expanded === entry.id ? undefined : entry.id)}>
                <time dateTime={entry.timestamp} title={entry.timestamp}>{new Date(entry.timestamp).toLocaleTimeString()}</time>
                <span className={`log-level log-level--${entry.level}`}>{entry.level}</span>
                <span className="log-source">{entry.source}</span>
                <span className="log-message">{entry.message}</span>
              </button>
              {expanded === entry.id && <div className="log-details"><dl><dt>ID</dt><dd>{entry.id}</dd><dt>Canonical timestamp</dt><dd>{entry.timestamp}</dd><dt>Severity</dt><dd>{entry.level}</dd><dt>Source</dt><dd>{entry.source}</dd><dt>Session ID</dt><dd>{entry.sessionId}</dd>{entry.code && <><dt>Code</dt><dd>{entry.code}</dd></>}{entry.operationId && <><dt>Operation ID</dt><dd className="operation-value"><span>{entry.operationId}</span><button type="button" onClick={() => setFilters({ ...filters, operationId: entry.operationId! })}>Filter this operation</button></dd></>}<dt>Message</dt><dd>{entry.message}</dd></dl><div className="log-entry-actions"><button type="button" disabled={sharing || !window.infolens} onClick={() => share(() => window.infolens!.copyLogEntry(entry.id), () => "Log entry copied")}><Copy size={15} />Copy entry</button></div>{entry.code && ERROR_GUIDANCE[entry.code] && <div className="log-guidance"><strong>{ERROR_GUIDANCE[entry.code].explanation}</strong><span>{ERROR_GUIDANCE[entry.code].action}</span></div>}</div>}
            </div>
          ))}
          <div className="log-history-state">{cursor ? <button type="button" onClick={loadOlder} disabled={loadingOlder}>{loadingOlder ? "Loading..." : "Load older"}</button> : <span>End of retained history</span>}</div>
        </div>
      )}
    </section>
  );
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
  const [logFilters, setLogFilters] = useState<LogFilters>(INITIAL_LOG_FILTERS);
  const [focusedLogId, setFocusedLogId] = useState<string>();
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

  const openFailureLogs = (pluginId: string, failure: NonNullable<StatusSnapshot["failure"]>) => {
    const timestamp = failure.timestamp ? new Date(failure.timestamp) : undefined;
    const localValue = (value: Date) => new Date(value.getTime() - value.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
    setLogFilters({
      sources: [`plugin:${pluginId}`],
      levels: ["error"],
      from: timestamp ? localValue(new Date(timestamp.getTime() - 60_000)) : "",
      to: timestamp ? localValue(new Date(timestamp.getTime() + 60_000)) : "",
      keyword: "",
      operationId: failure.operationId ?? "",
    });
    setFocusedLogId(failure.logId);
    setView({ kind: "logs" });
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
          <button className={`nav-item utility ${view.kind === "logs" ? "is-selected" : ""}`} onClick={() => setView({ kind: "logs" })} type="button"><span className="utility-icon"><ScrollText size={17} /></span><span className="nav-label">Logs</span></button>
          <button className={`nav-item utility ${view.kind === "settings" ? "is-selected" : ""}`} onClick={() => setView({ kind: "settings" })} type="button"><span className="utility-icon"><Settings size={17} /></span><span className="nav-label">Settings</span></button>
        </nav>
      </aside>

      <main className="main-area">
        {runtimeRestarting && <div className="restart-bar" role="status"><LoaderCircle className="spinner" size={15} /> Restarting plugin services...</div>}
        {view.kind === "logs" && <LogsView filters={logFilters} setFilters={setLogFilters} focusEntryId={focusedLogId} onNotice={setToast} />}
        {view.kind !== "logs" && status === "loading" && <div className="system-state" role="status"><LoaderCircle className="spinner" size={24} /><p>{message}</p></div>}
        {view.kind !== "logs" && status === "error" && <div className="system-state system-state--error" role="alert"><h1>Plugin services unavailable</h1><p>{message}</p></div>}
        {status === "ready" && view.kind === "plugin" && selected && selected.state === "disabled" && (
          <div className="system-state"><CircleOff size={28} /><h1>{selected.name} is disabled</h1><button className="primary-button" onClick={() => runtime && mutate(() => runtimeRequest(runtime, `/runtime/plugins/${selected.id}/enabled`, { method: "POST", body: JSON.stringify({ enabled: true }) }), `${selected.name} enabled`)}>Enable in Plugins</button></div>
        )}
        {status === "ready" && view.kind === "plugin" && workspaceSrc && selected?.state !== "disabled" && <iframe ref={iframeRef} className="workspace-frame" src={workspaceSrc} title={`${selected?.name ?? "Plugin"} workspace`} allow="clipboard-write" />}
        {status === "ready" && view.kind === "plugins" && runtime && (
          <section className="host-page plugin-manager">
            <header className="page-header"><div><h1>Plugins</h1><p>Installed packages and local diagnostics</p></div><button className="primary-button" onClick={install}><FolderPlus size={17} />Install plugin</button></header>
            <div className="manager-layout">
              <div className="package-list" role="listbox" aria-label="Installed plugins">
                {runtime.plugins.map((plugin) => <button key={plugin.id} className={managedKey === plugin.id ? "package-row selected" : "package-row"} onClick={() => setManagedKey(plugin.id)}><span className={`source-icon source-icon--${plugin.id}`}>{sourceInitial(plugin)}</span><span><strong>{plugin.name}</strong><small>{plugin.version}</small></span><Lifecycle state={plugin.state} /></button>)}
                {runtime.rejectedPlugins.map((plugin) => <button key={plugin.package} className={managedKey === plugin.package ? "package-row selected" : "package-row"} onClick={() => setManagedKey(plugin.package)}><span className="source-icon"><TriangleAlert size={15} /></span><span><strong>{plugin.name ?? plugin.package}</strong><small>Incompatible</small></span><AlertCircle className="danger" size={15} /></button>)}
              </div>
              <div className="package-detail">
                {managed && <><div className="detail-title"><span><h2>{managed.name}</h2><p>{managed.id} · {managed.version}</p></span><label className="toggle"><input type="checkbox" checked={managed.enabled} onChange={(event) => mutate(() => runtimeRequest(runtime, `/runtime/plugins/${managed.id}/enabled`, { method: "POST", body: JSON.stringify({ enabled: event.target.checked }) }), event.target.checked ? `${managed.name} enabled` : `${managed.name} disabled`)} /><span />Enabled</label></div><dl><dt>State</dt><dd>{managed.state}</dd><dt>Package</dt><dd className="path-value">{managed.packagePath}</dd><dt>Last successful refresh</dt><dd>{managed.statusSnapshot?.lastSuccessfulRefreshAt ?? "Not yet recorded"}</dd>{managed.statusSnapshot?.failure && <><dt>Latest failure</dt><dd className="failure-summary"><span>{managed.statusSnapshot.failure.code}: {managed.statusSnapshot.failure.message}</span><button type="button" onClick={() => openFailureLogs(managed.id, managed.statusSnapshot!.failure!)}>View matching logs</button></dd></>}</dl><div className="detail-actions"><button onClick={() => mutate(async () => { const value = await runtimeRequest<{ diagnostics: string }>(runtime, `/runtime/plugins/${managed.id}/diagnostics`); if (window.infolens) await window.infolens.copyText(value.diagnostics); else await navigator.clipboard.writeText(value.diagnostics); }, "Diagnostics copied")}><Copy size={16} />Copy diagnostics</button><button className="danger-button" onClick={() => setRemoveKey(managed.id)}><Trash2 size={16} />Remove plugin</button></div></>}
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
