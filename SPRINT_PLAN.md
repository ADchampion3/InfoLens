# Infolens MVP Sprint Plan

## Planning Assumptions

- Sprints are two weeks long and begin on July 20, 2026.
- The schedule is scope-based. Team capacity may change how much fits in a sprint without changing the integration gates.
- A feature is not complete until it works through the Electron host, shared Plugin Runtime, and relevant plugin workspace.

## Sprint Schedule

### Sprint 1: Walking Skeleton

**Dates:** July 20-31, 2026

**Outcome:** Deliver the first runnable vertical slice.

**Work items included in acceptance:**

- Create the Electron main process, secure preload bridge, React/Vite renderer, and development/build scripts.
- Create the shared Runtime child process with plugin discovery, backend activation, static workspace serving, scoped API routing, health endpoint, and graceful shutdown.
- Package the Hacker News plugin as `manifest.json`, `backend/index.js`, and `web/dist`.
- Build the host navigation shell and Hacker News retained-content workspace from the approved frontend prototype.
- Add an automated host-to-runtime-to-workspace smoke test and a Sprint 1 acceptance checklist.

**Acceptance criteria:**

- The Electron host launches the shared Plugin Runtime and shows its loading or failure state when startup is delayed or fails.
- The Hacker News package is discovered, activated, and shown as a running plugin in persistent navigation.
- The plugin health endpoint, static workspace, and API route are served from Runtime; the workspace renders retained API content inside the host iframe.
- The workspace calls only its own same-origin API path and does not depend on a host business API.
- The shell and workspace match the approved prototype's desktop layout at 1440 x 900 and remain usable at 1024 x 700.
- Closing the main window stops the shared runtime.
- `typecheck`, production build, and the automated end-to-end smoke test pass.

### Sprint 2: Runtime and SDK Contract

**Dates:** August 3-14, 2026

**Outcome:** Establish the stable plugin execution foundation.

**Work items included in acceptance:**

- Create `@infolens/plugin-sdk` with typed manifests, backend activation context, health and workspace URL helpers, plugin data-directory access, scoped logger, task registration, scheduling, and OpenCLI invocation helpers.
- Add manifest, semantic-version, command-availability, read-access, JSON-output, and strategy validation to Runtime discovery and installation paths.
- Implement plugin-scoped lifecycle error boundaries, structured status events, rotating plugin logs, and cleanup hooks.
- Implement task coalescing and the bounded command adapter for the bundled OpenCLI runtime.
- Add contract fixtures for valid, structurally invalid, version-incompatible, unsupported-strategy, and unavailable-command packages.

**Acceptance criteria:**

- A plugin backend receives the documented SDK context and can register routes, tasks, schedules, logs, data access, and only declared OpenCLI commands.
- Invalid package structures, contract versions, host versions, OpenCLI ranges, non-read commands, non-JSON commands, unavailable commands, and `UI` strategies are rejected with precise reasons.
- A route, task, activation, or cleanup failure marks only the offending plugin failed; a healthy sibling stays usable.
- Repeated requests for the same plugin refresh coalesce into one task.
- Runtime launches the application-bundled OpenCLI executable rather than resolving a global `opencli` command.
- Contract tests execute the SDK and package fixtures through the actual Runtime process.

### Sprint 3: Public Plugins and Persistence

**Dates:** August 17-28, 2026

**Outcome:** Complete the `PUBLIC` strategy slice.

**Work items included in acceptance:**

- Replace Sprint 1 Hacker News fixtures with its declared `PUBLIC` OpenCLI collection flow, SQLite store, migrations, refresh task, read state, and workspace actions.
- Add the complete GitHub Trending package with its own `PUBLIC` mapping, SQLite schema, migration, API routes, refresh task, filters, and repository workspace.
- Build plugin-local refresh settings sheets for manual-only, disabled, and fixed-interval policies.
- Persist source records, collection snapshots, settings, and read state independently in each plugin store.
- Add mock OpenCLI unit tests and credential-free integration tests for both public plugins.

**Acceptance criteria:**

- Hacker News and GitHub Trending each invoke only their declared `PUBLIC` OpenCLI mapping, validate the result, persist it in their own SQLite database, and render it in their user-visible workspace.
- Each plugin can reopen retained records immediately after application restart without waiting for a new collection.
- Hacker News story rows and GitHub repository rows expose the source-specific information, controls, and external navigation defined in the frontend handoff.
- A failed refresh leaves the most recent successful content intact and shows source-local failure feedback.
- Manual-only, disabled, and fixed-interval refresh settings are plugin-owned and survive restart without changing the other plugin's settings.
- Automated tests cover successful persistence, migrations, retained-content reads, malformed collection results, and failed refresh preservation.

### Sprint 4: Browser-Backed Collection

**Dates:** August 31-September 11, 2026

**Outcome:** Complete the `COOKIE` strategy slice.

**Work items included in acceptance:**

- Add the Zhihu Hot List package with its declared `COOKIE` OpenCLI mapping, SQLite schema and migration, collection task, routes, and ranked Chinese workspace.
- Implement plugin-local Browser Bridge and login-state detection, including disconnected and expired-login workspace states.
- Add host navigation states for browser-dependent plugin availability without exposing browser details in the host shell.
- Add redaction rules and test fixtures that cannot contain credentials, Chrome profile paths, cookies, or Browser Bridge session data.
- Document the developer-machine prerequisite and real-source test procedure.

**Acceptance criteria:**

- With Browser Bridge connected and an authenticated Zhihu session, Zhihu collects through its declared `COOKIE` mapping, persists the result, and renders retained content after restart.
- With Browser Bridge disconnected, Zhihu alone shows its connection guidance and retry action; Hacker News and GitHub Trending remain fully usable.
- With Browser Bridge connected but the Zhihu session expired, Zhihu shows login guidance that is distinct from the disconnected state.
- Browser-dependent operational details are confined to the affected plugin workspace while navigation shows only concise lifecycle state.
- CI tests and diagnostics are demonstrably free of credentials, Chrome profiles, cookies, and Browser Bridge session data.

### Sprint 5: Intercept and Scheduling

**Dates:** September 14-25, 2026

**Outcome:** Complete the `INTERCEPT` strategy slice and shared scheduling behavior.

**Work items included in acceptance:**

- Add the Product Hunt package with its declared `INTERCEPT` mapping, SQLite schema and migration, collection task, routes, and ranked product workspace.
- Complete Runtime's task queue, per-plugin active-task tracking, `PUBLIC` permit pool, browser-backed permit pool, coalescing, cancellation, and lifecycle status reporting.
- Connect refresh UI and plugin-local schedules to the shared queue instead of standalone plugin timers.
- Add queue tests with controlled fake OpenCLI processes for concurrency, serial browser work, cancellation, uncertain outcomes, and sibling failure isolation.

**Acceptance criteria:**

- Product Hunt uses its declared `INTERCEPT` mapping to collect, validate, persist, and display product results in its own workspace.
- Runtime runs at most three `PUBLIC` collection commands concurrently and exactly one combined `COOKIE` or `INTERCEPT` command at a time.
- A plugin never has more than one active collection task; duplicate refreshes visibly coalesce instead of triggering duplicate source activity.
- Plugin schedules and workspace refresh actions use the shared Runtime queue.
- Closing the application or removing a plugin cancels queued and active work, releases permits, and prevents future scheduled work.
- Queue tests cover limits, coalescing, cancellation, uncertain command outcomes, and failures that leave sibling plugins operational.

### Sprint 6: Host Lifecycle and Operations

**Dates:** September 28-October 9, 2026

**Outcome:** Complete the daily-use host experience.

**Work items included in acceptance:**

- Persist host state atomically as JSON: enabled IDs, last available selection, theme preference, and status snapshots.
- Implement navigation lifecycle indicators, opaque plugin badges, restored selection, first-run Browser Bridge check, runtime-restarting bar, and host-level unavailable state.
- Build the Plugin Manager: compatible and rejected package lists, local-folder installation, compatibility results, enabled toggle, diagnostics copy, and destructive removal confirmation.
- Implement application theme settings and the initial iframe query plus live `postMessage` theme convention for bundled plugins.
- Implement explicit package copy, duplicate-ID rejection, Runtime deactivation, task cancellation, route removal, package/data/log deletion, and fallback Runtime restart.

**Acceptance criteria:**

- Navigation shows all installed compatible plugins with running, refreshing, failed, unavailable, or disabled state and any opaque plugin-provided badge.
- Last available selection and system, light, or dark theme survive application restart; an open bundled workspace changes theme without reload.
- First-run Browser Bridge status identifies only browser-dependent plugins and does not block public plugins.
- A structurally valid, compatible local plugin package is copied into the managed directory, enabled immediately, and appears in navigation.
- Duplicate IDs are rejected before any file copy with a clear instruction to remove the installed plugin first.
- Rejected discovered and selected packages remain visible only in Plugin Manager with the exact compatibility reason.
- Removal deactivates the module, cancels work, unregisters routes, and deletes the exact package, SQLite data, and logs after confirmation.
- Copyable per-plugin diagnostics include status and bounded logs but exclude source records and authentication material.

## Full-System Integration Phase

### Sprint 7: Release-Candidate Assembly

**Dates:** October 12-23, 2026

**Outcome:** Assemble and validate every MVP component in one release candidate.

**Work items included in acceptance:**

- Produce a clean packaged Electron release candidate with the pinned OpenCLI runtime and all four built plugin packages.
- Create and execute a full integration matrix covering discovery, activation, navigation, refresh, persistence, scheduling, Browser Bridge degradation, installation, rejection, diagnostics, removal, theming, runtime restart, and application restart.
- Add packaged-app smoke automation and documented manual integration scripts for each matrix row.
- Resolve all integration defects that arise only when host, Runtime, SDK, stores, and workspaces run together.

**Acceptance criteria:**

- A clean-profile packaged release candidate discovers and launches Hacker News, GitHub Trending, Zhihu, and Product Hunt together.
- The integration matrix passes for host, SDK, Runtime, bundled OpenCLI, all plugin backends, independent SQLite stores, workspaces, scheduler, installation/removal, themes, and diagnostics.
- A Runtime exit triggers host recovery and reactivation of all enabled plugins without losing their retained records.
- A plugin activation, route, task, or refresh failure affects only that plugin; siblings continue to navigate, read retained content, and refresh when eligible.
- Application restart restores enabled state, theme, last available selection, and retained content for each plugin.
- Each official workspace completes the full Electron UI-to-scoped-API-to-plugin-store path; no integration row passes solely because of isolated unit tests.

### Sprint 8: Real-Source Validation and Release

**Dates:** October 26-November 6, 2026

**Outcome:** Produce release evidence and stabilize the release candidate.

**Work items included in acceptance:**

- Prepare the release-candidate machine with the bundled application, Browser Bridge, and required authenticated browser sessions.
- Execute the real-source verification script for all four plugins and record command, persistence, rendering, and restart evidence per plugin.
- Exercise Browser Bridge loss, expired login, fresh-profile installation, rejection, diagnostics, removal, shutdown, and recovery scenarios.
- Triage defects, close critical issues, and record explicit release decisions for any remaining high-severity issue.
- Produce the release notes, verification record, and known-issues list.

**Acceptance criteria:**

- On a release-candidate developer machine, all four plugins perform real-source collection, persist results, survive application restart, and render retained data in their workspaces.
- Recorded evidence demonstrates a passing `PUBLIC` run for Hacker News and GitHub Trending, a `COOKIE` run for Zhihu, and an `INTERCEPT` run for Product Hunt.
- Browser Bridge loss and expired-login tests affect only their browser-dependent plugin and preserve browser-independent plugin operation.
- A clean profile passes installation, duplicate and incompatibility rejection, diagnostics copy, and removal with deletion verification.
- Closing the main window stops Plugin Runtime, active collection, queued work, and scheduled refreshes.
- All critical defects are closed, and every remaining high-severity defect has an explicit release decision in the verification record.

## Definition of Done and Integration Gate

Every sprint is complete only when:

- The increment runs through the Electron host, not only in a package-level harness.
- New backend behavior is exercised from the real plugin workspace through Plugin Runtime.
- Automated tests cover the relevant contract, success, and failure behavior.
- The packaged or development application has a repeatable smoke-test result.
- Documentation and compatibility rules match the implemented behavior.
- Incomplete wiring is treated as unfinished work even when individual components pass their own tests.

Sprint 7 is the explicit component-assembly phase. Sprint 8 is separate because real `COOKIE` and `INTERCEPT` verification requires Browser Bridge and authenticated source sessions that CI cannot provide.
