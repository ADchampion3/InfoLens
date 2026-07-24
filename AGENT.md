# Infolens Agent Specification

## Purpose

This file defines the required delivery process for agents working on Infolens. Work is delivered one sprint at a time, validated as an integrated increment, accepted by the user, and only then committed to Git.

The keywords **MUST**, **MUST NOT**, **SHOULD**, and **SHOULD NOT** are normative.

## Sources of Truth

Agents MUST read the relevant project documents before changing implementation:

1. `PRD.md` defines product scope and release success criteria.
2. `ARCHITECTURE.md` and `docs/adr/` define technical boundaries and decisions.
3. `CONTEXT.md` defines project terminology.
4. `FRONTEND_PROTOTYPE_HANDOFF.md` and the current user-approved prototype define frontend behavior and visual direction.
5. `SPRINT_PLAN.md` defines sprint order, work items, and acceptance criteria.
6. `SPRINT_<N>_ACCEPTANCE.md` records the build, evidence, user testing, and result for sprint `N`.

When documents conflict, the agent MUST surface the conflict before changing the affected behavior. A later accepted ADR takes precedence over an earlier ADR. User direction takes precedence when it intentionally changes project scope.

## Sprint Delivery Rule

Only one sprint may be active at a time. The agent MUST NOT implement work assigned to a later sprint unless it is strictly necessary to complete the active sprint's acceptance criteria and the reason is documented.

Every sprint follows this sequence:

```text
Select sprint scope
    -> implement its work items
    -> run engineering verification
    -> prepare acceptance document and runnable build
    -> user performs acceptance testing
    -> fix rejected items and repeat verification
    -> user explicitly accepts
    -> commit accepted sprint
    -> begin next sprint
```

The agent MUST stop at the user acceptance gate. It MUST NOT mark a sprint accepted on the user's behalf, commit before explicit acceptance, or begin the next sprint while acceptance is pending.

## Phase 1: Start a Sprint

Before implementation, the agent MUST:

1. Read the sprint outcome, work items, and acceptance criteria in `SPRINT_PLAN.md`.
2. Read the preceding sprint's acceptance record and relevant implementation.
3. Inspect `git status` and preserve unrelated user changes.
4. State which sprint is active and that work will stop for user acceptance before commit.
5. Create or update a working plan containing implementation, verification, acceptance, and post-acceptance commit steps.

If a requested change alters sprint scope, the agent MUST update `SPRINT_PLAN.md` and the sprint acceptance document so the plan and evidence remain aligned.

## Phase 2: Implement the Work Items

The agent MUST implement every work item listed for the active sprint. A work item is incomplete until its relevant pieces are assembled through the real system boundary.

For Infolens, this means:

- Host features MUST be exercised through the Electron host renderer and main process where applicable.
- Plugin features MUST run through Plugin Runtime and a plugin-scoped route; the host MUST NOT take ownership of plugin business data or UI.
- Workspace behavior MUST be exercised from the real plugin workspace, not only through direct API calls.
- Collection behavior MUST use the declared OpenCLI boundary. Test fakes may support automated tests but MUST NOT be presented as real-source verification.
- Plugin persistence MUST remain plugin-owned and independent.
- Ordinary plugin failures MUST remain scoped to that plugin.

The agent SHOULD keep changes limited to the active sprint. Any supporting work pulled forward from a later sprint MUST be called out in the acceptance document.

## Phase 3: Engineering Verification

Before asking the user to test, the agent MUST run all checks relevant to the sprint. At minimum, when the scripts exist:

```powershell
npm run typecheck
npm run build
npm run test:sprint<N>
```

The agent MUST also run targeted tests for changed runtime, SDK, host, plugin, persistence, or scheduling behavior. Integration-sensitive work requires an end-to-end smoke test through the actual Runtime process.

Failed checks MUST be fixed and rerun. A check that cannot run because of environment, credentials, Browser Bridge, network, or tooling constraints MUST be recorded as `Blocked` or `Not run` with the exact reason. It MUST NOT be reported as passed.

The agent MUST run `git diff --check` before presenting the sprint for acceptance.

## Phase 4: Prepare User Acceptance

Each sprint MUST have a root acceptance document named:

```text
SPRINT_<N>_ACCEPTANCE.md
```

The document MUST contain:

1. **Phase**: sprint number, name, and outcome.
2. **Build Under Test**: exact command, URL, profile, fixture, or release-candidate build the user should test.
3. **Delivered Work Items**: each task or feature, what was delivered, and its primary code location.
4. **Engineering Checks**: each command or check and its actual result.
5. **Acceptance Checklist**: every sprint work item and acceptance criterion mapped to a concrete user action and expected evidence.
6. **Acceptance Record**: tester, date, result, and notes.

Every checklist row MUST have one of these states:

- `Pending`: user testing has not completed.
- `Passed`: user confirmed the expected behavior.
- `Failed`: user found a defect or missing behavior.
- `Blocked`: testing cannot proceed because a named prerequisite is unavailable.

Engineering checks may be marked passed by the agent. User-facing criteria remain `Pending` until the user tests them.

The agent MUST start or otherwise provide the runnable build needed for acceptance. It MUST give the user the shortest viable test path and disclose any test that requires the Electron build rather than a browser preview.

## Phase 5: User Acceptance Gate

The user performs acceptance testing. The agent MUST wait for an explicit result such as `Sprint N accepted` before committing.

If the user reports a defect, the agent MUST:

1. Mark the affected checklist item `Failed` and record the observation.
2. Diagnose and fix the defect within the active sprint.
3. Rerun relevant engineering checks.
4. Update the delivered work and evidence if behavior changed.
5. Return the sprint to the user for acceptance testing.

The agent MUST NOT weaken acceptance criteria merely to make a failing sprint pass. Any intentional scope change requires an explicit update to `SPRINT_PLAN.md` and user agreement.

## Phase 6: Record Acceptance and Commit

After explicit user acceptance, the agent MUST:

1. Update every accepted checklist row to `Passed`.
2. Fill the acceptance record with the tester, acceptance date, result `Accepted`, and relevant notes.
3. Rerun `git status`, relevant tests, and `git diff --check` if code changed after the last verification.
4. Review the diff and stage only the active sprint's files plus its plan and acceptance documentation.
5. Commit the accepted increment using this format:

```text
sprint <N>: <concise outcome>
```

6. Report the commit hash, committed scope, verification results, and any recorded limitation.
7. Mark the sprint complete in the working plan before beginning the next sprint.

The agent MUST preserve unrelated changes and MUST NOT use destructive Git operations. It MUST NOT amend or rewrite an accepted sprint commit unless the user explicitly requests it.

## Definition of Sprint Done

A sprint is done only when all of the following are true:

- Every listed work item is implemented or explicitly removed from scope with user agreement.
- Every acceptance criterion has concrete evidence.
- The increment works through its real host, Runtime, plugin, workspace, and persistence boundaries as applicable.
- Relevant automated tests, type checks, and builds pass.
- Known blocked checks and limitations are recorded accurately.
- The user explicitly accepts the sprint.
- The accepted code and acceptance record are committed together.

Passing isolated component tests is insufficient when the sprint requires integrated behavior.

## Integration and Release Sprints

Sprint 7 is the full component-assembly gate. Its integration matrix MUST cover host, SDK, Runtime, bundled OpenCLI, all plugin backends, independent stores, workspaces, scheduling, installation, removal, theming, diagnostics, Runtime recovery, and application restart.

Sprint 8 is the real-source release gate. `PUBLIC`, `COOKIE`, and `INTERCEPT` representatives MUST be exercised against their real source environments on the release-candidate machine. Mock OpenCLI output and credential-free CI tests do not satisfy real-source acceptance.

## Status Communication

During implementation, the agent SHOULD give concise updates when it:

- finishes a meaningful work item;
- discovers a scope or architecture issue;
- begins verification;
- encounters a blocked check;
- presents the build for user acceptance; or
- commits an accepted sprint.

The acceptance handoff MUST clearly state that the sprint is uncommitted and identify the exact user response needed to authorize the commit.
