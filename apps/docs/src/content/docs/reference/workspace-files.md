---
title: Workspace files
description: The on-disk contract for your workspace folder — what lives where, and what's safe to touch.
---

This is the portable on-disk contract used by local and self-hosted Worktable.
Worktable Cloud exposes the same content through `.wtb` export rather than a
direct server filesystem.

## The shape

The layout below applies to workspace manifest version 2. Existing and newly
created V1 workspaces remain supported and are not automatically migrated.
In V1, HTML docs use `widgets/<path>/` bundles containing `widget.yaml`,
`index.html`, and optional `state.yaml`; annotations and history also retain
their legacy paths. Do not change the manifest version by hand.

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
      docs.meta.json              doc archive state and provenance
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

## What this buys you

Copy the folder or move it in a `.wtb` package and its portable meaning remains.
Grep it, back it up, put it in git, or read it without Worktable running. Docs
are Markdown, JSON, or self-contained HTML; records are YAML; thread and
annotation envelopes are JSON.

## Editing by hand

Safe and supported: document `.md` and `.html` files and record `.yaml` files.
Worktable watches the folder, so external edits show up live in the app and to
agents. In V2, an HTML file added under a Space's `docs/` tree becomes an HTML
doc with network and Records access off until you explicitly grant them. In
V1, use the app or agent tools to create HTML docs in the supported bundle layout.

Treat as Worktable's bookkeeping (editable, but easy to get wrong):
`worktable.workspace.json`, `space.json`, `docs.meta.json`,
`documents.meta.json`, `document-data/`, `doc-aliases.json`, thread JSON, and
`versions/`. Prefer doing those operations through the app or the MCP tools.
Freshness and review status are derived from version history instead of being
user-authored metadata.

## What is deliberately not here

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
