# Runtime-Hosted Plugin Workspaces

Status: superseded

Superseded by: [ADR 0061 - Standalone Plugin Runtime Daemon and Client-Independent Lifecycle](0061-standalone-daemon-and-client-independent-lifecycle.md)

ADR 0061 retains daemon-served, same-origin static workspaces and the rule that clients do
not proxy Plugin business requests. It supersedes the Electron-owned Runtime lifetime and
the unversioned business routes in this ADR; the current API and health paths are under
`/api/v1`.

The standalone daemon serves every plugin's built workspace bundle and scoped API from the same loopback origin. Workspaces are available below `/plugins/<pluginId>/workspace/`, APIs below `/api/v1/plugins/<pluginId>/api/`, and health is available at `/api/v1/plugins/<pluginId>/health`. Workspace bundles must use entry-relative asset URLs so assets remain inside that mount path. Host Web, whether opened in a browser or Electron, embeds the daemon workspace and never proxies plugin business requests. This removes a cross-origin CORS dependency while keeping a plugin as code loaded by the daemon rather than an independent service.
