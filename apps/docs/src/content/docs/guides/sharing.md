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
3. Choose **Create Link**, then **Copy**.

A new link expires in 14 days, or sooner if the owner's longest expiry is
shorter. To change that, open the link's menu and choose **Edit Link**. The
link stays in **Share**, so you can copy it again at any time.

To give an audience its own link, open **More links** and choose **New Link**.
Each of these links has its own label and expiry, and revoking one does not
affect the others. Renaming or moving a document keeps its links working.

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
team and the longest expiry. These settings apply
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

For an HTML Doc, open **Live data** in **Share** and turn on
**Show live data**. Worktable checks which Records collections the tool reads
and shows how many records visitors can read, with the fields kept from them.
Choose **Hide Fields** to change which fields visitors see, and
**View as Visitor** to inspect the link.

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

Open **Comments** in **Share** and turn on **Allow comments**. Visitors see
their own comments and the team's replies. A visitor may need to complete a
human check before sending a comment.

Review visitor comments in the document's comments panel. They stay separate
from agent-readable team content until a member chooses **Pass to Team**.

## Stop sharing

In **Share** or in **Settings → Links**, open a link's menu and choose
**Revoke Link**. Revoke each link you want to stop; revoking is
permanent. Renaming or moving a document does not revoke its links; archiving
or deleting it makes them unavailable.

Links made with earlier versions of Worktable move into the link list when
Worktable updates, and keep their URLs.

Pausing Worktable Link stops access to that device's shared documents. Resuming
it restores the existing links; unlinking the device ends its access. See
[Remote access](/guides/remote-access/#worktable-link).
