# Plugin Author Preview Harness

Status: accepted

## Context

`doctor` proves lifecycle and static Workspace correctness, while `dev` only
prepares a development Adapter Scope. Authors still need a foreground loop
that starts a real Plugin Runtime, serves one Plugin Workspace, and can restart
that Runtime after package edits. The Host must not gain a Development Link or
an installation-time development mode to provide this workflow.

## Decision

The Plugin SDK author CLI provides a separate `preview <path>` command. Preview
is a foreground author tool with this interface:

- it validates the target package before starting;
- it copies a filtered package snapshot into a temporary Plugin Directory;
- it starts one isolated Plugin Runtime with temporary Plugin data, Host State,
  Managed Adapter Store, and Application Session state;
- it exposes the Runtime's normal Plugin Workspace, Plugin API, and Plugin
  Health URLs for the target Plugin;
- it watches the source package and restarts the Runtime from a fresh snapshot
  after a debounced change, keeping the temporary state and loopback port for
  the session;
- it stops the Runtime and removes temporary state on `Ctrl+C`, `SIGTERM`, or
  the `shutdown` stdin command.

Preview serves the built Workspace Bundle through Plugin Runtime. It does not
compile frontend source, execute browser JavaScript, provide browser rendering
assertions, or claim Browser Bridge credentials are available. A browser or
other author-controlled client may open the reported Workspace URL.

## Boundaries

This command does not change `dev`, `validate`, `doctor`, `pack`, installation,
or the managed Plugin Directory. It does not create a Development Link,
symbolic link, or package-directory mutation. `pack` never invokes Preview.
Runtime restart is an author-tool process restart, not Host plugin hot reload.

## Consequences

Authors get a stable local URL and the same Runtime URL shape used by the Host,
with automatic Backend and static Workspace refresh after edits. The preview
process owns cleanup, so temporary state does not become part of the package.
The harness is intentionally limited to built static assets; a future frontend
build or browser automation workflow remains a separate decision.
