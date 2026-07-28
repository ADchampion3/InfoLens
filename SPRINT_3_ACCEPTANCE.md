# Sprint 3 User Acceptance

## Phase

Sprint 3: Public Plugins and Persistence

**Outcome:** Complete the `PUBLIC` strategy slice with two independently persisted, user-visible plugin workspaces.

## Build Under Test

- Live browser-preview URL: `http://127.0.0.1:4174/?runtimeOrigin=http%3A%2F%2F127.0.0.1%3A49241`
- Live restart command: `npm run live:sprint3`; it uses the pinned official OpenCLI distribution and retains data under `.infolens-live/sprint3/`.
- Deterministic restart command: `npm run acceptance:sprint3`; it uses controlled fixture output for repeatable persistence and failure-path acceptance and retains data under `.infolens-acceptance/sprint3/`.
- Each launcher writes its current browser URL to its profile's `url.txt`.
- Automated suite: `npm run test:sprint3`
- The Sprint 3 worktree is intentionally uncommitted until user acceptance.

## Delivered Work Items

| Work item | Delivered feature | Primary location |
| --- | --- | --- |
| Hacker News public collection | Removed retained code fixtures; validates the native row array returned by official `opencli hackernews top -f json` | `plugins/hn/backend/index.js`, `plugins/hn/manifest.json` |
| Native Hacker News job rows | Treats the official adapter's omitted or null `comments` field as zero without weakening validation of other fields | `plugins/hn/backend/index.js`, `tests/sprint3-public-plugins.test.mjs` |
| Hacker News persistence | Plugin-owned SQLite migration, story projection, snapshots, settings, metadata, and durable read state | `plugins/hn/backend/storage.js` |
| Hacker News workspace | Dense ranked rows, source/discussion actions, read styling, manual refresh, retained failure banner, empty state, and settings sheet | `plugins/hn/web/dist/` |
| GitHub Trending package | Complete package validating the native row array returned by official `opencli github-trending repos -f json` | `plugins/github-trending/` |
| GitHub persistence and filters | Independent SQLite migration, repository projection, snapshots, refresh/view settings, read state, period, and language filters | `plugins/github-trending/backend/` |
| GitHub workspace | Compact repository list with description, language swatch, stars, forks, gained stars, filters, external action, and settings sheet | `plugins/github-trending/web/dist/` |
| Plugin-local refresh policy | Manual-only default plus disabled and fixed intervals; settings and schedules are independently owned and restored | Both plugin backends and workspaces |
| Retained failure handling | Malformed results and source-process failures preserve the last successful transaction and expose source-local warnings | Both plugin backends and storage modules |
| Official bundled OpenCLI | Pins `@jackwener/opencli@1.8.6` with lockfile integrity, verifies package identity at startup, and launches its application-local `dist/src/main.js`; no Infolens collector or scraper remains | `resources/opencli/`, `packages/plugin-runtime/src/opencli-adapter.mjs` |
| Runtime restart cleanup | Graceful Runtime shutdown now exits after server, task, schedule, plugin, database, and log cleanup | `packages/plugin-runtime/src/server.mjs` |
| Deterministic acceptance profile | Starts the real Runtime and host renderer with mock public-source output and retained local databases | `scripts/acceptance-sprint3.mjs` |
| Live-source preview profile | Starts the real Runtime, pinned OpenCLI distribution, and host renderer without fixture overrides | `scripts/live-sprint3.mjs` |
| Automated integration matrix | Mock OpenCLI, migrations, validation, independent stores/settings, refresh, read state, restart, malformed output, and failed-source preservation | `tests/sprint3-public-plugins.test.mjs`, `tests/fixtures/sprint3/` |

## Engineering Checks

| Check | Result |
| --- | --- |
| `npm run typecheck` | Passed: desktop renderer and SDK declarations |
| `npm run build` | Passed: production renderer build |
| `npm run test:sprint1` | Passed: host/Runtime/Hacker News walking-skeleton regression |
| `npm run test:sprint2` | Passed: 2 SDK and actual-Runtime contract tests |
| `npm run test:sprint3` | Passed: 4 official-distribution, native-row regression, persistence, and actual-Runtime integration tests |
| `npm run install:opencli` | Passed: pinned local OpenCLI dependency installed, 0 vulnerabilities |
| Official OpenCLI package identity | Passed: Runtime resolved `@jackwener/opencli@1.8.6`; packaged `hackernews/top` and `github-trending/repos` adapters both declare read-only `PUBLIC` |
| Runtime command vectors | Passed: actual Runtime issued only `hackernews top --limit=30 -f json` and `github-trending repos --since=daily --limit=25 -f json` |
| Infolens collector scan | Passed: no direct source fetch or HTML parser remains outside the official dependency |
| Workspace JavaScript syntax | Passed for Hacker News, GitHub Trending, and acceptance launcher |
| Acceptance HTTP build | Passed: host renderer responds at the Build Under Test URL |
| Browser-controlled visual QA | Not run: no in-app or Chrome browser binding was available in this environment |
| Integrated live Hacker News refresh | Passed through Runtime HTTP: 30 current stories persisted; a real job row without comments normalized to zero |
| Integrated live GitHub Trending refresh | Passed through Runtime HTTP: 15 current repositories persisted |
| `git diff --check` | Passed |

## Acceptance Checklist

| # | Sprint work item and acceptance criterion | User action and expected evidence | Result |
| --- | --- | --- | --- |
| 1 | Hacker News `PUBLIC` flow: refresh invokes only official `hackernews top`, accepts native job rows whose comments field is omitted/null as zero, writes its SQLite store/snapshot, and renders at least 15 source-specific rows. | Start `npm run live:sprint3`, open Hacker News, and click Refresh. Existing rows remain visible while the icon spins; completion shows current ranked titles, domain where present, points, author, comments (including zero), and read state. | Passed |
| 2 | Hacker News actions and read state: source title and discussion actions navigate externally; selected stories become visibly read and persist. | Select a story title, return, select a comment count, then restart `npm run acceptance:sprint3`. The story remains reduced in emphasis. | Passed |
| 3 | GitHub Trending complete `PUBLIC` plugin: refresh invokes only official `github-trending repos`, validates its native output, persists it, and displays at least 12 repositories. | In the live preview, select GitHub Trending and click Refresh. Confirm current compact rows include owner/repository, descriptions, language swatches or missing language, total stars, forks, gained stars, and external navigation. | Passed |
| 4 | GitHub filters: period and language are plugin-owned and supplied to its declared collection command. | Change period and language, refresh, switch to Hacker News and back. The selected GitHub controls remain unchanged. | Passed |
| 5 | Independent SQLite persistence: each plugin keeps source records, snapshots, settings, and read state in a separate database. | Mark one item read in each plugin, use different refresh policies, stop and restart the acceptance command. Both retained lists appear immediately with their own state. | Passed |
| 6 | Manual-only default: a new plugin profile does not collect merely because its workspace or settings sheet opens. | On a fresh acceptance profile, open each settings sheet before refreshing. `仅手动` is selected and opening/canceling causes no refresh. | Passed |
| 7 | Disabled policy: disabling refresh survives restart and does not affect the sibling plugin. | Set Hacker News to `停用刷新`, save, and restart. Its refresh control remains disabled while GitHub can still refresh. | Passed |
| 8 | Fixed-interval policy: supported intervals are saved, scheduled by Runtime, restored after restart, and remain plugin-local. | Set Hacker News to every 6 hours and GitHub to every 12 hours, restart, then reopen both sheets. Each retains its own selection. | Passed |
| 9 | Failed refresh preservation: malformed output or a failed command never replaces the latest successful records and produces source-local feedback. | Start the deterministic `npm run acceptance:sprint3` profile. With retained content visible, set `hn` to `malformed` or `github` to `exit` in `.infolens-acceptance/sprint3/opencli-state.json`, then refresh that plugin. Its rows remain and a compact warning with Retry appears; its sibling remains usable. | Passed |
| 10 | Migration, native-row normalization, and retained restart behavior: schema version 1 is idempotent and both workspaces reopen without waiting for collection. | Run `npm run test:sprint3`; all four tests pass, including official package verification, omitted-comments normalization, migration reopen, snapshot count, actual Runtime restart, and retained reads. | Passed |
| 11 | Minimum viewport and accessibility: no overlap occurs at 1024 x 700; controls remain keyboard reachable with visible focus and accessible icon names. | Resize the browser to 1024 x 700. Tab through header, filters, rows, and settings; press Escape in the sheet. Text and controls remain readable and the sheet closes with focus returned. | Passed |
| 12 | Integrated host assembly: both packages are discovered together and can be switched without host-owned business rendering or loading reset. | Use the left navigation to switch Hacker News → GitHub Trending → Hacker News. The host stays stable and retained plugin content reappears without collection. | Passed |
| 13 | Earlier contracts remain intact and production build succeeds. | Run `npm run typecheck`, `npm run build`, `npm run test:sprint1`, and `npm run test:sprint2`; all complete successfully. | Passed |

## Scope Notes

- The production distribution is the pinned official `@jackwener/opencli` package. `live:sprint3` uses that distribution with real sources. Automated tests and `acceptance:sprint3` use a deterministic executable through the same application-local process boundary for repeatable failure testing; fixture output is not claimed as live-source verification.
- Official OpenCLI `hackernews top` does not expose story publication time in its JSON schema. The workspace does not fabricate an age value; adding source age requires an upstream OpenCLI schema enhancement rather than an Infolens-side fetch.
- Cross-plugin permit pools and shared queue limits remain Sprint 5 work. Sprint 3 uses the Runtime-owned per-plugin task/schedule APIs delivered in Sprint 2.
- Host-level persistence, lifecycle badges, theming, and Plugin Manager behavior remain Sprint 6 work.
- No host-owned feed, shared source schema, or global refresh setting was introduced.

## Acceptance Record

- Tester: User
- Date: 2026-07-28
- Result: Accepted
- Notes: User explicitly requested the Sprint 3 changes be committed after the live-refresh correction and verification.
