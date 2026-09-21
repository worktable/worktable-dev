# Worktable Design System

**Theme:** Neutral Drafting Room — Cobalt × Bronze
Neutral structure, paper for content, real tools for primary action.
This file records the durable usage rules. Exact values and generated adapters
come from the canonical theme configuration below.

## Theme source and generated artifacts

[`packages/ui/src/theme/theme-config.ts`](packages/ui/src/theme/theme-config.ts) is the only human-edited source for structural colors, accents, statuses, charts, backdrop geometry, control finishes, overlay elevation, browser shell colors, and the BlockNote and Mermaid adapter palettes. Read that file for exact values; do not copy its values into documentation or product CSS.

Run `bun run generate:theme` after changing the configuration. It generates and commits:

- `packages/ui/src/styles/theme.generated.css`, the pure semantic CSS variable contract.
- `apps/web/src/styles/blocknote-theme.generated.css`, BlockNote-compatible hardcoded colors.
- `packages/types/src/mermaid-theme.generated.ts`, Mermaid-compatible constants.

`bun run check:theme` rejects drift. Product CSS consumes `@worktable/ui/theme.css`; React continues using standard Tailwind semantic utilities.

Additional deployment-specific outputs are declared in
`scripts/generation-targets.json` for the checkout that owns them.

### Static brand assets

The theme-independent Worktable logo palette lives under `themeConfig.brand` in
`packages/ui/src/theme/theme-config.ts`. It is derived from the light primary
and button-face cobalt recipe, but exported brand artwork does not change with
the application theme.

`scripts/generate-brand-assets.ts` owns the filled app-icon lockup and all blue
brand variants. The lockup preserves the uploaded optical geometry, including
the larger mark and its downward offset. Files marked as generated under
`assets/brand`, app `public` directories, and `apps/desktop/ui` must not be
edited directly. Run `bun run generate:brand` after changing the static brand
palette or geometry; `bun run check:brand` verifies committed SVG and raster
outputs without rewriting them.

### Semantic color roles

| Role                     | Tailwind/CSS contract                             | Usage                                                               |
| ------------------------ | ------------------------------------------------- | ------------------------------------------------------------------- |
| Canvas                   | `bg-background`, `--background`                   | Application and page background                                     |
| Desktop sidebar          | `.desktop-sidebar-surface`, `--sidebar-desktop`   | Recessed side-by-side navigation glass                              |
| Sidebar space text       | `text-sidebar-space-foreground`                   | Medium-emphasis workspace and space labels                          |
| Sidebar item text        | `text-sidebar-item-foreground`                    | Resting file, folder, record, widget, and navigation labels         |
| Reading foreground       | `text-reading-foreground`, `--reading-foreground` | Long-form editor, Markdown, and documentation prose                 |
| Panel / raised / overlay | `bg-card`, `bg-popover`                           | Content panels and opaque portaled surfaces                         |
| Decorative neutral       | `bg-surface-tint`                                 | Quiet non-status badges, chips, icon wells, and decorative emphasis |
| Selected neutral         | `bg-surface-selected`                             | Current rows, tabs, and selected controls                           |
| Field                    | `.well`, `--well-bg`                              | Inputs and control tracks; always flat                              |
| Interactive field hover  | `.well-interactive`, `--well-hover-bg`            | Quiet fill and border response for editable/clickable field wells   |
| Active control           | `bg-control-active`, `--control-active`           | Flat enabled-state fill for switches and binary controls            |
| Resize handle            | `bg-resize-handle`, `--resize-handle`             | Calm graphite highlight for draggable pane and column separators    |
| Primary                  | `bg-primary`, `text-primary-text`, `ring-primary` | Cobalt actions, links, icons, and focus                             |
| Bronze                   | `bg-accent-bronze`, `.bronze-knob`                | Material details such as presence and annotation dots               |
| Technical notation       | `.inline-code-accent`, `--code-accent-*`          | Primary cobalt for code, commands, and compact hints                |
| Illustration accent      | `*-illustration-accent/<opacity>`                 | Cobalt markers and surfaces inside noninteractive product mockups   |
| Status                   | `success`, `warning`, `info`, `destructive`       | Genuine state and feedback only                                     |

`--accent-bronze-soft` is a deprecated compatibility alias for `--surface-tint`. Do not introduce new internal use.

### Color Rules

- **Cobalt = action and focus.** Primary buttons remain tactile. Links, active text, icons, check marks, borders, and focus rings may use cobalt. Selected-surface fills stay neutral. Noninteractive product illustrations use the explicit illustration accent with an opacity modifier, never the primary role.
- **Bronze = material.** Keep it for details such as presence and annotation dots. Never use it as a general decorative surface tint or primary action. Switch thumbs are flat cobalt controls.
- **Technical notation = primary cobalt.** It shares the primary palette through its generated `--code-accent-*` finish. Use it for inline code, commands, environment variables, compact key hints, and docs tips; it does not imply clickability.
- **Destructive stays red (hue ~22–28).** The primary no longer competes with it — keep it that way.
- **Sidebar text uses semantic hierarchy.** Space labels use `text-sidebar-space-foreground`; resting file, folder, record, widget, and navigation labels use `text-sidebar-item-foreground`. Hover and selected states may rise to the full sidebar foreground or primary text roles.

## Control finishes

Primary keys remain physical objects. Secondary actions and fields are flat neutral surfaces. Utilities live in `globals.css` outside `@layer`:

| Class                 | What it does                                                                                                             |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `.btn-key`            | Primary button finish: shallow rimmed face, layered 2px under-edge and shadow; rises on hover and collapses on `:active` |
| `.btn-key-outline`    | Flat neutral fill, subtle border, no gradient, shadow, or press translation                                              |
| `.well`               | Flat translucent field fill and subtle border, with no inset shadow                                                      |
| `.well-interactive`   | Hoverable field finish using canonical fill and border tokens without changing field depth                               |
| `.bronze-knob`        | Radial-lit bronze circle for material details such as agent and annotation dots                                          |
| `.inline-code-accent` | Primary cobalt ink over a quiet borderless surface for compact technical notation                                        |
| `.overlay-floating`   | Opaque dropdown, popover, context-menu, and floating-toolbar surface with the shared quiet perimeter and low elevation   |
| `.overlay-dialog`     | Dialog elevation and visible modal perimeter; the component supplies its own border geometry                             |
| `.overlay-drawer`     | Full dialog-equivalent perimeter plus direction-aware elevation that casts back into the visible viewport                |
| `.navigation-drawer`  | Opaque mobile-navigation shell surface with its canonical edge border and elevation                                      |

Rules:

1. Only primary buttons use the top-lit key edge, hover lift, and 3px hover-to-press travel.
2. Outline buttons, secondary actions, fields, textareas, selects, checkboxes, and switch tracks stay flat.
3. Editable and clickable field wells use `.well-interactive`; hover changes fill and border through `--well-hover-bg` and `--input-hover`, while cobalt focus takes precedence and disabled, invalid, and read-only fields do not advertise editability. `--field-focus-shadow` provides the mode-aware focus halo for non-Tailwind adapters such as docs search.
4. **Primary shadows are tinted ink, never pure black in light mode** — use `--key-shadow` and do not hand-roll structural shadows.
5. Button sizes: default 40px (`h-10`), sm 36px, xs 32px (dense chrome only — audit before reaching for it), lg 44px. Inputs are `h-10`. Base radius `0.75rem`.

### Action hierarchy

Give each state at most one primary action. Use the primary key treatment for
the path most users should take next. Use a flat outline treatment for a
legitimate alternative, and present lower-priority utilities such as export,
advanced options, or support as links or menus.

Do not render three adjacent actions with equal visual weight. Copy length,
button treatment, grouping, and page alignment must express the intended path.

### Overlay elevation

Portaled surfaces use semantic elevation recipes from the canonical theme: `--overlay-floating-shadow` for menus and popovers, `--overlay-dialog-shadow` for centered dialogs, and directional `--overlay-drawer-*-shadow` values for edge-pinned drawers. They use the same `--overlay-border`, which is deliberately quieter than the general content border. Dialogs and drawers both draw the complete rounded perimeter; edge placement hides the off-viewport portion of a drawer naturally while preserving continuous corner treatment. They additionally use `.dialog-backdrop` and the mode-aware `--dialog-background-clip`: light mode uses a quieter backdrop and composites the perimeter over the dialog surface, while dark mode preserves padding-box compositing. This is an optical correction for the modal context, not a second border color. Product-specific surfaces and third-party adapters must consume `.overlay-floating`, `.overlay-dialog`, `.overlay-drawer`, `.dialog-backdrop`, or those variables instead of adding `shadow-md`, `shadow-lg`, foreground rings, or hand-authored structural shadows. Compact inverted tooltips remain borderless because they communicate transient labels rather than containing interactive surface content.

Application notifications use the shared `Toaster` and `toast` exports from `@worktable/ui/components/sonner`; product code must not import Sonner directly. The adapter preserves Sonner's behavior while applying the opaque popover surface, `.overlay-floating` elevation, semantic status icons, General Sans typography, and shared `xs` button treatment for toast actions.

Mobile navigation is shell chrome rather than a portaled content overlay. It uses `--navigation-surface`, `--navigation-backdrop`, and `--navigation-drawer-shadow` through `.navigation-drawer` and `.navigation-backdrop`. The navigation surface is opaque so nested translucent sidebar roles resolve against the canonical canvas instead of recompositing the dimmed page. App and docs mobile navigation must share this contract.

### Typography

| Font           | Variable         | Usage         |
| -------------- | ---------------- | ------------- |
| General Sans   | `--font-sans`    | Body text, UI |
| Fraunces       | `--font-display` | Headings      |
| JetBrains Mono | `--font-mono`    | Code          |

Body weight: 480 (slightly heavier than normal for screen readability). Long-form prose uses `--reading-foreground`, which is deliberately softer than UI `--foreground`; headings, labels, links, statuses, and syntax colors keep their existing semantic roles.
Letter spacing: 0.015em body, -0.005em headings.

Operational state titles such as empty states, errors, and recovery prompts use the body font at a larger semibold weight. Reserve the display font for major page and artifact headings where its character has enough size and space to read clearly.

## Loading and transition states

Choose the smallest state treatment that preserves the user’s sense of place:

| Scope                 | Treatment                            | Use                                                                                                                     |
| --------------------- | ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| App entry is blocked  | Full transition screen               | Startup, authentication, session restoration, workspace provisioning, or another prerequisite before the app can appear |
| A route is changing   | Top progress line                    | Navigation while the existing application shell remains valid                                                           |
| Content is resolving  | Skeleton shaped like the content     | Lists, documents, panels, and other data regions whose layout is already known                                          |
| One action is pending | Busy state on the initiating control | Saves, submissions, refreshes, and isolated operations                                                                  |

A full transition screen uses the filled Worktable icon, one Fraunces heading, one General Sans live-status line, and one indeterminate cobalt progress line over the faded drafting backdrop. Keep the heading stable. Change the status only when naming a genuinely distinct phase helps the user; do not restate the heading in a second line. Replace progress with recovery actions when the state needs intervention, and honor reduced-motion preferences.

This is a cross-runtime product contract, not a requirement for one shared component. Desktop’s trusted shell is the reference implementation, and the Gateway mirrors it in its self-contained HTML response. Add a shared React primitive only when a concrete React surface needs this full-screen lifecycle; ordinary web route, content, and action loading states continue to use their scoped treatments above.

## Glass System

Glass panes use `backdrop-filter` for frosted blur effects. Three tiers:

| Class          | Blur | Saturate | Usage                         |
| -------------- | ---- | -------- | ----------------------------- |
| `.glass`       | 28px | 1.3      | Sidebar, header               |
| `.glass-heavy` | 40px | 1.4      | Reserved heavy glass          |
| `.glass-light` | 16px | 1.15     | Reserved for lighter overlays |

**Rules:**

- Glass utilities live OUTSIDE `@layer utilities` in globals.css. Tailwind v4 strips unprefixed `backdrop-filter` from `@layer` blocks. Always keep them outside.
- Both `-webkit-backdrop-filter` and `backdrop-filter` must be declared (Chrome needs unprefixed).
- Portaled elements (dropdowns, popovers) cannot use backdrop-filter because they render outside the layout stacking context. Use fully opaque backgrounds for these.
- Mobile navigation drawers are opaque shell surfaces, not glass. Use `.navigation-drawer`; do not apply `.glass-heavy` to navigation.

### Opacity Guidelines

| Surface            | Opacity                | Why                                           |
| ------------------ | ---------------------- | --------------------------------------------- |
| Desktop sidebar    | 72%                    | Needs blur to frost; more opaque = less bleed |
| Cards              | 78%                    | Sits over content; semi-transparent for depth |
| Popovers/Dropdowns | 100% (opaque)          | Portaled, can't blur                          |
| Header             | 75% (via inline style) | Blurs page content scrolling underneath       |

## Scroll Fade

Scroll-aware fade masks that dissolve content at container edges instead of hard clips.

### Vertical (`scroll-fade`)

```tsx
import { useScrollFade } from "@/hooks/use-scroll-fade"

function MyComponent() {
  const scrollRef = useScrollFade<HTMLDivElement>()
  return (
    <div ref={scrollRef} className="scroll-fade overflow-y-auto">
      ...
    </div>
  )
}
```

For `<ScrollArea>` components, use the drop-in replacement:

```tsx
import { ScrollFadeArea } from "@/components/scroll-fade-area"
;<ScrollFadeArea fadeSize={24} className="min-h-0 flex-1">
  ...
</ScrollFadeArea>
```

### Horizontal (`scroll-fade-x`)

```tsx
import { useScrollFadeX } from "@/hooks/use-scroll-fade-x"

function MyTable() {
  const scrollRef = useScrollFadeX<HTMLDivElement>()
  return (
    <div ref={scrollRef} className="scroll-fade-x overflow-x-auto">
      ...
    </div>
  )
}
```

### How It Works

- **CSS:** `mask-image` gradients controlled by data attributes. Default fade: 32px vertical, 24px horizontal.
- **Hooks:** Callback refs (work with conditional rendering). rAF-throttled scroll listeners + ResizeObserver on container and first child.
- **Scroll-aware:** Fade only appears at edges where there's more content. At top of page = no top fade. Scrolled to bottom = no bottom fade.
- **Custom size:** Override `--sf-size` via inline style or the `fadeSize` prop on `ScrollFadeArea`.

### Where It's Applied

| Container                             | Type        | Size |
| ------------------------------------- | ----------- | ---- |
| Main content area (`<main>`)          | Bottom only | 32px |
| Sidebar (via `ScrollFadeArea`)        | Vertical    | 32px |
| Editor and primary artifact scrollers | Bottom only | 32px |
| Thread conversation                   | Bottom only | 32px |
| Doc sidebar (outline panel)           | Vertical    | 32px |
| Tables, code blocks, feature matrices | Horizontal  | 24px |
| Icon picker grids                     | Vertical    | 20px |

### Rules

- **Every scrollable container should have scroll-fade.** If it scrolls vertically, add `scroll-fade` + `useScrollFade`. If horizontally, add `scroll-fade-x` + `useScrollFadeX`.
- **Do not stack a border and fade on the same edge.** The shared header owns the main viewport's top boundary with a quiet bottom border, so `<main>` disables its top fade and keeps only the bottom fade. Nested scroll regions retain both fades unless they have their own explicit edge treatment.
- **Scroll fade CSS lives outside `@layer`** (same Tailwind v4 issue as glass).

## Context Panels

Record details, annotations, and version history use the shared `DesktopContextPanel` shell at `xl` and wider. The shell is inset 12px on every side, uses an opaque paper-like floating surface in light mode and the standard card surface in dark mode, a complete quiet overlay-color perimeter, full rounding, and the shared floating shadow. It consumes layout width rather than covering the artifact.

Rules:

- Persistent navigation panes such as the Threads list remain docked with a quiet divider. They are part of the page structure, not floating contextual inspectors.
- Only one contextual panel is open at a time. Opening annotations closes history and compare; opening history closes annotations.
- Panel content and controls may differ, but surface geometry and elevation do not. Record details keep their wider resizable content width; annotations and history use the compact contextual width.
- The panel shell owns elevation. Repeated annotation and version-history entries are flat rows with quiet separators and selected-state emphasis, not independently raised cards. Semantic record-property groups may retain quiet bordered sections without adding another shadow.
- Version compare is the exception to the single-artifact layout. Its history controls collapse into a narrow floating rail with the same perimeter and inset.
- Below `xl`, contextual content uses a bottom drawer. The drawer owns its border, rounding, shadow, backdrop, and safe-area behavior; do not nest the desktop panel surface inside it.
- Panel headers remain fixed while their bodies scroll. Nested scroll bodies retain edge-aware fades.

## Pane Resize

Drag-resizable panes use the shared primitive: `useResizable` (`packages/ui/src/hooks/use-resizable.ts`) + `ResizeHandle` (`packages/ui/src/components/resize-handle.tsx`). The hook owns pointer-capture drag, px clamping, localStorage persistence, double-click reset, arrow/Home/End keyboard resize, and separator ARIA; the handle renders an invisible 8px grab strip with a 2px neutral graphite bar on hover/focus/drag. Table column resizing keeps its table-owned drag behavior but uses `ResizeHandle` for the same visible affordance.

```tsx
const resize = useResizable({
  edge: "right", // the pane edge the handle sits on
  defaultSize: 288,
  minSize: 220,
  maxSize: 480,
  storageKey: "worktable-sidebar-width",
})

;<aside
  className={`relative ... ${resize.isResizing ? "" : "transition-[width] ..."}`}
  style={{ width: open ? resize.size : 0 }}
>
  ...
  <ResizeHandle
    {...resize.handleProps}
    aria-label="Resize sidebar"
    className="right-0"
  />
</aside>
```

Rules:

- **Suspend width transitions while `isResizing`** or the pane lags the cursor; keep them for open/close toggles.
- **Never bypass the body `data-resizing` mechanism.** It disables pointer events on iframes mid-drag (globals.css); without it a widget iframe under the cursor swallows the pointer stream and freezes the drag.
- The app sidebar, Threads navigation pane, and record-detail panel use it today. Any contextual panel that becomes resizable must adopt the same primitive rather than hand-rolling drag logic.

## Sidebar Patterns

### Hover-to-reveal actions

Action buttons (3-dot menus, plus buttons) on sidebar items show only on hover:

```tsx
<div className="group/space relative flex items-center ...">
  <span className="flex-1 ...">Item name</span>
  <div className="opacity-0 transition-opacity group-hover/space:opacity-100 has-[[data-popup-open]]:opacity-100">
    <DropdownMenuTrigger ... />
  </div>
</div>
```

- Use named groups (`group/space`, `group/doc`, `group/folder`) to avoid conflicts.
- `has-[[data-popup-open]]:opacity-100` keeps the trigger visible while its dropdown is open.
- Trigger buttons: `h-6 w-6`, `rounded-md`, `hover:bg-sidebar-accent hover:text-sidebar-foreground`.

### Collapsible sections

Sidebar sections auto-expand when you navigate into them, but can be manually collapsed even while viewing content inside:

```tsx
const userCollapsedRef = useRef(false)

useEffect(() => {
  if (isInSpace && !expanded && !userCollapsedRef.current) setExpanded(true)
  if (!isInSpace) userCollapsedRef.current = false
}, [isInSpace, expanded])

const handleToggle = (open: boolean) => {
  if (!open && isInSpace) userCollapsedRef.current = true
  setExpanded(open)
}
```

### Alignment

All action buttons (plus icons, dropdown triggers) use consistent right padding: `pr-1` on their wrappers. Section headers ("Spaces", "Documents") also use `pr-1` to align their plus buttons with the row-level triggers.

## Background backdrop

Both modes use the shared unlayered recipe in `packages/ui/src/styles/backdrop.css`: a very low-opacity 24px orthogonal neutral grid in independently masked bottom-left and bottom-right patches, with a quiet neutral wash beneath each patch. Multi-stop masks fade gradually through the full patch so no hard transition is visible. The top and central reading area remain clear. Geometry and mode colors come from `theme-config.ts`, and print removes the backdrop explicitly.

Sidebar rows share `--sidebar-item-radius`; `--sidebar-hover` is deliberately quieter than the selected `--sidebar-accent`. App and docs navigation must use those roles rather than general surface fills.

## Anti-Patterns

- **Don't put `backdrop-filter` in `@layer utilities`.** Tailwind v4 strips the unprefixed version.
- **Don't use `backdrop-filter` on portaled elements.** Popovers, dropdowns, tooltips render outside the DOM hierarchy. Use opaque backgrounds.
- **Don't combine a hard edge and a scroll fade at the same boundary.** Choose the treatment that matches the surrounding surface.
- **Don't use `useRef` for scroll fade on conditionally rendered elements.** Use `useScrollFade` (callback ref) or `ScrollFadeArea`.
- **Don't forget `has-[[data-popup-open]]`** on hover-to-reveal triggers. Without it, the trigger disappears when the dropdown opens.
