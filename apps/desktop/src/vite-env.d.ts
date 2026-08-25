/// <reference types="vite/client" />

type ThemePreference = "system" | "light" | "dark";

interface StatusSnapshot {
  state: string;
  updatedAt?: string;
  lastSuccessfulRefreshAt?: string;
  failure?: { code: string; message: string; logId?: string; operationId?: string; batchId?: string; timestamp?: string };
}

interface HostState {
  enabledPluginIds: string[];
  lastSelection: string | null;
  theme: ThemePreference;
  statusSnapshots: Record<string, StatusSnapshot>;
  pluginInstallations: Record<string, PluginInstallation>;
}

interface PluginInstallation {
  origin: "market" | "local" | "bundled";
  version?: string;
  name?: string;
  description?: string;
  registryUrl?: string;
  indexUrl?: string;
  artifactUrl?: string;
  artifactSize?: number;
  publisher?: string;
  license?: string;
  categories?: string[];
  changelog?: string;
  contractVersion?: string;
  minHostVersion?: string;
  platforms?: string[];
  architectures?: string[];
  publishedAt?: string;
  expectedSha256?: string;
  observedSha256?: string;
  releaseStatus?: "current" | "retracted" | "incompatible" | "unknown";
  retractionReason?: string;
  installedAt?: string;
  operationId?: string;
}

interface RuntimePlugin {
  id: string;
  name: string;
  version: string;
  icon?: string;
  badge?: string;
  state: string;
  enabled: boolean;
  browserDependent: boolean;
  dependencyState?: "connected" | "disconnected" | "login-required" | "unknown" | "not-required";
  dependencyWarning?: boolean;
  packagePath: string;
  workspaceUrl: string;
  apiBaseUrl: string;
  healthUrl?: string;
  capabilities?: Record<"browser" | "clipboard" | "file" | "notification", { requested: boolean; required: boolean; granted?: boolean }>;
  statusSnapshot?: StatusSnapshot;
  failure?: { code: string; message: string; logId?: string; operationId?: string; batchId?: string; timestamp?: string };
  origin?: "market" | "local" | "bundled";
  releaseStatus?: PluginInstallation["releaseStatus"];
  provenance?: PluginInstallation;
}

interface MarketCompatibility {
  compatible: boolean;
  reasons: Array<{ code: string; message: string }>;
}

interface MarketRelease {
  pluginId: string;
  name: string;
  description: string;
  icon?: string;
  publisher: string;
  license: string;
  categories: string[];
  version: string;
  changelog: string;
  contractVersion: string;
  minHostVersion: string;
  platforms: string[];
  architectures: string[];
  artifact: { url: string; size: number; sha256: string };
  publishedAt: string;
  indexUrl?: string;
  retraction?: { reason: string; at?: string };
  compatibility: MarketCompatibility;
  installable: boolean;
}

type MarketIndexRelease = Omit<MarketRelease, "compatibility" | "installable">;

interface MarketPlugin {
  pluginId: string;
  name: string;
  description: string;
  icon?: string;
  publisher: string;
  license: string;
  categories: string[];
  releases: MarketRelease[];
  latestCompatible?: string;
}

interface MarketCatalog {
  index?: { schemaVersion: number; generatedAt?: string; registry?: { name?: string; source?: string }; releases: MarketIndexRelease[] };
  cachedAt?: string;
  cacheAgeMs?: number;
  offline: boolean;
  connected: boolean;
  releases: MarketRelease[];
  plugins: MarketPlugin[];
}

interface MarketOperation {
  operationId: string;
  pluginId: string;
  version: string;
  phase: "download" | "verification" | "extraction" | "package-validation" | "activation" | "complete" | "cancelled" | "failed";
  state: "running" | "succeeded" | "cancelled" | "failed";
  progress?: { received: number; total?: number };
  observedSha256?: string;
  startedAt: string;
  completedAt?: string;
  error?: { code: string; message: string };
}

type BrowserStatusOverall = "connected" | "degraded" | "disconnected" | "unknown";

interface BrowserStatusCheck {
  status: "ok" | "degraded" | "failed" | "unknown";
  code?: string;
  retryable?: boolean;
  action?: string;
}

interface BrowserStatus {
  overall: BrowserStatusOverall;
  checks: { daemon: BrowserStatusCheck; extension: BrowserStatusCheck; browser: BrowserStatusCheck; profile: BrowserStatusCheck };
  checkedAt?: string;
  durationMs: number;
  code: string;
  retryable: boolean;
  action: string;
  affected: Array<{ id: string; name: string; state?: string; dependencyState?: string }>;
}

type RefreshOptionValue = string | number | boolean;

interface RefreshOptionChoice {
  value: string;
  label: string;
}

interface RefreshOptionField {
  key: string;
  label: string;
  type: "select" | "text" | "number" | "boolean";
  options?: RefreshOptionChoice[];
  default?: RefreshOptionValue;
  required?: boolean;
  min?: number;
  max?: number;
  step?: number;
  maxLength?: number;
  placeholder?: string;
}

interface RefreshOptions {
  title?: string;
  fields: RefreshOptionField[];
  values?: Record<string, RefreshOptionValue>;
}

interface BatchTarget {
  pluginId: string;
  targetId: string;
  name: string;
  version: string;
  state: string;
  enabled: boolean;
  eligible: boolean;
  reason?: string;
  browserDependent: boolean;
  dependencyState?: string;
  dependencyWarning?: boolean;
  refreshOptions?: RefreshOptions;
  lastSuccessfulRefreshAt?: string;
  failure?: StatusSnapshot["failure"];
}

type BatchItemState = "queued" | "running" | "succeeded" | "failed" | "skipped" | "interrupted";

interface BatchItem {
  pluginId: string;
  targetId: string;
  name: string;
  version: string;
  state: BatchItemState;
  reason?: string;
  operationId?: string;
  coalesced?: boolean;
  refreshInput?: Record<string, RefreshOptionValue>;
  startedAt?: string;
  completedAt?: string;
  outcome?: { status: string; code?: string; message?: string; timestamp?: string };
}

interface BatchCounts {
  total: number;
  queued: number;
  running: number;
  succeeded: number;
  failed: number;
  skipped: number;
  interrupted: number;
  remaining: number;
}

interface BatchSummary {
  batchId: string;
  parentBatchId?: string;
  createdAt: string;
  completedAt?: string;
  status: "queued" | "running" | "succeeded" | "partial" | "failed" | "skipped" | "interrupted";
  state: string;
  targets?: BatchTarget[];
  items: BatchItem[];
  counts: BatchCounts;
}

interface RejectedPlugin {
  package: string;
  packagePath: string;
  id?: string;
  name?: string;
  version?: string;
  code: string;
  message: string;
}

interface RuntimeInfo {
  type: "runtime-ready";
  origin: string;
  runtimeToken?: string;
  daemon?: { state: string; loopback: boolean };
  plugins: RuntimePlugin[];
  rejectedPlugins: RejectedPlugin[];
  hostState: HostState;
  activeBatch?: BatchSummary;
}

interface RuntimeStatusEvent {
  status: "running" | "restarting" | "unavailable";
  message?: string;
  info?: RuntimeInfo;
}

type LogLevel = "debug" | "info" | "warn" | "error";

interface LogEntry {
  id: string;
  timestamp: string;
  level: LogLevel;
  source: string;
  message: string;
  code?: string;
  sessionId: string;
  operationId?: string;
  batchId?: string;
}

interface LogPage {
  entries: LogEntry[];
  nextCursor: string | null;
}

interface LogFilters {
  sources: string[];
  levels: LogLevel[];
  from: string;
  to: string;
  keyword: string;
  operationId: string;
  batchId: string;
}

interface LogQueryRequest {
  filters?: Partial<LogFilters>;
  cursor?: string;
  limit?: number;
}

interface Window {
  infolens?: {
    getRuntimeInfo(): Promise<RuntimeInfo | undefined>;
    selectPluginFolder(): Promise<string | null>;
    selectPluginArchive(): Promise<string | null>;
    copyText(value: string): Promise<void>;
    downloadText(value: { filename: string; text: string }): Promise<{ canceled: boolean; filename?: string }>;
    onRuntimeStatus(listener: (event: RuntimeStatusEvent) => void): () => void;
  };
}
