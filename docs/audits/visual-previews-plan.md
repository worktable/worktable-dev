# Shared visual previews for agents

Status: historical implementation proposal, prepared 2026-10-01. The implementation that followed is recorded in [Visual preview implementation](visual-previews-implementation.md). The measurements below belong to the earlier disposable investigation and must not be treated as production performance measurements.

## Recommendation

Build one document-preview service and one media-result contract, with adapters for drawings, HTML, and eventually stored images. Use Quickdraw's own Canvas implementation for drawing PNGs and geometry, and the existing sandboxed HTML runtime for HTML screenshots. Run these through a managed Chromium runtime with separate supervised processes for drawing and authored-HTML work. Keep source reads and typed editing tools: pixels supplement structured editing rather than replacing it.

Reuse the existing MCP image delivery path. Preserve the drawing tools, previews, revision checks, dry runs, undo/redo and existing scopes. Add a generic document render action and an HTML convenience action backed by the same service. Do not introduce automatic layouts or a public arbitrary-URL screenshot tool.

The principal exchange is explicit: native drawing code becomes authoritative for PNG and editing geometry, but we take on a browser runtime, a deliberate font distribution, asynchronous geometry preparation, and a read-only HTML execution policy. Legacy SVG still needs separate maintenance until replaced or deprecated. This is more infrastructure than replacing one rendering function. It also provides the foundation for HTML visual inspection.

## What exists and what can be reused

| Existing capability | Reuse | Remaining work |
| --- | --- | --- |
| Quickdraw 0.2.0 `Editor.exportImage()` | Native PNG for whole board or selected IDs, scale, background, margin | Fonts/assets readiness, bounded dimensions, arbitrary crop, explicit asset failures |
| Quickdraw `drawShape`, `localBounds`, `pageBounds` | Shared drawing behavior and measurement | Worker adapter and migration of server geometry consumers |
| Drawing operations, revision/request receipts, undo/redo | Existing editing semantics and persistence | Inject native bounds into geometry-dependent preparation without moving storage authority into the browser |
| HTML theme, SDK injection and host styles | Existing viewer semantics in a minimal preview host | Restricted broker, capture readiness, frozen source/state, diagnostics |
| Document format registry and browser renderer registry | Format dispatch and trust disposition | Narrow code-owned preview adapter registry; no ambient browser authority for arbitrary format hooks |
| Drawing MCP image results | Inline pixels plus structured metadata | Generalize the drawing-specific media helper and schemas |
| MCP stdio, HTTP, HTTP-to-stdio connector | Preserve content blocks | Actual transport and supported-host visual comprehension checks |
| Application-private storage | Optional bounded derived-image cache | Cache identity, access rechecks, eviction; previews must not become authored history |
| Desktop WKWebView | Possible future foreground rendering optimization | It is not Chromium and is unavailable to standalone/headless servers |

Relevant implementation sources: [drawing service](../../packages/server/src/drawing-service.ts), [drawing MCP adapter](../../packages/server/src/mcp/drawings.ts), [tool result assembly](../../packages/server/src/mcp/tools.ts), [format registry](../../packages/server/src/document-format-registry.ts), [browser renderers](../../apps/web/src/lib/document-renderers.tsx), [HTML runtime](../../packages/server/src/widget-authoring.ts), [HTML routes](../../packages/server/src/routes/widgets.ts), [HTML viewer](../../apps/web/src/components/html-document.tsx), [connector bridge](../../packages/mcp-connect/src/bridge.ts), [private storage](../../packages/server/src/app-storage.ts).

## Experimental evidence

The disposable scripts and raw outputs are in `.local-dev/visual-preview-spike/`. The retained [evidence summary](visual-previews-evidence.json) records sample details and qualifications. [Native export with supplied fonts](visual-previews-native-fonts.png) is a synthetic example, not a production Worktable screenshot.

| Observation | Local result | Interpretation |
| --- | --- | --- |
| Browser launch through first native PNG | 394–533 ms, three samples | Small synthetic drawing, existing binary, host fonts, default Playwright launch; first export missed its image, so this is not readiness-correct latency |
| Repeated exports in the same loaded page | 32–75 ms, five samples | Demonstrates reuse potential; excludes fresh job context, font loading and isolation costs |
| Warm browser with a fresh context/page for each job | 203–330 ms, five samples | Includes local viewer load, tracked image readiness, export, transfer and context disposal; uses host fonts and default unsandboxed launch |
| Browser process memory | About 449 MiB summed RSS | Includes multiple browser processes and double-counts shared pages; not unique memory or an incremental per-job measurement |
| Installed Linux headless browser | About 262 MiB on disk | Uncompressed existing headless-shell installation; excludes fonts, system libraries, integration and download compression |
| Supplied-font drawing | CJK, Devanagari, Bengali, Tamil, Thai and color emoji specimens rendered visibly | Arabic/Hebrew already had host fallback; visual inspection is not a full typography or Unicode coverage certification |
| Supplied-font specimen setup | About 867 ms page/setup/font loading; about 38 ms export, one sample | Separate experiment, not directly comparable to host-font cold samples |
| Font files used by experiment | About 52 MiB of deliberately unoptimized font specimens | Includes large CJK and color emoji TTFs; not a recommended production package or comprehensive font set |

Observed native limitations matter:

1. **First image export can be incomplete.** Native export waits for separate image loads, but drawing uses a private image cache. A fresh WebP shape was absent on [immediate export](visual-previews-image-before-ready.png) and visible on [later export](visual-previews-image-after-ready.png). Replace the experiment's delay with a deterministic asset-ready hook or a narrow upstream/package patch. Do not ship a fixed sleep as correctness.
2. **Fonts must load before measurement.** Quickdraw caches text layout by properties. Waiting for fonts after the first layout can preserve incorrect bounds. Explicitly load required faces before loading/measuring the snapshot; use a fresh page per job.
3. **Font coverage and line breaking are different.** Native Canvas shapes the tested scripts with supplied fonts. Quickdraw's wrapping still splits on whitespace; long unspaced CJK text can overflow. Mixed-direction text and language-specific line breaking need dedicated fixtures and, where necessary, small shared Quickdraw fixes.
4. **PNG is native; SVG is not.** The installed Quickdraw package has no equivalent native SVG export. Its native PNG path has a roughly 24-megapixel cap, selection support, and returns null for an empty selection/board. Our adapter still needs stricter model-response limits and explicit empty behavior.
5. **The successful timing experiments used Playwright's default unsandboxed launch.** A separate explicit `chromiumSandbox: true` launch failed on this host with `No usable sandbox!` and SIGTRAP. Host settings were not changed. Production sandbox support is unproven here; never silently disable sandboxing to make authored HTML previews work.

The HTML experiment only established a basic element screenshot. It did not exercise Worktable data authorization, production packaging, agent-host ingestion or adversarial HTML. Those remain implementation acceptance work.

## Tool surface and agent flows

### Surface

Names below describe additions, not currently available APIs.

| Entry point | Proposed behavior |
| --- | --- |
| `worktable_documents_read`, `action: render` | Resolve an existing document and select its preview adapter |
| Existing `worktable_drawings_read`, `action: render` | Retain drawing selection/world-region options and delegate to the same service |
| `worktable_html_read`, `action: render` | Convenience path preserving legacy HTML read scopes |
| Drawing write/dry-run preview | Preserve current options/defaults; render the exact saved or proposed candidate |
| HTML write preview | Initially opt-in; render the exact saved source, independently report save and preview outcomes |
| Future stored-image preview | Use an authorized document/asset locator and the same media result; avoid inventing arbitrary file/URL access |

Generic entry uses `documents:read`; legacy HTML entry keeps `widgets:read`. Both reuse the same underlying document access policy. Records-backed HTML additionally requires caller Records read authority intersected with captured document permissions, including related collections. Preview cannot confer read access on a write-only caller. Report capability/runtime availability before expensive work where possible.

Common options: explicit light/dark theme, bounded viewport/resolution, expected source revision and capture mode. Keep adapter-specific geometry distinct: drawing regions are world coordinates; HTML clips are CSS pixels. PNG is the first interoperable output. One overview is the default; let agents request readable crops rather than emitting many images automatically. Keep `preview: none` for editing batches.

Return JSON metadata and one actual MCP image block. Metadata identifies `saved` versus `proposal`, document/source revision or proposal hash, image content hash, renderer/font versions, pixel dimensions, viewport/theme, capture timestamp, status and diagnostics. Correlate media by content-block index or ID without duplicating base64 in JSON. HTML adds data mode and observation interval/state fingerprint. Status distinguishes complete, partial, failed and unavailable; an image alone must not imply successful loading.

The connector is deliberately tools-only. Inline image blocks and embedded SVG resources work within that contract; do not make `resources/read` a hidden prerequisite. MCP explicitly supports image content, but each external agent host must actually pass it to its model. [MCP tool image contract](https://modelcontextprotocol.io/specification/2025-11-25/server/tools#image-content).

### Read, edit, inspect, correct

1. Agent reads structured drawing objects or HTML source and requests a visual overview.
2. Server authorizes access and freezes the exact source and required state/properties. Expected-revision mismatch returns a conflict rather than silently rendering newer content.
3. Adapter prepares native geometry/rendering in an isolated job and returns pixels plus identity/diagnostics.
4. Agent changes IDs/operations or HTML source. Drawing dry-run can produce a proposal preview without saving.
5. Server commits with existing revision/request-ID guarantees. Optional preview uses that committed candidate even if another edit follows immediately.
6. Agent inspects pixels, requests a region if labels are too small, and corrects or uses existing drawing undo. A preview timeout never changes a successful write into a failed save; retrying preview never repeats the mutation.

### HTML preview

1. Capture exact source bytes, source-bound permissions and starting runtime state under existing synchronization, then release locks before rendering.
2. Load a minimal trusted host and the existing opaque sandboxed HTML frame at the requested viewport. Do not navigate the authenticated document viewer or mark the document human-reviewed.
3. Broker only recognized read operations. Records queries are POST, so an HTTP-method-only allowlist is incorrect. Deny record/state writes, navigation and unsupported operations with diagnostics.
4. Block external network by default at the browser boundary, including frame navigation, redirects and sockets. Reuse CSP as an additional layer. Do not pass session cookies, owner tokens or unrestricted server endpoints into authored JavaScript.
5. Wait for frame readiness, requested fonts, images and initial broker reads; then a short bounded settling interval. Freeze animations for capture. A deadline returns a partial image and pending/error diagnostics where possible.
6. Label Records as live observations during capture. Memoize identical queries in a job, but do not call multiple live reads a transactionally consistent database snapshot.

Default state writes are rejected, including writes during initialization. Some documents will consequently look different or fail to initialize. A future explicit ephemeral-state mode could allow copy-on-write state inside the job, but must label simulated state and still deny real Records mutations. Do not silently invent those semantics in the first implementation.

### Photos and replies

A legitimate stored raster image can use the same media envelope, with passthrough or bounded resize/crop; it does not need a browser page. SVG needs active-content isolation before rasterization. A general stored-image locator/authorization contract is not currently implemented and must precede a broad image-reading tool.

Tool-returned images are separate from photos in Worktable thread replies. The current OpenClaw thread channel and thread message schema are text-only; its first-text parsing is used for participant/thread delivery, not evidence that the external OpenClaw MCP tool host discards drawing images. Thread attachments additionally need storage, permissions, message schemas, sender/receiver integration and UI. Reuse the media descriptor when that feature is built, but do not expand this preview project into rich messaging implicitly.

## Runtime, geometry and fonts

### Browser worker

Use a narrow service-owned worker with packaged local assets. Maintain separate supervised processes for trusted drawing rendering and authored HTML; share the service contract and renderer assets, not a browser process across those trust categories. Reuse each process within its permitted workspace/tenant boundary, create a fresh context/page per job, and dispose it afterward. Private Quickdraw caches and asset IDs must not leak across documents. Browser contexts separate session state; they are not a substitute for OS/process isolation. [Playwright contexts](https://playwright.dev/docs/browser-contexts).

Start with one active local job across the service, bounded queue, timeout/cancellation and idle shutdown; tune limits with representative workloads. Separate on-demand processes mean retaining both drawing and HTML workers can cost more memory than the single-browser measurement. Hosted deployments need tenant isolation, process supervision and explicit CPU/memory budgets. Keep browser startup/rendering outside workspace locks and off the server's synchronous request path. Bound job input, decoded images, output pixels, output bytes and lifetime. Terminate/recycle a hung worker without taking down document storage.

Explicitly enable Chromium sandboxing and validate supported deployment environments. A failed launch reports the affected capability unavailable, with an actionable environment diagnostic; it must not retry unsandboxed. Playwright's `chromiumSandbox` defaults to false. Host requests must have narrow operation authorization, with browser egress blocked independently of authored CSP. A fresh context alone does not contain hostile authored code. [Launch options](https://playwright.dev/docs/api/class-browsertype#browser-type-launch-option-chromium-sandbox).

Production CLI/server builds currently use compiled Bun artifacts, and Desktop uses Tauri/WKWebView. Development Playwright installation is not shipped infrastructure. Prove Playwright/browser discovery and subprocess startup from an actual compiled artifact early; if external driver assets are needed, package them explicitly. Browser/driver versions must be pinned together. Linux library support and macOS signing/notarization of any added executable need explicit packaging treatment. [Browser installation requirements](https://playwright.dev/docs/browsers).

Recommend a managed renderer component included by the normal supported installation path, with an explicit minimal installation option that advertises unavailable previews. Hosted images include it at build time. This favors reliable offline rendering over smallest installation size. First-render download is an alternative, but adds network dependence, first-use failure/latency and version lifecycle work; it should not happen invisibly. Existing-user installation/update migration remains an implementation decision to make concrete before shipping.

### Geometry is part of the migration

Current [server geometry](../../packages/server/src/drawing-geometry.ts) uses our custom font metrics. Its bounds feed drawing reads, region queries, changed-region previews, connector reconciliation after operations, and undo. The browser's [binding adapter](../../apps/web/src/lib/drawing-bindings.ts) already uses native Quickdraw bounds. Merely replacing `drawing-render.ts` leaves these consumers inconsistent.

Extract pure drawing batch preparation from persistence and parameterize its bounds provider. Execute geometry-dependent preparation with native Quickdraw measurements in the drawing worker, returning a validated candidate, measurements and diff. Keep authorization, request receipts, source validation and commit authority in the server. Recheck the expected revision when committing after asynchronous preparation. Preserve sequential binding updates within batches; measuring only the final snapshot can change existing operation semantics. Dry-run and undo must use the same provider.

Cache derived measurements by shape properties plus engine/font version; fixed geometric shapes can keep deterministic pure bounds. Do not persist approximate text measurements as authored truth. If the native measurement service is unavailable, operations requiring it must return an explicit retryable failure before saving. Raw source reads and edits that do not require measurement can remain available. This creates a real availability/latency dependency for some drawing operations, not just optional previews. Avoid concealing it behind silent approximate geometry.

### Fonts

Distribute licensed fonts locally, with versions and explicit script/emoji coverage. Use shared families in the editor and renderer where matching layout matters. Load only faces needed by a job, but keep supported fallback assets locally available for offline use. Account for locale-specific CJK glyph variants and emoji sequences; presence of a character in a font is not proof of correct shaping or line breaking.

This changes today's OS-dependent font choices. Standardizing them can change text width, line wrapping, note height and connector placement in existing drawings. Exercise existing document fixtures and document the visual migration; do not rewrite authored positions merely to hide the change. Keeping system fonts avoids that migration but forfeits cross-machine layout agreement. Recommend deliberate shared fonts because geometry and screenshots must agree.

The experiment used unoptimized Noto specimens, not the final font selection. Optimize distribution/subsetting only against retained script, shaping and emoji-sequence coverage. There is no honest blanket guarantee for every Unicode character. Maintain a supported corpus and useful missing-glyph diagnostics. Font licenses and browser binary notices require distribution inventory; existing web-bundle notice generation does not cover this automatically. [Noto Emoji assets and licenses](https://github.com/googlefonts/noto-emoji), [Noto CJK](https://github.com/notofonts/noto-cjk).

### SVG compatibility

Keep the existing SVG API while explicitly identifying it as the legacy, limited renderer during migration. Make native PNG authoritative for visual inspection. Do not label a PNG embedded inside SVG as vector export. Once all consumers are understood, decide whether accurate SVG merits a separate maintained exporter or a documented deprecation. Retaining SVG also retains some custom-renderer dependencies; remove those only after geometry and all supported SVG consumers are addressed.

## Identity, caching and limits

- Freeze exact source bytes with the existing source-read service. A `?v=` query on today's live HTML content route is only a cache buster, not revision pinning.
- Drawing preview cache keys include workspace/document identity, source or proposal hash, renderer/font version, theme, selection/crop and resolution. Recheck authorization before delivery.
- HTML source revision does not cover permissions, runtime state, Records or external data. Initially retain only individual capture results; do not reuse a source-keyed screenshot as a current dashboard. Record the state/properties fingerprint and data observation interval.
- Historical HTML currently disables scripts. Preserve explicitly labeled static-history semantics. Historical source executed against current data is not historical appearance. Faithful history would require capture artifacts or historical data inputs, which this project does not promise.
- Keep derived previews in owner-private app storage with bounded eviction, outside portable authored data and document history. Initial implementation can use memory-only results until a cache is justified.
- Existing drawing output allows 2048-pixel bounds and up to 12 MiB PNG; the latter becomes about 16 MiB base64 before JSON overhead. Those safety limits are not a proven usable agent budget. Introduce a common transport budget with controlled downscaling and explicit crops, then test actual supported hosts. Large downscaled boards can be technically complete but unreadable.
- Automatic previews cost latency and model image context on every edit. Preserve drawing defaults for compatibility, make HTML previews opt-in initially, and expose standalone render plus `preview: none`. Host-specific image limits and vision costs remain empirical unknowns.

## Alternatives considered

| Approach | Benefit | Compromise / reason not the default |
| --- | --- | --- |
| Managed Chromium for both formats | One browser behavior, native Quickdraw and real HTML | Largest runtime and security-update burden; font distribution still necessary |
| Native Skia Canvas adapter for drawings | Could reuse `drawShape` without a whole browser | Requires Canvas/Path2D/Image/measurement adapter and platform-native packaging; HTML still needs a browser; parity not yet proven |
| Existing Desktop or connected user browser | Avoid additional browser in some foreground sessions | Requires an active UI/IPC bridge, introduces multiple engines and host-font variability, cannot guarantee headless use |
| Improve current custom SVG/PNG renderer | Keeps relatively small, self-contained server | We continue owning shaping, wrapping, emoji, images and geometry parity; newer rasterizer alone does not replace our text-layout logic |
| Remote screenshot service | Small local footprint | Workspace content leaves the machine, needs availability/credentials/network and a separate data-policy story |

Native Skia Canvas is a credible drawing-only alternative, not ruled out technically; its documentation demonstrates color emoji/font registration. It is not installed or adapted here. Choose a bounded adapter spike if Chromium's deployment cost proves unacceptable; do not claim it has already achieved Quickdraw parity. [Canvas implementation](https://github.com/Brooooooklyn/canvas#emoji-text).

## Implementation sequence and concrete completion criteria

1. **Resolve runtime and font feasibility first.** Package a minimal renderer with the compiled Bun runtime; prove sandboxed capture on supported targets; finalize font families, coverage and first-asset readiness. Measure isolated-job latency and resource use. This is the highest-cost architectural uncertainty, before reshaping public APIs.
2. **Generalize media delivery and contracts.** Add shared result metadata/content assembly and render schemas; preserve existing drawing behavior and scopes. Prove a mixed JSON/PNG result through HTTP and packaged stdio connector without duplicate binary data.
3. **Build the preview job service.** Frozen inputs, authorization, native adapters, lifecycle, cancellation, budgets, diagnostic statuses and private derived results. Start without persistent HTML cache. Surface runtime absence explicitly.
4. **Migrate drawings and geometry together.** Share fonts/theme; preserve dry-run, receipts, undo and sequential bindings; native image-readiness hook; world crop via native drawing functions/canvas clipping. Validate empty boards, selection, rotated objects, assets and multilingual bound connectors. Retain SVG compatibility with visible limitations.
5. **Add HTML capture using existing runtime utilities.** Extract common policy/broker parsing, add minimal capture host and settle instrumentation. Reuse read authorization including related Records; prevent persistent mutations, egress and human-review side effects. Add generic render and HTML aliases plus opt-in write previews.
6. **Exercise real agent flows and document remaining limits.** Agent creates/reads/corrects diagrams with multilingual labels, connectors and images; agent creates a Records dashboard and inspects narrow/wide, light/dark previews. Run host-specific visual comprehension tasks. Use findings to refine tool descriptions and defaults. Add stored-image support once its authorized locator is defined; thread attachments stay separate.

Suggested ownership/files: shared request/result types in `packages/types`; new `document-preview-service.ts`, `document-preview-browser.ts` and format adapters in `packages/server/src`; shared media assembly under `packages/server/src/mcp`; minimal preview host beside web rendering assets; geometry preparation shared with the browser worker; runtime distribution in `scripts/build-release.ts`, CLI installation/update paths and Desktop preparation. Extract reusable HTML policy from existing routes and broker code rather than duplicating permission logic.

Acceptance is behavioral, not a test-count target:

- Agent can identify an unpredictable label and relative spatial positions from a tool-returned PNG in each supported host; transport tests alone are insufficient.
- Changing source during capture still yields the requested frozen revision; retry after saved-write/preview-failure does not duplicate edits.
- Multilingual/emoji fixtures show correct pixels and matching bounds/connector endpoints in browser editing, read/query, dry-run, write and undo.
- First export includes fresh embedded images; decode failure is diagnosed; identical asset IDs in different jobs never reuse prior document content.
- HTML on-load state/Records mutations leave persistent data unchanged. Query POST succeeds only within caller and document permissions, including related collections.
- Delayed reads/fonts/images settle or yield bounded partial results. Infinite JS, navigation, redirects and socket attempts cannot escape job policy or stall the server.
- Unchanged HTML with changed state/data is not served as a fresh cached screenshot; access revocation prevents later image retrieval.
- Runtime absence is explicit: preview failure does not undo saved HTML; required geometry failure does not silently commit approximate drawing edits.

## Remaining product decisions and costs

Recommended defaults are stated above so implementation can progress. The choices to validate early are browser distribution for normal versus minimal installations, standardized font families and migration appearance, the supported script/emoji corpus, and the fate of accurate SVG. These are product/runtime decisions, not routine release verification.

Expected ongoing overhead: browser security updates and per-platform distribution; font licenses/versioning and regression corpus; worker memory and cold-start latency; queue contention on small hosts; stricter HTML capture policy than interactive viewing; partial captures for arbitrary asynchronous applications; image payload/model-context costs; and a measurement service dependency for geometry-sensitive edits. Exact compressed installation size, sandboxed fleet resource budget, optimized font size, and supported-host image limits are not yet measured. Do not replace these unknowns with the small local experiment's numbers.
