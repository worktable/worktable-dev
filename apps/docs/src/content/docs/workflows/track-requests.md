---
title: Track requests
description: Create a small records collection and update items without losing their identity.
---

Use records when items change independently and share fields. This example
tracks fictional equipment requests for a repair workshop.

## Create the collection

Ask your connected agent:

```text
In the Community workshop Space, find or create an Equipment requests
collection. Use a required title field displayed as Item, a numeric quantity,
and a status field with requested, confirmed, and unavailable choices.

Add these fictional requests if they are not already present:
- Folding tables: quantity 4, requested
- Desk lamps: quantity 6, requested
- Extension leads: quantity 3, confirmed

Use one record per request. Do not add owners, dates, or other facts we
have not supplied. Link me to the collection.
```

Open the collection from the Space's **Records** section. Check the three rows
and field types. Quantity should support numeric values, and status should use
the agreed options.

## Update an item

Change the folding-table status to **confirmed** in the table. Open its detail
view to verify the saved value. Then tell the agent:

```text
The desk-lamp request is now unavailable. Update that existing record,
then list the confirmed equipment and quantities.
```

The result should include four folding tables and three extension leads. It
should preserve the lamp request with its new status rather than delete it or
create a duplicate.

## Find outstanding work

Filter the table by status, or ask the agent to query requests that are not
confirmed. Grouping by status makes counts visible as the collection grows.

If a workflow later needs assignment, add a contact field through the schema
editor. Existing data must remain valid when the schema changes.

The built-in table is enough for this example. Add an [HTML doc](/guides/widgets/)
when a board, form, or other interface serves a specific task, and have it use
the same collection.
