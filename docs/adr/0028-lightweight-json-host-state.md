# Lightweight JSON Host State

The host will store only enabled plugins, last selection, theme preference, and recent lifecycle state in an atomically written JSON file. It will scan plugin manifests from the fixed plugin directory instead of introducing a central Registry database; plugin SQLite stores remain the authority for plugin business data.
