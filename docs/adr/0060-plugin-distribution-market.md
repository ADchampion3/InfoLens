# Plugin Distribution Market Boundary

Status: accepted

Supersedes [ADR 0013](0013-fixed-directory-and-local-plugin-installation.md) only where it excludes a remote Registry and marketplace. The fixed Plugin Directory, explicit local installation, and existing Plugin lifecycle contracts remain in force.

## Context

Infolens needs a controlled distribution path for approved Plugin releases while remaining local-first. A Market must not become a second Plugin Runtime, a remote lifecycle controller, or an implicit trust authority. The existing package contract, author validation workflow, and explicit removal behavior already define the lifecycle boundary.

## Decision

V1 adds a Host-owned Plugin Market service backed by one fixed official HTTPS Registry. The Registry exposes a validated static JSON index and immutable deterministic ZIP artifacts. Artifact URLs may use only the official Registry origin or an explicit CDN allowlist. The client validates the complete index, keeps the last successful cache for offline browsing, and requires a current Registry connection for a new remote installation.

The existing Plugin SDK author workflow remains the publication gate. `publish` runs the established `pack` and `doctor` path, creates a deterministic archive, records its SHA-256, and publishes the artifact and release record as one Registry operation. A `pluginId/version` pair is immutable. V1 has no public upload API, publisher account flow, package signatures, automatic upgrades, or pre-release channel.

The Host downloads a selected compatible stable release outside the managed Plugin Directory and passes it to the Plugin Runtime. The Runtime repeats the digest check, rejects unsafe archives, validates the Plugin Contract and release metadata, stages the package, atomically commits it, and enables it immediately. The Runtime remains the only lifecycle authority. Existing local-folder installation remains available and records `local` provenance; Bundled packages record `bundled` provenance. A Market package cannot replace a Bundled Plugin or an existing Plugin ID.

Host State stores Market provenance separately from `manifest.json`, including source references, selected version, publication metadata, expected and observed digest, installation time, and release status. Retraction changes Market availability and installed provenance only; it never remotely disables, deletes, or modifies installed package code or data. Plugin Manager removal continues to stop the Plugin and delete the package, Plugin-owned data, Adapter Scope, Host State entries, and retained logs, including the existing Runtime restart-required path.

The Host Shell keeps Market discovery and trusted-code disclosure separate from Plugin Manager lifecycle controls. The disclosure identifies the publisher, release, official source, SHA-256, and the fact that trusted Plugin Backend code can access filesystem, network, and subprocess APIs. SHA-256 is integrity evidence only and is not presented as publisher authentication.

## Consequences

Users can discover and install approved releases without weakening local recovery or development workflows. Offline users retain catalog context and installed Plugin operation, but cannot treat stale metadata as current installation authority. Release publication and installation gain stable validation, operation, provenance, and cleanup evidence. Registry availability, package signatures, automatic upgrades, migrations, rollback, and remote kill switches remain outside V1.

ADR 0014, ADR 0016, ADR 0017, ADR 0039, ADR 0048, and ADR 0055 continue to govern package copying, explicit replacement, removal data deletion, compatibility gates, discovery checks, and author publication validation.
