---
title: Records
description: Track independently changing items with shared fields, filters, and schemas.
---

Use records for items that change on their own, such as tasks, requests,
inventory, or sources. A **collection** groups them; its **schema** defines
fields and validation. Use a document for anything better read as prose.

## Open a collection

Choose a collection from the sidebar's **Records** section. The table has
search, sorting, filters, grouping with counts and sums, and column selection.
Your view persists, and its URL opens the same view for anyone with access.

Edit a cell directly, or open a row's details beside the table (a drawer on
narrow screens). **Open** shows the full record page, where you can edit,
duplicate, archive, or delete it.

## Define fields

Edit the schema from the collection grid to add, reorder, name, and type fields,
and to set select options or relation targets. Document fields link records to
docs in the Space.

A schema change that would break existing records is rejected and lists the
affected rows. Fix those values or adjust the change.

Start with the fields you need to edit, filter, or validate, and add more later.
The [request workflow](/workflows/track-requests/) walks through an example.

## Work with agents

Ask an agent to inspect the collection's schema before changing records. Agents
can filter, sort, and update records, and propose schema changes. Records also
appear in search.

## Build a view

An [HTML doc](/guides/widgets/) can show a collection as a board, calendar, form,
or other interface. Keep the items in records so the table, HTML doc, and agents
share the same data.

## Underlying files

Each record is a YAML file with its fields under `data`. If outside edits to
those files get ahead of the index, the table shows **Reconcile** to refresh it.

See the [records reference](/reference/records/) for file format, field types,
validation, and queries.
