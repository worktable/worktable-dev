# How files behave

These are the rules Worktable's file handling keeps, so that taking in any file
behaves predictably for people and agents. Each rule gives the guarantee, why
it matters, where the code keeps it, and the tests that prove it. Where the code
doesn't meet a rule yet, the gap is listed under the rule.

Check a change to how files are stored, served, versioned or classified against
every rule it touches. When a change makes a rule true or breaks one, update
this page in the same pull request. Paths below are relative to
`packages/server/src` unless they start with `packages/` or `apps/`.

## Words

- **File:** anything in a Space's folder. **Plain file:** a file Worktable
  doesn't edit itself (an image, a CSV, a PDF). **Doc:** Markdown, rich text,
  an HTML Doc or a drawing. A rule that says "file" covers both.
- **Through Worktable:** the app, the HTTP API, agent tools and file links.
- **On disk:** anything writing the Space's folder directly, such as an agent
  with a shell.

Writes on disk are never refused or checked: the last write wins. Rules that
need the writer's cooperation, such as naming the revision a replace is based
on or refusing a write over a limit, cover writes through Worktable only. What
Worktable records of a change on disk depends on the file:

- A plain file Worktable already keeps (uploaded, moved or otherwise managed
  through it) gets a version once its Space's changes settle, marked as made on
  disk. Changes in quick succession merge into one version, and a Space that
  keeps changing is recorded after at most 10 seconds
  (`file-change-recorder.ts`), so a version can hold a state the writer hadn't
  finished.
- A new file written on disk has no history until Worktable keeps it.
- A file over 64 MiB keeps no new versions while it stays that large; versions
  from before it grew stay in its history.
- A Doc gets no version when the change settles. Its next write through
  Worktable first keeps what is on disk as a recovery point.

## Trust

### 1. Reading never changes a file

Opening, viewing, downloading, indexing, previewing, sharing and archiving never
change a file's bytes. A file changes only when someone writes or restores it,
or when a move rewrites links that pointed at what moved; each change through
Worktable is a version. Nothing becomes a Worktable format unless a person chooses it, and the
original is kept.

**Why:** people and agents keep their own files in a Space. A file that changes
because someone looked at it can't be trusted, and an agent's next write would
conflict with a change nobody made.

**Enforced in:** `file-revision.ts` (reads open one pinned revision),
`file-response.ts`, `yjs-manager.ts` (an open with no edit persists nothing),
`link-rewrite.ts` (move rewrites, recorded as versions).

**Proved by:**

- `routes-documents.test.ts` "keeps a Doc overwritten with plain JSON as the
  same unreadable item, with its history": its page, source, an agent read and
  an editor connection leave the bytes on disk identical.
- `routes-documents.test.ts` "moves, archives, restores and deletes a plain
  file once files are on".
- `yjs-manager.test.ts` "opening a legacy doc with id-less blocks records no
  version".
- `workspace-transfer-v2.test.ts` "excludes incompatible history before
  portability validation and preserves source bytes".

**Gaps:** a version carries a reason only when its writer gives one. No test
checks that indexing, previews and shared pages leave a file's bytes unchanged.

### 2. Any content is accepted; names follow written rules

Within published limits, any bytes are stored, listed and downloadable
unchanged: unknown, damaged and encrypted files included. Only a name or an
object can be refused, and only for a reason on this list:

| Reason                 | Examples                                                                                                                           | Where                                    |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| Hidden                 | A file or Doc whose name starts with a dot, or in a folder whose name does (`.env`, `.git/HEAD`); see [Hidden files](#hidden-files) | `document-format-registry.ts`            |
| Unsafe                 | Empty or absolute paths, `.` and `..`, backslashes, encoded separators, NUL, a segment over 255 bytes, ill-formed Unicode          | `document-path.ts` (`UNSAFE_CODES`)      |
| Not portable           | Reserved Windows names, characters Windows refuses, a trailing dot or space, a path that is too long                               | `document-path.ts` (`PORTABILITY_CODES`) |
| A Doc's name           | `.md`, `.excalidraw` and `.quickdraw` are for the Doc tools; a `.json` holding Doc blocks is a Doc                                 | `file-uploads.ts` (`namesAFile`)         |
| A link or special file | Symbolic links, sockets and devices are skipped; an export leaves them out and lists them                                          | `document-adapters.ts`                   |
| Over a limit           | An upload over 64 MiB; a write through Worktable past the storage limit                                                            | `file-uploads.ts`, `storage-limit.ts`    |

A `.json` that doesn't hold Doc blocks and an outside `.html` are plain files,
so they upload as files.

**Why:** a Worktable that silently drops, renames or rewrites what it is given
loses work. A refusal that names its reason lets a person or agent fix the name.

**Enforced in:** `document-path.ts`, `file-uploads.ts`, `routes/documents.ts`,
`document-write-service.ts`.

**Proved by:**

- `routes-documents.test.ts` "uploads, serves and replaces files, keeping each
  version": `.json`, `package.json` and `.csv` come back byte for byte; a `.md`
  is refused.
- `routes-documents.test.ts` "streams an upload to disk as it arrives, and saves
  only a whole one": one byte over the limit is refused and nothing is kept.
- `document-catalog.test.ts` "lists every visible file and Doc by its whole name
  once files are on": `.git/HEAD` and `.DS_Store` aren't listed.
- `document-path.test.ts` "rejects unsafe encodings, separators, dot segments,
  and malformed Unicode".
- `document-path.test.ts` "refuses a new name for one reason on the written
  list, and says which": each refusal carries its own code (`HIDDEN_NAME`,
  `UNSAFE_PATH`, `NOT_PORTABLE`, `DOC_NAME`).

**Gaps:**

- Listings skip links and special files without saying so; only an export
  reports them.

### 3. Every file stays usable

A file Worktable can't read, version or preview (an unknown type, over a limit,
damaged) still lists, opens as a card, downloads, and says what's missing and
why, to people and to agents. A type Worktable doesn't know is a plain file. No
single file can make a Space fail to open.

**Why:** a file that can't be opened or taken out is lost, even if its bytes are
still on disk.

**Enforced in:** `file-limits.ts` (`fileNoHistory`, decided from the size on
disk without reading the file), `document-page-service.ts`,
`mcp/dispatcher.ts` (`fileOverVersionLimit`), `apps/web/src/components/file-page.tsx`.

**Proved by:**

- `routes-documents.test.ts` "keeps a version when a file with history changes
  on disk": a file over 64 MiB still lists, says it has no history, downloads
  whole and by range, and a replace is refused with the reason.
- `mcp-documents.test.ts` "sends a file to a one-time upload link and reads it
  back from a download link": agents get `noHistory` with its message and a
  working download link.
- `mcp-documents.test.ts` "reads supported formats through one bounded inert
  projection": an invalid Doc reads as invalid instead of failing.
- `document-catalog.test.ts` "keeps missing, newer, and unknown inventoried
  formats visible and inert".

**Gaps:**

- An unreadable Doc's page says only that it couldn't be opened safely, and
  downloading its source is for the owner only and stops at 64 MiB.
- The "No preview" card for an unknown type gives no reason.
- The file page's preview states ("Too large to preview", "Couldn't load
  preview") have no test.

### 4. Editors keep what they don't show

An editor may open a file only if opening and closing it without an edit leaves
the bytes identical, and an edit keeps everything outside it. Where an editor
can't promise that, it opens read-only, or says so before the first save, which
becomes a new version with the original kept. A file is a Doc only if it passes
that Doc format's full check; otherwise it's a plain file.

**Why:** a shell agent's `data.json` once opened in the Doc editor, and the first
edit saved it as empty paragraphs.

**Enforced in:** `rich-text-blocks.ts` (the Doc block check), `doc-source-kind.ts`
and `json-source-kind.ts` (whether a `.json` is a Doc), `yjs-manager.ts`,
`blocknote.ts`.

**Proved by:**

- `yjs-manager.test.ts` "opening a legacy doc with id-less blocks records no
  version": opening and closing leaves the file byte for byte, though the editor
  gives the blocks ids in memory.
- `yjs-manager.test.ts` "normalizes a legacy Mermaid code block in memory and
  persists it only after an edit".
- `yjs-manager.test.ts` "never opens or rewrites a read-only Markdown document".
- `document-format-registry.test.ts` "takes JSON as a rich-text Doc only when it
  holds Doc blocks".
- `routes-documents.test.ts` "keeps a Doc overwritten with plain JSON as the
  same unreadable item, with its history": the editor refuses it.

The Doc check refuses a block or table-cell field the editor doesn't know, so a
write holding one is refused by name and an existing Doc holding one is listed as
unreadable. Fields an earlier Worktable editor wrote, always at default values,
stay known (`EARLIER_BLOCK_PROPS`); the editor drops them on the next save,
which changes nothing the Doc shows.

**Gaps:** unknown style keys inside text are still accepted, since Worktable's
own writes never store them. An agent reading an unreadable Doc is told it
isn't Doc blocks, without the field that made it so.

### 5. What a file is doesn't change silently

Whether a file is a Doc or a plain file stays as it is when its bytes change.
Bytes that aren't a Doc written over a Doc leave the same item, marked
unreadable, with its history. A plain-file `.json` stays a plain file when Doc
blocks are later written into it. An `.html` from outside is a plain file with a
static preview unless Worktable made it or a person chooses Open as HTML Doc;
that choice is recorded and travels with export. Changing kind never converts
content, loses history or grants new abilities.

**Why:** an item that turns into something else changes what can run and what
an edit does, without anyone deciding it.

**Enforced in:** `doc-source-kind.ts`, `source-kind-records.ts` (each item's
recorded kind), `document-write-service.ts` (`openFileAsHtmlDoc`),
`document-catalog.ts`.

**Proved by:**

- `routes-documents.test.ts` "keeps a Doc overwritten with plain JSON as the
  same unreadable item, with its history".
- `routes-documents.test.ts` "keeps HTML that was there an HTML Doc, and takes
  HTML added later as a file a person can open": agents can't open a file as an
  HTML Doc, and a kept `.json` stays a file.
- `routes-documents.test.ts` "uploads, serves and replaces files, keeping each
  version": a kept file stays a file whatever is written into it.
- `workspace-transfer-v2.test.ts` "keeps a file opened as an HTML Doc one
  through export and restore".
- `document-filesystem-coordinator.test.ts` "dispatches a changed .json or
  .html as what it is, a plain file by its whole name".

### 6. Identity survives

A file keeps its identity, and with it its history, comments, links and Used in,
across rename, move, replace, archive, restore and a change of kind. Only Delete
ends it. A new file at a deleted file's path doesn't inherit it.

**Why:** comments, links and history belong to the thing, not to its current
name.

**Enforced in:** `document-inventory.ts`, `document-lifecycle-journal.ts`,
`document-write-service.ts`, `deleted-items.ts`.

**Proved by:**

- `routes-documents.test.ts` "moves, archives, restores and deletes a plain
  file once files are on": one identity through move, archive and restore; a new
  file at the deleted path has a new identity and none of its history.
- `document-format-conformance.test.ts` "gives a registered writable format
  fenced CRUD and exact versions".
- `doc-rename.test.ts` "gives MCP the same annotation-aware rename lifecycle as
  REST".
- `document-identity-admission.test.ts` "keeps imported HTML identity and
  history through archive, move, and external deletion".
- `deleted-items.test.ts` "take their live editing state with them".

**Gaps:** archiving a Doc ends its share links for good, so restoring it doesn't
bring them back.

## Knowing what a file is

### 7. One contract says what a file is, everywhere

Every surface asks the same file-type table, keyed by name with one case rule.
Where a surface treats a type differently on purpose, the table says so and
why; a difference it doesn't record is a bug. The name nominates a type;
content can only narrow it (a would-be Doc becomes a plain file), never widen it
or allow anything to run.

**Why:** when the app, the agent tools and shared pages disagree about a file,
each surface's behaviour is a surprise.

**Enforced in:** `packages/types/src/file-types.ts` (`fileTypeFor`: the base
name, A to Z folded, no other Unicode folding), `packages/types/src/file-type-notes.ts`,
`doc-source-kind.ts`, `file-media.ts`.

**Proved by:**

- `packages/types/src/file-types.test.ts` "decides by the base name under one
  case rule", "records why wherever surfaces disagree, and nowhere else" and
  "gives every type a policy on every surface, and every surface a default".
- `document-format-registry.test.ts` "takes JSON as a rich-text Doc only when it
  holds Doc blocks".
- `routes-documents.test.ts` "keeps HTML that was there an HTML Doc, and takes
  HTML added later as a file a person can open".

**Gaps:** the Doc format registry folds case with full Unicode lowercasing
(`document-format-registry.ts`), not the table's rule; no Doc extension differs
under the two today. Nothing yet decides between parts of Worktable on
different versions.

## Writes and versions

### 8. Writes are whole, and replaces are checked

A write through Worktable either becomes the current version completely or
leaves the previous one intact; an interrupted write never shows. Every replace
through Worktable names the revision it's based on: a stale one is refused as a
conflict (409 `REVISION_CHANGED`, with the current revision) and a missing one
as missing (428 `REVISION_REQUIRED`), never a silent overwrite. Replace Anyway
(`replace=current`) is for people only. Changes on disk aren't checked: the last
write wins, and what Worktable records of it is listed under [Words](#words). It
never claims versions it didn't see. Old versions are kept as the history policy says.

**Why:** an agent and a person editing the same file shouldn't lose each other's
work without knowing it.

**Enforced in:** `file-uploads.ts` (`FileReplaceRefused`), `staged-file.ts`
(uploads stream to a staged file and publish whole), `routes/documents.ts`
(`If-Match`), `routes/widgets.ts` (HTML Doc replace and restore),
`mcp/dispatcher.ts` (`worktable_files_write`), `file-change-recorder.ts`
(changes on disk, once they settle).

**Proved by:**

- `routes-documents.test.ts` "uploads, serves and replaces files, keeping each
  version": stale, missing and agent Replace Anyway are each refused, and Upload
  New Version from a stale page keeps the agent's newer version.
- `routes-documents.test.ts` "streams an upload to disk as it arrives, and saves
  only a whole one": a cut-off replace leaves the current version and nothing
  staged.
- `mcp-documents.test.ts` "asks for the revision a replace is based on, on the
  preview surface too".
- `mcp-documents.test.ts` "sends a file to a one-time upload link and reads it
  back from a download link": upload links need a revision, and a stale one is
  refused.
- `linked-ingress.test.ts` "carries a file link in pieces: an upload saved after
  its last piece, and a download piece by piece".
- `routes-documents.test.ts` "keeps a version when a file with history changes
  on disk": a kept file's change becomes a version, a new file dropped on disk
  records nothing, and a file over 64 MiB is marked as having no history.
- `document-format-conformance.test.ts` "gives a registered writable format
  fenced CRUD and exact versions": a Doc changed on disk is kept as a recovery
  point before the next write.
- `routes-docs.test.ts` "replaces an existing doc only from the revision it
  read": a whole-Doc replace with no revision gets 428 and a stale one 409.
- `widget-versions.test.ts` "restores a version round-trip including
  permissions, bypassing the validation gate": restoring an HTML Doc version
  with no revision gets 428 and a stale one 409.

**Gaps:**

- Restoring a Doc version over HTTP (`routes/docs.ts`) names no revision.
  Its open editors save first, and the restore keeps the current text as a
  version.
- The released MCP surface still describes `expectedRevision` as optional for
  `worktable_files_write`, though a replace without it is refused; the preview
  surface says it's required.
- No test covers a ChatGPT attachment replace.

### 9. A revision is one state

Anything said to come from a revision (a download, a range, a Link piece, a
preview, a history read) comes from exactly those bytes, or says it's
unavailable. Nothing mixes revisions: a file replaced during a transfer fails
the transfer or restarts it.

**Why:** a download stitched from two versions is a corrupt file that looks
fine.

**Enforced in:** `file-revision.ts`, `file-response.ts` (ETags, ranges,
`If-Range`), `linked-file-links.ts` (Link pieces pinned to one revision),
`file-history.ts`.

**Proved by:**

- `routes-documents.test.ts` "serves ranges of a file, streamed at one revision
  without holding its Space": ranges, `If-Range`, and a file changed mid-stream
  fails the transfer.
- `routes-documents.test.ts` "gives two same-size writes in one clock tick their
  own ETags".
- `routes-documents.test.ts` "serves a file as it was at an earlier moment, for
  an old Doc version".
- `linked-ingress.test.ts` "carries a file link in pieces: an upload saved after
  its last piece, and a download piece by piece".
- `mcp-document-previews.test.ts` "keeps HTML saved when preview runtime is
  unavailable and fences standalone captures to the source revision".

**Gaps:** a Records import from a CSV reads the file again without its
revision, so the proposal and the import can see different bytes
(`records-import.ts`). Restoring a Doc copies at most 50 earlier images or
256 MiB; past that, images stay current (`file-history.ts`).

### 10. Every version says who made it

Writes through Worktable record the signed-in person or agent. A version made
from a change on disk, which only a plain file Worktable keeps gets, is marked
as made on disk (`createdBy: "external"`, `source: "filesystem"`).
A name written inside a file is display text, not authorship.

**Why:** history is only useful if it says who changed what.

**Enforced in:** `routes/documents.ts` (`documentWriteAttribution`),
`routes/file-links.ts` (a link writes as the agent that made it), `auth.ts`,
`document-write-service.ts` (`recordExternalFileChanges`).

**Proved by:**

- `routes-documents.test.ts` "keeps a version when a file with history changes
  on disk": the change on disk is recorded as made on disk.
- `bridge-e2e.test.ts` "runs the exact unpacked child with tool parity and
  authenticated write attribution": an agent's Doc write records its token.

## What Worktable derives

### 11. Derived output is replaceable, honest and private

Text, previews, facts and indexes are never the only copy of anything; losing
them loses no work. Each names the revision it came from and whether it's
complete. It's read only with current access to the file. Deletion or revoked
access stops it at once.

**Why:** derived output outlives its source by accident unless every path
checks, and stale output presented as current misleads.

**Enforced in:** `share-images.ts` (shared-page images keyed by content hash),
`document-preview-service.ts` and `html-preview.ts` (source revision and
`partial` status), `routes/file-links.ts` (access checked when a link is used),
`document-write-service.ts` (deletion).

**Proved by:**

- `share-links-store.test.ts` "shows the images a shared Doc embeds from its
  Space, and a changed image at once".
- `share-links-store.test.ts` "opens several links to one document on their
  own, and revoking one leaves the rest": a Doc deleted mid-render answers 404.
- `deleted-items.test.ts` "take their live editing state with them".
- `routes-documents.test.ts` "names the Docs that use a file on the file's
  page": a deleted Doc leaves Used in.
- `html-preview.test.ts` "captures live data, diagnoses forbidden on-load writes
  and bad assets, and bounds unsettled/static HTML".

**Gaps:** one search mode can show a deleted Doc's excerpt while a slow index
sync runs; activity-feed comment quotes outlive their Doc. No test uses a
download link after its maker lost access to the Space.

## Safety

### 12. File content is data, never authority

Opening, previewing or extracting a file gives its content no access to the
Worktable, the network, credentials or anyone's agents; text inside a file is
never an instruction. Simple text formats are parsed within stated limits.
Container, binary and scriptable formats are parsed in isolation, with limits on
size, entries, depth, time, memory and output, and each parser can be switched
off without blocking storage or download. Files are served with explicit types,
`nosniff` and a sandbox.

**Why:** anyone can put a file in a Space, including a file written to attack
whoever opens it.

**Enforced in:** `file-response.ts` (CSP sandbox, `nosniff`, inline only where
the type table allows), `packages/types/src/file-types.ts`,
`apps/web/src/components/file-page.tsx` (an outside `.html` shows in a
`sandbox=""` frame), `records-import.ts` (row and column limits).

**Proved by:**

- `routes-documents.test.ts` "uploads, serves and replaces files, keeping each
  version": `nosniff`, the sandbox policy, and which types are served inline.
- `routes-documents.test.ts` "keeps HTML that was there an HTML Doc, and takes
  HTML added later as a file a person can open": an outside `.html` is served
  under the sandbox policy.
- `mcp-documents.test.ts` "reads supported formats through one bounded inert
  projection": scripts and styles in a file never surface or run.

**Gaps:** no test covers the web page's `sandbox=""` frame. Worktable has no
container or binary parsers yet; the first one must follow this rule.

## Cost

### 13. Cost doesn't grow with file size where it needn't

Memory per transfer stays bounded whatever the file's size: large files stream,
with ranges. Lists read no file content. A hash is computed once per version and
reused. Long transfers never hold a lock that other work waits on. Slow work is
bounded and cancellable, and shows as pending until it's ready.

**Why:** one large file shouldn't slow everyone else's Worktable.

**Enforced in:** `file-revision.ts` (256 KiB chunks, read outside the Space
lock, hashes kept per revision), `staged-file.ts` and `file-uploads.ts`
(uploads stream to disk, one chunk in memory), `file-limits.ts`.

**Proved by:**

- `routes-documents.test.ts` "serves ranges of a file, streamed at one revision
  without holding its Space": a 304 without opening the file, and a write
  succeeds while a download streams.
- `routes-documents.test.ts` "streams an upload to disk as it arrives, and saves
  only a whole one".
- `workspace-snapshot.test.ts` "hashes only files whose identity changed since
  the last capture".
- `perf-smoke` file reads and stats per request, in
  `scripts/perf/smoke-budgets.json`. See [Keep Worktable fast](performance.md).

**Gaps:** an agent's read of a large binary file still loads the whole file into
memory before returning its download link, though outside the Space lock
(`current-file-source.ts`). No test shows that listing opens no file; only the
perf budget does.

### 14. Storage is accounted, bounded and recoverable

Limits count live files, history, deleted items and derived output. Transfers
in progress (uploads being received, export packages and import staging) are
temporary and don't count, by decision, so disk use can briefly exceed the
limit. Writes through Worktable can't pass it; writes on disk are counted. At
the limit the oldest history is pruned first, visibly. A write is refused (507
`STORAGE_LIMIT`) when it couldn't fit even if all prunable history went, in
which case nothing is pruned for it, or when pruning can't make room within a
few seconds. A person typing in a Doc
keeps saving at the limit, counted but never refused. At its limit a Worktable
still opens, reads, deletes and exports. What people delete leaves the
backed-up folder at once and is removed after the history window.

The default limit is 2 GiB, the most today's export can carry.
`WORKTABLE_STORAGE_LIMIT_BYTES` sets another; outside Cloud it is capped at
2 GiB. On Cloud it carries the plan's limit, which can be higher, while export
still stops at 2 GiB compressed (rule 16).

**Why:** a Worktable that fills its disk, or grows past what its backup and
export can carry, can't be recovered.

**Enforced in:** `storage-usage.ts`, `storage-limit.ts`, `storage-pruning.ts`,
`deleted-items.ts`.

**Proved by:**

- `storage-limit.test.ts` "prunes deleted items first, then the oldest versions,
  enough for writes asking at once and no more".
- `storage-limit.test.ts` "admits restores and saved versions for what they
  keep, prunes a version once no restore holds it, and refuses when nothing is
  left": reads, a smaller replace and a delete still work at the limit.
- `storage-limit.test.ts` "leaves transfers out, counts a write on disk past the
  limit, and refuses the next new write".
- `storage-usage.test.ts` "matches the disk through writes, a change on disk, a
  delete and an emptied trash".
- `deleted-items.test.ts` "move out of the workspace folder at once and are
  removed after the window".

**Gaps:**

- Nothing is refused until the first count, a few seconds after start.
- With history kept forever, deleted items are kept forever too.
- Removing Cloud backups after 30 days isn't built in this repository yet.
- The limit check doesn't cover annotations, Space metadata or pre-V2 HTML
  snapshots.
- No test covers a move or export at the limit.

## People and agents

### 15. Same file, same meaning

People and agents act on the same identities, revisions, permissions and bytes.
What they're shown may differ by interface, but it carries the same meaning and
says what's left out. What can be done with a file (view, contents, pictures,
compare, edit) is worked out for this file, revision, host and caller, each on
its own; one failing never takes the others down.

**Why:** an agent that sees a different file than its person makes changes the
person can't follow.

**Enforced in:** `document-catalog.ts`, `packages/types/src/file-types.ts`
(the agent policy beside the page policy), `file-limits.ts` (one no-history
reason for both), `mcp/file-results.ts`.

**Proved by:**

- `mcp-documents.test.ts` "sends a file to a one-time upload link and reads it
  back from a download link": the agent's bytes match the disk, and it gets the
  same no-history reason as the page.
- `routes-documents.test.ts` "keeps a version when a file with history changes
  on disk": the page's no-history reason.
- `mcp-document-previews.test.ts` "keeps HTML saved when preview runtime is
  unavailable and fences standalone captures to the source revision".

**Gaps:** a code file (such as `.py` or `.ts`) is a card to people but text to
agents. Plain text and logs are text to both; CSV and TSV are a table to people
and text to agents, which carries the same content. No test
checks that the HTTP API and agent tools report the same identity and revision
for one file.

### 16. Everything can be taken out

A whole Worktable exports as its original files plus what carries identity,
history and relationships, at every size Worktable allows, without needing
support for any file type.

**Why:** people trust a place with their files when they can leave with all of
them.

**Enforced in:** `workspace-transfer-v2.ts`, `workspace-transfer-jobs.ts`.

**Proved by:**

- `workspace-transfer-v2.test.ts` "creates a standard, independently browsable
  ZIP and round-trips content".
- `workspace-transfer-v2.test.ts` "keeps a file opened as an HTML Doc one
  through export and restore".
- `workspace-transfer-v2.test.ts` "supports all, none, age, and per-item history
  policies".
- `workspace-transfer-v2.test.ts` "stops ZIP generation at the archive ceiling
  and removes partial output".
- `workspace-transfer-v2.test.ts` "leaves links and special files out of a
  person's export, keeps hidden items, and refuses unsafe destinations".

**Gaps:** export stops at 2 GiB compressed and 8 GiB expanded. Outside Cloud
the storage limit is set to fit; a Cloud plan's limit can be higher. Share links and visitor comments live in app data, so an export doesn't
carry them.

## Hidden files

A file or Doc whose name starts with a dot, or that sits in a folder whose name
does, is hidden: it isn't listed, searched, shared or sent to agents, and
Worktable doesn't create or move anything there. Hidden items stay on disk and
go into exports and backups. The agent guidance says so.

Moving a folder takes its hidden items with it, as Finder or a shell does:
each hidden file, and each hidden folder whole, goes to the same place in the
new folder, byte for byte and still hidden, in the same move. A crash rolls
them back or forward with the folder's Docs. The move is refused when one
would land on something already there, when a name in the folder holds a
backslash, which Windows reads as a separator, or when something is mounted
in the folder. Links and special files stay
where they are. Moving one Doc or file doesn't touch hidden items beside it.

Deleting a folder takes everything in it: its Docs and files, and with them
its hidden items, links and special files, each as itself. A link is never
followed. They leave in the same delete, so a crash leaves the folder whole or
gone, and the folder is gone from disk. Files other Docs use stay when the
delete keeps them. Delete is permanent: what the folder held waits in deleted
items, outside backups and exports, until the history window ends (rule 14).
Emptying deleted items never crosses into another filesystem: an item that
holds one stays, logged, for an operator.
The delete is refused, naming the item, when something in the folder can't be
moved: a folder Worktable can't write, anything mounted inside (a bind mount
of the same disk included), or a name with a backslash. Deleting a whole
Space is refused the same way when something is mounted in it, or its folder
is a mount. A move or delete finds the folder on disk however its name's
case is written, and a delete that would lose a file it keeps rolls back.
Deleting one Doc or file doesn't touch hidden items beside it.

**Enforced in:** `document-format-registry.ts` (`isHiddenName`,
`pathIsHidden`), `document-adapters.ts` (discovery), `document-write-service.ts`
and `document-lifecycle-journal.ts` (creates and moves refused; a folder
move's plan carries hidden items, and a folder delete's plan takes the rest of
the folder), `store.ts` (`deleteSpace`), `deleted-items.ts` (into deleted
items, then gone). Listing,
search, sharing and agent tools all read the catalog, so they inherit it.

**Proved by:**

- `document-catalog.test.ts` "lists every visible file and Doc by its whole name
  once files are on": hidden Docs, and a stale inventory entry for one, aren't
  listed.
- `routes-documents.test.ts` "moves, archives, restores and deletes a plain
  file once files are on": a move into a hidden folder is refused.
- `workspace-snapshot.test.ts` "captures hidden items whole, and refuses
  in-workspace destinations, overwrites, and linked content".
- `routes-documents.test.ts` "moves mixed folders with common write authority,
  hidden items included": `.env`, `.git/HEAD` and a dot-named Doc arrive
  byte for byte, the listing is unchanged, and a link stays behind; a hidden
  new name is refused.
- `document-lifecycle-journal.test.ts` "recovers one all-or-nothing mixed
  folder generation": a crash before, during or after the hidden items move
  leaves them all in one folder.
- `routes-documents.test.ts` "deletes mixed folders with common write
  authority, files in them included": `.env`, `.git/HEAD`, a dot-named Doc and
  a link leave with the folder, byte for byte and the link as itself, and the
  folder is gone; a folder Worktable can't write refuses the delete by name.
- `document-lifecycle-journal.test.ts` "settles one mixed document folder
  atomically across compensation and committed recovery": after a crash at
  any point, the folder's contents are all in the folder or all deleted.
- `storage-usage.test.ts` "matches the disk through writes, a change on disk,
  a delete and an emptied trash": a deleted folder's hidden items count as
  deleted items until the window ends.
- `deleted-items.test.ts` "a crash mid-move leaves the store consistent, and
  the next pass finishes": a link and a FIFO reach deleted items on another
  disk.
- `deleted-items.test.ts` "move a deleted Space with its history, and clear
  what older versions left behind": a mount in the Space, or its folder being
  one, refuses the delete by name.

**Gaps:** a direct read by path of a symbolic link to a Doc still follows the
link.

## Agents

Agents learn these rules from the tools' descriptions and from
`worktable_guidance` topic `format_spec`. `format_spec` also says that hidden
files stay hidden, and that a write straight to disk is
last writer wins while a write through Worktable's tools with
`expectedRevision` is checked (`FILES_SPEC` in `mcp/format-spec.ts`). Any change to what agents receive is
an MCP change: hold it on the preview surface (`PREVIEW_CHANGES` in
`mcp/catalog.ts`, recorded in `mcp-tools.preview.json`) until agent directories
review it. See [Develop Worktable](development.md#generated-files).

## Adding a file type

A new file type ships when it passes the tests for the guarantees it uses. A
text viewer needs rules 1, 3, 7, 12 and 15; raising a size limit also needs 13,
14 and 16. Add the type to `packages/types/src/file-types.ts` with a policy for
every surface, and write down any deliberate difference with its reason.
