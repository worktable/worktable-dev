---
title: Workspace backups
description: Back up, restore, export, or move workspace content.
---

A portable export keeps an independent copy of your work or moves it to another
installation. Cloud also keeps hosted backups.

Exports contain workspace content only. They leave out installation
credentials, agent connections, team memberships and Space permissions. A full
operator backup keeps people and permissions; after a full restore, people sign
in again and agents reconnect.

Importing into an existing team Worktable keeps its members. Replaced Spaces
stay restricted until an owner shares them again.

## Hosted backups

Full backup and restore needs operator access. Being a Worktable owner is not
enough.

In Worktable Cloud, open **Settings → Data**, or choose **Backups** beside the
Worktable in **Your Worktables**. You see available backups, the schedule,
retention and the last successful backup.

- **Back up now** takes a backup.
- The restore icon beside a backup restores the whole hosted workspace. Editing
  pauses during the restore.
- **Undo** after a restore returns to the content saved just before it.

Hosted backups do not include files on linked local or self-hosted devices. If
the hosted workspace cannot open, contact
[support](https://www.worktable.cloud/support).

For local or self-hosted installations, export through Worktable, or stop the
service before copying the workspace folder.

## Portable exports

Open **Settings → Data** in any deployment.

### Choose history

Choose how much version history to include, then select **Export**. Current
content is always included.

- **All history** (default) is the complete snapshot.
- **Last 30 days** also keeps each item's newest version and meaningful
  checkpoints.
- **Last 50 per item** also keeps meaningful checkpoints.
- **No history** exports current content only.

Limits: 2 GiB compressed, 8 GiB of workspace content, 2 GiB for one file and
100,000 entries. Worktable shows an error rather than making a partial package.

You can close Settings while the export is prepared. Download the `.wtb`
package when it's ready. It is a standard ZIP archive. After extracting:

- `Open Worktable Export.html` is a read-only offline browser. It does not run
  HTML-doc scripts or make network requests.
- `workspace/` holds the exact portable workspace.
- `README.txt` explains the layout.

### Filename recovery

Some older history may have filenames that can't be unpacked on every
filesystem. **No history** avoids this and still includes all current content.

If selected history has such filenames, Worktable shows the count and offers
**Skip files**. Review the list or download the diagnostic report first.
Trailing spaces appear as `␠`. Skipped history is recorded in the package; your
original files are not changed.

Current content with incompatible filenames must be renamed before exporting.
Symlinks, unreadable files, archive limits and integrity failures also stop an
export.

## Replace a workspace

1. Choose a `.wtb` package under **Import workspace**. Worktable shows the
   source workspace, export time, size, file count and history before anything
   changes. If the page reloads during a large upload, choose the same file
   again to continue.
2. Review the summary, then select **Replace Worktable** and confirm.

Worktable replaces the content and version history, restarts on the same
address and keeps the destination's identity and account. It does not merge or
sync workspaces. On local installations, sign in to Worktable Cloud and
reconnect Worktable Link afterwards.

If replacement fails, Worktable tries to restore the previous workspace. If
that also fails, it stops. Keep the package and check the server logs before
retrying.

## Import separately

To import into a new or empty folder instead of replacing the workspace:

```sh
worktable workspace import backup.wtb ~/Worktable-Restored
```

This creates an independent workspace with a fresh ID. Cloud does not offer
this.

## CLI exports

```sh
worktable workspace export backup.wtb
worktable workspace export backup.wtb --history age --history-days 30
worktable workspace export backup.wtb --history count --history-count 50
worktable workspace export backup.wtb --history none
```

Use `--force` to overwrite an existing export file. See the
[CLI command reference](/reference/cli-commands/) for more options.

## Clear a workspace

On local, Desktop and self-hosted installations, choose **Clear** under
**Clear workspace**, review what will be removed, type
`CLEAR <workspace name>` and confirm. A review expires after ten minutes or
when the workspace changes.

Clearing permanently removes Spaces, documents, records, threads, attachments
and version history. **A completed clear cannot be undone, so export first.**

- The workspace keeps its identity, name, local preferences and storage format.
- Starter content is not recreated.
- Sign in to Worktable Cloud and reconnect Worktable Link again afterwards.
- Exports already on the server are revoked; downloaded copies remain yours.
- Open tabs refresh and discard drafts.

If the clear fails before it completes, Worktable tries to restore the original
content. If that fails, the server stops and needs attention.

Clear is not available in Cloud yet.
