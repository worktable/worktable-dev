---
title: Documents
description: Edit prose, compare versions, restore changes, and link related work.
---

Documents hold notes, plans, research, and decisions. Use the block editor for
headings, lists, tables, code, and diagrams. You and connected agents can revise
the same work.

## Create and edit

Choose **Doc** from a Space's **+** menu. Without a name, Worktable uses
`untitled`, then `untitled-2`, and so on. The sidebar uses the first heading as
the label when one exists.

Select **Edit** on a Markdown document to use the rich editor. Agents can read
both Markdown and rich-text documents as Markdown. Ask them to change specific
passages when the rest should remain intact.

Open documents receive saved agent changes. Collaborative editing reduces
conflicts, but whole-document replacements can overwrite intent; review changes
when several people or agents are editing. Offline editor changes synchronize
when the connection returns.

New documents in the app start temporary by default. Use **Archives → Keep** to
retain one, or change the default in the Space's **+** menu. See
[Spaces](/guides/organize-and-find/#document-lifetimes) for lifetimes and archiving.

## Copy and export

The document header or menu provides:

- **Copy Markdown** to copy the prose, including rich text converted to Markdown.
- **Download Markdown** to save it as a `.md` file.
- **Print PDF** to open the browser's print dialog with the document content.
- **Save Markdown**, when the rich document can be represented completely in
  Markdown, to change its storage format. This action is hidden when conversion
  would lose rich-only content.

If another device has offline edits from before a format change, Worktable
can recover them into a separate document.

## Version history

Open history from the document menu to read older versions, create a checkpoint,
or restore one. History keeps the last 30 days by default, and always each
document's newest version.

**Settings → History** keeps 30, 90 or 180 days, or the last 7 versions of each
document. Applying a shorter limit deletes older versions immediately after
confirmation. Choose a policy before relying on a particular version as your
recovery path. Workspaces that kept everything before these limits now keep 180
days.

HTML docs have their own history; restoring their source does not restore saved
interface state or records they changed. [Drawings](/guides/drawings/) have
separate recovery controls.

## Links and backlinks

Link to another document in the Space with Markdown such as
`[Project brief](/project-brief)`. Worktable tracks links and backlinks. An agent
write that points to a missing document returns a warning.

Worktable links open in the current tab; external websites open in a new tab.
The browser's link menu can open or copy either destination. Existing links and
bookmarks continue to resolve after a document or folder moves.

## Mermaid diagrams

Worktable validates Mermaid diagrams in prose documents before saving. Select a
diagram or its **Fullscreen** button to zoom, pan, fit it to the screen, or
download an SVG.

Use [Drawings](/guides/drawings/) for freehand work or layouts you want to edit
visually. Agents building Mermaid inside HTML docs should validate it before
embedding it; see [HTML authoring](/agents/building-widgets/).
