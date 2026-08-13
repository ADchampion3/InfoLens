# Daily Summary Writing Prompt

## Status

Accepted for the Daily Summary writing workflow.

## Decision

The Daily Summary Host Shell exposes three distinct text artifacts:

- the existing frozen facts Markdown, which remains suitable for arbitrary downstream instructions;
- a generated, editable writing prompt that includes the selected facts and asks an LLM to regroup entries by content topic;
- an editable authored summary that the user may paste or write after using the prompt.

The default prompt is explicit about the local-day boundary, source completeness, preserving source fields, separating facts from editorial judgment, uncertainty, follow-up questions, Markdown output, and treating source content as untrusted data rather than instructions. It provides topic hints when records expose a `topic`, `topics`, `category`, `categories`, `tag`, or `tags` field, while requiring the model to classify records by meaning and use a fallback topic when classification is not reliable.

The prompt is downloaded as `infolens-daily-summary-prompt-YYYY-MM-DD.md`. User-authored content is downloaded as `infolens-daily-summary-written-YYYY-MM-DD.md` with the selected-date metadata added by the Host Shell. Both artifacts may be copied or downloaded only for a current Daily Summary preview and remain subject to the existing Browser-Dependent source privacy confirmation. The facts artifact keeps its existing filename and content contract.

The Host Shell owns prompt generation, editing, authored-content delivery, and filename validation. Plugin Context remains a structured, read-only input, and Plugin Export remains Plugin-owned and opaque to the Host Shell.

## Consequences

Users can move directly from a selected Daily Summary to an LLM-ready prompt, adjust the instruction for their purpose, and export the resulting written summary without manually rebuilding the source context. Prompt edits do not mutate the frozen facts or Plugin data. The writing workflow is session-local; it is not persisted as Host State or Plugin data.

This supersedes the earlier Daily Summary wording only where it implied that the page could not provide a separate prompt. The facts Markdown artifact still contains no fixed prompt.
