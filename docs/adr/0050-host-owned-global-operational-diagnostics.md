# Host-Owned Global Operational Diagnostics

The Electron main process owns a bounded global log service for operational evidence from the Host Shell, Plugin Runtime, and plugins. This extends [ADR 0043](0043-local-plugin-diagnostics.md): per-plugin diagnostics remain local and removable with plugin data, while Host lifecycle evidence is persisted separately from Host State and remains queryable when Plugin Runtime is unavailable.

The service stores a minimal structured envelope with a plain-text message. It redacts sensitive values before persistence and again before returning entries. The renderer receives logs only through a narrow context-isolated preload API and never receives filesystem paths or capabilities.

Each source retains three files of at most 256 KiB, measured as encoded bytes. Retained evidence survives Application Sessions within those limits. Raw log content never belongs in Host State; Host State may contain only its existing status snapshots and identifiers needed to link a status to canonical evidence.
