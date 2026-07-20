# Local Plugin Diagnostics

The host atomically persists one minimal status snapshot per plugin: lifecycle state, last successful refresh time, and latest failure time, code, and short message. It does not persist full logs, collected source records, credentials, Chrome profiles, or Browser Bridge sessions.

Plugin Runtime supplies every backend module with a logger that writes a bounded rotating log in that plugin's data directory. The plugin manager can copy a report for a selected plugin containing its status snapshot and recent log entries. Reports are local, per-plugin, and exclude source records and authentication material. Plugin removal deletes the logs with the rest of the plugin data.
