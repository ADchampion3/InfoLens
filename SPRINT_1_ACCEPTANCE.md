# Sprint 1 User Acceptance

## Phase

Sprint 1: Walking Skeleton

## Build Under Test

- Host preview: `http://127.0.0.1:43100/?runtimeOrigin=http://127.0.0.1:43110`
- Desktop command: `npm start`
- Runtime health: `http://127.0.0.1:43110/runtime/health`

## Delivered Work Items

| Work item | Delivered feature | Primary location |
| --- | --- | --- |
| Electron desktop host | Main process, secure preload bridge, 1440 x 900 default window, 1024 x 700 minimum window, and Runtime lifecycle ownership | `apps/desktop/main.cjs`, `apps/desktop/preload.cjs` |
| Host renderer | React/Vite application shell with persistent Chinese-first navigation, loading/error states, plugin selection, lifecycle indicator, and badge rendering | `apps/desktop/src/App.tsx`, `apps/desktop/src/styles.css` |
| Shared Plugin Runtime | Node child process that discovers packages, activates backends, exposes health/API routes, serves static workspaces, reports readiness, and shuts down with the host | `packages/plugin-runtime/src/server.mjs` |
| Packaged Hacker News plugin | Manifest, backend activation, health badge, scoped summary API, and static workspace bundle | `plugins/hn/` |
| Hacker News workspace | Prototype-aligned retained story list with 15 Chinese stories, ranks, source domains, points, author, age, read state, and comment counts | `plugins/hn/web/dist/` |
| Runtime configuration | Iframe query configuration for `pluginId` and `apiBaseUrl`; workspace reads only its own same-origin API | `apps/desktop/src/App.tsx`, `plugins/hn/web/dist/workspace.js` |
| Build and test tooling | Development launcher, production renderer build, TypeScript check, and end-to-end Runtime smoke test | `scripts/dev.mjs`, `tests/sprint1-smoke.test.mjs` |

## Engineering Checks

| Check | Result |
| --- | --- |
| TypeScript type-check | Passed |
| Production renderer build | Passed |
| Runtime-to-plugin smoke test | Passed |
| Host preview response | Passed |
| Plugin workspace response | Passed |
| Same-origin plugin API response | Passed, 15 retained stories |
| Dependency security audit | Not run: npm registry audit endpoint unavailable in the restricted environment |

## Acceptance Checklist

| # | Work item and acceptance criterion | User test and expected evidence | Result |
| --- | --- | --- | --- |
| 1 | Electron host and Runtime startup: the desktop host launches the shared Runtime and renders a stable loading or failure state if startup is delayed or fails. | Run `npm start`. The Infolens window opens into the normal shell with no blank main area. | Passed |
| 2 | Plugin discovery and activation: the Hacker News package is found from `plugins/`, activated, and represented in host navigation. | Confirm `Hacker News` is selected in the left navigation, has the `Y` source mark, the `8` badge, and a running-state dot. | Passed |
| 3 | Runtime delivery: health, workspace, and API routes are scoped under the plugin Runtime. | Open the runtime health URL. It returns a running Runtime response; opening the workspace URL from runtime metadata returns the Hacker News page. | Passed |
| 4 | Iframe and API boundary: the host contains the workspace while the plugin reads its own same-origin API. | Confirm Hacker News renders in the main area without a separate window or visible host frame; 15 API-backed retained stories appear. | Passed |
| 5 | Prototype-aligned workspace: the Sprint 1 host and Hacker News content follow the approved desktop prototype. | Confirm the neutral shell, 56 px workspace header, compact navigation, ranked serif story titles, Chinese metadata, read-state emphasis, and comment counts. | Passed |
| 6 | Responsive desktop layout: the shell works at the MVP's minimum supported size. | Resize the desktop window to 1024 x 700. Navigation, header, and story rows remain readable with no overlap, clipping, or horizontal page scroll. | Passed |
| 7 | Runtime shutdown: closing the main window stops the child Runtime. | Close the Electron window. The application exits; no Infolens Runtime process remains. | Passed |
| 8 | Engineering regression coverage: the integrated vertical slice remains buildable and testable. | Run `npm run typecheck`, `npm run build`, and `npm run test:sprint1`; all three commands pass. | Passed |

## Acceptance Record

- Tester: User
- Date: 2026-07-24
- Result: Accepted
- Notes: User authorized the Sprint 1 outcome commit.

Sprint 1 was accepted by the user before its Git commit was created.
