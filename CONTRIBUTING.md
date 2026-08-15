# Contributing to Infolens

[English](CONTRIBUTING.md) | [简体中文](CONTRIBUTING.zh-CN.md)

Infolens is under active development. Plugin contracts, APIs, and user-facing
interfaces can change between revisions. Keep changes focused on the boundary
that owns the behavior and document deliberate contract changes.

## First Run

Use Node.js 22 or newer and npm 10 or newer. Windows is the maintained release
target; Electron development can run on other platforms, but cross-platform
packaging is outside the current workflow.

```powershell
git clone <repository-url>
cd infolens
npm install
npm run verify:release
npm run typecheck
npm run dev
```

Use the GitHub repository's Code button for the clone URL. The first install
needs network access because `postinstall` installs the pinned Bundled OpenCLI
distribution under `resources/opencli` and applies the repository overrides.

## Find the Right Boundary

| Change | Start here |
| --- | --- |
| Electron lifecycle, navigation, settings, or host IPC | `apps/desktop/` |
| Plugin discovery, lifecycle, scheduling, diagnostics, or Plugin API | `packages/plugin-runtime/` |
| Plugin author CLI or typed Plugin SDK contract | `packages/plugin-sdk/` |
| Source-specific collection, storage, or Plugin Workspace | `plugins/<plugin-id>/` |
| Shared presentation-only Workspace controls | `packages/plugin-workspace/` |

Read `CONTEXT.md` before changing domain terminology. Read the relevant ADR in
`docs/adr/` before changing an established architectural boundary. The
architecture overview is in `ARCHITECTURE.md`.

## Validation

Run the smallest useful set for the affected boundary:

```powershell
# TypeScript contracts and release metadata
npm run typecheck
npm run verify:release

# One focused Node test file
node --test tests/plugin-runtime-contract.test.mjs

# Renderer build when desktop or Workspace assets change
npm run build
```

The full test command builds a local release package before running all Node
test files:

```powershell
npm test
```

When a test uses live Browser Bridge or external source sessions, state that
requirement explicitly in the change description. Deterministic fixtures do
not prove that a live `COOKIE` or `INTERCEPT` collection still works; use
`npm run verify:real-source` only with the required developer-machine setup.

## Plugin Author Path

For a new Plugin, start with the [Plugin Development Guide](docs/plugin-development.md)
([中文](docs/plugin-development.zh-CN.md)):

```powershell
npm run plugin -- init path\to\my-plugin --check --format text
npm run plugin -- doctor path\to\my-plugin --format text
npm run plugin -- preview path\to\my-plugin --format text
npm run plugin -- pack path\to\my-plugin --out ..\my-plugin.infolens-plugin
```

`validate` is the fast package-contract check. `doctor` exercises the real
Backend lifecycle in temporary state. `pack` stages the exact package contents
and runs the package gate before writing an artifact. Trusted Plugin Backend
code is ordinary Node.js code; these commands are lifecycle and state checks,
not a security sandbox.

## Generated and Local-Only Files

Commit the static Workspace Bundle under `plugins/*/web/dist/` when its source
changes. Keep these local-only paths out of commits:

- `node_modules/`
- `.infolens-data/`, `.infolens-dev/`, `.infolens-live/`, and
  `.infolens-acceptance/`
- `release/`
- Chrome profiles, cookies, exported logs, and diagnostic material containing
  credentials

Run `git status --short` before opening a pull request and inspect every added
file. The repository is local-first, and browser login state must remain in
Chrome rather than in fixtures or documentation.

## Pull Requests

Describe the behavior changed, the owning boundary, and any contract or data
implications. Include the exact validation commands you ran and identify any
live-source checks you could not run. Update user or developer documentation
when commands, package contracts, or setup requirements change.

Do not mix unrelated refactors into a feature or bug fix. If an architectural
decision changes, update or add the relevant ADR and call out the decision in
the pull request. Do not include secrets, generated local state, or an
unreviewed Plugin package artifact.

See [AGENTS.md](AGENTS.md) for repository-local agent conventions.
