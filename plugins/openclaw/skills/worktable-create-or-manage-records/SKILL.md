---
name: worktable-create-or-manage-records
description: Organize repeated structured information as durable Worktable Records. Use for research datasets, inventories, directories, pipelines, trackers, and other collections whose items need identity, fields, filtering, links, validation, or individual updates.
---

# Organize Worktable Records

Treat a Record as a **thing with identity and a lifecycle**, not a row extracted from prose. Treat a collection schema as shared operational vocabulary that makes real items easier to find, compare, update, validate, and reuse.

## Decide whether Records earn their keep

Use Records when people or agents will repeatedly create, update, compare, filter, sort, group, assign, or validate individual items. Keep a plan, decision, argument, or research synthesis in a Doc when its meaning lives in the whole. Use an HTML Doc only when a task-specific view materially improves work over the canonical Records.

## Model from the work

- Start with the questions, views, and state changes the collection must support. Make each field enable a current edit, validation rule, query, automation, or materially better scan.
- Usually use one collection for one real entity type. Give each Record a recognizable title or name and deduplicate by real-world identity before creating it.
- Use select fields for controlled states that drive workflow. Use relations when the target is another independently changing entity.
- Require only identity and workflow-critical fields. Keep long shared context in a Doc and item-specific context in a concise text field when it truly belongs there.
- Keep field keys stable and display names clear. Worktable owns creation and update provenance; do not recreate it as domain fields without a real need.

## Build safely

1. Discover related Docs and collections. Query likely matches before creating a collection or Record; reuse established names and identities.
2. Define the minimum viable schema before the first insert. For a large or ambiguous extraction, confirm the proposed count and a representative sample before writing the full set.
3. Evolve populated schemas additively. Carry forward existing fields, preserve compatible types, and resolve validation conflicts rather than bypassing them.
4. Write or update Records, then query them through the filters and ordering the real workflow uses. Verify count, identity, field values, relations, and expanded references where relevant.
5. Use the built-in table for generic inspection. Add an HTML view only when its controls or visual form materially improve the task.

## Preserve identity and data

Do not invent missing values, duplicate a collection under a near-synonymous name, or replace a relation with copied display text. Treat warnings as evidence: repair duplicate identities, unrecognizable titles, schema conflicts, and invalid references when the source supports a correction.

Never delete Records, collections, or fields during routine organization. Use the explicit destructive surface only for an exact user-requested Record; collection and field deletion are not public skill operations. The result is complete when the collection remains understandable in the built-in table, contains no near-duplicate identities, and supports a real query or update without rereading the source transcript.
