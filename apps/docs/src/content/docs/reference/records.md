---
title: Record schemas
description: Record envelopes, field types, query shapes, and validation.
---

Records are YAML files grouped into collections. A collection may have a schema.
Field keys identify stored values; display names can change without renaming keys.
Worktable keeps the files authoritative and maintains a rebuildable query index.

## File envelopes

A collection's `schema.yaml` includes its schema and provenance:

```yaml
version: 2
kind: worktable.recordSchema
id: requests
name: Requests
createdAt: "2026-10-01T09:00:00.000Z"
updatedAt: "2026-10-01T09:00:00.000Z"
createdBy: user
fields:
  title:
    type: text
    required: true
  status:
    type: select
    values: [open, done]
metadata: {}
```

An item such as `requests/repair-lamp.yaml` has a separate envelope:

```yaml
version: 1
kind: worktable.record
id: repair-lamp
collectionId: requests
createdAt: "2026-10-01T09:00:00.000Z"
updatedAt: "2026-10-01T09:00:00.000Z"
createdBy: user
archive: null
metadata: {}
data:
  title: Repair lamp
  status: open
```

The schema, record, and workspace versions are separate. Worktable assigns
provenance when writing through its tools; record values belong under `data`.
External YAML edits must preserve valid envelopes and quoted timestamp strings.

## Field types

| Type | Value |
| --- | --- |
| `text` | Text string |
| `url` | URL string |
| `email` | Email string |
| `number` | Number; optional `unit` metadata |
| `boolean` | `true` or `false` |
| `date` | Calendar-date string |
| `datetime` | Date-time string |
| `person` | Person string |
| `select` | One string from `values` |
| `multi_select` | Array of strings from `values` |
| `relation` | Record ID in the collection named by `references` |
| `document` | Space-relative document path |
| `json` | JSON-compatible value |

`many: true` permits arrays for `relation` and `document` fields. Relation metadata includes `inverse` and `onDelete`
(`restrict`, `setNull`, or `none`).

Legacy `string`, `enum`, and `reference` remain readable. `enum` uses select
semantics. Legacy references retain their looser string validation; they are not
silently rewritten as strict relation IDs. Writers stamp the lowest schema
version required by the fields and do not downgrade newer versions.

## Queries

`worktable_records_read` action `query` accepts search, filters, ordering,
projection, pagination, relation expansion, and aggregates. This request finds
open items and returns a bounded page:

```json
{
  "request": {
    "action": "query",
    "spaceId": "repair-event",
    "collectionId": "requests",
    "where": { "field": "status", "op": "eq", "value": "open" },
    "orderBy": [{ "field": "title", "dir": "asc" }],
    "limit": 50
  }
}
```

Compose predicates with `and`, `or`, or `not`. A leaf contains `field`, `op`,
and `value` where needed. Legacy flat filters remain supported; do not mix
flat keys into a predicate tree.

| Operator | Meaning |
| --- | --- |
| `eq`, `neq` | Equal or unequal |
| `in` | Matches a value in the supplied array |
| `contains` | Substring match |
| `has` | Exact array membership, or equality for a scalar |
| `gt`, `gte`, `lt`, `lte` | Ordered comparison |
| `isEmpty` | Empty when `value` is omitted or true; nonempty when false |

Queries support `count`, `sum`, `avg`, `min`, `max`, and `unique` aggregates.
Use the returned `nextCursor` for the next page with the same query. The maximum
page size is 1,000. Check returned warnings for invalid files or incomplete
results. HTML callers also need permission for collections reached through
relations or expansion.

## Schema changes

Worktable validates a proposed schema against existing records and identifies
rows that would become invalid. Carry forward fields you intend to retain when
upserting a schema. Removing a schema field does not erase its stored values.
Record updates preserve unspecified data fields; permanent deletion uses the
separate destructive tool.

The generated [MCP tools](/reference/mcp-tools/) catalog defines exact request
shapes. See [Manage records](/agents/records-and-schemas/) for the authoring
workflow and [Records](/guides/records/) for the built-in interface.
