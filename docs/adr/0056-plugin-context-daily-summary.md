# Daily Summary consumes optional Plugin Context

## Status

Accepted for the current Daily Summary Export implementation.

## Decision

Daily Summary is a Host Shell workflow that consumes a structured Plugin Context capability registered through the public Plugin Activation Context. The capability is optional: a compatible Plugin that does not register a provider remains valid and is reported as unsupported. A Plugin may register at most one provider; duplicate registration fails activation.

Plugin Runtime owns the aggregate request. It chooses `localDate`, `timeZone`, and `generatedAt` once, passes the same values and a request-scoped cancellation signal to every active enabled provider, preserves Plugin Navigation order, and converts provider exceptions, malformed envelopes, and unsafe timestamps into a generic `unavailable` result. Runtime does not read Plugin Stores, invoke Plugin API routes, call `/export`, or parse Plugin Export artifacts.

Each Plugin Backend Module owns its provider implementation and reads its own Collection Snapshots through a read-only point-in-time view. The provider returns only business records: common title/link/rank/read fields plus labeled source-specific fields. Settings, failures, logs, authentication material, Browser Bridge state, Adapter data, caches, and SQLite details remain outside Plugin Context.

Host Shell renders the aggregate into deterministic Markdown and owns preview freezing, source selection, privacy confirmation, clipboard delivery, and dated file delivery. Selection and acknowledgement live only in the current Application Session. Plugin Export remains Plugin-owned and opaque; this workflow does not change its formats or delivery boundary.

## Consequences

The four official Bundled Plugins can participate without imposing a mandatory contract change on third-party Plugins. A source failure does not hide other sources, and selected missing or unavailable sources remain explicit in the document. The Host Shell has one stable cross-source seam and does not need to know any Plugin Store schema, but each provider must decide which safe business fields it exposes and maintain that adapter as its own store evolves.

This extends [ADR 0023](0023-thin-plugin-sdk.md), [ADR 0052](0052-plugin-owned-text-export-delivery.md), and the Plugin Context vocabulary in `CONTEXT.md`.

## Boundary Clarifications

This decision supersedes the following earlier boundaries only for this explicitly named Daily Summary workflow:

- [ADR 0027](0027-persistent-plugin-navigation.md) and the corresponding architecture baseline state that the Host Shell does not render a content dashboard or cross-Plugin feed. The Host Shell may render this one deliberate, inspectable Daily Summary from structured Plugin Context. It is a utility workflow, not a Plugin Workspace, a general content dashboard, or a shared source-specific business UI.
- [ADR 0023](0023-thin-plugin-sdk.md) and the SDK section of `ARCHITECTURE.md` state that the Plugin SDK does not standardize persistence or source schemas. The opt-in `daily-summary-store` helper is a narrow read-only mechanism for provider-owned SQLite files: it performs no migrations or writes, accepts each Plugin's queries and identity/parser functions, and does not define a shared business schema. Plugin Backend Modules remain the owners of their stores and fields.

No other Host Shell, Plugin SDK, Plugin Store, or Plugin Export boundary is changed by this ADR.
