---
title: Workspace files
description: The on-disk contract for your workspace folder — what lives where, and what's safe to touch.
---

This is the portable on-disk contract used by local and self-hosted Worktable.
Worktable Cloud exposes the same content through `.wtb` export rather than a
direct server filesystem.

## The shape

Current workspaces use manifest version 2. A legacy V1 workspace is upgraded
before the server admits edits. Worktable preserves a rollback copy and blocks
access if the upgrade fails; repair the reported issue and retry. Do not change
the manifest version by hand.

V1 used `widgets/<path>/` bundles for HTML and different annotation/history
paths. Those are legacy layouts, not instructions for creating current content.

```txt
<workspace>/                      default ~/Worktable
  worktable.workspace.json        workspace manifest
  threads/
    <thread-id>.json              Worktable-level conversations
  spaces/
    <space-id>/
      space.json                  space metadata
      docs/
        <doc-path>.md             markdown docs
        <doc-path>.json           rich (BlockNote) docs
        <doc-path>.html           HTML docs
        <doc-path>.quickdraw      drawings
      docs.meta.json              doc archive state, lifetime, and provenance
      documents.meta.json         durable document IDs and current paths
      doc-aliases.json            rename aliases for old doc paths and folders
      document-data/
        <document-id>/
          annotations.json        document comments and instructions
          state/                  format-owned properties and state
      records/
        <collection-id>/
          schema.yaml             optional collection schema
          <record-id>.yaml        one record per file
      threads/
        <thread-id>.json          Space-level conversations
    .trash/                       recoverable deleted content
  versions/
    <space-id>/
      documents/<document-id>/    version history for every document format
```

## Portable content

Copy the folder or move it in a `.wtb` package and its portable meaning remains.
Documents use Markdown, JSON, HTML, or Quickdraw source; records use YAML;
threads and annotation envelopes use JSON. Worktable also maintains rebuildable
indexes, including SQLite projections, outside the portable content.

## Editing by hand

Safe and supported: document `.md` and `.html` files and record `.yaml` files.
Worktable watches the folder, so external edits show up live in the app and to
agents. In V2, an HTML file added under a Space's `docs/` tree becomes an HTML
doc with network and Records access off until permissions are set through the app or supported tools.

Manage these files through Worktable rather than editing them directly:
`worktable.workspace.json`, `space.json`, `docs.meta.json`,
`documents.meta.json`, `document-data/`, `doc-aliases.json`, thread JSON, and
`versions/`. Prefer doing those operations through the app or the MCP tools.

In `docs.meta.json`, a temporary document carries `archiveOn`, the time it
archives itself, and `lifetimeSetAt`, when that date was chosen. A document
without `archiveOn` is durable. `createdAt` records when a document was created
through Worktable; documents added another way have none.

## Local state

Machine-local state, including install data, CLI config, Worktable-managed token
and password hashes, participant bindings, thread delivery state, service logs,
realtime edit state, and caches, lives in the app data folder (macOS Application
Support, or `~/.config/worktable`). The rule:
if copying the workspace should preserve its meaning, it is in the workspace;
if it is security-sensitive, install-specific, or rebuildable, it is not.
User-authored content can still contain secrets, so review it before sharing or
committing the folder.

For the archive boundary and import limits, see
[workspace packages](/reference/workspace-packages/).
