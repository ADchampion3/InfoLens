# Sprint 7 Integration Matrix

Use the packaged release candidate only. Build it with `npm run package:sprint7`, then start the retained deterministic profile with `npm run acceptance:sprint7`.

| Row | Boundary exercised | Manual action | Expected evidence |
| --- | --- | --- | --- |
| 1 | Package, host, Runtime, SDK, OpenCLI | Start with an empty `.infolens-acceptance/sprint7/` profile. | The packaged app opens and lists Hacker News, GitHub Trending, Zhihu, and Product Hunt as enabled. |
| 2 | Navigation and workspaces | Open each source from the sidebar. | Each Runtime-hosted workspace loads inside the Electron host with its source-specific controls. |
| 3 | Scoped APIs and independent stores | Refresh each source, then navigate between all four. | Fixture records render in every workspace and each plugin creates its own data directory and SQLite store. |
| 4 | Scheduler | In one workspace choose refresh settings, fixed interval, and save. Restart the app and reopen settings. | The policy and interval remain selected; other plugins retain independent settings. |
| 5 | Browser degradation and failure isolation | Set `producthunt` to `disconnected` in `.infolens-acceptance/sprint7/opencli-state.json`, then refresh Product Hunt. | Product Hunt shows its Browser Bridge state and retained products; Hacker News and GitHub remain readable and refreshable. |
| 6 | Refresh failure isolation | Set `producthunt` to `malformed`, refresh it, then open Hacker News. | Product Hunt shows a retained-content warning; its previous products remain and Hacker News is unaffected. |
| 7 | Theme and host state | Select Hacker News, choose Dark in Settings, and return to its workspace. | Host and open workspace update without reload. Closing and reopening restores Dark and Hacker News. |
| 8 | Installation and activation | In Plugins choose Install plugin and select `tests/fixtures/sprint6/installable-plugin`. | Reading Notes is copied to the profile, enabled, activated, navigable, and served through Runtime. |
| 9 | Rejection and diagnostics | Attempt a duplicate install, inspect any rejected package, and copy diagnostics for Reading Notes. | Exact compatibility/duplicate reason is shown. Diagnostics contain bounded operational data and no source rows or authentication material. |
| 10 | Removal | Remove Reading Notes, cancel once, then confirm. | Its package, data, settings, routes, and logs disappear while all official plugins remain operational. |
| 11 | Runtime recovery | End the child Plugin Runtime process from Task Manager while the host remains open. | A non-modal restart state appears, a new Runtime starts, all enabled plugins reactivate, and retained records remain. |
| 12 | Application restart | Close the main window and rerun `npm run acceptance:sprint7`. | Enabled state, theme, last available selection, schedules, and all retained plugin records return. |

`npm run test:sprint7` automates the same assembly with a packaged Electron renderer, real child Runtime, deterministic OpenCLI process fixture, official backends/workspaces, independent stores, native IPC installation/removal, diagnostics clipboard, Runtime termination/recovery, and application restart. It does not constitute Sprint 8 real-source evidence.
