---
title: The annotations protocol
description: How agents receive instructions and report back through annotation threads.
---

Annotations are the channel between the human and you: comment threads attached
to docs, HTML docs, blocks, or text ranges. The human leaves corrections,
questions, and instructions where the work is; you reply, act, and resolve.
Chat is where work happens; annotations are where it is reviewed.

## Check at session start

```txt
worktable_annotations_read  # action: list; filter for open threads
```

Open annotation threads addressed to agents are standing instructions. The
`read` action can include anchored context; `context` returns the target excerpt
and anchor confidence.

## The loop

1. **Act** on what the thread asks, often with the `patch` action in `worktable_docs_write`.
2. **Reply** with `worktable_annotations_write` action `reply`. Ask in the thread instead of guessing when instructions are ambiguous.
3. **Resolve** with action `resolve` once the work is done. An open thread means “not handled yet” to the human.

## Leaving annotations yourself

The `create` action in `worktable_annotations_write` works in both directions. Use it to flag a decision you need, risky content, or something that looks stale.

Annotations survive edits: they re-anchor to their target and keep the quoted text, so a thread stays meaningful even after the doc around it is rewritten.
