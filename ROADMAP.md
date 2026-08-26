# Roadmap

This file tracks work that still needs deployment, product decisions, or
user-facing completion beyond the checked-in implementation.

## Personal Plugin Distribution

### Implemented

- [x] Deterministic Plugin ZIP artifacts with external SHA-256 and
  machine-readable distribution descriptions.
- [x] Local ZIP import and direct HTTPS installation with expected digest
  verification, bounded transfer, redirect policy, and temporary-file cleanup.
- [x] Runtime preflight, duplicate-ID protection, explicit replacement,
  transactional rollback, one-revision retention, cancellation, retry, and
  crash recovery journals.
- [x] Legacy Market provenance migration to `url` or `local` Host State records.
- [x] Desktop Plugin Manager actions for Import ZIP, Install URL, Replace,
  revision inspection, Rollback, diagnostics, and trusted-code disclosure.

### Open decisions

- [ ] Add release automation that signs distribution descriptions when a
  signing policy is selected.
- [ ] Add an optional user-configured HTTPS mirror without introducing a
  central catalog or registry dependency.

## Manual Plugin Import

### Current baseline

- [x] The Plugin Manager imports a local ZIP through the shared archive and
  Contract validation boundary.
- [x] Runtime validation covers the manifest, Host and Contract compatibility,
  OpenCLI commands and adapters, duplicate IDs, activation failure cleanup,
  and immediate enablement.
- [x] Local and URL provenance, expected/observed digests, operation status,
  cancellation, retry, and recovery state are visible to the Host client.

### Open decisions

- [ ] Add an OS-native download dialog for large URL artifacts when the client
  integration needs one; the Runtime API already owns transfer controls.
