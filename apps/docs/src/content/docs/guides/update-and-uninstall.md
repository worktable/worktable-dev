---
title: Updates
description: Update Worktable, upgrade workspace storage, or remove the installation.
---

The update controls on this page apply to Desktop, local, and self-hosted
Worktable. Worktable Cloud updates automatically.

## Update Desktop

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

## Update a service

For a local or self-hosted service, open **Settings → System → Software update**.
The panel checks for a release, downloads it, and restarts into it. You can keep
working until the restart. If the release check fails, retry before updating.

A dot on **Settings**, an **Update** badge on **System**, and a release
notification indicate when an update is available.

## CLI updates

```sh
worktable update --check   # is there a newer release?
worktable update           # download and switch to it
```

`worktable status` also tells you when an update is available. Turn automatic
checks off with **Check for updates automatically** in **Settings → System**.
The [configuration reference](/reference/configuration/) covers the environment
override for automated or managed installations.

What shipped in each release is on [What's new](/whats-new/).

## Workspace upgrades

Starting with 0.1.13, an older workspace upgrades automatically when the updated
Worktable server starts. No manual export, import, or version selection is needed.
New workspaces already use the current format.

If you open Worktable while the upgrade is running, you will see **Upgrading your
workspace**. Editing and agent access wait until preparation finishes, then the
page opens automatically. Allow several minutes for a large workspace; later
starts do not repeat the migration. **Drawing** appears in a Space's **+** menu
after the upgrade.

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

The command previews removal of the launcher, installed releases, app data,
shell completions, managed agent registrations, and installed skills, then asks
for confirmation.
Use `--yes` to confirm non-interactively. Locally modified skill files are
preserved and reported.

The workspace folder remains by default. Keep that folder to reopen your work
with a later installation. To delete the configured workspace as well:

```sh
worktable uninstall --purge
```

Export any content you need before purging. Review the paths shown by the
command; deletion cannot be recovered through Worktable history.

This command removes a CLI installation. To remove Desktop, quit it and remove
the application from Applications. Removing the app does not delete a workspace
folder you keep separately. Cloud cancellation is covered in
[Cloud account](/guides/cloud-account/).
