---
title: Documents
description: Edit prose, compare versions, restore changes, and link related work.
---

Documents hold notes, plans, research, and decisions. You and connected agents
can edit the same doc.

## Create and edit

Choose **Doc** from a Space's **+** menu, type a title, and press Enter to start
writing. The title is the doc's name everywhere, including its file name. A doc
without a title is called Untitled; click the grey name to add one.

Select **Edit** on a Markdown document to use the rich editor. Agents read both
formats as Markdown.

Open documents show agent changes as they save. When several people or agents
edit at once, ask agents to change specific passages, since a whole-document
replacement can overwrite other work. Offline changes sync when you reconnect.

New documents start temporary. Use **Archives → Keep** to keep one. See
[document lifetimes](/guides/organize-and-find/#document-lifetimes).

## Copy and export

The document menu offers:

- **Copy Markdown**
- **Download Markdown** (a `.md` file)
- **Print PDF**
- **Save Markdown**, to store a rich doc as Markdown. It only appears when
  nothing would be lost.

If another device has offline edits from before a format change, Worktable can
recover them into a separate document.

## Version history

Open history from the document menu to read, checkpoint, or restore versions.

- Edits in a row by one person or agent form one version until a 10-minute
  pause. Another editor, a restore, or a checkpoint starts a new one.
- History keeps 30 days by default, plus each document's newest version.
- **Settings → Data** can keep 30, 90 or 180 days, or the last 7 versions.
  A shorter limit deletes older versions as soon as you confirm.
- Workspaces that kept everything before these limits now keep 180 days.

HTML docs have their own history. Restoring their source does not restore saved
interface state or records they changed. [Drawings](/guides/drawings/) recover
differently.

## Links and backlinks

Link to another document with Markdown such as `[Project brief](/project-brief)`.
Worktable tracks backlinks, and an agent write that links to a missing document
returns a warning. Links keep working after a document or folder moves.

Worktable links open in the current tab; external sites open in a new tab.

## Mermaid diagrams

Mermaid diagrams are validated before saving. Select a diagram or its
**Fullscreen** button to zoom, pan, or download an SVG.

For freehand work or layouts you edit by hand, use
[Drawings](/guides/drawings/). For Mermaid inside HTML docs, see
[HTML authoring](/agents/building-widgets/).
