import { AlertTriangle, CheckCircle2, Download, ExternalLink, LoaderCircle, RefreshCw, RotateCcw, ShieldAlert, Store, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useLanguage } from "../i18n";
import type { Translate } from "../i18n";

interface MarketViewProps {
  catalog?: MarketCatalog;
  loading: boolean;
  refreshing: boolean;
  operation?: MarketOperation;
  onRefresh: () => void;
  onInstall: (release: MarketRelease) => Promise<void>;
  onCancel: () => void;
  onRetry: () => void;
}

function bytes(value: number) {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

function ageLabel(milliseconds: number | undefined, t: Translate) {
  if (milliseconds === undefined) return t("No cached catalog");
  const minutes = Math.floor(milliseconds / 60_000);
  if (minutes < 60) return t("{value}m old", { value: minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t("{value}h old", { value: hours });
  return t("{value}d old", { value: Math.floor(hours / 24) });
}

function releaseStatus(release: MarketRelease, t: Translate) {
  if (release.retraction) return t("Retracted");
  if (release.compatibility.compatible) return t("Compatible");
  return t("Unavailable");
}

function releaseMatches(plugin: MarketPlugin, query: string) {
  const haystack = [plugin.pluginId, plugin.name, plugin.description, plugin.publisher, ...plugin.categories].join(" ").toLocaleLowerCase();
  return query.trim().toLocaleLowerCase().split(/\s+/u).filter(Boolean).every((term) => haystack.includes(term));
}

export function MarketView({ catalog, loading, refreshing, operation, onRefresh, onInstall, onCancel, onRetry }: MarketViewProps) {
  const { t, locale } = useLanguage();
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string>();
  const [selectedVersion, setSelectedVersion] = useState<string>();
  const [trustRelease, setTrustRelease] = useState<MarketRelease>();
  const plugins = useMemo(() => (catalog?.plugins ?? []).filter((plugin) => releaseMatches(plugin, query)), [catalog, query]);
  const selected = plugins.find((plugin) => plugin.pluginId === selectedId) ?? plugins[0];
  const selectedRelease = selected?.releases.find((release) => release.version === selectedVersion)
    ?? selected?.releases.find((release) => release.version === selected.latestCompatible)
    ?? selected?.releases[0];

  useEffect(() => {
    if (!selected || selected.pluginId !== selectedId) setSelectedId(selected?.pluginId);
    if (selected && !selected.releases.some((release) => release.version === selectedVersion)) setSelectedVersion(selected.latestCompatible ?? selected.releases[0]?.version);
  }, [selected, selectedId, selectedVersion]);

  const progress = operation?.progress?.total ? Math.min(100, Math.round((operation.progress.received / operation.progress.total) * 100)) : undefined;
  const operationActive = operation?.state === "running";

  return (
    <section className="host-page market-page">
      <header className="page-header">
        <div><h1><Store size={21} /> {t("Plugin Market")}</h1><p>{catalog?.offline ? t("Cached catalog · {value}", { value: ageLabel(catalog.cacheAgeMs, t) }) : t("Official Registry catalog")}</p></div>
        <button className="primary-button" type="button" onClick={onRefresh} disabled={refreshing}><RefreshCw className={refreshing ? "spinner" : ""} size={16} />{t("Refresh catalog")}</button>
      </header>
      <div className="market-toolbar">
        <label className="market-search"><span>{t("Search Market")}</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t("Name, ID, author, category")} /></label>
        <span className={`market-connection ${catalog?.connected ? "is-connected" : ""}`}>{catalog?.connected ? t("Registry connected") : t("Offline catalog")}</span>
      </div>
      {operation && <div className={`market-operation market-operation--${operation.state}`} role="status">
        <div className="market-operation-main"><strong>{operation.pluginId} {operation.version}</strong><span>{t(operation.phase)}</span>{progress !== undefined && <span>{progress}%</span>}{operation.error && <span className="market-error">{operation.error.code}: {operation.error.message}</span>}</div>
        <div className="market-operation-actions">{operationActive && <button type="button" onClick={onCancel}><X size={14} />{t("Cancel")}</button>}{operation.state === "failed" && <button type="button" onClick={onRetry}><RotateCcw size={14} />{t("Retry")}</button>}{operation.state === "succeeded" && <CheckCircle2 className="market-success" size={17} />}</div>
      </div>}
      {loading && <div className="market-empty"><LoaderCircle className="spinner" size={24} /><span>{t("Loading catalog")}</span></div>}
      {!loading && !catalog?.plugins.length && <div className="market-empty"><Store size={28} /><strong>{t("No Market releases available")}</strong><span>{t("Refresh the official Registry when connected.")}</span></div>}
      {!loading && Boolean(catalog?.plugins.length) && <div className="market-layout">
        <div className="market-list" role="listbox" aria-label={t("Market plugins")}>
          {!plugins.length && <div className="market-empty market-empty--compact"><span>{t("No matching releases")}</span></div>}
          {plugins.map((plugin) => <button className={`market-row ${selected?.pluginId === plugin.pluginId ? "selected" : ""}`} type="button" key={plugin.pluginId} onClick={() => { setSelectedId(plugin.pluginId); setSelectedVersion(plugin.latestCompatible ?? plugin.releases[0]?.version); }}>
            <span className="market-row-icon">{plugin.icon ? <img src={plugin.icon} alt="" loading="lazy" /> : plugin.name.slice(0, 2).toUpperCase()}</span>
            <span className="market-row-copy"><strong>{plugin.name}</strong><small>{plugin.pluginId} · {plugin.publisher}</small></span>
            <span className="market-row-version">{plugin.latestCompatible ? `v${plugin.latestCompatible}` : t("No compatible version")}</span>
          </button>)}
        </div>
        <div className="market-detail">
          {selected && selectedRelease && <>
            <div className="market-detail-heading"><div className="market-detail-identity"><span className="market-detail-icon" aria-hidden="true">{selected.icon ? <img src={selected.icon} alt="" loading="lazy" /> : selected.name.slice(0, 2).toUpperCase()}</span><div className="market-detail-copy"><h2>{selected.name}</h2><p>{selected.description}</p><span className="market-detail-categories">{selected.categories.join(" / ")}</span></div></div><span className="market-publisher">{selected.publisher}</span></div>
            <dl className="market-facts"><dt>{t("Plugin ID")}</dt><dd>{selected.pluginId}</dd><dt>{t("Publisher")}</dt><dd>{selected.publisher}</dd><dt>{t("License")}</dt><dd>{selected.license}</dd><dt>{t("Platforms")}</dt><dd>{selectedRelease.platforms.join(", ")} · {selectedRelease.architectures.join(", ")}</dd></dl>
            <div className="market-release-picker"><label>{t("Release")}<select value={selectedRelease.version} onChange={(event) => setSelectedVersion(event.target.value)}>{selected.releases.map((release) => <option key={release.version} value={release.version} disabled={!release.installable}>{release.version}{release.retraction ? ` · ${t("retracted")}` : release.compatibility.compatible ? ` · ${t("compatible")}` : ` · ${t("unavailable")}`}</option>)}</select></label><span className={`market-release-status ${selectedRelease.compatibility.compatible ? "is-compatible" : ""}`}>{releaseStatus(selectedRelease, t)}</span></div>
            <div className="market-release-meta"><span>{bytes(selectedRelease.artifact.size)}</span><span>{new Date(selectedRelease.publishedAt).toLocaleDateString(locale)}</span><span className="market-hash">SHA-256 {selectedRelease.artifact.sha256}</span></div>
            <div className="market-changelog"><strong>{t("Change summary")}</strong><p>{selectedRelease.changelog}</p></div>
            {!selectedRelease.compatibility.compatible && <div className="market-compatibility market-compatibility--bad"><AlertTriangle size={16} /><div><strong>{t("Cannot install this release")}</strong>{selectedRelease.compatibility.reasons.map((reason) => <span key={reason.code}>{reason.message}</span>)}</div></div>}
            {selectedRelease.compatibility.compatible && catalog?.offline && <div className="market-compatibility"><AlertTriangle size={16} /><span>{t("Connect to the official Registry before installing. Cached metadata is browse-only.")}</span></div>}
            <button className="primary-button market-install" type="button" disabled={!selectedRelease.installable || Boolean(catalog?.offline) || operationActive} onClick={() => setTrustRelease(selectedRelease)}><Download size={16} />{t("Install {value}", { value: selectedRelease.version })}</button>
            <a className="market-source" href={selectedRelease.artifact.url} target="_blank" rel="noreferrer"><ExternalLink size={13} />{t("Official artifact address")}</a>
          </>}
        </div>
      </div>}
      {trustRelease && <div className="dialog-scrim"><div className="dialog market-trust-dialog" role="dialog" aria-modal="true" aria-labelledby="market-trust-title"><button className="dialog-close" type="button" aria-label={t("Close")} onClick={() => setTrustRelease(undefined)}><X size={17} /></button><ShieldAlert className="dialog-symbol warning" size={27} /><h2 id="market-trust-title">{t("Review trusted Plugin code")}</h2><p>{t("Plugin Backend code is trusted Node code with filesystem, network, and subprocess access. This confirmation is not a sandbox.")}</p><dl className="market-trust-facts"><dt>{t("Publisher")}</dt><dd>{trustRelease.publisher}</dd><dt>{t("Version")}</dt><dd>{trustRelease.version}</dd><dt>{t("Registry")}</dt><dd>{trustRelease.indexUrl ?? officialUrlLabel(trustRelease.artifact.url, t)}</dd><dt>SHA-256</dt><dd>{trustRelease.artifact.sha256}</dd></dl><div className="dialog-actions"><button type="button" onClick={() => setTrustRelease(undefined)}>{t("Cancel")}</button><button className="primary-button" type="button" onClick={() => { const next = trustRelease; setTrustRelease(undefined); void onInstall(next); }}><Download size={15} />{t("Install release")}</button></div></div></div>}
    </section>
  );
}

function officialUrlLabel(value: string, t: Translate) {
  try { return new URL(value).origin; } catch { return t("Official Registry catalog"); }
}
