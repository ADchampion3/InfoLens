# 04 - Read live logs without interruption

**What to build:** Let users observe new operational evidence while Logs is open without interrupting an investigation already in progress. Updates must be bounded to the active Logs view and accessible to keyboard and screen-reader users.

**Blocked by:** 03 - Investigate retained log history.

**Status:** resolved

- [x] The active Logs view checks for new entries every two seconds without introducing a streaming transport.
- [x] Polling stops when the user navigates away from Logs and resumes when they return.
- [x] When the user is at the newest position, new entries appear without a manual refresh.
- [x] When the user is reading older entries, incoming entries do not move the visible reading position.
- [x] A control reports how many new entries are waiting and moves to the newest results on activation.
- [x] Repeated polling does not duplicate entries and respects the current filters.
- [x] Temporary query failures preserve already displayed evidence and present a recoverable status.
- [x] Live-update status and controls expose meaningful accessible names and do not rely on animation or color alone.
- [x] Keyboard users can reach and activate the new-entry control with visible focus.
- [x] Packaged Electron coverage verifies polling start and stop, both insertion behaviors, deduplication, and preserved reading position.

## Answer

Added active-view two-second polling, ID-based deduplication, automatic newest insertion, preserved older reading position with an accessible pending-entry control, recoverable live errors, and cleanup on navigation.
