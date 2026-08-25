# Browser Bridge Session UX

Status: superseded

Supersedes: [ADR 0020 - Plugin-Level Browser Degradation](0020-plugin-level-browser-degradation.md)

Superseded by: [ADR 0061 - Standalone Plugin Runtime Daemon and Client-Independent Lifecycle](0061-standalone-daemon-and-client-independent-lifecycle.md)

ADR 0061 retains this ADR's cached Browser Bridge coordinator, explicit check/reconnect
operations, serialized browser resource, safe diagnostic parsing, and Plugin-level
degradation. It supersedes the Host Shell/Electron ownership assumption: the standalone
daemon owns the coordinator and its lifecycle, while clients call the versioned `/api/v1`
boundary and may disconnect without stopping the daemon.

## Context

Browser-dependent Plugins need a connected Browser Bridge and, for some Sources, a logged-in browser profile. The previous decision described Plugin-level degradation but left the global status read coupled to a live probe. That made startup perform external work, encouraged a global dialog, and did not define who owns daemon restart, browser tab leases, or cleanup. OpenCLI 1.8.6 exposes doctor as human-readable text and provides `opencli daemon restart`; its report includes profile context IDs that are not Host-facing data.

## Decision

Plugin Runtime owns a deep Browser Bridge coordinator behind a small interface: read the cached status, explicitly check, explicitly reconnect, run a best-effort post-failure check, and stop accepting work. The coordinator owns the cache, safe doctor parser, retry policy, daemon repair policy, and shared permit usage. Callers do not parse doctor text or manage daemon lifecycle.

GET `/api/v1/browser-status` is a side-effect-free cache read. POST `/api/v1/browser-status/check` performs a doctor check. POST `/api/v1/browser-status/reconnect` runs `opencli daemon restart` and then checks the result. The initial state and an expired state are `unknown`. Reports are cached in memory for five minutes and are discarded when the daemon's Plugin Runtime restarts. Concurrent checks merge into one operation, and all checks, reconnects, and browser-backed collection commands use the serialized `BROWSER` resource.

Automatic repair is deliberately narrow. A check may restart the daemon only for `DAEMON_STOPPED`, `DAEMON_STALE`, or `DAEMON_UNSTABLE`. Extension, profile, login, and browser probe findings remain results with user actions; they do not cause a daemon restart. A daemon finding is repaired before generic retry backoff, and retry waits observe cancellation.

The bundled OpenCLI Adapter is the only process seam. It captures and parses the pinned doctor output, fails closed with `DOCTOR_OUTPUT_UNSUPPORTED` when required markers are absent, and returns only stable statuses, codes, actions, and safe affected Plugin summaries. It never returns raw doctor text or profile context IDs. The Adapter also releases the reserved `__doctor__` session in a bounded `finally` cleanup, including when the probe or parser fails. Browser-backed Plugin commands always receive `--window background`, `--site-session ephemeral`, and `--keep-tab false`; conflicting Plugin arguments are removed before the managed values are appended. OpenCLI releases the temporary tab lease on both success and failure.

The Runtime owns only its own process, task queue, and Browser Bridge coordinator. `stop()` and Runtime shutdown do not stop the external daemon, close Chrome, or close a user-owned tab. OpenCLI's ephemeral lease cleanup applies only to the automation session created for that command.

Plugin lifecycle and external dependency state are separate. Browser-dependent Bundled Plugins remain `ready` when collection cannot reach the Browser Bridge or login state. They expose `dependencyState` as `connected`, `disconnected`, `login-required`, or `unknown`; browser-independent Plugins use `not-required` in public contracts. Retained Plugin content remains readable after dependency failures.

The Host Shell does not probe at startup and does not display an automatic Browser Bridge dialog. Settings reads the cached snapshot on demand and provides explicit Check connection and Reconnect actions. This feature is verified with Node, Runtime, TypeScript, and build checks only; it does not add Electron or browser UI testing.

## Consequences

The first Settings view can honestly say that the Bridge is not checked instead of making an unrequested connection attempt. A status report can be stale or unknown and must be treated as guidance rather than a durable installation fact. Login state remains Plugin-specific and cannot be inferred from a global doctor result.

The Host has two explicit mutation routes for recovery, and direct consumers of the old `{ connected, affected }` response must migrate to the new structured report. The old behavior is intentionally not preserved because the repository is under active development. The Plugin-level isolation principle from ADR 0020 remains part of this decision, but its global probing and lifecycle semantics are replaced here.
