# Solutions for slow document opening

This research follows the [measured opening breakdown](document-loading-timing-breakdown.md). The goal is to improve both first readable content and usable editing. A fast preview followed by seconds of frozen input is not a completed solution.

## New findings from this pass

### Document responses are still uncompressed

The real fixture server returned document JSON without `Content-Encoding`, even with `Accept-Encoding: gzip`. Offline gzip of those exact response bodies produced:

| Paragraphs | Current response body | Gzip of the same body |
| ---: | ---: | ---: |
| 10 | 2,649 bytes | 578 bytes |
| 500 | 104,890 bytes | 3,647 bytes |
| 2,000 | 422,391 bytes | 13,106 bytes |

The prior delivery fix covered static assets, not these API responses. This is particularly relevant on a poor connection. The synthetic repeated-paragraph fixture compresses unusually well; real documents need their own measurements. These are byte measurements, not an end-to-end speedup claim.

**Action:** negotiate compression for sufficiently large JSON/document responses, preserve correct representation headers and private-cache behavior, and measure CPU versus transfer savings. Avoid compressing streaming/socket traffic through an indiscriminate REST middleware. Reuse revision-keyed representations where appropriate rather than repeatedly compressing unchanged content.

### The browser applies the same full stylesheet twice

Chrome's CSS domain returned two author sheets, `/assets/main-s3sQKeml.css#` and `/assets/main-s3sQKeml.css`. Both contained **261,348 characters of identical CSS**, with the same SHA-256. The earlier cache fix avoids a repeat network transfer but leaves both installed stylesheet objects.

A selector-statistics recording also showed selector matching from both copies. For example, BlockNote's empty-paragraph `:has(...)::after` selector and generated descendant-focus rules appeared in both. This makes stylesheet ownership/deduplication a concrete candidate. It does not prove that selector matching explains the entire long style-recalculation event.

The diagnostic recording used 1× CPU and completed at 26.521 s with selector statistics enabled. That instrumentation is expensive and its timings must not be compared to the unprofiled 12.311 s result. Across the tested renderer, recorded selector-matching time was about 1.268 s; broader style/layout work and instrumentation overhead remain. Do not infer that removing `:has()` alone saves nine seconds. [Chrome's selector-statistics documentation](https://developer.chrome.com/docs/devtools/performance/selector-stats) describes both attribution and overhead.

**Action:** give the common stylesheet one owner across the prerendered shell and Vite's dynamic import preloads. Normalize the fragment distinction before insertion, preserving load completion and cascade order. Then profile the editor reveal separately: the current parent switches `visibility`, `inert`, and `aria-hidden` across a large subtree. Test a stable rendering surface with readiness enforced at the editor/focus boundary; do not simply expose an interactive, unsynchronized editor or remove accessibility protections.

A browser-response-interception experiment intended to measure CSS-fragment normalization did not complete its unchanged control within 90 seconds. It produced no valid comparison and is excluded from speed claims. Duplicate-sheet contents and selector attribution were verified in separate successful browser checks. [Research evidence](document-loading-solutions-evidence.json) retains those checks and the failed control. Product code and the served review builds were not changed during this research.

### Some common recommendations do not fit this fixture

The installed BlockNote paragraph renderer already uses `document.createElement('p')`, not a React component for every paragraph. Native spellcheck defaults to false until settings resolve. These are useful things to audit in richer documents, but neither should be sold as an explanation for the plain-paragraph benchmark without evidence.

## Recommended work in this codebase

| Priority | Change | Cost it addresses | Evidence/status |
| --- | --- | --- | --- |
| 1 | Compress document JSON; eliminate duplicate stylesheet application | Poor-connection transfers and repeated browser work | Missing compression and duplicate sheets verified; latency impact needs matched tests |
| 1 | Promote the direct block lookup and empty-annotation fixes into maintainable code | Repeated traversal and unnecessary layout | Combined prototype reduced large-editor median 17.67 → 12.31 s; regression work remains |
| 2 | Return authenticated readable HTML plus a canonical opening envelope | Several seconds before the content request even starts | Small initial-HTML reader prototype reached 0.43 s; full app integration remains |
| 2 | Bound rendering work to sections near the viewport | Styling/layout of thousands of off-screen elements | Strong architectural fit; compatibility/performance prototype required |
| 3 | Incremental catalog and on-demand sidebar inventory | Rebuilding unrelated document metadata | Catalog scaling measured separately |
| 3 | Section-based editor or full virtualization, if simpler changes miss the target | Construction of the entire editable DOM | Larger architectural project; not a configuration switch |

### Initial-response reading and one opening envelope

Return the title, current reading projection, canonical identity, revision, format, archive state, and collaboration epochs in the initial response. Cache/precompute the projection on document changes. Hydrate controls around that surface instead of replacing it with more skeletons. BlockNote supports [server-side processing](https://www.blocknotejs.org/docs/features/server-processing); the repository also has rendering/sanitizing infrastructure in `public-share-renderer.ts`. Private-document authorization and internal-link semantics require their own integration.

For the initial screen, return only the bounded reading projection when the full JSON is unnecessary. Today the preview is bounded to 80 blocks but its REST response still contains the whole document, followed by collaborative state over the socket. Keep projection and editable state distinct. Reducing that duplicate transport is better than merely hiding the second download behind a spinner.

A future bootstrap can include authoritative collaboration state, followed by differential synchronization. Yjs's [state-vector API](https://docs.yjs.dev/api/document-updates) supports exchanging missing updates. The existing provider already uses the Yjs protocol: this is a way to consolidate startup data, not a missing protocol to turn on. Preserve IndexedDB replay, document identity, epochs, offline intent, and move-between-read-and-connect validation. Never turn a truncated reading projection into editable document state.

For HTML, return authorized frame bootstrap data early and register the trusted message broker before the frame parses. For Markdown, serve rendered content without waiting for a rich editor. Authored HTML application scripts/data may have additional costs beyond the parent document-opening path.

### Upgrade or backport relevant BlockNote fixes

This checkout uses BlockNote **0.51.4**. The tagged [0.54.2 implementation](https://raw.githubusercontent.com/TypeCellOS/BlockNote/v0.54.2/packages/core/src/schema/blocks/internal.ts) converts the resolved block node directly, avoiding the old extra block-ID lookup. The [upstream changelog](https://raw.githubusercontent.com/TypeCellOS/BlockNote/main/CHANGELOG.md) also records changed-range block processing and table handles limited to table blocks in 0.54.1.

A supported upgrade deserves a focused compatibility branch. It is not a blind version bump: 0.52 changes collaboration setup to `withCollaboration`, and 0.53 changes the shadcn integration to Base UI. Test schema compatibility, Mermaid blocks, annotations, tables, undo, selection, remote updates, and offline recovery. A targeted maintained backport is an alternative if migration is too broad. No upgrade speedup is claimed without testing.

Keep annotations event-driven, skip work when there are no relevant annotations, cache per-revision block lookup/text information, and batch geometry reads. Avoid scanning the whole model or asking off-screen blocks for geometry every second.

## How other editors handle large documents

### Skip off-screen rendering before attempting full virtualization

`content-visibility: auto` lets a browser defer off-screen style/layout/paint while retaining the DOM; estimated intrinsic sizes preserve scroll extent. It does **not** eliminate JavaScript creation of the nodes. Geometry queries can force skipped work back into the critical path. [Browser-engine explanation](https://web.dev/articles/content-visibility).

Slate's [performance guide](https://docs.slatejs.org/walkthroughs/09-performance) recommends applying this to memoized chunks rather than every individual element; it warns of per-element overhead, especially in Safari. This suggests testing section-sized rendering groups. Slate's chunking API itself does not transfer to BlockNote.

For Worktable, prototype it first in the reading surface, then in editor-supported section boundaries. Do not insert arbitrary wrappers into ProseMirror's managed DOM. Audit annotation positioning, drag handles, selection, IME input, search, print, lists, tables, and screen-reader behavior. `contain: style` is not a selector isolation boundary or substitute for Shadow DOM; containment must match actual layout semantics. [MDN containment reference](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Properties/contain).

### True viewport rendering or section editors

CodeMirror [renders the visible range plus a margin](https://codemirror.net/docs/guide/), tracks estimated/measured heights, and avoids making the entire document into DOM. That is a strong design reference for HTML/Markdown source editing. Its text-editor model does not make it a drop-in rich-text replacement.

The ProseMirror maintainer describes viewporting as outside its core scope and mentions separate chapter editors as a possible structure. These are historical architectural discussions, not a guarantee about every modern extension: [viewporting](https://discuss.prosemirror.net/t/improving-performance-loading-on-scroll/4972), [chapter editors](https://discuss.prosemirror.net/t/different-parsing-strategy-for-large-documents/1017).

A Worktable design could keep the whole logical document while mounting rich editors only for active/nearby sections, with lightweight reading sections elsewhere. That requires explicit cross-section selection, undo, clipboard, keyboard navigation, annotation mapping, search, and export behavior. Yjs [subdocuments](https://docs.yjs.dev/api/subdocuments) provide a possible lazy-loading primitive, but provider support and persistence/room design must be implemented; our single-fragment document cannot be split safely by hiding/removing its model blocks.

### Different editor engines

- **Lexical:** its [custom reconciler](https://lexical.dev/docs/intro) updates changed DOM regions. That is promising for editing updates, but does not establish fast cold creation of our document/schema. Evaluate using the same fixtures and feature requirements before proposing migration.
- **Slate:** documented chunking makes it a useful comparison implementation. Switching would still entail schema, collaboration, annotations, migration, and accessibility work.
- **Canvas rendering:** Google announced [Docs' move to canvas](https://workspaceupdates.googleblog.com/2021/05/Google-Docs-Canvas-Based-Rendering-Update.html). It demonstrates a different rendering architecture, not a package we can adopt to fix this app. Building text layout, selection, input, accessibility, and export is a major product investment.

Tiptap's [integration guide](https://tiptap.dev/docs/guides/performance) notes that React node views are synchronous and can be expensive; isolate editor updates from surrounding React state and use lightweight rendering for simple nodes. In our current fixture the paragraph path is already plain DOM. Focus React-node-view work on actual heavy custom blocks and controls.

## Things that help responsiveness but do not erase the cost

- **Scheduling/yielding:** split application-owned processing into bounded tasks, using feature-detected [`scheduler.yield()`](https://developer.mozilla.org/en-US/docs/Web/API/Scheduler/yield) or a fallback. This cannot safely turn an opaque synchronous ProseMirror update into an asynchronous transaction. `startTransition` alone does not make external DOM work interruptible.
- **Workers:** useful for parsing, search, indexing, and eligible projection preparation; they cannot perform the editor's DOM styling/layout. The previous profile did not identify Yjs decoding as the dominant standalone cost.
- **Prefetch/cache:** warm likely document routes on intent, reuse bounded revision-validated reading snapshots and loaded modules, and avoid fetching all documents on a constrained connection. Revalidate before enabling writes. This improves revisits; it does not solve a brand-new cold link by itself.
- **More code splitting:** keep secondary dialogs/controls off startup, but earlier shell splitting cut entry size 33% without a consistent timing win. Use the request critical path rather than bundle size as the acceptance criterion.

## Decision and validation

Stay with the current editor for the first targeted fixes. Address transport, duplicate CSS, unnecessary traversal, and startup ordering, then prototype bounded off-screen rendering. Escalate to section editors/virtualization only if those changes still leave unacceptable first-input or scrolling stalls. Research supports this sequence; it does not justify promising a percentage gain for an untested rewrite.

Judge reading and editing separately: first readable content, first successful input, maximum main-thread stall, scrolling/selection responsiveness, bytes, and memory. Test cold/warm loads, poor-bandwidth/high-latency profiles, representative short and long rich documents, tables/diagrams, HTML/Markdown, and Chrome/Firefox/Safari. Ensure a rendering optimization does not merely make a last-block visibility test pass while scrolling, search, selection, or editing remains broken.
