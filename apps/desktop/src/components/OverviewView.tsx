import { useEffect, useState } from "react";
import { ArrowRight, LoaderCircle, RefreshCw, TriangleAlert } from "lucide-react";
import { runtimeRequest } from "../runtime-api";
import type { DailySummaryAggregate } from "../daily-summary";
import { sourceInitial } from "./InstrumentRail";

interface OverviewViewProps {
  runtime: RuntimeInfo;
  onOpenPlugin: (plugin: RuntimePlugin) => void;
  onOpenBatch: () => void;
  onOpenDailySummary: () => void;
  onOpenSettings: () => void;
}

function relativeAge(iso: string | undefined, now: Date): string {
  if (!iso) return "No successful refresh";
  const elapsed = now.getTime() - new Date(iso).getTime();
  if (elapsed < 60_000) return "Refreshed just now";
  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 60) return `Refreshed ${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `Refreshed ${hours} h ago`;
  return `Refreshed ${Math.floor(hours / 24)} d ago`;
}

/** Freshness as a 0..1 meter: full at the last successful refresh, empty after 24 h. */
function freshness(iso: string | undefined, now: Date): number {
  if (!iso) return 0;
  const hours = Math.max(0, now.getTime() - new Date(iso).getTime()) / 3_600_000;
  return Math.max(0, Math.min(1, 1 - hours / 24));
}

function stateTone(state: string): "ok" | "busy" | "bad" | "muted" {
  if (["refreshing", "queued", "starting"].includes(state)) return "busy";
  if (["failed", "unavailable", "cancelled"].includes(state)) return "bad";
  if (state === "disabled") return "muted";
  return "ok";
}

function bridgeTone(overall: BrowserStatusOverall | undefined): "ok" | "warn" | "bad" | "muted" {
  if (overall === "connected") return "ok";
  if (overall === "degraded") return "warn";
  if (overall === "disconnected") return "bad";
  return "muted";
}

export function OverviewView({ runtime, onOpenPlugin, onOpenBatch, onOpenDailySummary, onOpenSettings }: OverviewViewProps) {
  const [now, setNow] = useState(() => new Date());
  const [summary, setSummary] = useState<DailySummaryAggregate>();
  const [summaryState, setSummaryState] = useState<"loading" | "ready" | "error">("loading");
  const [bridge, setBridge] = useState<BrowserStatus>();
  const [bridgeState, setBridgeState] = useState<"loading" | "ready" | "error">("loading");
  const browserDependent = runtime.plugins.filter((plugin) => plugin.browserDependent);
  const batch = runtime.activeBatch;

  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    let active = true;
    setSummaryState("loading");
    runtimeRequest<DailySummaryAggregate>(runtime, "/runtime/daily-summary")
      .then((next) => { if (active) { setSummary(next); setSummaryState("ready"); } })
      .catch(() => { if (active) setSummaryState("error"); });
    return () => { active = false; };
  }, [runtime.origin]);

  useEffect(() => {
    if (!browserDependent.length) return;
    let active = true;
    setBridgeState("loading");
    runtimeRequest<BrowserStatus>(runtime, "/runtime/browser-status")
      .then((next) => { if (active) { setBridge(next); setBridgeState("ready"); } })
      .catch(() => { if (active) setBridgeState("error"); });
    return () => { active = false; };
  }, [runtime.origin, browserDependent.length]);

  return (
    <section className="host-page overview-page">
      <header className="overview-header">
        <span className="overview-weekday">{now.toLocaleDateString(undefined, { weekday: "long" })}</span>
        <h1>{now.toLocaleDateString(undefined, { month: "long", day: "numeric" })}</h1>
        <p>Signal deck · {runtime.plugins.length} {runtime.plugins.length === 1 ? "source" : "sources"} on this device</p>
      </header>

      <div className="signal-grid" aria-label="Source signals">
        {runtime.plugins.map((plugin) => {
          const lastRefresh = plugin.statusSnapshot?.lastSuccessfulRefreshAt;
          const tone = stateTone(plugin.state);
          return (
            <button className={`signal-card signal-card--${plugin.id}`} type="button" key={plugin.id} onClick={() => onOpenPlugin(plugin)}>
              <span className="signal-card-top">
                <span className={`source-icon source-icon--${plugin.id}`} aria-hidden="true">{sourceInitial(plugin)}</span>
                <span className={`ov-pill ov-pill--${tone}`}>{plugin.state}</span>
              </span>
              <span className="signal-card-name">{plugin.name}</span>
              <span className="signal-card-meta">
                {plugin.badge !== undefined && <span className="signal-card-badge">{plugin.badge} new</span>}
                <span>{relativeAge(lastRefresh, now)}</span>
              </span>
              <span className="fresh-meter" aria-hidden="true"><span className="fresh-fill" style={{ width: `${Math.round(freshness(lastRefresh, now) * 100)}%` }} /></span>
            </button>
          );
        })}
        {!runtime.plugins.length && <div className="logs-state"><strong>No sources installed</strong><span>Install a plugin to see signals here.</span></div>}
      </div>

      <section className="ov-band" aria-label="Batch refresh status">
        <div className="ov-band-head">
          <h2>{batch ? "Batch in progress" : "Batch refresh"}</h2>
          {batch
            ? <button className="ov-band-action" type="button" onClick={onOpenBatch}>Open batch<ArrowRight size={14} /></button>
            : <button className="ov-band-action" type="button" onClick={onOpenBatch}><RefreshCw size={14} />Start refresh</button>}
        </div>
        {batch && (
          <>
            <div className="ov-band-counts">
              <span><strong>{batch.counts.succeeded}</strong> succeeded</span>
              <span><strong>{batch.counts.failed}</strong> failed</span>
              <span><strong>{batch.counts.remaining}</strong> remaining</span>
            </div>
            <div className="ov-band-rows">
              {batch.items.map((item) => (
                <div className="ov-band-row" key={item.pluginId}>
                  <span className="ov-band-row-name">{item.name}</span>
                  <span className={`ov-pill ov-pill--${item.state === "succeeded" ? "ok" : item.state === "failed" ? "bad" : item.state === "running" || item.state === "queued" ? "busy" : "muted"}`}>{item.state}</span>
                </div>
              ))}
            </div>
          </>
        )}
        {!batch && <p className="ov-band-note">No batch is running. Start one to refresh every source at once.</p>}
      </section>

      <div className="ov-duo">
        <section className="ov-card" aria-label="Daily Summary status">
          <div className="ov-card-head"><h2>Daily Summary</h2><button className="ov-card-action" type="button" onClick={onOpenDailySummary}>Open<ArrowRight size={14} /></button></div>
          {summaryState === "loading" && <div className="ov-card-state" role="status"><LoaderCircle className="spinner" size={16} /></div>}
          {summaryState === "error" && <div className="ov-card-state"><span>Daily Summary data is unavailable.</span></div>}
          {summaryState === "ready" && summary && (
            <>
              <div className="ov-card-meta"><span>{summary.localDate}</span><span>Generated {summary.generatedAt}</span></div>
              <div className="ov-status-rows">
                {summary.plugins.filter((plugin) => plugin.status !== "disabled").map((plugin) => (
                  <div className="ov-status-row" key={plugin.pluginId}>
                    <span>{plugin.name}</span>
                    <span className={`daily-summary-status daily-summary-status--${plugin.status}`}>{plugin.status}</span>
                  </div>
                ))}
                {!summary.plugins.length && <div className="ov-card-state"><span>No enabled plugins participate.</span></div>}
              </div>
            </>
          )}
        </section>

        {browserDependent.length > 0 && (
          <section className="ov-card" aria-label="Browser Bridge status">
            <div className="ov-card-head"><h2>Browser Bridge</h2><button className="ov-card-action" type="button" onClick={onOpenSettings}>Settings<ArrowRight size={14} /></button></div>
            {bridgeState === "loading" && <div className="ov-card-state" role="status"><LoaderCircle className="spinner" size={16} /></div>}
            {bridgeState === "error" && <div className="ov-card-state"><TriangleAlert size={15} /><span>Bridge status could not be read.</span></div>}
            {bridgeState === "ready" && (
              <div className="ov-bridge">
                <span className={`ov-pill ov-pill--${bridgeTone(bridge?.overall)}`}>{bridge?.overall ?? "unknown"}</span>
                <span className="ov-card-meta">{bridge?.checkedAt ? `Last checked ${new Date(bridge.checkedAt).toLocaleString()}` : "Not checked yet"}</span>
                {Boolean(bridge?.affected.length) && <span className="ov-card-meta">Affects {bridge!.affected.map((plugin) => plugin.name).join(", ")}</span>}
              </div>
            )}
          </section>
        )}
      </div>
    </section>
  );
}
