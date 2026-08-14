# Plugin Development Environment and Developer Experience Research

Date: 2026-08-14

## Scope and method

This note evaluates the current Infolens Plugin author workflow and identifies
improvements that fit the current trusted-package model. The repository source
and its ADRs are treated as primary sources. The conclusions are intentionally
limited by the repository convention that UI testing is out of scope for this
work.

## Executive summary

The repository already has a strong package-quality foundation:

- Contract, Host, OpenCLI, manifest, command, and Provided Adapter checks are
  exposed through one author CLI.
- `doctor` imports the real Plugin Backend Module in temporary state roots and
  checks lifecycle cleanup and the static Workspace Bundle graph.
- `pack` validates the exact staged contents and publishes only after the staged
  `doctor` succeeds.
- The CLI returns stable machine-readable fields and the author workflow is
  covered for all four bundled Plugins and an independent package boundary.

The largest developer-experience gap is the first ten minutes and the edit to
feedback loop, not package correctness. A new author must construct the
package shape manually, discover commands from a long guide, and run a command
named `dev` that only prepares an Adapter Scope. It does not run the Plugin
Runtime, serve a Workspace, watch files, or provide hot reload. Independent
projects are documented as supported, but the package boundaries they need are
currently private workspace packages, so setup is not yet a normal installable
workflow.

Recommended order:

1. Add an explicit help surface and a minimal `init` scaffold. Keep operational
   command output JSON-compatible.
2. Add a short-path author workflow and a human-readable summary mode without
   changing the stable JSON envelope.
3. Design a separate `preview` or `dev --runtime` harness for the local edit
   loop. Do not silently redefine the current `dev` command until the relevant
   ADR is superseded.
4. Publish or otherwise distribute the SDK/author-tool package boundary as a
   supported external-project dependency.

## Current environment

### What works well

The author contract is explicit. The guide defines the package shape, manifest
requirements, Backend activation contract, static Workspace Bundle, OpenCLI
mapping, and the `validate`/`doctor`/`pack` relationship [1]. The result
envelope includes `ok`, `command`, `environment`, `checks`, and structured
error identity, which is appropriate for CI and editor integrations [1].

`validate` is intentionally fast and side-effect-light. `doctor` is the
lifecycle superset: it activates the real Backend, records routes/tasks/
schedules, checks Plugin Health, runs cleanup, and diagnoses the staged
Workspace graph [1]. The implementation uses temporary roots and explicitly
avoids running tasks, arming schedules, invoking OpenCLI during activation, or
executing Workspace JavaScript [2]. This gives authors a deterministic
credential-free diagnostic boundary.

`pack` is a meaningful release gate rather than a file copy. It excludes
development-only content, validates the staged directory, writes adapter
integrity metadata, and atomically publishes only after error-level checks pass
[1][2]. The tests exercise the official Plugin matrix, independent package
boundaries, lifecycle failures, Workspace graph findings, and staged dependency
failures [3].

### Friction observed from the source and command runs

1. **No discoverable entry point.** The CLI has no help command or help option.
   Unknown commands return a JSON error containing one usage string, but an
   author cannot ask the tool what commands, flags, or output contracts exist
   [2]. The guide is the only discovery surface.

2. **No package scaffold.** Authors must hand-create `manifest.json`,
   `package.json`, `backend`, `web`, and optional adapter directories. The
   smallest valid package has enough coupled fields that a typo is more likely
   to be found by validation than prevented at creation time [1].

3. **`dev` is preparation, not a development loop.** The documented command
   creates a linked development Adapter Scope, but does not start Plugin
   Runtime, serve the Workspace, watch files, or provide hot reload [1]. Its
   name therefore implies more than its behavior. This is a usability problem,
   not a runtime correctness defect.

4. **The normal feedback loop is longer than necessary.** The guide presents
   separate `validate`, `doctor`, `adapters list`, `dev`, and `pack` commands,
   even though `doctor` already includes the contract and Workspace checks and
   `pack` runs a staged `doctor` [1]. Authors need a clear fast path and a
   reason to run each extra command.

5. **Human diagnosis is hidden inside large JSON.** Every author command emits
   pretty-printed JSON, which is excellent for automation but expensive for a
   person iterating locally. The implementation has stable check IDs and error
   phases, so a summary view can be added without weakening the automation
   contract [2].

6. **External-project setup is not yet self-contained.** The docs describe
   independent package boundaries, while the SDK, Plugin Runtime, release
   metadata, Plugin Workspace, and bundled OpenCLI packages in this repository
   are marked `private` [1][4]. The independent-project test therefore copies
   package boundaries into a temporary `node_modules` tree rather than using a
   normal registry install [3]. This is a release/distribution gap.

7. **Workspace feedback is deliberately incomplete.** `doctor` proves that
   the staged static asset graph is present, but it does not execute the
   Workspace or prove browser rendering [1]. That boundary is honest and
   deterministic, but authors need a separately named preview/live-check path
   when they work on browser behavior. The repository's no-UI-testing rule
   means this should not be added to the current verification run.

## Design constraints and ADR conflicts

The following constraints should remain explicit when improving DX:

- The Workspace is a built static bundle, and the Host does not compile
  TypeScript, start a frontend server, install dependencies, or run lifecycle
  scripts during installation [1][5]. A development server belongs to an
  author-only harness, not the installation contract.
- The current MVP deliberately rejects a Development Link. ADR 0040 says the
  development-link workflow is future work and is not the ordinary installation
  path [6]. A live-link implementation therefore needs a new or superseding
  ADR; it should not be smuggled into `pack` or normal installation.
- ADR 0055 defines the author CLI as a reliable JSON-producing contract and
  explicitly separates lifecycle diagnosis from a security sandbox [7]. Human
  output must be an additional presentation mode, not a replacement for the
  stable result object.
- The Plugin SDK is intentionally thin. A scaffold may provide examples and
  scripts, but it should not turn source schemas, persistence, or UI components
  into a mandatory SDK abstraction [8].

## Recommended improvements

### P0: reduce onboarding friction without changing runtime architecture

**Add `help` and `--help`.** Show commands, positional arguments, supported
options, default paths, the JSON contract, and the distinction between
`validate`, `doctor`, `dev`, `adapters list`, and `pack`. `help` can be human
text; existing operational commands should keep their current JSON default.

**Add `init <directory>`.** Generate one minimal, valid Plugin with:

- a manifest using the resolved Contract and Minimum Host versions;
- an ESM Backend that reports ready health and exposes a small health/summary
  route;
- a static Workspace entry and local asset;
- a package script set for `validate`, `doctor`, `dev`, and `pack`;
- no OpenCLI command or adapter until the author opts into one.

The command should refuse to overwrite a non-empty directory, accept an
explicit plugin ID, and print the next two commands. This gives authors a
known-good starting point while preserving the trusted-package boundary.

**Document one fast path.** The first iteration should be:

```powershell
infolens-plugin init .\my-plugin
cd .\my-plugin
npm run doctor
npm run pack
```

`adapters list` remains a targeted troubleshooting command, not a mandatory
step for every package.

### P1: improve local feedback while preserving the static package contract

**Add a human summary mode.** Use `--format text` or `--summary` to render the
   plugin identity, environment versions, failed checks, warnings, and next
   action. Keep JSON as the default and keep stable IDs/codes in both modes.
   A summary should point to the full JSON report when a CI/editor integration
   needs details.

**Separate preparation from preview.** Keep current `dev` semantics stable
   until an ADR is updated. Introduce a name such as `preview` for an author
   harness that can:

- build or serve a Workspace in an author-controlled process;
- start an isolated Plugin Runtime with temporary data;
- expose the same `pluginId`, API base URL, and Runtime mounts as the Host;
- restart the Backend when its source changes;
- stop all child processes on exit.

The preview harness must not be used by installation or `pack`, and it should
make clear when it cannot exercise a real Browser Bridge or credentialed Source.

### P1: make independent projects genuinely installable

Choose one supported distribution model and test it from a clean directory:

- publish `@infolens/plugin-sdk` with the author CLI and its runtime-compatible
  package dependencies; or
- provide a versioned local tarball bundle and a documented install command
  for development; or
- explicitly scope Contract Version 2 to the monorepo until publication is
  ready, instead of presenting the temporary package-boundary copy as a normal
  external setup.

The release must pin the Host/Contract/OpenCLI matrix that the CLI reports.
The external-project acceptance test should use the selected distribution
mechanism rather than copying private workspace directories.

### P2: make failures measurable and maintainable

Add a small author-DX acceptance suite that measures:

- time and commands from scaffold to first passing `doctor`;
- whether every validation error has a stable check ID, code, phase, and a
  remediation hint;
- whether `pack` and `doctor` report the same staged failure;
- whether a failed preview shuts down all children and removes temporary state.

Do not make the static `doctor` test claim browser-rendering coverage. Keep
credentialed Browser Bridge checks as a separately named live-source workflow.

## Proposed delivery sequence

| Slice | Deliverable | Scope | Estimate |
| --- | --- | --- | --- |
| 1 | `help`, `--help`, `init`, quick-start docs, CLI tests | CLI and docs only | 0.5-1 day |
| 2 | Summary output and generated package scripts | CLI presentation | 0.5 day |
| 3 | Preview harness design and ADR | Runtime/dev boundary | 1 day for design, 2-4 days for a usable harness |
| 4 | Clean external package distribution and acceptance test | Release tooling | 1-2 days after the distribution choice |

The first slice is the recommended next action. It improves onboarding without
changing the Plugin Runtime, installation, or Contract Version 2 behavior.

## Sources

1. [Plugin development guide](plugin-development.md), especially package
   contract, author workflow, and current `dev` semantics.
2. [Author CLI implementation](../packages/plugin-sdk/bin/infolens-plugin.mjs),
   especially option parsing and command dispatch.
3. [Author command and package-boundary tests](../tests/plugin-author-commands.test.mjs).
4. [Plugin SDK package metadata](../packages/plugin-sdk/package.json), [Plugin
   Runtime metadata](../packages/plugin-runtime/package.json), [release
   metadata](../packages/release-metadata/package.json), and [bundled OpenCLI
   metadata](../resources/opencli/package.json).
5. [ADR 0018: Static Plugin Workspace Bundles](adr/0018-static-plugin-workspace-bundles.md).
6. [ADR 0040: No Development Links in MVP](adr/0040-no-development-links-in-mvp.md).
7. [ADR 0055: Plugin Author Diagnostic Commands](adr/0055-plugin-author-diagnostic-commands.md).
8. [ADR 0023: Thin Plugin SDK](adr/0023-thin-plugin-sdk.md).
9. [npm `package.json` documentation: `private`](https://docs.npmjs.com/cli/v11/configuring-npm/package-json#private).
10. [npm workspaces documentation](https://docs.npmjs.com/cli/v11/using-npm/workspaces).
11. [Vite HMR API documentation](https://vite.dev/guide/api-hmr).
12. [Node.js test runner documentation](https://nodejs.org/api/test.html).
