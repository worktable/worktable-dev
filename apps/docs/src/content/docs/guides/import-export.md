---
title: Import and export a workspace
description: Move a workspace between local, self-hosted, Desktop, and Cloud Worktable, or browse it without Worktable.
---

Open **Settings → Import & Export** in any Worktable deployment.

## Export a portable package

Choose how much available version history to include, then select **Export**.
Current content is always included.

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

## Recover an export with incompatible history filenames

Older history may contain filenames that cannot be unpacked on every supported
filesystem. Choosing **No history** excludes those history files before filename
checks. It still includes all current content.

If selected history has incompatible filenames, Worktable shows the affected
file count and offers **Skip files**. Review the filename
issues or download the diagnostic report before choosing that option. Trailing
spaces appear as `␠` in the review. Recovery leaves the original files untouched
and records the omitted history in the package. If the affected files change,
Worktable asks for a new review.

Current content with incompatible filenames must be corrected before exporting;
recovery never silently drops current documents. Symlinks, unreadable files,
archive limits, and integrity failures still stop an export.

You can close Settings while export preparation continues. Reopen **Import &
Export** to check progress and download the result.

## Clear the current workspace

On local, Desktop, and self-hosted installations, **Clear** under **Clear workspace** opens a
review of the content to remove. Type the exact `CLEAR <workspace name>` phrase
and confirm. Reviews expire after ten minutes; changes to the workspace after
review require a new review.

Clearing permanently removes spaces, documents, records, threads, attachments,
and version history. Export first if you need a copy. The workspace keeps its
identity, name, local preferences, and storage format. You will need to sign in
to Worktable Cloud and reconnect Worktable Link again. It remains empty after
restart; starter content is not recreated.

If replacement or restart fails before the clear commits, Worktable restores
the original content. A completed clear cannot be undone. Previously generated
exports on the server are revoked; copies already downloaded remain yours.
Open tabs refresh and discard drafts from the old workspace content.

Clear is not yet available in Cloud.

## Import by replacing a workspace

Choose a `.wtb` package under **Import workspace**. Worktable verifies it and
shows the source workspace, export time, size, file count, and history summary
before anything changes. If the page reloads during a large upload, reselect
the same file to continue.

Select **Replace Worktable** and confirm only after reviewing that
summary. Worktable replaces the portable content, restarts on the same address,
and keeps the destination workspace identity and account attachment.
On local installations, sign in to Worktable Cloud and reconnect Worktable Link
after replacement.

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
