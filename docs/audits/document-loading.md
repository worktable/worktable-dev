# Document opening: loading and performance audit

This records the **pre-change investigation**. See [implemented fixes and verification](document-loading-fixes.md) for the current implementation.

**Scope correction:** The browser timings in this first pass start with an already-loaded app shell and use Vite preview. They do not describe full page startup or the app server's actual asset delivery. The [second-pass investigation](document-loading-second-pass.md) traces those paths, identifies the theme/animation/CSS issues, and changes the implementation priorities. Read it alongside this report.

This is an investigation, not an implementation change. It covers the common document route, rich-text and Markdown docs, HTML docs, drawings, legacy links, and failure states. Findings come from source tracing, a production frontend build, browser request/DOM traces, and synthetic API and catalog measurements in a disposable workspace. No existing user documents were modified.

The central problem is that opening a document is composed of several independently gated readers. Each reader has its own loading UI. The common route does discovery and metadata work, but passes only the path into the renderer, which fetches again. Rich-text adds local persistence, editor/schema loading, and collaboration; HTML adds a separate content navigation. Some expensive optional work runs before any content can appear.

## What happens on opening

### Common entry

1. Sidebar, search, record links, and internal document links target `/spaces/:spaceId/documents/:path`. Old `/docs/` and `/widgets/` routes redirect there while retaining search/hash.
2. Router intent preloading can begin on hover/focus. The common route's `beforeLoad` calls `fetchQuery` for `/documents/page`, explicitly using `staleTime: 0` and `retry: false`. This is a freshness check, not a reusable content bootstrap.
3. On cold entry, the root waits for workspace data. The space parent also withholds its child outlet until it mounts and space detail loads. It starts document-list and record-collection queries even when displaying a document child. Shell and document work can overlap, but the outlet has an additional gate.
4. `/documents/page` resolves aliases/conflicts and builds a catalog of the whole space. It reads archive information and page metadata, including freshness/provenance. A space-wide path lock covers resolution and the callback's page assembly.
5. The common route chooses a trusted renderer registration. It passes `spaceId` and `documentPath`, **not the fetched page metadata or content**, to that renderer. Its fallback is `EditorSkeleton` for every format, including HTML and drawings.

References: `apps/web/src/router.tsx:6`, `routes/spaces/$spaceId/documents/$.tsx:17`, `routes/spaces/$spaceId.tsx:545`, `lib/document-renderers.tsx:14`; `packages/server/src/document-query.ts:318` and `:875`, `document-page-service.ts:228`, `doc-path-lock.ts:6`.

### Rich-text docs

1. `DocEditorPage` performs another REST read, `/docs/:path`, with `refetchOnMount: "always"`, `staleTime: 0`, and `retry: false`. It refuses cached content until `isFetchedAfterMount` is true. This protects against a move between the common lookup and renderer mounting.
2. That REST read loads the document, stat, archive, provenance, freshness, links/backlinks, workspace collaboration epoch, document cache epoch and history. For JSON docs it also computes Markdown conversion safety, including an actual conversion/parse round trip and annotation-anchor checks.
3. `BlockNoteDocPage` creates a Y.Doc and opens IndexedDB. The WebSocket provider is created only in IndexedDB's `synced` callback. While waiting, another `EditorSkeleton` is returned.
4. The provider connects and the editor import starts. These two activities can overlap at this point, but the editor import was not started during the earlier REST/IndexedDB waits.
5. `Editor` waits for `worktable-mermaid-block` before creating **any** editor. This module imports CodeMirror and its Mermaid language integration. The full Mermaid rendering engine is separately lazy-loaded when a diagram actually renders; the universal penalty is the block/schema module and its editing dependencies.
6. The editor uses a different centered pulsing loader during schema loading and its mount effect. It then mounts against the Yjs fragment. It does not wait for authoritative server synchronization before showing the editor. With a cold/empty local fragment, an empty editor can appear before text arrives.
7. The server validates room existence and epochs, loads or reconstructs Yjs state, and sends synchronization updates. A cold room may import the portable blocks through the server editor. The REST response's rich-text `content` was already transferred but is not used as the editor's initial display.

References: `routes/spaces/$spaceId/docs/$.tsx:490`, `:789`, `:1325`, `:1461`; `components/editor/editor.tsx:218`, `:231`, `:313`, `:478`; `components/editor/worktable-mermaid-block.tsx:14`; `packages/server/src/routes/docs.ts:825`, `markdown.ts:224`, `yjs-manager.ts:372`, `index.ts:1339`.

### Markdown

Markdown shares the common lookup and mandatory `/docs/:path` refresh. It then renders synchronously through `MarkdownViewer`, without IndexedDB, Yjs, or BlockNote. Individual Mermaid blocks have their own Suspense boundary. This is already a better model for optional heavy content: the rest of the document remains visible.

### HTML

1. After the common lookup, `WidgetDetailPage` performs a mandatory metadata read and requires evidence newer than its mount.
2. Its fallback is the text “Loading HTML doc...”, replacing the shared prose skeleton.
3. A connected space subscription triggers `router.invalidate()` once per mounted HTML route, including an initial connection, producing another common-page validation.
4. Once metadata arrives, the iframe mounts with `/content?theme=…&v=…`. The server reads the HTML and source-bound permissions, injects theme/runtime support, and returns it with a CSP. The iframe remains an opaque sandbox with `allow-scripts` only.
5. There is no parent loading cover tied to iframe content readiness. The frame can look blank while its document, scripts, and brokered record/state requests load. The existing iframe load listener manages navigation-token lifecycle, not presentation readiness.
6. V2 metadata reads themselves resolve through another full catalog build and read HTML bytes to verify source-bound permissions. Page lookup, metadata, and iframe content therefore repeat more than just tiny JSON reads.

References: `routes/spaces/$spaceId/widgets/$.tsx:207`, `:230`, `:403`, `:892`, `:948`; `packages/server/src/routes/widgets.ts:340`, `:459`; `html-document-storage-v2.ts:255`, `:364`; `html-document-path.ts:22`.

### Drawings and unavailable documents

Drawings use the same generic page skeleton, then load Quickdraw, initialize a readonly canvas, fetch `/documents/editable-source`, decode/parse the source, recover a compatible local draft, and reveal its UI. “Opening drawing…” is a screen-reader status; this does not use the rich-text or HTML loading contract. Unsupported formats/conflicts branch into their own download/error presentation after the common lookup.

Reference: `components/drawing-document.tsx:40`, `:67`, `:214`, `:472`.

## Evidence and significance

The production build completed successfully. Sizes below are build-reported gzip estimates, not a claim about production transfer encoding:

| Asset | Minified | Gzip |
|---|---:|---:|
| Main entry | 1,934.87 kB | 567.36 kB |
| BlockNote editor chunk | 1,087.20 kB | 331.00 kB |
| Mermaid block chunk | 632.21 kB | 208.29 kB |

The production main entry contains both `DocDocumentRenderer` and `HtmlDocumentRenderer` and their component bodies, despite the lazy registration. These exported components live in route modules also statically imported by the generated route tree. The build therefore does not provide the intended isolation. Moving renderer implementations out of route files is a concrete bundle-boundary fix; the precise main-bundle savings require rebuilding after that change.

In a production-assets browser trace, a 10-paragraph doc with no diagrams still requested the 208 kB gzip Mermaid block chunk after the editor chunk. The trace showed the prose skeleton, then a different centered loader, then content. A 2,000-paragraph doc showed an empty editor for about one second before the text arrived in the first trace. This is evidence that “editor mounted” and “document visible” are distinct states.

First-opening traces showed two `/documents/page` requests for ordinary docs, consistent with intent preloading followed by navigation's forced refresh. HTML showed three, including the subscription-triggered invalidation, plus metadata and content requests. The extra common-page requests can overlap other work, so their durations must not simply be added together.

A final production-assets browser pass, with no concurrent conversion/catalog benchmark, measured navigation-attempt-to-content confirmation as follows. These include locator/click overhead and intent preloading; server caches were warm, browser context was fresh, and HTML contained no external resources:

| Journey | Time |
|---|---:|
| First rich-text open, 10 paragraphs | 1,094 ms |
| First HTML open | 1,062 ms |
| Markdown, Doc renderer already loaded | 252 ms |
| Rich text, 2,000 paragraphs, editor code already loaded | 2,215 ms |
| Reopen the 10-paragraph doc | 731 ms |

In that final large-document pass, the empty editor appeared at 1,224 ms and text at 2,208 ms. Even the small revisit passed through the prose skeleton and centered loader again. Raw request/DOM timing evidence is retained in [document-loading-evidence.json](document-loading-evidence.json).

Repeated REST reads on loopback, after initial setup, produced these illustrative ranges:

| Request | Four measured runs | Body bytes |
|---|---|---:|
| Rich text, 10 paragraphs | 25, 34, 20, 41 ms | 2,417 |
| Rich text, 500 paragraphs | 370, 295, 181, 255 ms | 104,658 |
| Rich text, 2,000 paragraphs | 833, 795, 831, 808 ms | 422,159 |
| HTML common page | 54, 41, 32, 32 ms | 749 |
| HTML metadata | 27, 18, 20, 18 ms | 570 |
| HTML content | 16, 15, 14, 14 ms | 14,484 |

Standalone calls to the exact `prepareMarkdownStorageConversion` function also took hundreds of milliseconds for large fixtures and roughly a second for 2,000 paragraphs. A cold first call on a small document took over a second because it initialized the server editor. These are separate measurements, not subtractable endpoint subspans, but they corroborate the expensive algorithm in the blocking read path. Instrumentation is still needed to apportion a real request precisely.

Isolated catalog construction, with only small Markdown files and no browser workload:

| Documents in space | First call | Subsequent calls |
|---:|---:|---|
| 10 | 18 ms | 4, 4, 6 ms |
| 100 | 34 ms | 27, 26, 24 ms |
| 500 | 98 ms | 96, 95, 156 ms |
| 1,000 | 220 ms | 187, 170, 169 ms |

This demonstrates that an exact document lookup contains work that grows with space size. Rich inventories and HTML bundles can add more filesystem inspections. Holding the space path lock during this work also makes concurrent reads/writes wait.

The missing-document browser test issued **three 404 requests**. The first returned at 662 ms after navigation began; the final response returned at 2,324 ms. `beforeLoad` catches the first error and removes the query, then the mounted observer fetches again and applies the global one-retry policy. This needlessly delays an already-known error.

These are synthetic local measurements on a shared machine, not production percentiles or a promised speedup. Some exploratory browser and conversion runs overlapped; their absolute timings are illustrative. The deterministic findings are request duplication, serial dependency order, asset sizes, algorithmic work, and loading-state transitions. The browser also reported a service-worker access error in an opaque sandbox during the preview run; HTML content still appeared. Its provenance was not isolated and it is not used to explain the loading delay.

## Recommended changes, in implementation order

### 1. Remove optional work from the open path

- Move Markdown conversion/round-trip validation to the conversion action. If the menu must indicate availability beforehand, calculate it asynchronously and cache by content revision and annotation generation; revalidate during the actual mutation. Do not replace the safe converter with an optimistic guess.
- Load backlinks/links independently of the primary document body. The graph currently reads every doc sequentially on rebuild, uses a global dirty generation, and has no in-flight build sharing. Make invalidation per-space and incremental where possible, share concurrent rebuilds, and do not block opening on it.
- Read document metadata once per request and derive archive/provenance/cache epochs from that snapshot. The current helpers repeatedly parse the same metadata file. Freshness already has revision-aware caching; preserve that rather than introducing another blanket TTL cache.

Expected benefit: directly remove a measured, document-size-dependent CPU cost and keep optional failures from preventing a readable document. This is the highest-confidence first performance change.

### 2. Make one authoritative open response feed the renderer

Extend the common page service into a typed document-open response, containing canonical path, document identity, revision, capabilities and the format-specific initial data. Markdown can include its text; rich text needs collaboration epochs and a display/bootstrap representation; HTML needs metadata and the revision-bound content URL; drawings need their source/revision or a deliberately parallel source load.

Consume that response directly rather than fetching legacy metadata again after mount. Separate speculative prefetch from the current navigation's authoritative validation. Cached content can provide a readonly preview, but a stale cache must not authorize an editor or HTML capabilities. Retain server-side identity/path/epoch validation at WebSocket admission, content serving and writes; handle a move between bootstrap and connection with a canonical redirect/rebootstrap. Revision evidence must survive the entire handoff.

Define one owner for initial validation and reconnect reconciliation. Replace the HTML renderer's unconditional initial `router.invalidate()` with validation based on whether a connection gap or actual revision change occurred. Coalesce hover/click work where it is safe; do not merely delete freshness checks or increase `staleTime`.

Expected benefit: remove one mandatory metadata round trip, duplicated metadata work, and avoidable page revalidation. The reduction is larger on remote connections, but must be measured rather than expressed as a fixed speed multiplier.

### 3. Fix editor loading and bundle boundaries

- Move Doc/HTML renderer implementations out of router files. Keep legacy routes as small redirect-only modules.
- Add explicit module preload functions. Start editor code loading from intent or resolved format, concurrently with data and IndexedDB. Start only code/data prefetch, not a speculative editable Yjs session.
- Register a lightweight Mermaid schema/block component synchronously. Lazy-load the CodeMirror editor and diagram renderer inside that block when needed. Omitting the block schema until a diagram appears risks dropping or misinterpreting collaborative content.
- Keep Shiki initialization off the critical path for docs without code where practical. It starts asynchronously today; it is not the same universal blocking gate as the Mermaid block module.

Expected benefit: eliminate the unconditional 208 kB gzip secondary block load from plain rich-text initialization and overlap the editor chunk with existing waits. Exact byte savings depend on the rebuilt shared chunks.

### 4. Give the document surface one loading contract

Use a persistent `DocumentSurface` with stable header/title and body bounds. Its internal states should distinguish resolving, readable, editable/interactive, recovering and failed. Avoid presenting each internal dependency as a new screen.

- Show at most one visible loading treatment per navigation. Use a brief delayed reveal to avoid flashing for very fast opens; this is a proposed product choice, not a measured threshold.
- Keep existing content visible during background refresh of the same validated identity. For another document, show a known readonly preview or the stable surface fallback.
- For rich text, retain the same cover until authoritative content is ready. A genuinely empty document is ready after sync; a temporarily empty fragment is not. Offer an explicit local/offline mode and failure state instead of waiting forever if IndexedDB or synchronization fails. Do not seed live collaborative state from REST JSON without a reconciliation design.
- For HTML, keep the cover while the iframe loads. Use the trusted injected runtime for a document-ready signal, scoped to the current frame/navigation, and distinguish that from an authored app's later data loading. Provide timeout/error/retry behavior. Keep `sandbox="allow-scripts"`; readiness must not expand iframe authority.
- For drawings, use the same surface until source parsing and snapshot application finish, while preserving local-draft recovery.
- Expose one `aria-busy` region/status announcement and respect reduced motion. Individual diagrams can load locally without replacing the page.
- Start inferred review dwell when content is actually readable. The current rich-text check only tests provider/Y.Doc existence; HTML review eligibility is not tied to frame readiness.

### 5. Stop rescanning the space for every exact read

Maintain a catalog/index keyed by workspace and space generation, with in-flight build sharing and precise invalidation for source changes, aliases, inventory, moves/deletes, and workspace replacement. Resolve an exact target from that index and revalidate the selected source and its ownership. Preserve conflict detection and source-bound HTML permissions.

Shorten the namespace-lock critical section: snapshot canonical ownership/generation under the lock, perform independent derived metadata work outside it, and validate before using results where necessary. A naive TTL cache or removing the lock would regress rename/replace safety. Filesystem reconciliation must account for missed watcher events and reconnects.

### 6. Make failures settle once

Retain a failed navigation result without retaining stale renderer authorization. Do not erase the error and trigger a second observer request automatically. Avoid retrying deterministic 404/409 responses; use bounded retry for transient failures and an explicit retry action.

An additional reproduced edge case: a directly copied, provisional 10-paragraph JSON doc returned `500: Document needs a durable identity before annotations` during the Markdown-compatibility annotation check. Materializing identity through the isolated fixture's normal write path made it readable. Reading should not require an optional conversion-eligibility check to acquire annotation identity. This further supports removing that check from GET.

## Validation required for the fixes

Instrument a navigation ID from user intent through lookup, renderer module, IndexedDB, WebSocket connect/sync, first readable frame and editable readiness. Add server spans for lock wait, catalog construction, source read, metadata/freshness, backlinks and conversion. Collect p50/p95 separately for Markdown, rich text, HTML and drawings, and for first open versus revisit. General page-load metrics alone will miss in-app opens.

Acceptance cases should cover cold/warm opens, remote latency, large documents, large spaces, rapid A→B→A switching, aliases/moves between fetch and mount, concurrent external edits, reconnect/epoch rotation, offline drafts, failed IndexedDB, slow/erroring HTML, unsupported documents, and failed reads. Assert first meaningful content, safe edit readiness, request counts and visible loading transitions separately. Existing collaboration, alias, identity and browser regressions must remain green.

Reproduction used the existing `apps/web/e2e/harness.ts` with storage version 2, raw rich-text fixtures of 10/500/2,000 paragraphs, a small Markdown file, and a static HTML document with no external resources. The frontend was built with `bun run --cwd apps/web build` and served through Vite preview proxying the isolated API. Browser inspection used the shared visible Chrome through CDP. The executable exploration scripts and raw traces were saved under `/tmp/worktable-*-bench*`; this report preserves the relevant results.
