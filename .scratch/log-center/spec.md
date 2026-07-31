# Global Log Center

Status: implemented

## Problem Statement

Infolens records bounded, redacted logs for compatible plugin backend modules, and Plugin Management can copy a recent per-plugin diagnostic report. This is insufficient when a user or developer needs to understand why a plugin was rejected or failed to load, why collection failed, or why Plugin Runtime restarted. Operational evidence is split between per-plugin files, transient Runtime status events, and Host process output. Some evidence disappears when Plugin Runtime exits, rotated plugin history is not exposed, and the Host Shell has no place to browse or correlate events.

Users need a durable, safe log view inside the application. Developers need the same view to retain enough context to trace one operation across Host Shell, Plugin Runtime, and plugin boundaries without gaining access to credentials or other unredacted material.

## Solution

Add a global Logs view to the Host Shell. The Electron main process owns a global log service that remains available when Plugin Runtime is restarting or unavailable. It queries bounded logs from the Host, Plugin Runtime, and individual plugins through a minimal structured envelope while keeping the log message itself plain text.

The Logs view presents a dense, searchable stream with source, severity, time, and operation filters. Known failures receive user-readable guidance, while developers can expand a row to inspect its fixed metadata and complete redacted message. Failure indicators elsewhere in the Host Shell link directly to the relevant context. Logs persist across Application Sessions within fixed rotation limits, are always redacted, and can be copied or exported without exposing an unredacted mode.

## User Stories

1. As a user, I want a Logs entry in persistent Host Shell navigation, so that I can find operational evidence without opening Plugin Management.
2. As a user, I want the Logs view to remain available while Plugin Runtime is restarting, so that I can inspect the failure that caused the restart.
3. As a user, I want plugin discovery and compatibility rejection failures in Logs, so that I can understand why an installed package is unavailable.
4. As a user, I want plugin activation failures in Logs, so that I can understand why a compatible plugin did not start.
5. As a user, I want collection failures in Logs, so that I can understand why a refresh did not produce new content.
6. As a user, I want known failure codes to include concise guidance, so that I can take an appropriate recovery action.
7. As a user, I want unknown failures to retain their original redacted message, so that useful evidence is not replaced by a generic error.
8. As a user, I want a plugin failure indicator to open Logs with the relevant context selected, so that I do not need to reconstruct filters manually.
9. As a user, I want the latest failure summary to link to the exact related log entry when available, so that I can move from status to evidence directly.
10. As a user, I want logs from previous Application Sessions to remain available within a bounded history, so that restarting the application does not erase the evidence I need.
11. As a user, I want log storage to remain bounded, so that diagnostics cannot consume unbounded disk space.
12. As a user, I want timestamps displayed in local time, so that I can relate events to actions I performed.
13. As a developer, I want the canonical timestamp retained in row details and exports, so that events can be compared precisely.
14. As a developer, I want to filter by `host`, `runtime`, or a specific `plugin:<id>` source, so that I can isolate the responsible boundary.
15. As a developer, I want OpenCLI outcomes attributed to the plugin that invoked OpenCLI, so that collection traces remain plugin-scoped.
16. As a developer, I want to filter by severity, so that I can focus on warnings and failures or include informational context.
17. As a developer, I want debug entries hidden by default, so that ordinary diagnostics are not overwhelmed by verbose output.
18. As a developer, I want to reveal debug entries explicitly, so that detailed development evidence remains accessible.
19. As a developer, I want to filter by a time range, so that I can focus on the period surrounding a reported failure.
20. As a developer, I want keyword search over the redacted message, so that I can locate event names, codes, paths, and other textual evidence.
21. As a developer, I want related start, completion, and failure entries to share an operation identifier, so that I can isolate one load, refresh, or installation attempt.
22. As a developer, I want a one-click filter for an operation identifier, so that concurrent activity does not mix unrelated traces.
23. As a developer, I want each log entry to have a stable identifier, so that links and deduplication identify one fact reliably.
24. As a developer, I want status updates and visible logs to refer to the same entry, so that one failure is not shown twice as unrelated evidence.
25. As a user, I want new logs to appear while the Logs view is open, so that I can observe an operation without manually refreshing.
26. As a user, I want polling to stop when I leave Logs, so that background viewing does not create unnecessary work.
27. As a user, I want my reading position preserved when new logs arrive, so that live updates do not interrupt inspection of older entries.
28. As a user, I want an indication that new entries are available when I am reading older entries, so that I can return to the latest evidence deliberately.
29. As a user, I want the view to remember my filters for the current Application Session, so that navigating away does not reset an active investigation.
30. As a user, I want a clear empty state when no logs match, so that an empty result is not mistaken for a loading failure.
31. As a user, I want a clear unavailable or read-error state, so that failure to load logs is distinguishable from having no logs.
32. As a developer, I want logs loaded in bounded pages, so that a large retained history does not block or resize the interface unpredictably.
33. As a developer, I want to request older pages without losing current filters, so that I can extend an investigation backward in time.
34. As a user, I want a compact row showing time, severity, source, and message, so that many entries can be scanned efficiently.
35. As a developer, I want to expand a row for fixed metadata and the complete message, so that the main list remains dense without discarding detail.
36. As a user, I want to copy one log entry, so that I can share a focused failure report.
37. As a developer, I want to copy the current filtered result, so that I can share the exact evidence under investigation.
38. As a developer, I want to export the current filtered result as JSONL, so that tools can process the minimal envelopes without scraping the UI.
39. As a user, I want the existing Plugin Diagnostic Report action to remain available, so that established support workflows continue to work.
40. As a user, I want all displayed, copied, and exported content to be redacted, so that diagnostics do not reveal credentials or Browser Bridge session material.
41. As a security-conscious user, I want no developer switch that reveals original sensitive values, so that release and development builds have the same confidentiality boundary.
42. As a user, I want plugin removal to delete that plugin's dedicated log files, so that its package data deletion semantics remain intact.
43. As a developer, I want redacted Host lifecycle events about a removed plugin to remain until natural rotation, so that installation, rejection, crash, and removal sequences remain diagnosable.
44. As a developer, I want existing JSONL plugin logs to remain readable without being rewritten, so that upgrading does not mutate historical diagnostics.
45. As a plugin developer, I want existing logger calls with message and fields to remain source-compatible, so that adding the Logs view does not break plugins.
46. As a plugin developer, I want custom fields rendered into a deterministic, redacted plain-text message, so that they remain searchable without expanding the envelope contract.
47. As a user, I want the full Logs view in production builds, so that support evidence is not limited to development environments.
48. As a keyboard user, I want filters, row expansion, copy, export, and new-log controls to be operable with visible focus, so that the Logs view is accessible without a pointer.
49. As a screen-reader user, I want severity and source conveyed as text rather than color alone, so that log meaning does not depend on vision.

## Implementation Decisions

- The Electron main process owns the global log service and exposes a narrow query and export interface through the existing context-isolated preload boundary. The renderer never receives filesystem access.
- The global log service remains callable when Plugin Runtime is unavailable. Host lifecycle and child-process exit evidence must therefore be recorded outside Plugin Runtime.
- Log sources use exactly three categories: `host`, `runtime`, and `plugin:<id>`. OpenCLI activity is attributed to the invoking plugin and distinguished by event or error code.
- Stored and returned entries use a minimal envelope containing `id`, `timestamp`, `level`, `source`, `message`, optional `code`, `sessionId`, and optional `operationId`. The message is plain text. Arbitrary structured fields are not part of the query contract.
- Existing plugin logger methods and call signatures remain compatible. Supplied fields are redacted, serialized in deterministic key order, and appended to the text message. Fields are searchable as text but cannot be addressed as independent filters.
- A load, refresh, installation, removal, or similar bounded attempt receives one operation identifier shared by its start, success, and failure entries.
- One operational fact produces one canonical visible entry. Status snapshots or lifecycle notifications reference the same log identifier where applicable instead of emitting a second visible copy.
- Each source retains three rotating files with a maximum of 256 KiB per file. Rotation is based on encoded byte size and survives Application Sessions.
- Plugin-specific log files continue to live with plugin data and are deleted during plugin removal. Redacted Host operational events containing plugin identity may remain in the Host log until natural rotation.
- The query contract merges sources by canonical timestamp, applies a deterministic identifier tie-break, returns newest entries first, and uses an opaque cursor. The default and maximum page size is 200 entries unless a later performance measurement justifies a smaller enforced maximum.
- The query accepts source, level, time-range, keyword, and operation filters. Keyword matching applies only to the redacted text exposed by the service.
- Existing JSONL plugin entries are adapted at read time. Historical files are never rewritten. Missing envelope values are synthesized deterministically where possible and otherwise marked as legacy session data.
- Redaction runs before persistent writes and again before any query, copy, diagnostic, or export response. The second pass protects legacy content and content created before future redaction-rule improvements.
- Redaction continues to cover authentication headers, cookies, tokens, secrets, sessions, Browser Bridge identifiers, and browser profile paths. It is extended to cover common credential-bearing URL parameters and equivalent textual forms. There is no unredacted API or UI mode.
- The Logs view is a Host Shell utility view in persistent navigation. It is not owned by a plugin workspace.
- The main presentation is a dense list with stable columns for local display time, severity, source, and message. Expanding a row shows the fixed envelope metadata, canonical timestamp, complete redacted message, and user guidance for a known code.
- The initial filter includes `info`, `warn`, and `error`, and excludes `debug` in every build. Production and development users can explicitly include debug without changing the confidentiality boundary.
- Filter state is retained in renderer memory for the current Application Session. It is not added to Host State.
- While Logs is visible, the renderer polls every two seconds. Polling stops when the view is not active. No persistent event stream is introduced.
- New entries are inserted automatically only while the user is at the newest position. Otherwise the list preserves its visual position and presents a control reporting the number of new entries.
- Failure summaries and relevant Host Shell status indicators navigate to Logs with source, severity, time, operation, and entry context when those values are available.
- Known stable error codes map to concise user-facing explanations and recommended actions. The original redacted message remains available. Unknown codes do not receive fabricated guidance.
- Copy actions support one entry and the complete current filtered result. Export produces JSONL containing only the minimal envelope for the current filtered result. Existing per-plugin Plugin Diagnostic Report copying remains available.
- The Logs view does not expose deletion controls. Bounded rotation is the only automatic cleanup mechanism besides plugin removal.
- The Logs navigation item may indicate a current failed state, but the feature does not define read/unread semantics or counters.
- This decision expands the Local Plugin Diagnostics architecture from per-plugin reports to Host-owned global operational diagnostics. The implementation must record a new ADR that explicitly extends the existing local diagnostics decision while retaining the rule that raw logs do not belong in Host State.

## Testing Decisions

- Tests assert observable behavior through public UI, preload, and log-query contracts. They do not import private renderer components, inspect React state, or require a particular internal class layout.
- The primary seam is the packaged Electron application, following the existing release-candidate tests that drive the real Host Shell through its browser debugging surface and exercise preload IPC. A fixture plugin emits representative debug, informational, warning, failure, custom-field, and operation-correlated entries.
- The packaged Electron test verifies navigation to Logs, default severity selection, filtering, row expansion, contextual failure navigation, polling behavior, preserved reading position, copying, JSONL export, accessibility labels, Plugin Runtime termination visibility, and continued log access during restart.
- The packaged test restarts the application with the same test profile and verifies that bounded historical evidence remains visible across an Application Session boundary.
- The secondary seam is the public log-service contract. It uses temporary managed data roots and verifies exact behavior for byte-bound rotation, merged ordering, stable cursors, page boundaries, source and operation filters, deterministic text serialization, and legacy JSONL adaptation.
- Security cases pass credential-bearing keys, headers, URL query parameters, nested values, Windows and Unix profile paths, and legacy entries through the public write/query/export boundaries. Assertions require that secrets are absent from persistent files and every returned representation.
- Compatibility coverage calls the existing plugin logger interface with fields and verifies that the resulting message retains non-sensitive diagnostic context without adding arbitrary envelope properties.
- Deduplication coverage triggers a failure that updates Plugin Status and verifies that the query returns one canonical visible failure with the referenced identifier.
- Removal coverage verifies that deleting a plugin removes its dedicated logs while a redacted Host lifecycle entry remains queryable until rotation.
- Query tests include malformed or partially written legacy lines. The service must skip or safely represent them without failing an otherwise valid page and without returning unredacted content.
- Existing Plugin Runtime contract tests remain the prior art for plugin logging, rotation, status events, and redaction. Existing Host operations tests remain the prior art for diagnostics and removal. Existing packaged release-candidate tests remain the prior art for end-to-end Host Shell behavior.

## Out of Scope

- Streaming logs over Server-Sent Events or WebSocket
- An unredacted developer mode or reveal-secret action
- User-controlled log clearing or retention configuration
- Persistent unread counts or cross-session read state
- CSV export or a multi-file support bundle
- Arbitrary structured plugin fields in the envelope or field-specific querying
- A separate OpenCLI source category
- Remote log upload, telemetry, cloud retention, or automatic support submission
- Full-text indexing beyond bounded in-memory or file-backed scanning of retained logs
- Changing plugin-owned content, refresh policy, source persistence, or workspace layout
- Replacing the existing Plugin Diagnostic Report workflow

## Further Notes

- The feature must use the domain terms Host Shell, Plugin Runtime, Host State, Application Session, Plugin Status, and Plugin Diagnostic Report as defined by the project glossary.
- Raw log content remains outside Host State. Host State may retain only the existing minimal status snapshot and references such as a latest log identifier when required for contextual navigation.
- The existing redaction implementation is heuristic rather than a proof that arbitrary plugin text is safe. Double redaction and bounded exposure reduce risk, but plugin authors should still avoid logging source records or authentication material.
- The specification intentionally favors a polling design because retained data is small and bounded. A streaming transport should be reconsidered only with measured evidence that polling is insufficient.

## Implementation Result

All six implementation tickets are resolved. Verification completed with `npm run typecheck`, packaged Electron log-center coverage, targeted Runtime and Host-operation contracts, and the full serial suite: 56 tests passed.
