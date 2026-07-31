# 02 - Unify Plugin Runtime and plugin evidence

**What to build:** Let users inspect Plugin Runtime and plugin evidence in the Host-owned Logs view alongside Host entries. Rejections, activation failures, collection failures, and Runtime crashes must remain attributable to the correct source without breaking the existing plugin logger or Plugin Diagnostic Report.

**Blocked by:** 01 - Host Shell log center walking skeleton.

**Status:** resolved

- [x] The log query returns merged entries from `host`, `runtime`, and `plugin:<id>` sources in deterministic newest-first order.
- [x] Plugin discovery rejection, activation failure, route failure, task or collection failure, cleanup failure, and Runtime exit evidence appear with the correct source.
- [x] OpenCLI activity is attributed to the plugin that invoked it rather than exposed as a separate source category.
- [x] Existing plugin logger methods and call signatures remain source-compatible.
- [x] Plugin logger fields are redacted, serialized in deterministic key order, and appended to the plain-text message without adding arbitrary envelope properties.
- [x] Existing JSONL plugin history is adapted at read time without rewriting historical files.
- [x] Missing legacy identifiers and session metadata are synthesized deterministically where possible and otherwise identified as legacy data.
- [x] Malformed or partially written legacy lines cannot fail an otherwise valid query or expose unredacted text.
- [x] Runtime crash evidence remains available while the Host restarts Plugin Runtime.
- [x] Removing a plugin deletes its dedicated logs while redacted Host lifecycle evidence remains until natural rotation.
- [x] The existing Plugin Diagnostic Report remains available and continues to exclude source records and authentication material.
- [x] Contract and packaged Electron tests demonstrate a plugin failure and Runtime exit from production boundaries.

## Answer

Unified Host, Runtime, and plugin evidence through the Host-owned query contract. Plugin logger calls remain compatible while fields become deterministic redacted message text; legacy and malformed JSONL are adapted safely at read time. Runtime rejection, plugin activation/failure, Runtime exit, diagnostics compatibility, and removal semantics are covered at contract and packaged Electron boundaries.
