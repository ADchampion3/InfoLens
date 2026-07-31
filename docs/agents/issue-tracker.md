# Issue Tracker: Local Markdown

Issues and specs for this repository live as Markdown files under `.scratch/`.

## Conventions

- One feature per directory: `.scratch/<feature-slug>/`
- The feature specification is `.scratch/<feature-slug>/spec.md`
- Implementation issues are stored individually under `.scratch/<feature-slug>/issues/`
- Implementation issue filenames start with a two-digit sequence number
- Triage state is recorded with a `Status:` line near the top of each issue
- Comments and conversation history are appended under a `## Comments` heading

## Publishing

When a skill publishes a specification or issue, create the corresponding Markdown file under `.scratch/<feature-slug>/`, creating the directory when needed.

## Fetching

When a skill fetches a ticket, read the path supplied by the user. For a feature-level reference, inspect its specification and issue directory.

## Wayfinding

- The map is `.scratch/<effort>/map.md`.
- Child tickets are `.scratch/<effort>/issues/<NN>-<slug>.md`.
- Child tickets record `Type:`, `Status:`, and optional `Blocked by:` metadata.
- A ticket is unblocked when every listed blocker has status `resolved`.
- Claim work by setting `Status: claimed` before starting.
- Resolve work by appending an `## Answer`, setting `Status: resolved`, and linking the decision from the map.
