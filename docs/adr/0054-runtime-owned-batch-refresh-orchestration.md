# Runtime-Owned Batch Refresh Orchestration

Status: superseded

Superseded by: [ADR 0061 - Standalone Plugin Runtime Daemon and Client-Independent Lifecycle](0061-standalone-daemon-and-client-independent-lifecycle.md)

ADR 0061 retains the batch target snapshot, per-Plugin evidence, task correlation, result
normalization, and interruption semantics. It supersedes only the assumption that an
Electron Application Session owns the Runtime lifetime or can end daemon state by closing
its window; the standalone daemon owns batch state and marks active work `interrupted` on
an explicit daemon stop or daemon recovery.

Plugin Runtime owns cross-Plugin batch refresh orchestration for the duration of one Application Session. A Batch stores a fixed target snapshot, per-Plugin item state, operation correlation, and an in-session history of at most five summaries. The Host Shell selects targets, starts a Batch, polls progress, and presents results; it does not invoke Plugin task handlers or own Plugin collection data.

Each executable target is revalidated immediately before it is enqueued through the existing Plugin Task Manager. The existing task queue and OpenCLI resource permits remain authoritative. A target that is already disabled, unavailable, queued, or refreshing is skipped. If a race coalesces the request with an existing refresh, the Batch follows that task's operationId and final RefreshOutcome.

Plugin refresh handlers return a result with an `ok` flag, or throw. Runtime normalizes both forms to `succeeded`, `failed`, or `cancelled` before updating the Plugin Status Snapshot. A failure preserves the previous successful timestamp; a later success clears the failure and advances the timestamp. The normalized result contains only a redacted code, short message, and timestamps, never source records.

Batch state is Runtime-owned and session-scoped. Electron gives one Application Session a temporary batch-state path so a Plugin Runtime restart can mark unresolved items `interrupted` while retaining completed item results. The Host Shell removes that path when the Application Session ends. Batch lifecycle and per-Plugin evidence carry `batchId`, while Plugin task evidence keeps `operationId`; neither identifier changes Plugin Store or Host State ownership.
