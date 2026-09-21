# Document opening: implementation and acceptance targets

Status: in progress. These targets are not yet achieved or release claims.

The target is readable saved content within 1 second on the controlled normal
profile and 2.5 seconds on a constrained connection, ordinary-document editing
within 2 seconds, and interaction response within 200 ms. Large documents must
remain readable and avoid multi-second interaction freezes. Report first reading
and editing separately; an initial preview is never an editable document.

The normal controlled profile uses a fresh visible Chrome context, 100 ms network
latency, 10 Mbps download, 4 Mbps upload, and 4× CPU slowdown. The machine is shared,
so paired alternating runs and ranges matter. Production field p75 measurements
are still needed. Google's [Core Web Vitals thresholds](https://web.dev/articles/defining-core-web-vitals-thresholds)
provide the external reference (LCP ≤2.5 s, INP ≤200 ms); the reading and editing
targets above are stricter product-specific budgets.

## Stage 1: transport, styles, annotation work

Implemented negotiated gzip for JSON REST responses, explicit root ownership of
the global stylesheet, and skipping annotation geometry polling when there are
no unresolved block-anchored annotations. Compression negotiation and exclusions
have focused regression coverage. The production build passed.

Three alternating cold before/after pairs per fixture did **not** establish an
overall speed improvement. Keep this negative result rather than presenting the
individual fixes as an achieved performance win:

| Fixture / median | Before | Stage 1 |
| --- | ---: | ---: |
| 10 paragraphs: first preview | 3.860 s | 4.204 s |
| 10 paragraphs: editor visible | 5.492 s | 5.700 s |
| 2,000 paragraphs: first preview | 5.395 s | 4.575 s |
| 2,000 paragraphs: editor visible | 16.831 s | 17.211 s |
| HTML: content ready | 5.435 s | 6.644 s |

All 18 runs and their resource/long-task observations are retained in
[document-loading-stage1-evidence.json](document-loading-stage1-evidence.json).
No browser page errors were recorded. The stage-1 results reinforce that asset
delivery fixes alone do not solve the startup and editor critical paths.

## Stage 2: upstream editor and initial HTML

Implementation under validation:

- Align BlockNote core/react/shadcn/code-block/server-util to 0.54.2. Adopt its
  explicit Yjs v13 collaboration extension and lazy dual-theme syntax highlighting.
  Keep the customized mobile toolbar's Radix focus contract separate from the
  upstream default desktop menu implementation.
- Share one bounded saved-preview renderer between the server and browser. A
  direct document navigation can include readable content in the initial HTML,
  before the application JavaScript or collaborative editor is ready.
- Authorize that projection with the normal identity and both navigation/content
  scopes; resolve and read its source in one document transaction. Do not embed
  conflicts, aliases, unsupported sources or unauthenticated content. Responses
  containing private previews are `private, no-store`.
- Limit optional projection latency and source/output size. If the projection
  cannot be produced promptly, continue through the normal app path.
- Keep the initial preview out of query authorization and Yjs state. Preserve
  the existing fresh path checks before mounting the live editor. Hand reading
  position to the validated in-app preview when it appears.

Upstream references: [0.54.2 changelog](https://github.com/TypeCellOS/BlockNote/blob/v0.54.2/CHANGELOG.md),
[node-view block conversion](https://github.com/TypeCellOS/BlockNote/blob/v0.54.2/packages/core/src/schema/blocks/internal.ts),
[changed-range processing](https://github.com/TypeCellOS/BlockNote/blob/v0.54.2/packages/core/src/api/getBlocksChangedByTransaction.ts).

Do not call this stage finished until the production browser verifies hydration,
preview handoff, styles, editing/persistence, menus, Markdown, HTML, authentication,
and repeatable cold/warm timings. The initial server projection currently targets
rich text and Markdown; HTML still needs its own measured critical-path work.

## Measured progress (21 September 2026)

The initial server preview is now implemented and tested with authenticated LAN
navigation, not just the standalone reader prototype. It remains a bounded saved
projection (80 rich-text blocks / bounded Markdown), not a live collaborative view.

**Measurement correction:** stage 1/2 `previewMs` recorded DOM availability and
one animation-frame callback, which can occur before paint. In the stage-2 LAN
sample the initial HTML's actual first-contentful-paint medians were **0.788 s**
(small document) and **0.840 s** (2,000 paragraphs). Do not describe its earlier
0.568/0.649 s callback medians as visible content. Stage 3/4 add a second animation
frame as a conservative paint-opportunity boundary and retain browser paint
entries separately. Field presentation and input timing still need separate work.

### Stage 3: smaller startup and deferred offscreen layout

Split the sidebar and onboarding from the initial app entry; deduplicate Base UI;
use Vite's manifest to discover the selected renderer's static imports early;
apply `content-visibility: auto` to top-level blocks in documents over 200 blocks.
The complete document remains mounted. Print resets containment. Optional
Mermaid/highlighter features are not traversed by renderer preloading.

Entry gzip decreased from 367.04 KB to 259.79 KB; editor gzip from 408.19 KB to
347.86 KB, relative to stage 2. Byte reductions alone are not latency wins.

Three alternating original/stage-3 pairs per fixture:

| Fixture | Original | Stage 3 |
| --- | ---: | ---: |
| Small document reading boundary, median | 4.134 s | 1.144 s |
| Small editor, median | 5.746 s | 5.969 s |
| 2,000-paragraph editor | 16.932 / 18.316 s; one >90 s timeout | 8.659 / 11.002 / 11.433 s |
| HTML ready, median | 4.653 s | 4.520 s |

The timed-out original run is retained in
[stage-3 evidence](document-loading-stage3-evidence.json). Do not silently exclude
it to claim an original median from three successful runs. All completed runs
recorded zero browser page errors. Early preloading competed with initial reading;
this was a regression against stage 2's first paint and motivated stage 4.

### Stage 4: prioritize reading and remove unrelated startup work

Renderer preloads now use low priority after an initial paint opportunity. Closed
settings, space/collection/drawing creation dialogs load on demand. Dialogs retain
their existing mounted lifecycle after first opening. Space overview document and
collection queries start on the overview rather than in every child document page.
The editor is constructed after its first usable Yjs state (cached or first sync),
while the saved preview remains available.

Three alternating stage-3/stage-4 pairs, same controlled profile:

| Fixture / median | Stage 3 control | Stage 4 |
| --- | ---: | ---: |
| Small document reading boundary | 1.142 s | 0.787 s |
| Small editor ready | 6.078 s | 6.093 s |
| 2,000-paragraph reading boundary | 0.980 s | 0.950 s |
| 2,000-paragraph editor ready | 9.119 s | 8.912 s |
| HTML ready | 5.036 s | 4.460 s |

[Stage-4 evidence](document-loading-stage4-evidence.json) retains all 18 runs.
The extra Yjs gate has not established a meaningful additional editor-speed win.
Small editing remains well outside the 2-second target, and HTML remains slow.
Do not present early readable content as completion of editing or HTML work.

### Correctness evidence so far

- Production build and project typecheck passed after the upstream upgrade.
- Server serialization/Yjs/Markdown/Mermaid regression rerun: 139 passed.
- Opening authorization/escaping, compression and manifest tests: 11 passed.
- Canonical document browser suite: all six tests passed on stages 3 and 4,
  including a 5,000-block cold sync, internal links, malformed historical links,
  resizing, mobile navigation/new-space dialog, and Markdown SPA navigation.
- Production manual checks: edit at the end of a 2,000-block document, undo, redo,
  flush/save/reload; mobile text selection, color formatting, focus and persistence.
- The 5,000-block browser test keeps trace screenshots/network evidence but disables
  trace DOM snapshots, which force style reads throughout skipped subtrees and
  distort this regression. It still verifies first and last paragraph, actual
  scrolling, editable content, completed sync and responsive event-loop turns.

Work remains: constrained-network and warm measurements, actual input latency,
HTML critical-path work, rich-block menus/diagrams, and a cheaper editor reveal.
Cross-browser and deployed hosted-delivery validation are not yet established.

### Warm loads, constrained network, and input diagnostics

A separate single-pass matrix used the same isolated stage-4 production fixture.
Constrained means **400 ms latency, 1.6 Mbps down, 0.75 Mbps up, 4× CPU**. Warm
means same-context reload after the cold opening (HTTP cache and IndexedDB warm).
These are diagnostic samples, not medians or field percentiles.

| Fixture | Normal cold / warm ready | Constrained cold / warm ready | Constrained cold saved-reading boundary |
| --- | ---: | ---: | ---: |
| 10 paragraphs | 5.114 / 3.555 s | 10.847 / 3.828 s | 2.198 s |
| 2,000 paragraphs | 8.686 / 5.311 s | 15.801 / 5.859 s | 2.269 s |
| Markdown | 4.871 / 2.490 s | 8.226 / 3.208 s | 2.481 s |
| HTML | 4.541 / 2.598 s | 14.021 / 3.630 s | No initial HTML-content preview |

Typing and undo succeeded without page errors in every rich-document check.
Automation-to-next-paint-opportunity after a character was 79–138 ms for small
text and 159–293 ms for large text. **This is not INP.** Browser Event Timing also
recorded slower click/keyboard interactions: maximum recorded durations reached
232 ms for small text and 600 ms for large text. The 200 ms interaction target is
therefore not established. See [raw reading/input evidence](document-loading-stage4-reading-input-evidence.json)
and the reproducible [fixture measurement script](document-loading-experiments/measure-reading-and-input.mjs).

### Rejected reveal experiment

Replacing inherited visibility with opacity while retaining inert/readiness guards
did not reliably help: six alternating controlled 2,000-paragraph openings gave
8.274 s visibility versus 8.499 s opacity medians. The product change was reverted.
[Reveal evidence](document-loading-reveal-evidence.json) includes the valid runs
and notes the earlier invalid style-injection attempt; it supports no speed claim.

### Next measured changes

The router's root SPA hydration path inherits a **500 ms minimum pending hold**
from TanStack Router. Override the root hold to zero while retaining the existing
hydration-independent initial tree. ThemeProvider also re-applies the prepaint
bootstrap theme on mount, inserting a global transition override and forcing a
style read; skip that work when the resolved theme is already applied.

The build's dynamic icon picker turns ordinary static Lucide imports into dozens
of separate small files. The HTML renderer's initial preload graph contained 32
files, followed by more sidebar imports. Consolidate only explicitly imported
icons into a shared chunk, keeping the remaining dynamic catalog lazy. Validate
output size, request count, hydration, icon picking, and constrained latency before
claiming an improvement. Stage 5 is not yet measured.

### Stage 5: fewer startup requests and no forced logo hold

Implemented the root pending-time override, redundant-theme-update guard, and a
shared chunk for statically imported icons. React and the Lucide factories have
independent shared chunks so the icon chunk cannot accidentally pull the editor
into HTML/Markdown routes. The first attempted grouping exposed exactly that
cycle in the manifest; it was corrected before serving a review build.

The final manifest keeps the editor out of HTML and Markdown static dependency
graphs. HTML's renderer preload graph fell from 32 files to 18. Its measured cold
JavaScript requests fell from 66 to 24 in the paired constrained test. The shared
icons are 11.42 KB gzip; the full picker catalog remains lazy.

Two alternating constrained pairs per fixture (4× CPU):

| Fixture | Stage 4 | Stage 5 |
| --- | ---: | ---: |
| Small editor | 10.259 / 10.884 s | 8.311 / 7.601 s |
| 2,000-paragraph editor | 16.125 / 16.434 s | 13.555 / 13.222 s |
| HTML ready, top-page throttle only | 8.154 / 8.030 s | 6.138 / 6.103 s |

[Raw stage-5 evidence](document-loading-stage5-constrained-evidence.json).
**HTML measurement limitation:** the sandboxed iframe's own response took only
66–84 ms despite the 400 ms top-page setting. It did not inherit that CDP target's
network throttle. Earlier HTML rows using that method are optimistic for the full
constrained path; their app-startup comparisons remain useful, but they are not a
complete constrained-network acceptance test. A fixture-only HTTP proxy check now
covers both parent and iframe requests and explicitly verifies the frame delay.

Nine canonical browser tests passed (document behavior plus self-managed/Cloud
Settings compositions); 21 focused checks passed; the expanded opening security
suite separately passed all seven cases. Full project typecheck and production
build passed. A production rich-block check verified a rendered Mermaid diagram,
table input/undo, deferred Settings, and actual syntax-token color changes in light
and dark themes, with zero console/page errors. It caught and fixed an upstream
highlighting-default change: light mode now explicitly selects `--shiki-light`.
See [rich-block evidence](document-loading-rich-blocks-evidence.json) and
[screenshot](document-loading-rich-blocks.png).

The independent proxy check passed: both parent and iframe used the constrained
HTTP path, with measured frame response completion at 458–479 ms. Two alternating
pairs gave **7.644 / 7.580 s** for stage 4 and **5.823 / 5.723 s** for final stage 5,
with no page errors. This supports the startup/delivery improvement but still
misses the target. Proxy scheduling differs from CDP; compare these pairs with
each other, not their absolute durations with the CDP table.
[Proxy evidence](document-loading-html-proxy-evidence.json).

Current validated LAN build:
`http://192.168.2.211:39085/spaces/loading-audit/documents/rich-10`.
The review password is unchanged and is deliberately not stored in this report.
Use the sidebar for the 2,000-paragraph, Markdown, HTML, and rich-block fixtures.
The workspace is isolated from real user documents.
