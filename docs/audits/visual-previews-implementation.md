# Preview implementation

> Historical report. See the [archive index](README.md) for dates, source revisions, current status, and reproduction limits.

Implemented on 2026-10-01, merged in `56dc83f`, and released with Worktable 0.1.14. This supersedes the open implementation choices in the [planning investigation](visual-previews-plan.md).

## Implemented behavior

- Drawing PNGs, text geometry and bound-connector updates use Quickdraw's actual Canvas engine. Reads, queries, sequential edits, proposals and undo/redo share its measurements. Geometry-dependent writes fail before saving if the native renderer is unavailable. Title and ordering changes do not require a renderer. New or changed image bytes require browser decoding before save, including unused imports and writes with previews disabled; unchanged image bytes and removals do not.
- The editor and native renderer share versioned fonts and theme tokens. General Sans is the default sans-serif family, with script/emoji fallbacks and explicit drawing font choices preserved. Opening and saving drawings do not wait for fonts: the editor displays available fallback text, loads browser-selected faces on demand, and invalidates cached text measurements as fonts arrive. Native captures wait for the faces selected by actual text/font runs, not the full collection. The Quickdraw patch provides grapheme-safe wrapping, text-cache invalidation, a shared decoded-image cache and explicit export failures for missing/broken images. The editor hides Quickdraw branding through its supported option.
- Generic document rendering supports drawings and HTML at the current source revision; other document formats report unavailable previews. It and the HTML convenience action return inline MCP PNG content with structured revision, dimensions, renderer/font identity, capture status and diagnostics. Bytes appear once, outside structured JSON. Drawing-specific selection, world-coordinate crops and object labels remain available.
- Drawing writes and optional HTML write previews capture the exact saved candidate. Failed preview generation does not undo a successful save; callers retry rendering separately. Unsaved drawing proposals are identified as proposals. Existing revision checks, request receipts and targeted undo/redo remain authoritative.
- HTML uses the existing theme, host styles and widget SDK inside a fresh sandboxed frame. Source, permissions and widget state are frozen. A restricted broker permits authorized Records/state reads, including related-collection checks, and rejects mutations. External network, navigation, downloads and sockets are disabled. Internal capture helpers also support static historical HTML without scripts or live data; the public HTML/generic MCP render actions do not expose a historical `versionId` option.
- HTML capture waits for initial data, fonts, image decoding and paint, with bounded partial-result diagnostics. Full-page and clipped captures obey response/pixel limits. Arbitrary future timers cannot be inferred as application readiness.
- Drawing and HTML have separate managed browser processes and fresh contexts per job. The runtime bounds admission, execution time and cleanup; cancellation or stuck JavaScript can terminate the process group. Idle processes stop. Server shutdown closes the pool.
- Bun owns each browser subprocess; Playwright connects through its public CDP transport adapter using a native WebSocket and a loopback-only ephemeral endpoint. This avoids Bun's extra-file-descriptor pipe finalizer bug and the incompatible Node WebSocket connection path. Browser processes receive a minimal environment and an isolated temporary profile. Capture behavior is verified through this transport; it is not an attachment to a user's browser.
- CLI/server and Desktop packages include the pinned Playwright driver and matching Chromium, notices and provenance. Browser downloads happen during packaging, never while rendering. Desktop signing includes nested native browser components. Generated font/native-renderer assets are checked once by CI source checks and again for standalone release assembly; ordinary build/test commands do not repeat this validation.
- Development and fixture tests resolve the same pinned Chromium headless shell used in release packages. They do not silently select full Chrome or an ambient browser.

## Costs and deliberate limits

| Area | Current trade-off |
| --- | --- |
| Installation | Browser and driver occupy about 214 MB macOS ARM64, 219 MB macOS x64, 286 MB Linux x64, or 382 MB Linux ARM64, unpacked. Shared fonts add 15.7 MiB before packaging compression. |
| First editor load | Drawings open and remain editable while font responses are pending or fail. The browser requests only faces used by the content; it does not preload the 444 fallback subsets. The supplied General Sans variable font is 38,132 bytes; the shared font declaration stylesheet is about 96 KB compressed, cached and nonblocking. Text can change width or wrapping when its intended face arrives. HTML also uses nonblocking font display and preserves authored font choices. |
| Runtime | A browser consumes materially more memory and startup time than the retired custom rasterizer. One active job and eight queued jobs bound concurrency. Per-job deadline is 30 seconds including queuing; response images are capped at 4 MiB and four megapixels. |
| Sandbox support | Production always requires Chromium's OS sandbox. An incompatible host gets an explicit unavailable response; there is no automatic unsandboxed fallback. Source operations that do not need geometry remain usable. |
| Fonts | Bundled Noto families provide fallback coverage for the supplied script corpus, including CJK, Arabic/Hebrew and major Indic/Southeast Asian scripts. This is not all Unicode or a guarantee of locale-specific Han glyph choices. General Sans is provisioned from the existing local Desktop font source and packaged for offline captures with source/license/hash metadata. Public-source development without that optional file remains usable with fallback fonts and explicit capture diagnostics. |
| Emoji | The pinned Fontsource WOFF2 emoji loads but paints blank in Chromium. The implementation uses the same package's WOFF faces with COLRv1 and SVG tables. Maintained pixel checks must verify visible color glyphs, not merely successful font loading. |
| SVG | Existing SVG remains a separate legacy exporter and returns an explicit fidelity warning. Native PNG is the authoritative visual preview; SVG does not gain native shaping fidelity from this change. |
| HTML data | State is frozen, while authorized Records are read during the capture interval and memoized per query. This is not a database-wide historical snapshot. Source revision, state fingerprint and observation timestamps distinguish these facts. |
| HTML behavior | Capture is read-only and blocks network even where interactive viewing permits it. Documents requiring writes or remote assets may produce partial previews. Full-page iframe resizing can reflow viewport-relative layouts; remaining overflow is reported as partial with `preview_clipped`. Historical previews intentionally omit scripts/live data. |
| Image delivery | MCP transports carry real image blocks. An agent host still needs multimodal tool-result support to inspect pixels. Images also consume model context; focused crops reduce cost. |

The emoji format issue is documented by [Fontsource](https://github.com/fontsource/fontsource/issues/588). WebKit's [color-font discussion](https://github.com/WebKit/standards-positions/issues/415) describes the dual COLRv1/SVG strategy. Actual WKWebView behavior remains a target-platform check, not something proved by Chromium on Linux.

The browser transport change follows a reproduced failure in longer test sequences, consistent with the [upstream Bun/Playwright pipe report](https://github.com/microsoft/playwright/issues/42692). [Playwright documents CDP limitations](https://playwright.dev/docs/api/class-browsertype#browser-type-connect-over-cdp); the supported capture, routing, binding and isolated-context workflows are exercised directly rather than assuming every Playwright feature has identical behavior over that connection.

## Font loading and test cleanup follow-up

Removed the drawing-open font barrier and the frontend's generated font-asset
import. A shared, nonblocking stylesheet declares the available faces; browser
font matching selects downloads. General Sans is supplied from the trusted local
asset, with a pinned build-time provisioning command for clean CI checkouts.
The installed fallback collection remains available offline without becoming an
upfront browser download. Native captures prime the actual text/font runs,
including sequential batch edits, rather than loading every fallback family.

Font arrival invalidates cached measurements and updates attached connectors.
Those derived updates do not create undo steps or trigger autosave. History
comparison preserves meaningful edits to free connector endpoints, styles and
bindings while ignoring positions derived solely from font metrics. Agent reads
also reconcile saved connector geometry without rewriting the source.

The maintained browser journeys now hold back or fail font requests while
exercising ordinary editing and recovery. The English board requested fewer
than five font assets, remained editable, and repainted after fonts arrived
without changing its saved source. Both journeys passed in a local run with a
120-second per-test budget. Canonical 60-second runs passed the collaboration
journey but timed out during the longer recovery journey after cold
development-server startup consumed much of its budget. The final run also
blocks the external development Fontshare request. Repository timeouts remain
unchanged; a passing full canonical browser result is not claimed here.

Final workspace and lab typechecking, generated preview integrity, test policy,
repository documentation checks and the production web build passed. The new
frontend build contains zero drawing fallback font files, removing the old
collection from frontend assets and offline precaching. Focused service tests
also passed with the sequential empty/duplicated-text font scenario.

The final concurrent `test:required` attempt did not pass: the standard lane
passed 666 tests, three CLI cases failed on startup/time limits, and the scheduler
cancelled the server lane after it had also hit two widget-route timeouts and a
record-index timeout. Host load was above 22 during this attempt. All six failed
cases then passed in isolated runs using their existing deadlines; the updated
connector/font case passed again alongside the server cases. This supports
resource contention as a contributor, not a claim that the full command passed.
The earlier complete attempt passed the standard, CLI and packaged lanes but
used a previously loaded font-run implementation while its strengthened
connector test was being added. Fresh focused runs verified the correction.

Correction logs are under `.local-dev/font-correction-*.log`, including final
typechecks/build, canonical and extended-timeout browser runs, full required
attempts, and isolated failure checks. These checks used pinned Bun 1.3.14.

Removed repeated `check:previews` prefixes from ordinary build/test commands,
the duplicated long MCP business workflow, cosmetic browser theme/reload loops
and screenshots, retired-dependency bans, and exact transitive-package notice
lists. Retained service-level edit/recovery coverage, real transport/image
checks, native script/emoji rendering, compiled-asset coverage, and the single
CI source check plus standalone release guard. No new CI test jobs were added.

## Review round 1 and final source checks

The first review found two drawing issues: agent undo treated font-derived
connector positions as conflicting edits, and a targeted fixed-geometry read
could unnecessarily require Chromium because of an unrelated text-bound
connector. Browser history and agent undo now share the authored-record
comparison, preserving genuine free-endpoint, binding, style and dependency
conflicts. Targeted measurement includes only selected shapes and their direct
dependencies. Existing service, history, MCP and native-render tests passed
17 tests with 218 assertions after these corrections.

HTML full-page capture now checks the final layout after resizing the iframe,
so viewport-relative content that still overflows cannot silently report a
complete image. The existing HTML suite passed seven tests with 78 assertions.
Release runtime verification now checks confined paths, target identity, pinned
driver/browser versions, executable bytes and mode, supporting files/notices,
and product-font/license hashes at assembly and archive verification. Its
existing suite passed three tests with 32 assertions; all four staged target
distributions passed the verifier.

Final public source checks used Bun 1.3.14: all 11 workspace typecheck tasks,
lab typechecking, test policy, generated tools/theme/brand/preview checks,
documentation generation and Astro diagnostics, and repository documentation
checks passed. The full required suite was not rerun for this final candidate;
hosted PR CI must establish that result on the final commit. The earlier
concurrent-suite limitations described above remain applicable evidence.

A separate disposable Ubuntu 26 Linux VM, running as unprivileged UID 1001,
exercised the unmodified production `launchPreviewBrowserProcess` path with
the pinned Playwright 1.61.1 driver and Chromium headless-shell revision 1228.
It produced a 320 × 200 PNG of 8,111 bytes with the OS sandbox enabled, without
test-launcher injection or sandbox-disabling flags. This proves production
browser launch and PNG capture on that Linux environment; it does not establish
the remaining macOS signing, WKWebView or ARM64 execution checks.

## Review round 2: drawing receipts and image validation

Undo and redo now require the receipt's original stable principal ID; matching
display names or shared drawing write scope do not confer receipt ownership.
Creation receipts retain their pre-operation title, so a title operation in a
create batch reverses together with its objects. Older receipts that report a
title change without its original title fail explicitly rather than partially
undoing the batch. Existing MCP and service cases cover both principal checks,
creation replay/recovery after a move, title undo/redo, and unchanged source on
legacy-baseline failure: eight tests with 118 assertions passed. Shared types
and server typechecking also passed with Bun 1.3.14.

The shared document writer now validates new or changed drawing image bytes
before publishing source, history or receipts, covering MCP and normal browser
saves. It checks declared MIME against the compressed format and rejects
dimensions above 8,192 pixels or a cumulative asset budget above 16 million
pixels before decoding. The managed browser then decodes all remaining assets,
including unused imports. This adds renderer startup/decoding cost to image
imports; a renderer outage blocks them. Edits retaining existing image bytes
and image removal remain available when their geometry needs no renderer.
Expanded existing service/MCP cases passed eight tests with 153 assertions,
including malformed images, mismatched MIME, dimension/cumulative limits,
unchanged source/history after rejection, and outage behavior. Renderer and
shared-write conformance checks passed ten tests with 160 assertions.

The next CI run exposed Bun 1.3.14's async rejection matcher losing browser
I/O events during nested event-loop processing, matching upstream reports
[bun#33261](https://github.com/oven-sh/bun/issues/33261) and
[bun#37189](https://github.com/oven-sh/bun/issues/37189). The unchanged image
case reproduced locally on its fourth repetition; converting only its final
matcher moved the stall to an earlier matcher. Ordinary JavaScript awaits
followed by the same error assertions passed eight repetitions. A shared
test helper now handles these browser-backed rejection assertions. Production
decoding and time budgets are unchanged. Final service, renderer and MCP checks
passed 14 tests with 213 assertions; server typechecking passed.

## Earlier acceptance evidence and environmental boundaries

The first hosted PR run for commit `99d3352` passed the complete required suite
and selected browser journeys with their unchanged canonical deadlines. This
resolves the earlier shared-host timing uncertainty for that candidate. Its
release build exposed unrelated lockfile resolution changes missing from the
reviewed dependency inventory; that packaging correction and the final head
still require passing CI. [Hosted verification run](https://github.com/worktable/worktable-dev/actions/runs/36868832308).

A real MCP client scenario made 17 calls with 111 assertions and nine PNG responses. It created a multilingual board with joined/skin-tone emoji and an embedded raster badge; read IDs and text; edited text and bound connectors; queried/cropped; rendered an unsaved proposal; corrected a visible overlap; and undid/redid while preserving unrelated title and position changes. Visual inspection caught the initially blank emoji and confirmed the fix. The final run through the release headless-shell/native WebSocket transport passed in 22.7 seconds, with image-returning calls taking 0.96–3.17 seconds; the title-only save took 81 milliseconds. These are single synthetic-workflow observations, not a production benchmark. The schemas were usable without malformed calls. Coordinates still require agent judgment: the preview revealed an overlap, and the agent corrected it explicitly.

Changed-region previews can clip labels on neighboring objects at the crop edge. The agent can request a full overview or a larger explicit region when that context matters; an otherwise successful cropped image does not imply every neighboring label is visible.

Actual HTML captures exercised light/dark mode, viewport/crop/full-page output, blocked on-load mutations, authorized reads, broken images and delayed assets. Drawing browser journeys exercised editing and save recovery. Compiled Bun tests exercised embedded renderer/font assets outside the checkout; packaged runtime resolution was also tested outside the checkout. A controlled infinite-JavaScript fixture proved hard termination and subsequent recovery.

Verification on this host:

- Repository typechecking, lab typechecking, test policy, generated preview checks, production web build and repository documentation checks passed.
- The complete canonical server lane passed 1,503 tests across 130 files. The packaged connector/bridge lane passed all nine tests, including model-visible images through the HTTP-to-stdio bridge and compiled renderer assets outside the checkout.
- After correcting development/test browser selection to the release headless shell, drawing, forced-GC transport and compiled-asset checks passed eight tests; HTML capture passed seven tests; server typechecking passed again.
- The standard test lane passed. The complete CLI lane passed all 132 tests across five files when run separately. Two full concurrent required-suite attempts did not pass: they exposed renderer issues corrected here and short-deadline CLI/server failures during concurrent execution. The affected cases passed in the complete server-only and CLI-only runs. These separate passing lanes are not a passing result for the full concurrent required command.

This Linux host rejects sandboxed Chromium with `No usable sandbox!`. Renderer behavior tests therefore use an explicit test-only injected launcher with repository-authored synthetic fixtures. These tests do not establish production sandbox support on this host. All four browser distributions were staged, but actual macOS signing/notarization, WKWebView rendering and ARM64 execution require those targets. No host security settings were relaxed.

Detailed disposable outputs live under `.local-dev/native-drawing-agent-flow/`, `.local-dev/html-preview-runtime/` and `.local-dev/visual-preview-spike/`. They contain synthetic examples, not user workspace data. Maintained tests and canonical test results provide the repeatable verification path.
