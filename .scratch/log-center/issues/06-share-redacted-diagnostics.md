# 06 - Share redacted diagnostic evidence

**What to build:** Let users safely share exactly the evidence they are investigating. Copy and export operate on the same filtered, minimal envelopes shown in Logs and never create a route to original sensitive values.

**Blocked by:** 03 - Investigate retained log history.

**Status:** resolved

- [x] A user can copy one entry with its minimal envelope and complete redacted message.
- [x] A user can copy the complete current filtered result, including all matching retained pages rather than only visible rows.
- [x] A user can export the complete current filtered result as valid JSONL containing only minimal-envelope properties.
- [x] Copy and export apply redaction again after reading retained or legacy content.
- [x] Authentication headers, cookies, tokens, secrets, session identifiers, Browser Bridge identifiers, profile paths, and common credential-bearing URL parameters are absent from persisted and returned representations.
- [x] There is no development or production control, IPC operation, or export option that reveals unredacted values.
- [x] Existing Plugin Diagnostic Report copying remains available and behaviorally compatible.
- [x] Logs exposes no clear or retention controls; plugin removal and bounded rotation remain the only cleanup paths.
- [x] Copy and export controls are keyboard operable, have visible focus, and expose accessible names.
- [x] Contract security cases cover structured fields, nested values, free text, URL parameters, Windows and Unix paths, and legacy entries.
- [x] Packaged Electron coverage demonstrates copying and exporting a filtered production log workflow without leaking seeded secrets.

## Answer

Added minimal-envelope single-entry copy, all-page filtered copy, and JSONL export through main-process IPC. All paths re-query and re-redact retained evidence; security coverage spans structured, nested, textual, URL, Browser Bridge, profile-path, and legacy cases. Existing Plugin Diagnostic Report behavior remains covered.
