---
title: Troubleshooting
description: Recover from installation, connection, document, and transfer problems.
---

CLI diagnostics check a local installation only. They can't diagnose your
Cloud account or a server on another computer.

## Local installation

```sh
worktable doctor
worktable status
worktable paths
```

These report installation health, the active host and workspace, and paths.
For a managed service, check `worktable service logs -n 100` and
`worktable service status`. Each log rotates at 10 MB and keeps three older
copies. Logs leave out document paths and error details;
to include them while you reproduce a problem, set `WORKTABLE_DEBUG=1` for the
service and restart it.

- **Port in use:** run `worktable launch --port 7481`, then reconnect clients
  to the endpoint Worktable reports.
- **`worktable` not found:** add the install directory the installer printed
  to PATH. The installer does not edit shell profiles.

## Desktop connection

- **This Mac:** if an agent lost its endpoint after you quit, reopen Worktable.
  Closing the window keeps the host running; quitting stops it.
- **Self-hosted:** check the address, certificate and that the server is up.
  Desktop rejects redirects and a different workspace at a saved address.
- **Cloud:** use the Cloud option and finish sign-in in the system browser.

See [Desktop](/reference/desktop/).

## Agent access

On a CLI-managed host:

```sh
worktable mcp status
worktable mcp test
worktable mcp repair
```

**Settings → Agents** shows the current endpoint and setup steps. A remote
client needs a reachable host; `localhost` means the client's own computer.
Cloud clients usually need browser OAuth approval.

- **Remote client has no token:** run `worktable mcp setup` on the host or
  pair again.
- **Codex entry invalid or duplicated:** `worktable mcp repair` rewrites it.
- **After a token rotation:** recheck your other clients.
- **OpenClaw and Hermes:** use their plugin setup, not `worktable mcp setup`.
  `hermes worktable status` shows a Hermes connection. If its Cloud sign-in
  expired, run `hermes worktable connect` again and restart the gateway.
- **Client needs stdio:** use `worktable mcp stdio` for a local workspace, or an
  [HTTP bridge](/reference/mcp/#http-to-stdio-bridge) for a remote server.

An offline agent's messages stay queued; the thread is not lost. See
[Connections](/start/connect-your-agent/).

## Service startup

Read `worktable service logs -f`, fix the cause, then run
`worktable service restart`. A service won't start beside a Desktop-owned or
foreground host. Where managed services aren't available, use
`worktable launch --foreground`.

A protected bind or public workspace URL needs an owner password. Fix the
configuration; don't remove authentication to get past a startup error.

## Missing work

Check the selected workspace and Space, then search archived documents.
Temporary documents are archived, not deleted, when they expire. Restore any
you need.

For local storage, `worktable paths` shows the directory. Cloud exports are in
**Settings → Data**.

## Edits and previews

After a revision conflict, reread the document and reapply your change. Don't
force a full replacement to get past a conflict or formatting refusal. Before
reloading a drawing with unsaved edits, save a copy.

If an HTML doc or drawing saved but its preview failed, retry the render, not
the write, which can duplicate work. Preview diagnostics explain partial
captures.

## Upgrades and imports

Keep the source package or backup. A failed V1 upgrade blocks edits until the
problem is fixed and the upgrade retried. Don't edit the manifest version by
hand.

Import errors name unsafe paths, unsupported formats, integrity errors or size
limits. Import creates or replaces a snapshot; it never merges workspaces. See
[Workspace packages](/reference/workspace-packages/).

## Report a problem

File a [bug report](https://github.com/worktable/worktable-dev/issues/new/choose)
with the Worktable version, platform, deployment, steps and error text. Remove
credentials and private content from logs and screenshots. For account or
billing help, see [Cloud account](/guides/cloud-account/).
