# MVP Source and OpenCLI Strategy Mapping

The MVP ships five user-visible official plugins: Hacker News Top Stories, GitHub Trending, Juejin Hot Articles, Zhihu Hot List, and Product Hunt Today's Top Launches. Hacker News, GitHub Trending, and Juejin use OpenCLI `PUBLIC`; Zhihu Hot List uses `COOKIE`; Product Hunt uses `INTERCEPT`.

This preserves three browser-independent technology sources while making the Chrome login-session and interception paths part of real, daily-use information experiences. All five plugins remain independently owned packages with their own stores, refresh settings, and workspaces.
