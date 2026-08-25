# Shared Plugin Runtime and Task Scheduling

Status: superseded

Superseded by: [ADR 0061 - Standalone Plugin Runtime Daemon and Client-Independent Lifecycle](0061-standalone-daemon-and-client-independent-lifecycle.md)

ADR 0061 retains this ADR's shared Plugin Runtime, per-Plugin task queue, coalescing, and
OpenCLI resource-permit rules, but replaces the Electron-owned process lifetime. The
standalone daemon now owns discovery, activation, scheduling, and shutdown; Electron is a
client that may start or discover the daemon and does not stop it when its window closes.

The Electron host starts one Node child process named Plugin Runtime. It dynamically loads every enabled plugin's backend module instead of starting one backend process per plugin. Modules retain their own SQLite stores, source-specific HTTP routes below `/plugins/<pluginId>/`, refresh policy, and workspace bundles.

Backend modules register named task handlers during activation. Enqueued work contains only plugin ID, task name, input, and trigger reason; the loaded handler validates its own input and crawler code remains inside the loaded module. The runtime allows one active collection per plugin, coalesces duplicate refreshes, permits up to three `PUBLIC` collections in parallel, and permits one browser-backed `COOKIE` or `INTERCEPT` collection at a time. It derives the resource permit from each manifest's declared OpenCLI command mapping and launches OpenCLI as a child process.

This reduces idle process and server overhead as plugin count grows while retaining plugin-specific data, UI, and operational status. The Electron host restarts Plugin Runtime if it exits and reactivates enabled modules; individual task failures remain plugin-local.

Removal first aborts the target module's tasks, invokes its cleanup handler, and unregisters its routes. If it fails to settle within a grace period, the host restarts Plugin Runtime without that module before deleting the module package and its data directory.
