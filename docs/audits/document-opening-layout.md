# Document opening status and layout follow-up

The opening preview, rich editor and Markdown reader now share their page frame:
64 px below the document header, with the existing rich-text horizontal spacing.
The frame owns the top gap; the first block no longer adds another heading margin.
The skeleton uses the same frame.

The separate top-right “Saved preview · Opening editor…” label is removed. The
initial HTML, client preview and live editor use the same bottom-left status pill.
It reads **Opening** until both the editor and its content are ready, even if the
WebSocket has already synced. It then uses the existing Syncing/Synced/Offline
states; Synced hides after 1.8 seconds. Markdown hides Opening when its reader is
ready. The status clears the sidebar, including its resized width, and sits at
the viewport edge on mobile.

## What caused the shift

- The preview/Markdown frame had 32 px top padding. A rich-text H1 had that padding
  plus a 32 px block margin: 64 px in total.
- Markdown H1 line height was 1.2 versus the editor's 1.5. Multiline headings
  consequently changed height when the editor appeared.
- Rich previews used Markdown paragraph margins instead of BlockNote's 3 px block
  insets, moving the first body line below a heading.
- Preview text spans inherited the global body-text tracking rule inside headings.
  On the mobile fixture this produced six title lines where the editor had five.
  Spans now inherit heading tracking, with matching whitespace and ligature rules.

## Validation

`document-opening-layout-evidence.json` records six production-browser cases:
heading-first rich text, paragraph-first rich text and Markdown at 1440 and 390 px.
The reproducible script is
`document-loading-experiments/verify-opening-layout.mjs`. It requires
`AUDIT_FIXTURE_CONFIG` (JSON with an isolated server's `url` and workspace parent
`root`), optionally `AUDIT_PASSWORD`, and a running Chrome CDP endpoint. It creates
synthetic documents in that isolated workspace; never point it at personal data.
`AUDIT_OUTPUT_PREFIX` controls its evidence/screenshot output paths.

The script deliberately holds application and editor chunks to examine the HTML,
client-preview and editable stages. Font-provider CSS is replaced with empty CSS
for these controlled geometry comparisons. It checks actual content-box heights
and padded text origins, since preview and editor wrappers differ.

All six cases passed:

| Case | First text origin before/after | First body origin before/after |
| --- | --- | --- |
| Desktop rich heading | 112 / 112 px | 334 / 334 px |
| Mobile rich heading | 112 / 112 px | 478 / 478 px |
| Desktop/mobile rich paragraph | 112 / 112 px | 112 / 112 px |
| Desktop Markdown | 112 / 112 px | 340 / 340 px |
| Mobile Markdown | 112 / 112 px | 484 / 484 px |

The document header is 48 px high, leaving the requested 64 px gap. Checks also
passed for holding Opening beyond the Synced hide timer, preserving a 180 px scroll
position, status auto-hide, disconnect/reconnect, and typing followed by undo.
Offline injection explicitly closes test WebSockets: browser offline emulation
alone leaves existing WebSockets connected. No browser page errors were recorded.

Full project typecheck (11 tasks), production build, nine focused preview and
server-opening tests, and all seven document/browser behavior tests passed.
Two earlier browser runs had intermittent failures: a sidebar-resizing handle had
no bounding box after a double-click, and a nested-paste case hit its five-second
editor-startup limit. The final run passed all seven with zero retries. Neither
test was weakened or changed for this UI work.

The existing copied-data LAN preview was also checked with normal font delivery.
Its rich-text, Markdown and HTML pages opened without browser page errors. Both
rich text and Markdown had the 64 px opening gap at desktop and mobile widths.
The desktop rich-text preview and editor also matched their two-line title height
with fonts loaded. Some navigations omitted the optional server preview under
its existing 250 ms budget; those personal-data runs only verify the final layout.
Private document screenshots and checks remain alongside that preview, outside
the repository. The existing copied workspace/session were retained when updating
its assets.

## Scope and limits

This follow-up fixes status presentation and the common initial text-layout
handoff. It is not a new load-speed benchmark or a claim of zero layout movement
for every document: delayed fonts, rich embeds, lists/tables and the bounded
80-block preview can still change layout when the full editor arrives. Markdown
keeps its body paragraph rhythm; its page origin and heading metrics match rich
text. Prior performance results and outstanding large-document limits remain in
`document-loading-results.md`.
