---
name: infolens-plugin-author
description: Develop, review, and package Infolens Plugin Contract Version 2 packages, including manifests, Plugin Backend modules, static Workspace Bundles, OpenCLI command mappings, Provided OpenCLI Adapters, author validation, preview, and Personal Plugin Distribution artifacts. Use when adding or changing an Infolens Plugin or its OpenCLI integration.
---

# Infolens Plugin Author

Use this skill for the Infolens package boundary. Keep source-specific business
behavior in the Plugin, keep lifecycle ownership in Plugin Runtime, and expose
OpenCLI only through manifest-declared command keys.

## Read Before Editing

1. Read `CONTEXT.md` and `docs/agents/domain.md` for repository vocabulary.
2. Read `docs/plugin-development.md`; use `docs/plugin-development.zh-CN.md`
   when the requested documentation or explanation is Chinese.
3. Read the relevant decisions before changing a boundary:
   `docs/adr/0042-plugin-backend-module-interface.md`,
   `docs/adr/0049-plugin-provided-opencli-adapters.md`,
   `docs/adr/0055-plugin-author-diagnostic-commands.md`, and
   `docs/adr/0059-plugin-author-preview-harness.md`.
4. Inspect `package.json`, the target Plugin, its `manifest.json`, and existing
   tests before choosing a new shape.

Completion: the target package root, its current contract, its owning runtime
boundary, and any relevant ADR are known.

## Choose the Package Path

- Develop a bundled Plugin under `plugins/<plugin-id>/`. Commit its built
  `web/dist/` Workspace Bundle when source changes require it.
- Develop an independent Plugin outside this repository with an installed
  `@infolens/plugin-sdk`. Use the SDK's published dependency boundaries rather
  than reaching into this repository with relative imports.
- Update an existing Plugin in place only after reading its manifest, Backend,
  Workspace entry, OpenCLI mappings, and persistence code.

Run `npm run plugin -- help` from this repository. In an independent project,
use the installed `infolens-plugin` binary. Author commands return JSON by
default; use `--format text` for a human summary and keep automation on the
stable fields `ok`, `command`, `environment`, `checks`, and `error` identity.

Completion: the package root and the repository or installed-CLI command path
are selected.

## Build the Package

Use `init` only for an empty or absent directory:

```powershell
npm run plugin -- init path\to\my-plugin --check --format text
```

The scaffold creates `manifest.json`, `package.json`, an ESM Backend, and a
static Bundle under `web/dist/`. It does not add SDK dependencies, install
packages, compile frontend source, or create a Development Link.

Keep these Contract Version 2 invariants:

- `manifest.json` is at the package root and declares `contractVersion: "2"`.
- `id` uses lowercase letters, numbers, and hyphens; `version` and
  `minHostVersion` are semantic versions.
- `backend.entry` and `ui.entry` are relative paths to files inside the
  package. `ui.entry` points to a built static HTML file.
- `openCliAdapters` and `openCliCommands` are objects, including empty objects
  when the Plugin has no OpenCLI integration.
- Every Backend OpenCLI call uses a manifest command key. Pass task signals to
  `context.opencli.run(key, args, signal)` and do not pass `-f`, `--format`, or
  arbitrary command paths; Runtime adds JSON output and controls discovery.
- `activate(context)` registers routes and tasks, sets initial Plugin Health,
  and returns `deactivate()` when resources or schedules need cleanup.
- Keep Plugin data and schema migrations in the Plugin-owned data directory.
- Keep the Workspace static and locally referenced. `/runtime/` is a Host
  Runtime mount; dynamic API URLs are expected diagnostic warnings.

Completion: the manifest points to real package files, Backend activation is
cleanup-capable, and Workspace assets are built at the declared entry.

## Add OpenCLI Integration

Inspect the actual bundled inventory before adding a Provided Adapter:

```powershell
npm run plugin -- adapters list path\to\my-plugin --format text
```

Use `adapter: "builtin"` when the required command exists in that inventory.
The mapping must declare the exact command path, must have `site` equal to the
first path segment, and must use `access: "read"`, `outputFormat: "json"`, and
one supported strategy: `PUBLIC`, `COOKIE`, or `INTERCEPT`.

### Create a Provided Adapter

Load these existing skills when this branch fires:

- `.agents/skills/opencli-usage/SKILL.md` to discover the live OpenCLI surface.
- `.agents/skills/opencli-adapter-author/SKILL.md` to perform site recon,
  strategy selection, field decoding, adapter coding, and verification.

Follow the OpenCLI adapter skill's strategy note, endpoint evidence, field
decoding, output design, and verify steps. Its private adapter path
(`~/.opencli/clis/<site>/<command>.js`) is a recon/development location, not
the final Infolens package. Copy the ready-to-run command into:

```text
my-plugin/
  opencli-adapters/
    my-adapter/
      opencli-plugin.json
      package.json                 # optional metadata
      command.js                   # or one or more .js/.mjs files
```

Declare the adapter in `manifest.json` and map every registered command:

```json
{
  "openCliAdapters": {
    "myAdapter": {
      "id": "io.example.my-source",
      "version": "1.0.0",
      "path": "opencli-adapters/my-adapter"
    }
  },
  "openCliCommands": {
    "items": {
      "site": "infolens-my-source",
      "adapter": "myAdapter",
      "command": ["infolens-my-source", "items"],
      "strategy": "PUBLIC",
      "access": "read",
      "outputFormat": "json"
    }
  }
}
```

Make `opencli-plugin.json.name` and `.version` exactly match the declaration,
use a reverse-domain adapter ID, and set `.opencli` to a semver range that
includes the bundled OpenCLI version. Keep the adapter self-contained:

- Include ready-to-run `.js` or `.mjs` output and no `node_modules`.
- Bundle non-OpenCLI runtime dependencies into the JavaScript output. Do not
  declare `dependencies` or `optionalDependencies` in the adapter metadata.
- Import OpenCLI public modules such as
  `@jackwener/opencli/registry` and `@jackwener/opencli/errors`, plus Node
  built-ins or relative files.
- Register no `onStartup`, `onBeforeExecute`, or `onAfterExecute` hook.
- Align `columns` with the returned object keys in name and order, and throw a
  typed OpenCLI error for invalid input, auth failure, empty results, or source
  execution failure instead of silently returning sentinel data.

Do not claim that a passing author check proves a live `COOKIE` or `INTERCEPT`
source works. `doctor` never runs Plugin tasks or OpenCLI during activation;
real-source verification is a separate developer-machine check and requires
the Browser Bridge/session setup. Follow the repository rule against UI tests.

Completion: every registered adapter command has one manifest mapping, the
mapping's strategy/access matches actual registration, and the adapter contains
no install-time dependency or hook requirement.

## Run the Author Gates

Run the narrowest useful command first, then the full package gate:

```powershell
npm run plugin -- validate path\to\my-plugin --format text
npm run plugin -- adapters list path\to\my-plugin --format text
npm run plugin -- dev path\to\my-plugin --format text
npm run plugin -- doctor path\to\my-plugin --timeout 10000 --format text
npm run plugin -- preview path\to\my-plugin --format text
npm run plugin -- pack path\to\my-plugin --out ..\my-plugin.zip --format text
```

- `validate` checks manifest, entry files, compatibility, command mappings,
  and the Provided Adapter Scope without activating Backend code.
- `adapters list` repeats the probe and lists bundled inventory plus provided
  adapters. Use it to diagnose unavailable commands or range mismatches.
- `dev` creates `.infolens-dev/opencli-adapters` with linked development
  content. It does not start Runtime, watch files, or provide hot reload.
- `doctor` activates the real Backend in temporary Plugin, data, Host State,
  Managed Adapter Store, and Adapter Scope roots; it checks registrations,
  Health, cleanup, and static Workspace references. It does not open a
  browser, execute Workspace JavaScript, arm schedules, run tasks, or call
  OpenCLI during activation.
- `preview` serves the built Workspace through an isolated Runtime and watches
  package files for restart. Stop with `Ctrl+C` or `shutdown` on stdin. Treat
  its URL as a Runtime/API smoke surface, not a UI test.
- `pack` copies the exact package contents to staging, excludes
  `node_modules`, `.git`, `.infolens-dev`, and old `adapter-integrity.json`,
  runs staged `doctor`, writes fresh adapter hashes into a deterministic ZIP,
  and creates `<artifact>.sha256` plus `<artifact>.distribution.json`.
  Outputs must be outside the source package and all three paths must be new.

Personal Plugin Distribution has no `publish` command, central catalog,
Registry, retraction, or background update workflow. A Host accepts the ZIP
locally or accepts a direct HTTPS URL together with its expected SHA-256.

Completion: `validate`, `doctor`, and `pack` return `ok: true`; all warnings
are understood; the ZIP contains `adapter-integrity.json`; the SHA-256 and
distribution-description companions exist; and any live-source verification
still required is named explicitly.

## Diagnose Failures

Use the error code and check phase as the next action:

| Finding | Next action |
| --- | --- |
| `UNAVAILABLE_COMMAND` | Rerun `adapters list`; use an exact bundled command or add a Provided Adapter. |
| `ADAPTER_*` | Check adapter path, identity/version, OpenCLI range, bundled dependencies, hooks, and generated JavaScript. |
| `ADAPTER_COMMAND_MISMATCH` or `UNDECLARED_ADAPTER_COMMAND` | Compare actual OpenCLI registration with every manifest mapping. |
| `DIAGNOSTIC_OPENCLI_EXECUTION` | Move collection from `activate` into a task or route-triggered enqueue. |
| `WORKSPACE_*` | Fix the staged HTML/JavaScript/CSS graph; do not hide a missing local file behind a dynamic URL. |
| `PACK_OUTPUT_EXISTS` | Choose a new output path; the packer never overwrites an artifact. |

When the repository and an installed package disagree, check these sources in
order: `packages/plugin-runtime/src/contract.mjs`,
`packages/plugin-runtime/src/adapter-scope.mjs`,
`packages/plugin-sdk/src/index.d.ts`, and
`packages/plugin-sdk/bin/infolens-plugin.mjs`.
