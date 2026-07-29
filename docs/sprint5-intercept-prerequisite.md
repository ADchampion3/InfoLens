# Sprint 5 INTERCEPT Prerequisite

Product Hunt collection uses the bundled OpenCLI `producthunt hot` command. The command opens Product Hunt through a connected Browser Bridge session and installs OpenCLI's `producthunt.com` interceptor before reading the rendered ranking.

## Developer Machine

1. Install and connect OpenCLI Browser Bridge in Chrome.
2. Confirm Product Hunt opens normally in that browser profile. Product Hunt login is not required by the current adapter.
3. Run `npm run live:sprint5`.
4. Open the URL printed by the command, select Product Hunt, and choose Refresh.
5. Confirm ranked launches with vote counts appear and remain after stopping and restarting the command.

If Browser Bridge is disconnected, Product Hunt alone should show its connection action. Zhihu and Product Hunt share one browser-backed Runtime permit, so simultaneous refreshes run sequentially. Hacker News and GitHub Trending use the independent three-permit `PUBLIC` pool.

The deterministic command `npm run acceptance:sprint5` uses a credential-free OpenCLI process fixture. It verifies product rendering and queue behavior, but it is not evidence of a real-source `INTERCEPT` run.
