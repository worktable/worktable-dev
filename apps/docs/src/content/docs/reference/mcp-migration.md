---
title: MCP migration
description: Mapping from earlier Worktable MCP tool shapes to the current tools.
---

## One tool for each job

Worktable now lists 30 tools. Each does one thing and takes its arguments
directly, without a `request` wrapper or `action` selector. Optional fields
choose what a tool acts on or returns. Calls in the earlier shapes keep working
for now, though they are no longer listed. Reconnect the MCP client so it
refreshes `tools/list`.

```json
{
  "name": "worktable_docs_read",
  "arguments": {
    "spaceId": "project",
    "docPath": "notes/plan"
  }
}
```

| Earlier call | Current call |
| --- | --- |
| `worktable_discover` `state` | `worktable_state` |
| `worktable_discover` `space_index`, or `worktable_space_index` | `worktable_state` with `spaceId` and `index: true` |
| `worktable_discover` `search` | `worktable_search` |
| `worktable_discover` `pending` | `worktable_pending` |
| `worktable_docs_read` `grep` | `worktable_search` with `exact: true`, or `regex: true` |
| `worktable_spaces` `create`, or `worktable_spaces_create` | `worktable_spaces_write` without `spaceId` |
| `worktable_spaces` `update`, or `worktable_spaces_update` | `worktable_spaces_write` with `spaceId` |
| `worktable_spaces` `archive` or `restore`, or `worktable_spaces_archive` and `worktable_spaces_restore` | `worktable_spaces_write` with `spaceId` and `archived: true` or `false` |
| `worktable_documents_read` or `worktable_files_read` `list` | `worktable_files_read` without `path` |
| `worktable_documents_read` or `worktable_files_read` `read` | `worktable_files_read` with `path` |
| `worktable_documents_read` or `worktable_files_read` `read_source` | `worktable_files_read` with `source: true` |
| `worktable_documents_read` or `worktable_files_read` `versions` | `worktable_files_read` with `versions: true` |
| `worktable_documents_read` or `worktable_files_read` `diff` | `worktable_files_read` with `from` |
| `worktable_documents_read` or `worktable_files_read` `render` | `worktable_files_render` |
| `worktable_documents_write` or `worktable_files_write` `create` | `worktable_files_write` with `source`, without `expectedRevision` |
| `worktable_documents_write` or `worktable_files_write` `replace` | `worktable_files_write` with `source` and `expectedRevision` |
| `worktable_documents_write` or `worktable_files_write` `restore_version` | `worktable_files_write` with `fromVersionId` |
| `worktable_documents_write` or `worktable_files_write` `upload` | `worktable_files_write` with `file`, or without `source` |
| `worktable_documents_write` or `worktable_files_write` `move`, `move_folder` | `worktable_files_update` with `newPath` |
| `worktable_documents_write` or `worktable_files_write` `archive`, `restore` and their folder versions | `worktable_files_update` with `archived: true` or `false` |
| `worktable_documents_write` or `worktable_files_write` `set_lifetime`, `set_folder_lifetime` | `worktable_files_update` with `lifetime` |
| `worktable_documents_write` or `worktable_files_write` `checkpoint` | `worktable_files_update` with `checkpoint: true` |
| `worktable_docs_read` `list` | `worktable_files_read` without `path` |
| `worktable_docs_read` `read` | `worktable_docs_read` |
| `worktable_docs_write` `write` | `worktable_docs_write` with `content` |
| `worktable_docs_write` `edit` | `worktable_docs_write` with `edits` |
| `worktable_docs_write` `rename` | `worktable_files_update` with `newPath` |
| `worktable_html_read` `guide` | `worktable_guidance` with `topic: "html"` |
| `worktable_html_read` `list` | `worktable_files_read` without `path` |
| `worktable_html_read` `read` | `worktable_html_read`, with `includeHtml` for the source |
| `worktable_html_read` `render` | `worktable_files_render` |
| `worktable_html_write` `create` | `worktable_html_write` without `htmlId` |
| `worktable_html_write` `update` | `worktable_html_write` with `htmlId` and `html` |
| `worktable_html_write` `rename` | `worktable_html_write` with `htmlId` and `name`, without `html` |
| `worktable_html_write` `move`, `archive`, `restore` | `worktable_files_update` |
| `worktable_drawings_read` `inspect`, `query`, `render` | `worktable_drawings_read` |
| `worktable_drawings_read` `changes` | `worktable_drawings_read` with `changes: true` |
| `worktable_drawings_write` `create` | `worktable_drawings_write` without `expectedRevision` |
| `worktable_drawings_write` `edit` | `worktable_drawings_write` with `expectedRevision` and `operations` |
| `worktable_drawings_write` `undo` | `worktable_drawings_write` with `undoChangeId` |
| `worktable_drawings_write` `redo` | `worktable_drawings_write` with `undoChangeId` and `redo: true` |
| `worktable_records_read` `list_collections` | `worktable_records_query` without `collectionId` |
| `worktable_records_read` `query` | `worktable_records_query` |
| `worktable_records_read` `read` | `worktable_records_query` with `recordId` |
| `worktable_records_write` `create`, `create_many`, `import` | `worktable_records_create` with `data`, `records` or `importPath` |
| `worktable_records_write` `update`, `update_many` | `worktable_records_update` |
| `worktable_records_write` `upsert_collection` | `worktable_records_upsert_collection` |
| `worktable_annotations_read` `list` | `worktable_annotations_read` without `annotationId` |
| `worktable_annotations_read` `read`, `context` | `worktable_annotations_read` with `annotationId`, and `includeTargetContext` |
| `worktable_annotations_write` `create` | `worktable_annotations_write` |
| `worktable_annotations_write` `reply` | `worktable_annotations_write` with `replyTo` |
| `worktable_annotations_write` `update` | `worktable_annotations_write` with `annotationId` and `patch` |
| `worktable_annotations_write` `resolve` | `worktable_annotations_write` with `annotationId` and `resolved: true` |
| `worktable_threads_read` `participants` | `worktable_threads_read` with `participants: true` |
| `worktable_threads_read` `list` | `worktable_threads_read` without `threadId` |
| `worktable_threads_read` `read` | `worktable_threads_read` with `threadId` |
| `worktable_threads_read` `message` | `worktable_threads_read` with `threadId` and `messageId` |
| `worktable_threads_read` `wait` | `worktable_threads_read` with `threadId`, `wait: true` and `after` |
| `worktable_threads_write` `post` | `worktable_threads_post` |
| `worktable_threads_write` `rename` | `worktable_threads_update` with `title` |
| `worktable_threads_write` `assign_response` | `worktable_threads_update` with `assignResponse` |
| `worktable_thread_delivery` `register_participant` | `worktable_delivery_claim` with `registerAs` |
| `worktable_thread_delivery` `claim` | `worktable_delivery_claim` |
| `worktable_thread_delivery` `accept`, `progress`, `fail` | `worktable_delivery_report` with `status` `accepted`, `progress` or `failed` |
| `worktable_delete` `document` | `worktable_delete` with `path` |
| `worktable_delete` `document_folder` | `worktable_delete` with `path` and `folder: true` |
| `worktable_delete` `record` | `worktable_delete` with `collectionId` and `recordId` |
| `worktable_guidance` `format_spec`, `drawings` | `worktable_guidance` with `topic` |
| `worktable_mermaid` `validate` | `worktable_mermaid` |
| `worktable_mermaid` `preview` | `worktable_mermaid` with `preview: true` |

`search` and `fetch` are unchanged.

## Capability tools in 0.0.37

Worktable 0.0.37 replaced the operation-per-tool MCP API with an initial set of
13 capability tools. The capability surface has grown since then, but the
migration rule remains: calls wrap action-specific arguments in `request`.
Reconnect the MCP client after upgrading so it refreshes `tools/list`.

```json
{
  "name": "worktable_docs_read",
  "arguments": {
    "request": {
      "action": "read",
      "spaceId": "project",
      "docPath": "notes/plan"
    }
  }
}
```

| Previous tool                          | Replacement                                              |
| -------------------------------------- | -------------------------------------------------------- |
| `worktable_state`                      | `worktable_discover` action `state`                      |
| `worktable_search`                     | `worktable_discover` action `search`                     |
| `worktable_space_index`                | `worktable_discover` action `space_index`                |
| `worktable_create_space`               | `worktable_spaces` action `create`                       |
| `worktable_list_docs`                  | `worktable_docs_read` action `list`                      |
| `worktable_read_doc`                   | `worktable_docs_read` action `read`                      |
| `worktable_write_doc`                  | `worktable_docs_write` action `write`                    |
| `worktable_patch_doc`                  | `worktable_docs_write` action `edit` (exact text)        |
| `worktable_rename_doc`                 | `worktable_docs_write` action `rename`                   |
| `worktable_delete_doc`                 | `worktable_delete` action `doc`                          |
| `worktable_get_widget_authoring_guide` | `worktable_html_read` action `guide`                     |
| `worktable_list_widgets`               | `worktable_html_read` action `list`                      |
| `worktable_read_widget`                | `worktable_html_read` action `read`                      |
| `worktable_create_widget`              | `worktable_html_write` action `create`                   |
| `worktable_update_widget`              | `worktable_html_write` action `update`                   |
| `worktable_rename_widget`              | `worktable_html_write` action `rename`                   |
| `worktable_archive_widget`             | `worktable_html_write` action `archive`                  |
| `worktable_restore_widget`             | `worktable_html_write` action `restore`                  |
| `worktable_delete_widget`              | `worktable_delete` action `html`                         |
| `worktable_list_record_collections`    | `worktable_records_read` action `list_collections`       |
| `worktable_query_records`              | `worktable_records_read` action `query`                  |
| `worktable_read_record`                | `worktable_records_read` action `read`                   |
| `worktable_upsert_record_collection`   | `worktable_records_write` action `upsert_collection`     |
| `worktable_create_record`              | `worktable_records_write` action `create`                |
| `worktable_update_record`              | `worktable_records_write` action `update`                |
| `worktable_delete_record`              | `worktable_delete` action `record`                       |
| `worktable_list_annotations`           | `worktable_annotations_read` action `list`               |
| `worktable_read_annotation`            | `worktable_annotations_read` action `read`               |
| `worktable_get_annotation_context`     | `worktable_annotations_read` action `context`            |
| `worktable_create_annotation`          | `worktable_annotations_write` action `create`            |
| `worktable_reply_annotation`           | `worktable_annotations_write` action `reply`             |
| `worktable_update_annotation`          | `worktable_annotations_write` action `update`            |
| `worktable_resolve_annotation`         | `worktable_annotations_write` action `resolve`           |
| `worktable_get_format_spec`            | `worktable_guidance` action `format_spec`                |
| `worktable_read_skill`                 | Retired; read workspace `skills/` paths as ordinary Docs |
| `worktable_validate_mermaid`           | `worktable_mermaid` action `validate`                    |
| `worktable_preview_mermaid`            | `worktable_mermaid` action `preview`                     |
| `worktable_docs_write` action `patch`  | `worktable_docs_write` action `edit`                     |

Public HTML arguments use `htmlId`. Legacy API and application routes retain
`widgets` names, but current workspace storage uses HTML files in the Space
document tree. Annotation authorship comes from the authenticated caller.

The HTML guide accepts only the `runtime` profile. Install the optional HTML
Agent Skill for visual composition and authoring workflow.
