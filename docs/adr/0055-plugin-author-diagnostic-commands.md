# Reliable Plugin Author Commands

## Status

Accepted for the Contract Version 2 author workflow.

## Decision

Plugin author commands resolve Host, Plugin Contract, Plugin SDK, and Bundled OpenCLI metadata through package boundaries. Host-facing package versions are lockstep. The Plugin SDK keeps an independent semantic version, and the Plugin Contract remains an independent protocol integer. `scripts/verify-release.mjs` is the release gate for those relationships, the exact OpenCLI dependency, the installed OpenCLI package identity, the generated command inventory, and any release manifest.

`validate` is the fast package-contract command. `doctor` is its strict lifecycle superset: it runs in a child Plugin Runtime with temporary state roots, loads only the target package, records registration results, checks Plugin Health, and performs cleanup. Diagnostic mode records schedules without arming them, leaves tasks idle, and rejects OpenCLI calls during activation. It is an isolation boundary for state and lifecycle behavior, not a Node or operating-system security sandbox for trusted Backend code.

Workspace diagnosis is static. It follows local HTML, JavaScript, and CSS references from the Manifest Workspace entry, handles cycles and duplicates, rejects missing or escaping local files, and reports external or dynamically unresolved references as warnings without fetching or executing them. Source maps are ignored by default.

`pack` filters the source package into a unique staging directory beside the requested output, runs `doctor` against that exact staged content, writes adapter integrity metadata, and creates a deterministic Plugin ZIP plus its SHA-256 and distribution-description companions only after all error-level checks pass. Warnings remain visible and permit artifact creation. Failed staging or diagnosis removes the staging directory and never leaves a known-broken artifact.

## Consequences

The author CLI has a stable JSON envelope and stable check identifiers, codes, phases, and environment source identities. Human messages and resolved paths remain diagnostic details. The workflow does not start Electron, render a Workspace, open a browser, contact a real Source, or inspect the user's installed Plugin or Host State. A future installed-system doctor is a separate contract.

The release candidate must include the verified release metadata and must pass the official Plugin command matrix. Independent Plugin projects can run the commands from installed package boundaries without a monorepo-relative OpenCLI resource path.

This decision extends [ADR 0019](0019-bundle-opencli-runtime.md), [ADR 0023](0023-thin-plugin-sdk.md), [ADR 0039](0039-basic-plugin-package-compatibility.md), [ADR 0044](0044-runtime-hosted-plugin-workspaces.md), and [ADR 0049](0049-plugin-provided-opencli-adapters.md).
