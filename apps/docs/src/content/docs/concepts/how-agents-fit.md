---
title: How agents fit in
description: Agents create and maintain workspace content; you direct and review through the app.
---

Worktable is built for a specific division of labor: agents produce and
maintain durable work; you direct and review it. This page is the human view of
that loop. Agents get [their own section](/agents/overview/).

## Connected MCP clients

A connected coding agent or AI app can discover the workspace, search, work
with docs and records, build HTML docs, and handle annotations according to the
access you approved. Setup differs between local, self-hosted, and Cloud
Worktable, but the work itself follows the same content model.

Connections do not all need the same access. A normal content client can work
across the workspace, while a specialized participant may be limited to
conversations. **Settings → Agents** shows the setup and controls available for
the current deployment.

Worktable gives connected agents workspace guidance, so you do not have to
teach every new client the basic conventions from scratch.

## Always-on participants and threads

Some integrations, such as OpenClaw, can remain available as a thread
participant. A **Worktable thread** is general conversation; a **Space thread**
carries one Space's context. Follow-ups stay in the same agent conversation so
the participant can continue from earlier messages.

Conversation history is portable workspace content. Exporting and importing it
does not reconnect the agent; connect the participant again at the destination
when you want to continue the conversation there.

## The annotation loop

Annotations are review attached to the work itself:

1. An agent writes or updates an artifact.
2. You annotate what is wrong, unclear, or next.
3. An agent acts, replies, and resolves the annotation thread.

Use a Worktable or Space thread for broader conversation; use an annotation
when the instruction belongs to a specific artifact or passage.

## Trust signals

You can see provenance and freshness signals on workspace content. Only a human
review action marks content reviewed; agents cannot bless their own writes.
Space Home surfaces stale and needs-attention work, while automatic lint can
flag broken links and orphaned docs as annotations that resolve when fixed.

## What agents are told

Worktable encourages agents to keep durable results in the workspace, search
before creating, update rather than replace, preserve content they do not own,
and use the smallest useful structure. Add workspace-specific instructions when
your team needs additional house rules.
