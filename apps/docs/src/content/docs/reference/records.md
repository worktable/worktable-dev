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
and `value` where needed. A flat filter such as `{ "status": "open" }` or
`{ "due": { "gte": "2026-01-01" } }` means the same tree and works with every
other option; do not mix flat keys into a predicate tree. Search matches field
values, not field names.

| Operator | Meaning |
| --- | --- |
| `eq`, `neq` | Equal or unequal |
| `in` | Matches a value in the supplied array |
| `contains` | Substring match |
| `has` | Exact array membership, or equality for a scalar |
| `gt`, `gte`, `lt`, `lte` | Ordered comparison |
| `isEmpty` | Empty when `value` is omitted or true; nonempty when false |

Queries support `count`, `sum`, `avg`, `min`, `max`, and `unique` aggregates.
Over MCP, grouping by a multi-select field counts each value. Select fields
sort in the order their options are listed. Whenever more records match than
the page holds, the result includes `nextCursor`; pass it as `cursor` with the
same query. An MCP query without `limit` returns 100 records. The maximum page
size is 1,000. Check returned warnings for invalid files or incomplete
results. HTML callers also need permission for collections reached through
relations or expansion.

## Schema changes

Worktable validates a proposed schema against existing records and identifies
rows that would become invalid. Over MCP, `upsert_collection` merges fields by
key: the fields you send are added or replaced, the rest stay, and the result
lists them in `fieldChanges`. Remove a field in the schema editor. Removing a
schema field does not erase its stored values.

Creating a record with an `id` that already exists never overwrites it. MCP
returns the stored record with `created: false`; REST and HTML Docs answer
`409 CONFLICT`. Derive the id from a natural key, such as a normalized URL, to
add each item once. Record updates preserve unspecified data and metadata keys;
permanent deletion uses the separate destructive tool.

The generated [MCP tools](/reference/mcp-tools/) catalog defines exact request
shapes. See [Manage records](/agents/records-and-schemas/) for the authoring
workflow and [Records](/guides/records/) for the built-in interface.
