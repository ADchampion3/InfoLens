import { useEffect, useMemo, useState } from "react";
import { LoaderCircle, Plug, Settings } from "lucide-react";

type Status = "loading" | "ready" | "error";

async function getRuntimeInfo(): Promise<RuntimeInfo> {
  if (window.infolens) {
    const info = await window.infolens.getRuntimeInfo();
    if (info) return info;
  }

  const runtimeOrigin = new URLSearchParams(window.location.search).get("runtimeOrigin");
  const response = await fetch(runtimeOrigin ? `${runtimeOrigin}/runtime/info` : "/runtime-info.json");
  if (!response.ok) throw new Error("Runtime is not available in browser preview mode.");
  return response.json();
}

export function App() {
  const [status, setStatus] = useState<Status>("loading");
  const [message, setMessage] = useState("Starting plugin services...");
  const [runtime, setRuntime] = useState<RuntimeInfo>();
  const [selectedId, setSelectedId] = useState<string>();

  useEffect(() => {
    getRuntimeInfo()
      .then((info) => {
        setRuntime(info);
        setSelectedId(info.plugins[0]?.id);
        setStatus("ready");
      })
      .catch((error: unknown) => {
        setMessage(error instanceof Error ? error.message : "Plugin services did not start.");
        setStatus("error");
      });
  }, []);

  const selected = useMemo(
    () => runtime?.plugins.find((plugin) => plugin.id === selectedId),
    [runtime, selectedId],
  );

  const workspaceSrc = selected
    ? `${selected.workspaceUrl}?pluginId=${encodeURIComponent(selected.id)}&apiBaseUrl=${encodeURIComponent(selected.apiBaseUrl)}`
    : undefined;

  return (
    <div className="app-shell">
      <aside className="sidebar" aria-label="Infolens navigation">
        <header className="brand">
          <span className="brand-mark" aria-hidden="true">IL</span>
          <span>Infolens</span>
        </header>

        <nav className="plugin-nav" aria-label="插件">
          <div className="nav-caption">信息源</div>
          {runtime?.plugins.map((plugin) => (
            <button
              className={`nav-item ${plugin.id === selectedId ? "is-selected" : ""}`}
              key={plugin.id}
              onClick={() => setSelectedId(plugin.id)}
              type="button"
            >
              <span className="source-icon source-icon--hn" aria-hidden="true">Y</span>
              <span className="nav-label">{plugin.name}</span>
              {plugin.badge ? <span className="nav-badge">{plugin.badge}</span> : <span />}
              <span className="status-icon" aria-label="运行中" />
            </button>
          ))}
        </nav>

        <nav className="utility-nav" aria-label="应用">
          <button className="nav-item" disabled type="button">
            <span className="utility-icon"><Plug size={17} /></span>
            <span className="nav-label">插件</span>
            <span /><span />
          </button>
          <button className="nav-item" disabled type="button">
            <span className="utility-icon"><Settings size={17} /></span>
            <span className="nav-label">设置</span>
            <span /><span />
          </button>
        </nav>
      </aside>

      <main className="main-area">
        {status === "loading" && (
          <div className="system-state" role="status">
            <LoaderCircle className="spinner" size={24} />
            <p>{message}</p>
          </div>
        )}
        {status === "error" && (
          <div className="system-state system-state--error" role="alert">
            <h1>插件服务不可用</h1>
            <p>{message}</p>
          </div>
        )}
        {status === "ready" && workspaceSrc && (
          <iframe
            className="workspace-frame"
            src={workspaceSrc}
            title={`${selected?.name ?? "Plugin"} workspace`}
          />
        )}
      </main>
    </div>
  );
}
