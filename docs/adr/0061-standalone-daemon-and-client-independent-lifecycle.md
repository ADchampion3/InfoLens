# Standalone Plugin Runtime Daemon and Client-Independent Lifecycle

Status: accepted

Supersedes the Electron-owned lifecycle assumptions in [ADR 0041](0041-runtime-owned-plugin-lifecycle.md), [ADR 0054](0054-runtime-owned-batch-refresh-orchestration.md), and [ADR 0058](0058-browser-bridge-session-ux.md) where they make a Host Shell process the owner of Plugin Runtime lifetime. Their Plugin, task, batch, and browser dependency contracts remain in force.

## Context

The Host Web must be usable from a normal browser as well as from the Electron desktop shell. A Plugin Runtime tied to an Electron process cannot provide a stable local service, cannot survive a window close, and makes every client reproduce business operations. The daemon also needs a deterministic local data owner, discoverable loopback origin, authenticated HTTP boundary, and recovery behavior when one Plugin fails.

## Decision

The existing Plugin Runtime is promoted to the Infolens daemon. It owns the daemon data root, Plugin Directory, Plugin Stores, Host State, task and batch metadata, Managed Adapter Store, scheduler timers, operational logs, and daemon lock. It binds only to `127.0.0.1`, writes a versioned discovery record, and rejects a second writer for the same data root with `DAEMON_ALREADY_RUNNING`.

The daemon exposes the versioned `/api/v1` contract. Readiness and loopback health are public; business and administration routes require either a daemon Bearer credential or an HttpOnly browser session created through the local bootstrap route. Credential rotation changes only authentication material and never business state. Cross-origin clients require an explicit allowlist.

Electron is a thin client. It may start or discover the daemon, observe bounded restart status, provide OS primitives such as file selection, clipboard, and native download dialogs, and attach the BrowserWindow to the daemon-served Host Web. Plugin business reads, task control, Distribution operations, diagnostics, lifecycle, and backup/restore cross the daemon HTTP boundary. Closing the BrowserWindow disconnects the client and does not stop the daemon.

Plugin Workspaces receive a URL-scoped runtime configuration and a narrow capability result. They do not receive Node, Electron, persistent credentials, or arbitrary native handles. A failed or incompatible Plugin is represented as unavailable while sibling Plugins and daemon readiness remain available.

## Consequences

The same Host Web and Workspace Bundle work in a browser and in Electron. A daemon can be inspected, backed up, restored, credential-rotated, and stopped without the Host Shell. Runtime-owned state survives a client restart, while active work is marked interrupted and can be retried through the shared task and batch contracts.

The old `/runtime/*` business routes and unversioned Plugin API routes are not part of the daemon contract. Static Workspace support resources may retain their resource mount until the Workspace Bundle migration is complete; they are not business APIs. Release packaging uses Electron's embedded Node runtime to ship the daemon without requiring a user-installed Node executable.
