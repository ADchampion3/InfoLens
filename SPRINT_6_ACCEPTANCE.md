# Sprint 6 User Acceptance

## Phase

Sprint 6: Host Lifecycle and Operations

**Outcome:** Complete the daily-use host experience with persisted host state, operational navigation, plugin management, live appearance updates, and explicit package lifecycle operations.

## Build Under Test

- Running deterministic browser preview: `http://127.0.0.1:4176/?runtimeOrigin=http%3A%2F%2F127.0.0.1%3A53089`
- Deterministic restart command: `npm run acceptance:sprint6`; profile data is retained under `.infolens-acceptance/sprint6/`.
- Electron acceptance command: `npm run acceptance:sprint6:electron`; use this for the native folder picker, clipboard, and Runtime-process recovery checks.
- Compatible installation fixture: `D:\Infolens\tests\fixtures\sprint6\installable-plugin`
- Automated suite: `npm run test:sprint6`
- Sprint 6 is intentionally uncommitted until explicit user acceptance.

## Delivered Work Items

| Work item | Delivered feature | Primary location |
| --- | --- | --- |
| Atomic host state | Versioned JSON state with serialized temporary-write-and-rename persistence for enabled IDs, last selection, theme, and bounded status snapshots | `packages/plugin-runtime/src/host-state.mjs` |
| Lifecycle navigation | Compatible packages remain visible with running, refreshing, failed, unavailable, or disabled status plus opaque badges and restored available selection | `apps/desktop/src/App.tsx` |
| Host operational states | First-run browser dependency check, plugin-scoped status, host unavailable state, Runtime restarting bar, automatic Runtime recovery, and workspace reload | Desktop renderer, main process, and Runtime status APIs |
| Plugin Manager | Compatible/rejected lists, exact compatibility detail, enabled toggle, package details, refresh/failure snapshots, diagnostics copy, and confirmed removal | Desktop renderer and Runtime management routes |
| Local installation | Native folder selection, compatibility validation before copy, managed-directory copy, duplicate-ID rejection, immediate enablement, and activation | `apps/desktop/main.cjs`, `apps/desktop/preload.cjs`, Runtime server |
| Complete removal | Task cancellation, module cleanup, route removal, exact package/data/log deletion, status cleanup, and Electron Runtime-restart fallback for cleanup timeout | Runtime server and Electron main process |
| Theme preference | Persisted system/light/dark setting, shell updates, initial iframe query, and live `postMessage` updates without iframe reload | Desktop settings, Plugin SDK, and four bundled workspaces |
| Sprint verification | Runtime integration coverage, compatible/rejected fixtures, deterministic browser/Electron launchers, and isolated acceptance profile | `tests/sprint6-host-operations.test.mjs`, `tests/fixtures/sprint6/`, `scripts/*sprint6*` |

## Engineering Checks

| Check | Result |
| --- | --- |
| `npm run typecheck` | Passed: desktop renderer and Plugin SDK declarations |
| `npm run build` | Passed: production renderer build, 1,646 modules transformed |
| `npm run test:sprint6` | Passed: 3 host-state, package lifecycle, diagnostics, theme convention, and bounded-removal tests |
| `npm test` | Passed: all 23 Sprint 1-6 tests |
| Deterministic acceptance HTTP smoke | Passed: Runtime ready with 4 compatible packages, 1 precisely rejected package, host state, and Runtime-served theme assets |
| Browser-controlled visual QA | Blocked: the Browser runtime reported no available browser bindings after setup and troubleshooting discovery |
| Electron interactive acceptance | Passed: user accepted the Sprint 6 increment and requested commit |
| `git diff --check` | Passed |

## Acceptance Checklist

| # | Sprint work item and acceptance criterion | User action and expected evidence | Result |
| --- | --- | --- | --- |
| 1 | Navigation shows every compatible package with lifecycle state and opaque badge. | Open the build. Confirm the four official sources appear, status is expressed by icon, and Hacker News' badge is displayed without a host-defined label. Refresh a source and observe queued/refreshing state. | Passed |
| 2 | Last available selection and theme survive restart. | Select GitHub Trending, choose Dark in Settings, stop and rerun the build. GitHub Trending is selected and the shell opens in dark theme. | Passed |
| 3 | An open bundled workspace changes theme without reload. | Open Hacker News, note retained rows, then change Light/Dark in Settings and return. The workspace uses the selected theme and retained state remains in place. | Passed |
| 4 | First-run browser status identifies only browser-dependent plugins. | On launch, inspect Browser connection. It names Zhihu and Product Hunt as affected and does not imply Hacker News or GitHub Trending are blocked. Check again and Continue both work. | Passed |
| 5 | Compatible local installation is copied, enabled, and activated. | In the Electron build select Install plugin and choose `tests/fixtures/sprint6/installable-plugin`. Reading Notes appears enabled in navigation and opens its Runtime-hosted workspace. | Passed |
| 6 | Duplicate IDs are rejected before copy. | Select the same installation fixture again. The error says the installed plugin must be removed first; the existing Reading Notes package remains operational and no second package appears. | Passed |
| 7 | Rejected packages remain only in Plugin Manager with the exact reason. | Open Plugins and select Future Reader. It is absent from source navigation and shows `INCOMPATIBLE_CONTRACT` with the supported-contract explanation. | Passed |
| 8 | Enablement is persistent and plugin-local. | Disable one plugin in Plugins and restart. It remains in navigation as disabled, does not activate, and its siblings remain usable. Re-enable it and open its workspace. | Passed |
| 9 | Diagnostics are bounded, operational, and redacted. | Select an installed plugin and Copy diagnostics. Paste locally; the report contains plugin identity, status snapshot, and recent logs but no retained source rows, cookies, authentication data, or browser profile paths. | Passed |
| 10 | Confirmed removal deletes the exact package, retained data, settings, and logs. | Remove Reading Notes, first cancelling once and then confirming. It disappears from navigation and Plugins. Verify `.infolens-acceptance/sprint6/plugins/reading-notes` and its data directory no longer exist. | Passed |
| 11 | Runtime recovery keeps the host operational. | In the Electron build terminate its Plugin Runtime child process. The navigation remains visible, a non-modal restarting bar appears, services restart, enabled plugins reactivate, and the selected workspace reloads. | Passed |
| 12 | Host unavailable and minimum viewport states remain usable. | At 1024 x 700, inspect Plugins, Settings, both dialogs, a disabled workspace, and the Runtime-restarting bar. Text and actions do not overlap; keyboard focus is visible and Escape closes dialogs. | Passed |
| 13 | Earlier sprint behavior remains intact. | Run `npm test`, `npm run typecheck`, and `npm run build`; all complete successfully. | Passed |

## Scope Notes

- User disablement and internal Runtime deactivation remain distinct: disabled packages stay visible in host navigation, while Sprint 5's internal deactivation contract unregisters the module from Runtime output.
- Removal normally completes inside Runtime. If cleanup exceeds the grace period, Runtime refuses deletion with `RUNTIME_RESTART_REQUIRED`; Electron stops Runtime, validates managed paths, deletes only that package and data directory, updates host state atomically, and restarts Runtime.
- Browser preview installation uses a path prompt because browsers cannot open Electron's native folder picker. Native installation acceptance must use `npm run acceptance:sprint6:electron`.
- The deterministic rejected package and installable package contain no authentication material or source records.

## Acceptance Record

- Tester: User
- Date: 2026-07-29
- Result: Accepted
- Notes: User explicitly requested that Sprint 6 be committed after implementation and verification.
