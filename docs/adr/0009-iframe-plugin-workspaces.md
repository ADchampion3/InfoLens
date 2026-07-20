# Iframe Plugin Workspaces

The Electron renderer will load a selected plugin's built Web workspace into an iframe served from local static assets. This lets each plugin fully control its content UI while keeping host navigation independent of plugin styles, routing, and ordinary renderer failures; it does not add a plugin approval or permission-review system.
