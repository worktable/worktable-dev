---
title: Interactive tools
description: Build a budget explorer, test its calculations, and revise the same HTML document.
---

An HTML doc can turn fixed inputs into a tool you can inspect and adjust. This
example estimates the cost of a fictional workshop without needing a records
collection or external service.

## Specify the inputs

Ask your connected agent:

```text
Create a durable Workshop budget HTML doc in the Community workshop Space.
Reuse it if it already exists. Use these fictional assumptions:
- Room hire: $180
- Equipment: $40
- Materials: $8 per attendee
- Expected attendees: 20

Let me change attendee count and equipment cost. Show fixed cost,
materials cost, total cost, and cost per attendee. Display the assumptions
and formulas. Reject negative values and fractional attendee counts.
At zero attendees, show cost per attendee as unavailable.

Keep the tool self-contained, with no network access or records collection.
Preview it and check the calculations before giving me the link.
```

## Check the result

Open the HTML doc and try these inputs:

| Attendees | Equipment | Expected total | Per attendee |
| --- | --- | --- | --- |
| 20 | $40 | $380 | $19 |
| 10 | $40 | $300 | $30 |
| 0 | $40 | $220 | Unavailable |

Check that the controls reject negative costs and fractional attendee counts.
The tool should expose its assumptions so you can tell whether its result fits
your situation.

## Revise the tool

Ask the agent:

```text
Update Workshop budget to include an optional 10% contingency on the
whole total. Keep the existing controls and show base and adjusted totals.
Leave contingency off by default. Test both settings.
```

At 20 attendees and $40 equipment cost, the base total should remain $380 and
the contingency total should be $418. Review the same document and compare its
history if needed.

If the tool should later track actual requests or purchases, add records for
those independently changing items. For a public link, remember that
[shared HTML](/guides/sharing/) does not run interactive scripts.
