---
title: Update and uninstall
description: Update in place from the app or the CLI; uninstall without losing a single file of your work.
---

The update controls on this page apply to Desktop, local, and self-hosted
Worktable. Worktable Cloud updates automatically.

## Update Worktable Desktop

Signed Desktop releases check once after startup and at most once per day.
Nothing downloads until you choose **Download and Restart**.
Choose **Help → Check for Updates…** to check immediately. If installation
fails, Desktop keeps the current app and offers the signed DMG for
manual recovery.

If **Help → Check for Updates…** is unavailable, install the latest DMG once.
Future updates can then be installed from the app.

The updater preserves workspace files, saved connections, and local settings.
A Desktop-owned local host stops for restart; a CLI or managed
service that Desktop only attached to keeps running. See the
[Desktop reference](/reference/desktop/) for connection and storage boundaries.

## Update from the app

On a local or self-hosted install, open Settings → System → Software update. It shows the running version, checks for a newer release and names it once found, downloads it in the background, and restarts the service into it. You keep working until the restart. Already on the latest release? It says so instead of offering to update again. If the release server cannot be reached, the panel offers to retry the check and does not offer an update until the release is confirmed.

You don't have to go looking: a dot appears on the sidebar's Settings entry once a release is available, and the System entry carries an Update badge. Settings still opens normally on General, so the update never gets in the way when you came to change something else. A one-time toast announces each release; its Review update action opens System directly.

## Update from the CLI

```sh
worktable update --check   # is there a newer release?
worktable update           # download and switch to it
```

`worktable status` also tells you when an update is available. Turn automatic
checks off with **Check for updates automatically** in **Settings → System**.
The [configuration reference](/reference/configuration/) covers the environment
override for automated or managed installations.

What shipped in each release is on [What's new](/whats-new/).

## First opening after the workspace upgrade

Starting with 0.1.13, an older workspace upgrades automatically when the updated
Worktable server starts. No manual export, import, or version selection is needed.
New workspaces already use the current format.

If you open Worktable while the upgrade is running, you will see **Upgrading your
workspace**. Editing and agent access wait until preparation finishes, then the
page opens automatically. Allow several minutes for a large workspace; later
starts do not repeat the migration. **New drawing** becomes available after the
upgrade.

Existing documents, history, and share links are preserved. Worktable retains the
original workspace as a rollback copy beside the workspace folder. Keep that copy
until you have verified the upgraded workspace; it contains private data.

If you see **Workspace upgrade needs attention**, the owner needs to inspect the
server logs and resolve the reported issue before choosing **Retry upgrade**.
The original workspace is preserved and editing stays unavailable until the
upgrade succeeds. Do not restore an old application release against converted
workspace files; rollback requires the matching original workspace copy.

## Uninstall

```sh
worktable uninstall
```

It shows what it will remove — the launcher, installed releases, app data, shell completions, agent registrations — and asks first (`--yes` to skip the prompt).

**Your workspace folder survives.** Uninstalling removes Worktable, not your work: every doc, record, and annotation stays on disk, readable without Worktable installed. The one exception is explicit:

```sh
worktable uninstall --purge   # ALSO deletes the workspace folder
```

Reinstalling later picks the same workspace folder right back up.
