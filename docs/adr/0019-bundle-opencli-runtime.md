# Bundle the OpenCLI Runtime

Infolens will ship a pinned OpenCLI runtime and invoke its application-local CLI path, so users do not install OpenCLI globally or configure Node/npm/PATH. Browser-backed collection still relies on the user-installed Chrome Browser Bridge extension, which Infolens detects and guides during first-run setup.
