import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertCircle, CheckCircle2, CircleOff, Copy, Download, ExternalLink, FileArchive, FolderPlus, ListChecks,
  LoaderCircle, RefreshCw, RotateCcw, ScrollText, Trash2, TriangleAlert,
} from "lucide-react";
import {
  batchCompletionNotice, exactLocalTime, freshnessLabel, hasExecutableSelection, localDayKey,
  selectAllEligible, selectNotRefreshedToday, selectionEmptyState, targetEligibility,
} from "./batch-refresh";
import {
  createDailySummaryPreview, dailySummaryDeliveryDecision,
  dailySummaryPromptFilename, dailySummarySourceMetadata, dailySummaryWrittenFilename, defaultDailySummarySelection, isDailySummaryPreviewCurrent, isDailySummarySelectable, preserveDailySummarySelection,
  renderDailySummaryPrompt, renderDailySummaryWrittenMarkdown,
  toggleDailySummarySelection,
} from "./daily-summary";
import type { DailySummaryAggregate, DailySummaryPreview } from "./daily-summary";
import { InstrumentRail, Lifecycle, sourceInitial } from "./components/InstrumentRail";
import { CommandPalette } from "./components/CommandPalette";
import { OverviewView } from "./components/OverviewView";
import { BridgePanel } from "./components/BridgePanel";
import { MarketView } from "./components/MarketView";
import type { CommandItem } from "./components/CommandPalette";
import { readJsonResponse, runtimeRequest } from "./runtime-api";
import { useTheme } from "./useTheme";
import type { HostView } from "./host-view";
import { useLanguage } from "./i18n";
import type { Translate } from "./i18n";

type Status = "loading" | "ready" | "error";
type DailySummaryDeliveryMode = `${"facts" | "prompt" | "written"}:${"copy" | "download"}`;

function previewOrigin() {
  return new URLSearchParams(window.location.search).get("runtimeOrigin");
}

async function getRuntimeInfo(): Promise<RuntimeInfo> {
  const hostInfo = window.infolens ? await window.infolens.getRuntimeInfo() : undefined;
  const origin = hostInfo?.origin ?? previewOrigin() ?? window.location.origin;
  if (!origin || origin === "null") throw new Error("Plugin services are unavailable.");
  const response = await fetch(`${origin}/api/v1/session/bootstrap`, { credentials: "include" });
  const body = await readJsonResponse<{ origin: string }>(response, "Plugin services are unavailable.");
  if (!response.ok) throw new Error("Plugin services are unavailable.");
  const infoResponse = await fetch(`${body.origin ?? origin}/api/v1/info`, { credentials: "include" });
  const info = await readJsonResponse<RuntimeInfo>(infoResponse, "Plugin services are unavailable.");
  if (!infoResponse.ok) throw new Error("Plugin services are unavailable.");
  return info;
}

function browserStatusFromError(error: unknown): BrowserStatus | undefined {
  if (!error || typeof error !== "object" || !("body" in error)) return undefined;
  const body = error.body;
  if (!body || typeof body !== "object" || !("overall" in body)) return undefined;
  return body as BrowserStatus;
}

function available(plugin: RuntimePlugin) {
  return plugin.enabled && !["disabled", "failed", "unavailable", "cancelled"].includes(plugin.state);
}

const INITIAL_LOG_FILTERS: LogFilters = { sources: [], levels: ["info", "warn", "error"], from: "", to: "", keyword: "", operationId: "", batchId: "" };
const ERROR_GUIDANCE: Record<string, { explanation: string; action: string }> = {
  INCOMPATIBLE_CONTRACT: { explanation: "This plugin uses a package contract that this Host does not support.", action: "Install a compatible plugin version." },
  INCOMPATIBLE_HOST: { explanation: "This plugin requires a newer Infolens Host.", action: "Update Infolens, then try the plugin again." },
  PLUGIN_ERROR: { explanation: "The plugin could not complete the operation.", action: "Review the redacted message, then retry or restart the plugin." },
  RUNTIME_RESTART_REQUIRED: { explanation: "Plugin Runtime could not finish the lifecycle operation safely.", action: "Allow Plugin Runtime to restart, then retry." },
};

function LogsView({ runtime, filters, setFilters, focusEntryId, onNotice }: { runtime?: RuntimeInfo; filters: LogFilters; setFilters: (filters: LogFilters) => void; focusEntryId?: string; onNotice: (message: string) => void }) {
  const { t, locale } = useLanguage();
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
  const requestLogs = (cursor?: string) => {
    if (!runtime) return Promise.reject(new Error("Plugin services are unavailable."));
    const params = new URLSearchParams({ limit: "200" });
    for (const source of requestFilters.sources) params.append("source", source);
    for (const level of requestFilters.levels) params.append("level", level);
    for (const [key, value] of Object.entries(requestFilters)) {
      if (key === "sources" || key === "levels" || !value) continue;
      params.set(key, String(value));
    }
    if (cursor) params.set("cursor", cursor);
    return runtimeRequest<LogPage>(runtime, `/api/v1/logs?${params.toString()}`);
  };

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
    if (!runtime) {
      setEntries([]);
      setCursor(null);
      setLoading(false);
      return;
    }
    pendingIdsRef.current.clear();
    setPendingCount(0);
    atNewestRef.current = true;
    requestLogs().then((page) => {
      if (!active) return;
      setEntries(page.entries);
      setCursor(page.nextCursor);
    }).catch((reason: unknown) => {
      if (active) setError(reason instanceof Error ? reason.message : t("Logs could not be loaded."));
    }).finally(() => { if (active) setLoading(false); });

    const timer = window.setInterval(async () => {
      try {
        const page = await requestLogs();
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
        if (active) setLiveError(reason instanceof Error ? reason.message : t("Live updates are temporarily unavailable."));
      }
    }, 2_000);
    return () => { active = false; window.clearInterval(timer); };
  }, [requestFilters, runtime?.origin]);

  const showNewest = async () => {
    if (!runtime) return;
    try {
      const page = await requestLogs();
      setEntries(page.entries);
      setCursor(page.nextCursor);
      pendingIdsRef.current.clear();
      setPendingCount(0);
      atNewestRef.current = true;
      tableRef.current?.scrollTo({ top: 0 });
      setLiveError(undefined);
    } catch (reason) {
      setLiveError(reason instanceof Error ? reason.message : t("Newest logs could not be loaded."));
    }
  };

  const loadOlder = async () => {
    if (!runtime || !cursor) return;
    setLoadingOlder(true);
    setError(undefined);
    try {
      const page = await requestLogs(cursor);
      setEntries((current) => [...current, ...page.entries]);
      setCursor(page.nextCursor);
    } catch (reason) {
      setLiveError(reason instanceof Error ? reason.message : t("Older logs could not be loaded."));
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
      onNotice(reason instanceof Error ? reason.message : t("Logs could not be shared."));
    } finally { setSharing(false); }
  };
  const copyFiltered = async () => {
    const page = await requestLogs();
    const text = page.entries.map((entry) => JSON.stringify(entry)).join("\n");
    if (window.infolens) await window.infolens.copyText(text);
    else await navigator.clipboard.writeText(text);
    return { count: page.entries.length };
  };
  const exportFiltered = async () => {
    const page = await requestLogs();
    const text = page.entries.map((entry) => JSON.stringify(entry)).join("\n");
    const filename = `infolens-logs-${new Date().toISOString().slice(0, 10)}.jsonl`;
    if (window.infolens) return { ...(await window.infolens.downloadText({ filename, text })), count: page.entries.length };
    const link = document.createElement("a");
    link.href = URL.createObjectURL(new Blob([text], { type: "application/jsonl" }));
    link.download = filename;
    link.click();
    URL.revokeObjectURL(link.href);
    return { canceled: false, count: page.entries.length };
  };
  const sources = [...new Set(["host", "runtime", ...filters.sources, ...entries.map((entry) => entry.source)])].sort();

  return (
    <section className="host-page logs-page">
      <header className="page-header"><div><h1>{t("Logs")}</h1><p>{t("Operational evidence from this device")}</p></div></header>
      <div className="logs-toolbar" aria-label={t("Log filters")}>
        <label>{t("Source")}<select aria-label={t("Source")} value={filters.sources[0] ?? ""} onChange={(event) => setFilters({ ...filters, sources: event.target.value ? [event.target.value] : [] })}><option value="">{t("All sources")}</option>{sources.map((source) => <option value={source} key={source}>{source}</option>)}</select></label>
        <fieldset><legend>{t("Severity")}</legend>{(["debug", "info", "warn", "error"] as LogLevel[]).map((level) => <label key={level}><input type="checkbox" checked={filters.levels.includes(level)} onChange={(event) => updateLevel(level, event.target.checked)} />{level === "warn" ? t("Warning") : t(level[0].toUpperCase() + level.slice(1))}</label>)}</fieldset>
        <label>{t("From")}<input aria-label={t("From time")} type="datetime-local" value={filters.from} onChange={(event) => setFilters({ ...filters, from: event.target.value })} /></label>
        <label>{t("To")}<input aria-label={t("To time")} type="datetime-local" value={filters.to} onChange={(event) => setFilters({ ...filters, to: event.target.value })} /></label>
        <label className="log-search">{t("Keyword")}<input aria-label={t("Keyword")} type="search" value={filters.keyword} onChange={(event) => setFilters({ ...filters, keyword: event.target.value })} placeholder={t("Search messages")} /></label>
        <label className="operation-search">{t("Batch ID")}<input aria-label={t("Batch ID")} value={filters.batchId} onChange={(event) => setFilters({ ...filters, batchId: event.target.value })} /></label>
        <label className="operation-search">{t("Operation ID")}<input aria-label={t("Operation ID")} value={filters.operationId} onChange={(event) => setFilters({ ...filters, operationId: event.target.value })} /></label>
        <div className="log-share-actions"><button type="button" disabled={sharing || !runtime} onClick={() => share(copyFiltered, (count) => t("{count} filtered log entries copied", { count }))}><Copy size={15} />{t("Copy filtered")}</button><button type="button" disabled={sharing || !runtime} onClick={() => share(exportFiltered, (count) => t("{count} log entries exported", { count }))}><Download size={15} />{t("Export JSONL")}</button></div>
      </div>
      {pendingCount > 0 && <button className="new-logs-button" type="button" aria-label={`${pendingCount} ${t("new")} ${t("Logs")}; move to newest`} onClick={showNewest}>{pendingCount} {t("new")} {t(pendingCount === 1 ? "entry" : "entries")}</button>}
      {liveError && <div className="live-log-status" role="status">{t("Live updates paused: {value}", { value: liveError })}</div>}
      {error && <div className="logs-state" role="alert"><AlertCircle size={20} /><strong>{t("Logs unavailable")}</strong><span>{error}</span></div>}
      {!error && loading && <div className="logs-state" role="status"><LoaderCircle className="spinner" size={20} /><span>{t("Loading logs...")}</span></div>}
      {!error && !loading && entries.length === 0 && <div className="logs-state"><ScrollText size={20} /><strong>{t("No logs match these filters")}</strong></div>}
      {!loading && entries.length > 0 && (
        <div className="log-table" aria-label={t("Operational logs")} ref={tableRef} onScroll={(event) => { atNewestRef.current = event.currentTarget.scrollTop <= 8; }}>
          <div className="log-row log-header" aria-hidden="true">
            <span>{t("Time")}</span><span>{t("Severity")}</span><span>{t("Source")}</span><span>{t("Message")}</span>
          </div>
          {entries.map((entry) => (
            <div className="log-entry" key={entry.id} data-log-id={entry.id}>
              <button className="log-row" type="button" aria-expanded={expanded === entry.id} onClick={() => setExpanded(expanded === entry.id ? undefined : entry.id)}>
                <time dateTime={entry.timestamp} title={entry.timestamp}>{new Date(entry.timestamp).toLocaleTimeString(locale)}</time>
                <span className={`log-level log-level--${entry.level}`}>{t(entry.level)}</span>
                <span className="log-source">{entry.source}</span>
                <span className="log-message">{entry.message}</span>
              </button>
              {expanded === entry.id && <div className="log-details"><dl><dt>ID</dt><dd>{entry.id}</dd><dt>{t("Canonical timestamp")}</dt><dd>{entry.timestamp}</dd><dt>{t("Severity")}</dt><dd>{t(entry.level)}</dd><dt>{t("Source")}</dt><dd>{entry.source}</dd><dt>{t("Session ID")}</dt><dd>{entry.sessionId}</dd>{entry.batchId && <><dt>{t("Batch ID")}</dt><dd className="operation-value"><span>{entry.batchId}</span><button type="button" onClick={() => setFilters({ ...filters, batchId: entry.batchId! })}>{t("Filter this Batch")}</button></dd></>}{entry.code && <><dt>{t("Code")}</dt><dd>{entry.code}</dd></>}{entry.operationId && <><dt>{t("Operation ID")}</dt><dd className="operation-value"><span>{entry.operationId}</span><button type="button" onClick={() => setFilters({ ...filters, operationId: entry.operationId! })}>{t("Filter this operation")}</button></dd></>}<dt>{t("Message")}</dt><dd>{entry.message}</dd></dl><div className="log-entry-actions"><button type="button" disabled={sharing || !runtime} onClick={() => share(async () => { if (window.infolens) await window.infolens.copyText(entry.message); else await navigator.clipboard.writeText(entry.message); return { count: 1 }; }, () => t("Log entry copied"))}><Copy size={15} />{t("Copy entry")}</button></div>{entry.code && ERROR_GUIDANCE[entry.code] && <div className="log-guidance"><strong>{t(ERROR_GUIDANCE[entry.code].explanation)}</strong><span>{t(ERROR_GUIDANCE[entry.code].action)}</span></div>}</div>}
            </div>
          ))}
          <div className="log-history-state">{cursor ? <button type="button" onClick={loadOlder} disabled={loadingOlder}>{loadingOlder ? t("Loading...") : t("Load older")}</button> : <span>{t("End of retained history")}</span>}</div>
        </div>
      )}
    </section>
  );
}

function batchTerminal(batch?: BatchSummary) {
  return Boolean(batch && ["succeeded", "partial", "failed", "skipped", "interrupted"].includes(batch.status));
}

function batchStatusLabel(status: string, t: Translate) {
  return t(({ queued: "Queued", running: "Refreshing", succeeded: "Completed", partial: "Partially completed", failed: "Failed", skipped: "Skipped", interrupted: "Interrupted" } as Record<string, string>)[status] ?? status);
}

function itemStatusLabel(status: BatchItemState, t: Translate) {
  return t(({ queued: "Queued", running: "Refreshing", succeeded: "Succeeded", failed: "Failed", skipped: "Skipped", interrupted: "Interrupted" } as Record<BatchItemState, string>)[status]);
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
  const { t } = useLanguage();
  const [aggregate, setAggregate] = useState<DailySummaryAggregate>();
  const [preview, setPreview] = useState<DailySummaryPreview>();
  const [promptText, setPromptText] = useState("");
  const [writtenContent, setWrittenContent] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [privacyKey, setPrivacyKey] = useState<string>();
  const [privacySources, setPrivacySources] = useState<string[]>([]);
  const [privacyMode, setPrivacyMode] = useState<DailySummaryDeliveryMode>();
  const selection = selectedPluginIds ?? new Set<string>();
  const runtimeOrigin = runtime.origin;

  const applyAggregate = (next: DailySummaryAggregate, nextSelection: Set<string>) => {
    setAggregate(next);
    onSelectionChange(nextSelection);
    setPreview(nextSelection.size ? createDailySummaryPreview(next, nextSelection) : undefined);
    setPromptText(nextSelection.size ? renderDailySummaryPrompt(next, nextSelection) : "");
    setWrittenContent("");
    setPrivacyKey(undefined);
    setPrivacyMode(undefined);
    setPrivacySources([]);
  };

  const readAggregate = async () => {
    setLoading(true);
    setError(undefined);
    try {
      const next = await runtimeRequest<DailySummaryAggregate>(runtime, "/api/v1/daily-summary");
      const nextSelection = selectedPluginIds === undefined ? defaultDailySummarySelection(next) : preserveDailySummarySelection(next, selectedPluginIds);
      applyAggregate(next, nextSelection);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t("Daily Summary could not be loaded."));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void readAggregate(); }, [runtimeOrigin]);

  const selectionChanged = (pluginId: string) => {
    if (!aggregate) return;
    const nextSelection = toggleDailySummarySelection(aggregate, selection, pluginId);
    onSelectionChange(nextSelection);
    setPromptText(nextSelection.size ? renderDailySummaryPrompt(aggregate, nextSelection) : "");
    setWrittenContent("");
    setPreview(nextSelection.size ? createDailySummaryPreview(aggregate, nextSelection) : undefined);
    setPrivacyKey(undefined);
    setPrivacyMode(undefined);
    setPrivacySources([]);
  };

  const generatePreview = async () => {
    if (!aggregate || !selection.size) {
      onNotice(t("Select at least one source before generating a preview."));
      return;
    }
    setLoading(true);
    setError(undefined);
    try {
      const next = await runtimeRequest<DailySummaryAggregate>(runtime, "/api/v1/daily-summary");
      const nextSelection = preserveDailySummarySelection(next, selection);
      if (!nextSelection.size) {
        applyAggregate(next, nextSelection);
        onNotice(t("Select at least one source before generating a preview."));
        return;
      }
      setAggregate(next);
      onSelectionChange(nextSelection);
      const nextPreview = createDailySummaryPreview(next, nextSelection);
      setPreview(nextPreview);
      setPromptText(renderDailySummaryPrompt(next, nextSelection));
      setWrittenContent("");
      setPrivacyKey(undefined);
      setPrivacyMode(undefined);
      setPrivacySources([]);
    } catch (reason) {
      onNotice(reason instanceof Error ? reason.message : t("Daily Summary preview could not be generated."));
    } finally {
      setLoading(false);
    }
  };

  const deliver = async (kind: "facts" | "prompt" | "written", mode: "copy" | "download", acknowledgedKey?: string) => {
    if (!aggregate) return;
    let deliveryText: string | undefined;
    let deliveryFilename: string | undefined;
    try {
      if (kind === "prompt") {
        deliveryText = promptText;
        deliveryFilename = dailySummaryPromptFilename(aggregate.localDate);
      } else if (kind === "written") {
        deliveryText = renderDailySummaryWrittenMarkdown(aggregate, selection, writtenContent);
        deliveryFilename = dailySummaryWrittenFilename(aggregate.localDate);
      }
    } catch (reason) {
      onNotice(reason instanceof Error ? reason.message : t("Daily Summary content is unavailable."));
      return;
    }
    const decision = dailySummaryDeliveryDecision({ aggregate, selectedPluginIds: selection, preview, acknowledgedPreviewKey: acknowledgedKey ?? privacyKey, deliveryText, deliveryFilename });
    if (!decision.allowed) {
      if (decision.requiresPrivacyConfirmation && preview) {
        setPrivacySources(decision.privacySources ?? []);
        setPrivacyKey(preview.key);
        setPrivacyMode(`${kind}:${mode}`);
      } else if (decision.reason === "content-required") onNotice(t("Write a Daily Summary before exporting it."));
      else onNotice(decision.reason === "preview-required" ? t("Generate a preview before delivery.") : t("Generate a new preview for the current selection."));
      return;
    }
    try {
      if (mode === "copy") {
        if (window.infolens) await window.infolens.copyText(decision.text!);
        else await navigator.clipboard.writeText(decision.text!);
        onNotice(kind === "prompt" ? t("Writing prompt copied.") : kind === "written" ? t("Written summary copied.") : t("Daily Summary copied."));
      } else {
        if (!window.infolens) throw new Error(t("File delivery is unavailable."));
        const result = await window.infolens.downloadText({ filename: decision.filename!, text: decision.text! });
        if (!result.canceled) onNotice(kind === "prompt" ? t("Writing prompt downloaded.") : kind === "written" ? t("Written summary downloaded.") : t("Daily Summary downloaded."));
      }
    } catch {
      onNotice(t("Daily Summary delivery failed."));
    }
  };

  const confirmPrivacy = () => {
    const mode = privacyMode;
    setPrivacySources([]);
    setPrivacyMode(undefined);
    if (mode) {
      const [kind, deliveryMode] = mode.split(":") as ["facts" | "prompt" | "written", "copy" | "download"];
      void deliver(kind, deliveryMode, privacyKey);
    }
  };

  const cancelPrivacy = () => {
    setPrivacySources([]);
    setPrivacyKey(undefined);
    setPrivacyMode(undefined);
  };

  return <section className="host-page daily-summary-page">
    <header className="page-header">
      <div><h1>{t("Daily Summary")}</h1><p>{t("Inspect today&apos;s retained Plugin Context before delivery.")}</p></div>
      <div className="daily-summary-actions"><button type="button" onClick={onOpenBatch}><RefreshCw size={15} />{t("Open Batch Refresh")}</button><button type="button" onClick={() => void readAggregate()} disabled={loading}><RotateCcw size={15} />{t("Read again")}</button></div>
    </header>
    {loading && <div className="daily-summary-state" role="status"><LoaderCircle className="spinner" size={20} />{t("Loading Daily Summary data...")}</div>}
    {error && <div className="daily-summary-state daily-summary-state--error" role="alert"><AlertCircle size={20} /><strong>{t("Daily Summary unavailable")}</strong><span>{error}</span></div>}
    {!loading && !error && aggregate && <>
      <div className="daily-summary-meta"><span><strong>{aggregate.localDate}</strong> {t("local date")}</span><span>{aggregate.timeZone}</span><span>{t("Generated")} {aggregate.generatedAt}</span></div>
      <div className="daily-summary-layout">
        <div className="daily-summary-sources">
          {aggregate.plugins.filter((plugin) => plugin.status !== "disabled").map((plugin) => {
            const selectable = isDailySummarySelectable(plugin);
            const selected = selection.has(plugin.pluginId);
            const metadata = dailySummarySourceMetadata(plugin, aggregate.generatedAt);
            const sourceDetails = plugin.status === "unsupported"
              ? t("Daily Summary not supported")
              : `${plugin.status === "no-data" ? t("No qualifying snapshot for today") : plugin.status === "unavailable" ? t("Data unavailable") : ""}${plugin.status === "ready" ? "" : " | "}${metadata.recordCount} ${t("records")} | ${metadata.collectedAt} | ${metadata.relativeAge}`;
            return <label className={`daily-summary-source ${selected ? "is-selected" : ""} ${!selectable ? "is-disabled" : ""}`} key={plugin.pluginId}>
              <input type="checkbox" checked={selected} disabled={!selectable} onChange={() => selectionChanged(plugin.pluginId)} />
              <span className="daily-summary-source-main"><strong>{plugin.name}</strong><small>{sourceDetails}</small></span>
              <span className={`daily-summary-status daily-summary-status--${plugin.status}`}>{t(plugin.status)}</span>
            </label>;
          })}
          {!aggregate.plugins.length && <div className="daily-summary-state">{t("No enabled Plugins participate in Daily Summary.")}</div>}
          <div className="daily-summary-toolbar"><span>{selection.size} {t("selected")}</span><button className="primary-button" type="button" disabled={!selection.size || loading} onClick={() => void generatePreview()}><ListChecks size={15} />{t("Generate preview")}</button></div>
        </div>
        <div className="daily-summary-workbench">
          <section className="daily-summary-panel daily-summary-prompt-panel">
            <div className="daily-summary-preview-header"><div><h2>{t("Writing prompt")}</h2><p>{t("Reclassify entries by topic and generate a traceable Daily Summary.")}</p></div><span>{promptText ? t("Editable") : t("Select a source")}</span></div>
            <textarea aria-label={t("Daily Summary writing prompt")} value={promptText} onChange={(event) => setPromptText(event.currentTarget.value)} placeholder={t("Generate a preview to prepare the writing prompt.")} />
            <div className="daily-summary-delivery"><button type="button" disabled={!promptText.trim() || !preview} onClick={() => void deliver("prompt", "copy")}><Copy size={15} />{t("Copy prompt")}</button><button type="button" disabled={!promptText.trim() || !preview} onClick={() => void deliver("prompt", "download")}><Download size={15} />{t("Export prompt")}</button></div>
          </section>
          <section className="daily-summary-panel daily-summary-written-panel">
            <div className="daily-summary-preview-header"><div><h2>{t("Written summary")}</h2><p>{t("Paste or write model output, then export it.")}</p></div><span>{writtenContent.trim() ? `${writtenContent.trim().length} ${t("chars")}` : t("Draft")}</span></div>
            <textarea aria-label={t("Written Daily Summary")} value={writtenContent} onChange={(event) => setWrittenContent(event.currentTarget.value)} placeholder={t("Paste or write a topic-organized Daily Summary here...")} />
            <div className="daily-summary-delivery"><button type="button" disabled={!writtenContent.trim() || !preview} onClick={() => void deliver("written", "copy")}><Copy size={15} />{t("Copy summary")}</button><button type="button" className="primary-button" disabled={!writtenContent.trim() || !preview} onClick={() => void deliver("written", "download")}><Download size={15} />{t("Export summary")}</button></div>
          </section>
          <section className="daily-summary-panel daily-summary-facts-panel">
            <div className="daily-summary-preview-header"><div><h2>{t("Facts preview")}</h2><p>{t("Export the frozen facts used by the prompt and summary.")}</p></div>{preview && <span>{isDailySummaryPreviewCurrent(preview, aggregate, selection) ? t("Current") : t("Regenerate required")}</span>}</div>
            {!preview && <div className="daily-summary-preview-empty">{t("Generate a preview to freeze the selected facts.")}</div>}
            {preview && <pre aria-label={t("Daily Summary Markdown preview")}>{preview.markdown}</pre>}
            <div className="daily-summary-delivery"><button type="button" disabled={!preview} onClick={() => void deliver("facts", "copy")}><Copy size={15} />{t("Copy facts")}</button><button type="button" disabled={!preview} onClick={() => void deliver("facts", "download")}><Download size={15} />{t("Export facts")}</button></div>
          </section>
        </div>
      </div>
    </>}
    {privacySources.length > 0 && <div className="dialog-scrim"><div className="dialog" role="dialog" aria-modal="true" aria-labelledby="daily-summary-privacy-title"><TriangleAlert className="dialog-symbol warning" size={26} /><h2 id="daily-summary-privacy-title">{t("Confirm browser-dependent sources")}</h2><p>{t("This Daily Summary includes information collected through browser-backed or signed-in Plugins.")}</p><small>{privacySources.join(", ")}</small><div className="dialog-actions"><button type="button" onClick={cancelPrivacy}>{t("Cancel")}</button><button type="button" className="primary-button" onClick={confirmPrivacy}>{t("Continue")}</button></div></div></div>}
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
  const { t, locale } = useLanguage();
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
    const response = await runtimeRequest<{ targets: BatchTarget[] }>(runtime, "/api/v1/batches/targets");
    setTargets(response.targets);
  };

  const fetchHistory = async () => {
    const response = await runtimeRequest<{ activeBatch?: BatchSummary; batches: BatchSummary[] }>(runtime, "/api/v1/batches");
    setHistory(response.batches);
    if (!initialBatchId && response.activeBatch) {
      setBatch(response.activeBatch);
      onBatchIdChange(response.activeBatch.batchId);
    }
  };

  const fetchBatch = async (batchId: string) => {
    const result = await runtimeRequest<BatchSummary>(runtime, `/api/v1/batches/${encodeURIComponent(batchId)}`);
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
      if (active) setError(reason instanceof Error ? reason.message : t("Batch refresh could not be loaded."));
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
      if (active) setError(reason instanceof Error ? reason.message : t("Batch progress could not be loaded."));
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
      const result = await runtimeRequest<BatchSummary & { batch?: BatchSummary }>(runtime, "/api/v1/batches", {
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
      setError(reason instanceof Error ? reason.message : t("Batch refresh could not start."));
    } finally { setSubmitting(false); }
  };
  const retryFailed = async () => {
    if (!batch || !batchTerminal(batch) || !batch.counts.failed) return;
    setSubmitting(true);
    try {
      const result = await runtimeRequest<BatchSummary & { batch?: BatchSummary }>(runtime, `/api/v1/batches/${encodeURIComponent(batch.batchId)}/retry`, { method: "POST" });
      const created = result.batch ?? result;
      setBatch(created);
      onBatchIdChange(created.batchId);
      onBatchStarted(created.batchId);
      await fetchHistory();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t("Failed targets could not be retried."));
    } finally { setSubmitting(false); }
  };
  const startNewBatch = () => {
    setBatch(undefined);
    setSelectedIds(new Set());
    setError(undefined);
    onBatchIdChange(undefined);
  };

  const emptyState = selectionEmptyState(targets, now, undefined, t);
  const today = localDayKey(now);
  const targetRows = batch
    ? batch.items.map((item) => ({ item, target: batch.targets?.find((target) => target.pluginId === item.pluginId) ?? targets.find((target) => target.pluginId === item.pluginId) }))
    : [];
  const historyPanel = (
    <aside className="batch-history">
      <h2>{t("Session history")}</h2>
      {history.map((entry) => <button type="button" className={entry.batchId === batch?.batchId ? "batch-history-row is-selected" : "batch-history-row"} key={entry.batchId} onClick={() => { setBatch(entry); onBatchIdChange(entry.batchId); }}><span><strong>{new Date(entry.createdAt).toLocaleTimeString(locale)}</strong><small>{entry.parentBatchId ? t("Retry") : t("Batch refresh")}</small></span><span><strong>{batchStatusLabel(entry.status, t)}</strong><small>{entry.counts.succeeded}/{entry.counts.total} {t("succeeded")}</small></span></button>)}
      {!history.length && <p>{t("No Batch history in this Application Session.")}</p>}
    </aside>
  );

  return (
    <section className="host-page batch-page">
      <header className="page-header">
        <div><h1>{t("Batch refresh")}</h1><p>{batch ? `${batchStatusLabel(batch.status, t)} · ${batch.counts.remaining} ${t("remaining")}` : t("Choose one or more Plugin Workspaces")}</p></div>
        {batch && <div className="batch-header-actions"><button type="button" onClick={() => onOpenLogs(batch.batchId)}><ScrollText size={15} />{t("View Batch logs")}</button>{batchTerminal(batch) && <button type="button" onClick={startNewBatch}><RefreshCw size={15} />{t("New batch")}</button>}{batchTerminal(batch) && batch.counts.failed > 0 && <button className="primary-button" type="button" disabled={submitting} onClick={retryFailed}><RotateCcw size={15} />{t("Retry failed")}</button>}</div>}
      </header>
      {error && <div className="batch-error" role="alert"><AlertCircle size={17} />{error}</div>}
      {loading && !targets.length && <div className="logs-state" role="status"><LoaderCircle className="spinner" size={20} />{t("Loading Workspaces...")}</div>}
      {!loading && !batch && (
        <div className="batch-selection-layout">
          <div className="batch-selection-main">
            <div className="batch-toolbar">
              <div><strong>{selectedIds.size}</strong> {t("selected")} <span className="batch-toolbar-note">{today ? `${t("Local day")} ${today}` : ""}</span></div>
              <div className="batch-toolbar-actions"><button type="button" onClick={() => setSelectedIds(selectAllEligible(targets))}><ListChecks size={15} />{t("Select all eligible")}</button><button type="button" onClick={() => setSelectedIds(selectNotRefreshedToday(targets, now))}><RefreshCw size={15} />{t("Not refreshed today")}</button></div>
            </div>
            <div className="batch-target-list" aria-label={t("Plugin Workspace refresh targets")}>
              {targets.map((target) => {
                const eligibility = targetEligibility(target, t);
                return <div className={`batch-target-row ${selectedIds.has(target.pluginId) ? "is-selected" : ""} ${!eligibility.eligible ? "is-unavailable" : ""}`} key={target.pluginId}>
                  <input aria-label={t("Select {value}", { value: target.name })} type="checkbox" checked={selectedIds.has(target.pluginId)} disabled={!eligibility.eligible} onChange={() => toggle(target.pluginId)} />
                  <div className="batch-target-main"><strong>{target.name}</strong><small>{target.pluginId} · {freshnessLabel(target, now, undefined, t, locale)}</small><small className="batch-target-exact">{target.lastSuccessfulRefreshAt ? exactLocalTime(target.lastSuccessfulRefreshAt, locale) : t("No successful refresh")}</small><RefreshOptionControls target={target} input={refreshInputs[target.pluginId]} disabled={!eligibility.eligible} onChange={(key, value) => updateRefreshInput(target.pluginId, key, value)} /></div>
                  <span className="batch-target-state"><span>{t(target.state)}</span>{eligibility.warning && <span title={eligibility.warning}><TriangleAlert size={15} aria-label={eligibility.warning} /></span>}{!eligibility.eligible && <small>{eligibility.reason}</small>}</span>
                </div>;
              })}
              {!targets.length && <div className="logs-state"><strong>{t("No Plugin Workspaces found")}</strong></div>}
            </div>
            <div className="batch-submit-bar">
              <span>{selectedIds.size ? `${selectedIds.size} ${t("selected")}` : emptyState}</span>
              <button className="primary-button" type="button" disabled={!selectedExecutable || submitting} onClick={startBatch}>{submitting ? <LoaderCircle className="spinner" size={15} /> : <RefreshCw size={15} />}{t("Start refresh")}</button>
            </div>
          </div>
          {historyPanel}
        </div>
      )}
      {batch && (
        <div className="batch-result-layout">
          <div className="batch-result-main">
            <div className="batch-counts" aria-label={t("Batch counts")}><span><strong>{batch.counts.succeeded}</strong> {t("succeeded")}</span><span><strong>{batch.counts.failed}</strong> {t("failed")}</span><span><strong>{batch.counts.skipped}</strong> {t("skipped")}</span><span><strong>{batch.counts.remaining}</strong> {t("remaining")}</span></div>
            <div className="batch-item-list" aria-label={t("Batch Workspace results")}>
              {targetRows.map(({ item, target }) => <div className="batch-item-row" key={item.pluginId}>
                <span className={`batch-item-icon batch-item-icon--${item.state}`}>{item.state === "running" || item.state === "queued" ? <LoaderCircle className="spinner" size={16} /> : item.state === "succeeded" ? <CheckCircle2 size={16} /> : item.state === "failed" ? <AlertCircle size={16} /> : <CircleOff size={16} />}</span>
                <span className="batch-item-main"><strong>{item.name}</strong><small>{item.pluginId} · {itemStatusLabel(item.state, t)}{item.coalesced ? ` · ${t("followed existing refresh")}` : ""}</small>{item.reason && <small className="batch-item-reason">{item.reason}</small>}{target?.lastSuccessfulRefreshAt && <small className="batch-target-exact">{t("Last success {value}", { value: exactLocalTime(target.lastSuccessfulRefreshAt, locale) })}</small>}</span>
                <span className="batch-item-actions">{item.operationId && <button type="button" onClick={() => onOpenLogs(batch.batchId, item.operationId)}><ExternalLink size={14} />{t("Evidence")}</button>}</span>
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
  const { language, setLanguage, t } = useLanguage();
  const [status, setStatus] = useState<Status>("loading");
  const [message, setMessage] = useState(() => t("Starting plugin services..."));
  const [runtime, setRuntime] = useState<RuntimeInfo>();
  const [view, setView] = useState<HostView>({ kind: "overview" });
  const [dailySummarySelection, setDailySummarySelection] = useState<Set<string>>();
  const [batchId, setBatchId] = useState<string>();
  const [managedKey, setManagedKey] = useState<string>();
  const [browserStatus, setBrowserStatus] = useState<BrowserStatus>();
  const [browserAction, setBrowserAction] = useState<"check" | "reconnect">();
  const [runtimeRestarting, setRuntimeRestarting] = useState(false);
  const [removeKey, setRemoveKey] = useState<string>();
  const [toast, setToast] = useState<ToastNotice>();
  const [logFilters, setLogFilters] = useState<LogFilters>(INITIAL_LOG_FILTERS);
  const [focusedLogId, setFocusedLogId] = useState<string>();
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [marketCatalog, setMarketCatalog] = useState<MarketCatalog>();
  const [marketLoading, setMarketLoading] = useState(false);
  const [marketRefreshing, setMarketRefreshing] = useState(false);
  const [marketOperation, setMarketOperation] = useState<MarketOperation>();
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
      setView({ kind: "overview" });
      setManagedKey(info.plugins[0]?.id ?? info.rejectedPlugins[0]?.package);
    }).catch((error: unknown) => {
      setMessage(error instanceof Error ? t(error.message) : t("Plugin services did not start."));
      setStatus("error");
    });
  }, []);

  useEffect(() => {
    if (status !== "ready" || !runtime || view.kind !== "settings" || !runtime.plugins.some((plugin) => plugin.browserDependent)) return;
    let active = true;
    runtimeRequest<BrowserStatus>(runtime, "/api/v1/browser-status")
      .then((next) => { if (active) setBrowserStatus(next); })
      .catch(() => {});
    return () => { active = false; };
  }, [status, runtime?.origin, view.kind]);

  useEffect(() => {
    if (status !== "ready") return;
    const timer = window.setInterval(() => refreshInfo().catch(() => {
      setRuntimeRestarting(true);
      setDailySummarySelection(undefined);
    }), 1_500);
    return () => window.clearInterval(timer);
  }, [status]);

  useEffect(() => {
    if (status !== "ready" || !runtime?.daemon) return;
    const source = new EventSource(`${runtime.origin}/api/v1/events`, { withCredentials: true });
    const onDaemonEvent = (event: MessageEvent<string>) => {
      try {
        const value = JSON.parse(event.data) as { event?: string; title?: string; message?: string };
        if (value.event === "notification-intent" && value.title && value.message) showNotice(`${value.title}: ${value.message}`);
      } catch {}
    };
    source.addEventListener("daemon", onDaemonEvent);
    return () => { source.removeEventListener("daemon", onDaemonEvent); source.close(); };
  }, [status, runtime?.origin]);

  useEffect(() => {
    if (status !== "ready" || !runtime) return;
    let active = true;
    const checkBatches = async () => {
      try {
        const response = await runtimeRequest<{ activeBatch?: BatchSummary; batches: BatchSummary[] }>(runtime, "/api/v1/batches");
        if (!active) return;
        const batches = new Map(response.batches.map((batch) => [batch.batchId, batch]));
        if (response.activeBatch) batches.set(response.activeBatch.batchId, response.activeBatch);
        for (const batch of batches.values()) {
          const notice = batchCompletionNotice(batch, observedBatchIds.current, notifiedBatchIds.current);
          if (notice) showNotice({ ...notice, actionLabel: t("View results"), message: t("Batch refresh {status}: {succeeded} succeeded, {failed} failed, {skipped} skipped, {interrupted} interrupted", { status: t(({ succeeded: "completed", partial: "partially completed", failed: "failed", skipped: "skipped", interrupted: "interrupted" } as Record<string, string>)[batch.status] ?? batch.status), succeeded: batch.counts.succeeded, failed: batch.counts.failed, skipped: batch.counts.skipped, interrupted: batch.counts.interrupted }) });
        }
      } catch {}
    };
    void checkBatches();
    const timer = window.setInterval(checkBatches, 900);
    return () => { active = false; window.clearInterval(timer); };
  }, [status, runtime?.origin, t]);

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

  useEffect(() => {
    if (view.kind !== "market" || !runtime) return;
    let active = true;
    setMarketLoading(true);
    runtimeRequest<MarketCatalog>(runtime, "/api/v1/market/catalog").then((catalog) => {
      if (active) setMarketCatalog(catalog);
    }).catch((error) => {
      if (active) showNotice(error instanceof Error ? error.message : t("Market catalog is unavailable."));
    }).finally(() => { if (active) setMarketLoading(false); });
    return () => { active = false; };
  }, [view.kind, runtime?.origin]);

  const { theme, actualTheme, changeTheme } = useTheme(runtime, setRuntime, iframeRef, view);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(undefined), 4500);
    return () => window.clearTimeout(timer);
  }, [toast]);

  useEffect(() => {
    const closeDialog = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (removeKey) setRemoveKey(undefined);
    };
    window.addEventListener("keydown", closeDialog);
    return () => window.removeEventListener("keydown", closeDialog);
  }, [removeKey]);

  const selected = useMemo(
    () => view.kind === "plugin" ? runtime?.plugins.find((plugin) => plugin.id === view.id) : undefined,
    [runtime, view],
  );
  const managed = runtime?.plugins.find((plugin) => plugin.id === managedKey);
  const rejected = runtime?.rejectedPlugins.find((plugin) => plugin.package === managedKey);
  const workspaceSrc = selected
    ? `${selected.workspaceUrl}?pluginId=${encodeURIComponent(selected.id)}&apiBaseUrl=${encodeURIComponent(selected.apiBaseUrl)}&capabilities=${encodeURIComponent(JSON.stringify(selected.capabilities ?? {}))}&theme=${actualTheme}`
    : undefined;

  const selectPlugin = async (plugin: RuntimePlugin) => {
    setView({ kind: "plugin", id: plugin.id });
    if (available(plugin) && runtime) {
      await runtimeRequest(runtime, "/api/v1/host/state", { method: "PATCH", body: JSON.stringify({ lastSelection: plugin.id }) }).catch(() => {});
    }
  };

  const openBatchRefresh = async () => {
    if (!runtime) return;
    try {
      const result = await runtimeRequest<{ activeBatch?: BatchSummary }>(runtime, "/api/v1/batches");
      if (result.activeBatch) observeBatch(result.activeBatch.batchId);
      setBatchId(result.activeBatch?.batchId);
      setView({ kind: "batch" });
    } catch (reason) {
      showNotice(reason instanceof Error ? reason.message : t("Batch refresh is unavailable."));
    }
  };

  const mutate = async (action: () => Promise<unknown>, success: string) => {
    try { await action(); await refreshInfo(); showNotice(success); }
    catch (error) { showNotice(error instanceof Error ? error.message : t("Operation failed")); }
  };

  const install = async () => {
    if (!runtime) return;
    const sourcePath = window.infolens ? await window.infolens.selectPluginFolder() : window.prompt(t("Plugin folder path"));
    if (!sourcePath) return;
    await mutate(async () => {
      const result = await runtimeRequest<{ pluginId: string }>(runtime, "/api/v1/plugins/install", { method: "POST", body: JSON.stringify({ sourcePath }) });
      setManagedKey(result.pluginId);
      setView({ kind: "plugins" });
    }, t("Plugin folder installed and enabled"));
  };

  const importArchive = async () => {
    if (!runtime) return;
    const archivePath = window.infolens ? await window.infolens.selectPluginArchive() : window.prompt(t("Plugin ZIP path"));
    if (!archivePath) return;
    await mutate(async () => {
      const result = await runtimeRequest<{ pluginId: string }>(runtime, "/api/v1/plugins/install-archive", { method: "POST", body: JSON.stringify({ archivePath }) });
      setManagedKey(result.pluginId);
      setView({ kind: "plugins" });
    }, t("Plugin ZIP imported and enabled"));
  };

  const refreshMarket = async () => {
    if (!runtime) return;
    setMarketRefreshing(true);
    try {
      await runtimeRequest(runtime, "/api/v1/market/refresh", { method: "POST" });
      setMarketCatalog(await runtimeRequest<MarketCatalog>(runtime, "/api/v1/market/catalog"));
      showNotice(t("Market catalog refreshed"));
    }
    catch (error) {
      await runtimeRequest<MarketCatalog>(runtime, "/api/v1/market/catalog").then(setMarketCatalog).catch(() => {});
      showNotice(error instanceof Error ? error.message : t("Market refresh failed."));
    }
    finally { setMarketRefreshing(false); }
  };

  const installMarket = async (release: MarketRelease) => {
    if (!runtime) return;
    try {
      const result = await runtimeRequest<{ operationId: string }>(runtime, "/api/v1/market/install", { method: "POST", body: JSON.stringify({ pluginId: release.pluginId, version: release.version }) });
      setMarketOperation(await runtimeRequest<MarketOperation>(runtime, `/api/v1/market/operations/${encodeURIComponent(result.operationId)}`));
      await refreshInfo();
      showNotice(t("{name} installed and enabled", { name: release.name }));
    } catch (error) { showNotice(error instanceof Error ? error.message : t("Market installation failed.")); }
  };

  const cancelMarket = () => {
    if (marketOperation && runtime) void runtimeRequest(runtime, `/api/v1/market/operations/${encodeURIComponent(marketOperation.operationId)}/cancel`, { method: "POST" });
  };

  const retryMarket = async () => {
    if (!marketOperation || !runtime) return;
    try {
      const result = await runtimeRequest<{ operationId: string }>(runtime, `/api/v1/market/operations/${encodeURIComponent(marketOperation.operationId)}/retry`, { method: "POST" });
      setMarketOperation(await runtimeRequest<MarketOperation>(runtime, `/api/v1/market/operations/${encodeURIComponent(result.operationId)}`));
      await refreshInfo();
      showNotice(t("{name} installed and enabled", { name: marketOperation.pluginId }));
    } catch (error) { showNotice(error instanceof Error ? error.message : t("Market retry failed.")); }
  };

  const checkBridge = async () => {
    if (!runtime) return;
    setBrowserAction("check");
    try {
      setBrowserStatus(await runtimeRequest<BrowserStatus>(runtime, "/api/v1/browser-status/check", { method: "POST" }));
    } catch (error) {
      const failedStatus = browserStatusFromError(error);
      if (failedStatus) setBrowserStatus(failedStatus);
      showNotice(error instanceof Error ? error.message : t("Browser connection check failed."));
    } finally {
      setBrowserAction(undefined);
    }
  };

  const reconnectBridge = async () => {
    if (!runtime) return;
    setBrowserAction("reconnect");
    try {
      setBrowserStatus(await runtimeRequest<BrowserStatus>(runtime, "/api/v1/browser-status/reconnect", { method: "POST" }));
    } catch (error) {
      const failedStatus = browserStatusFromError(error);
      if (failedStatus) setBrowserStatus(failedStatus);
      showNotice(error instanceof Error ? error.message : t("Browser reconnection failed."));
    } finally {
      setBrowserAction(undefined);
    }
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

  useEffect(() => {
    const togglePalette = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setPaletteOpen((open) => !open);
      }
    };
    window.addEventListener("keydown", togglePalette);
    return () => window.removeEventListener("keydown", togglePalette);
  }, []);

  const commands = useMemo<CommandItem[]>(() => {
    const goTo: CommandItem[] = [
      { id: "view-overview", group: t("Go to"), label: t("Overview"), action: () => setView({ kind: "overview" }) },
      { id: "view-market", group: t("Go to"), label: t("Plugin Market"), action: () => setView({ kind: "market" }) },
      { id: "view-plugins", group: t("Go to"), label: t("Plugins"), action: () => setView({ kind: "plugins" }) },
      { id: "view-daily-summary", group: t("Go to"), label: t("Daily Summary"), action: () => setView({ kind: "daily-summary" }) },
      { id: "view-batch", group: t("Go to"), label: t("Batch refresh"), action: () => void openBatchRefresh() },
      { id: "view-logs", group: t("Go to"), label: t("Logs"), action: () => setView({ kind: "logs" }) },
      { id: "view-settings", group: t("Go to"), label: t("Settings"), action: () => setView({ kind: "settings" }) },
    ];
    const workspaces: CommandItem[] = (runtime?.plugins ?? []).filter(available).map((plugin) => ({
      id: `plugin-${plugin.id}`,
      group: t("Workspaces"),
      label: plugin.name,
      hint: plugin.id,
      action: () => void selectPlugin(plugin),
    }));
    const actions: CommandItem[] = [
      { id: "action-install-folder", group: t("Actions"), label: t("Install local plugin folder"), action: () => void install() },
      { id: "action-import-archive", group: t("Actions"), label: t("Import plugin ZIP"), action: () => void importArchive() },
      { id: "theme-system", group: t("Actions"), label: t("Theme: System"), action: () => void changeTheme("system") },
      { id: "theme-light", group: t("Actions"), label: t("Theme: Light"), action: () => void changeTheme("light") },
      { id: "theme-dark", group: t("Actions"), label: t("Theme: Dark"), action: () => void changeTheme("dark") },
    ];
    if (runtime?.plugins.some((plugin) => plugin.browserDependent)) {
      actions.push({ id: "action-bridge-check", group: t("Actions"), label: t("Check browser connection"), action: () => void checkBridge() });
    }
    return [...goTo, ...workspaces, ...actions];
  }, [runtime, actualTheme, t]);

  return (
    <div className="app-shell">
      <InstrumentRail runtime={runtime} view={view} onSelectPlugin={(plugin) => void selectPlugin(plugin)} onOpenView={setView} onOpenBatch={() => void openBatchRefresh()} onOpenPalette={() => setPaletteOpen(true)} />

      <main className="main-area">
        {runtimeRestarting && <div className="restart-bar" role="status"><LoaderCircle className="spinner" size={15} /> {t("Restarting plugin services...")}</div>}
        {view.kind === "logs" && <LogsView runtime={runtime} filters={logFilters} setFilters={setLogFilters} focusEntryId={focusedLogId} onNotice={showNotice} />}
        {view.kind !== "logs" && status === "loading" && <div className="system-state" role="status"><LoaderCircle className="spinner" size={24} /><p>{message}</p></div>}
        {view.kind !== "logs" && status === "error" && <div className="system-state system-state--error" role="alert"><h1>{t("Plugin services unavailable")}</h1><p>{message}</p></div>}
        {status === "ready" && view.kind === "plugin" && selected && selected.state === "disabled" && (
          <div className="system-state"><CircleOff size={28} /><h1>{selected.name} {t("is disabled")}</h1><button className="primary-button" onClick={() => runtime && mutate(() => runtimeRequest(runtime, `/api/v1/plugins/${selected.id}/enabled`, { method: "POST", body: JSON.stringify({ enabled: true }) }), t("{name} enabled", { name: selected.name }))}>{t("Enable in Plugins")}</button></div>
        )}
        {status === "ready" && view.kind === "plugin" && workspaceSrc && selected?.state !== "disabled" && <iframe ref={iframeRef} className="workspace-frame" src={workspaceSrc} title={`${selected?.name ?? t("Plugin")} ${t("workspace")}`} allow="clipboard-write" />}
        {status === "ready" && view.kind === "overview" && runtime && <OverviewView runtime={runtime} onOpenPlugin={(plugin) => void selectPlugin(plugin)} onOpenBatch={() => void openBatchRefresh()} onOpenDailySummary={() => setView({ kind: "daily-summary" })} onOpenSettings={() => setView({ kind: "settings" })} />}
        {status === "ready" && view.kind === "market" && <MarketView catalog={marketCatalog} loading={marketLoading} refreshing={marketRefreshing} operation={marketOperation} onRefresh={() => void refreshMarket()} onInstall={installMarket} onCancel={cancelMarket} onRetry={() => void retryMarket()} />}
        {status === "ready" && view.kind === "batch" && runtime && <BatchRefreshView runtime={runtime} initialBatchId={batchId} onBatchIdChange={setBatchId} onBatchStarted={observeBatch} onOpenLogs={openBatchLogs} />}
        {status === "ready" && !runtimeRestarting && view.kind === "daily-summary" && runtime && <DailySummaryView runtime={runtime} onOpenBatch={openBatchRefresh} onNotice={showNotice} selectedPluginIds={dailySummarySelection} onSelectionChange={setDailySummarySelection} />}
        {status === "ready" && view.kind === "plugins" && runtime && (
          <section className="host-page plugin-manager">
            <header className="page-header"><div><h1>{t("Plugins")}</h1><p>{t("Installed packages and local diagnostics")}</p></div><div className="page-header-actions"><button type="button" onClick={install}><FolderPlus size={17} />{t("Install folder")}</button><button type="button" className="primary-button" onClick={importArchive}><FileArchive size={17} />{t("Import ZIP")}</button></div></header>
            <div className="manager-layout">
              <div className="package-list" role="listbox" aria-label={t("Installed plugins")}>
                {runtime.plugins.map((plugin) => <button key={plugin.id} className={managedKey === plugin.id ? "package-row selected" : "package-row"} onClick={() => setManagedKey(plugin.id)}><span className={`source-icon source-icon--${plugin.id}`}>{sourceInitial(plugin)}</span><span><strong>{plugin.name}</strong><small>{plugin.version}</small></span><Lifecycle state={plugin.state} /></button>)}
                {runtime.rejectedPlugins.map((plugin) => <button key={plugin.package} className={managedKey === plugin.package ? "package-row selected" : "package-row"} onClick={() => setManagedKey(plugin.package)}><span className="source-icon"><TriangleAlert size={15} /></span><span><strong>{plugin.name ?? plugin.package}</strong><small>{t("Incompatible")}</small></span><AlertCircle className="danger" size={15} /></button>)}
              </div>
              <div className="package-detail">
                {managed?.provenance && <div className="package-provenance"><strong>{t("Origin")}: {managed.origin ?? managed.provenance.origin}</strong>{managed.releaseStatus && <span>{t("Release status")}: {t(managed.releaseStatus)}</span>}{managed.provenance.publisher && <span>{t("Publisher")}: {managed.provenance.publisher}</span>}{managed.provenance.expectedSha256 && <span className="path-value">SHA-256: {managed.provenance.expectedSha256}</span>}</div>}
                {managed && <><div className="detail-title"><span className="detail-title-copy"><h2>{managed.name}</h2><p>{managed.id} · {managed.version}</p></span><label className="toggle"><input type="checkbox" checked={managed.enabled} onChange={(event) => mutate(() => runtimeRequest(runtime, `/api/v1/plugins/${managed.id}/enabled`, { method: "POST", body: JSON.stringify({ enabled: event.target.checked }) }), event.target.checked ? t("{name} enabled", { name: managed.name }) : t("{name} disabled", { name: managed.name }))} /><span />{t("Enabled")}</label></div><dl className="package-facts"><dt>{t("State")}</dt><dd>{t(managed.state)}</dd><dt>{t("Package")}</dt><dd className="path-value">{managed.packagePath}</dd><dt>{t("Last successful refresh")}</dt><dd>{managed.statusSnapshot?.lastSuccessfulRefreshAt ?? t("Not yet recorded")}</dd>{managed.statusSnapshot?.failure && <><dt>{t("Latest failure")}</dt><dd className="failure-summary"><span>{managed.statusSnapshot.failure.code}: {managed.statusSnapshot.failure.message}</span><button type="button" onClick={() => openFailureLogs(managed.id, managed.statusSnapshot!.failure!)}>{t("View matching logs")}</button></dd></>}</dl><div className="detail-actions"><button onClick={() => mutate(async () => { const value = await runtimeRequest<{ diagnostics: string }>(runtime, `/api/v1/plugins/${managed.id}/diagnostics`); if (window.infolens) await window.infolens.copyText(value.diagnostics); else await navigator.clipboard.writeText(value.diagnostics); }, t("Diagnostics copied"))}><Copy size={16} />{t("Copy diagnostics")}</button><button className="danger-button" onClick={() => setRemoveKey(managed.id)}><Trash2 size={16} />{t("Remove plugin")}</button></div></>}
                {rejected && <><div className="detail-title"><span className="detail-title-copy"><h2>{rejected.name ?? rejected.package}</h2><p>{rejected.version ?? t("Invalid package")}</p></span><span className="incompatible">{t("Incompatible")}</span></div><div className="failure-panel"><strong>{rejected.code}</strong><p>{rejected.message}</p></div><dl className="package-facts"><dt>{t("Package")}</dt><dd className="path-value">{rejected.packagePath}</dd></dl><div className="detail-actions"><button className="danger-button" onClick={() => setRemoveKey(rejected.package)}><Trash2 size={16} />{t("Remove package")}</button></div></>}
              </div>
            </div>
          </section>
        )}
        {status === "ready" && view.kind === "settings" && (
          <section className="host-page">
            <header className="page-header"><div><h1>{t("Settings")}</h1><p>{t("Application preferences")}</p></div></header>
            <div className="settings-section">
              <h2>{t("Appearance")}</h2>
              <div className="setting-row"><span><strong>{t("Theme")}</strong><small>{t("Applied to the host and open plugin workspace")}</small></span><div className="segmented" aria-label={t("Theme")}>{(["system", "light", "dark"] as ThemePreference[]).map((item) => <button aria-pressed={theme === item} className={theme === item ? "active" : ""} key={item} onClick={() => changeTheme(item)}>{t(item[0].toUpperCase() + item.slice(1))}</button>)}</div></div>
              <div className="setting-row"><span><strong>{t("Language")}</strong><small>{t("Choose the language used by the Host Shell")}</small></span><div className="segmented" aria-label={t("Language")}><button aria-pressed={language === "zh-CN"} className={language === "zh-CN" ? "active" : ""} onClick={() => setLanguage("zh-CN")}>{t("中文")}</button><button aria-pressed={language === "en-US"} className={language === "en-US" ? "active" : ""} onClick={() => setLanguage("en-US")}>{t("English")}</button></div></div>
            </div>
            {runtime && runtime.plugins.some((plugin) => plugin.browserDependent) && <div className="settings-section">
              <h2>{t("Browser Bridge")}</h2>
              <BridgePanel status={browserStatus} action={browserAction} onCheck={() => void checkBridge()} onReconnect={() => void reconnectBridge()} />
            </div>}
          </section>
        )}
      </main>

      {removeKey && runtime && <div className="dialog-scrim"><div className="dialog" role="dialog" aria-modal="true" aria-labelledby="remove-title"><TriangleAlert className="dialog-symbol danger" size={26} /><h2 id="remove-title">{t("Remove plugin?")}</h2><p>{t("The package, Plugin-owned data, Adapter Scope, Host State entries, and retained logs will be permanently deleted.")}</p><div className="dialog-actions"><button onClick={() => setRemoveKey(undefined)}>{t("Cancel")}</button><button className="danger-button" onClick={() => mutate(async () => { await runtimeRequest(runtime, `/api/v1/plugins/${encodeURIComponent(removeKey)}/remove`, { method: "DELETE" }); setRemoveKey(undefined); setManagedKey(undefined); }, t("Plugin removed"))}>{t("Remove plugin")}</button></div></div></div>}
      {toast && <div className="toast" role="status"><span>{toast.message}</span>{toast.batchId && <button type="button" onClick={() => { setBatchId(toast.batchId); setView({ kind: "batch" }); setToast(undefined); }}><ExternalLink size={14} />{toast.actionLabel ?? t("View results")}</button>}</div>}
      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} commands={commands} />
    </div>
  );
}
