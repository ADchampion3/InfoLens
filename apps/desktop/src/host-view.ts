export type HostView =
  | { kind: "overview" }
  | { kind: "plugin"; id: string }
  | { kind: "plugins" }
  | { kind: "market" }
  | { kind: "logs" }
  | { kind: "settings" }
  | { kind: "batch" }
  | { kind: "daily-summary" };
