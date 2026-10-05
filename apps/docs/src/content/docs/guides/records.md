---
title: Records
description: Track independently changing items with shared fields, filters, and schemas.
---

Use records for tasks, requests, inventory, sources, or other items that need
separate updates. A **collection** groups them; its **schema** defines fields
and validation. Use a document when the information is better read as prose.

## Open a collection

Choose a collection from the sidebar's **Records** section. The table supports
search, sorting, filter chips, grouping, and column selection. Groups can show
counts and sums. Your view settings persist across reloads, and the table URL
preserves the view for another person with workspace access.

Edit a cell directly, or open a row's detail view. On wide screens it appears
beside the table; on narrow screens it opens as a drawer. Use previous and next
to move between records, or **Open** for the full record page. You can edit,
duplicate, archive, or delete a record there.

## Define fields

Edit the schema from the collection grid to add or reorder fields, set display
names, choose types, and configure select options or relation targets. Document
fields link records to related work in the Space.

A schema change that would invalidate existing records is rejected and reports
the affected rows. Correct those values or adjust the proposed schema before
trying again.

Choose fields needed for editing, queries, or validation. For example, an
equipment-request collection could start with item, quantity, status, and
contact. Add other fields when they serve a specific task. The
[request workflow](/workflows/track-requests/) walks through an example.

## Work with agents

Ask an agent to find the relevant collection and inspect its schema before
creating or changing records. It can filter and sort records through Worktable's
tools, update selected items, and propose schema changes.

Records are also search results, so you can find them without opening the
collection first.

## Build a view

Use the built-in table for routine inspection and edits. An
[HTML doc](/guides/widgets/) can provide a board, calendar, form, or other
interface over the same collection. Keep the items in records so the table,
HTML doc, and agents all use the same data.

## Underlying files

Each record is a readable YAML file with its fields under `data`. Worktable
maintains a query index over those files. If external file edits outpace the
index, the table can show a **Reconcile** action to refresh it.

For file envelopes, field types, validation, and queries, see the
[records reference](/reference/records/).
