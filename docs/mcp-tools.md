# MCP tool reference

When an agent connects to Worktable over [MCP](connect-your-agent.md), it gets the tool surface below — 36 tools across discovery, docs, widgets, records, annotations, and diagrams. This is a snapshot of the Worktable MCP registry; the running server is always the source of truth.

> New to the workspace? Start with `worktable_state`, then `worktable_get_format_spec`, then `worktable_read_skill`.

## Workspace & discovery

| Tool | What it does |
|---|---|
| `worktable_state` | See what exists in the workspace — call early in a session. Summarizes spaces, or returns full detail for one `spaceId`. |
| `worktable_search` | Search the workspace before asking the user for context — plans, decisions, research, and reference docs often already exist. Fuzzy + ranked. |
| `worktable_create_space` | Create a new space. Returns the `spaceId`. |
| `worktable_get_format_spec` | Read the content model and surface guidance — use when choosing between Docs, Widgets, and Records. |
| `worktable_read_skill` | Learn how to work in this workspace; read once per session. Start with `name='agent-instructions'`; omit `name` to list all instruction docs. |

## Docs

| Tool | What it does |
|---|---|
| `worktable_list_docs` | List docs in a space with discovery metadata. Use before reading or editing. |
| `worktable_read_doc` | Read a doc by `spaceId` + `docPath`. Returns markdown when safe, BlockNote when rich content would be lossy. |
| `worktable_write_doc` | Create or replace a doc — markdown strings for plain docs, BlockNote arrays for rich docs. |
| `worktable_patch_doc` | Surgically edit a doc by heading, text search, block ID, index, or append. Prefer over full rewrites. |
| `worktable_rename_doc` | Rename or move a doc within a space. |
| `worktable_delete_doc` | Delete a doc from a space. |

## Widgets

| Tool | What it does |
|---|---|
| `worktable_get_widget_authoring_guide` | Read the canonical Widget Authoring Contract. Call before creating or updating widgets. |
| `worktable_list_widgets` | List widgets in a space (metadata only). |
| `worktable_read_widget` | Read a widget by id — metadata plus the self-contained `index.html` and validation warnings by default. |
| `worktable_create_widget` | Create a widget. Read the authoring guide first, grant needed record permissions, then fix validation warnings. |
| `worktable_update_widget` | Update a widget. Read the existing widget + authoring guide first; preserve permissions unless intentionally changing them. |
| `worktable_rename_widget` | Rename a widget / update its description without rewriting the HTML. |
| `worktable_archive_widget` | Hide a widget from normal lists without deleting its files. |
| `worktable_restore_widget` | Restore an archived widget. |
| `worktable_delete_widget` | Permanently delete a widget directory. Prefer archiving. |

## Records

| Tool | What it does |
|---|---|
| `worktable_list_record_collections` | List file-backed record collections, with optional schema summaries and active counts. |
| `worktable_upsert_record_collection` | Create or update an optional schema for a collection. Schemas validate future writes. |
| `worktable_query_records` | Query records in a collection — field filters, search, order, limit, archived inclusion. |
| `worktable_read_record` | Read one record by collection + id. |
| `worktable_create_record` | Create a record. Derives a canonical id from title/name if `recordId` is omitted. |
| `worktable_update_record` | Patch a record's data and/or metadata. Existing fields are preserved unless replaced. |
| `worktable_delete_record` | Permanently delete a record. Prefer updates / status changes. |

## Annotations

| Tool | What it does |
|---|---|
| `worktable_list_annotations` | List annotations — the human↔agent instruction channel. Check at session start and before editing any doc. |
| `worktable_read_annotation` | Read a single annotation thread; optionally include the anchored block/excerpt and nearby context. |
| `worktable_create_annotation` | Attach an annotation to a doc, block, or text range. Use `category='instruction'` for actionable feedback. |
| `worktable_reply_annotation` | Reply to a thread with progress, questions, or review notes. |
| `worktable_update_annotation` | Update annotation metadata — title, body, status, labels. |
| `worktable_resolve_annotation` | Resolve an annotation with an optional reason. |
| `worktable_get_annotation_context` | Return the target block/excerpt and anchor confidence for an annotation. |

## Diagrams

| Tool | What it does |
|---|---|
| `worktable_validate_mermaid` | Validate raw Mermaid source before writing it into a doc. |
| `worktable_preview_mermaid` | Validate and render Mermaid source to SVG for a lightweight preview loop before saving. |
