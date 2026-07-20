# Defer the UI Strategy from MVP

Status: superseded by [ADR 0046](0046-reject-ui-strategy-in-current-contract.md).

Infolens retains a generic plugin contract that can invoke OpenCLI commands declared with `Strategy.UI`, but the MVP will not bundle or release a user-visible `UI` representative plugin. The MVP release gate instead requires real, user-visible representatives for `PUBLIC`, `COOKIE`, and `INTERCEPT`.

This reduces initial setup dependencies and source-selection complexity without introducing a host-level special case. A later official or trusted local plugin may use `UI` through the unchanged OpenCLI process adapter.
