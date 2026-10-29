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

Open the collection from the Space's **Records** section and check the three
rows, the numeric quantity, and the status options.

## Update an item

Change the folding-table status to **confirmed** in the table. Open its detail
view to verify the saved value. Then tell the agent:

```text
The desk-lamp request is now unavailable. Update that existing record,
then list the confirmed equipment and quantities.
```

The result should list four folding tables and three extension leads. The lamp
request should keep its record with the new status, not be deleted or
duplicated.

## Find outstanding work

Filter or group the table by status, or ask the agent for requests that are
not confirmed.

To assign requests later, add a contact field in the schema editor. Existing
data must stay valid when the schema changes. For a board or form, add an
[HTML doc](/guides/widgets/) that uses the same collection.
