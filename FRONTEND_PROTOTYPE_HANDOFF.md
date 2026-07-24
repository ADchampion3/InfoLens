# Infolens Frontend Prototype Handoff

## Purpose

This document defines the design and interaction requirements for a high-fidelity desktop prototype of the Infolens MVP. The prototype should be detailed enough to validate information architecture, component states, plugin-host boundaries, and the primary user flows before production implementation.

The intended audience is the product designer and frontend engineer building the prototype in Figma or React.

## Product Experience

Infolens is a local-first desktop reader for independently designed information plugins. The application shell provides persistent navigation and operational status. Selecting a plugin opens that plugin's complete workspace; the host does not aggregate plugin content into a dashboard or shared feed.

The experience should feel quiet, efficient, and information-dense. It is a daily-use desktop tool, not a marketing site. Favor clear hierarchy, compact rows, predictable controls, and restrained surfaces over large cards or decorative effects.

## Prototype Deliverables

The prototype must include:

- A desktop host shell at 1440 x 900.
- A constrained layout check at 1024 x 700.
- Light and dark themes.
- Four official plugin workspaces: Hacker News, GitHub Trending, Zhihu Hot List, and Product Hunt.
- Plugin management and application settings screens.
- First-run Browser Bridge status.
- Loading, empty, refreshing, failed, unavailable, and runtime-restarting states.
- Clickable flows for plugin switching, refresh, plugin settings, installation outcomes, diagnostics, removal, and theme changes.

Mobile layouts, a marketing page, a cross-plugin feed, plugin authoring, and a hostile-plugin permission flow are outside the prototype scope.

## Experience Principles

1. **Retained content first.** Opening a plugin shows its last successful content immediately. Refresh runs without replacing the content with a blocking loader.
2. **Failures stay local.** A failed or browser-dependent plugin does not make unrelated plugins unavailable.
3. **Status is visible but quiet.** Operational state is easy to find in navigation and management without dominating reading.
4. **Plugin ownership remains clear.** The host surrounds the workspace but never renders plugin business content.
5. **Actions are predictable.** Refresh, settings, diagnostics, install, and removal appear in consistent locations and always show feedback.

## Information Architecture and Ownership

| Surface | Owner | Responsibilities |
| --- | --- | --- |
| Left navigation | Host | Plugin selection, icon, name, lifecycle indicator, optional opaque badge |
| Workspace frame | Host | Loads and contains the selected plugin workspace |
| Plugin content and detail views | Plugin | Source-specific reading, filtering, refresh, read state, and source actions |
| Plugin refresh settings | Plugin | Manual-only, disabled, and fixed-interval policy |
| Plugin management | Host | Installation, compatibility state, diagnostics, enablement, and removal |
| Application settings | Host | System, light, or dark theme preference |
| Browser/login guidance | Affected plugin | Source-specific connection and login recovery |

## Core Layout

### Desktop Frame

- Default viewport: 1440 x 900.
- Minimum supported prototype viewport: 1024 x 700.
- Navigation width: 248 px at 1200 px and wider; 216 px below 1200 px.
- Navigation is always visible and does not collapse to icons in the MVP.
- Main area fills all remaining width and height.
- A 1 px divider separates navigation from the main area.
- The plugin workspace iframe is visually unframed and fills the main area.
- Do not wrap the workspace in a card or add host padding around it.

```text
+-----------------------+----------------------------------------------------+
| Infolens              |                                                    |
|                       |                                                    |
| [icon] Hacker News  8 |          Selected plugin workspace                |
| [icon] GitHub         |          (owned entirely by plugin)               |
| [icon] Zhihu       !  |                                                    |
| [icon] Product Hunt   |                                                    |
|                       |                                                    |
|                       |                                                    |
|                       |                                                    |
|-----------------------|                                                    |
| [plug] Plugins        |                                                    |
| [gear] Settings       |                                                    |
+-----------------------+----------------------------------------------------+
```

### Navigation Anatomy

Each plugin row is 44 px high and contains:

- 24 px source icon.
- Plugin name on one line, truncating with an ellipsis when necessary.
- Optional short badge, displayed as opaque text without interpreting its meaning.
- Lifecycle marker: running, refreshing, failed, unavailable, or disabled.

Use a filled selection background and a 3 px leading accent. Do not rely on color alone for failed or unavailable states; pair color with an icon and tooltip. Navigation rows have a 6 px maximum corner radius.

The bottom area contains `Plugins` and `Settings`. These are host destinations and replace the workspace in the main area when selected.

## Host Screens

### H1: Normal Plugin Selection

**Entry:** Application launch or plugin selection.

**Required content:**

- Persistent navigation.
- Selected state on exactly one plugin.
- The plugin workspace filling the main area.
- Last available selection restored after restart.

**Behavior:** Switching plugins changes the workspace without changing the navigation layout. Previously retained content should appear immediately when the destination plugin is available.

### H2: First-Run Browser Bridge Check

Show a compact first-run dialog after the shell is visible. It must not block access to `PUBLIC` plugins.

Dialog content:

- Title: `Browser connection`
- Connected state: `Browser Bridge is connected.`
- Disconnected state: `Connect Browser Bridge to refresh browser-based plugins.`
- Primary action: `Check again`
- Secondary action: `Continue`

The dialog may identify Zhihu and Product Hunt as affected, but it must not imply that Hacker News or GitHub Trending are unavailable.

### H3: Runtime Restarting

When the shared Plugin Runtime exits, keep the shell interactive and show a non-modal status bar at the top of the main area:

- Message: `Restarting plugin services...`
- Indeterminate progress indicator.
- Plugin navigation remains visible.
- The current workspace remains in place until reconnection or a scoped unavailable state is known.

On recovery, dismiss the bar and reload the workspace. Do not show a success toast unless recovery took long enough for the user to notice.

### H4: Plugin Manager

Use an unframed two-column management layout, not cards nested inside a page container.

- Header: `Plugins`
- Primary action: `Install plugin` with a folder-plus icon.
- Left column: installed and rejected plugin rows.
- Right column: details for the selected plugin.

Each row shows icon, name, version, enabled state, lifecycle state, and latest refresh summary. Rejected packages appear only here and include an `Incompatible` label.

The detail panel includes:

- Name, version, plugin ID, and package location.
- Enabled toggle for compatible plugins.
- Current state and last successful refresh.
- Latest failure code, time, and short message when present.
- `Copy diagnostics` action with copy confirmation.
- Destructive `Remove plugin` action.

Removal opens a confirmation dialog that explicitly states that the plugin package, retained content, settings, and logs will be deleted. The confirmation action is `Remove plugin`; the safe action is `Cancel`.

### H5: Installation Outcomes

The operating-system folder picker does not need to be recreated. Prototype the states after a folder is selected:

| Outcome | Presentation | Required action |
| --- | --- | --- |
| Compatible package | Progress row followed by success toast | `Open plugin` |
| Duplicate ID | Inline dialog error explaining that replacement is not supported | `View installed plugin` |
| Unsupported contract | Inline dialog error with contract and host versions | `Close` |
| Host version too old | Inline dialog error with required host version | `Close` |
| OpenCLI mapping incompatible | Inline dialog error naming the unsupported mapping | `Close` |
| Invalid package structure | Inline dialog error naming the missing or invalid file | `Close` |

Do not include a plugin review, permission approval, marketplace, update, or replace-in-place flow.

### H6: Application Settings

- Header: `Settings`
- Section: `Appearance`
- Label: `Theme`
- Three-option segmented control: `System`, `Light`, `Dark`

Changing the selection updates the shell and open bundled workspace immediately. The selection persists. No global refresh setting belongs on this screen.

## Plugin Workspace Pattern

The official plugins should share basic placement conventions without appearing to be one host-rendered content template:

- A 56 px workspace header with source name, last-refresh text, refresh icon button, and settings icon button.
- A source-specific toolbar or filter row only when useful.
- Content beneath the header, optimized for scanning.
- A compact progress indicator beside refresh while retained content stays visible.
- Plugin settings shown as a right-side sheet, 360 px wide, owned and styled by the plugin.

Refresh icon buttons use the Lucide `RefreshCw` icon and an accessible tooltip. Settings uses `Settings`. External links use `ExternalLink`. Avoid text-only rounded pills where a familiar icon is sufficient.

### Shared Plugin States

| State | Workspace behavior |
| --- | --- |
| Initial loading | Use row-shaped skeletons; keep header dimensions stable |
| Retained content | Render content immediately with last successful refresh time |
| Refreshing | Keep content visible; animate refresh icon and show `Refreshing...` |
| Empty, never refreshed | Show source-specific empty state and a clear `Refresh now` action |
| Refresh failed with retained content | Keep content visible; show a compact warning banner and retry action |
| Unavailable | Show plugin-owned dependency or startup guidance in the workspace |
| Disabled | Host shows a neutral disabled state with `Enable in Plugins` action |

### Refresh Settings Sheet

All four bundled plugins include:

- Title: `Refresh settings`
- Radio options: `Manual only`, `Disabled`, and `Every [interval]`
- Interval select enabled only when the fixed-interval option is selected.
- `Save` and `Cancel` actions.

Newly installed plugins begin with `Manual only` selected. Automatic refresh must not begin merely by opening the settings sheet.

## Official Plugin Screens

### P1: Hacker News Top Stories

Use a dense ranked list with one story per row.

Each row contains rank, title, source domain, points, author, age, comment count, and read state. Selecting a story opens its source URL; selecting the comment count opens the discussion. Read stories use reduced emphasis without becoming illegible.

Prototype content should include at least 15 stories, mixed title lengths, missing domains, zero-comment items, and read/unread examples. Suggested navigation badge mock: `8`.

### P2: GitHub Trending

Use a vertically scrolling repository list with compact metadata rather than a card grid.

Each row contains owner/repository, description, language with color swatch, total stars, forks, and stars gained in the selected period. Include period and language controls in the toolbar. Selecting a repository opens it externally.

Prototype content should include at least 12 repositories, long descriptions, repositories without a language, and multiple language colors.

### P3: Zhihu Hot List

Use a ranked editorial list with strong Chinese title scanning.

Each row contains rank, question title, optional excerpt, heat value, and optional thumbnail. The list must remain aligned when a thumbnail is absent. Selecting a row opens the Zhihu item externally.

Create three connected prototype states:

1. Connected with retained content.
2. Browser Bridge disconnected.
3. Browser connected but Zhihu login expired.

Dependency states must include `Check again` and a source-appropriate recovery action. Suggested failed navigation badge mock: `!`.

### P4: Product Hunt Today's Top Launches

Use a ranked product list with product identity visible at a glance.

Each row contains rank, product logo, name, tagline, topics, vote count, and comment count. Selecting the row opens the product page; vote and comment values are informational in the MVP.

Create connected and Browser Bridge disconnected states. Prototype at least 12 products, including long taglines, missing logos, and several topic counts.

## Visual System

### Typography

Use a native desktop-friendly sans-serif stack:

```css
font-family: Inter, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
```

| Role | Size / line height | Weight |
| --- | --- | --- |
| Page title | 20 / 28 px | 650 |
| Workspace title | 17 / 24 px | 650 |
| Row title | 14 / 20 px | 600 |
| Body | 14 / 20 px | 400 |
| Metadata | 12 / 16 px | 400 |
| Button | 13 / 18 px | 600 |

Do not scale typography with viewport width. Letter spacing is `0`.

### Color Tokens

Use a neutral shell with distinct semantic and source accents. Avoid a single-hue interface.

| Token | Light | Dark |
| --- | --- | --- |
| `bg.app` | `#F7F8FA` | `#15171A` |
| `bg.surface` | `#FFFFFF` | `#1D2024` |
| `bg.selected` | `#E9EEF5` | `#29313A` |
| `text.primary` | `#1B1F24` | `#F1F3F5` |
| `text.secondary` | `#66707A` | `#AAB2BB` |
| `border.default` | `#DDE2E7` | `#343A40` |
| `accent.host` | `#2563A6` | `#62A8E5` |
| `status.success` | `#237A46` | `#56C987` |
| `status.warning` | `#A15C00` | `#F0B35B` |
| `status.danger` | `#B4232C` | `#FF7B83` |
| `status.info` | `#316CA8` | `#75B7F0` |

Source accents may use Hacker News orange, GitHub neutral/green, Zhihu blue, and Product Hunt red-orange, but accents should occupy a small part of the workspace.

### Geometry and Spacing

- Spacing scale: 4, 8, 12, 16, 24, and 32 px.
- Control height: 32 px compact, 36 px default.
- Icon button: fixed 32 x 32 px.
- Row minimum height: 52 px; dense metadata rows may reach 72 px.
- Border radius: 4 px for controls and 6 px for dialogs, sheets, and repeated items; never exceed 8 px.
- Use borders and background changes for separation. Avoid decorative shadows except on dialogs and side sheets.
- Do not use gradients, decorative blobs, oversized empty-state illustrations, or cards nested inside cards.

### Icons

Use Lucide icons where available. Required mappings:

- Refresh: `RefreshCw`
- Settings: `Settings`
- Plugin management: `Plug`
- Install: `FolderPlus`
- Copy diagnostics: `Copy`
- Remove: `Trash2`
- External navigation: `ExternalLink`
- Success: `CheckCircle2`
- Warning: `TriangleAlert`
- Unavailable: `CircleOff`
- Retry: `RotateCcw`

Every unfamiliar icon-only control requires a tooltip and accessible name.

## Interaction Details

- Selection changes should complete within 150 ms in the prototype.
- Use 120-180 ms ease-out transitions for hover, selection, dialogs, and sheets.
- Do not animate workspace content on every plugin switch beyond a subtle opacity transition.
- Refresh does not clear or shift retained rows.
- Toasts appear at the bottom-right, remain for 4-6 seconds, and never cover primary actions.
- Destructive actions always require confirmation.
- Escape closes dialogs and sheets; focus returns to the invoking control.
- Keyboard focus order follows navigation, workspace header, toolbar, then content.

## Accessibility Requirements

- Meet WCAG 2.2 AA contrast for text, controls, and focus indicators.
- Provide a visible 2 px focus ring with at least 2 px offset.
- All controls are keyboard operable.
- Status is expressed with text or icon plus text, never color alone.
- Touch targets are at least 32 x 32 px for this desktop application.
- Chinese and English text must wrap without clipping at 1024 x 700.
- Lists expose clear selected, current, disabled, and busy states to assistive technology.
- Dialogs trap focus and announce their title.

## Prototype Flow Checklist

The clickable prototype must demonstrate these end-to-end flows:

1. Launch into retained Hacker News content, switch to GitHub Trending, and return without a loading reset.
2. Refresh Hacker News while its existing list remains readable, then show a successful completion state.
3. Open Zhihu while Browser Bridge is disconnected, follow recovery, and arrive at retained content.
4. Change the theme in application settings and see the host and current plugin update immediately.
5. Install a compatible plugin and open it from navigation.
6. Attempt a duplicate installation and navigate to the already installed plugin's management detail.
7. Inspect a failed plugin, copy diagnostics, and receive copy confirmation.
8. Remove a plugin through confirmation and verify it disappears from navigation.
9. Simulate Plugin Runtime restart and recover the currently selected workspace.
10. Change one plugin's refresh policy without affecting the settings of other plugins.

## Handoff Assets and Naming

Organize design frames using these names:

```text
H1 Host - Plugin selected
H2 Host - First run bridge connected
H2 Host - First run bridge disconnected
H3 Host - Runtime restarting
H4 Plugins - Normal
H4 Plugins - Failure detail
H4 Plugins - Incompatible package
H5 Install - Success
H5 Install - Duplicate
H5 Install - Incompatible
H6 Settings - Light
H6 Settings - Dark
P1 Hacker News - Retained
P1 Hacker News - Refreshing
P1 Hacker News - Empty
P2 GitHub Trending - Retained
P3 Zhihu - Retained
P3 Zhihu - Bridge missing
P3 Zhihu - Login expired
P4 Product Hunt - Retained
P4 Product Hunt - Bridge missing
```

Provide source icons and product thumbnails as replaceable bitmap assets. Keep host icons in the shared Lucide icon set. Annotate host-owned and plugin-owned frames explicitly so implementation does not move business UI into the Electron shell.

## Prototype Acceptance Criteria

The handoff is ready for implementation when:

- All named frames exist in light theme, and core shell, settings, and one representative plugin exist in dark theme.
- The 10 prototype flows are clickable without dead ends.
- Every host and plugin state in this document is represented or linked to a component variant.
- Layouts have been checked at 1440 x 900 and 1024 x 700 with no overlap, clipping, or unexpected reflow.
- Navigation, headers, toolbars, buttons, and content rows keep stable dimensions across states.
- The design clearly distinguishes host lifecycle UI from plugin-owned business UI.
- Installation, diagnostics, failure isolation, Browser Bridge recovery, and runtime restart are shown, not left as implementation notes.
- Mock content includes long, short, missing, failed, and empty data cases.
- Accessibility annotations cover focus order, accessible names, status announcements, and contrast.
- No out-of-scope dashboard, shared content schema, global refresh setting, marketplace, permission review, or plugin update flow has been added.
