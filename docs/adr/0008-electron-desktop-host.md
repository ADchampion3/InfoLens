# Electron Desktop Host

Infolens will use Electron for its MVP desktop host. This keeps OpenCLI's Node-based runtime and local child-process integration in the same primary environment while allowing the host renderer to navigate between plugin-owned Web workspaces; a smaller native shell is not worth adding a Rust and sidecar boundary in the first release.
