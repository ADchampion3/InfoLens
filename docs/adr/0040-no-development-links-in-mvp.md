# No Development Links in MVP

The MVP scans only its managed fixed `plugins/` directory. Local-folder installation copies a prebuilt package into that directory, while official plugin development builds and runs from the repository's corresponding plugin directory.

The MVP does not support external development links, symbolic links, or plugin hot reload. This keeps discovery, removal, and replacement semantics deterministic; a dedicated development-link workflow may be added later.
