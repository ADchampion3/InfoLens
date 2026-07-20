# Exit Stops Plugin Backends

## Status

Amended in process mechanics by [ADR 0041](0041-shared-plugin-runtime-and-task-scheduling.md). The exit policy remains in force.

Closing the main Infolens window will exit the MVP application and stop every plugin backend. Plugin refresh runs only during an explicit application session; the MVP will not retain a tray-resident or hidden background refresher.
