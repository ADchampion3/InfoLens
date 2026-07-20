# Per-Plugin Node Process

## Status

Superseded by [ADR 0041](0041-shared-plugin-runtime-and-task-scheduling.md).

Each Infolens plugin backend will run as an independent Node child process with its own loopback HTTP API port. This is operational fault isolation, not a hostile-code sandbox: the host can keep navigation and sibling plugins available when one backend crashes while continuing to trust installed plugin code by default.
