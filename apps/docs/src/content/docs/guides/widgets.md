---
title: HTML docs
description: Ask your agent for a tool or visual plan, and it produces sandboxed HTML docs over your workspace data.
---

Some results shouldn't be prose. A project visual plan, a planning board, a review room for research sources, a one-off calculator. For these, ask your agent for an **HTML doc**: a self-contained interactive page that lives in your space. Docs come in three formats — markdown, rich text, and HTML — and HTML docs are the interactive kind.

## Asking for one

Describe the interface:

```txt
Build me an HTML doc that shows the launch-tasks records as a kanban
board grouped by status, with a count per column.
```

Worktable gives the agent the HTML authoring guidance it needs, and the agent
builds a single self-contained file. Iterate the same way you would on any doc.
"Make the columns collapsible" is a normal follow-up.

## The sandbox

HTML docs run in a sandbox. They have no network access unless you enable it for
that doc. An HTML doc can query and update **records**, remember its own
interface settings, and follow your theme, so it remains a live view of the
same data rather than a frozen snapshot.

## HTML docs + records

Records hold the structured state while the HTML doc presents it. The kanban board above doesn't own the tasks, the record collection does. Close the doc, edit a record by hand or by agent, reopen: the board reflects it. Data outlives interface.

Use the built-in records table for generic inspection and quick edits. When the collection needs a board, planner, dashboard, form, or workflow-specific interface, ask an agent to build an HTML doc over the records. Keep durable domain data in the records; use HTML-doc state only for interface-local preferences.

## Viewing them

Click an HTML doc and it opens full-bleed in the main pane, title in the breadcrumb, just like any other doc. Use the fullscreen toggle in the header for more room; "Open in new tab" is still available from the doc's menu if you want it in its own window.

Need the source itself? **Copy HTML** — in the header, the doc's menu, or the sidebar's right-click menu — copies the full HTML to your clipboard so you can paste it into a conversation, another tool, or back to an agent.

## Managing them

HTML docs have a normal lifecycle (move, rename, archive, restore, delete). Use
**Rename** in the sidebar and enter a path such as `plans/launch-board` to file
one in a folder. Its history, comments, saved interface state, and old bookmarks
follow it. Archive liberally: a doc built for one review session did its job;
archiving keeps it recoverable without cluttering the space. HTML docs are
stored as portable, inspectable files like the rest of the workspace.

An HTML doc can also act as a folder home. Buttons and links can open any
supported document in the same Space by path, and keep working after the target
document or its folder moves.
