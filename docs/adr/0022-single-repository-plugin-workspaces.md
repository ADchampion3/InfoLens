# Single Repository Plugin Workspaces

Infolens will use one workspace repository containing the Electron host, a shared plugin SDK, and the bundled HN, GitHub Trending, Juejin, and Zhihu plugins. The root `plugins/` directory remains the runtime discovery location, so bundled and locally installed packages share the same package shape.
