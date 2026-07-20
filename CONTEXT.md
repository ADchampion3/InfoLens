# Infolens

Infolens is a local-first information-plugin host. It provides navigation between independently designed source plugins.

## Language

**Plugin**:
A trusted local package that owns collection, persistence, and a complete source-oriented workspace.
_Avoid_: Source, adapter

**Bundled Plugin**:
A source plugin designed and shipped specifically for Infolens.
_Avoid_: Migrated TractIt plugin, compatibility layer

**Strategy Representative Plugin**:
A user-visible bundled plugin that proves one real OpenCLI website collection strategy end to end: collection, persistence, and workspace rendering.
_Avoid_: Hidden test fixture, generic command launcher

**OpenCLI Website Strategy**:
One of OpenCLI's four browser and website collection mechanisms: `PUBLIC`, `COOKIE`, `INTERCEPT`, or `UI`.
_Avoid_: Plugin category, host permission level

**Supported Plugin Strategy**:
An OpenCLI strategy accepted by the current Infolens plugin package contract: `PUBLIC`, `COOKIE`, or `INTERCEPT`. `UI` is an OpenCLI strategy but is not accepted by the MVP package contract.
_Avoid_: Permanent OpenCLI limitation

**Source**:
A provider of external information that a plugin collects from.
_Avoid_: Plugin, website

The MVP sources are Hacker News, GitHub Trending, Zhihu Hot List, and Product Hunt Today's Top Launches.

**OpenCLI Strategy Mapping**:
The source-specific OpenCLI strategy declared by a plugin's collection command. In the MVP, Hacker News and GitHub Trending use `PUBLIC`, Zhihu Hot List uses `COOKIE`, and Product Hunt Today's Top Launches uses `INTERCEPT`.
_Avoid_: Host routing rule, plugin permission level

**Real Strategy Verification**:
The release-candidate developer-machine check that runs each official MVP plugin against its real OpenCLI command and source environment, then confirms collection, persistence, and workspace rendering.
_Avoid_: CI fixture test, mocked command result

**Plugin Workspace**:
The complete main-content interface owned and rendered by one plugin.
_Avoid_: Host page, shared detail view

**Workspace Bundle**:
The built static Web assets a plugin provides at `web/dist` for its workspace.
_Avoid_: Host UI source, required frontend framework

**Workspace Frame**:
The iframe in the host shell that contains the selected plugin workspace.
_Avoid_: Shared content panel, host-rendered plugin UI

**Workspace Runtime Configuration**:
The `pluginId` and `apiBaseUrl` values the host supplies in a workspace iframe URL.
_Avoid_: Business RPC, host data API

**Plugin API**:
The HTTP routes a plugin backend module registers below its own `/plugins/<pluginId>/api/` prefix in the shared Plugin Runtime, exclusively for that plugin workspace.
_Avoid_: Host RPC, cross-plugin business API

**Plugin Runtime**:
The one Node child process managed by the Electron host that loads enabled plugin backend modules, dispatches plugin-scoped routes, schedules tasks, and invokes OpenCLI.
_Avoid_: Electron main process, one process per plugin

**Plugin Backend Module**:
The backend entry loaded by Plugin Runtime for one plugin. It registers its own routes and task handlers and owns source-specific persistence.
_Avoid_: Independent backend process, host business logic

**Plugin Activation Context**:
The single interface Plugin Runtime passes to a backend module's `activate(context)` function. It provides plugin-scoped routes, tasks, scheduling, declared OpenCLI command execution, data-directory access, and logging.
_Avoid_: Direct process control, independent HTTP server, arbitrary OpenCLI command runner

**Plugin Health**:
The backend-module readiness signal returned from `GET /plugins/<pluginId>/health` in Plugin Runtime.
_Avoid_: Authenticated handshake, host RPC

**Plugin Task**:
An in-memory scheduled request containing plugin ID, task name, input, and trigger reason. Its handler remains inside the plugin backend module and validates its own input directly in code.
_Avoid_: Serialized crawler code, separate task-transfer protocol

**Enabled Plugin**:
A compatible discovered plugin that the host starts for the current application session. A compatible plugin with no prior host state is enabled by default; installation enables it immediately.
_Avoid_: Selected plugin, visible workspace

**Plugin Directory**:
The fixed `plugins/` location that the host scans for discovered plugin packages.
_Avoid_: Marketplace, remote registry

**Plugin Manager**:
The host surface for listing installed plugins and explicitly removing one before a replacement installation.
_Avoid_: Automatic upgrader, marketplace

**Plugin Removal**:
An explicit plugin-manager action that stops a plugin and deletes both its package and plugin-owned data.
_Avoid_: Upgrade, retained uninstall data

**Development Link**:
A future development-only reference from the plugin directory to a plugin's original source folder. It is not supported in the MVP.
_Avoid_: Ordinary installation, copied package, MVP plugin workflow

**Plugin Manifest**:
The small package descriptor used by the host to discover, identify, and start a plugin.
_Avoid_: Permission policy, source schema

**OpenCLI Command Mapping**:
A manifest entry keyed by command key, declaring a source `site`, immutable CLI `command` path, supported `strategy`, `access: read`, JSON output format, and `openCliVersionRange`. Plugin Runtime validates mapping compatibility and command availability before it launches OpenCLI; the loaded plugin handler validates task arguments directly in code.
_Avoid_: Arbitrary shell command, serialized argument schema

**Plugin Contract Version**:
The manifest version identifying the supported Infolens plugin-package contract. A package with an unsupported value cannot be installed.
_Avoid_: Plugin release version, host version

**Minimum Host Version**:
The semantic-version minimum host release declared by a plugin manifest. A package cannot be installed when the current Infolens version is older.
_Avoid_: Automatic updater, permission requirement

**Plugin SDK**:
The thin shared package that implements Infolens runtime conventions without defining plugin business behavior or UI.
_Avoid_: Content framework, shared source model

**Host Shell**:
The Electron-owned React navigation and lifecycle surface surrounding a plugin workspace.
_Avoid_: Shared content workspace, plugin UI

**Host State**:
The lightweight JSON-persisted host settings and lifecycle information, separate from plugin business data.
_Avoid_: Plugin registry database, source store

**Plugin Status Snapshot**:
The host-owned summary for one plugin: current lifecycle state, last successful refresh time, and the latest failure time, code, and short message.
_Avoid_: Full plugin log, collected source data

**Plugin Diagnostic Report**:
A copyable local troubleshooting report for one selected plugin, composed from its status snapshot and recent rotating-log entries. It contains no source records or authentication material.
_Avoid_: Telemetry payload, central audit log

**Theme Preference**:
The host's persisted system, light, or dark appearance selection.
_Avoid_: Plugin business setting, shared component library

**Theme Update**:
An appearance-only message sent by the host to an open plugin workspace when the theme changes.
_Avoid_: Business RPC, workspace reload

**Plugin Navigation**:
The persistent left-side host list used to select a plugin workspace and show concise plugin state.
_Avoid_: Content dashboard, cross-plugin feed

**Navigation Badge**:
An optional short value a plugin supplies for display beside its navigation entry.
_Avoid_: Global unread count, host-owned content state

**Bundled OpenCLI Runtime**:
The pinned OpenCLI distribution shipped and invoked by Infolens instead of a user-global CLI installation.
_Avoid_: Global prerequisite, PATH dependency

**Browser-Dependent Plugin**:
A plugin whose OpenCLI collection needs a connected Browser Bridge or browser login state.
_Avoid_: Application-wide dependency, host setup failure

**Refresh Policy**:
A plugin-defined rule for when it collects updates. Manual-only is a valid refresh policy.
_Avoid_: Forced schedule

**Plugin Refresh Settings**:
The user-facing settings inside one plugin that select its refresh policy and interval.
_Avoid_: Host-wide refresh policy, global refresh preference

**Manual-Only Default**:
The initial refresh policy for a newly installed plugin, requiring an explicit user refresh or later settings change.
_Avoid_: Automatic first-run collection

**Application Session**:
The period from starting Infolens until the main window closes and the shared Plugin Runtime stops.
_Avoid_: Tray-resident background service, persistent daemon

**Collection Snapshot**:
The recorded result of one plugin attempt to collect updates, whether successful, failed, or uncertain.
_Avoid_: Cache, job

**Plugin Store**:
The local persistent store owned by one plugin for its source-specific records.
_Avoid_: Central item database, shared source schema

**Plugin Migration**:
A plugin-owned change that evolves that plugin's SQLite schema while preserving its own data when applicable.
_Avoid_: Host migration, cross-plugin data upgrade
