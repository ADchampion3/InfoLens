export type OpenCliStrategy = "PUBLIC" | "COOKIE" | "INTERCEPT";

export interface OpenCliCommandMapping {
  adapter: "builtin" | string;
  site: string;
  command: readonly [string, ...string[]];
  strategy: OpenCliStrategy;
  access: "read";
  outputFormat: "json";
}

export interface OpenCliAdapterDeclaration {
  id: string;
  version: string;
  path: string;
}

export interface PluginManifest {
  id: string;
  name: string;
  version: string;
  icon?: string;
  contractVersion: "2";
  minHostVersion: string;
  backend: { entry: string };
  ui: { entry: string };
  openCliAdapters: Record<string, OpenCliAdapterDeclaration>;
  openCliCommands: Record<string, OpenCliCommandMapping>;
}

export interface PluginHealth {
  state: "ready" | "starting" | "refreshing" | "failed" | "unavailable" | "disabled";
  badge?: string;
  lastSuccessfulRefresh?: string;
  message?: string;
}

export interface PluginLogger {
  debug(message: string, fields?: Record<string, unknown>): Promise<void>;
  info(message: string, fields?: Record<string, unknown>): Promise<void>;
  warn(message: string, fields?: Record<string, unknown>): Promise<void>;
  error(message: string, fields?: Record<string, unknown>): Promise<void>;
}

export interface TaskOptions {
  reason?: string;
  coalesceKey?: string;
}

export interface ScheduleOptions<Input = unknown> {
  intervalMs: number;
  input?: Input;
  reason?: string;
  runImmediately?: boolean;
}

export interface PluginActivationContext {
  readonly pluginId: string;
  readonly dataDir: string;
  resolveDataPath(relativePath: string): string;
  route(method: string, route: string, handler: (request: PluginRouteRequest) => unknown | Promise<unknown>): void;
  task<Input = unknown, Output = unknown>(name: string, handler: (input: Input, task: PluginTaskContext) => Output | Promise<Output>): void;
  enqueue<Input = unknown, Output = unknown>(name: string, input: Input, options?: TaskOptions): Promise<Output>;
  schedule<Input = unknown>(name: string, options: ScheduleOptions<Input>): () => void;
  setHealth(health: PluginHealth): void;
  readonly logger: PluginLogger;
  readonly opencli: {
    run<Output = unknown>(commandKey: string, args?: readonly string[], signal?: AbortSignal): Promise<Output>;
  };
}

export interface PluginRouteRequest {
  method?: string;
  url: URL;
  headers: Record<string, string | string[] | undefined>;
  signal: AbortSignal;
}

export interface PluginTaskContext {
  signal: AbortSignal;
  reason: string;
}

export interface PluginLifecycle {
  badge?: string;
  health?: PluginHealth;
  deactivate?(): void | Promise<void>;
}

export interface DownloadableResponse {
  readonly type: "infolens:download";
  readonly filenameBase: string;
  readonly format: ExportFormat;
  readonly body: Iterable<string> | AsyncIterable<string>;
}

export type ExportFormat = "json" | "csv" | "markdown" | "text";
export type ExportDeliveryErrorCode = "EXPORT_REQUEST_FAILED" | "EXPORT_TOO_LARGE" | "UNSUPPORTED_EXPORT_TYPE" | "CLIPBOARD_UNAVAILABLE" | "CLIPBOARD_DENIED";

export type ActivatePlugin = (context: PluginActivationContext) => PluginLifecycle | void | Promise<PluginLifecycle | void>;

export function defineManifest<const Manifest extends PluginManifest>(manifest: Manifest): Manifest;
export function defineBackend(activate: ActivatePlugin): { activate: ActivatePlugin };
export function healthResponse(state?: PluginHealth["state"], details?: Omit<PluginHealth, "state">): PluginHealth;
export const EXPORT_FORMATS: readonly ExportFormat[];
export function downloadableResponse(options: { filenameBase: string; format: ExportFormat; body: DownloadableResponse["body"] }): DownloadableResponse;
export function downloadExport(route: string | URL): Promise<{ initiated: true }>;
export function copyDownloadable(route: string | URL): Promise<{ copied: true }>;
export function pluginHealthUrl(origin: string, pluginId: string): string;
export function pluginWorkspaceUrl(origin: string, pluginId: string): string;
export function pluginApiUrl(origin: string, pluginId: string, route?: string): string;
export function workspaceRuntimeConfig(location?: Pick<Location, "search">): { pluginId: string; apiBaseUrl: string };
export type WorkspaceTheme = "light" | "dark";
export function workspaceTheme(location?: Pick<Location, "search">): WorkspaceTheme;
export function observeWorkspaceTheme(listener: (theme: WorkspaceTheme) => void, target?: Pick<Window, "addEventListener" | "removeEventListener">): () => void;
