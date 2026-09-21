---
title: Import and export a workspace
description: Move a workspace between local, self-hosted, Desktop, and Cloud Worktable, or browse it without Worktable.
---

Open **Settings → Import & Export** in any Worktable deployment.

## Export a portable package

Choose how much available version history to include, then select **Export
workspace**. Current content is always included.

- **All history** is the complete snapshot and the default.
- **Last 30 days** also keeps each item's newest version and meaningful
  checkpoints.
- **Last 50 per item** also keeps meaningful checkpoints.
- **No history** exports current content only.

The supported package envelope is 2 GiB compressed, 8 GiB of portable
workspace content, 2 GiB for one file, and 100,000 workspace entries. Worktable
shows a limit error instead of producing or accepting a partial package.

When preparation finishes, download the `.wtb` package. It is a standard
compressed ZIP archive, not an opaque Worktable-only format. Extract it with
Finder, 7-Zip, `unzip`, or another ZIP tool.

Inside the extracted folder:

- Open `Open Worktable Export.html` for a read-only offline browser.
- Find the exact portable workspace under `workspace/`.
- Read `README.txt` for the package layout.

The offline browser does not run HTML-doc scripts or make network requests.
Large or unusual files remain available as raw files.

## Import by replacing a workspace

Choose a `.wtb` package under **Import and replace**. Worktable verifies it and
shows the source workspace, export time, size, file count, and history summary
before anything changes. If the page reloads during a large upload, reselect
the same file to continue.

Select **Replace this workspace** and confirm only after reviewing that
summary. Worktable replaces the portable content, restarts on the same address,
and keeps the destination workspace identity and account attachment.

This replaces current portable content and version history. It is not a merge
and it does not create background sync. Export the newer side and deliberately
replace the older side whenever you want to move your latest snapshot again.

If replacement or restart fails, Worktable restores the prior workspace.

## Create a separate local workspace

The CLI can import the package into a missing or empty folder instead of
replacing the configured workspace:

```sh
worktable workspace import backup.wtb ~/Worktable-Restored
```

This creates an independent workspace with a fresh ID and one-way source
provenance. It is useful for inspection, recovery, or keeping both copies. Cloud
does not offer an “import as new” action.

## CLI exports

```sh
worktable workspace export backup.wtb
worktable workspace export backup.wtb --history age --history-days 30
worktable workspace export backup.wtb --history count --history-count 50
worktable workspace export backup.wtb --history none
```

Use `--force` to replace an existing regular export file. The
[CLI command reference](/reference/cli-commands/) lists compatibility and
format options.
