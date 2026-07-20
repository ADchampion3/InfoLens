# Plugin Backend Module Interface

Every plugin `backend.entry` exports `activate(context)`. Plugin Runtime supplies one activation context containing the plugin ID and data directory, plugin-scoped HTTP route registration, task definition/enqueueing/schedule registration, logging, and `opencli.run(commandKey, args, signal)`. Activation returns cleanup behavior used during module deactivation.

Plugins own SQLite stores, source-specific routes, task handlers, and refresh policy. They register their selected refresh schedule with Plugin Runtime, which owns timers, queueing, cancellation, and resource permits. A module cannot listen on its own port, start an independent scheduler, or directly spawn OpenCLI; `opencli.run` accepts only commands declared in its manifest.
