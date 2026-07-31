# 05 - Trace Plugin Status failures to one operation

**What to build:** Connect Plugin Status and operational logs so a user can move directly from a visible failure to the exact load, refresh, installation, or removal attempt that caused it. Known failures provide useful guidance, while unknown failures preserve their original redacted evidence.

**Blocked by:** 03 - Investigate retained log history.

**Status:** resolved

- [x] Each bounded load, refresh, installation, and removal attempt receives one operation identifier shared by its start, completion, and failure entries.
- [x] Each canonical visible entry has a stable identifier suitable for links, query results, and deduplication.
- [x] A Plugin Status update references the same log identifier as its canonical failure entry when one exists.
- [x] One operational fact produces one visible log entry rather than separate status-event and plugin-log duplicates.
- [x] A plugin failure summary opens Logs with the relevant source, severity, time, operation, and entry context selected when available.
- [x] Relevant Host Shell failure indicators offer the same contextual navigation without replacing normal plugin navigation.
- [x] Users can reduce the result set to one operation from an entry or contextual link.
- [x] Known stable error codes show a concise explanation and recommended action while retaining the complete redacted message.
- [x] Unknown error codes display the original redacted message without fabricated guidance.
- [x] Contract tests cover correlation and canonical-entry deduplication; packaged Electron coverage demonstrates navigation from Plugin Status to the matching failure.

## Answer

Correlated activation, task/refresh, install, removal, and route failure evidence with stable operation and log identifiers. Plugin Status now references the canonical failure, task failures are not duplicated at the route boundary, and the Host Shell deep-links to an expanded matching entry with operation filtering and known-code guidance.
