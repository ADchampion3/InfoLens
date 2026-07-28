# Sprint 4 User Acceptance

## Phase

Sprint 4: Browser-Backed Collection

**Outcome:** Complete the `COOKIE` strategy slice with a persisted Zhihu Hot List workspace and plugin-local Browser Bridge degradation.

## Build Under Test

- Deterministic browser-preview URL: `http://127.0.0.1:4175/?runtimeOrigin=http%3A%2F%2F127.0.0.1%3A57763`
- Deterministic restart command: `npm run acceptance:sprint4`; data is retained under `.infolens-acceptance/sprint4/`.
- Live-source command: `npm run live:sprint4`; data is retained under `.infolens-live/sprint4/` and the current URL is written to that profile's `url.txt`.
- Automated suite: `npm run test:sprint4`
- The Sprint 4 worktree is intentionally uncommitted until user acceptance.

The deterministic profile reads `.infolens-acceptance/sprint4/opencli-state.json`. Set `zhihu` to `success`, `disconnected`, `expired`, or `malformed`, then select Refresh in Zhihu to exercise that state.

## Delivered Work Items

| Work item | Delivered feature | Primary location |
| --- | --- | --- |
| Zhihu `COOKIE` package | Declared read-only `zhihu whoami` authentication check followed by `zhihu hot`, strict native-row validation, collection task, plugin-scoped routes, and package metadata | `plugins/zhihu-hot/manifest.json`, `plugins/zhihu-hot/backend/index.js` |
| Independent persistence | Schema migration, ranked questions, snapshots, retained read state, refresh settings, metadata, and transactional replacement in a plugin-owned SQLite database | `plugins/zhihu-hot/backend/storage.js` |
| Ranked Chinese workspace | Dense Chinese title scanning, rank/heat/answer metadata, external question actions, read styling, refresh, failure warning, settings sheet, and responsive layout | `plugins/zhihu-hot/web/dist/` |
| Dependency recovery | Distinct Browser Bridge disconnected and Zhihu login-required states, each with retry and a source-appropriate recovery action | Zhihu backend and workspace |
| Refresh reconciliation fix | Every bundled workspace reloads its canonical committed summary after refresh and surfaces request failures instead of silently rerendering stale state | All three `web/dist/workspace.js` files |
| Host lifecycle state | Dynamic Runtime-info polling and concise unavailable/failed/refreshing navigation signals without browser implementation details | `apps/desktop/main.cjs`, `apps/desktop/src/App.tsx` |
| Safe diagnostics | Central recursive redaction for authentication fields and local Chrome-profile paths; classified OpenCLI errors expose safe codes/messages | `packages/plugin-runtime/src/redaction.mjs`, logger and OpenCLI adapter |
| Official OpenCLI commands | Bundled allowlist includes the pinned distribution's official `zhihu whoami` authentication adapter and `zhihu hot` collection adapter | `resources/opencli/runtime.json` |
| Credential-free test profile | Actual Runtime fixture with success, bridge-disconnected, expired-login, and malformed modes; it contains no credentials or browser-session artifacts | `tests/fixtures/sprint4/`, `tests/sprint4-browser-collection.test.mjs` |
| Developer prerequisite | Browser Bridge installation, authenticated-profile prerequisite, real-source procedure, restart check, and degradation procedure | `docs/sprint4-browser-prerequisite.md` |

## Engineering Checks

| Check | Result |
| --- | --- |
| `npm install --ignore-scripts` | Passed: workspace lock updated, 0 vulnerabilities |
| `npm run typecheck` | Passed: desktop renderer and SDK declarations |
| `npm run build` | Passed: production renderer build, 1,646 modules transformed |
| Workspace and launcher syntax checks | Passed |
| `npm run test:sprint1` | Passed: 1 walking-skeleton regression test |
| `npm run test:sprint2` | Passed: 2 SDK/Runtime contract tests |
| `npm run test:sprint3` | Passed: 4 public-plugin persistence/integration tests |
| `npm run test:sprint4` | Passed: 8 official-adapter/auth, migration, redaction, actual-Runtime, recovery, workspace-reconciliation, bare-Vite-root, isolation, restart, and fixture-safety tests |
| Live preview Runtime JSON fallback | Passed: bare `http://127.0.0.1:4176/` resolves `/runtime-info.json` through Vite to the actual Runtime instead of returning `index.html` |
| Deterministic acceptance HTTP smoke | Passed: all three plugins active; Zhihu success/disconnected/expired/recovery states exercised through scoped API |
| Generated Zhihu log inspection | Passed: safe command keys and error codes only; no source records or authentication/browser-session material |
| Browser-controlled visual QA | Not run: the in-app browser runtime reported no available browser binding |
| Real-source Zhihu collection | Not run: this environment has no connected Browser Bridge/authenticated Zhihu browser session; user procedure is documented |
| `git diff --check` | Passed |

## Acceptance Checklist

| # | Sprint work item and acceptance criterion | User action and expected evidence | Result |
| --- | --- | --- | --- |
| 1 | Zhihu uses only its declared official `COOKIE` mappings and renders ranked retained content. | Run `npm run live:sprint4` with Browser Bridge connected and Zhihu logged in. Select Zhihu and Refresh; `whoami` verifies login before `hot`, at least 12 current questions render, and any prior failure prompt disappears. | Passed |
| 2 | Zhihu persists independently and reopens without collection. | Stop and restart the live command. Select Zhihu before refreshing; the previous questions appear immediately and a read row remains reduced in emphasis. | Passed |
| 3 | Browser Bridge disconnection affects only Zhihu. | In the deterministic profile set `zhihu` to `disconnected` and Refresh. Zhihu shows connection recovery and Check connection; navigation shows only a concise unavailable signal. Hacker News and GitHub Trending still open normally. | Passed |
| 4 | Expired Zhihu login is distinct from bridge disconnection. | Set `zhihu` to `expired` and Refresh. The official `auth.js`/`whoami` check reports login required, the workspace offers Open Zhihu, and prior rows remain stored. | Passed |
| 5 | Dependency recovery works in place. | Set `zhihu` back to `success` and choose Check connection. Ranked content returns and the host unavailable signal clears without restarting Runtime. | Passed |
| 6 | Failed/malformed collection preserves the latest successful snapshot. | With retained content present, set `zhihu` to `malformed` and Refresh. The last list remains stored, and source-local failure feedback is shown without affecting siblings. | Passed |
| 7 | Refresh settings are plugin-owned. | Save different policies for Zhihu, Hacker News, and GitHub Trending; restart the profile. Each workspace retains its own setting and disabled Zhihu refresh does not disable another plugin. | Passed |
| 8 | Diagnostics and fixtures contain no sensitive browser material. | Run `npm run test:sprint4`; all eight tests pass, including recursive redaction and fixture scans. Inspect `.infolens-acceptance/sprint4/data/zhihu-hot/logs/plugin.log`; it contains no source records, credentials, Chrome paths, or session data. | Passed |
| 9 | Minimum viewport and keyboard behavior remain usable. | Resize to 1024 x 700. Tab through refresh, settings, rows, and recovery actions; open/close the sheet with keyboard and Escape. No text or controls overlap. | Passed |
| 10 | Earlier contracts and production assembly remain intact. | Run `npm run typecheck`, `npm run build`, and `npm run test:sprint1` through `npm run test:sprint3`; all pass. Opening the live preview root must resolve Runtime JSON rather than Vite HTML. | Passed |

## Scope Notes

- The official adapter returns rank, title, heat, answer count, and URL. It does not return excerpt or thumbnail fields, so the workspace supports those optional fields without fabricating them.
- Dependency detection stays behind the declared OpenCLI CLI-process boundary. Neither host nor workspace accesses cookies, Chrome profiles, daemon ports, or Browser Bridge session data.
- Sprint 4 classifies known OpenCLI bridge/auth failures through `whoami`. Empty or malformed hot-list results remain ordinary retained-content failures.
- Cross-plugin browser permit serialization remains Sprint 5 work. Host state persistence, first-run setup, and Plugin Manager diagnostics remain Sprint 6 work.
- Real `COOKIE` execution requires user-controlled Browser Bridge and login state. Deterministic tests are integration evidence, not real-source evidence; final release evidence remains Sprint 8 scope.

## Acceptance Record

- Tester: User
- Date: 2026-07-28
- Result: Accepted
- Notes: User explicitly requested the Sprint 4 servers be closed and the accepted Sprint 4 increment committed after refresh recovery, OpenCLI `whoami` authentication, and live preview Runtime JSON routing fixes.
