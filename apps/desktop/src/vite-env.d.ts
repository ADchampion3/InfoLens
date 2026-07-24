/// <reference types="vite/client" />

interface RuntimePlugin {
  id: string;
  name: string;
  version: string;
  icon?: string;
  badge?: string;
  workspaceUrl: string;
  apiBaseUrl: string;
}

interface RuntimeInfo {
  type: "runtime-ready";
  origin: string;
  plugins: RuntimePlugin[];
}

interface Window {
  infolens?: {
    getRuntimeInfo(): Promise<RuntimeInfo | undefined>;
  };
}
