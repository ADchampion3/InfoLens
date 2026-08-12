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
  packagePath: string;
  workspaceUrl: string;
  apiBaseUrl: string;
  statusSnapshot?: StatusSnapshot;
  failure?: { code: string; message: string; logId?: string; operationId?: string; batchId?: string; timestamp?: string };
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
    queryLogs(request?: LogQueryRequest): Promise<LogPage>;
    copyLogEntry(id: string): Promise<{ count: number }>;
    copyFilteredLogs(filters?: Partial<LogFilters>): Promise<{ count: number }>;
    exportFilteredLogs(filters?: Partial<LogFilters>): Promise<{ canceled: boolean; count: number }>;
    selectPluginFolder(): Promise<string | null>;
    copyText(value: string): Promise<void>;
    downloadText(value: { filename: string; text: string }): Promise<{ canceled: boolean; filename?: string }>;
    removePlugin(id: string): Promise<void>;
    testReadClipboard(): Promise<string>;
    testTerminateRuntime(): Promise<void>;
    testWriteLog(message: string): Promise<LogEntry>;
    testLogQueryCount(): Promise<number>;
    onRuntimeStatus(listener: (event: RuntimeStatusEvent) => void): () => void;
  };
}
