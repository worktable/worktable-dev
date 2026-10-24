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
3. Optionally give the link a **Label** and choose when it **Expires**.
4. Choose **Create link**, then copy the URL.

A document can have several links, each with its own label and expiry, so you
can give each audience its own link and revoke one without affecting the
others. To copy a link's URL again later, open **Share**, then the link's menu,
and choose **Copy Link**. Renaming or moving a document keeps its links
working.

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

## Owner controls

Owners manage sharing in **Settings → Links**. **Pause all links** stops every
link at once until it is turned off. Owners can also choose who can share on a
team, which Spaces can be shared and the longest expiry. These settings apply
to existing links as well as new ones. The link table lists links across
Spaces; open a link's menu to copy or revoke it.

Operator backups preserve owner policy and visitor comments, but do not
preserve working links after full machine recovery. Make new links after a
recovery. Restoring a workspace on a machine that still has its sharing store
does not replace the current policy with an older copy.

## Sharing preview

Selected Worktables have a sharing preview with link passwords, live tools and
visitor comments. These controls appear only where the preview is enabled.
Live tools also need a compatible share host.

Owners first enable **Live tools** and **Comment links** in
**Settings → Links**. Both are off by default. The workflows below are
available when the owner permits them. With the preview, a link can also have
a password, and owners can require one for every link.

### Live tools

For an HTML Doc, turn on **Live tool** in the
sharing form. Under **What this link opens**, choose the Records collections
the link opens and clear any fields readers should not see. Readers see every
record in a chosen collection. Choose **Check access** to confirm what the link
shows, then create the link and use **View as visitor** to inspect it.

The tool reads current data from those collections. Readers cannot change
Records. Interface choices such as filters stay in their tab and do not change
the team's saved state. Tightening the document's permissions or the owner's
sharing policy can reduce what an existing link can read.

Record rules filter Records API reads. They do not hide text or data written
directly into the tool itself, which is shared with every reader of the link.

Readers run the same HTML Doc your team uses, so any tool your agents build
works on a live link without changes. Parts of a tool that change Records or
open other documents are unavailable to readers. A stopped live link loses data access within the short cache window, at most
three seconds.

### Visitor comments

Choose **Can comment** when making a link, then set **Accept comments** and
**Visitors see**. By default, visitors see their own comments and replies. An
owner may allow a link to show all its visitor comments instead. A visitor may
need to complete a human check before sending a comment.

Review visitor comments in the document's comments panel. They stay separate
from agent-readable team content until a member chooses **Pass to Team**.

## Stop sharing

In the document's link list or in **Settings → Links**, open a link's menu and
choose **Revoke Link**. Revoke each link you want to stop; revoking is
permanent. Renaming or moving a document does not revoke its links; archiving
or deleting it makes them unavailable.

Links made with earlier versions of Worktable move into the link list when
Worktable updates, and keep their URLs.

Pausing Worktable Link stops access to that device's shared documents. Resuming
it restores the existing links; unlinking the device ends its access. See
[Remote access](/guides/remote-access/#worktable-link).
