/// <reference types="vite/client" />

type ThemePreference = "system" | "light" | "dark";

interface StatusSnapshot {
  state: string;
  updatedAt?: string;
  lastSuccessfulRefreshAt?: string;
  failure?: { code: string; message: string };
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
  failure?: { code: string; message: string };
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

interface Window {
  infolens?: {
    getRuntimeInfo(): Promise<RuntimeInfo | undefined>;
    selectPluginFolder(): Promise<string | null>;
    copyText(value: string): Promise<void>;
    removePlugin(id: string): Promise<void>;
    testReadClipboard(): Promise<string>;
    testTerminateRuntime(): Promise<void>;
    onRuntimeStatus(listener: (event: RuntimeStatusEvent) => void): () => void;
  };
}
