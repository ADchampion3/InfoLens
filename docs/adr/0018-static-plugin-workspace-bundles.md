# Static Plugin Workspace Bundles

Every plugin will provide a built static workspace bundle at `web/dist/index.html`, while its internal frontend framework remains its own choice. The Electron host and bundled MVP plugins will use React and Vite to reuse TractIt code, but that implementation choice is not imposed on third-party plugin packages.
