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
  origin: "url" | "local" | "bundled";
  version?: string;
  contractVersion?: string;
  minHostVersion?: string;
  sourceUrl?: string;
  sourceFileName?: string;
  expectedSha256?: string;
  observedSha256?: string;
  installedAt?: string;
  operationId?: string;
  previousRevision?: PluginRevision;
  recoveryState?: string;
}

interface PluginRevision {
  revisionId: string;
  id: string;
  version?: string;
  origin?: "url" | "local";
  sourceUrl?: string;
  sourceFileName?: string;
  expectedSha256?: string;
  observedSha256?: string;
  enabled?: boolean;
  createdAt?: string;
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
  origin?: "url" | "local" | "bundled";
  provenance?: PluginInstallation;
}

type DistributionIntent = "install" | "replace" | "rollback";

type DistributionSource =
  | { kind: "local"; path: string; expectedSha256?: string }
  | { kind: "url"; url: string; expectedSha256: string };

interface DistributionOperation {
  operationId: string;
  intent: DistributionIntent;
  pluginId?: string;
  source?: { kind: "local" | "url"; url?: string; fileName?: string; expectedSha256?: string };
  phase: string;
  state: "queued" | "preflight" | "committing" | "completed" | "failed" | "cancelled";
  progress?: { received: number; total?: number };
  candidateVersion?: string;
  candidateSha256?: string;
  currentVersion?: string;
  currentSha256?: string;
  observedSha256?: string;
  previousOperationId?: string;
  revisionId?: string;
  createdAt: string;
  updatedAt: string;
  result?: Record<string, unknown>;
  error?: { code: string; message: string };
}

interface PluginRevisionsResponse {
  pluginId: string;
  current: PluginInstallation | null;
  previous: PluginRevision | null;
  rollbackAvailable: boolean;
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
    selectPluginArchive(): Promise<{ fileName: string; data: ArrayBuffer; expectedSha256?: string } | null>;
    copyText(value: string): Promise<void>;
    downloadText(value: { filename: string; text: string }): Promise<{ canceled: boolean; filename?: string }>;
    onRuntimeStatus(listener: (event: RuntimeStatusEvent) => void): () => void;
  };
}
