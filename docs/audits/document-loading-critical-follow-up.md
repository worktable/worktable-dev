# Document loading: what the first fixes missed

The changes in `4eb2adf` fix real delivery and loading-state defects, but **they do not make cold document opening fast enough**. The largest mistake was putting the readable preview behind the same application startup waterfall we needed to escape. This follow-up profiles the remaining work and tests three alternative approaches. The experiments are separate from the application implementation.

## Open and inspect it

For review from another computer on the LAN, use the network listeners: [current application](http://192.168.2.211:45747/spaces/loading-audit/documents/rich-10), [reading prototype](http://192.168.2.211:45551/rich-10), and [editor prototype](http://192.168.2.211:43009/spaces/loading-audit/documents/rich-2000). The application listeners use password-protected copies of the fixture workspaces; the temporary review password was provided in the conversation, not committed here. Login and document rendering were checked through these LAN URLs. The original loopback URLs below remain for same-machine access.

These local servers were left running for review. They contain disposable fixture documents, not the user's workspace:

- [Current saved application](http://127.0.0.1:45747/spaces/loading-audit/documents/rich-10), including sidebar links to Markdown, HTML, and 500/2,000-paragraph rich documents.
- [Initial-HTML reading prototype](http://127.0.0.1:45551/rich-10). This deliberately has no editor or application chrome. [Large-document version](http://127.0.0.1:45551/rich-2000) shows only the first 80 blocks.
- [Experimental editor optimization](http://127.0.0.1:43009/spaces/loading-audit/documents/rich-2000). This has two isolated editor changes described below; it is not the regression-tested production implementation.

The current app was verified in visible Chrome over CDP. The integrated preview panel opened, but its automation navigation/snapshot calls failed; that panel is not the basis for the browser verification. Local URLs last only while their server processes run. [Saved scripts](document-loading-experiments/README.md) allow the fixtures and experiments to be recreated.

## What was missed

1. **The preview starts too late.** It still requires the app bundle to execute, router setup, canonical page resolution, the document renderer, and a content request. A preview helps only after these gates. Moving it earlier within React cannot eliminate app startup.
2. **Large-document costs were identified too broadly.** Calling this “editor mounting” hid two specific causes: a repeated document search for each block view, and annotation layout work even with no annotations.
3. **Tiny workspaces concealed server scaling costs.** Document handle resolution rebuilds a catalog; the sidebar also requests document/widget inventories across spaces. Document size and workspace size are separate performance dimensions.
4. **Visual diagnosis and timing were mixed.** The earlier tracer sampled `main.innerText` on animation frames and captured screenshots. Reading `innerText` can force layout. That instrumentation is useful for the logo/skeleton sequence but unsuitable for the primary speed comparison. See [MDN's explanation](https://developer.mozilla.org/en-US/docs/Web/API/Node/textContent).
5. **Bundle size was too easy to treat as the goal.** A new shell experiment removed about a third of the entry bundle without delivering a consistent opening-time improvement.

The observed pre-fix light logo → dark logo → changing skeletons was real. Its owners and CSS collision are documented in the [second-pass trace](document-loading-second-pass.md). The [implemented fixes](document-loading-fixes.md) address those defects. This follow-up addresses why the wait remains substantial after those fixes.

## Measured experiments

Fresh visible-Chrome contexts; 1280×900; 100 ms emulated latency; 10 Mbps down / 4 Mbps up; 4× CPU slowdown; production static assets from the real Bun server. Server/filesystem caches are warm and the host is shared. Chrome's CPU multiplier is relative to this host, not a simulated physical phone. Each headline comparison has three samples per version with order alternated. No screencast or per-frame text extraction runs during these measurements.

| Milestone | Current application | Experimental alternative |
| --- | --- | --- |
| First visible paragraph, 10-block doc | **4.671 s** median; 4.561–5.405 s | **0.430 s**; 0.400–0.603 s, initial-HTML reader |
| Last paragraph present in 2,000-block editor | **17.670 s**; 16.940–18.414 s | **12.311 s**; 11.385–12.935 s, two editor optimizations |

The first row compares the same visible-paragraph milestone. It demonstrates a much faster path to reading, **not** a 0.43-second full app or editor. The prototype renders a bounded saved projection into initial HTML, makes no browser JavaScript requests, and omits app chrome. It still fetches canonical identity and saved content from the existing API on the server. It has no production private-route authentication integration, hydration, rich embed support, or live editing.

The second row is approximately a **30% reduction in editor opening time**, with essentially unchanged entry-bundle size. The two changes were measured together; this does not allocate the gain between them. Last-block visibility establishes completed rendering, not typing latency or collaboration correctness. Twelve seconds remains unacceptable for an ordinary opening experience.

Do not compare this 17.7-second baseline with the previous 43-second busy-host trace and call the difference an improvement. Instrumentation and host load differ. All samples, exclusions, resource timelines, and CPU attribution are saved in [the evidence](document-loading-critical-evidence.json) and [CPU summary](document-loading-experiments/cpu-summary.json).

### 1. Put reading in the initial response

In a separate CPU-profiled current-app load, requests started approximately as follows:

| Work | Start after navigation |
| --- | ---: |
| Main JavaScript | 0.143 s |
| Workspace request | 1.275 s |
| Canonical page request | 1.390 s |
| Document renderer JavaScript | 2.135 s |
| Rich editor JavaScript | 2.962 s |
| Saved document content | **3.247 s** |

The content request starts several seconds into loading even on a local server. The strongest change is to make a cold document URL return authenticated, canonical, revision-bound readable content with its initial HTML, rather than return only an app loader.

Proposed implementation:

- Resolve authorization, canonical identity, format, revision, archive state, and workspace/document epochs at the document request boundary.
- Return a correctly themed document header and saved reading projection, plus one serialized opening envelope containing the metadata the client otherwise rediscovers.
- Generate/cache projections by committed content revision and renderer version. Invalidate on writes, external edits, moves, and relevant epoch changes. Avoid adding an expensive full conversion to every open request.
- Hydrate around the existing content. Load navigation controls and editing code independently. Reuse the opening envelope rather than immediately refetching everything.
- Bind subscriptions to identity/revision and revalidate at the connection/write boundary. A document moved between response and subscription must not receive stale-path edits. Saved HTML must never seed collaborative state.

There is existing server-rendering infrastructure in `packages/server/src/public-share-renderer.ts:420`. Its sanitizer/renderer can inform the implementation; its public authorization and link policy cannot simply be reused for private documents. BlockNote also documents [server processing](https://www.blocknotejs.org/docs/features/server-processing).

For huge documents, background editor mounting can still freeze a readable page. Remove the measured CPU defects first, then evaluate an explicit Edit transition or bounded rendering. Opening a preview and immediately blocking the main thread for seconds is not a completed solution. A read-first product default requires a deliberate UX choice.

### 2. Remove repeated block searches and empty annotation work

The installed BlockNote 0.51.4 implementation obtains the block node from its position, reads its ID, then calls `editor.getBlock(id)`. That performs another document traversal. Creating every node view repeats this process: roughly quadratic work across a flat document.

Relevant installed sources are `@blocknote/core/src/schema/blocks/internal.ts` (`getBlockFromPos`), `schema/blocks/createSpec.ts`, and `api/nodeUtil.ts`. Upstream main already converts the resolved node directly in [getBlockFromPos](https://raw.githubusercontent.com/TypeCellOS/BlockNote/main/packages/core/src/schema/blocks/internal.ts). That supports a targeted backport or carefully tested upgrade; it is not proof that an arbitrary published upgrade is compatible.

Separately, `AnnotationBadges` in `apps/web/src/components/editor/editor.tsx:723` reads container geometry, materializes/flattens the editor document, and updates state before knowing whether there are annotations to display. It runs immediately and every second. The experimental fix exits before installing that work when there are no unresolved block annotations.

A baseline CPU profile attributed about **2.31 s self time** to annotation updating and **2.38 s inclusive time** to the block-ID lookup. Inclusive stack costs overlap and must not be added indiscriminately. The annotation cost includes synchronous geometry/layout work; the profile does not isolate every statement. The full profile took 14.804 s and is diagnostic, separate from the unprofiled comparison.

The isolated Vite transform tests direct node conversion plus the empty-annotation exit without modifying installed dependencies. Its initial prerender failed because the temporary output directory could not resolve a server dependency; the test server uses the unchanged production shell with the prototype entry filename substituted. Browser opening succeeded, but this is not a clean production build or a release-ready dependency patch.

A production implementation needs coverage for nested blocks, tables, diagrams, selection, drag/drop, undo, annotation reanchoring, remote edits, offline recovery, and epoch changes. For nonempty annotations, follow up with event-driven/batched geometry updates instead of unconditional polling and repeated whole-document scans.

### 3. Stop rebuilding workspace inventories during an open

`packages/server/src/document-query.ts:318` builds a fresh catalog for a query context. `useResolvedDocumentHandle` prepares reads through this machinery. `document-catalog.ts:568` merges aliases, legacy claims, and filesystem inventory with ownership checks. This is enumeration/identity work, not necessarily parsing every document body.

An isolated benchmark pre-created Markdown documents and called the real catalog builder four times at each size, without a live watcher:

| Documents in space | Warm median of last three builds |
| ---: | ---: |
| 10 | 7 ms |
| 100 | 22 ms |
| 500 | 95 ms |
| 2,000 | 395 ms |

These are catalog-only measurements, not total open times. The first live-server scaling experiment was confounded by writing thousands of files while watchers reconciled them and is excluded from these results.

Use a generation-aware catalog/index with incremental invalidation and coalesced rebuilds. Share one validated handle through an opening request. Preserve alias/conflict/path checks and locking; a TTL cache that bypasses validation is not equivalent. Split sidebar space summaries from expanded-space inventories: `/api/spaces` currently bundles docs/widgets for every space in `packages/server/src/routes/spaces.ts:32`.

### 4. A smaller shell is secondary, not sufficient

Lazily importing the entire sidebar and onboarding reduced raw main JavaScript from **1,256,090 to 839,015 bytes** (33%). Two rich-document pairs were inconsistent: 6.700 → 7.753 s, then 5.653 → 5.526 s. Corrected HTML repeats also varied substantially on the shared host; the evidence retains them. The shell fixture had fewer documents, another limitation. There is no reliable measured win to claim here.

The main entry still includes React DOM, a roughly 123 KiB generated icon-import catalog, sidebar code, notifications, settings, onboarding, and utility/schema code. Split closed dialogs and secondary controls at interaction boundaries, but judge changes by the critical request chain and readable/interactive time—not entry bytes alone.

Moving Yjs into a worker is also not the first intervention supported by this profile. Yjs source self time was about 210 ms; repeated traversal, node views, and layout consumed seconds. A worker cannot remove DOM work on the main thread.

## HTML and a consistent loading experience

HTML already avoids downloading the rich editor, but still waits for app startup, canonical resolution, renderer setup, content, and frame readiness. Give it the same early opening envelope. A small message broker can mount the authorized sandbox before the full sidebar/application initializes, registering handlers before the frame parses.

Keep the existing sandbox, source-window checks, navigation token, document identity/generation checks, and permission validation. Do not replace parsed-content readiness with arbitrary delays or trust a ready message from an unrelated frame. Static markup ready and an authored HTML application's asynchronous data ready are separate milestones. The rich-reader prototype does **not** measure this HTML architecture.

The desired visual contract is one stable, themed document surface: readable content appears in place; editing and optional blocks become available locally. Eliminate whole-page replacements between route pending, renderer loading, provider synchronization, and iframe setup. Keep title/content width/scroll position stable; transfer focus and selection intentionally. During warm navigation, retain the shell and use revision-bound prefetching. Local cached previews must be labeled and validated before editing is enabled.

## Implementation order and acceptance

1. Promote the two measured editor fixes into maintainable source/dependency changes and run collaboration/annotation regressions. This has demonstrated impact without redesigning the whole product.
2. Build the authenticated initial-response reading path and shared opening envelope, with HTML mounting through an early trusted broker. This is the largest demonstrated opportunity for cold reading.
3. Add generation-aware catalog reuse and load sidebar inventories on demand. Benchmark document size and workspace size independently.
4. Re-profile large-document editing. Only then choose bounded/virtualized rendering or an explicit editing transition; avoid assuming a library upgrade, workers, or more lazy imports will solve it.

Record navigation start, first readable content, editor mounted, provider ready, and first successful input separately. Keep lightweight timing separate from visual tracing. Test cold/warm reloads, in-app navigation, HTML/Markdown/rich content, 10/500/2,000 blocks, and 10/100/500/2,000 documents per space. Exercise saved/system theme and reduced motion. Subsecond cold reading is supported as a prototype target under this chosen profile, not yet achieved in the full app. Establish production p50/p95 and real-device behavior before making user-facing promises.

The application implementation remains `4eb2adf`; this follow-up saves the investigation, evidence, and runnable prototypes. It does not claim the architectural changes are already shipped.

Final visible-browser smoke checks confirmed the current app rendered its last fixture paragraph, the reader rendered with zero script elements, and the experimental editor contained all 2,000 blocks and accepted typing followed by undo. No page errors were captured. [Check results](document-loading-experiments/browser-checks.json) and a [reader screenshot](document-loading-experiments/reader-proof.png) are retained. These are smoke checks, not the collaboration regression coverage required to promote the prototype. The saved JavaScript scripts passed syntax checks; the TypeScript experiment files parsed successfully.
