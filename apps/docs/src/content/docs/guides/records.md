---
title: Records
description: Structured state as readable YAML is shared memory between you, your agents, and your HTML docs.
---

Records are for independently useful things that repeat, change separately, or benefit from shared fields and queries: tasks, sources, feedback items, inventory, metrics. Instead of an agent reconstructing current state from prose every session, it queries records, and so do HTML docs, and so do you.

## YAML you can read

Every record is one YAML file in your workspace, like a small envelope of bookkeeping, with your fields under `data`:

```yaml
version: 1
kind: worktable.record
id: ship-onboarding-flow
collectionId: launch-tasks
createdBy: agent
data:
  title: Ship the onboarding flow
  status: in-progress
  owner: me
  due: 2026-07-10
```

Open it in an editor, change a field under `data`, and the app and your agents see it immediately. There's no database hiding behind the product; the files are the database.

## Collections and schemas

Records live in collections, and collections can have schemas as field names and types that validate future writes. Edit a schema right from the collection's grid: add fields, set a display name, configure select options, relation targets, or a document field linking to another doc in the space, reorder fields, and change types, all without hand-editing YAML. A change that would break existing records is rejected and names the affected rows, so you fix the data or loosen the change instead of losing it silently.

Agents start with the smallest schema that supports what you are doing now, then evolve it as repeated use reveals a need. Collection descriptions stay very concise. Field descriptions are optional when the name, type, and choices are already clear. A complex operational collection is welcome when its fields have real jobs; the goal is understandable structure, not a low field count.

## Where records show up

- **The sidebar's Records section** lists your collections; open one for a sortable, searchable grid where every cell edits in place, and click a row to open its detail view, a resizable rail on wide screens or a drawer on narrow ones, with previous/next navigation, connected documents, provenance, and an Open link to the full record page when you want more room. From there you can edit, duplicate, archive, or delete the record. The built-in table is for generic inspection, correction, and lightweight management. Filter with chips, group rows by a field for live per-group counts and sums, and show, hide, or reorder columns. Your filters, grouping, sorting, and column choices persist across reloads, and the current table can be shared with its URL. If files changed outside Worktable faster than the grid could catch up, a chip shows how many are indexed with a one-click Reconcile action.
- **Search**: records are first-class results, searchable from the sidebar on any page, not just Space Home.
- **HTML docs** — the interface layer for a collection when a generic table is not enough: boards, calendars, dashboards, forms, planners, and workflow-specific tools that stay live as records change.
- **Agents** — querying with filters and ordering instead of paging through files.

## Records or a doc?

Meaning in prose → Doc. Independently changing items that need shared operations → Records. Most projects want both, connected: the decisions Doc explains *why*, while the collection tracks *what and where it stands*. Repeated headings alone are not a reason to extract records. See [records and schemas](/agents/records-and-schemas/) for the agent-side practice.
