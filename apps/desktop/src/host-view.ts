export type HostView =
  | { kind: "plugin"; id: string }
  | { kind: "plugins" }
  | { kind: "logs" }
  | { kind: "settings" }
  | { kind: "batch" }
  | { kind: "daily-summary" };
