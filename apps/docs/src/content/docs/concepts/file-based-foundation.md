---
title: File based foundation
description: Portable, inspectable workspace content with installation state kept separate.
---

Worktable is file-backed: the app, agents, and exports all operate on one
portable workspace model. Docs are Markdown, rich text, or registered future
formats, records are YAML, and HTML docs contain self-contained HTML source.
Conversations and annotations are stored alongside the content they belong to.
V2 workspaces keep HTML source in ordinary `.html` files and format-owned state
under a stable document identity; V1 workspaces retain the supported HTML bundle
layout. Moving a document through Worktable preserves its history and behavior.

## What “file-backed” means by deployment

- **Desktop and local installs** keep the workspace in a folder you choose or
  accept during setup. You can open, back up, diff, or version those files with
  normal tools.
- **Self-hosted installs** keep the same workspace folder on the server you run.
- **Worktable Cloud** manages the live storage for you. Export a `.wtb` package
  whenever you need a complete portable copy or want to move deployments.

Desktop, Cloud, and self-hosted Worktable use the same portable content format.
A `.wtb` package can move between them; it is a snapshot handoff, not continuous
sync or merge.

## Portable workspace versus machine state

Worktable deliberately separates content you own from installation state:

| Kind               | Examples                                                                   | Portable |
| ------------------ | -------------------------------------------------------------------------- | -------- |
| Workspace content  | Spaces, docs, HTML docs, records, annotations, threads, versions           | Yes      |
| Installation state | Credentials, sessions, service logs, caches, release files, delivery state | No       |

Copying or exporting a workspace does not copy credentials or reconnect agents.
That boundary makes the content portable without turning an archive into a
credential backup. Review content for secrets before sharing or committing it,
just as you would any project folder.

The complete on-disk layout is in [workspace files](/reference/workspace-files/),
and the portable archive format is in
[workspace packages](/reference/workspace-packages/).

## What this means for agents

Agents work with the same kinds of content regardless of deployment, subject to
the access granted to their connection. Their durable output enters the same
workspace a human reviews in the app. See
[how agents fit](/concepts/how-agents-fit/).
