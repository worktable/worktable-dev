export const FORMAT_SPEC = `# Worktable format

Worktable has four durable primitives:

1. **Docs** are documents stored as markdown, BlockNote JSON, or Quickdraw drawing JSON and addressed by an extensionless path within a space.
2. **HTML docs** are self-contained pages stored as HTML files in a space's docs tree and addressed through the MCP by htmlId. Prefer HTML docs in Worktable for custom visual or interactive artifacts.
3. **Records** are independently addressable YAML items grouped into optional typed collections.
4. **Annotations** are comment or instruction threads attached to Docs, blocks, text ranges, or HTML docs.

Choose Docs when value lives in prose, reasoning, or a whole document; choose Drawing Docs for a freehand scratchpad, shapes, and spatial notes. Choose Records when items change separately or need validation, filtering, sorting, grouping, comparison, or automation. Choose HTML when custom presentation or interaction materially improves the work. Use Annotations for situated feedback and agent instructions.

Inside workspace content, identify Docs with decoded, extensionless paths without a leading slash, such as \`specs/doc-urls-for-agents\`. Markdown links use portable root-relative paths such as \`[Title](/specs/doc-urls-for-agents)\`; never persist an origin or \`/spaces/...\` application URL. External chat may use a returned \`urlToSendInChat\`.

Record schemas may use a \`document\` field for a same-space Doc. Store the same portable path form; \`many: true\` stores an array. Friendly input with a leading slash or \`.md\` suffix is normalized. A valid path may point to a missing or archived Doc.

Records are canonical shared data. HTML-local filters, drafts, preferences, and temporary selections belong in \`worktable.state\`; HTML that reads or writes Records needs explicit per-collection permissions.

## Drawing Docs (V2 document storage)

Drawing source is a strict JSON envelope saved as a .quickdraw file:

{"type":"worktable.quickdraw","version":1,"title":"Scratchpad","snapshot":{"document":{"store":{}}}}

Use worktable_documents_write with request.action="create", spaceId, an extensionless path, format={"id":"worktable.quickdraw","sourceVersion":1}, and source as a JSON string (encoding="utf8"). To edit, use worktable_documents_read with request.action="read_source", decode its base64 source, preserve existing records, and replace through worktable_documents_write with request.action="replace" and expectedRevision set to the returned sourceRevision. A conflict requires rereading and reconciling; never blindly retry a replacement with a newer revision. These APIs require V2 storage.

snapshot.document.store maps each record's unique id to that record. All shapes have id, typeName="shape", type, x, y, rot (radians), z (stacking order), and props. For example, this complete freehand stroke can be added under the key "ink-1":

{"id":"ink-1","typeName":"shape","type":"draw","x":100,"y":100,"rot":0,"z":1,"props":{"color":"black","size":"m","pts":[0,0,0.5,20,30,0.7],"done":true,"isPen":true}}

Supported shape types and props:
- draw/highlight: color, size, pts (flat local x,y,pressure triples), optional done, isPen, dash.
- text: color, size, text, font; optional positive scale, positive w, autosize, align (start/middle/end).
- note: color, size, text, font; optional positive scale.
- line/arrow: color, size, dx, dy, dash; optional bend.
- geo: color, size, positive w and h, geo (rectangle/ellipse/triangle/diamond/hexagon/star), dash, fill (none/semi/solid/pattern), font; optional label and labelSize.
- image: positive w and h, assetId referencing an asset record.

Colors: black, grey, light-violet, violet, blue, light-blue, yellow, orange, green, light-green, light-red, red. Sizes: s/m/l/xl. Fonts: draw/sans/serif/mono. Dash: draw/solid/dashed/dotted. Assets have only id, typeName="asset", positive w and h, and src as an embedded base64 PNG/JPEG/WebP/GIF data URL. Remote URLs and SVG are rejected. No extra properties are accepted. IDs must match store keys, be 1–200 characters, and cannot be __proto__, constructor, or prototype. Numbers must be finite and within ±10,000,000. Title is 1–200 nonblank characters, text/labels up to 50,000 characters, pts up to 300,000 numbers, total up to 5,000 records and 8 MiB UTF-8 source.

Typed text is searchable; freehand marks require a PNG export or browser inspection to interpret. There is no OCR or live merging. Ask the human to use Reload drawing after your edit; unsaved conflicting ink can be kept with Save a copy. Each autosave retains a full source version under the Worktable's history retention policy, so embedded images can grow history quickly.
`;
