# OpenCLI CLI Process Boundary

Infolens will invoke known read-only OpenCLI commands through a managed local child process with JSON output, rather than importing OpenCLI's private command-execution modules. OpenCLI does not publicly export a stable adapter-execution API, so the CLI contract gives Infolens an upgradeable boundary while preserving its adapters, Browser Bridge, daemon, and logged-in browser behavior.
