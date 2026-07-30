# Infolens 0.1.0 Release Notes

## Highlights

- One local-first Electron host for Hacker News, GitHub Trending, Zhihu Hot List, and Product Hunt.
- Independent plugin workspaces, SQLite stores, refresh settings, read state, and failure boundaries.
- Pinned OpenCLI 1.8.6 collection with `PUBLIC`, `COOKIE`, and `INTERCEPT` strategy support.
- Shared bounded task scheduling with coalescing, cancellation, and browser-work serialization.
- Plugin installation, compatibility rejection, diagnostics, enable/disable, and confirmed removal.
- System, light, and dark themes with restored selection and retained content after restart.
- Runtime crash recovery without losing plugin-owned records.
- Windows system-proxy handoff for the packaged Runtime while preserving explicit proxy environment settings.
- Product Hunt collection waits for real source cards across ordinary security-verification navigation without interacting with or bypassing the challenge.

## Release Status

Automated release-candidate validation passed on 2026-07-30. Hacker News, GitHub Trending, Zhihu, and Product Hunt all collected real-source data, persisted and rendered it, survived application restart, and remained intact through Runtime recovery. Version 0.1.0 remains uncommitted until the user completes the manual acceptance matrix and explicitly accepts Sprint 8.
