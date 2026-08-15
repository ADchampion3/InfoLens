# Roadmap

This file tracks work that still needs deployment, product decisions, or
user-facing completion beyond the checked-in implementation.

## Plugin Distribution Market

### TODO

- [ ] Deploy the official HTTPS Registry at
  `https://market.infolens.app/v1/index.json`.
  - Configure DNS, TLS, and the approved CDN or static hosting origin.
  - Serve the validated `index.json` and immutable ZIP artifacts.
  - Publish the first approved release and verify artifact SHA-256 values.
  - Add a deployment check for the index and an artifact download.

### Implemented

- [x] Host-owned catalog, cache, compatibility filtering, download, digest
  verification, cancellation, retry, provenance, and Runtime handoff.
- [x] Runtime-side archive, manifest, compatibility, duplicate-ID, Bundled
  conflict, staging, atomic commit, activation, and cleanup checks.
- [x] Deterministic ZIP publication and immutable `pluginId/version` records.

## Manual Plugin Import

### Current baseline

- [x] The desktop Plugin Manager lets a user select a local plugin directory.
- [x] The selected directory is copied into the managed Plugin Directory and
  receives `local` provenance.
- [x] Runtime validation covers the manifest, Host and Contract compatibility,
  OpenCLI commands and adapters, duplicate IDs, failure cleanup, and immediate
  enablement.
- [x] The existing workflow accepts the directory produced by `pack`, whose
  `.infolens-plugin` suffix is a directory name rather than a ZIP file.
- [x] The Plugin Manager can import a local ZIP archive through the same safe
  extraction, Contract validation, staging, and activation boundary used by
  Market installs; the imported package remains `local` provenance.

### Open decisions

- [ ] Add import progress, cancellation, structured error details, and retry
  affordances if manual imports are expected to handle large packages.
