# Thin Plugin SDK

`@infolens/plugin-sdk` will standardize manifest typing, backend health startup, plugin runtime environment, OpenCLI JSON invocation, and workspace API-address helpers. It deliberately will not standardize source data, persistence, scheduling, components, DOM, or user-facing UI so plugins retain full business and presentation ownership. Reusable presentation-only controls requested by multiple Plugin Workspaces belong to the separate `@infolens/plugin-workspace` package described by ADR 0053.
