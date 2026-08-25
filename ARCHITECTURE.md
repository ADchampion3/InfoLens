# Infolens Architecture

[English](ARCHITECTURE.md) | [简体中文](ARCHITECTURE.zh-CN.md)

## Status

This is the current architecture baseline for the MVP. It records the trusted-plugin boundary, standalone daemon, browser/Electron clients, package contract, workspace embedding, plugin persistence, versioned HTTP API, and local diagnostics policy.

## Architectural Intent

Infolens is a local-first application built around a standalone Infolens daemon. The daemon owns Plugin Runtime, plugin discovery, persistent state, task execution, diagnostics, and the versioned business HTTP API. Host Web is the client-facing shell and can run in a normal browser or inside the Electron desktop shell. The Electron process is a thin client that may start or discover the daemon and provide OS primitives; it is not the daemon's lifecycle owner. Each plugin owns its source collection, source-specific local persistence, refresh behavior, and full user interface.

The daemon distribution bundles a pinned OpenCLI runtime and invokes its application-local CLI path. Infolens does not depend on a user's global `opencli` installation, PATH configuration, Node installation, or npm setup. Plugin Backends never spawn OpenCLI, use global adapter discovery, or pass arbitrary command paths. They call only `context.opencli.run(commandKey, args, signal)`; the daemon resolves the manifest-declared command mapping and its managed adapter scope. Browser-backed OpenCLI adapters still require the user to install and connect the Chrome Browser Bridge extension; Host Web exposes the dependency state and recovery actions.

Browser Bridge availability is a plugin-level dependency. A missing connection or expired site login makes only the affected plugin unavailable for browser-backed collection; browser-independent plugins continue to start, refresh, and render normally. An affected plugin owns the detailed connection or login guidance in its workspace, while the host exposes a concise dependency state in navigation.

The application must not fork OpenCLI or copy its browser bridge, Chrome daemon, extension protocol, adapter discovery, or scraping logic. The daemon may use OpenCLI's existing read-oriented adapters for the MVP sources and its browser-backed execution path when an adapter requires login, but only through the declared command and managed adapter boundary.

## System Boundary

```text
Browser Client / Electron Client
  Host Web Shell
  Plugin Navigation and Settings
  Plugin Workspace Container
          |
          | authenticated loopback HTTP: /api/v1
          v
Standalone Infolens Daemon
  Discovery and Package Validation
  Plugin Lifecycle and Host State
  Plugin Task and Batch Scheduling
  Diagnostics and Backup/Restore
  Versioned Business API (/api/v1)
          |
          v
Trusted Source Plugins
  OpenCLI Strategy Representative Plugins
    Hacker News Plugin (PUBLIC)
    GitHub Trending Plugin (PUBLIC)
    Zhihu Hot List Plugin (COOKIE)
    Product Hunt Plugin (INTERCEPT)
    Plugin UI
      same-origin HTTP through the daemon
          |
          v
Plugin Runtime inside the Daemon
  Plugin Backend Modules
  Plugin Workspace Static Assets
  Plugin-Scoped HTTP Routes
  Plugin Task Scheduler
  Plugin Stores and Refresh Logic
  OpenCLI CLI Process Adapter
          |
          v
OpenCLI Runtime
  Bundled Pinned CLI
  Adapter Registry and Commands
  Browser Bridge / Local Daemon
  Chrome Profile and Login State
          |
          v
External Sources
  Hacker News | GitHub Trending | Zhihu | Product Hunt
```

The daemon owns plugin discovery, package validation, lifecycle, Host State, task/batch scheduling, diagnostics, and the `/api/v1` business boundary. Host Web owns navigation, presentation, and client-session state. Electron may start or discover the daemon, attach its BrowserWindow to the daemon-served Host Web, and provide OS primitives; closing that window disconnects the client without stopping the daemon. A plugin owns its persistent records, refresh policy, content UI, and source-specific schema. OpenCLI owns how a daemon-authorized, manifest-declared collection command obtains its result.

## Repository Layout

```text
apps/desktop/              Electron thin client and OS integration
packages/plugin-runtime/   standalone daemon and Plugin Runtime
packages/plugin-sdk/       shared manifest, backend, and workspace helpers
plugins/hn/                bundled Hacker News plugin (`PUBLIC`)
plugins/github-trending/   bundled GitHub Trending plugin (`PUBLIC`)
plugins/zhihu-hot/         bundled Zhihu Hot List plugin (`COOKIE`)
plugins/product-hunt/      bundled Product Hunt plugin (`INTERCEPT`)
```

The repository's fixed `plugins/` directory is the sole development and daemon discovery location for built packages. The MVP does not distinguish official and user-installed package locations; every discovered package has the same daemon-owned lifecycle and removal semantics.

Host Web uses React, Vite, and TypeScript. It renders a persistent left plugin-navigation rail, a right-side workspace frame for the selected plugin, and plugin-management/application-settings entries at the bottom of navigation. It owns navigation, daemon-backed lifecycle status, and client-facing error states; it does not render a content dashboard or plugin business content. Electron supplies the window and OS integration but does not duplicate this business logic.

## Plugin SDK Boundary

`@infolens/plugin-sdk` is a thin runtime-contract package. It provides typed manifest helpers, backend-module activation and health helpers, plugin data-directory access, task registration, enqueueing, and schedule-registration helpers, an OpenCLI JSON invocation helper, and workspace helpers for resolving the plugin's `/api/v1` paths in the daemon. `/runtime/` is reserved for static workspace support resources such as the browser SDK; it is not a business API.

The SDK does not define a content schema, database, refresh policy, UI component system, or frontend framework. Those are plugin-owned decisions. Plugin Runtime implements the shared scheduler from plugin-registered policies.

## Bundled Plugin Persistence

Each bundled MVP plugin stores its records in an independent SQLite database in its own plugin data directory. Every plugin owns its schema version and migrations; the daemon neither coordinates nor interprets those migrations. This keeps persistence implementation consistent for the bundled plugins without creating a cross-plugin schema or database.

## Host State

The daemon persists Host State and other daemon-owned metadata in atomically written files below its daemon data root. It stores enabled plugin IDs, the last selected available plugin, a system/light/dark theme preference, one status snapshot per plugin, task and batch evidence, diagnostics, and the daemon discovery record. Host Web and Electron keep only ephemeral client state; they do not become a second owner of plugin state or lifecycle.

Bundled plugins follow the selected host theme. Third-party plugins may opt into the theme convention, but the host does not require them to use its UI components or styling system.

## Plugin Package Contract

A trusted plugin package contains:

```text
plugin/
  manifest.json
  backend/
    index.js
  web/
    dist/
      index.html
      assets/
```

Every plugin must provide a built static Web workspace at `web/dist/index.html`; all workspace asset URLs must be relative to that entry so the daemon remains able to serve the bundle below `/plugins/<pluginId>/workspace/`. The daemon does not require a specific frontend framework inside that bundle. The Host Web and bundled MVP plugins use React and Vite.

The initial manifest contract declares at least:

- stable plugin `id`, display `name`, `version`, and optional `icon`
- `contractVersion` for the Infolens plugin package contract and `minHostVersion` as a semantic-version minimum
- `backend.entry` for the plugin backend-module activation entry point
- `ui.entry` for the built plugin workspace
- the plugin's OpenCLI command mapping

Plugin Contract Version 2 is the only supported package contract. An OpenCLI command mapping is keyed by `commandKey` and explicitly names either `adapter: "builtin"` or a Provided OpenCLI Adapter declaration. Each entry also declares `site`, an immutable `command` path, `strategy` (`PUBLIC`, `COOKIE`, or `INTERCEPT`), `access: "read"`, and `outputFormat: "json"`. Adapter compatibility belongs to the standard `opencli-plugin.json`; the Runtime verifies it against the pinned OpenCLI version, probes actual registration, rejects hooks and command collisions, and writes the result to the plugin's Scope Lock. `UI` remains unsupported.

Provided Adapters are copied into an Infolens-managed immutable Store outside OpenCLI's `node_modules`. Identical ID, version, and content hashes are deduplicated; different content under the same ID and version is rejected. Multiple versions may coexist. Each plugin receives a Scope Lock containing exact Adapter paths, versions, hashes, and registered commands. OpenCLI runs with user-global discovery disabled and receives only those exact paths. Development scopes link source files, while installed scopes reference immutable Store content.

Before copying a local package into the managed plugin directory, the daemon checks that `contractVersion` is supported, that its own semantic version satisfies `minHostVersion`, and that every declared command mapping is supported. The daemon repeats those checks for every package during startup discovery. It rejects an incompatible package with the reason before any installation changes or module activation. A rejected discovered package is not activated or shown in ordinary navigation, but remains visible in plugin management for inspection and removal. The daemon otherwise performs only structural package validation needed for discovery and startup. Installed local plugins are trusted by default: there is no permission approval, package review, data-generation system, or governed upgrade transaction.

At startup, the daemon scans the project's fixed `plugins/` directory for plugin packages. It installs a prebuilt plugin selected from a local folder by copying it into that managed discovery location and enables it immediately after successful validation. A valid discovered plugin with no prior daemon state is enabled by default; a user-disabled plugin remains disabled. MVP development builds and runs official plugins in their repository directories; it does not support external development links, symbolic links, or plugin hot reload.

The daemon does not upgrade or replace an installed plugin in place. A local installation whose manifest ID already exists is rejected with a message directing the user to remove the existing plugin through the plugin-management surface before installing another package with that ID. There is no automatic package rollback or data migration transaction.

Explicit plugin removal asks the daemon to deactivate the plugin module, cancel its tasks, and unregister its routes before deleting both its package and its plugin-owned data directory. If the module does not settle within a short grace period, the daemon restarts its in-process Plugin Runtime without that module before deletion. The daemon does not retain source data across a manual replacement because a newly installed plugin package may use an incompatible data format.

The daemon serves each plugin's built Web workspace at `http://127.0.0.1:<daemonPort>/plugins/<pluginId>/workspace/`, its business API below `http://127.0.0.1:<daemonPort>/api/v1/plugins/<pluginId>/api/`, and health at `GET /api/v1/plugins/<pluginId>/health`. Host Web opens the workspace URL in a frame; the plugin controls the workspace body while Host Web controls navigation around it. The common daemon origin lets a workspace call its API without CORS or an Electron security exception. Electron attaches to this origin and may reconnect after a daemon restart; it does not own the daemon process.

## Minimal Plugin Lifecycle Contract

The daemon binds one loopback API port and writes a discovery record for clients. During activation, each enabled backend module receives its plugin data directory and registers its API routes and task handlers. A plugin becomes available only after `GET /api/v1/plugins/<pluginId>/health` returns `ready`; until then Host Web shows it as starting or unavailable.

The health response may also include a last-refresh timestamp and a short optional navigation badge. The host treats a badge as opaque plugin metadata: it displays the value without assigning shared unread, task, or content semantics to it.

To stop or remove a plugin, the daemon asks Plugin Runtime to abort that module's tasks, invoke its cleanup handler, and unregister its routes. It waits for a short grace period. If the module does not settle, the daemon restarts Plugin Runtime without the module before completing removal. Clients use the authenticated `/api/v1` administration boundary; they do not control in-process module state directly.

## Plugin UI and Backend Communication

Each backend module registers a plugin-scoped local HTTP API in the daemon below `/api/v1/plugins/<pluginId>/api/`; its health endpoint is `GET /api/v1/plugins/<pluginId>/health`. When opening a workspace, Host Web places `pluginId` and that plugin-scoped same-origin `apiBaseUrl` in its URL query parameters; workspace helpers read those values and call the plugin API directly for content, refresh actions, and plugin-defined interactions. The Electron client does not route, validate, or translate business requests. When the daemon restarts, clients reconnect to the discovered origin and reload affected workspaces.

The host also supplies the initial theme in the iframe URL and sends theme changes as a minimal `postMessage` payload. Workspace SDK helpers read the initial value and subscribe to updates. This is an appearance-only convention, not a host business RPC channel.

The standalone daemon runs the shared Plugin Runtime in its own Node process. It dynamically loads every enabled backend module, scopes its routes and task state by plugin ID, serves workspace assets, and invokes OpenCLI through local CLI child processes. A backend module owns its source-specific persistence and HTTP handlers, while the daemon owns lifecycle, task scheduling, resource permits, static workspace delivery, route dispatch, authentication, and client sessions. Electron may verify readiness and retain transient connection status, but it does not proxy OpenCLI commands or expose a second business RPC surface.

## Plugin Backend Module Interface

Every `backend.entry` exports an `activate(context)` function. The runtime calls it once during module activation and expects a cleanup-capable lifecycle result. The activation context provides the plugin ID and data directory, plugin-scoped HTTP route registration, task definition/enqueueing/schedule registration, a logger, and `opencli.run(commandKey, args, signal)`.

A backend module opens and migrates its own SQLite store from its data directory. It registers routes under its own prefix and registers handlers for long-running work. It reads its refresh setting from its own store and registers the selected schedule through the context; it must not create an independent timer or scheduler. The runtime supplies task cancellation and enforces execution permits.

`opencli.run` accepts only a command key declared in that plugin's manifest mapping. The loaded backend module passes its already-validated task arguments directly as the command's argument vector; Runtime does not introduce a serialized argument schema or a second task-transfer protocol. The runtime resolves the immutable command path, verifies the pinned OpenCLI version and command availability, obtains the appropriate resource permit, and starts the bundled OpenCLI process with JSON output. A backend module must not listen on its own port, create an OpenCLI subprocess directly, or manage an independent scheduler. Its cleanup result cancels source-owned resources such as database handles and subscriptions during deactivation.

The runtime wraps module activation, route handlers, task handlers, and cleanup in plugin-scoped error boundaries. An ordinary plugin exception marks only that plugin unavailable or failed and leaves sibling modules running. A Runtime-level exit can briefly interrupt all plugin APIs while the daemon recovers and reactivates enabled modules; clients reconnect to the daemon origin. The MVP does not attempt to prevent a trusted plugin from deliberately terminating the Runtime process or causing a native-process crash.

## Local Diagnostics

The daemon emits structured lifecycle and refresh outcomes and atomically persists its Host State. Host State does not contain raw logs, collected source records, website credentials, Chrome profiles, or Browser Bridge session data.

The activation-context logger writes a bounded rotating log for each plugin in that plugin's data directory. Host Web can request a diagnostic report from the daemon's `/api/v1` diagnostics boundary containing the status snapshot and recent log entries for the selected plugin, then copy it locally. Reports are per-plugin and contain neither source records nor authentication material. Plugin removal deletes those logs together with the package data.

## Plugin Task Execution

During activation, a backend module registers named task handlers with the daemon's Plugin Runtime. A task enqueue request contains only plugin ID, task name, input, and trigger reason; the loaded handler validates its own input and its crawler implementation remains in-memory plugin code rather than being sent over HTTP or serialized into the queue.

Plugin workspaces invoke their own routes to enqueue long-running work such as refreshes. Plugin-local schedules use the same enqueue path. Short SQLite reads and detail queries execute directly in their plugin route handlers.

The daemon permits at most one active collection task per plugin and coalesces duplicate refresh requests for that plugin. Each `opencli.run` obtains a permit from its validated command mapping: at most three `PUBLIC` commands may run concurrently and one browser-backed `COOKIE` or `INTERCEPT` command may run at once. A task may therefore call commands with different strategies without classifying the whole plugin as browser-backed. A task failure updates only that plugin's status; if the daemon itself exits, a client may reconnect after it is restarted and active work is marked interrupted.

## Plugin Collection Contract

Each plugin declares an OpenCLI command mapping, but the daemon is the only process boundary into OpenCLI. A Plugin Backend uses the injected `context.opencli.run(commandKey, args, signal)` capability and must:

1. Pass only a manifest-declared command key and already-validated argument vector.
2. Let the daemon select the pinned executable, managed adapter scope, resource permit, and JSON output.
3. Return the daemon result together with execution metadata such as start time, finish time, failure, and raw source identifier.
4. Never expose OpenCLI command parsing, browser transport, or browser session implementation to UI code.

For the MVP, each trusted plugin maps its source to the corresponding OpenCLI read command. The mapping stays inside the plugin manifest and Backend; Host Web selects a plugin or task, not a source or arbitrary command string. The daemon rejects undeclared command keys and user-supplied command paths.

The bundled MVP is not complete until it includes normally working, user-visible official source plugins for its three OpenCLI website collection strategies: Hacker News and GitHub Trending for `PUBLIC`, Zhihu Hot List for `COOKIE`, and Product Hunt Today's Top Launches for `INTERCEPT`. These are official daily-use workspaces, not hidden strategy-verification fixtures. The strategy is declared in each plugin's OpenCLI command mapping and must match its real adapter execution.

OpenCLI's `UI` strategy is outside the current plugin package and runtime contract. It is neither bundled nor accepted for local installation in the MVP. Supporting it later requires a contract revision that defines its interactive execution and resource policy.

Release verification runs all four MVP plugins through the bundled OpenCLI runtime in a real source environment on a release-candidate developer machine. The environment has Browser Bridge connected and the required browser session available. A representative passes only when its OpenCLI command produces a usable result, the plugin persists that result in its own SQLite store, and its workspace renders the retained result. Fake OpenCLI output is permitted for isolated automated tests but is not evidence that a strategy representative works.

CI runs credential-free unit and contract tests only. It does not retain website credentials, Chrome profiles, or Browser Bridge sessions, and it is not evidence of real `COOKIE` or `INTERCEPT` operation.

## Runtime Flow

### Start Application

1. The daemon discovers plugin packages, validates their package and OpenCLI compatibility, and determines their enabled state. Compatible packages without prior daemon state are enabled by default; rejected packages remain available only in plugin management.
2. The daemon starts its Plugin Runtime, activates every enabled plugin Backend, binds loopback HTTP, and writes the discovery record.
3. Host Web or Electron bootstraps/authenticates through `/api/v1`, reads daemon-backed status, and opens the selected workspace.
4. A running plugin follows its own refresh policy for the daemon lifetime, independent of any one client.

### Exit Application

1. Closing the Electron BrowserWindow disconnects that client; it does not stop the daemon.
2. The daemon continues serving Host Web, plugin workspaces, and scheduled work for other clients.
3. An explicit authenticated daemon stop deactivates modules and marks unfinished tasks or batch items `interrupted`; it is not an implicit Electron window action.

### Open Plugin

1. Host Web renders plugin navigation and daemon-backed status.
2. The user selects a plugin.
3. Host Web opens that plugin's daemon-served workspace in the main content area.
4. The plugin reads and renders its own retained records.

### Refresh

1. A plugin UI action or its own refresh policy requests a refresh.
2. The daemon coalesces conflicting collection work for that plugin and applies the relevant resource permit.
3. The plugin Backend requests its declared command through `context.opencli.run`; the daemon invokes OpenCLI.
4. OpenCLI uses its native public-fetch or browser-backed mechanism as required by that adapter.
5. The plugin validates and persists a successful result using its own source-specific record model.
6. On failure, the plugin retains its latest successful records and the daemon records operational status for clients.

## Core Concepts

**Plugin** is a trusted local package that owns the collection, persistence, and workspace for one source-oriented information experience.

The bundled MVP plugins are newly designed against the Infolens package contract. They may reuse general React, Vite, Electron, and OpenCLI techniques, but do not inherit TractIt's plugin behavior, data model, lifecycle, or workspace implementation.

**Plugin Workspace** is the complete main-content user interface rendered by one plugin.

**Plugin Manifest** is the small package descriptor the daemon uses to validate, identify, activate, and expose a plugin.

**Source** is the external provider that a plugin collects from. The MVP sources are Hacker News, GitHub Trending, Zhihu Hot List, and Product Hunt Today's Top Launches.

**Refresh Policy** is a plugin-defined rule for when its source is collected. Manual-only is a valid policy.

For bundled plugins, the user chooses manual-only, disabled, or a supported fixed interval in that plugin's workspace settings. The plugin persists the setting in its SQLite store and schedules its own collection; the host only displays resulting status.

All newly installed plugins begin in manual-only mode. A plugin performs automatic background collection only after the user explicitly selects an interval in that plugin's settings.

**Plugin Store** is the local persistent store owned by one plugin. It retains that plugin's records and evolves without a host-defined business schema.

## Reliability Principles

- Plugin-owned cached content is the primary read path; collection is asynchronous work.
- An ordinary plugin activation, route, task, or cleanup failure is isolated and must not block Host Web navigation or other plugins. A daemon-level crash may briefly interrupt plugin APIs before recovery; active work is marked interrupted.
- A plugin keeps its newest successful content until it replaces it successfully.
- The daemon exposes concise lifecycle and last-refresh status through `/api/v1`, while a plugin chooses its own detailed refresh UI.
- OpenCLI may report an uncertain browser-command outcome. The plugin records it as uncertain or failed and does not silently replay the collection.

## Security Position

The MVP is a single-user local application that trusts installed plugins by default. It has no plugin permission-review, approval, or hostile-code sandboxing layer. The host still contains ordinary failures by keeping plugin lifecycle, workspace loading, logs, and diagnostics separate from its own navigation UI.

## Explicit Non-Architecture

The MVP is not a hosted multi-tenant service, a distributed crawler system, a plugin marketplace, a generic OpenCLI command launcher, a centrally normalized source-data store, or a host-owned cross-plugin content feed.
