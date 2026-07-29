# Sprint 5 User Acceptance

## Phase

Sprint 5: Intercept and Scheduling

**Outcome:** Complete the `INTERCEPT` strategy slice with a persisted Product Hunt workspace and Runtime-owned cross-plugin scheduling.

## Build Under Test

- Deterministic browser-preview URL: `http://127.0.0.1:4175/?runtimeOrigin=http%3A%2F%2F127.0.0.1%3A54873`
- Deterministic restart command: `npm run acceptance:sprint5`; data is retained under `.infolens-acceptance/sprint5/`.
- Live-source command: `npm run live:sprint5`; data is retained under `.infolens-live/sprint5/` and the current URL is written to that profile's `url.txt`.
- Automated suite: `npm run test:sprint5`
- The Sprint 5 worktree is intentionally uncommitted until user acceptance.

The deterministic profile reads `.infolens-acceptance/sprint5/opencli-state.json`. Set `producthunt` to `success`, `disconnected`, or `malformed`, then select Refresh in Product Hunt to exercise that state.

## Delivered Work Items

| Work item | Delivered feature | Primary location |
| --- | --- | --- |
| Product Hunt `INTERCEPT` package | Official read-only `producthunt hot` mapping, strict native-row validation, collection task, scoped routes, and package metadata | `plugins/product-hunt/manifest.json`, `plugins/product-hunt/backend/index.js` |
| Independent persistence | Schema migration, ranked launches, snapshots, retained read state, refresh settings, dependency metadata, and transactional replacement | `plugins/product-hunt/backend/storage.js` |
| Ranked product workspace | Dense launch ranking, vote counts, external product actions, read styling, retained failure state, Browser Bridge recovery, refresh, and settings | `plugins/product-hunt/web/dist/` |
| Shared Runtime queue | Three `PUBLIC` permits, one combined `COOKIE`/`INTERCEPT` permit, per-plugin active tracking, FIFO queueing, and resource snapshots | `packages/plugin-runtime/src/task-manager.mjs` |
| Coalescing and lifecycle | Duplicate refresh promise coalescing plus queued, started, completed, failed, and cancelled status events | Runtime task manager and server |
| Runtime-owned schedules | Existing plugin-local policies register timers with the shared queue; scheduled/manual collisions use the same coalescing key | Runtime task manager and bundled backends |
| Cancellation and removal boundary | Shutdown and Runtime deactivation cancel queued/active work, stop timers, release permits, clean up routes, and report uncertain interrupted outcomes | `packages/plugin-runtime/src/server.mjs` |
| Controlled process tests | Permit limits, serial browser work, coalescing, scheduling, queued/active cancellation, uncertain outcomes, removal, and sibling isolation | `tests/sprint5-intercept-scheduling.test.mjs`, `tests/fixtures/sprint5/` |
| Acceptance launchers | Deterministic four-plugin preview and real bundled-OpenCLI preview | `scripts/acceptance-sprint5.mjs`, `scripts/live-sprint5.mjs` |

## Engineering Checks

| Check | Result |
| --- | --- |
| `npm install --ignore-scripts` | Passed: Product Hunt workspace registered, 97 packages audited, 0 vulnerabilities |
| `npm run typecheck` | Passed: desktop renderer and SDK declarations |
| `npm run build` | Passed: production renderer build, 1,646 modules transformed |
| `npm run test:sprint1` | Passed: 1 walking-skeleton regression test |
| `npm run test:sprint2` | Passed: 2 SDK/Runtime contract tests |
| `npm run test:sprint3` | Passed: 4 public-plugin persistence/integration tests |
| `npm run test:sprint4` | Passed: 8 browser-backed collection and regression tests; Vite test required approved temp-file access |
| `npm run test:sprint5` | Passed: 5 permit, coalescing, scheduling, cancellation, isolation, Product Hunt persistence, browser serialization, and Runtime deactivation tests |
| Deterministic acceptance HTTP smoke | Passed: all four plugins `ready`; Product Hunt retained 12 ranked launches |
| Browser-controlled visual QA | Blocked: the in-app browser runtime reported no available browser bindings |
| Real-source Product Hunt collection | Not run: this environment has no connected Browser Bridge; user procedure is documented |
| `git diff --check` | Passed |

## Acceptance Checklist

| # | Sprint work item and acceptance criterion | User action and expected evidence | Result |
| --- | --- | --- | --- |
| 1 | Product Hunt uses its declared official `INTERCEPT` mapping and displays ranked retained products. | Run `npm run live:sprint5` with Browser Bridge connected. Select Product Hunt and Refresh; current launches render in rank order with vote counts and product links. | Passed |
| 2 | Product Hunt persists independently. | Open one launch, stop and restart the live command, then select Product Hunt before refreshing. The prior ranking appears immediately and the opened row remains reduced in emphasis. | Passed |
| 3 | Browser-backed work is globally serial. | In the deterministic build, trigger Product Hunt and Zhihu refreshes together. Both complete, navigation shows queued/refreshing state, and `npm run test:sprint5` confirms browser concurrency never exceeds one. | Passed |
| 4 | Public work uses a separate bounded pool. | Run `npm run test:sprint5`; the controlled queue reaches three concurrent `PUBLIC` tasks but never four, while browser work can proceed independently. | Passed |
| 5 | A plugin has one active task and duplicates coalesce. | Select Refresh repeatedly while Product Hunt is queued or running. The control stays busy, one source request occurs, and Runtime emits `task-coalesced` for duplicate API triggers. | Passed |
| 6 | Plugin schedules and workspace refresh use the shared queue. | Save a fixed refresh interval, then run `npm run test:sprint5`; scheduled work emits the same queue lifecycle events and coalesces with matching refresh work. | Passed |
| 7 | Shutdown and deactivation cancel work and future schedules. | Run `npm run test:sprint5`; active work reports an uncertain cancelled outcome, queued work reports not-started, permits return to zero, and Runtime deactivation unregisters Product Hunt. | Passed |
| 8 | Failures remain plugin-local and release permits. | Set deterministic `producthunt` to `malformed` and Refresh. Product Hunt retains its last list and warning; Hacker News, GitHub Trending, and Zhihu remain usable. | Passed |
| 9 | Browser disconnection remains plugin-local. | Set deterministic `producthunt` to `disconnected` and Refresh. Product Hunt shows connection guidance while its siblings remain usable; set it back to `success` and retry to recover in place. | Passed |
| 10 | Minimum viewport and keyboard behavior remain usable. | At 1024 x 700, tab through refresh, launch links, recovery, and settings; close settings with Escape. No controls or text overlap. | Passed |
| 11 | Earlier contracts and production assembly remain intact. | Run typecheck, build, and Sprint 1 through Sprint 4 tests; all pass. | Passed |

## Scope Notes

- Resource class is derived conservatively from each validated manifest: a package is `PUBLIC` only when all its mappings are `PUBLIC`; any `COOKIE` or `INTERCEPT` mapping uses the combined browser permit.
- Runtime deactivation unregisters an active module and stops its work. Package/data deletion and the user-facing Plugin Manager remain Sprint 6 scope.
- Active child-process cancellation is reported as `outcome: uncertain`; Runtime does not claim whether a remote source observed partially completed activity.
- Deterministic OpenCLI fixtures contain no credentials or browser-session material and do not satisfy the Sprint 8 real-source release gate.

## Acceptance Record

- Tester: User
- Date: 2026-07-29
- Result: Accepted
- Notes: User explicitly requested that Sprint 5 be committed after the Product Hunt live-source capture-wait defect was diagnosed and fixed in the bundled OpenCLI adapter.
