# 03 - Investigate retained log history

**What to build:** Give users and developers a bounded investigation workflow over retained Host, Plugin Runtime, and plugin logs. They can narrow evidence, inspect complete entries, and page backward without loading the entire retained history or losing their current investigation.

**Blocked by:** 02 - Unify Plugin Runtime and plugin evidence.

**Status:** resolved

- [x] Queries support source, severity, canonical time range, keyword, and operation identifier filters over redacted content.
- [x] Results merge current and rotated files, sort newest first by timestamp with a deterministic identifier tie-break, and return no more than 200 entries per page.
- [x] An opaque cursor retrieves the next older page without duplicates or omissions when filters are unchanged.
- [x] Invalid or stale cursors fail through a documented public error response rather than returning misleading results.
- [x] The initial UI filter includes info, warning, and error entries and excludes debug entries in every build.
- [x] Users can explicitly include debug entries without enabling any unredacted mode.
- [x] The Logs toolbar exposes source, level, time, and keyword controls suitable for repeated operational use.
- [x] Each row shows local display time, severity text, source, and message without relying on color alone.
- [x] Expanding a row shows its fixed envelope metadata, canonical timestamp, and complete redacted message.
- [x] Loading older pages preserves active filters and already loaded results.
- [x] Filter state survives Host Shell navigation within the current Application Session but is not added to Host State.
- [x] Distinct loading, no-match, end-of-history, and read-error states are visible and accessible.
- [x] Contract tests cover rotation boundaries, filtering, deterministic ordering, page boundaries, and cursor behavior; packaged Electron coverage verifies the user investigation workflow.

## Answer

Added bounded filtered queries, deterministic newest-first pagination with filter-bound opaque cursors and explicit cursor errors, plus a session-retained investigation UI with accessible filters, expandable fixed metadata, older-page loading, and distinct result states.
