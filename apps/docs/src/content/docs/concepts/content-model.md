---
title: Worktable's content model
description: Four content primitives inside Spaces, plus durable conversations.
---

Worktable has four content primitives inside Spaces: docs, HTML docs, records,
and annotations. Threads add conversations at either the Worktable or Space
level. You get the best results by giving each kind of information one clear
home.

## Space

A project, workstream, or operating context that groups durable work. Create
one per project or domain, not per task. Opening a Space shows **Space Home**, an
automatic overview of its contents.

## Doc

Narrative knowledge: notes, plans, briefs, research, and decisions. Docs come
in Markdown and rich-text formats with version history, so an agent rewrite can
be compared or restored. **Reach for a doc when the meaning lives in prose.**
How-to: [docs and versions](/guides/docs-and-versions/).

## HTML doc

A self-contained interactive page an agent builds for you: a visual plan,
explorer, review room, dashboard, or one-off tool. HTML docs run sandboxed, keep
version history, and have no network access unless you grant it. They can work
with records and remember interface settings. **Reach for an HTML doc when a
richer interface beats a wall of text.** How-to:
[HTML docs](/guides/widgets/).

## Record

Structured data as readable YAML files: one record per file, in collections
with optional schemas shared between agents, HTML docs, and the UI. **Reach for
records when items have independent identity and shared fields enable separate
updates, validation, or queries across the set.** How-to:
[records](/guides/records/).

## Annotation

Feedback and instructions anchored to docs, HTML docs, blocks, or text ranges.
The human leaves a note, an agent replies or acts, and the annotation thread can
be resolved. **Reach for an annotation when feedback belongs to a specific
piece of existing work.** How-to: [annotations](/guides/annotations/).

## Thread

A durable conversation with a connected participant. A Worktable thread is
general; a Space thread carries that Space's context. A thread is not a fifth
Space artifact and is not anchored to a doc. **Reach for a thread when the
conversation itself should persist and continue.** How-to:
[Worktable and Space threads](/guides/threads/).

## How they combine

A research effort might use a **doc** for the synthesis, **records** for sources,
an **HTML doc** for a review room, **annotations** to request revisions, and a
**Space thread** to continue a conversation with an always-on agent. Promote the
resulting decisions back into the doc so the current state remains easy to find.
