# Personal Plugin Distribution Without a Market

Status: accepted

Supersedes [ADR 0060](0060-plugin-distribution-market.md). The fixed Plugin
Directory, explicit local installation, shared Plugin Runtime, package
compatibility gates, and removal behavior from ADR 0013, ADR 0014, ADR 0016,
ADR 0017, ADR 0039, ADR 0048, and ADR 0055 remain in force.

## Context

Infolens distributes trusted Plugin code but does not need a central catalog,
publisher workflow, remote lifecycle authority, or background update service.
The former Market boundary introduced those concepts into the Host and SDK,
while the actual installation problem only requires a verifiable artifact and
an explicit user action.

## Decision

The product uses Personal Plugin Distribution. The formal artifact is a
deterministic Plugin Contract Version 2 ZIP plus two external companions:

- `<plugin>.zip.sha256` contains the artifact SHA-256.
- `<plugin>.zip.distribution.json` describes the Plugin identity, compatibility,
  artifact size, digest, and build metadata.

The Author CLI `pack` command validates the staged package with `doctor`, adds
the Adapter Integrity record, writes the deterministic ZIP, and creates both
companions. It has no `publish`, Registry, catalog, retraction, or background
update operation.

The Runtime exposes one Distribution Module seam for `install`, `replace`, and
`rollback` intents. Sources are either a local regular ZIP path or a direct
HTTPS URL with an expected SHA-256. Both source adapters enforce bounded
transfer, safe ZIP extraction, Contract/Host/OpenCLI/Workspace checks, and
temporary-state cleanup. URL redirects stay HTTPS and cannot carry
credentials.

An initial install is enabled immediately and records `local` or `url`
provenance. The same Plugin ID requires an explicit replacement intent; a
Bundled Plugin cannot be replaced by personal distribution. Replacement and
rollback are serialized per Plugin. Before switching, the Runtime snapshots
the current package, Plugin-owned data, Adapter Scope, Host State metadata, and
enabled state. It retains exactly one complete previous revision and supports
bidirectional rollback by swapping current and previous revisions. Any
pre-commit, disk, deactivation, switch, validation, or activation failure
restores the previous state before reporting failure.

Each mutating phase has a durable operation status and journal. Startup scans
incomplete journals before Plugin discovery, completes safe cleanup or restore,
and marks ambiguous state unavailable for explicit repair. Cancellation is
accepted before the commit boundary; retry creates a new operation linked to
the failed or cancelled source.

Host State migration is one-way and idempotent. A legacy `origin: "market"`
record becomes `url` when it has an artifact URL and otherwise becomes
`local`; package/data/version, observed and expected digests, installation time,
enabled state, and a safe source name are retained. Market-only publisher,
catalog, approval, retraction, and release fields are removed. No Registry
state is required after migration.

The Host Shell Plugin Manager presents Import ZIP, Install URL, Replace,
revision inspection, Rollback, cancellation/retry, diagnostics, and an
explicit trusted-code disclosure. It does not present catalog browsing,
Market status, or release publication controls. Daemon backup/restore remains
a separate Host State and Plugin data concern; Distribution revisions and
operation journals are not folded into the backup format.

## Consequences

Distribution is explicit, local-first, and recoverable. Users may exchange a
ZIP directly or host it at an HTTPS URL while the expected digest provides
artifact integrity evidence. SHA-256 does not authenticate a publisher, and
trusted Plugin Backend code remains ordinary Node.js code rather than a
security sandbox.

The Host no longer caches a catalog, checks release retractions, or performs
remote upgrades. Replacement and rollback add local disk usage for one
revision and require careful recovery handling, but a client disconnect cannot
interrupt the Runtime transaction. The old Market package and API are removed
rather than retained as compatibility shims.
