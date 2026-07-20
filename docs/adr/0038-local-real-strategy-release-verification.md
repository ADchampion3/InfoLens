# Local Real Strategy Release Verification

Every release candidate runs the four official MVP plugins through their bundled OpenCLI runtime on a developer machine with Browser Bridge connected and required browser sessions available. Each plugin must collect a real result, persist it in its SQLite store, and render the retained result in its workspace.

Continuous integration is limited to credential-free unit and contract tests. It must not contain website credentials, Chrome profiles, or Browser Bridge session data. Mocked OpenCLI results support isolated tests but never substitute for release verification.
