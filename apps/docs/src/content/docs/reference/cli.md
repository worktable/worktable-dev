---
title: CLI
description: Find commands for running, connecting, and managing Worktable.
---

The CLI installs as `worktable`, with `wtb` as an alias. Running `worktable`
without a command launches or reuses the server and opens the browser.

The generated [CLI commands](/reference/cli-commands/) reference contains every
public command, option, and default.

| Task | Commands | Guide |
| --- | --- | --- |
| Install and configure | `setup`, `launch` | [CLI install](/start/install/) |
| Inspect the installation | `status`, `doctor`, `paths` | [Troubleshooting](/guides/troubleshooting/) |
| Connect agents | `mcp setup`, `mcp status`, `mcp test`, `mcp repair` | [Connections](/agents/connections/) |
| Install workflow skills | `skills install`, `skills update`, `skills remove` | [Skills](/agents/skills/) |
| Connect another computer | `agent invite`, `agent connect` | [Remote access](/guides/remote-access/) |
| Manage a background host | `service status`, `service restart`, `service logs` | [CLI install](/start/install/) |
| Transfer a workspace | `workspace export`, `workspace import` | [Workspace backups](/guides/import-export/) |
| Update or uninstall | `update`, `uninstall` | [Updates](/guides/update-and-uninstall/) |

## Host ownership

`status` identifies whether Desktop, a managed service, or a foreground CLI
session owns the local server. Service start and restart refuse to run beside
a Desktop-owned or foreground host. Desktop can attach to a managed service.

`doctor` reports installation problems and interrupted workspace handoffs.
`paths --json` provides resolved paths for scripts. Use these before assuming
the workspace lives at its default location.

## Removal

`worktable uninstall` removes the installation and keeps the workspace.
`--purge` also deletes workspace content. Review the removal plan and export
any content you need before purging.

## Completion

The installer configures bash, zsh, or fish completion unless disabled. To add
it later, run `worktable completion install`; `worktable completion zsh` prints
the script for manual installation.
