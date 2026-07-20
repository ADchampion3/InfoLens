# Four Real OpenCLI Strategy Representatives

## Status

Superseded in MVP strategy scope by [ADR 0036](0036-defer-ui-strategy-from-mvp.md).

The Infolens MVP requires normally working, user-visible bundled representative plugins for each OpenCLI website collection strategy: `PUBLIC`, `COOKIE`, `INTERCEPT`, and `UI`. They are official daily-use information experiences rather than hidden verification fixtures. Their source assignments are selected as product scope, while each plugin continues to own its command mapping, persistence, refresh behavior, and workspace.

Before release, each representative must run its actual OpenCLI command against its real source environment, persist the collected result in its own SQLite store, and render that retained result in its workspace. Fake command output remains useful for isolated automated tests, but cannot replace this end-to-end verification.
