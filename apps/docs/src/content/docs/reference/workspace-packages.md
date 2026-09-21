---
title: Workspace packages
description: The portable .wtb snapshot format, import behavior, and supported size limits.
---

A `.wtb` file is a ZIP-based snapshot of portable Worktable content. Use it to
back up a workspace, move between local, self-hosted, Desktop, and Cloud
deployments, or inspect a workspace offline. It is not a live synchronization
or merge protocol.

## Package contents

The archive contains a versioned manifest and the portable workspace tree:
Spaces, docs, HTML docs, records, annotations, threads, and any version history
selected for export. Current exports also include a read-only offline browser
for inspecting the snapshot without a running Worktable server.

Machine-local credentials, owner sessions, participant registrations, thread
delivery state, service configuration, logs, caches, and realtime editor state
are excluded. Importing a conversation therefore does not reconnect its agent.

## Import behavior

Import validates the archive before replacing the destination workspace. A
replacement preserves the destination deployment's identity and account or
server attachment. Treat import as a deliberate snapshot handoff: changes made
independently on both sides are not merged.

Keep the source package until the destination has opened successfully. See
[Import and export a workspace](/guides/import-export/) for the user flow.

## Limits

Current import limits are:

| Boundary                   |   Limit |
| -------------------------- | ------: |
| Compressed archive         |   2 GiB |
| Portable workspace content |   8 GiB |
| One file                   |   2 GiB |
| Workspace entries          | 100,000 |
| Total archive entries      | 200,000 |
| Manifest                   |  32 MiB |

Cloud transfers use 8 MiB upload chunks and an unfinished transfer expires
after 24 hours of inactivity. A valid package must also pass path, entry-type,
manifest-version, integrity, and workspace-contract validation.
