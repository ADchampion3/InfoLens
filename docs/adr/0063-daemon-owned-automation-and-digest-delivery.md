# Daemon-Owned Automation and Digest Delivery

Status: accepted

## Context

The Host Shell and the Plugin Runtime are separate processes. A recurring
refresh or an email digest must therefore not depend on a browser tab, an
Electron window, or a Plugin Workspace being mounted. The existing Plugin
Activation Context has a timer-shaped schedule helper, but that helper cannot
provide durable state, time-zone semantics, restart recovery, delivery
idempotency, or a useful run history.

Daily Summary already has a deterministic provider seam. The missing seam is
the daemon-owned orchestration that selects a local-day window, freezes the
facts, renders a bounded multipart message, and records whether SMTP accepted
the message.

## Decision

The daemon is the sole owner of automation. It stores schedule definitions,
optimistic versions, run records, digest snapshots, delivery records, and
mail-test audit records in scheduler.sqlite below the daemon data root.
The Host Shell only calls the authenticated /api/v1 automation contract.

The supported schedule model is intentionally small:

- one fixed-interval refresh schedule per Plugin, with an interval from five
  minutes through seven days;
- any number of daily or weekly Daily Summary schedules;
- an explicit IANA time zone and local wall-clock minute for wall-clock
  schedules;
- enabled, paused, and orphaned schedule states, plus a separate run state
  and delivery state.

Intervals remain anchored to the original schedule timeline. A daemon
restart performs at most one refresh catch-up. A missed digest catches up
only the most recent unprocessed local date; older dates are skipped. A
repeated wall-clock minute executes once, and a nonexistent DST minute moves
to the next valid instant.

Refresh and digest are separate operations. A digest never starts a refresh.
When a selected Plugin refresh is active, the digest waits for its committed
task result up to a fixed deadline and then reads only the Plugin's committed
snapshot. Plugin providers receive the local date, time zone, explicit
window bounds, and an abort signal.

The digest renderer produces deterministic Markdown facts and escaped HTML
with a per-Plugin and total item cap. It sends only a text/html multipart
message. It does not invoke an LLM, fetch remote images, or attach files.
Global SMTP configuration is stored in SQLite without the password; the
password is stored separately with atomic writes and restrictive file mode.
SMTP uncertainty after message submission is recorded as unknown and is never
automatically retried. A successful scheduleId plus localDate delivery is
idempotent; manual resend uses the stored snapshot and is a distinct run.

Queued and running scheduler runs become interrupted after restart. In-flight
deliveries become unknown. Backup includes the scheduler database and
snapshots but excludes the mail secret. Restore closes and reopens the
scheduler database and does not resend unknown deliveries.

Plugin refresh settings remain source-specific parameters and manual or
disabled behavior. Legacy Plugin timer registrations are not armed by the
daemon; no old fixed interval is migrated into the new scheduler. Existing
Plugin data, history, read state, and credentials remain untouched. Removing
a Plugin marks dependent schedules orphaned; reinstalling the same Plugin ID
restores them when all dependencies are available. Deleting a schedule is
explicit.

## Consequences

Closing the Host Shell no longer stops automation. The Automation page can
show last and next execution, run history, failures, delivery state, SMTP
configuration, and a separate test-mail audit. Browser-dependent Plugins can
still be scheduled; their unavailable or disabled runs are recorded rather
than silently retried.

The scheduler is a deeper daemon module with a narrow handler seam:
refresh handlers enqueue existing Plugin tasks, and the digest handler calls
the shared Daily Summary provider seam. Plugin code does not own recurring
timers in daemon mode. The old timer API remains available to the generic
Plugin contract and preview tooling, but daemon activation disables it.
