import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertCircle, CheckCircle2, CircleOff, Copy, Download, ExternalLink, FileText, FolderPlus, ListChecks,
  LoaderCircle, Plug, RefreshCw, RotateCcw, ScrollText, Settings, Trash2, TriangleAlert, X,
} from "lucide-react";
import {
  batchCompletionNotice, exactLocalTime, freshnessLabel, hasExecutableSelection, localDayKey,
  selectAllEligible, selectNotRefreshedToday, selectionEmptyState, targetEligibility,
} from "./batch-refresh";
import {
  createDailySummaryPreview, dailySummaryDeliveryDecision,
  dailySummarySourceMetadata, defaultDailySummarySelection, isDailySummaryPreviewCurrent, isDailySummarySelectable, preserveDailySummarySelection,
  toggleDailySummarySelection,
} from "./daily-summary";
import type { DailySummaryAggregate, DailySummaryPreview } from "./daily-summary";

type HostView = { kind: "plugin"; id: string } | { kind: "plugins" } | { kind: "logs" } | { kind: "settings" } | { kind: "batch" } | { kind: "daily-summary" };
type Status = "loading" | "ready" | "error";

function previewOrigin() {
  return new URLSearchParams(window.location.search).get("runtimeOrigin");
}

async function getRuntimeInfo(): Promise<RuntimeInfo> {
  if (window.infolens) {
    const info = await window.infolens.getRuntimeInfo();
    if (info) return info;
    throw new Error("Plugin services are unavailable.");
  }
  const origin = previewOrigin();
  const response = await fetch(origin ? `${origin}/runtime/info` : "/runtime-info.json");
  const body = await readJsonResponse<RuntimeInfo>(response, "Plugin services are unavailable.");
  if (!response.ok) throw new Error("Plugin services are unavailable.");
  return body;
}

async function readJsonResponse<T>(response: Response, invalidResponseMessage: string): Promise<T> {
  const text = await response.text();
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(response.ok ? "Plugin services returned invalid JSON." : invalidResponseMessage);
  }
}

async function runtimeRequest<T>(runtime: RuntimeInfo, route: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${runtime.origin}${route}`, {
    ...init,
    headers: { "content-type": "application/json", ...init?.headers },
  });
  const body = await readJsonResponse<{ error?: string; code?: string } & T>(response, "Plugin services are unavailable.");
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

const INITIAL_LOG_FILTERS: LogFilters = { sources: [], levels: ["info", "warn", "error"], from: "", to: "", keyword: "", operationId: "", batchId: "" };
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
    batchId: filters.batchId,
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
        <label className="operation-search">Batch ID<input aria-label="Batch ID" value={filters.batchId} onChange={(event) => setFilters({ ...filters, batchId: event.target.value })} /></label>
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
              {expanded === entry.id && <div className="log-details"><dl><dt>ID</dt><dd>{entry.id}</dd><dt>Canonical timestamp</dt><dd>{entry.timestamp}</dd><dt>Severity</dt><dd>{entry.level}</dd><dt>Source</dt><dd>{entry.source}</dd><dt>Session ID</dt><dd>{entry.sessionId}</dd>{entry.batchId && <><dt>Batch ID</dt><dd className="operation-value"><span>{entry.batchId}</span><button type="button" onClick={() => setFilters({ ...filters, batchId: entry.batchId! })}>Filter this Batch</button></dd></>}{entry.code && <><dt>Code</dt><dd>{entry.code}</dd></>}{entry.operationId && <><dt>Operation ID</dt><dd className="operation-value"><span>{entry.operationId}</span><button type="button" onClick={() => setFilters({ ...filters, operationId: entry.operationId! })}>Filter this operation</button></dd></>}<dt>Message</dt><dd>{entry.message}</dd></dl><div className="log-entry-actions"><button type="button" disabled={sharing || !window.infolens} onClick={() => share(() => window.infolens!.copyLogEntry(entry.id), () => "Log entry copied")}><Copy size={15} />Copy entry</button></div>{entry.code && ERROR_GUIDANCE[entry.code] && <div className="log-guidance"><strong>{ERROR_GUIDANCE[entry.code].explanation}</strong><span>{ERROR_GUIDANCE[entry.code].action}</span></div>}</div>}
            </div>
          ))}
          <div className="log-history-state">{cursor ? <button type="button" onClick={loadOlder} disabled={loadingOlder}>{loadingOlder ? "Loading..." : "Load older"}</button> : <span>End of retained history</span>}</div>
        </div>
      )}
    </section>
  );
}

function batchTerminal(batch?: BatchSummary) {
  return Boolean(batch && ["succeeded", "partial", "failed", "skipped", "interrupted"].includes(batch.status));
}

function batchStatusLabel(status: string) {
  return ({ queued: "Queued", running: "Refreshing", succeeded: "Completed", partial: "Partially completed", failed: "Failed", skipped: "Skipped", interrupted: "Interrupted" } as Record<string, string>)[status] ?? status;
}

function itemStatusLabel(status: BatchItemState) {
  return ({ queued: "Queued", running: "Refreshing", succeeded: "Succeeded", failed: "Failed", skipped: "Skipped", interrupted: "Interrupted" } as Record<BatchItemState, string>)[status];
}

function DailySummaryView({
  runtime,
  onOpenBatch,
  onNotice,
  selectedPluginIds,
  onSelectionChange,
}: {
  runtime: RuntimeInfo;
  onOpenBatch: () => void;
  onNotice: (message: string) => void;
  selectedPluginIds?: Set<string>;
  onSelectionChange: (selected: Set<string>) => void;
}) {
  const [aggregate, setAggregate] = useState<DailySummaryAggregate>();
  const [preview, setPreview] = useState<DailySummaryPreview>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [privacyKey, setPrivacyKey] = useState<string>();
  const [privacySources, setPrivacySources] = useState<string[]>([]);
  const [privacyMode, setPrivacyMode] = useState<"copy" | "download">();
  const selection = selectedPluginIds ?? new Set<string>();
  const runtimeOrigin = runtime.origin;

  const applyAggregate = (next: DailySummaryAggregate, nextSelection: Set<string>) => {
    setAggregate(next);
    onSelectionChange(nextSelection);
    setPreview(undefined);
    setPrivacyKey(undefined);
    setPrivacyMode(undefined);
    setPrivacySources([]);
  };

  const readAggregate = async () => {
    setLoading(true);
    setError(undefined);
    try {
      const next = await runtimeRequest<DailySummaryAggregate>(runtime, "/runtime/daily-summary");
      const nextSelection = selectedPluginIds === undefined ? defaultDailySummarySelection(next) : preserveDailySummarySelection(next, selectedPluginIds);
      applyAggregate(next, nextSelection);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Daily Summary could not be loaded.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void readAggregate(); }, [runtimeOrigin]);

  const selectionChanged = (pluginId: string) => {
    if (!aggregate) return;
    onSelectionChange(toggleDailySummarySelection(aggregate, selection, pluginId));
    setPreview(undefined);
    setPrivacyKey(undefined);
    setPrivacyMode(undefined);
    setPrivacySources([]);
  };

  const generatePreview = async () => {
    if (!aggregate || !selection.size) {
      onNotice("Select at least one source before generating a preview.");
      return;
    }
    setLoading(true);
    setError(undefined);
    try {
      const next = await runtimeRequest<DailySummaryAggregate>(runtime, "/runtime/daily-summary");
      const nextSelection = preserveDailySummarySelection(next, selection);
      if (!nextSelection.size) {
        applyAggregate(next, nextSelection);
        onNotice("Select at least one source before generating a preview.");
        return;
      }
      setAggregate(next);
      onSelectionChange(nextSelection);
      const nextPreview = createDailySummaryPreview(next, nextSelection);
      setPreview(nextPreview);
      setPrivacyKey(undefined);
      setPrivacyMode(undefined);
      setPrivacySources([]);
    } catch (reason) {
      onNotice(reason instanceof Error ? reason.message : "Daily Summary preview could not be generated.");
    } finally {
      setLoading(false);
    }
  };

  const deliver = async (mode: "copy" | "download", acknowledgedKey?: string) => {
    if (!aggregate) return;
    const decision = dailySummaryDeliveryDecision({ aggregate, selectedPluginIds: selection, preview, acknowledgedPreviewKey: acknowledgedKey ?? privacyKey });
    if (!decision.allowed) {
      if (decision.requiresPrivacyConfirmation && preview) {
        setPrivacySources(decision.privacySources ?? []);
        setPrivacyKey(preview.key);
        setPrivacyMode(mode);
      } else onNotice(decision.reason === "preview-required" ? "Generate a preview before delivery." : "Generate a new preview for the current selection.");
      return;
    }
    try {
      if (mode === "copy") {
        if (window.infolens) await window.infolens.copyText(decision.text!);
        else await navigator.clipboard.writeText(decision.text!);
        onNotice("Daily Summary copied.");
      } else {
        if (!window.infolens) throw new Error("File delivery is unavailable.");
        const result = await window.infolens.downloadText({ filename: decision.filename!, text: decision.text! });
        if (!result.canceled) onNotice("Daily Summary downloaded.");
      }
    } catch {
      onNotice("Daily Summary delivery failed.");
    }
  };

  const confirmPrivacy = () => {
    const mode = privacyMode;
    setPrivacySources([]);
    setPrivacyMode(undefined);
    if (mode) void deliver(mode, privacyKey);
  };

  const cancelPrivacy = () => {
    setPrivacySources([]);
    setPrivacyKey(undefined);
    setPrivacyMode(undefined);
  };

  return <section className="host-page daily-summary-page">
    <header className="page-header">
      <div><h1>Daily Summary</h1><p>Inspect today&apos;s retained Plugin Context before delivery.</p></div>
      <div className="daily-summary-actions"><button type="button" onClick={onOpenBatch}><RefreshCw size={15} />Open Batch Refresh</button><button type="button" onClick={() => void readAggregate()} disabled={loading}><RotateCcw size={15} />Read again</button></div>
    </header>
    {loading && <div className="daily-summary-state" role="status"><LoaderCircle className="spinner" size={20} />Loading Daily Summary data...</div>}
    {error && <div className="daily-summary-state daily-summary-state--error" role="alert"><AlertCircle size={20} /><strong>Daily Summary unavailable</strong><span>{error}</span></div>}
    {!loading && !error && aggregate && <>
      <div className="daily-summary-meta"><span><strong>{aggregate.localDate}</strong> local date</span><span>{aggregate.timeZone}</span><span>Generated {aggregate.generatedAt}</span></div>
      <div className="daily-summary-layout">
        <div className="daily-summary-sources">
          {aggregate.plugins.filter((plugin) => plugin.status !== "disabled").map((plugin) => {
            const selectable = isDailySummarySelectable(plugin);
            const selected = selection.has(plugin.pluginId);
            const metadata = dailySummarySourceMetadata(plugin, aggregate.generatedAt);
            const sourceDetails = plugin.status === "unsupported"
              ? "Daily Summary not supported"
              : `${plugin.status === "no-data" ? "No qualifying snapshot for today" : plugin.status === "unavailable" ? "Data unavailable" : ""}${plugin.status === "ready" ? "" : " | "}${metadata.recordCount} records | ${metadata.collectedAt} | ${metadata.relativeAge}`;
            return <label className={`daily-summary-source ${selected ? "is-selected" : ""} ${!selectable ? "is-disabled" : ""}`} key={plugin.pluginId}>
              <input type="checkbox" checked={selected} disabled={!selectable} onChange={() => selectionChanged(plugin.pluginId)} />
              <span className="daily-summary-source-main"><strong>{plugin.name}</strong><small>{sourceDetails}</small></span>
              <span className={`daily-summary-status daily-summary-status--${plugin.status}`}>{plugin.status}</span>
            </label>;
          })}
          {!aggregate.plugins.length && <div className="daily-summary-state">No enabled Plugins participate in Daily Summary.</div>}
          <div className="daily-summary-toolbar"><span>{selection.size} selected</span><button className="primary-button" type="button" disabled={!selection.size || loading} onClick={() => void generatePreview}><ListChecks size={15} />Generate preview</button></div>
        </div>
        <div className="daily-summary-preview">
          <div className="daily-summary-preview-header"><h2>Markdown preview</h2>{preview && <span>{isDailySummaryPreviewCurrent(preview, aggregate, selection) ? "Current" : "Regenerate required"}</span>}</div>
          {!preview && <div className="daily-summary-preview-empty">Generate a preview to freeze the selected facts.</div>}
          {preview && <pre aria-label="Daily Summary Markdown preview">{preview.markdown}</pre>}
          <div className="daily-summary-delivery"><button type="button" disabled={!preview} onClick={() => void deliver("copy")}><Copy size={15} />Copy</button><button type="button" disabled={!preview} onClick={() => void deliver("download")}><Download size={15} />Download Markdown</button></div>
        </div>
      </div>
    </>}
    {privacySources.length > 0 && <div className="dialog-scrim"><div className="dialog" role="dialog" aria-modal="true" aria-labelledby="daily-summary-privacy-title"><TriangleAlert className="dialog-symbol warning" size={26} /><h2 id="daily-summary-privacy-title">Confirm browser-dependent sources</h2><p>This Daily Summary includes information collected through browser-backed or signed-in Plugins.</p><small>{privacySources.join(", ")}</small><div className="dialog-actions"><button type="button" onClick={cancelPrivacy}>Cancel</button><button type="button" className="primary-button" onClick={confirmPrivacy}>Continue</button></div></div></div>}
  </section>;
}

type ToastNotice = {
  message: string;
  batchId?: string;
  actionLabel?: string;
};

function refreshOptionValue(target: BatchTarget, field: RefreshOptionField, input?: Record<string, RefreshOptionValue>) {
  if (input && Object.hasOwn(input, field.key)) return input[field.key];
  if (target.refreshOptions?.values && Object.hasOwn(target.refreshOptions.values, field.key)) return target.refreshOptions.values[field.key];
  if (field.default !== undefined) return field.default;
  if (field.type === "select") return field.options?.[0]?.value ?? "";
  return field.type === "boolean" ? false : "";
}

function refreshInputFor(target: BatchTarget, input?: Record<string, RefreshOptionValue>) {
  if (!target.refreshOptions?.fields.length) return undefined;
  const result: Record<string, RefreshOptionValue> = {};
  for (const field of target.refreshOptions.fields) {
    const value = refreshOptionValue(target, field, input);
    if (value !== undefined && value !== "") result[field.key] = value;
  }
  return Object.keys(result).length ? result : undefined;
}

function RefreshOptionControls({
  target,
  input,
  disabled,
  onChange,
}: {
  target: BatchTarget;
  input?: Record<string, RefreshOptionValue>;
  disabled?: boolean;
  onChange: (key: string, value: RefreshOptionValue | undefined) => void;
}) {
  const options = target.refreshOptions;
  if (!options?.fields.length) return null;
  return <div className="batch-target-options">
    {options.title && <span className="batch-target-options-title">{options.title}</span>}
    {options.fields.map((field) => {
      const value = refreshOptionValue(target, field, input);
      if (field.type === "select") return <label className="batch-target-option" key={field.key}>
        <span>{field.label}</span>
        <select aria-label={field.label} disabled={disabled} value={String(value)} onChange={(event) => onChange(field.key, event.currentTarget.value)}>
          {(field.options ?? []).map((option) => <option value={option.value} key={option.value}>{option.label}</option>)}
        </select>
      </label>;
      if (field.type === "number") return <label className="batch-target-option" key={field.key}>
        <span>{field.label}</span>
        <input aria-label={field.label} disabled={disabled} type="number" value={typeof value === "number" ? value : ""} min={field.min} max={field.max} step={field.step} onChange={(event) => onChange(field.key, event.currentTarget.value === "" ? undefined : Number(event.currentTarget.value))} />
      </label>;
      if (field.type === "boolean") return <label className="batch-target-option" key={field.key}>
        <input aria-label={field.label} disabled={disabled} type="checkbox" checked={value === true} onChange={(event) => onChange(field.key, event.currentTarget.checked)} />
        <span>{field.label}</span>
      </label>;
      return <label className="batch-target-option" key={field.key}>
        <span>{field.label}</span>
        <input aria-label={field.label} disabled={disabled} type="text" value={String(value ?? "")} maxLength={field.maxLength} placeholder={field.placeholder} onChange={(event) => onChange(field.key, event.currentTarget.value)} />
      </label>;
    })}
  </div>;
}

function BatchRefreshView({
  runtime,
  initialBatchId,
  onBatchIdChange,
  onBatchStarted,
  onOpenLogs,
}: {
  runtime: RuntimeInfo;
  initialBatchId?: string;
  onBatchIdChange: (batchId?: string) => void;
  onBatchStarted: (batchId: string) => void;
  onOpenLogs: (batchId: string, operationId?: string) => void;
}) {
  const [targets, setTargets] = useState<BatchTarget[]>([]);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const [refreshInputs, setRefreshInputs] = useState<Record<string, Record<string, RefreshOptionValue>>>({});
  const [batch, setBatch] = useState<BatchSummary>();
  const [history, setHistory] = useState<BatchSummary[]>([]);
  const [now, setNow] = useState(() => new Date());
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string>();
  const runtimeOrigin = runtime.origin;

  const fetchTargets = async () => {
    const response = await runtimeRequest<{ targets: BatchTarget[] }>(runtime, "/runtime/batches/targets");
    setTargets(response.targets);
  };

  const fetchHistory = async () => {
    const response = await runtimeRequest<{ activeBatch?: BatchSummary; batches: BatchSummary[] }>(runtime, "/runtime/batches");
    setHistory(response.batches);
    if (!initialBatchId && response.activeBatch) {
      setBatch(response.activeBatch);
      onBatchIdChange(response.activeBatch.batchId);
    }
  };

  const fetchBatch = async (batchId: string) => {
    const result = await runtimeRequest<BatchSummary>(runtime, `/runtime/batches/${encodeURIComponent(batchId)}`);
    setBatch(result);
  };

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(undefined);
    Promise.all([
      fetchTargets(),
      fetchHistory(),
      initialBatchId ? fetchBatch(initialBatchId) : Promise.resolve(),
    ]).catch((reason: unknown) => {
      if (active) setError(reason instanceof Error ? reason.message : "Batch refresh could not be loaded.");
    }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [runtimeOrigin, initialBatchId]);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!initialBatchId || !batch || batch.batchId !== initialBatchId || batchTerminal(batch)) return;
    let active = true;
    const timer = window.setInterval(() => fetchBatch(initialBatchId).catch((reason: unknown) => {
      if (active) setError(reason instanceof Error ? reason.message : "Batch progress could not be loaded.");
    }), 900);
    return () => { active = false; window.clearInterval(timer); };
  }, [runtimeOrigin, initialBatchId, batch?.batchId, batch?.status]);

  useEffect(() => {
    if (!initialBatchId || batchTerminal(batch)) return;
    const timer = window.setInterval(() => fetchTargets().catch(() => {}), 2_000);
    return () => window.clearInterval(timer);
  }, [runtimeOrigin, initialBatchId, batch?.status]);

  useEffect(() => {
    if (batch && batchTerminal(batch)) fetchHistory().catch(() => {});
  }, [batch?.batchId, batch?.status]);

  const selectedExecutable = hasExecutableSelection(targets, selectedIds);
  const toggle = (pluginId: string) => setSelectedIds((current) => {
    const next = new Set(current);
    if (next.has(pluginId)) next.delete(pluginId); else next.add(pluginId);
    return next;
  });
  const updateRefreshInput = (pluginId: string, key: string, value: RefreshOptionValue | undefined) => setRefreshInputs((current) => {
    const next = { ...current, [pluginId]: { ...(current[pluginId] ?? {}) } };
    if (value === undefined) delete next[pluginId][key];
    else next[pluginId][key] = value;
    return next;
  });
  const startBatch = async () => {
    if (!selectedExecutable || submitting) return;
    setSubmitting(true);
    setError(undefined);
    try {
      const selections = [...selectedIds].map((pluginId) => {
        const target = targets.find((entry) => entry.pluginId === pluginId);
        const refreshInput = target ? refreshInputFor(target, refreshInputs[pluginId]) : undefined;
        return { pluginId, ...(refreshInput ? { refreshInput } : {}) };
      });
      const result = await runtimeRequest<BatchSummary & { batch?: BatchSummary }>(runtime, "/runtime/batches", {
        method: "POST",
        body: JSON.stringify({ targets: selections }),
      });
      const created = result.batch ?? result;
      setBatch(created);
      onBatchIdChange(created.batchId);
      onBatchStarted(created.batchId);
      setSelectedIds(new Set());
      await fetchHistory();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Batch refresh could not start.");
    } finally { setSubmitting(false); }
  };
  const retryFailed = async () => {
    if (!batch || !batchTerminal(batch) || !batch.counts.failed) return;
    setSubmitting(true);
    try {
      const result = await runtimeRequest<BatchSummary & { batch?: BatchSummary }>(runtime, `/runtime/batches/${encodeURIComponent(batch.batchId)}/retry`, { method: "POST" });
      const created = result.batch ?? result;
      setBatch(created);
      onBatchIdChange(created.batchId);
      onBatchStarted(created.batchId);
      await fetchHistory();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Failed targets could not be retried.");
    } finally { setSubmitting(false); }
  };
  const startNewBatch = () => {
    setBatch(undefined);
    setSelectedIds(new Set());
    setError(undefined);
    onBatchIdChange(undefined);
  };

  const emptyState = selectionEmptyState(targets, now);
  const today = localDayKey(now);
  const targetRows = batch
    ? batch.items.map((item) => ({ item, target: batch.targets?.find((target) => target.pluginId === item.pluginId) ?? targets.find((target) => target.pluginId === item.pluginId) }))
    : [];
  const historyPanel = (
    <aside className="batch-history">
      <h2>Session history</h2>
      {history.map((entry) => <button type="button" className={entry.batchId === batch?.batchId ? "batch-history-row is-selected" : "batch-history-row"} key={entry.batchId} onClick={() => { setBatch(entry); onBatchIdChange(entry.batchId); }}><span><strong>{new Date(entry.createdAt).toLocaleTimeString()}</strong><small>{entry.parentBatchId ? "Retry" : "Batch refresh"}</small></span><span><strong>{batchStatusLabel(entry.status)}</strong><small>{entry.counts.succeeded}/{entry.counts.total} succeeded</small></span></button>)}
      {!history.length && <p>No Batch history in this Application Session.</p>}
    </aside>
  );

  return (
    <section className="host-page batch-page">
      <header className="page-header">
        <div><h1>Batch refresh</h1><p>{batch ? `${batchStatusLabel(batch.status)} · ${batch.counts.remaining} remaining` : "Choose one or more Plugin Workspaces"}</p></div>
        {batch && <div className="batch-header-actions"><button type="button" onClick={() => onOpenLogs(batch.batchId)}><ScrollText size={15} />View Batch logs</button>{batchTerminal(batch) && <button type="button" onClick={startNewBatch}><RefreshCw size={15} />New batch</button>}{batchTerminal(batch) && batch.counts.failed > 0 && <button className="primary-button" type="button" disabled={submitting} onClick={retryFailed}><RotateCcw size={15} />Retry failed</button>}</div>}
      </header>
      {error && <div className="batch-error" role="alert"><AlertCircle size={17} />{error}</div>}
      {loading && !targets.length && <div className="logs-state" role="status"><LoaderCircle className="spinner" size={20} />Loading Workspaces...</div>}
      {!loading && !batch && (
        <div className="batch-selection-layout">
          <div className="batch-selection-main">
            <div className="batch-toolbar">
              <div><strong>{selectedIds.size}</strong> selected <span className="batch-toolbar-note">{today ? `Local day ${today}` : ""}</span></div>
              <div className="batch-toolbar-actions"><button type="button" onClick={() => setSelectedIds(selectAllEligible(targets))}><ListChecks size={15} />Select all eligible</button><button type="button" onClick={() => setSelectedIds(selectNotRefreshedToday(targets, now))}><RefreshCw size={15} />Not refreshed today</button></div>
            </div>
            <div className="batch-target-list" aria-label="Plugin Workspace refresh targets">
              {targets.map((target) => {
                const eligibility = targetEligibility(target);
                return <div className={`batch-target-row ${selectedIds.has(target.pluginId) ? "is-selected" : ""} ${!eligibility.eligible ? "is-unavailable" : ""}`} key={target.pluginId}>
                  <input aria-label={`Select ${target.name}`} type="checkbox" checked={selectedIds.has(target.pluginId)} disabled={!eligibility.eligible} onChange={() => toggle(target.pluginId)} />
                  <div className="batch-target-main"><strong>{target.name}</strong><small>{target.pluginId} · {freshnessLabel(target, now)}</small><small className="batch-target-exact">{target.lastSuccessfulRefreshAt ? exactLocalTime(target.lastSuccessfulRefreshAt) : "No successful refresh"}</small><RefreshOptionControls target={target} input={refreshInputs[target.pluginId]} disabled={!eligibility.eligible} onChange={(key, value) => updateRefreshInput(target.pluginId, key, value)} /></div>
                  <span className="batch-target-state"><span>{target.state}</span>{eligibility.warning && <span title={eligibility.warning}><TriangleAlert size={15} aria-label={eligibility.warning} /></span>}{!eligibility.eligible && <small>{eligibility.reason}</small>}</span>
                </div>;
              })}
              {!targets.length && <div className="logs-state"><strong>No Plugin Workspaces found</strong></div>}
            </div>
            <div className="batch-submit-bar">
              <span>{selectedIds.size ? `${selectedIds.size} selected` : emptyState}</span>
              <button className="primary-button" type="button" disabled={!selectedExecutable || submitting} onClick={startBatch}>{submitting ? <LoaderCircle className="spinner" size={15} /> : <RefreshCw size={15} />}Start refresh</button>
            </div>
          </div>
          {historyPanel}
        </div>
      )}
      {batch && (
        <div className="batch-result-layout">
          <div className="batch-result-main">
            <div className="batch-counts" aria-label="Batch counts"><span><strong>{batch.counts.succeeded}</strong> succeeded</span><span><strong>{batch.counts.failed}</strong> failed</span><span><strong>{batch.counts.skipped}</strong> skipped</span><span><strong>{batch.counts.remaining}</strong> remaining</span></div>
            <div className="batch-item-list" aria-label="Batch Workspace results">
              {targetRows.map(({ item, target }) => <div className="batch-item-row" key={item.pluginId}>
                <span className={`batch-item-icon batch-item-icon--${item.state}`}>{item.state === "running" || item.state === "queued" ? <LoaderCircle className="spinner" size={16} /> : item.state === "succeeded" ? <CheckCircle2 size={16} /> : item.state === "failed" ? <AlertCircle size={16} /> : <CircleOff size={16} />}</span>
                <span className="batch-item-main"><strong>{item.name}</strong><small>{item.pluginId} · {itemStatusLabel(item.state)}{item.coalesced ? " · followed existing refresh" : ""}</small>{item.reason && <small className="batch-item-reason">{item.reason}</small>}{target?.lastSuccessfulRefreshAt && <small className="batch-target-exact">Last success {exactLocalTime(target.lastSuccessfulRefreshAt)}</small>}</span>
                <span className="batch-item-actions">{item.operationId && <button type="button" onClick={() => onOpenLogs(batch.batchId, item.operationId)}><ExternalLink size={14} />Evidence</button>}</span>
              </div>)}
            </div>
          </div>
          {historyPanel}
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
  const [dailySummarySelection, setDailySummarySelection] = useState<Set<string>>();
  const [batchId, setBatchId] = useState<string>();
  const [managedKey, setManagedKey] = useState<string>();
  const [bridgeDialog, setBridgeDialog] = useState(false);
  const [bridgeStatus, setBridgeStatus] = useState<{ connected: boolean; affected: Array<{ id: string; name: string }> }>();
  const [runtimeRestarting, setRuntimeRestarting] = useState(false);
  const [removeKey, setRemoveKey] = useState<string>();
  const [toast, setToast] = useState<ToastNotice>();
  const [logFilters, setLogFilters] = useState<LogFilters>(INITIAL_LOG_FILTERS);
  const [focusedLogId, setFocusedLogId] = useState<string>();
  const [systemDark, setSystemDark] = useState(() => window.matchMedia("(prefers-color-scheme: dark)").matches);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const observedBatchIds = useRef(new Set<string>());
  const notifiedBatchIds = useRef(new Set<string>());

  const refreshInfo = async () => {
    const info = await getRuntimeInfo();
    setRuntime(info);
    setStatus("ready");
    return info;
  };

  const showNotice = (notice: ToastNotice | string) => {
    setToast(typeof notice === "string" ? { message: notice } : notice);
  };

  const observeBatch = (nextBatchId: string) => {
    observedBatchIds.current.add(nextBatchId);
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
    const timer = window.setInterval(() => refreshInfo().catch(() => {
      setRuntimeRestarting(true);
      setDailySummarySelection(undefined);
    }), 1_500);
    return () => window.clearInterval(timer);
  }, [status]);

  useEffect(() => {
    if (status !== "ready" || !runtime) return;
    let active = true;
    const checkBatches = async () => {
      try {
        const response = await runtimeRequest<{ activeBatch?: BatchSummary; batches: BatchSummary[] }>(runtime, "/runtime/batches");
        if (!active) return;
        const batches = new Map(response.batches.map((batch) => [batch.batchId, batch]));
        if (response.activeBatch) batches.set(response.activeBatch.batchId, response.activeBatch);
        for (const batch of batches.values()) {
          const notice = batchCompletionNotice(batch, observedBatchIds.current, notifiedBatchIds.current);
          if (notice) showNotice(notice);
        }
      } catch {}
    };
    void checkBatches();
    const timer = window.setInterval(checkBatches, 900);
    return () => { active = false; window.clearInterval(timer); };
  }, [status, runtime?.origin]);

  useEffect(() => window.infolens?.onRuntimeStatus((event) => {
    if (event.status === "running") {
      refreshInfo().then(() => {
        setDailySummarySelection(undefined);
        setRuntimeRestarting(false);
        if (iframeRef.current) iframeRef.current.src = iframeRef.current.src;
      }).catch(() => {
        setRuntimeRestarting(true);
        setDailySummarySelection(undefined);
      });
    } else {
      setRuntimeRestarting(true);
      setDailySummarySelection(undefined);
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

  const openBatchRefresh = async () => {
    if (!runtime) return;
    try {
      const result = await runtimeRequest<{ activeBatch?: BatchSummary }>(runtime, "/runtime/batches");
      if (result.activeBatch) observeBatch(result.activeBatch.batchId);
      setBatchId(result.activeBatch?.batchId);
      setView({ kind: "batch" });
    } catch (reason) {
      showNotice(reason instanceof Error ? reason.message : "Batch refresh is unavailable.");
    }
  };

  const mutate = async (action: () => Promise<unknown>, success: string) => {
    try { await action(); await refreshInfo(); showNotice(success); }
    catch (error) { showNotice(error instanceof Error ? error.message : "Operation failed"); }
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
      batchId: failure.batchId ?? "",
    });
    setFocusedLogId(failure.logId);
    setView({ kind: "logs" });
  };

  const openBatchLogs = (nextBatchId: string, operationId?: string) => {
    setLogFilters({ ...INITIAL_LOG_FILTERS, batchId: operationId ? "" : nextBatchId, operationId: operationId ?? "" });
    setFocusedLogId(undefined);
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
           <button className={`nav-item utility ${view.kind === "daily-summary" ? "is-selected" : ""}`} onClick={() => setView({ kind: "daily-summary" })} type="button"><span className="utility-icon"><FileText size={17} /></span><span className="nav-label">Daily Summary</span></button>
           <button className={`nav-item utility ${view.kind === "batch" ? "is-selected" : ""}`} onClick={openBatchRefresh} type="button"><span className="utility-icon"><RefreshCw size={17} /></span><span className="nav-label">Batch refresh</span>{runtime?.activeBatch && <span className="nav-badge">{runtime.activeBatch.counts.remaining}</span>}</button>
           <button className={`nav-item utility ${view.kind === "logs" ? "is-selected" : ""}`} onClick={() => setView({ kind: "logs" })} type="button"><span className="utility-icon"><ScrollText size={17} /></span><span className="nav-label">Logs</span></button>
          <button className={`nav-item utility ${view.kind === "settings" ? "is-selected" : ""}`} onClick={() => setView({ kind: "settings" })} type="button"><span className="utility-icon"><Settings size={17} /></span><span className="nav-label">Settings</span></button>
        </nav>
      </aside>

      <main className="main-area">
        {runtimeRestarting && <div className="restart-bar" role="status"><LoaderCircle className="spinner" size={15} /> Restarting plugin services...</div>}
        {view.kind === "logs" && <LogsView filters={logFilters} setFilters={setLogFilters} focusEntryId={focusedLogId} onNotice={showNotice} />}
        {view.kind !== "logs" && status === "loading" && <div className="system-state" role="status"><LoaderCircle className="spinner" size={24} /><p>{message}</p></div>}
        {view.kind !== "logs" && status === "error" && <div className="system-state system-state--error" role="alert"><h1>Plugin services unavailable</h1><p>{message}</p></div>}
        {status === "ready" && view.kind === "plugin" && selected && selected.state === "disabled" && (
          <div className="system-state"><CircleOff size={28} /><h1>{selected.name} is disabled</h1><button className="primary-button" onClick={() => runtime && mutate(() => runtimeRequest(runtime, `/runtime/plugins/${selected.id}/enabled`, { method: "POST", body: JSON.stringify({ enabled: true }) }), `${selected.name} enabled`)}>Enable in Plugins</button></div>
        )}
        {status === "ready" && view.kind === "plugin" && workspaceSrc && selected?.state !== "disabled" && <iframe ref={iframeRef} className="workspace-frame" src={workspaceSrc} title={`${selected?.name ?? "Plugin"} workspace`} allow="clipboard-write" />}
        {status === "ready" && view.kind === "batch" && runtime && <BatchRefreshView runtime={runtime} initialBatchId={batchId} onBatchIdChange={setBatchId} onBatchStarted={observeBatch} onOpenLogs={openBatchLogs} />}
        {status === "ready" && !runtimeRestarting && view.kind === "daily-summary" && runtime && <DailySummaryView runtime={runtime} onOpenBatch={openBatchRefresh} onNotice={showNotice} selectedPluginIds={dailySummarySelection} onSelectionChange={setDailySummarySelection} />}
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
      {toast && <div className="toast" role="status"><span>{toast.message}</span>{toast.batchId && <button type="button" onClick={() => { setBatchId(toast.batchId); setView({ kind: "batch" }); setToast(undefined); }}><ExternalLink size={14} />{toast.actionLabel ?? "View results"}</button>}</div>}
    </div>
  );
}
