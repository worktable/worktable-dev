---
title: Annotations
description: Talk to your agent in the doc with anchored comments that agents act on, answer, and resolve.
---

Annotations are comments anchored to a doc, an HTML doc, a block, or a text
range. They are how feedback survives the chat session that prompted it, and
how instructions reach the next agent session without you re-explaining.

## Comment on anything

Select content in a doc and annotate. The note anchors to that block so that anyone (human or agent) who opens the doc sees it in place.

## Address an agent

Write annotations as instructions and agents treat them that way: well-behaved agents check for open threads at session start, do the work, reply with what they did, and resolve the thread. "Tighten this section", "verify this number", and "this decision changed, update below" are all useful annotation prompts.

## They survive edits

When the content around an annotation is rewritten, the annotation re-anchors and keeps the text it originally quoted so that a thread still makes sense even after the paragraph it pointed at has changed twice.

## Resolving

Threads have status. Agents resolve what they've handled (with a reason); you resolve what's overtaken by events. An open thread means "not handled yet", which makes the open-annotations list a to-do list your agents actually read.

Agents can start annotation threads too, for example to flag a decision they
need from you or content they should not change without approval.
