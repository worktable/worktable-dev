---
title: Records reference
description: Collection schemas, field types, query operators, aggregates, and limits.
---

Records are YAML files grouped into collections. A collection may have a schema;
each field key is its stable identity even when the display name changes.

## Field types

New schemas can use these field types:

| Type           | Value                                  |
| -------------- | -------------------------------------- |
| `text`         | Plain text                             |
| `url`          | URL text                               |
| `email`        | Email address text                     |
| `number`       | Number                                 |
| `boolean`      | Boolean                                |
| `date`         | Calendar date                          |
| `datetime`     | Date and time                          |
| `person`       | Person value                           |
| `select`       | One configured option                  |
| `multi_select` | Multiple configured options            |
| `relation`     | Reference to another record collection |
| `document`     | Reference to a Worktable doc           |
| `json`         | Arbitrary JSON-compatible value        |

Legacy `string`, `enum`, and `reference` fields remain supported. Worktable
treats `enum` as `select` and `reference` as `relation`; `string` remains
unchanged.

## Query operations

`worktable_records_read` action `query` supports full-text search, field
projection, ordering, pagination, relations, and filters. Filter operators are:

| Operator                 | Meaning                             |
| ------------------------ | ----------------------------------- |
| `eq`, `neq`              | Equal or not equal                  |
| `in`                     | Value is in a supplied set          |
| `contains`               | Text or collection contains a value |
| `has`                    | Multi-value field has a value       |
| `gt`, `gte`, `lt`, `lte` | Ordered comparison                  |
| `isEmpty`                | Field is or is not empty            |

Queries can calculate `count`, `sum`, `avg`, `min`, `max`, and `unique`
aggregates. The maximum requested page size is 1,000 records; use the returned
pagination state for larger collections.

## Schema changes

Schemas are optional. When a populated collection has one, Worktable validates
schema changes against its existing records and reports the record ids that
would become invalid. Removing a schema field does not silently erase that key
from record files. Record deletion is permanent, so a domain status is often a
better lifecycle mechanism.

The generated [MCP tool catalog](/reference/mcp-tools/) is the normative request
shape for collection, query, create, and update actions.
