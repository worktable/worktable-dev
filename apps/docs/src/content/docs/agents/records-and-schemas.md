---
title: Records and schemas
description: How agents keep structured state in file-backed YAML records.
---

Records are structured state as readable YAML files. Use them when items have independent identity, change separately, recur, or need validation and queries across the set. Introduce the smallest durable structure that makes the user's current work easier, then add complexity only for a concrete workflow or explicit request.

## Choose the artifact first

Reach for Records when people or automations will repeatedly create, update, compare, filter, sort, group, assign, or validate individual items. Tasks, inventory, contacts, feedback, and operational events often fit.

Prefer a Doc when the value is narrative, reasoning, synthesis, a plan, or a decision read as a whole. A document's headings and mentioned nouns are not automatically records. Prefer an HTML doc when interaction or a custom experience is materially useful, and an annotation for situated feedback.

Explicit user intent wins. A financial ledger or scientific dataset may need a detailed schema; an exhaustive catalog may need many records. Simplicity is a reasoning default, not a field-count rule.

## Start with a minimum viable schema

Define the collection's fields before inserting:

```txt
worktable_records_write  # action: upsert_collection
```

Schemas are optional, but define the smallest useful schema before inserting into a collection you create. Every field should support at least one current use: an independent edit, validation rule, filter/sort/group/search operation, automation, or materially better default scan. If it does not, keep that information in the source Doc rather than copying prose into another column.

Keep the collection description to a very concise statement of what belongs. Field descriptions are optional: add one only when the field's name, type, and choices do not already make its meaning clear.

Changing a populated schema is checked against every existing record. A change that would break rows is rejected with the offending record ids so you can fix the data or loosen the change instead of applying it silently.

## Working with records

- `worktable_records_read` action `query` handles filters, search, ordering, limits, projection, relations, and pagination.
- `worktable_records_write` action `create` creates one Record; omit `recordId` to derive it from title or name.
- `worktable_records_write` action `update` patches data while preserving unspecified fields.
- `worktable_delete` action `record` is permanent. Prefer a status change when possible.

Before writing, list existing collections and query for duplicates or related records. Reuse compatible fields instead of creating synonyms. Worktable may return advisory warnings about schema shape, duplicated provenance, or record identity; the write still succeeds, and justified complexity remains allowed.

For a large or ambiguous initial extraction, tell the user the proposed count, show a small sample, and explain how you will merge or deduplicate before making the individual record calls. Do not repeat that interruption for routine additions after the user has established the collection and pattern. The current MCP has no bulk preview/write operation.

## When records beat docs

Reach for Records when items have independent value and shared fields enable real operations; reach for Docs when meaning lives in prose. A project may want both. The `format_spec` action in `worktable_guidance` is the normative guide when the choice is unclear.

Records are plain files in the human's workspace: they read and edit the same YAML you do, and HTML docs subscribe to the same collections. A field's key is its permanent identity; give it a separate display name when the key alone wouldn't read naturally to a human.

System provenance such as created/updated timestamps and actor identity already lives in the record envelope. Do not duplicate it in user-visible fields unless the user needs a distinct domain value to query. Removing a field from a schema does not purge its values from record files; show the effect before destructive cleanup.

The built-in records table is the default for generic inspection and quick corrections. When the human needs a board, planner, dashboard, form, or workflow-specific controls, build an HTML doc that queries and updates the canonical collection. Keep durable domain data in records; use HTML-doc state only for interface-local preferences.

For field types, query operators, aggregates, and limits, use the
[records reference](/reference/records/).
