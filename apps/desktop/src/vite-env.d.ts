/// <reference types="vite/client" />

type ThemePreference = "system" | "light" | "dark";

interface StatusSnapshot {
  state: string;
  updatedAt?: string;
  lastSuccessfulRefreshAt?: string;
  failure?: { code: string; message: string; logId?: string; operationId?: string; timestamp?: string };
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
  failure?: { code: string; message: string; logId?: string; operationId?: string; timestamp?: string };
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
    removePlugin(id: string): Promise<void>;
    testReadClipboard(): Promise<string>;
    testTerminateRuntime(): Promise<void>;
    testWriteLog(message: string): Promise<LogEntry>;
    testLogQueryCount(): Promise<number>;
    onRuntimeStatus(listener: (event: RuntimeStatusEvent) => void): () => void;
  };
}
