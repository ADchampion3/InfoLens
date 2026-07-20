# MVP Source and OpenCLI Strategy Mapping

The MVP ships four user-visible official plugins: Hacker News Top Stories, GitHub Trending, Zhihu Hot List, and Product Hunt Today's Top Launches. Hacker News and GitHub Trending use OpenCLI `PUBLIC`; Zhihu Hot List uses `COOKIE`; Product Hunt uses `INTERCEPT`.

This preserves two browser-independent technology sources while making the Chrome login-session and interception paths part of real, daily-use information experiences. All four plugins remain independently owned packages with their own stores, refresh settings, and workspaces.
