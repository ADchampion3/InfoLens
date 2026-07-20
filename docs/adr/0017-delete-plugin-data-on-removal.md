# Delete Plugin Data on Removal

## Status

Amended in removal mechanics by [ADR 0041](0041-shared-plugin-runtime-and-task-scheduling.md). The delete-data decision remains in force.

Explicit plugin removal will delete both the plugin package and its plugin-owned data directory. Since replacing a plugin is manual and a new package may use an incompatible data format, Infolens will not retain source data across removal for a later replacement to inherit.
