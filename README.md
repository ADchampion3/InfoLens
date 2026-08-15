# Infolens

[English](README.md) | [简体中文](README.zh-CN.md)

Infolens is a local-first Electron host for source-oriented information
plugins. It provides one desktop shell for following several sources while
letting each plugin own its collection strategy, local data, refresh policy,
and reading workspace.

The project is in active development. APIs, package contracts, and user
interfaces may change between revisions.

## Start Here

- To run the application locally, follow [Quick Start](#quick-start).
- To contribute to the Host Shell, Plugin Runtime, or bundled Plugins, read
  [CONTRIBUTING.md](CONTRIBUTING.md).
- To create a Plugin, read the [Plugin Development Guide](docs/plugin-development.md)
  ([中文](docs/plugin-development.zh-CN.md)).
- To understand the system boundaries, start with [ARCHITECTURE.md](ARCHITECTURE.md)
  ([中文](ARCHITECTURE.zh-CN.md)).

Current deployment work and open product decisions are tracked in the
[project roadmap](ROADMAP.md).

## What It Includes

The repository ships four bundled plugins:

| Plugin | Collection strategy | Browser Bridge |
| --- | --- | --- |
| Hacker News | `PUBLIC` | Not required |
| GitHub Trending | `PUBLIC` | Not required |
| Zhihu Hot List | `COOKIE` | Required, with a logged-in Chrome profile |
| Product Hunt | `INTERCEPT` | Required for live collection |

Each plugin has its own backend, SQLite store, refresh behavior, and static
workspace. The Host Shell does not flatten their records into a shared feed.

The application bundles OpenCLI 1.8.6 and invokes the local runtime. A global
OpenCLI installation is not required. Browser-backed plugins use the OpenCLI
Browser Bridge extension and the user's existing Chrome session.

## Requirements

- Node.js 22 or newer is recommended.
- npm 10 or newer.
- Windows is the currently maintained packaged-release target. Electron
  development can be run on other platforms, but cross-platform packaging is
  not part of the current release workflow.
- Chrome and the OpenCLI Browser Bridge extension for `COOKIE` and
  `INTERCEPT` collection.

## Quick Start

```powershell
git clone <repository-url>
cd infolens
npm install
npm run dev
```

`npm install` also installs the pinned OpenCLI distribution under
`resources/opencli` and applies the repository's version-checked overrides.
The install therefore needs network access the first time it runs.

To build and launch the local production renderer:

```powershell
npm run build
npm start
```

The development command starts the Vite renderer, Electron host, and shared
Plugin Runtime together. Development state is written under the ignored
`.infolens-data` directory.

## Repository Layout

| Path | Responsibility |
| --- | --- |
| `apps/desktop/` | Electron Main Process and Host Shell |
| `packages/plugin-runtime/` | Shared Plugin Runtime and Plugin API boundary |
| `packages/plugin-sdk/` | Plugin SDK and Plugin author CLI |
| `packages/plugin-workspace/` | Shared presentation-only Plugin Workspace UI |
| `plugins/` | Bundled Plugin packages and their Workspace Bundles |
| `resources/opencli/` | Pinned Bundled OpenCLI Runtime distribution |
| `scripts/` | Development, release, and verification commands |
| `tests/` | Node test-runner suites and fixtures |

## Common Commands

| Command | Purpose |
| --- | --- |
| `npm run dev` | Start the Electron development session |
| `npm run build` | Verify release metadata and build the renderer |
| `npm run typecheck` | Type-check the desktop host and Plugin SDK |
| `npm test` | Build the local package and run the repository test suite |
| `npm run verify:release` | Check package and bundled OpenCLI version consistency |
| `npm run package:release` | Build and assemble a release package locally |
| `npm run verify:real-source` | Run Real Strategy Verification for configured live sources |
| `npm run plugin -- init <path> --check --format text` | Scaffold and check a Plugin package |
| `npm run plugin -- help` | Show Plugin author commands and options |
| `npm run plugin -- validate <path>` | Validate a plugin package |
| `npm run plugin -- doctor <path>` | Run isolated plugin lifecycle and workspace checks |
| `npm run plugin -- adapters list <path>` | Inspect bundled and provided OpenCLI adapters |
| `npm run plugin -- pack <path> --out <directory>` | Create a validated plugin package |

For a focused test run, use Node's test runner directly:

```powershell
node --test tests/browser-bridge.test.mjs tests/opencli-adapter.test.mjs
```

The repository's automated checks do not replace live-source verification for
browser-backed plugins. A release-candidate check with Browser Bridge and the
required site sessions is still needed for `COOKIE` and `INTERCEPT` sources.

`npm run verify:real-source` is intentionally a developer-machine check. It
needs the external source sessions and Browser Bridge setup described by the
selected Plugin; it is not a replacement for the deterministic test suites.

## Browser Bridge

The Host Shell does not probe the Browser Bridge during startup. Open Settings
to read the cached status, then use `Check connection` or `Reconnect` when a
browser-backed workflow needs recovery.

Browser-dependent collection is isolated to the plugin that needs it. A
missing bridge or site login does not make public-source plugins unavailable,
and retained plugin content remains readable after a failed refresh.

Automation uses background windows and ephemeral site sessions. The Runtime
releases its own temporary session leases after successful and failed commands;
it does not close user-owned Chrome tabs when the application exits.

## Architecture

```text
Electron Main Process
  Host Shell (React, Vite, TypeScript)
    Plugin navigation and host settings
    Plugin workspace frames
          |
          v
  Shared Plugin Runtime (Node)
    Plugin backends and task scheduling
    Plugin-scoped HTTP APIs and static workspaces
    Plugin-owned SQLite stores
    Bundled OpenCLI process boundary
          |
          v
  OpenCLI 1.8.6
    Public adapters and browser-backed adapters
    Browser Bridge daemon and Chrome session
```

The main architecture references are:

- [Architecture baseline](ARCHITECTURE.md) ([中文](ARCHITECTURE.zh-CN.md))
- [Plugin development guide](docs/plugin-development.md)
- [Architecture decisions](docs/adr/)
- [Browser Bridge session contract](docs/adr/0058-browser-bridge-session-ux.md)

## Files To Commit

The Plugin Workspace Bundles under `plugins/*/web/dist/` are shipped assets and
are intentionally tracked. Regenerate them when a bundled Plugin Workspace
changes. Do not commit `node_modules`, `.infolens-data`, `.infolens-dev`,
`.infolens-live`, `.infolens-acceptance`, `release`, Chrome profiles, cookies,
or exported logs.

## Plugin Development

Plugins are trusted local packages. A plugin backend is ordinary Node.js code
loaded by the shared Plugin Runtime; the current package model is not a
security sandbox or a permission system.

The package contract requires a manifest, a backend entry, and a built static
workspace. Every OpenCLI command must be declared in the manifest. Provided
adapters are copied and verified during packaging; package scripts, network
installation, and arbitrary dependency installation are not part of the
adapter workflow.

Start with the [plugin development guide](docs/plugin-development.md), then
create and check a package from the repository root:

```powershell
npm run plugin -- init path\to\my-plugin --check --format text
npm run plugin -- doctor path\to\my-plugin --format text
npm run plugin -- pack path\to\my-plugin --out ..\my-plugin.infolens-plugin
```

The scaffold is framework-neutral and does not add SDK dependencies. Its
generated `validate`, `doctor`, `dev`, `preview`, and `pack` scripts call
`infolens-plugin`; use them when the author CLI is available on `PATH`. The
external package distribution workflow remains separate.

## Data and Privacy

Infolens is local-first. Host state, plugin records, and logs are stored on
the local machine. Each plugin owns its own data directory and persistence
schema. The application does not provide cloud synchronization or a hosted
crawler service.

Browser login state remains in Chrome and is accessed through Browser Bridge.
Do not commit Chrome profiles, cookies, exported logs, generated release
directories, or `.infolens-data` to the repository.

## Contributing

Read [CONTRIBUTING.md](CONTRIBUTING.md) for the first-run setup, boundary map,
validation commands, Plugin author path, and pull request checklist. Keep
source-specific behavior in the owning Plugin, preserve the Plugin Runtime
process boundary, and update the relevant ADR when an architectural decision
changes. `AGENTS.md` contains repository-local agent conventions.

## License

This repository does not yet contain a license file. A license should be
selected and added before external redistribution or accepting third-party
contributions.
