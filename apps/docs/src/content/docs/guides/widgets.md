---
title: HTML docs
description: Create interactive tools, explanations, and interfaces inside a Space.
---

An HTML doc is an interactive page, such as a calculator, visual plan, or data
explorer. It can stand alone or work with a records collection.

## Create a tool

Tell a connected agent what the tool should do and what to use:

```text
Create an HTML doc for the Community workshop budget. Let me change
attendance and equipment cost, and show the resulting total. Use the
figures in the project brief and display all assumptions beside the controls.
Keep it durable.
```

Try the controls, then ask for revisions to the same HTML doc. See the
[interactive tools workflow](/workflows/interactive-tools/) for a full example.

## View and inspect

Open the HTML doc from the sidebar. Use fullscreen, or **Open in New Tab** from
its menu. **Copy HTML** copies the source.

HTML docs run in a sandbox with network access off by default. What else they
can reach, such as records, depends on the doc's permissions. An agent can let
its HTML doc read and change the records the agent itself can reach. Network
access needs a person: when an agent asks for it, the doc shows the request and
an **Allow** button. See the [HTML runtime](/reference/html-doc-runtime/) for
details.

## Use records

With permission, an HTML doc can query and update records, for example a
request board over the same collection as the built-in table. Keep shared items
in records; keep interface preferences, such as a selected view, in HTML-doc
state.

## Revise and recover

HTML docs have version history and checkpoints. Restoring a version brings back
its page and its permissions. Saved interface state and records the doc changed
stay as they are.

Move, rename, archive, restore, or delete an HTML doc from its menu. To move it
into a folder, **Rename** it to a path such as `plans/budget`. History, comments,
saved state, and bookmarks follow it.

Links and buttons can open other docs in the Space by path, so an HTML doc can
be a project entry point. **Pin** it if people should open it first.

To publish one, see [Sharing](/guides/sharing/). A shared HTML doc runs for its
readers, who can't change records and see them only when the link shows them.
