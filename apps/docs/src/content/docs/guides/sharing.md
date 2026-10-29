---
title: Sharing
description: Publish a document link, understand what readers can see, and revoke access.
---

Public document links work in Worktable Cloud and on installations with active
Worktable Link access. Anyone with the link can view it without signing in.

## Create a link

1. Open a document or HTML doc.
2. Choose **Share** in its header or page menu.
3. Choose **Create Link**, then **Copy**.

A new link expires in 14 days, or sooner if the owner sets a shorter maximum.
To change it, open the link's menu and choose **Edit Link**.

- **More links → New Link** gives an audience its own link, label and expiry.
  Revoking one does not affect the others.
- **Password** makes readers enter a password first. Changing it asks readers
  who already unlocked the link for the new one.
- Renaming or moving a document keeps its links working.

Links are unlisted. Review the content before you send one. On a linked local
device, Worktable must stay running, online and linked for readers to reach it.

## What readers see

A shared document shows its latest saved content. Mermaid diagrams render
without their links.

Shared HTML docs keep their layout and safe external links. Scripts, forms,
record access, saved interface state and links to private Worktable content are
off. To share a working tool, give its link live data; see
[Live tools](#live-tools).

## Owner controls

Owners manage sharing in **Settings → Sharing**:

- **Pause all links** stops every link until you turn it off.
- Choose who can share, which Spaces can be shared, whether every link needs a
  password, the longest expiry, and whether links can have live tools or
  visitor comments.
- The link table lists links across Spaces. Open a link's menu to copy or
  revoke it.

These settings apply to existing links as well as new ones.

Operator backups keep owner policy and visitor comments, but not working links
after a full machine recovery. Make new links after a recovery.

## Live tools and visitor comments

Owners first turn on **Live tools** and **Comment links** in
**Settings → Sharing**. Both are off by default. Live tools also need a
compatible share host.

### Live tools

For an HTML Doc, open **Live data** in **Share** and turn on
**Show live data**. Worktable shows which Records collections the tool reads,
how many records visitors can read, and which fields are hidden.

- **Hide Fields** changes which fields visitors see.
- **View as Visitor** shows the link as a reader sees it.

Readers see current data but cannot change Records or open other documents.
Filters and other interface choices stay in their tab. Tightening the
document's permissions or the sharing policy can reduce what an existing link
can read. A stopped live link loses data access within three seconds.

Record rules filter Records reads only. Text or data written into the tool
itself is visible to every reader.

### Visitor comments

Open **Comments** in **Share** and turn on **Allow comments**. Each visitor sees
only their own comments and the team's replies. A comment needs the visitor's
name and may need a human check.

Visitor comments appear in the document's comments panel. Agents do not see
them until a member chooses **Pass to Team**.

## Stop sharing

In **Share** or **Settings → Sharing**, open a link's menu and choose
**Revoke Link**. Revoking is permanent. Archiving or deleting a document makes
its links unavailable.

Pausing Worktable Link stops access to that device's shared documents until you
resume it. Unlinking the device ends it. See
[Remote access](/guides/remote-access/#worktable-link).
