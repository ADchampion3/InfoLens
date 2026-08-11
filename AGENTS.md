## Agent skills

### Issue tracker

Issues and specs are tracked as local Markdown under `.scratch/`. See `docs/agents/issue-tracker.md`.

### Triage labels

The repository uses the default triage role names. See `docs/agents/triage-labels.md`.

### Domain docs

The repository uses a single-context domain layout. See `docs/agents/domain.md`.

## Working conventions

- Do not perform UI testing.
- The project is still under active development. Do not preserve backward compatibility by default; prefer direct breaking contract changes over compatibility shims or overloads. Ask the user when the intended breaking-change scope is unclear or materially affects the design.
