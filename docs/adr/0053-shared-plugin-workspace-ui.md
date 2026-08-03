# Shared Plugin Workspace UI Boundary

ADR 0023 remains the boundary for `@infolens/plugin-sdk`: it provides runtime conventions and browser helpers, but it does not define DOM, UI copy, dialogs, components, or Plugin business behavior.

Reusable controls that are intentionally shared by multiple Plugin Workspaces live in the separate `@infolens/plugin-workspace` package. That package may own DOM construction, localized user-facing copy, keyboard interaction, confirmation dialogs, and CSS for those controls. It remains presentation-only: snapshot data is fetched from the calling Plugin API, and Plugin callbacks own rendering and business state.

The Plugin Runtime serves this package through `/runtime/plugin-workspace-history.js` and `/runtime/plugin-workspace-history.css`. Bundled Plugins use a local Workspace entry to import the shared controls. The old `/runtime/plugin-sdk-history.js` route and `packages/plugin-sdk/src/workspace-history.js` implementation are removed so the package boundary is explicit.

This decision formalizes the shared calendar and inline history controls requested by Issue 06 without expanding the Thin Plugin SDK. A future shared Workspace control follows the same rule: place it in `@infolens/plugin-workspace` only when the control is presentation-only and its Plugin-specific behavior remains callback-owned.
