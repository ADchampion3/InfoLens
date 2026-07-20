# Independent SQLite Plugin Stores

Each bundled plugin will use an independent SQLite database in its own data directory, with a plugin-owned schema and migrations. This provides durable offline source history without a shared data model or host-managed database migration system.
