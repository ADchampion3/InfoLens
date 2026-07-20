# Shared Plugin Runtime and Task Scheduling

The Electron host starts one Node child process named Plugin Runtime. It dynamically loads every enabled plugin's backend module instead of starting one backend process per plugin. Modules retain their own SQLite stores, source-specific HTTP routes below `/plugins/<pluginId>/`, refresh policy, and workspace bundles.

Backend modules register named task handlers during activation. Enqueued work contains only plugin ID, task name, validated input, and trigger reason; crawler code remains inside the loaded module. The runtime allows one active collection per plugin, coalesces duplicate refreshes, permits up to three `PUBLIC` collections in parallel, and permits one browser-backed `COOKIE` or `INTERCEPT` collection at a time. It derives the resource permit from each manifest's declared OpenCLI command mapping and launches OpenCLI as a child process.

This reduces idle process and server overhead as plugin count grows while retaining plugin-specific data, UI, and operational status. The Electron host restarts Plugin Runtime if it exits and reactivates enabled modules; individual task failures remain plugin-local.

Removal first aborts the target module's tasks, invokes its cleanup handler, and unregisters its routes. If it fails to settle within a grace period, the host restarts Plugin Runtime without that module before deleting the module package and its data directory.
