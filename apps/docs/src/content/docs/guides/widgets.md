---
title: HTML docs
description: Create interactive tools, explanations, and interfaces inside a Space.
---

An HTML doc is a self-contained interactive page: a calculator, visual plan,
data explorer, or custom interface. It can use supplied data on its own or work
with a records collection.

## Create a tool

Give a connected agent the task, inputs, and expected interactions:

```text
Create an HTML doc for the Community workshop budget. Let me change
attendance and equipment cost, and show the resulting total. Use the
figures in the project brief and display all assumptions beside the controls.
Keep it durable.
```

Open the result and try the controls. Ask for revisions to the same HTML doc.
The [interactive tools workflow](/workflows/interactive-tools/) provides a
complete fictional example.

## View and inspect

Open the HTML doc from the sidebar. Use the fullscreen control for more room,
or **Open in new tab** from its menu. **Copy HTML** copies the source for use in
another tool or conversation.

HTML docs run in a sandbox. Network access is disabled by default, and access
to records or navigation depends on the document's permissions. Agents with
write access can also set HTML permissions, so permissions are part of what you
should inspect when reviewing an agent-built tool. See the
[HTML runtime](/reference/html-doc-runtime/) for exact capabilities and limits.

## Use records

An HTML doc can query or update records when permitted. For example, a request
board can display the same collection you edit in the built-in table. Use
records for independently changing items; use HTML-doc state for local
interface preferences such as a selected view.

An HTML doc does not need records when its inputs are fixed or its calculations
are self-contained.

## Revise and recover

HTML docs have version history and checkpoints. Restoring a version restores
the HTML source, but does not roll back saved interface state or changes the
tool made to records.

Move, rename, archive, restore, or delete an HTML doc from its menu. To move it
into a folder, choose **Rename** and enter a path such as `plans/budget`. Its
history, comments, saved state, and existing bookmarks follow it.

Links and buttons can open supported documents in the same Space by path. This
can make an HTML doc a useful project entry point; pin it to **Start here** if
people should open it first.

For a public version, see [Sharing](/guides/sharing/). Shared HTML does not run
the tool's scripts or provide access to private records.
