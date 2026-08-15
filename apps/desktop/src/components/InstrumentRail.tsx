import { AlertCircle, CircleOff, FileText, LayoutDashboard, LoaderCircle, Plug, RefreshCw, ScrollText, Search, Settings, Store } from "lucide-react";
import type { HostView } from "../host-view";

export function sourceInitial(plugin: RuntimePlugin) {
  if (plugin.id === "hn") return "Y";
  if (plugin.id === "github-trending") return "GH";
  return plugin.name.slice(0, 2);
}

export function Lifecycle({ state }: { state: string }) {
  if (["refreshing", "queued", "starting"].includes(state)) return <LoaderCircle className="lifecycle spinner" aria-label={state} size={15} />;
  if (state === "failed") return <AlertCircle className="lifecycle danger" aria-label="Failed" size={15} />;
  if (state === "unavailable") return <CircleOff className="lifecycle danger" aria-label="Unavailable" size={15} />;
  if (state === "disabled") return <CircleOff className="lifecycle muted" aria-label="Disabled" size={15} />;
  return <span className="running-dot" aria-label="Running" />;
}

interface InstrumentRailProps {
  runtime?: RuntimeInfo;
  view: HostView;
  onSelectPlugin: (plugin: RuntimePlugin) => void;
  onOpenView: (view: HostView) => void;
  onOpenBatch: () => void;
  onOpenPalette: () => void;
}

export function InstrumentRail({ runtime, view, onSelectPlugin, onOpenView, onOpenBatch, onOpenPalette }: InstrumentRailProps) {
  return (
    <aside className="sidebar" aria-label="Infolens navigation">
      <header className="brand"><span className="brand-mark" aria-hidden="true">IL</span><span>Infolens</span></header>
      <button className="command-trigger" type="button" aria-keyshortcuts="Control+K Meta+K" onClick={onOpenPalette}>
        <Search size={15} aria-hidden="true" /><span>Command...</span><kbd>Ctrl K</kbd>
      </button>
      <nav className="plugin-nav" aria-label="Plugins">
        <button className={`nav-item utility ${view.kind === "overview" ? "is-selected" : ""}`} onClick={() => onOpenView({ kind: "overview" })} type="button"><span className="utility-icon"><LayoutDashboard size={17} /></span><span className="nav-label">Overview</span></button>
        <div className="nav-caption">Sources</div>
        {runtime?.plugins.map((plugin) => (
          <button className={`nav-item ${view.kind === "plugin" && plugin.id === view.id ? "is-selected" : ""}`} key={plugin.id} onClick={() => onSelectPlugin(plugin)} type="button">
            <span className={`source-icon source-icon--${plugin.id}`} aria-hidden="true">{sourceInitial(plugin)}</span>
            <span className="nav-label">{plugin.name}</span>
            {plugin.badge ? <span className="nav-badge">{plugin.badge}</span> : <span />}
            <Lifecycle state={plugin.state} />
          </button>
        ))}
      </nav>
      <nav className="utility-nav" aria-label="Application">
        <button className={`nav-item utility ${view.kind === "market" ? "is-selected" : ""}`} onClick={() => onOpenView({ kind: "market" })} type="button"><span className="utility-icon"><Store size={17} /></span><span className="nav-label">Plugin Market</span></button>
        <button className={`nav-item utility ${view.kind === "plugins" ? "is-selected" : ""}`} onClick={() => onOpenView({ kind: "plugins" })} type="button"><span className="utility-icon"><Plug size={17} /></span><span className="nav-label">Plugins</span></button>
        <button className={`nav-item utility ${view.kind === "daily-summary" ? "is-selected" : ""}`} onClick={() => onOpenView({ kind: "daily-summary" })} type="button"><span className="utility-icon"><FileText size={17} /></span><span className="nav-label">Daily Summary</span></button>
        <button className={`nav-item utility ${view.kind === "batch" ? "is-selected" : ""}`} onClick={onOpenBatch} type="button"><span className="utility-icon"><RefreshCw size={17} /></span><span className="nav-label">Batch refresh</span>{runtime?.activeBatch && <span className="nav-badge">{runtime.activeBatch.counts.remaining}</span>}</button>
        <button className={`nav-item utility ${view.kind === "logs" ? "is-selected" : ""}`} onClick={() => onOpenView({ kind: "logs" })} type="button"><span className="utility-icon"><ScrollText size={17} /></span><span className="nav-label">Logs</span></button>
        <button className={`nav-item utility ${view.kind === "settings" ? "is-selected" : ""}`} onClick={() => onOpenView({ kind: "settings" })} type="button"><span className="utility-icon"><Settings size={17} /></span><span className="nav-label">Settings</span></button>
      </nav>
    </aside>
  );
}
