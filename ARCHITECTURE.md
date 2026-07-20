# Infolens Architecture

## Status

This is the current architecture baseline for the MVP. It records the trusted-plugin boundary, Electron host, package contract, workspace embedding, plugin persistence, shared Plugin Runtime, and local diagnostics policy.

## Architectural Intent

Infolens is an Electron desktop plugin host. Its main content area is a plugin workspace, not a host-owned information feed. Each plugin owns its source collection, source-specific local persistence, refresh behavior, and full user interface. OpenCLI is the shared external collection and browser-execution runtime.

The Electron distribution bundles a pinned OpenCLI runtime and invokes its application-local CLI path. Infolens does not depend on a user's global `opencli` installation, PATH configuration, Node installation, or npm setup. Browser-backed OpenCLI adapters still require the user to install and connect the Chrome Browser Bridge extension; the host checks and guides this prerequisite during first-run setup.

Browser Bridge availability is a plugin-level dependency. A missing connection or expired site login makes only the affected plugin unavailable for browser-backed collection; browser-independent plugins continue to start, refresh, and render normally. An affected plugin owns the detailed connection or login guidance in its workspace, while the host exposes a concise dependency state in navigation.

The application must not fork OpenCLI or copy its browser bridge, Chrome daemon, extension protocol, adapter discovery, or scraping logic. It may use OpenCLI's existing read-oriented adapters for the MVP sources and its browser-backed execution path when an adapter requires login.

## System Boundary

```text
Electron Main Process
  Plugin Lifecycle and Status
          |
          v
Electron Renderer Shell
  Plugin Navigation
  Iframe Plugin Workspace Container
          |
          v
Trusted Source Plugins
  OpenCLI Strategy Representative Plugins
    Hacker News Plugin (PUBLIC)
    GitHub Trending Plugin (PUBLIC)
    Zhihu Hot List Plugin (COOKIE)
    Product Hunt Plugin (INTERCEPT)
    Plugin UI
      direct HTTP
          |
          v
Shared Plugin Runtime (One Node Child Process)
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

The host owns plugin discovery, navigation, lifecycle status, and basic diagnostics. A plugin owns its persistent records, refresh policy, content UI, and source-specific schema. OpenCLI owns how a requested collection command obtains its result.

## Repository Layout

```text
apps/desktop/              Electron host
packages/plugin-sdk/       shared manifest, backend, and workspace helpers
plugins/hn/                bundled Hacker News plugin (`PUBLIC`)
plugins/github-trending/   bundled GitHub Trending plugin (`PUBLIC`)
plugins/zhihu-hot/         bundled Zhihu Hot List plugin (`COOKIE`)
plugins/product-hunt/      bundled Product Hunt plugin (`INTERCEPT`)
```

The repository's fixed `plugins/` directory is the sole development and runtime discovery location for built packages. The MVP does not distinguish official and user-installed package locations; every discovered package has the same lifecycle and removal semantics.

The Electron host renderer uses React, Vite, and TypeScript. It renders a persistent left plugin-navigation rail, a right-side workspace frame for the selected plugin, and plugin-management/application-settings entries at the bottom of navigation. It owns navigation, lifecycle status, and host-level error states; it does not render a content dashboard or plugin business content.

## Plugin SDK Boundary

`@infolens/plugin-sdk` is a thin runtime-contract package. It provides typed manifest helpers, backend-module activation and `/health` helpers, plugin data-directory access, task registration, enqueueing, and schedule-registration helpers, an OpenCLI JSON CLI invocation helper, and workspace helpers for resolving the plugin's API path in the shared runtime.

The SDK does not define a content schema, database, refresh policy, UI component system, or frontend framework. Those are plugin-owned decisions. Plugin Runtime implements the shared scheduler from plugin-registered policies.

## Bundled Plugin Persistence

Each bundled MVP plugin stores its records in an independent SQLite database in its own plugin data directory. Every plugin owns its schema version and migrations; the host neither coordinates nor interprets those migrations. This keeps persistence implementation consistent for the bundled plugins without creating a cross-plugin schema or database.

## Host State

The host persists only its own lightweight state in an atomically written JSON file in the application data directory. It stores enabled plugin IDs, the last selected available plugin, a system/light/dark theme preference, and one status snapshot per plugin: current lifecycle state, last successful refresh time, and the latest failure time, code, and short message. The host scans manifests from the fixed plugin directory rather than maintaining an installed-plugin registry database.

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

Every plugin must provide a built static Web workspace at `web/dist/index.html`; all workspace asset URLs must be relative to that entry so the bundle remains valid when Runtime mounts it below `/plugins/<pluginId>/workspace/`. The host does not require a specific frontend framework inside that bundle. The Electron host and the bundled MVP plugins use React and Vite to reuse existing TractIt frontend code.

The initial manifest contract declares at least:

- stable plugin `id`, display `name`, `version`, and optional `icon`
- `contractVersion` for the Infolens plugin package contract and `minHostVersion` as a semantic-version minimum
- `backend.entry` for the plugin backend-module activation entry point
- `ui.entry` for the built plugin workspace
- the plugin's OpenCLI command mapping

An OpenCLI command mapping is an object keyed by `commandKey`. Each entry declares `site`, an immutable `command` path, `strategy` (`PUBLIC`, `COOKIE`, or `INTERCEPT`), `access: "read"`, `outputFormat: "json"`, and a semantic-version `openCliVersionRange`. Plugin Runtime rejects unsupported strategies and non-read mappings, verifies that its pinned OpenCLI runtime satisfies the range and resolves the declared `site` and command path, then uses the declared strategy for scheduling. `UI` is not accepted by the current plugin package contract. Task argument validation remains direct plugin-module code, not a serialized manifest schema or a second Runtime protocol.

Before copying a local package into the managed plugin directory, the host checks that `contractVersion` is supported, that its own semantic version satisfies `minHostVersion`, and that every declared command mapping is supported. The host repeats those checks for every package during startup discovery. It rejects an incompatible package with the reason before any installation changes or module activation. A rejected discovered package is not activated or shown in ordinary navigation, but remains visible in plugin management for inspection and removal. The host otherwise performs only structural package validation needed for discovery and startup. Installed local plugins are trusted by default: there is no permission approval, package review, data-generation system, or governed upgrade transaction.

At startup, the host scans the project's fixed `plugins/` directory for plugin packages. It installs a prebuilt plugin selected from a local folder by copying it into that managed discovery location and enables it immediately after successful validation. A valid discovered plugin with no prior host state is enabled by default; a user-disabled plugin remains disabled. MVP development builds and runs official plugins in their repository directories; it does not support external development links, symbolic links, or plugin hot reload.

The host does not upgrade or replace an installed plugin in place. A local installation whose manifest ID already exists is rejected with a message directing the user to remove the existing plugin through the plugin-management surface before installing another package with that ID. There is no automatic package rollback or data migration transaction.

Explicit plugin removal asks the shared runtime to deactivate the plugin module, cancel its tasks, and unregister its routes before deleting both its package and its plugin-owned data directory. If the module does not settle within a short grace period, the host restarts the shared runtime without that module before deletion. The host does not retain source data across a manual replacement because a newly installed plugin package may use an incompatible data format.

Plugin Runtime serves each plugin's built Web workspace at `http://127.0.0.1:<runtimePort>/plugins/<pluginId>/workspace/` and its API below `http://127.0.0.1:<runtimePort>/plugins/<pluginId>/api/`. The Electron renderer opens the workspace URL in an iframe; the plugin controls the iframe body while the host controls navigation around it. The common Runtime origin lets a workspace call its API without CORS or an Electron security exception. The host starts one Plugin Runtime process, activates enabled backend modules within it, and opens a workspace on selection.

## Minimal Plugin Lifecycle Contract

The host assigns one loopback API port to the shared Plugin Runtime. During activation, each enabled backend module receives its plugin data directory and registers its API routes and task handlers. A plugin becomes available only after `GET /plugins/<pluginId>/health` returns `ready`; until then the host shows it as starting or unavailable.

The health response may also include a last-refresh timestamp and a short optional navigation badge. The host treats a badge as opaque plugin metadata: it displays the value without assigning shared unread, task, or content semantics to it.

To stop or remove a plugin, the host asks Plugin Runtime to abort that module's tasks, invoke its cleanup handler, and unregister its routes. It waits for a short grace period. If the module does not settle, the host restarts Plugin Runtime without the module before completing removal. No authenticated IPC handshake, capability gateway, or governed runtime state machine is required.

## Plugin UI and Backend Communication

Each backend module registers a plugin-scoped local HTTP API in the shared Plugin Runtime below `/plugins/<pluginId>/api/`; its health endpoint is `GET /plugins/<pluginId>/health`. When opening an iframe, the host places `pluginId` and that plugin-scoped same-origin `apiBaseUrl` in its URL query parameters; workspace helpers read those values and call the plugin API directly for content, refresh actions, and plugin-defined interactions. The Electron host does not route, validate, or translate business requests. When the shared runtime restarts, the host reloads affected iframes with the new API address.

The host also supplies the initial theme in the iframe URL and sends theme changes as a minimal `postMessage` payload. Workspace SDK helpers read the initial value and subscribe to updates. This is an appearance-only convention, not a host business RPC channel.

The Electron host runs one shared Plugin Runtime as a Node child process. The runtime dynamically loads every enabled backend module, scopes its routes and task state by plugin ID, serves workspace assets, and invokes OpenCLI through local CLI child processes. A backend module owns its source-specific persistence and HTTP handlers, while the runtime owns lifecycle, task scheduling, resource permits, static workspace delivery, and route dispatch. The host may verify readiness and retain lifecycle status, but it does not proxy OpenCLI commands or expose a shared business RPC surface.

## Plugin Backend Module Interface

Every `backend.entry` exports an `activate(context)` function. The runtime calls it once during module activation and expects a cleanup-capable lifecycle result. The activation context provides the plugin ID and data directory, plugin-scoped HTTP route registration, task definition/enqueueing/schedule registration, a logger, and `opencli.run(commandKey, args, signal)`.

A backend module opens and migrates its own SQLite store from its data directory. It registers routes under its own prefix and registers handlers for long-running work. It reads its refresh setting from its own store and registers the selected schedule through the context; it must not create an independent timer or scheduler. The runtime supplies task cancellation and enforces execution permits.

`opencli.run` accepts only a command key declared in that plugin's manifest mapping. The loaded backend module passes its already-validated task arguments directly as the command's argument vector; Runtime does not introduce a serialized argument schema or a second task-transfer protocol. The runtime resolves the immutable command path, verifies the pinned OpenCLI version and command availability, obtains the appropriate resource permit, and starts the bundled OpenCLI process with JSON output. A backend module must not listen on its own port, create an OpenCLI subprocess directly, or manage an independent scheduler. Its cleanup result cancels source-owned resources such as database handles and subscriptions during deactivation.

The runtime wraps module activation, route handlers, task handlers, and cleanup in plugin-scoped error boundaries. An ordinary plugin exception marks only that plugin unavailable or failed and leaves sibling modules running. A Runtime-level exit can briefly interrupt all plugin APIs while the host restarts and reactivates enabled modules. The MVP does not attempt to prevent a trusted plugin from deliberately terminating the Runtime process or causing a native-process crash.

## Local Diagnostics

Plugin Runtime emits structured lifecycle and refresh outcomes to the host so it can atomically persist the status snapshot. The host state does not contain raw logs, collected source records, website credentials, Chrome profiles, or Browser Bridge session data.

The activation-context logger writes a bounded rotating log for each plugin in that plugin's data directory. The plugin manager can request a diagnostic report from Plugin Runtime containing the status snapshot and recent log entries for the selected plugin, then copy it locally. Reports are per-plugin and contain neither source records nor authentication material. Plugin removal deletes those logs together with the package data.

## Plugin Task Execution

During activation, a backend module registers named task handlers with the Plugin Runtime. A task enqueue request contains only plugin ID, task name, input, and trigger reason; the loaded handler validates its own input and its crawler implementation remains in-memory plugin code rather than being sent over HTTP or serialized into the queue.

Plugin workspaces invoke their own routes to enqueue long-running work such as refreshes. Plugin-local schedules use the same enqueue path. Short SQLite reads and detail queries execute directly in their plugin route handlers.

The runtime permits at most one active collection task per plugin and coalesces duplicate refresh requests for that plugin. Across plugins, it permits at most three `PUBLIC` collection commands at once and one browser-backed `COOKIE` or `INTERCEPT` command at once. The runtime derives the required permit from the plugin manifest's declared OpenCLI command mapping before spawning OpenCLI. A task failure updates only that plugin's status; if the runtime itself exits, the host restarts it and reactivates enabled modules. `UI` mappings are rejected, so no unclassified browser work can enter this scheduler.

## Plugin Collection Contract

Each plugin uses an OpenCLI CLI Process Adapter as its only integration point into OpenCLI. It must:

1. Start a known, read-only local OpenCLI command for a requested source with JSON output.
2. Request a machine-readable result format.
3. Return the command result together with execution metadata such as start time, finish time, failure, and raw source identifier.
4. Never expose OpenCLI command parsing, browser transport, or browser session implementation to UI code.

For the MVP, each trusted plugin maps its source to the corresponding OpenCLI read command. This mapping stays inside the plugin; host UI code selects a plugin, not a source or command string.

The bundled MVP is not complete until it includes normally working, user-visible official source plugins for its three OpenCLI website collection strategies: Hacker News and GitHub Trending for `PUBLIC`, Zhihu Hot List for `COOKIE`, and Product Hunt Today's Top Launches for `INTERCEPT`. These are official daily-use workspaces, not hidden strategy-verification fixtures. The strategy is declared in each plugin's OpenCLI command mapping and must match its real adapter execution.

OpenCLI's `UI` strategy is outside the current plugin package and runtime contract. It is neither bundled nor accepted for local installation in the MVP. Supporting it later requires a contract revision that defines its interactive execution and resource policy.

Release verification runs all four MVP plugins through the bundled OpenCLI runtime in a real source environment on a release-candidate developer machine. The environment has Browser Bridge connected and the required browser session available. A representative passes only when its OpenCLI command produces a usable result, the plugin persists that result in its own SQLite store, and its workspace renders the retained result. Fake OpenCLI output is permitted for isolated automated tests but is not evidence that a strategy representative works.

CI runs credential-free unit and contract tests only. It does not retain website credentials, Chrome profiles, or Browser Bridge sessions, and it is not evidence of real `COOKIE` or `INTERCEPT` operation.

## Runtime Flow

### Start Application

1. The host discovers plugin packages, validates their package and OpenCLI compatibility, and determines their enabled state. Compatible packages without prior host state are enabled by default; rejected packages remain available only in plugin management.
2. The host starts one shared Plugin Runtime and activates every enabled plugin backend module.
3. Each plugin reports readiness through its scoped local API path; the host records its lifecycle state.
4. A running plugin follows its own refresh policy for the duration of the application session.

### Exit Application

1. Closing the main window exits the application in the MVP.
2. The host stops the shared Plugin Runtime, which deactivates all backend modules and cancels unfinished tasks.
3. No plugin refresh continues after exit; the MVP has no implicit tray-resident background process.

### Open Plugin

1. The host renders plugin navigation and basic status.
2. The user selects a plugin.
3. The host opens that plugin's workspace in the main content area.
4. The plugin reads and renders its own retained records.

### Refresh

1. A plugin UI action or its own refresh policy requests a refresh.
2. Plugin Runtime coalesces conflicting collection work for that plugin and applies the relevant resource permit.
3. The plugin's OpenCLI Collection Adapter invokes OpenCLI.
4. OpenCLI uses its native public-fetch or browser-backed mechanism as required by that adapter.
5. The plugin validates and persists a successful result using its own source-specific record model.
6. On failure, the plugin retains its latest successful records and reports operational status to the host.

## Core Concepts

**Plugin** is a trusted local package that owns the collection, persistence, and workspace for one source-oriented information experience.

The bundled MVP plugins are newly designed against the Infolens package contract. They may reuse general React, Vite, Electron, and OpenCLI techniques, but do not inherit TractIt's plugin behavior, data model, lifecycle, or workspace implementation.

**Plugin Workspace** is the complete main-content user interface rendered by one plugin.

**Plugin Manifest** is the small package descriptor the host uses to identify, navigate to, and start a plugin.

**Source** is the external provider that a plugin collects from. The MVP sources are Hacker News, GitHub Trending, Zhihu Hot List, and Product Hunt Today's Top Launches.

**Refresh Policy** is a plugin-defined rule for when its source is collected. Manual-only is a valid policy.

For bundled plugins, the user chooses manual-only, disabled, or a supported fixed interval in that plugin's workspace settings. The plugin persists the setting in its SQLite store and schedules its own collection; the host only displays resulting status.

All newly installed plugins begin in manual-only mode. A plugin performs automatic background collection only after the user explicitly selects an interval in that plugin's settings.

**Plugin Store** is the local persistent store owned by one plugin. It retains that plugin's records and evolves without a host-defined business schema.

## Reliability Principles

- Plugin-owned cached content is the primary read path; collection is asynchronous work.
- An ordinary plugin activation, route, task, or cleanup failure is isolated and must not block host navigation or other plugins. A Runtime-level crash may briefly interrupt plugin APIs before recovery.
- A plugin keeps its newest successful content until it replaces it successfully.
- The host exposes concise lifecycle and last-refresh status, while a plugin chooses its own detailed refresh UI.
- OpenCLI may report an uncertain browser-command outcome. The plugin records it as uncertain or failed and does not silently replay the collection.

## Security Position

The MVP is a single-user local application that trusts installed plugins by default. It has no plugin permission-review, approval, or hostile-code sandboxing layer. The host still contains ordinary failures by keeping plugin lifecycle, workspace loading, logs, and diagnostics separate from its own navigation UI.

## Explicit Non-Architecture

The MVP is not a hosted multi-tenant service, a distributed crawler system, a plugin marketplace, a generic OpenCLI command launcher, a centrally normalized source-data store, or a host-owned cross-plugin content feed.
