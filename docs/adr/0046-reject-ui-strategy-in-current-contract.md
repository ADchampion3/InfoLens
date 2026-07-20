# Reject UI Strategy in the Current Contract

The MVP plugin package contract accepts only OpenCLI `PUBLIC`, `COOKIE`, and `INTERCEPT` mappings. It rejects `UI` mappings during installation and discovery because its interactive execution and scheduler policy are not yet defined. This supersedes ADR-0036's claim that a `UI` plugin can use the unchanged MVP contract.
