---
title: Troubleshooting
description: Recover from installation, connection, document, and transfer problems.
---

Start with the surface you use. CLI diagnostics inspect a local installation;
they do not diagnose your Cloud account or a server on another computer.

## Local installation

```sh
worktable doctor
worktable status
worktable paths
```

These report installation health, the active host and workspace, and resolved
paths. For a managed service, inspect `worktable service logs -n 100` and
`worktable service status`.

If the port is occupied, choose another with
`worktable launch --port 7481`. Use the endpoint reported by Worktable when
reconnecting clients.

If `worktable` is missing from PATH, find the install directory printed by the
installer. Add that directory to PATH or install into a directory already on
PATH. The installer does not edit shell profiles.

## Desktop connection

For **This Mac**, reopen Worktable if an agent lost its local endpoint after
you quit. Closing the window keeps the host running; quitting stops a host
owned by Desktop.

For a self-hosted profile, verify the origin, certificate, and server availability.
Desktop rejects redirects and a different workspace appearing at a saved origin.
For Cloud, use its connection option and complete sign-in in the system browser.
See [Desktop](/reference/desktop/) for connection requirements.

## Agent access

On a CLI-managed host:

```sh
worktable mcp status
worktable mcp test
worktable mcp repair
```

Use **Settings → Agents** for the current endpoint and supported setup path.
A remote client needs a reachable host; `localhost` refers to the client's own
computer. Cloud clients normally need browser OAuth approval.

If a reachable client configuration lacks a bearer, run `worktable mcp setup`
on the host or repeat the remote pairing flow. If Codex's Worktable table is
invalid or duplicated, `worktable mcp repair` rewrites that entry. Recheck other
clients after a token rotation.

OpenClaw uses its plugin setup and pairing or registration flow, not
`worktable mcp setup`. An offline participant can leave messages queued; it does
not imply that the thread was lost.

For a client that requires stdio, distinguish `worktable mcp stdio` (a local
workspace process) from an [HTTP bridge](/reference/mcp/#http-to-stdio-bridge)
for a remote server. See [Connections](/start/connect-your-agent/).

## Service startup

Read `worktable service logs -f`, fix the reported cause, then restart with
`worktable service restart`. A service will not start beside a Desktop-owned
or foreground host. Where managed services are unavailable, use
`worktable launch --foreground`.

A protected bind or public workspace URL requires an owner password. Do not
remove authentication to work around startup failure; repair the configuration.

## Missing work

Check the selected workspace and Space, then search archived documents.
Temporary documents archive after their lifetime expires; archiving does not
permanently delete them. Restore a document you need to keep using.

For local storage, `worktable paths` reports the selected directory. Cloud
exports are available in **Settings → Import & Export**.

## Edits and previews

After a revision conflict, reread the document and apply the change to its current
content. Do not force a full replacement to bypass a conflict or formatting refusal.
For a drawing with unsaved local edits, preserve a copy before reloading.

A saved HTML doc or drawing can have a failed preview. Check the save result,
then retry rendering; repeating the write can duplicate work. Read preview
diagnostics when network resources or unsupported rendering make a capture partial.

## Upgrades and imports

Keep the source package or workspace backup. A failed V1 upgrade blocks edits
until the reported problem is repaired and the upgrade retried. Do not change
the manifest version manually.

Import failures can identify unsafe paths, unsupported formats, integrity errors,
or size limits. Import creates or replaces a snapshot; it does not merge two
independently edited workspaces. See [Workspace packages](/reference/workspace-packages/).

## Report a problem

Include the Worktable version, platform, deployment, steps, and relevant error
text in a [bug report](https://github.com/worktable/worktable-dev/issues/new/choose).
Remove credentials and private workspace content from logs and screenshots.
For Cloud account or billing help, use [Cloud account](/guides/cloud-account/).
