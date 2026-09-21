---
title: CLI overview
description: How the worktable command is organized, with the workflows you'll actually type.
---

The CLI installs as `worktable`, with `wtb` as a shorthand — every example below works with either. Bare `worktable` runs `launch`: start (or reuse) the server and open the app.

This page is the guided tour; the [CLI command reference](/reference/cli-commands/) lists every command and flag, generated from the CLI itself.

## Run it

```sh
worktable                      # start or reuse, open the browser
worktable launch --foreground  # run in this terminal, Ctrl+C to stop
worktable launch --background  # run as a managed background service
worktable --version
```

## Set it up

```sh
worktable setup            # interactive: workspace, run mode, agents
worktable setup --yes      # accept defaults, no prompts
```

Setup is re-runnable. It's also where reachability lives — `worktable setup --reachable` binds all interfaces, protects the web app with an owner password, and mints a bearer token for MCP.

## Inspect it

```sh
worktable status   # server, workspace, service, and agent state
worktable doctor   # diagnose install problems (--check for scripts)
worktable paths    # resolved runtime paths (--json available)
```

`status` also reports which local surface currently owns the server: Desktop,
the managed service, or a foreground CLI session. Desktop and the CLI use the
same canonical workspace selection and stable endpoint. If Desktop finds an
existing CLI installation, it offers to attach or start it instead of creating
a second local server. `doctor` reports an interrupted workspace handoff and
the authority paths needed for repair.

## Connect agents

```sh
worktable mcp setup            # auto-detect and connect installed clients
worktable mcp setup codex      # connect one client
worktable mcp status           # per-client connection state
worktable mcp test             # is the endpoint reachable
worktable mcp repair           # re-apply config for connected clients
worktable mcp print-config vscode
```

Automatic setup supports Claude Code, ChatGPT / Codex, Cursor, OpenCode, and VS
Code. Goose uses `mcp print-config`; Claude Desktop uses the extension download
and guided setup in **Settings → Agents → Desktop apps**.

MCP connections and agent skills have separate commands and state. Install the
official Worktable skill suite into either supported local skills folder with:

```sh
worktable skills status
worktable skills install claude
worktable skills install agents
worktable skills update agents
worktable skills repair agents
worktable skills remove agents
```

The `claude` target is `~/.claude/skills`. The `agents` target is the shared
`~/.agents/skills` folder used by other agents that support Agent Skills.
Worktable setup and MCP setup do not install skills. Preview a change with
`--preview`; scripts can apply the exact reviewed plan with
`--plan-id <id> --yes`.

If Worktable runs on another computer, install only the skills on this one:

```sh
curl -fsSL https://worktable.dev/install-skills | sh -s -- --target claude
curl -fsSL https://worktable.dev/install-skills | sh -s -- --target agents
```

Use `status`, `update`, `repair`, or `remove` before `--target` to manage the
same installation. This downloads a temporary skill installer; it does not
install the Worktable app or create an MCP connection.

Status distinguishes missing, outdated, locally modified, conflicting, and
incomplete installations. Repair restores missing Worktable-owned files but
does not overwrite local edits or unmanaged same-name skills. Removal likewise
deletes only byte-exact paths recorded in Worktable's ownership manifest.

For an agent on another machine, `worktable agent invite` prints a one-line command to run over there, and `worktable agent connect <code>` redeems a pairing code on the machine running it. See [Connect your agent](/start/connect-your-agent/) for the walkthrough and [Remote access](/guides/remote-access/) for the pairing flow.

The binary also exposes a hidden provider-facing transport command:

```text
worktable mcp bridge [--url <mcp-url>] [--token-env <name>]
```

It proxies a Worktable Streamable HTTP MCP server to stdio using the same bridge
bundled in the Claude Desktop extension. The URL can come from
`WORKTABLE_MCP_URL`; the token environment variable defaults to
`WORKTABLE_MCP_TOKEN`. Raw tokens are never accepted on the command line. The
existing `worktable mcp stdio` and `worktable --mcp` contracts are unchanged.

## Manage the service

```sh
worktable service status
worktable service restart
worktable service logs -f
```

`install`, `start`, `stop`, and `uninstall` complete the set.
Service start/restart refuses to run beside a Desktop-owned or foreground CLI
host. Desktop can adopt an installed service, switch its workspace
transactionally, restart it, and reveal these same logs.

## Export or import a workspace

```sh
worktable workspace export backup.wtb             # all available history
worktable workspace export backup.wtb --history none
worktable workspace import backup.wtb ~/Restored  # new, independent workspace
```

Export writes a standard compressed ZIP package with an offline browser
(`--force` replaces an existing regular file). History can be `all`, `age`,
`count`, or `none`; age and count have matching limit flags. Import creates a
fresh workspace in a missing or empty directory. Owner-facing replacement lives
in **Settings → Import & Export**. Neither path merges or starts sync. See
[Import and export a workspace](/guides/import-export/).

## Update and remove

```sh
worktable update           # update to the latest release
worktable update --check   # just tell me if one exists
worktable uninstall        # remove Worktable; your workspace folder stays
```

`uninstall --purge` also deletes the workspace folder — the only command that touches your files.

## Shell completion

The installer sets up tab completion by default (bash, zsh, fish). If you skipped it or want it later:

```sh
worktable completion install        # detects your shell, places the files
worktable completion zsh            # or print the script to wire up yourself
```
