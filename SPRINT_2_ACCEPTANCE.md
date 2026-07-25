# Sprint 2 User Acceptance

## Phase

Sprint 2: Runtime and SDK Contract

**Outcome:** Establish the stable plugin execution foundation without implementing Sprint 3 source collection or persistence.

## Build Under Test

- Contract suite: `npm run test:sprint2`
- Full engineering regression: `npm run typecheck`, `npm run build`, and `npm run test:sprint1`
- Desktop shutdown check: `npm start`, then close the Infolens window
- Test fixtures: `tests/fixtures/sprint2/`
- The Sprint 2 worktree is intentionally uncommitted until user acceptance.

## Delivered Work Items

| Work item | Delivered feature | Primary location |
| --- | --- | --- |
| Typed plugin SDK | Typed manifest, activation context, route, task, schedule, logger, OpenCLI, health, and workspace URL contracts | `packages/plugin-sdk/` |
| SDK runtime helpers | Manifest/backend identity helpers, health response helper, plugin health/workspace/API URL helpers, and iframe runtime configuration reader | `packages/plugin-sdk/src/index.js` |
| Package contract validation | Structure, safe package paths, plugin semantic version, contract version, minimum host version, OpenCLI range, read access, JSON output, supported strategy, and command availability checks | `packages/plugin-runtime/src/contract.mjs` |
| Shared validation boundary | One exported validator used by startup discovery and available to the later installation workflow, returning stable rejection codes and precise messages | `packages/plugin-runtime/src/contract.mjs`, `packages/plugin-runtime/src/server.mjs` |
| Plugin activation context | Plugin-scoped data directory and path resolver, routes, tasks, enqueueing, schedules, health updates, logs, and declared OpenCLI execution | `packages/plugin-runtime/src/server.mjs` |
| Lifecycle isolation | Plugin boundaries around activation, API routes, task handlers, and cleanup; failures update only the offending plugin | `packages/plugin-runtime/src/server.mjs` |
| Structured status events | Bounded Runtime event history plus structured stdout events for activation, rejection, health, task, route, cleanup, and deactivation transitions | `packages/plugin-runtime/src/server.mjs` |
| Rotating plugin logs | Per-plugin JSON-lines logs with bounded size and numbered rotation inside the plugin data directory | `packages/plugin-runtime/src/logger.mjs` |
| Task registration and scheduling | Named in-memory handlers, Runtime-owned interval registration, cancellation, per-plugin serialization, and duplicate request coalescing | `packages/plugin-runtime/src/task-manager.mjs` |
| Bundled OpenCLI adapter | Application-local distribution metadata, immutable declared command path, forced JSON output, abort support, JSON parsing, and no global command lookup | `packages/plugin-runtime/src/opencli-adapter.mjs`, `resources/opencli/` |
| Graceful Runtime cleanup | Host sends a shutdown request to Runtime so tasks, schedules, plugin cleanup, and final logs settle before exit, with timed kill fallback | `apps/desktop/main.cjs`, `packages/plugin-runtime/src/server.mjs` |
| Contract fixture matrix | Valid, invalid-structure, contract/host/OpenCLI-incompatible, invalid-range, `UI`, non-read, non-JSON, unavailable-command, and lifecycle-failure packages | `tests/fixtures/sprint2/` |
| Actual-Runtime contract test | Child-process discovery, rejection, SDK context, coalescing, local OpenCLI launch, rotation, failure isolation, events, and cleanup verification | `tests/sprint2-contract.test.mjs` |

## Engineering Checks

| Check | Result |
| --- | --- |
| `npm run typecheck` | Passed: desktop and SDK declarations |
| `npm run build` | Passed: production renderer build |
| `npm run test:sprint1` | Passed: Sprint 1 Runtime/workspace regression |
| `npm run test:sprint2` | Passed: 2 tests, including the actual Runtime child-process contract suite |
| Bundled OpenCLI boundary | Passed: fixture executable reported `INFOLENS_OPENCLI_BUNDLED=1` and received only the declared command plus forced JSON output |
| Contract rejection matrix | Passed: all expected stable rejection codes observed through Runtime discovery |
| Lifecycle isolation | Passed: activation, route, task, and cleanup failures were plugin-scoped while a sibling remained usable or continued cleanup |
| Log rotation | Passed: bounded current and numbered rotated logs observed in the plugin data directory |
| Dependency security audit | Passed during dependency reconciliation: npm reported 0 vulnerabilities |
| `git diff --check` | Passed |

## Acceptance Checklist

| # | Work item and acceptance criterion | User test and expected evidence | Result |
| --- | --- | --- | --- |
| 1 | Typed SDK and activation context: a backend receives plugin ID, data directory, safe path resolution, route/task/schedule registration, scoped logging, health updates, and OpenCLI access. | Run `npm run test:sprint2`. The actual-Runtime test passes the SDK context and URL-helper assertions. | Passed |
| 2 | Route, task, and schedule assembly: a fixture registers routes and tasks, owns no independent server or timer, and Runtime cancels its schedule during cleanup. | In the same test output, confirm `Sprint 2 contracts execute through the actual Plugin Runtime` passes. | Passed |
| 3 | Declared-command boundary: a plugin can run `fixtureRead`; an undeclared key is rejected. | The Sprint 2 suite must pass both the fixture OpenCLI response assertion and the `not declared` error assertion. | Passed |
| 4 | Package structure and semantic versions: missing entries, unsupported contract, future host requirement, invalid OpenCLI range, and incompatible OpenCLI version are rejected precisely. | Run `npm run test:sprint2`; it must finish with 2 passing tests and no failed rejection-code assertion. | Passed |
| 5 | OpenCLI mapping validation: `UI`, non-read, non-JSON, and unavailable mappings are rejected before activation. | Inspect `tests/fixtures/sprint2/manifests/` if desired, then confirm the contract suite passes its rejection matrix. | Passed |
| 6 | Activation isolation: a backend that throws during activation becomes failed while valid sibling packages activate. | The contract suite must pass with `activation-failure` failed and `valid-contract`, `route-failure`, and `cleanup-failure` initially usable. | Passed |
| 7 | Route and task isolation: a failing route or task marks only its plugin failed; a healthy sibling API remains usable. | The contract suite must pass its HTTP 500/503 checks and the subsequent healthy sibling response check. | Passed |
| 8 | Cleanup isolation and graceful shutdown: a cleanup exception is recorded while later sibling cleanup continues. | The contract suite must observe `cleanup-failed` for one plugin and `deactivated` for its sibling before Runtime exits. | Passed |
| 9 | Task coalescing: repeated refresh requests for one plugin share a promise and execute the handler once. | The contract suite must report one execution and a `task-coalesced` status event. | Passed |
| 10 | Bundled OpenCLI execution: Runtime launches the explicit application-local executable and forces JSON instead of resolving global `opencli`. | The contract suite must return `bundled: true` with arguments ending in `--output=json`. | Passed |
| 11 | Structured events and rotating logs: lifecycle/task failures are emitted as structured events and plugin logs remain bounded. | The contract suite must find the named status events plus `plugin.log` and at least one numbered rotation. | Passed |
| 12 | Sprint 1 remains intact: Hacker News still discovers, activates, serves its workspace, and returns 15 retained stories. | Run `npm run test:sprint1`; the walking-skeleton test passes. | Passed |
| 13 | Production build and typed contract remain valid. | Run `npm run typecheck` and `npm run build`; both commands complete successfully. | Passed |
| 14 | Desktop host performs graceful Runtime shutdown. | Run `npm start`, confirm Hacker News opens, close the window, and confirm the Electron application exits without a lingering Runtime process. | Passed |

## Scope Notes

- `resources/opencli/` establishes and tests the bundled executable boundary. Its development placeholder intentionally does not collect a real source; Hacker News real `PUBLIC` collection begins in Sprint 3.
- Sprint 2 supplies task registration, scheduling, per-plugin serialization, cancellation, and coalescing. Cross-plugin `PUBLIC` and browser-backed permit pools remain Sprint 5 work.
- The shared package validator is ready for both discovery and installation. The Plugin Manager and local-folder copy workflow remain Sprint 6 work.

## Acceptance Record

- Tester: User
- Date: 2026-07-25
- Result: Accepted
- Notes: User explicitly accepted the Sprint 2 increment and authorized its Git commit.
