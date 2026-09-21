# Document loading: implemented changes and measured results

The implementation is saved on `t3code/improve-document-loading`. This is a
validated local review build, not a production deployment. Reading is much faster;
full editing and large-document interactions still miss the desired budgets.

Review on another computer on the same LAN:

- [Small rich document](http://192.168.2.211:39090/spaces/loading-audit/documents/rich-10)
- [2,000-paragraph document](http://192.168.2.211:39090/spaces/loading-audit/documents/rich-2000)
- [HTML document](http://192.168.2.211:39090/spaces/loading-audit/documents/html-audit)
- [Markdown document](http://192.168.2.211:39090/spaces/loading-audit/documents/plain)
- [Original comparison](http://192.168.2.211:45747/spaces/loading-audit/documents/rich-2000)

Use the fixture password provided in the conversation. These are isolated test
documents. The servers are running on this machine; the links require it to remain
available. Candidate assets are fixed in `/tmp/worktable-stage10-assets`.

## Before and after

Three alternating pairs per format, fresh visible Chrome contexts, persistent
servers, 100 ms latency, 10 Mbps download, 4 Mbps upload, and 4× CPU slowdown:

| Median | Original | Final | Reduction |
| --- | ---: | ---: | ---: |
| Small document: saved reading view | 3.870 s | 0.619 s | 84% |
| Small document: editor ready | 5.399 s | 4.160 s | 23% |
| 2,000 paragraphs: saved reading view | 4.257 s | 0.724 s | 83% |
| 2,000 paragraphs: editor ready | 13.630 s | 6.535 s | 52% |
| HTML ready, parent-page CDP throttling only | 3.860 s | 3.349 s | 13% |

[All 18 final comparison runs](document-loading-stage10-final-standard-evidence.json)
are retained, including slower runs; none recorded a page error. Editor ranges:
small original 4.858–5.569 s, final 4.058–4.350 s; large original 13.616–13.876 s,
final 6.474–6.811 s. This is one controlled session, not production p75.

Reading uses the later of the preview's double-animation-frame boundary and FCP.
That is an approximation of visible saved content, not a direct measurement of
physical display presentation. Both underlying measurements are retained. It is
not editing readiness. The saved projection is bounded and does not pretend to
be the complete collaborative editor.

For a genuinely constrained HTML path, an HTTP proxy imposed 400 ms request
latency and shared 1.6 Mbps download / 0.75 Mbps upload budgets on the parent
**and iframe**. Two alternating pairs improved **7.648 → 5.589 s**. Iframe response
completion was 451–532 ms, confirming it went through the delay. [Proxy evidence](document-loading-final-proxy-html-evidence.json).
External font hosts were unavailable through this fixture-only proxy; fallback
fonts were used. The fixture's HTML has no external assets. WebSocket bodies are
not bandwidth-throttled by this helper, so it is not a general collaboration test.

## What was wrong and what changed

- **The document waited for app startup.** Authorized, bounded saved rich-text and
  Markdown content now arrives in the initial HTML. It stays out of query caches
  and collaborative state, and hands over to the freshly validated live document.
- **Remote font CSS blocked painting.** Font imports are now optional and loaded
  after initial paint. With an injected eight-second font-CSS stall, small-doc
  FCP improved 8.662 → 0.680 s and editing 12.375 → 4.894 s. This proves the failure
  mode under controlled injection; it does not prove that every observed slow
  session had that cause. [Font-stall evidence](document-loading-delayed-font-evidence.json).
- **Editor work scaled poorly.** BlockNote was upgraded from 0.51.4 to 0.54.2,
  adopting upstream direct node conversion and changed-range improvements.
  The maintained ID patch removes quadratic duplicate searches, repeated inverse
  mapping, and redundant node-position lookups while preserving block identities.
- **Off-screen and unrelated UI work happened during opening.** Large-document
  off-screen rendering is deferred; empty annotation polling, initial forced
  geometry reads, and an unnecessary scroll reset are removed. Closed dialogs
  and panels mount on demand. Syntax highlighting initializes lazily.
- **Delivery and imports added avoidable cost.** JSON/HTML responses negotiate
  compression, the global stylesheet has one owner, and HTML no longer downloads
  editor code through shared chunk dependencies. Renderer code starts after the
  saved view gets a paint opportunity, overlapping metadata requests.
- **Independent loading components repeatedly replaced each other.** Theme and
  sidebar geometry are applied before paint, redundant editor mount/pending
  stages are removed, and HTML uses one shared server/client skeleton with
  explicit success/error handoff. Rich text and Markdown show saved content.

Not every experiment helped. Compression/style deduplication alone did not show
an overall speedup; changing reveal opacity did not help; cached lazy components
alone did not make cold editing faster. Those results remain in the
[full implementation log](document-loading-implementation-progress.md).

## Where the remaining time goes

In the final median large-editor run (6.535 s), main JavaScript finished transfer
at 0.597 s; editor code transferred from 0.652–1.461 s. The saved view had a
reading boundary at 0.654 s and FCP at 0.692 s. Canonical metadata completed at
1.659 s; full saved content completed at 2.313 s; the later fresh-path check
completed at 3.650 s. Editor readiness followed at 6.535 s.

These are overlapping milestones, not additive server timings. Long tasks totaled
4.053 s, with the longest at 1.453 s. The remaining interval includes editor
construction, collaboration, React work, and browser rendering; resource timing
alone cannot attribute each millisecond. The editor chunk is still about 347 KB
compressed, and ProseMirror still constructs the full editable document.
`content-visibility` defers browser rendering, not model or DOM construction.
The [earlier 12.311-second breakdown](document-loading-timing-breakdown.md) is
preserved separately rather than mixed with this new session.

## Targets and limits

Targets are saved reading ≤1 s on the normal profile, ≤2.5 s constrained,
ordinary editing ≤2 s, and interactions ≤200 ms. In the final cold/warm input
matrix, the constrained cold reading boundary was 1.899 s for small rich text,
1.892 s for large rich text, and 1.848 s for Markdown. Full editing/view handoff
was still 7.539 / 12.238 / 5.500 s respectively. [Input and constrained evidence](document-loading-final-input-evidence.json).

The reading target was met by these fixtures. The editing and interaction targets
were **not** met consistently. Normal cold sessions recorded maximum interaction
event durations of 272 ms for small documents and 552 ms for large documents;
the constrained large session reached 608 ms. These session maxima and automated
type/undo timings are diagnostics, not field INP. Large-editor startup still had
roughly 1.2–1.5-second main-thread tasks on the slowed CPU.

The next substantial changes require explicit architecture work: reduce the
editor's mandatory startup code; mount editable sections near the viewport while
preserving cross-section selection, undo, clipboard, annotations and collaboration;
and start the HTML sandbox earlier with a validated identity and an installed
message broker. Simply hiding more loaders, removing path validation, or making
an unsynchronized editor writable would not solve the remaining costs. The
[research](document-loading-solutions-research.md) describes the tradeoffs.
Production field measurements and Firefox/Safari coverage are still outstanding.

## Validation and reproduction

The final production build, all 11 project typechecks, seven document browser
regressions, and the repeated 141-test server suite passed. The first server run
had one intermittent cold-room snapshot failure; its file and then the full suite
passed on recheck. This remains a validation caveat. Earlier stages also passed
HTML move/error handoff, mobile formatting/save/reload, Mermaid, table editing,
code-theme, settings, annotations and 5,000-block opening checks. The final ID
patch adds a real-plugin multi-step nested insertion regression.

The upstream patch applies cleanly to the checksum-verified published package;
TypeScript, ESM and CommonJS match the installed files. Complete modified source
and attribution are shipped in the generated license notices.

Reproduction scripts are in [document-loading-experiments](document-loading-experiments/README.md):
`measure-paired-openings.mjs`, `measure-reading-and-input.mjs`,
`measure-proxy-html.mjs`, and `measure-delayed-fonts.mjs`. Use isolated fixtures,
keep builds/tests out of timed measurements, preserve failed runs, and do not
interpret a warm browser or already-running server as a fully cold deployment.
