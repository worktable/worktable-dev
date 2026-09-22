# Document loading fixes and verification

Implementation follow-up to [the second-pass investigation](document-loading-second-pass.md). Measurements below concern isolated fixture documents served by the **real Bun production server**, not Vite preview, and are not measurements of a deployed tenant or native desktop WebView.

The [critical follow-up](document-loading-critical-follow-up.md) profiles the remaining bottlenecks and measures initial-HTML reading and editor CPU prototypes. It also separates lightweight timing from the visual tracing overhead in this report.

## What changed

The intended cold-opening sequence is now: correctly themed startup logo → shared document skeleton → readable content. Rich documents show a labeled saved preview while the live editor finishes; HTML and Markdown reveal their own content. Client-side document navigation skips app startup. There are still real loading boundaries, but they no longer introduce the tiny loader or the scale-pulsing skeleton.

- The static shell applies the saved/system theme before the body paints. It uses the same default and storage key as React and tolerates unavailable storage. The browser theme color follows that selection.
- The startup animation has its own name. It no longer overrides Tailwind's `pulse` animation with a scale transform. Document fallbacks share `EditorSkeleton`, without the extra wrapper animation, and respect reduced motion. The tiny editor loader is gone. The document route shows its pending state immediately without enforcing a minimum wait.
- Space overview data no longer gates the document outlet. Workspace fetching starts at browser router creation, overlapping document resolution even when prerendered-root hydration skips `beforeLoad`.
- Markdown links to app documents use client navigation. Modified clicks, fragment links, downloads, and external destinations retain browser behavior.
- Rich-document and HTML renderers live outside the generated route tree. Legacy routes contain redirects only, so lazy imports actually split the renderer code. Once the canonical page response identifies the format, renderer and rich-editor downloads start alongside subsequent document REST/IndexedDB work. Markdown and HTML do not download the rich editor.
- The Mermaid schema is available synchronously, including for diagrams received through collaboration. Its UI, source editor, and rendering dependencies load when a diagram appears, instead of blocking every rich document.
- The icon catalog loads definitions on demand. Previously, sidebar and picker imports brought the complete Lucide icon namespace into startup. The explicit `.mjs` entry works in Node SSR; excluding that entry from Vite's dev prebundle avoids turning ordinary icon imports into thousands of shared-chunk requests.
- A non-editable saved preview appears after a fresh, canonical document read. It supports common text blocks and tables; embedded content has a placeholder. Rendering is bounded to 80 blocks and 40 rows per table, avoiding a second full render of large documents. It never initializes or overwrites Yjs. The live editor replaces it when mounted and cached collaboration content or the first server sync is available. Scroll position transfers to the editor. Preview time does not count as an inferred review.
- HTML documents use the same pending skeleton until their markup is parsed. The injected runtime sends a DOM-ready message, checked against the current frame, document identity, and its closure-held navigation token; `load` is a fallback. This separates parsed-markup readiness from the frame load event. External image/font/script assets remain prohibited by the existing sandbox policy; this change is not evidence of an external-resource performance gain. The iframe remains `sandbox="allow-scripts"`; its permissions/navigation checks are retained. This does not claim that arbitrary asynchronous third-party app code has finished initializing.
- Static assets use negotiated gzip, representation-specific ETags, conditional responses, and a bounded cache (32 MiB / 128 entries). Fingerprinted assets are immutable; the shell and unversioned assets revalidate. Cached buffers are invalidated by filesystem identity changes.
- Browser document reads opt out of the expensive Markdown conversion eligibility roundtrip (`conversionCheck=skip`, returning `markdownCompatible: null`). The conversion action still validates content and annotations before committing and displays server refusal reasons. Existing API consumers retain the default eligibility result.
- Concurrent link-graph reads share an in-flight rebuild while retaining generation checks when documents change during construction.

## Correctness boundaries

The canonical-path and post-mount validation gates, document/workspace collaboration epochs, IndexedDB replay ordering, offline edit intent, stale-cache protection, and HTML source-bound permissions remain in place. The saved REST preview is separate from collaborative state.

The initial HTML subscription revalidation remains: removing it casually would reintroduce a move-between-read-and-subscription race. Catalog scans, repeated metadata reads, and the broader server bootstrap shape still have room for improvement. Consolidating those calls needs a revision/identity-aware response contract, not a longer query cache timeout.

TanStack and Vite still produce two stylesheet link elements (`main.css#` and `main.css`). The new asset caching avoids the second network transfer, and the animation-name collision is fixed. A trial Vite dependency-filter workaround was removed because Vite appends CSS dependencies after that hook. No bundler internals were patched.

## Verification

The full project typecheck passed (11 packages), and the production frontend build passed. Focused tests passed: static delivery/link graph (26), document routes and format conversion (24), Yjs persistence/correctness (39), widget/Records correctness (11), and preview rendering (2): **102 tests**.

The existing 10-test browser suite passed. Subsequent targeted reruns covered cold collaboration startup, Markdown client navigation, discovered document formats, and HTML move/archive/navigation security. The added HTML readiness regression passed with the parent's iframe `load` fallback deliberately blocked, proving the real sandboxed runtime's ready message reveals the document. Manual production-browser checks verified first-paint theme behavior for dark/light/system/blocked storage, Mermaid rendering and source editing, and the unchanged `allow-scripts` sandbox.

### Timing method and limits

The comparison rebuilds untouched commit `651d3da` in an isolated checkout and the changed application, then serves each with its own Bun server and equivalent disposable workspaces. Each run starts from a blank page in a fresh visible-Chrome context. There are three samples per version/scenario, with before/after order alternated. Browser storage/assets are cold; the server process and operating-system caches are not reset. No build or test runs overlap the timing runs.

The throttled profile uses 100 ms emulated latency, 10 Mbps download, 4 Mbps upload, and a 4× CPU slowdown. “Editor ready” waits for the final paragraph to be visible in the editor; “preview” is the first sampled readable saved content. HTML readiness waits for its heading and for the outer loading overlay to disappear. These browser observations include automation polling and tracing overhead. They are neither production percentiles nor direct measurements of typing latency.

The machine is shared. Earlier optimized samples were faster, and a later busy period produced much slower results. All three phases are retained in [the evidence](document-loading-fixes-evidence.json); the interleaved comparison is the stronger before/after evidence. No universal latency or speedup guarantee follows from these fixtures.

| Cold opening, three samples per version | Before: median ready (range) | After: median ready (range) | After: median saved preview |
| --- | --- | --- | --- |
| Rich text, 10 paragraphs, local | 3.043 s (2.797–3.112) | 2.877 s (2.760–5.015) | 2.007 s |
| Rich text, 10 paragraphs, throttled | 11.496 s (11.202–11.752) | 9.812 s (7.943–9.973) | 7.024 s |
| Static HTML, throttled | 7.652 s (7.300–9.524) | 5.504 s (5.216–9.335) | — |

The main JavaScript bundle fell from **1,934,874 to 1,256,090 bytes** (35.1% less code). The production server now transmits its gzip representation, approximately **369 KB**, instead of the original uncompressed main bundle. Ordinary rich documents do not load Mermaid's UI/source editor; HTML and Markdown do not load the rich editor. This reduces work but does not eliminate the substantial remaining startup cost.

Observed JavaScript transfer, including resource-timing header overhead, fell from about **3.72 MB to 0.83 MB** for the small rich document and **1.96 MB to 0.40 MB** for HTML. These figures cover this fixture's startup requests, not every feature the app may later load.

Additional runs show the practical limits:

- Earlier optimized rich-document samples had medians of 2.111 s locally and 6.231 s throttled. The later busy-host final series reached medians of 4.719 s and 13.033 s, respectively; throttled HTML reached 12.136 s. These are retained, not replaced by the better paired results.
- Throttled Markdown became readable at 5.777 s and satisfied the ready check at 6.266 s in the final single run, without downloading the rich editor. There is no matched Markdown baseline here.
- A 2,000-paragraph document showed its bounded preview at **10.041 s**, but its full editor took **42.958 s** in the busy-host run. One main-thread task lasted **17.498 s**. An earlier optimized run took 22.586 s, with a preview at 6.371 s. Large-document editing is still too slow; the preview improves access to initial text but does not solve that CPU bottleneck. These are individual runs, not percentiles or a matched large-document comparison.

All 40 retained optimized/comparison browser traces completed their readiness checks with no captured JavaScript page errors. That is functional evidence, not proof of reliable production latency. The raw ranges matter: HTML's slowest after sample was still 9.335 s, and one local rich-text after sample was slower than all three local baseline samples.

The saved preview is illustrated in [this captured browser frame](document-loading-after.jpg). It is explicitly labeled and remains separate from editable collaborative state.

## Remaining work with the highest potential

1. **Large-document editor construction.** The bounded preview makes text available sooner, but mounting thousands of BlockNote/ProseMirror blocks still performs substantial synchronous work. Profile schema conversion, node views, plugins, and layout separately; first remove per-block repeated work, then prototype rendering only the visible region or opening large documents in a paged read view with explicit editing. Any virtualization must preserve selection, search, collaboration positions, and annotations. Download optimizations alone cannot remove this CPU cost.
2. **A smaller startup shell.** The main bundle remains substantial even after removing the full icon definitions and separating renderers. Split nonessential sidebar dialogs, settings, search UI, and record/annotation controls at their interaction boundaries. Keep visible navigation and document rendering in the critical path; verify chunk request overhead under latency rather than assuming more chunks are always better.
3. **One revision-aware document opening response.** Consolidate page discovery and subsequent metadata/content reads into an envelope containing canonical identity, format, content revision, archive state, and collaboration/cache epochs. Renderers should consume it only after validating those identities, with a subscription revision handshake to catch moves between the read and subscription. This can shorten the waterfall without reintroducing the races protected by today's repeated reads.
4. **Measure the actual delivery environment.** Record navigation start, theme application, shell readiness, first readable content, and editor interaction readiness separately in deployed web and native WebView runs. Compare cold and warm contexts, representative document sizes, and slower hardware. Add percentile budgets only once those populations are measured; these fixture runs are not production percentiles.
