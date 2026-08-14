# Plugin-Level Browser Degradation

Status: superseded by [ADR 0058 - Browser Bridge Session UX](0058-browser-bridge-session-ux.md)

Browser Bridge availability and site login state will affect only the plugin that needs them. Infolens keeps browser-independent plugins running, exposes a concise dependency state in navigation, and lets the affected plugin present its own connection or login guidance in its workspace.
