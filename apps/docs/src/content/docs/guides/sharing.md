---
title: Sharing
description: Publish a document link, understand what readers can see, and revoke access.
---

Public document links are available in Worktable Cloud and on installations
with active Worktable Link access. Anyone with the link can view the shared
content without signing in.

## Create a link

1. Open a document or HTML doc.
2. Choose **Share** in its header or page menu.
3. Choose **Create link**, then **Copy**.

Shared links are unlisted. Review the content before sending a link. On a
linked local device, Worktable must stay running, online, and linked for readers
to reach it.

## What readers see

A shared prose document shows its latest saved content. Mermaid diagrams render
without their links.

Shared HTML docs retain their layout and safe external links. Scripts, forms,
record access, saved interface state, and links to private Worktable content are
disabled. A shared calculator therefore displays its exported content, not the
interactive experience available inside Worktable.

## Sharing preview

Selected Worktables have a sharing preview with live tools, separate links and
visitor comments. These controls appear only where the preview is enabled.
Live tools also need a compatible share host.

Owners first enable **Live tools** and **Comment links** in
**Settings → Links**. Both are off by default. The workflows below are
available when the owner permits them.

Each link has its own label, access, expiry and optional password. Copy a new
link when it is created; its full URL is not shown again. Renaming or moving a
document keeps its preview links attached to the same document.

### Live tools

For an HTML Doc built for the preview runtime, turn on **Live tool** in the
sharing form. Under **What this link opens**, choose the Records collections,
rows and fields readers may see. Choose **Check access** to confirm the scope,
then create the link and use **View as visitor** to inspect it.

The tool reads current data within that link's scope. Readers cannot change
Records. Interface choices such as filters stay in their tab and do not change
the team's saved state. Tightening the document's permissions or the owner's
sharing policy can reduce what an existing link can read.

Record rules filter Records API reads. They do not hide text or data written
directly into the tool itself, which is shared with every reader of the link.

Preview tools use an isolated program and Worktable's view API. Existing HTML
that depends on browser scripts, DOM libraries or external resources needs to
be rebuilt for this runtime. Ask your connected agent to read the HTML runtime
guidance supplied by this Worktable before building the tool.

### Visitor comments

Choose **Can comment** when making a link, then set **Accept comments** and
**Visitors see**. By default, visitors see their own comments and replies. An
owner may allow a link to show all its visitor comments instead. A visitor may
need to complete a human check before sending a comment.

Review visitor comments in the document's comments panel. They stay separate
from agent-readable team content until a member chooses **Pass to Team**.

### Owner controls

Owners manage sharing in **Settings → Links**. They can pause all links, choose
who can share and which Spaces can be shared, and restrict access levels,
passwords and expiry. These settings apply to existing links as well as new
ones. A stopped live link loses data access within the short cache window,
at most three seconds.

Operator backups preserve owner policy and visitor comments, but do not
preserve working links after full machine recovery. Make new links after a
recovery. Restoring a workspace on a machine that still has its sharing store
does not replace the current policy with an older copy.

## Stop sharing

In the link list, open a link's menu and choose **Revoke Link**. Revoke each
link you want to stop. Renaming or moving a document does not revoke these
links; archiving or deleting it makes them unavailable.

In the earlier sharing dialog, choose **Stop sharing**. Its links also stop
when the document is moved, renamed, archived or deleted. Sharing again
creates a new link.

Pausing Worktable Link stops access to that device's shared documents. Resuming
it restores the existing links; unlinking the device ends its access. See
[Remote access](/guides/remote-access/#worktable-link).
