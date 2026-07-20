# Start Enabled Plugins on Launch

## Status

Superseded by [ADR 0041](0041-shared-plugin-runtime-and-task-scheduling.md).

The host will start every enabled plugin backend when Infolens launches and keep it running for the application session, while loading a plugin's iframe workspace only after the user selects it. This permits plugin-defined background refresh without forcing every plugin UI to load or every plugin to collect automatically.
