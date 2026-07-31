# 01 - Host Shell log center walking skeleton

**What to build:** Give users a Host-owned Logs view that records and displays Host lifecycle evidence through the real Electron security boundary. The view must remain usable while Plugin Runtime is unavailable, establishing the end-to-end seam used by later log sources and investigation features.

**Blocked by:** None - can start immediately.

**Status:** resolved

- [x] Persistent Host Shell navigation includes a Logs entry that opens a dense log list.
- [x] Starting the application produces a Host entry with the agreed minimal envelope and a plain-text message.
- [x] Host entries are persisted outside Host State and survive an Application Session restart.
- [x] Host log storage rotates at three files of at most 256 KiB each, measured in encoded bytes.
- [x] The renderer can query logs only through the context-isolated preload boundary and receives no filesystem capability.
- [x] The Logs view remains queryable and displays retained Host evidence when Plugin Runtime is unavailable or restarting.
- [x] Sensitive values are redacted before a Host entry is persisted and before it is returned to the renderer.
- [x] A new ADR extends Local Plugin Diagnostics to cover Host-owned global operational diagnostics while preserving the rule that raw logs do not belong in Host State.
- [x] Public log-service contract tests cover the envelope, rotation, persistence, and redaction behavior.
- [x] A packaged Electron test demonstrates the Logs navigation and Runtime-unavailable behavior through the real preload boundary.

## Answer

Implemented the Host-owned log service, context-isolated query IPC, persistent Logs navigation and dense list, lifecycle evidence, encoded-byte rotation, double redaction, ADR 0050, and public/packaged behavioral coverage.

Verified with `node --test tests/log-service-contract.test.mjs`, `npm run typecheck`, `npm run package:sprint7`, and `node --test tests/log-center-electron.test.mjs`.
