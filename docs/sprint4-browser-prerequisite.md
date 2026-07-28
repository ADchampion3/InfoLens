# Sprint 4 Browser-Backed Collection

## Developer-machine prerequisite

Real Zhihu collection requires Google Chrome or Chromium with the official OpenCLI Browser Bridge extension installed and enabled. The extension must be connected to the local OpenCLI daemon, and the connected Chrome profile must have an authenticated `www.zhihu.com` session.

Install the extension from the [Chrome Web Store](https://chromewebstore.google.com/detail/opencli/ildkmabpimmkaediidaifkhjpohdnifk). Infolens bundles OpenCLI itself; a global OpenCLI installation is neither required nor used.

## Real-source procedure

1. Open Chrome, enable Browser Bridge, and confirm Zhihu is logged in in that same profile.
2. Run `npm run live:sprint4` from the repository root. Either the printed URL or the bare `http://127.0.0.1:4176/` preview root resolves the active Runtime.
3. Open the printed URL, select Zhihu Hot List, and choose Refresh. The plugin first invokes the official read-only `zhihu whoami` command from `auth.js`, then invokes `zhihu hot` only when login is valid.
4. Confirm at least 12 current ranked questions render, then stop and restart `npm run live:sprint4` and confirm retained questions appear before another refresh.
5. Disable Browser Bridge, refresh Zhihu, and confirm only Zhihu shows connection recovery while Hacker News and GitHub Trending remain usable.
6. Re-enable Browser Bridge, sign out of Zhihu, refresh, and confirm the workspace shows the distinct Zhihu login recovery state.

The deterministic `npm run acceptance:sprint4` profile exercises the same Runtime, plugin, API, persistence, and workspace boundaries with credential-free fixtures. It is not evidence of a real `COOKIE` collection; real-source evidence is recorded during the Sprint 8 release gate.
