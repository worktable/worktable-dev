---
title: Your First Space
description: Put a real project in Worktable, create durable work, and close the review loop.
---

A workspace contains spaces. A space is a project, workstream, or operating
context. The fastest way to understand Worktable is to skip the test note and
start with something real.

## Make it a real project

Create a space from the sidebar. Give it a name that will still make sense in
six months. A useful first space often has:

- A short project brief.
- A running decisions doc.
- One living handoff or status doc.
- A record collection when repeated items need separate updates or queries.

You can create and edit all of these yourself. A connected agent can do the
same through Worktable's tools.

## Create the first durable result

Ask a connected agent:

```text
Create a space for <project> in my Worktable workspace. Write a short
project brief from what you know, and start a decisions doc.
```

Or create a new doc yourself and write the objective, current state, and open
questions. The important part is that the result now lives outside the chat
that produced it.

## Open Space Home

Click the space itself. Space Home is an automatic overview of docs by folder,
backlinks, stale-content markers, and items that need attention. You never need
to maintain an index doc by hand.

## Leave an annotation

Open the brief, select a block or text range, and leave a correction, question,
or instruction. Annotations stay attached to the work. Agents can read open
annotation threads, act on them, reply, and resolve them.

This is the core loop:

1. You or an agent creates durable work.
2. You review it in Worktable and annotate what should change.
3. The next agent session finds the open instruction, updates the artifact, and
   reports back in the annotation thread.

## Find the underlying files

On local or self-hosted Worktable, `worktable doctor` prints the live workspace
folder. The default local path is `~/Worktable`; docs are Markdown or JSON,
records are YAML, HTML docs are HTML, and threads and annotations are JSON.

Worktable Cloud keeps the live folder on the hosted workspace. Use
**Settings → Import & Export** to download the same portable content in a
standard `.wtb` package that you can extract and browse without Worktable.

## Next

- [Organize and find your work](/guides/organize-and-find/).
- [What to use Worktable for](/guides/what-to-use-it-for/).
- [Agent handoffs](/guides/agent-handoffs/).
- [Worktable and Space threads](/guides/threads/).
