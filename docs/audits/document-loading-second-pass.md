# Second pass: cold startup, visible loading stages, and delivery

This records the **pre-change baseline**. See [implemented fixes and verification](document-loading-fixes.md) for the subsequent changes and measurements.

The first investigation missed important parts of the experience. Its browser journeys began with the SPA shell already loaded, used Vite preview rather than Worktable's own static server, and counted skeleton elements without inspecting their actual animation keyframes. Those methods exposed some document costs but could not explain the full logo/theme/loading sequence.

This pass uses the production build served directly by `packages/server/src/index.ts`, fresh visible-Chrome contexts, navigation from a blank page, compositor screenshots, DOM/animation sampling, resource timing, long-task observation, and an isolated V2 workspace. The fixture is deliberately small: ten paragraphs with no diagrams, plus a static HTML document with no authored external resources.

The user's exact deployment, device and document URL were not supplied, so these results establish reproducible causes in this checkout, not production percentiles or a claim to have reproduced every stage in the reported order.

## What actually appeared

The throttled rich-text trace recorded the following states. Times are browser DOM observations from navigation start; screenshots and locator confirmation occur on their own schedules.

| Approximate time | Observed state | Owner/reason |
|---:|---|---|
| 0.96 s | Worktable logo on light background | Static shell; no theme class yet |
| 4.25 s | Same logo on dark background | ThemeProvider has applied saved dark preference; root still loading |
| 4.76 s | Two small space-header placeholder bars | Space parent is still withholding its child outlet |
| 4.89 s | Full document skeleton, scaling in size | Shared EditorSkeleton, using the logo's globally named animation |
| 5.67 s | Same skeleton geometry, now opacity-only animation | Later stylesheet insertion changes the winning `pulse` keyframes |
| 8.02 s | Small centered circle/bar loader | EditorLoadingState while Mermaid schema/module setup finishes |
| 9.61 s | Rich-text content in editor DOM | Editor has mounted with content |
| 9.86 s | Final paragraph confirmed visible by browser locator | End of measured opening journey |

[Selected compositor frames](document-loading-cold-sequence.jpg) show the light logo, dark logo, two differently animated document-skeleton states, and small centered loader. The short space placeholder and final content are recorded in the DOM trace rather than those selected frames.

**Remaining mismatch:** this fixture did not show another large skeleton *after* the tiny centered loader. It showed the two full-size skeleton appearances before it. A renderer remount, a different document format/content, a navigation/reconnect, or a different deployed build could produce a different sequence, but none of those has been established as the cause here. An actual URL/session trace is still needed to settle that specific observation. It would be incorrect to claim that the complete reported sequence has now been reproduced.

## Newly confirmed causes

### 1. The logo changes the animation used by skeletons

`apps/web/src/routes/__root.tsx:166` defines global `@keyframes pulse` with opacity **and `transform: scale(1.05)`**. Tailwind's skeleton utility also uses the name `pulse`, whose normal definition only changes opacity.

The browser's computed animation keyframes confirmed the collision: skeletons initially used `scale(1) → scale(1.05) → scale(1)`, then changed to opacity `1 → 0.5 → 1` without changing skeleton component. `EditorSkeleton` applies `animate-pulse` to both its wrapper and individual Skeleton children, so initially both levels can scale. This is an actual style collision, not just a subjective difference between loader designs.

Fix the logo animation name to something scoped, such as `worktable-logo-pulse`, and give document skeletons one intentional animation owner. Reduced-motion behavior must also cover the inline logo animation. Do not rely on stylesheet load order for animation semantics.

### 2. The same stylesheet arrives twice and changes the cascade

The generated shell contains `/assets/main-…css#`. Vite's dynamic-import preload helper later looks for `/assets/main-…css` using exact href matching, fails to identify the existing link, and appends another stylesheet after the inline shell style.

Both DOM links and both network requests were observed. The second stylesheet changes which unlayered `pulse` definition wins, turning the growing/shrinking skeleton into an opacity-only skeleton. No shimmer animation was found on these measured document skeletons.

This isn't merely an accidental string in application code. The installed TanStack Start manifest builder deliberately appends `#` for CSS reached by dynamic imports (`node_modules/@tanstack/start-plugin-core/src/start-manifest-plugin/manifestBuilder.ts:377`), while the installed Vite preload helper compares exact hrefs. Coordinate stylesheet ownership/deduplication at that integration boundary and regression-test route CSS retention/order. Blindly stripping fragments everywhere would be an unverified fix.

The app server delivered the 261,350-byte stylesheet twice in the raw cold run. In the caching experiment, the second use was quick, but a second DOM stylesheet still changed animation semantics. Caching alone does not fix the visual bug.

### 3. Initial theme selection happens too late and follows different rules

The static shell uses `prefers-color-scheme` and starts with no `dark` class. `RootLayoutWithProviders` first returns InitialLoader until its hydration effect runs. Only afterward does ThemeProvider mount, read localStorage, and apply its theme in another effect. Its default is **dark**, unlike the shell's system-based behavior.

With system light and saved/default dark, the first background was light and then changed to dark. The trace confirmed an unthemed light body followed by a dark body while the logo remained visible. The root also uses InitialLoader for router pending state and workspace-query pending state, so the same logo can cover several distinct internal waits.

Resolve the saved preference/default before first paint using a tiny, guarded bootstrap or an equivalent server-readable preference. Use one policy for html/body/background/browser theme color, and make the React hydration contract agree with it. Merely changing `useEffect` to a layout effect would still wait for the large application bundle before correcting the static shell.

References: `routes/__root.tsx:145`, `:578`, `:743`; `components/theme-provider.tsx:83` and `:133`.

### 4. An internal document link can restart the entire app

MarkdownViewer renders ordinary `<a href=…>` elements for internal document links (`components/editor/markdown-viewer.tsx:130`). It resolves the destination correctly, but does not use the SPA router for that link.

A browser experiment clicked a Markdown link to the rich-text fixture. It produced a new main-frame HTML request, changed `performance.timeOrigin`, and erased a sentinel attached to the previous window. Opening completed about 2.66 seconds later on loopback. Thus switching docs through body links can revisit the entire logo/startup sequence, whereas the earlier sidebar-only experiment did not.

Use router navigation for recognized internal document links, preserving ordinary browser behavior for modifier clicks, new tabs, downloads and external links. Audit rich-editor link actions and other entry points separately; the experiment proves the Markdown path, not every link implementation. The existing test named “an internal link settles…” checks rendering/responsiveness and does not actually click the link.

### 5. Preview serving concealed a delivery problem

The real static-file handler (`packages/server/src/static-assets.ts:143`) synchronously stats/reads the file and returns its raw bytes. In the tested direct-server responses there was no Content-Encoding, Cache-Control, ETag or Last-Modified. The static route did not add them.

The cold rich-text trace received **3,719,010 bytes of JavaScript** plus **522,700 bytes of CSS**. The main entry alone was 1,934,874 bytes. The previous Vite preview trace received compressed assets, so its transfer behavior was different.

This finding is about the direct application server. A hosted reverse proxy/CDN might already compress or cache responses; that must be checked against the actual URL before attributing this cost to a hosted deployment.

Serve precompressed gzip/Brotli variants with correct negotiation and Vary headers. Give hashed static assets a long immutable cache policy and keep shell/version selection fresh. Preserve already downloaded code across app navigations. Avoid synchronous per-request file reads through preloaded assets or appropriate file streaming. Verify headers and actual transferred bytes, not build-reported gzip estimates.

## Corrected performance evidence

The “remote” profile simulated 100 ms network latency, 10 Mbps download bandwidth and 4× CPU slowdown on the page. Browser caches were initially empty. The host is shared, the data synthetic, and screenshot/profiling instrumentation adds overhead. These are individual diagnostic runs, not a benchmark suite or predictions for a particular phone.

| Journey | Observed time to content confirmation |
|---|---:|
| Small rich-text doc, full cold page load, direct server, no artificial throttling | 3.90 s |
| Same cold rich-text path, simulated remote/CPU profile | 9.86 s |
| Same profile, temporary gzip + hashed-asset cache delivery proxy | 7.28 s |
| Static HTML, fresh context, same simulated remote/CPU profile | 5.80 s |

The HTML run includes no authored network or data workload; real HTML apps may add their own requests. Its instrumented main page was guarded from injecting storage probes into the opaque sandbox, and the verified run had no captured page errors.

The delivery-only experiment changed no application code. Encoded JS shrank from about **3.72 MB to 1.12 MB**. It reduced one observed cold journey by approximately **2.58 s**. This is evidence that compression matters, not a guaranteed percentage improvement or evidence that delivery fixes alone meet the desired speed.

The rich-text remote resource timeline explains the remainder:

- Main bundle request starts around 0.18 s and takes 2.17 s to transfer.
- First common document lookup does not start until approximately 3.87 s.
- Workspace request starts around 4.22 s, after client setup.
- Legacy doc-content request starts around 5.94 s.
- Editor chunk request starts around 6.21 s.
- Mermaid block chunk request starts around 7.98 s.
- Content appears in the DOM around 9.61 s.

Observed main-thread long tasks totaled approximately 3.61 s in that run. Those tasks overlap the overall timeline and must not be added to transfer times. The point is that a small document's content is downstream of megabytes of code, main-thread execution, shell hydration, and several data/module gates.

The first-pass REST findings remain relevant, especially for large rich-text documents: conversion validation and backlink/catalog work can add server delay on top of this startup path.

## Revised implementation order

1. **Eliminate avoidable full reloads and visual defects.** Route internal document links through the app router; choose theme before paint; scope the logo animation; remove nested skeleton animation; resolve duplicate CSS ownership. These fix specifically observed behavior and preserve the warm app between documents.
2. **Fix asset delivery and initial bundle boundaries.** Verify the real deployment's headers; add compression/immutable caching where absent. Move exported Doc/HTML renderers out of statically imported route modules. Keep legacy routes as tiny redirects. Audit what remains in the 1.93 MB main entry before setting a new size budget.
3. **Make the data path intentional.** Introduce one authoritative open response with canonical identity, revision and format-specific bootstrap data. Start independent workspace/document requests without waiting for avoidable React effect stages. Do not gate a child doc on space overview/list data that the reader doesn't require. Defer backlinks, conversion eligibility, side rails and sidebar decoration. Retain current identity/epoch validation at connection and write boundaries.
4. **Display the document before the full editor is ready.** Provide a lightweight, revision-bound reading representation; load editor code and collaboration in parallel. Keep that representation on screen until authoritative editor content is ready, rather than revealing an empty editor. The initial response can contain both the reading representation and bootstrap metadata so it does not require a new serial request.
5. **Keep heavy optional features local.** Register lightweight Mermaid block schema without importing CodeMirror. Load diagram editing/rendering when a relevant block or user intent needs it. Defer editor-only controls until editing is possible. For HTML, mount the authorized sandbox as early as its bootstrap allows and distinguish frame readiness from authored app/data readiness. For drawings, use a revision-bound thumbnail/preview while the canvas/source initializes if an appropriate preview is available.
6. **Optimize repeated server work.** Remove Markdown round-trip validation from GET; build revision-aware projections once per content change; use an incrementally invalidated catalog with short ownership locks. Combine these with the first audit's safeguards for moves, offline recovery and external edits.

## A faster architecture to prototype

Treat “readable” and “editable” as distinct milestones. A document-opening response should be able to provide a safe, current reading view without first requiring the entire SPA/editor stack to execute.

There is already relevant code in `packages/server/src/public-share-renderer.ts:420`: `renderPublicDocProjection` converts saved rich text/Markdown to sanitized HTML. It is not a drop-in private reader: its public-share sanitizer deliberately removes internal links and its cold server-editor initialization is expensive. Adapt the private-view policy, preserve supported block semantics, and cache the output by document revision/schema version. Generate it as part of a background/write-derived projection, not synchronously on every open.

For a cold deep link, a small authenticated shell could deliver that cached reading view plus essential document metadata before the large interactive application is ready. For an in-app switch, the already-running shell could display a prefetched revision-bound view. Begin editor/schema loading and collaboration alongside it, then replace the reading surface only when live content is ready. Preserve scroll, selection and focus through the handoff; never treat a readonly cached projection as permission to write.

For a warm revisit, use a bounded cache of readonly snapshots and, where worthwhile, recently used editor modules/session state. Avoid keeping unlimited live editors/sockets. Invalidate by document identity/revision/workspace epoch rather than only by path or a long TTL. Resolve stale/moved documents before enabling edits.

The desired user-visible contract becomes **one stable surface → readable content → editing available**, with local loading only for genuinely deferred blocks. Sub-second reading is a design target to validate against realistic latency/content, not a result demonstrated by this investigation. Gzip alone leaving a seven-second cold run makes clear why the reading path needs to be separated from editor startup.

## Experiment limits and next verification

Temporary HTML-response experiments confirmed that prepaint theme selection and a scoped logo animation remove the initial light theme and scaling keyframes. However, those modified-response runs, and a speculative preload experiment, reached an empty editor without completing collaboration before timeout. They are **not successful end-to-end fixes** and their times are excluded from the comparison. Their synchronization behavior was not explained; source-level implementation needs collaboration regression coverage before acceptance.

The exact additional large skeleton after the tiny loader remains unverified. Capture the actual user's URL/build/device and whether entry was sidebar, document-body link, new tab, refresh or resumed/discarded tab. Record first paint, all visible state transitions, each main-frame navigation, request bytes/headers, document-ready, WebSocket sync and editable-ready separately. Measure cold/warm and p50/p95 rather than substituting a fast single localhost run for user experience.

Evidence is retained in [document-loading-second-pass-evidence.json](document-loading-second-pass-evidence.json). The original server-path analysis remains in [document-loading.md](document-loading.md). Only audit artifacts changed in the repository; no application fix was shipped.
