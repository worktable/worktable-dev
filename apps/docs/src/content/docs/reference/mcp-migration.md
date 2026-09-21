---
title: MCP capability migration
description: Mapping from the pre-0.0.36 operation tools to the consolidated capability API.
---

Worktable 0.0.36 replaced the operation-per-tool MCP API with an initial set of
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
| `worktable_patch_doc`                  | `worktable_docs_write` action `patch`                    |
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

Public HTML arguments use `htmlId`; the internal storage directory and application URL remain named `widgets`. Annotation authorship always comes from the authenticated caller. Patch operations must now be an array rather than a JSON-encoded string.

The HTML guide accepts only the `runtime` profile. Install the optional HTML
Agent Skill for visual composition and authoring workflow.
