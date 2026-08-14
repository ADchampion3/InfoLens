import { LoaderCircle, RefreshCw, RotateCcw } from "lucide-react";

const CHECK_LABELS: Array<{ key: keyof BrowserStatus["checks"]; label: string }> = [
  { key: "daemon", label: "Daemon" },
  { key: "extension", label: "Extension" },
  { key: "browser", label: "Browser" },
  { key: "profile", label: "Profile" },
];

function overallTone(overall: BrowserStatusOverall | undefined): "ok" | "warn" | "bad" | "muted" {
  if (overall === "connected") return "ok";
  if (overall === "degraded") return "warn";
  if (overall === "disconnected") return "bad";
  return "muted";
}

function checkTone(status: BrowserStatusCheck["status"]): "ok" | "warn" | "bad" | "muted" {
  if (status === "ok") return "ok";
  if (status === "degraded") return "warn";
  if (status === "failed") return "bad";
  return "muted";
}

interface BridgePanelProps {
  status?: BrowserStatus;
  action?: "check" | "reconnect";
  onCheck: () => void;
  onReconnect: () => void;
}

export function BridgePanel({ status, action, onCheck, onReconnect }: BridgePanelProps) {
  return (
    <div className="bridge-panel">
      <div className="bridge-panel-head">
        <span className="bridge-panel-overall">
          <span className={`ov-pill ov-pill--${overallTone(status?.overall)}`}>{status?.overall ?? "not checked"}</span>
          <small>{status?.checkedAt ? `Last checked ${new Date(status.checkedAt).toLocaleString()}` : "Check only when you need browser-backed collection."}</small>
        </span>
        <div className="detail-actions">
          <button type="button" disabled={Boolean(action)} onClick={onCheck}>{action === "check" ? <LoaderCircle className="spinner" size={16} /> : <RefreshCw size={16} />}Check connection</button>
          <button type="button" disabled={Boolean(action)} onClick={onReconnect}>{action === "reconnect" ? <LoaderCircle className="spinner" size={16} /> : <RotateCcw size={16} />}Reconnect</button>
        </div>
      </div>
      {status && (
        <div className="bridge-checks" aria-label="Browser Bridge checks">
          {CHECK_LABELS.map(({ key, label }) => {
            const check = status.checks[key];
            return (
              <div className="bridge-check" key={key}>
                <span className="bridge-check-name">{label}</span>
                <span className={`ov-pill ov-pill--${checkTone(check.status)}`}>{check.status}</span>
                {check.action && <small>{check.action}</small>}
              </div>
            );
          })}
        </div>
      )}
      {status && (
        <dl>
          <dt>Result</dt><dd>{status.code}{status.retryable ? " · retryable" : ""}</dd>
          <dt>Duration</dt><dd>{status.durationMs} ms</dd>
          <dt>Affected Plugins</dt><dd>{status.affected.map((plugin) => plugin.name).join(", ") || "None"}</dd>
        </dl>
      )}
    </div>
  );
}
