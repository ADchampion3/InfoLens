# Infolens PRD

## Product Summary

Infolens is a local-first information-plugin host. It gives users one simple navigation shell for independently designed information plugins, each with its own collection, persistence, and reading experience.

The first release is an Electron desktop application with a React, Vite, and TypeScript host renderer. OpenCLI is the sole collection and browser-execution runtime.

## Problem

People follow information that lives in different places, with different login states and interaction patterns. Checking each source separately is repetitive, while a one-off cross-site search does not build a useful daily habit or preserve a personal reading history.

## Target User

An individual who routinely follows technology and Chinese internet trends, already uses a local desktop environment, and values a focused reading surface over a configurable automation system.

## Product Goals

- Give users a fast, predictable way to discover and open their information plugins.
- Let every plugin provide the reading and interaction experience that best fits its source.
- Reuse OpenCLI adapters, Chrome login state, Browser Bridge, and collection behavior instead of reimplementing crawling.
- Let every plugin retain and evolve its own collected data instead of forcing any shared business schema.
- Keep the first-run path simple: install or enable a plugin, then open it.
- Make plugin freshness and failures visible without dictating a plugin's content layout.
- Give plugin authors one small, stable package contract rather than a host-specific integration for every source.
- Keep the Host, plugin SDK, and bundled plugins in one workspace repository so the first plugins can evolve with the product contract.

## Non-Goals

- A general web search engine or an LLM research agent.
- Support for every OpenCLI command or site in the first release.
- Cloud accounts, multi-device synchronization, or a hosted crawler fleet.
- A strict plugin review, permission approval, or hostile-code sandboxing system.
- Authoring, repairing, or managing OpenCLI adapters from the product UI.
- A mandatory cross-plugin content feed, summary-card format, or shared item schema.

## MVP Scope

### Plugins

The first release ships with at least three curated, trusted, user-visible source plugins. They are official daily-use information experiences, not hidden strategy-verification fixtures. Together, the plugins must provide one normally working representative for each OpenCLI website collection strategy in MVP scope:

1. `PUBLIC` -- direct fetch without credentials
2. `COOKIE` -- collection through an existing Chrome login session
3. `INTERCEPT` -- collection by capturing a page-initiated request

OpenCLI's `UI` strategy is outside the current plugin package contract. It is neither bundled nor accepted for local installation in the MVP; supporting it later requires a contract revision.

The MVP official plugins and their OpenCLI mappings are:

1. Hacker News Top Stories -- `PUBLIC`
2. GitHub Trending -- `PUBLIC`
3. Zhihu Hot List -- `COOKIE`
4. Product Hunt Today's Top Launches -- `INTERCEPT`

Each plugin owns the OpenCLI command mapping, refresh policy, persistent records, and complete content workspace for its source.

The bundled plugins are designed specifically for Infolens rather than migrated from TractIt. Existing project patterns and tooling may inform implementation, but existing plugin UI, backend, and data behavior are not compatibility targets.

Each bundled plugin uses an independent SQLite database with its own schema and migrations. These database decisions are never shared across plugins or managed by the host.

### Core Experience

- A persistent left navigation listing available plugins with name, icon, running state, last refresh status, and an optional plugin-provided badge.
- A complete plugin-owned workspace in the right main-content area after a plugin is selected.
- Plugin management and application settings entries at the bottom of navigation, with no host content dashboard.
- Host theme controls for system, light, and dark preference; bundled plugins follow the selected theme.
- Discovery of local plugin packages only from the fixed `plugins/` directory through a small manifest, backend entry, and built Web workspace. The MVP does not distinguish official and user-installed package locations. Discovery applies the same compatibility checks as installation; rejected packages are shown only in plugin management with their rejection reason.
- Installation of a prebuilt plugin package from a user-selected local folder without a review flow; ordinary installation copies the package into the fixed plugin directory.
- MVP development uses the repository's fixed plugin directories after a local build; it does not support external development links, symbolic links, or plugin hot reload.
- Compatibility validation during installation and discovery using a plugin contract version, minimum host version, compatible OpenCLI version range, and declared command availability, with a clear rejection reason for incompatible packages.
- A simple plugin-management view for installed plugins, including explicit removal before replacing a plugin with the same ID. A successfully installed compatible plugin is enabled immediately; a valid discovered plugin with no prior host state is enabled by default.
- Plugin-manager diagnostics showing current state, last successful refresh, and the most recent failure summary, with a copyable per-plugin diagnostic report.
- A static built Web workspace for every plugin; Plugin Runtime serves its assets and API from the same loopback origin. The bundled plugins use React and Vite.
- A first-run check for the Chrome Browser Bridge extension; users do not need to install OpenCLI globally.
- Startup of one shared Plugin Runtime that activates all enabled plugin backend modules so plugin-defined background refresh can run during the application session.
- Plugin-owned refresh settings with manual-only, disabled, and fixed-interval options for bundled plugins.
- Newly installed plugins default to manual-only refresh until the user changes their plugin-local settings.
- Closing the main window exits the application and stops the shared Plugin Runtime; MVP does not keep an implicit tray-resident refresher.
- Plugin-defined navigation, detail views, read state, and source-specific interactions.
- Host-level indication when a plugin is unavailable or its latest refresh failed.
- Per-plugin Browser Bridge and login guidance; a browser-dependent plugin never blocks unrelated plugins.

### Collection Behavior

- All collection runs use OpenCLI mechanisms. Neither the host nor plugins reimplement crawling, browser automation, or cookie management.
- A plugin backend module invokes OpenCLI through the shared Plugin Runtime's local CLI process boundary with machine-readable JSON output.
- A plugin workspace directly calls its own same-origin API path in the shared Plugin Runtime; the Electron host does not proxy plugin business requests.
- The shared runtime runs at most one collection task for each plugin at a time and coalesces duplicate refresh requests. It permits bounded cross-plugin work, with `PUBLIC` collection allowed in parallel and browser-backed `COOKIE` and `INTERCEPT` collection serialized initially. The current plugin contract rejects `UI` strategy packages.
- Each plugin persists and updates its own records, using its own source model and refresh policy.
- Refresh settings are stored in the plugin, while the shared Plugin Runtime executes the plugin-registered schedule through its queue and resource limits; the host only receives resulting lifecycle status.
- A plugin's failed collection must not remove its latest successful content or make other plugins unavailable.
- A release is acceptable only when the MVP `PUBLIC`, `COOKIE`, and `INTERCEPT` strategies are exercised by their representative plugins against their real OpenCLI commands and source environments. Each verification run must collect a result, persist it in that plugin's SQLite store, and display it in the plugin workspace. Fakes may support isolated tests but cannot substitute for this release verification.
- Real strategy verification runs on a release-candidate developer machine with Browser Bridge connected and the required browser session available. CI runs only credential-free unit and contract tests; it must not store website credentials, Chrome profiles, or Browser Bridge sessions.

## Success Criteria

- A new user can open any built-in MVP plugin without configuring OpenCLI internals in the host UI.
- A user can run the application without a global `opencli` command or standalone Node setup.
- A user can install a valid prebuilt plugin from a local folder and find it through normal navigation.
- A user attempting to install a duplicate plugin is told to remove the installed plugin first.
- Opening a plugin presents its retained content without waiting for a new collection run.
- Reopening the application returns the user to the last available plugin workspace.
- Each of the MVP `PUBLIC`, `COOKIE`, and `INTERCEPT` representative plugins can complete a real collection, retain the result, and render it in its own user-visible workspace.
- A missing Browser Bridge connection leaves browser-independent plugins available and presents setup guidance only in affected plugins.
- A failed refresh in one official plugin does not make the other official plugins unavailable.
- A user can inspect an unavailable plugin's latest failure summary and copy its local diagnostic report from plugin management.
- The host remains usable when an individual plugin crashes or cannot start.
