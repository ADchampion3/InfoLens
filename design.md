# Design — Infolens

A locked design system for Infolens plugin workspaces and their prototypes.
Every workspace redesign reads this file before emitting code. Do not
regenerate per plugin — extend or amend this file when the system needs to grow.

## Genre

modern-minimal · tone: utilitarian.

These are information appliances, not marketing pages. Function carries every
surface: the list is the page. No hero sections, no eyebrows, no display-sized
taglines, no decorative kickers.

## Macrostructure family

- App pages (plugin workspaces): **Workbench** — compact utility header, one
  status strip, one or more labelled collections, side rails only when the
  view model needs filtering. Variation knobs: row layout, rail width, detail
  sheet width.
- Prototype pages (`prototypes/`): Workbench, same system, self-contained
  tokens.
- There are no marketing pages in this product. No enrichment anywhere.

## Theme

Cobalt (hue 250) base. Per-plugin accent hue is an identity mechanism and is
declared in each plugin's `theme.css`; the base system never hard-codes an
accent outside `var(--color-accent)`.

- `--color-paper`   oklch(98.5% 0.004 250)
- `--color-surface` oklch(99.5% 0.003 250)
- `--color-ink`     oklch(22% 0.018 255)
- `--color-ink-soft` oklch(34% 0.016 255)
- `--color-muted`   oklch(48% 0.014 255)
- `--color-rule`    oklch(88% 0.008 250)
- `--color-rule-strong` oklch(74% 0.012 250)
- `--color-accent`  oklch(50% 0.17 250)  (plugins override hue in theme.css)
- `--color-focus`   oklch(39% 0.17 250)

Dark mode: plugins supply full dark overrides in `theme.css`; the SDK token
file carries only the deltas that stay constant across themes.

## Typography

System-native stack only — no webfonts, no unloaded font declarations.

- Display: Bahnschrift ("Arial Narrow" fallback), weight 600, style normal
- Body: Segoe UI Variable Text, weight 400 / 700
- Mono: Cascadia Code — data only: ranks, counts, domains, timestamps
- Display tracking: -0.01em on h1/h2, 0 elsewhere; never use letter-spaced
  uppercase kickers
- Type scale anchor: `--text-display` = clamp(1.75rem, 3.5vw, 2.75rem) —
  reserved for prototype pages; workspaces never use it

Copy language: chrome copy is Simplified Chinese (`lang="zh-CN"`). Source
names, domains, and unit words native to the source (points, comments) stay in
their original language. No mixed-language sentences in one control.

## Spacing

4-point named scale in `tokens.css`. Pages use named tokens
(`var(--space-md)`), never raw values. Workspace content max-width 92rem;
header and main share the same container width.

## Radii

Utilitarian tight:

- `--radius-xs` 0.2rem — chips, filter buttons, row affordances
- `--radius-sm` 0.25rem — buttons, inputs, sheets, icon buttons
- `--radius-md` 0.375rem — menus, dialogs, calendar popover

## Motion

- Easings: `--ease-out` cubic-bezier(0.16, 1, 0.3, 1) for entrances/hovers
- Durations: 120 / 180 / 260 ms (`--dur-fast/base/slow`)
- Entrances: sheet fade + 1rem slide; scrim fade only. No scroll reveals.
- Feedback: 1px downward press on active buttons; icon spin while refreshing
  (scoped to the svg, never the button surface)
- Reduced-motion fallback: all animation/transition ≤ 1 ms

## Microinteractions stance

- Hover styles only under `(hover: hover) and (pointer: fine)`
- No toasts, no celebrations; state lives in the status strip dot + label
- Focus: 2px solid `--color-focus`, offset 2px, on every interactive element
- Disabled: opacity 0.5 + not-allowed; never re-colour

## Component voice

Shared chrome lives in `packages/plugin-sdk/src/workspace.css`. Plugin CSS
styles only its own content view (rows, rails, boards, desks) and never
re-declares header, buttons, sheets, warnings, or empty states.

- Header: sticky utility bar, min-height 3.5rem, hairline bottom rule,
  paper-92% blur backdrop. Source mark: accent square, mono initials.
- Status strip: single line under the header — state dot + label + detail +
  timestamp, mono, hairline rules above and below.
- Section head: h2 (display, text-md/lg) left + count right. No kickers,
  no numbered labels.
- Primary button: accent fill, radius-sm, min-height 2.5rem, weight 700,
  verb-first Chinese copy (立即刷新 / 保存 / 重试).
- Secondary button: rule-strong outline, surface fill, same geometry.
- Sheets: right-anchored, width min(25rem, 100%), head 4rem, independent
  scroll body with stable scrollbar gutter.
- Empty/error states: state mark (mono initials in bordered square) + h2 +
  one line of copy + one primary action.

## Per-page allowances

- Workspaces MUST NOT use enrichment, hero sections, or display type above
  `--text-xl`.
- Prototypes MAY use `--text-display` for template headings.
- Accent coverage ≤ 5 % of any viewport.

## What pages MUST share

- The token files (`plugin-sdk-tokens.css` for plugins, `tokens.css` for the
  prototype, both carrying identical values)
- The accent colour via `var(--color-accent)` and its placement rules
- The display + body + mono stacks
- The component voice above (button geometry, sheet behaviour, header shape)
- Status semantics: ready=success · refreshing=accent · stale=warning ·
  empty=faint

## What pages MAY differ on

- Accent hue (theme.css per plugin)
- Content view structure: ledger rows, board cards, reader rail — anything
  below the section head
- Detail sheet width per view model
