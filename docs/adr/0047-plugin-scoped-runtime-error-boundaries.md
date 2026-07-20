# Plugin-Scoped Runtime Error Boundaries

Plugin Runtime will catch ordinary activation, route, task, and cleanup errors at a plugin boundary, record the failure for that plugin, and keep sibling modules running. If the Runtime process itself exits, the host may briefly lose all plugin APIs while it restarts and reactivates enabled modules. The MVP does not try to protect against a trusted plugin deliberately terminating the process or causing a native-process crash.
