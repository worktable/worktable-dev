---
title: Writing docs
description: How agents write, patch, and place docs in a Worktable workspace.
---

Docs are versioned documents — markdown strings or rich BlockNote arrays — for prose that should outlive the chat: plans, research, decisions, notes. The `format_spec` action in `worktable_guidance` is the normative source for formats; this page covers the working patterns.

## Understand the space before you write

Placement is part of the content. The `space_index` action in `worktable_discover` gives a server-generated map of the space. Use it, or the `list` action in `worktable_docs_read`, to understand the organization before writing.

## Patch before you rewrite

The `patch` action in `worktable_docs_write` edits surgically by heading, text search, block ID, index, or append. Use `write` for new Docs or deliberate replacements. Extend an existing relevant Doc instead of creating a near-duplicate.

## Write for retrieval

You will read this doc again in a later session — so will other agents, and so will the human.

- Lead with the conclusion; add a one-paragraph summary up top.
- Dates absolute, decisions with their why.
- Link related docs by path: `[Title](/other-doc)`. To hand the human a clickable link outside Worktable (chat, email), use the `urlToSendInChat` field a tool result returns for that doc, not a raw path.
- Split a doc that outgrows one sitting; keep folder nesting to two levels.

## What the server tells you back

Doc writes return convention guidance as warnings — broken links, a missing title heading, over-long docs, overly deep folders. Fix what the warnings name, but they don't block the write. Three things are absolute instead: never write index docs (the server generates the index), never mark content as reviewed (that signal belongs to the human), and an invalid Mermaid diagram rejects the whole write with a location-aware error until you fix the source (see [Docs and versions](/guides/docs-and-versions/#diagrams)).

## Working with drawings

Drawings use `worktable.quickdraw`, source version `1`, in `.quickdraw` files.
Use `worktable_documents_read` with `action: "read_source"`, decode the base64
source, and preserve the existing records when editing the Quickdraw snapshot.
Replace it through `worktable_documents_write` with `action: "replace"` and
`expectedRevision` set to the returned `sourceRevision` so concurrent changes are detected.

Typed text is searchable; freehand marks need a PNG or browser inspection to
interpret. Drawing changes are not merged live: ask the human to use
**Reload drawing** to see your edits. See [Drawings](/guides/docs-and-versions/#drawings)
for export and conflict recovery.
