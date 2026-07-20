# Minimal Plugin Lifecycle Contract

## Status

Superseded in lifecycle mechanics by [ADR 0041](0041-shared-plugin-runtime-and-task-scheduling.md).

The host will assign a plugin's loopback API port at process start, consider it available after `GET /health` returns `ready`, and stop it through normal termination followed by forced termination after a short grace period. This deliberately replaces authenticated IPC and governed runtime state machines with the smallest contract needed for navigation and operational status.
