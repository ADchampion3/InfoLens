import { AlertCircle, ArrowRight, CheckCircle2, CircleOff, LoaderCircle, RefreshCw, Server, Terminal } from "lucide-react";
import { useLanguage } from "./i18n";

interface DaemonPageProps {
  connectionState: "loading" | "ready" | "error";
  message: string;
  runtime?: RuntimeInfo;
  health?: DaemonHealth;
  checkedAt?: string;
  action?: "start" | "refresh";
  canStart: boolean;
  onRefresh: () => void;
  onStart: () => void;
  onOpenAutomation: () => void;
}

function stateTone(state: string): "ok" | "busy" | "bad" | "muted" {
  if (["starting", "restarting", "loading"].includes(state)) return "busy";
  if (["unavailable", "stopped", "failed"].includes(state)) return "bad";
  if (state === "ready") return "ok";
  return "muted";
}

function stateIcon(state: string) {
  if (["starting", "restarting", "loading"].includes(state)) return <LoaderCircle className="spinner" size={18} />;
  if (["unavailable", "stopped", "failed"].includes(state)) return <CircleOff size={18} />;
  return <CheckCircle2 size={18} />;
}

export function DaemonPage({ connectionState, message, runtime, health, checkedAt, action, canStart, onRefresh, onStart, onOpenAutomation }: DaemonPageProps) {
  const { t, locale } = useLanguage();
  const daemonMode = Boolean(runtime?.daemon);
  const state = connectionState === "loading"
    ? "starting"
    : connectionState === "error"
      ? "unavailable"
      : health?.state ?? runtime?.daemon?.state ?? (daemonMode ? "unknown" : "not in daemon mode");
  const tone = stateTone(state);
  const connected = connectionState === "ready" && daemonMode;
  const lastChecked = checkedAt ? new Date(checkedAt).toLocaleString(locale) : undefined;

  return (
    <section className="host-page daemon-page">
      <header className="page-header">
        <div>
          <p className="eyebrow"><Server size={14} /> {t("Host service")}</p>
          <h1>{t("Daemon")}</h1>
          <p>{t("The daemon owns Plugin Runtime, schedules, and delivery state.")}</p>
        </div>
        <div className="page-header-actions">
          <button type="button" onClick={onRefresh} disabled={Boolean(action)}>
            {action === "refresh" ? <LoaderCircle className="spinner" size={16} /> : <RefreshCw size={16} />}
            {t("Check status")}
          </button>
          <button type="button" className="primary-button" onClick={onStart} disabled={Boolean(action) || !canStart}>
            {action === "start" ? <LoaderCircle className="spinner" size={16} /> : <RefreshCw size={16} />}
            {connected ? t("Reconnect daemon") : t("Start daemon")}
          </button>
        </div>
      </header>

      <div className="daemon-layout">
        <div className="daemon-main">
          <section className="daemon-status-card" aria-label={t("Daemon status")}>
            <div className="daemon-status-heading">
              <div className={`daemon-status-icon daemon-status-icon--${tone}`}>{stateIcon(state)}</div>
              <div><span className="section-kicker">{t("DAEMON STATUS")}</span><h2>{t(state)}</h2><p>{connectionState === "error" ? message : connected ? t("Daemon is serving the Host Shell.") : t("Plugin Runtime is not running in daemon mode.")}</p></div>
            </div>
            <dl className="daemon-facts">
              <dt>{t("Endpoint")}</dt><dd className="path-value">{runtime?.origin ?? t("Not connected")}</dd>
              <dt>{t("Version")}</dt><dd>{health?.daemon?.version ?? t("Unknown")}</dd>
              <dt>{t("Plugins")}</dt><dd>{health ? `${health.pluginCount - health.unavailableCount}/${health.pluginCount} ${t("available")}` : t("Not checked")}</dd>
              <dt>{t("Last checked")}</dt><dd>{lastChecked ?? t("Not checked")}</dd>
            </dl>
          </section>

          <section className="daemon-section">
            <div className="daemon-section-head"><div><span className="section-kicker">{t("RUNTIME HEALTH")}</span><h2>{t("Plugin Runtime")}</h2></div><span className={`ov-pill ov-pill--${tone}`}>{t(state)}</span></div>
            {health?.plugins?.length ? <div className="daemon-plugin-list">{health.plugins.map((plugin) => {
              const pluginTone = ["ready", "running"].includes(plugin.state) ? "ok" : plugin.state === "disabled" ? "muted" : "bad";
              return <div className="daemon-plugin-row" key={plugin.id}><span><strong>{plugin.name}</strong><small>{plugin.id}</small></span><span className={`ov-pill ov-pill--${pluginTone}`}>{t(plugin.state)}{plugin.failure?.code ? ` · ${plugin.failure.code}` : ""}</span></div>;
            })}</div> : <div className="daemon-empty"><AlertCircle size={17} /><span>{connectionState === "error" ? message : t("No daemon health details are available yet.")}</span></div>}
          </section>
        </div>

        <aside className="daemon-side">
          <section className="daemon-section">
            <div className="daemon-section-head"><div><span className="section-kicker">{t("AUTOMATION")}</span><h2>{t("Scheduled work")}</h2></div></div>
            <p className="daemon-copy">{t("Refresh schedules, Daily Summary snapshots, and mail delivery are managed by the daemon.")}</p>
            <button type="button" className="daemon-link-button" onClick={onOpenAutomation}>{t("Open Automation")}<ArrowRight size={15} /></button>
          </section>
          <section className="daemon-section daemon-cli-note">
            <div className="daemon-section-head"><div><span className="section-kicker">{t("CLI CONTROL")}</span><h2><Terminal size={17} /> {t("Command line")}</h2></div></div>
            <p className="daemon-copy">{canStart ? t("This desktop can start or reconnect the daemon.") : t("Standalone Host Web cannot start a stopped daemon.")}</p>
            {!canStart && <code>npm run daemon -- start</code>}
            <code>npm run daemon -- status</code>
            <code>npm run daemon -- stop</code>
          </section>
        </aside>
      </div>
    </section>
  );
}
