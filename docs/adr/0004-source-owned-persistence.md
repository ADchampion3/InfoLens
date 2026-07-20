# Source-Owned Persistence

Each Infolens source integration will own the persistent records it collects and its source-specific storage schema. The workspace will not make a central normalized item table authoritative; this keeps distinct source data models independent while preserving room to define a separate reading projection later.
