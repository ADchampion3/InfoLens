# Sprint 7 User Acceptance

## Phase

Sprint 7: Release-Candidate Assembly

**Outcome:** Assemble and validate every MVP component in one packaged Electron release candidate.

## Build Under Test

- Release candidate directory: `D:\Infolens\release\infolens-win32-x64`
- Executable: `D:\Infolens\release\infolens-win32-x64\Infolens.exe`
- Deterministic acceptance command: `npm run acceptance:sprint7`
- Retained acceptance profile: `.infolens-acceptance/sprint7/`
- Compatible installation fixture: `D:\Infolens\tests\fixtures\sprint6\installable-plugin`
- Full matrix instructions: `docs/sprint7-integration-matrix.md`
- Automated packaged matrix: `npm run test:sprint7`
- Sprint 7 is intentionally uncommitted until explicit user acceptance.

## Delivered Work Items

| Work item | Delivered feature | Primary location |
| --- | --- | --- |
| Windows release candidate | Deterministic unpacked Windows x64 Electron application with production renderer, Runtime, SDK, four official plugin packages, pinned OpenCLI, and a release manifest | `scripts/package-sprint7.mjs`, `release/infolens-win32-x64/` |
| Packaged profile ownership | Packaged execution seeds bundled plugins into writable Electron `userData` and keeps plugin packages, SQLite stores, logs, host state, and selection outside the application directory | `apps/desktop/main.cjs` |
| Full packaged matrix | Chrome DevTools Protocol automation drives the real packaged renderer, isolated official workspaces, scoped APIs, plugin stores, native IPC, Runtime child recovery, and application restart | `tests/sprint7-release-candidate.test.mjs`, `tests/helpers/sprint7-packaged-app.mjs` |
| Lifecycle operations | Matrix coverage for discovery, activation, navigation, refresh, scheduling settings, rejection, installation, diagnostics, removal, theming, and persistence | Sprint 7 packaged integration test |
| Failure isolation | Deterministic malformed and Browser Bridge-disconnected Product Hunt runs preserve its records while public siblings remain operational | Sprint 7 packaged integration test and Sprint 5 OpenCLI fixture |
| Recovery and restart | Test-only gated Electron controls terminate the actual Runtime child; host recovery reactivates four official plugins and full application restart restores retained state | Desktop main/preload and Sprint 7 packaged integration test |
| Manual acceptance | Retained packaged launcher and row-by-row integrated acceptance script | `scripts/acceptance-sprint7.mjs`, `docs/sprint7-integration-matrix.md` |

## Engineering Checks

| Check | Result |
| --- | --- |
| `npm run typecheck` | Passed: desktop renderer and Plugin SDK declarations |
| `npm run package:sprint7` | Passed: production renderer built and Windows x64 release candidate assembled with Electron 43.2.0 and OpenCLI 1.8.6 |
| `npm run test:sprint7` | Passed: 2 artifact and packaged full-system integration tests |
| `npm test` | Passed: all 26 Sprint 1-7 tests from a clean release-candidate rebuild |
| Packaged workspace path | Passed: all four workspaces were selected and refreshed through the Electron renderer and isolated Chromium iframe targets |
| Runtime recovery | Passed: actual packaged Runtime child terminated, recovered on a new origin, reactivated all official plugins, and retained records |
| Application restart | Passed: packaged app reopened the same profile with theme, selection, schedules, enabled plugins, and retained records |
| `git diff --check` | Passed |

## Acceptance Checklist

| # | Sprint work item and acceptance criterion | User action and expected evidence | Result |
| --- | --- | --- | --- |
| 1 | A clean packaged release candidate includes the pinned host, SDK, Runtime, OpenCLI, and four built plugin packages. | Run `npm run acceptance:sprint7`. The packaged Infolens window opens and lists Hacker News, GitHub Trending, Zhihu, and Product Hunt together. | Passed |
| 2 | Every official workspace completes the Electron UI to scoped API to independent plugin-store path. | Open and refresh each source. Each workspace renders fixture content and remains independently navigable. | Passed |
| 3 | Scheduling uses the shared Runtime queue and settings persist. | Save a fixed interval in one workspace, restart, and verify its setting returns without changing sibling settings. | Passed |
| 4 | Browser Bridge degradation is plugin-local. | Set `producthunt` to `disconnected` in the acceptance state file and refresh Product Hunt. Its dependency state appears while Hacker News and GitHub remain usable. | Passed |
| 5 | Refresh failures preserve retained content and isolate siblings. | Restore Product Hunt success once, then set it to `malformed` and refresh. Its prior products remain with warning feedback and siblings continue to refresh. | Passed |
| 6 | Compatible installation and incompatible/duplicate rejection run through Electron and Runtime. | Install Reading Notes from the fixture, then attempt the same installation again. The first activates; the duplicate is rejected without damaging it. | Passed |
| 7 | Diagnostics are bounded and redacted. | Copy Reading Notes diagnostics and inspect the clipboard. It contains identity/status/log evidence but no records, cookies, authentication data, or browser paths. | Passed |
| 8 | Confirmed removal deletes only the selected package and owned state. | Cancel Reading Notes removal once, then confirm it. Reading Notes disappears and all four official plugins remain operational. | Passed |
| 9 | Theme and host state cross the workspace boundary and survive restart. | Select Hacker News, choose Dark, return to its workspace, then restart. Dark and Hacker News are restored without losing records. | Passed |
| 10 | Runtime exit triggers host recovery and reactivation without record loss. | End the Plugin Runtime child process in Task Manager. Observe the restart bar, recovery, workspace reload, all enabled sources, and retained records. | Passed |
| 11 | Application restart restores enabled state, theme, last available selection, schedules, and retained content for every plugin. | Close the main window and rerun the acceptance command. Verify the complete retained profile returns. | Passed |
| 12 | Earlier sprint behavior and the assembled release remain buildable. | Run `npm test` and `npm run typecheck`; both pass. | Passed |

## Scope Notes

- Automated and manual Sprint 7 acceptance use credential-free OpenCLI fixture output through the real bundled process boundary. They validate assembly but do not satisfy Sprint 8 real-source evidence.
- `INFOLENS_TEST_CONTROL=1` gates automation-only Runtime termination and clipboard-read IPC. The acceptance launcher and ordinary packaged application do not enable these controls.
- The release candidate is an unpacked Windows x64 directory suitable for the assembly gate; installer production and real-source release evidence remain Sprint 8 work.

## Acceptance Record

- Tester: User
- Date: 2026-07-29
- Result: Accepted
- Notes: User explicitly requested the verified Sprint 7 increment be committed to Git.
