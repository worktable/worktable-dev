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

A shared HTML Doc runs for readers as it does for you: its buttons, scripts
and layout work. It runs in a locked frame with no network access, forms or
pop-ups. Readers can't change Records, their interface choices stay in their
tab, and links to private Worktable content don't open. Readers see the
Records a page reads only when its link shows them; see
[Live data](#live-data).

## Owner controls

Owners manage sharing in **Settings → Sharing**:

- **Pause all links** stops every link until you turn it off.
- Choose who can share, which Spaces can be shared, whether every link needs a
  password, the longest expiry, and whether links can show live data or take
  visitor comments.
- The link table lists links across Spaces. Open a link's menu to copy or
  revoke it.

These settings apply to existing links as well as new ones.

Operator backups keep owner policy and visitor comments, but not working links
after a full machine recovery. Make new links after a recovery.

## Live data and visitor comments

Owners first turn on **Live data** and **Comment links** in
**Settings → Sharing**. Both are off by default.

### Live data

For an HTML Doc that reads Records, open **Live data** in **Share** and turn on
**Show live data**. Worktable shows which Records collections the tool reads,
how many records visitors can read, and which fields are hidden. Without it,
the page still runs, and its Records reads are refused.

- **Hide Fields** changes which fields visitors see.
- **View as Visitor** shows the link as a reader sees it.

Readers see current data but cannot change Records or open other documents.
Filters and other interface choices stay in their tab. Tightening the
document's permissions or the sharing policy can reduce what an existing link
can read. Turning **Live data** off in Settings hides Records on every link;
the pages keep running.

Record rules filter Records reads only. Text or data written into the tool
itself is visible to every reader.

On Worktable Cloud, an HTML Doc's link counts its views, and **Share** shows
them under the link, such as "4 views · 2 people". A view is a reader's
browser showing the page for a few seconds, so link scanners and chat previews
don't count, and neither do reloads within half an hour or visits that look
automated. People is an estimate. Views are kept for 90 days, never with the
reader's address. Readers who send Do Not Track or Global Privacy Control are
counted without anything that tells them apart.

Each view also notes its country and region, browser, operating system,
language and screen size, how far down the page was read, and whether the
reader came from LinkedIn, email or straight to the link. Outside the EEA, the
UK, Switzerland and Quebec it also notes the network's organization, such as a
company or internet provider. **Share** says where the latest view came from
and how many people came back on another day; agents reading the HTML Doc see
each view.

Links made under **More links** show the same live data as the main link, so
each audience can have its own link and its own views. **Edit Link** turns a
link's live data off or back on.

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
