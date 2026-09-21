---
title: Install Worktable from the CLI
description: Install local or self-hosted Worktable on macOS or Linux with one command.
---

Use the command-line install on macOS or Linux to run Worktable locally in your
browser, or on a server you control. It is the recommended starting point for
the current release. If you do not want to operate a machine or server, use
[Worktable Cloud](/guides/worktable-cloud/).

```sh
curl -fsSL https://worktable.dev/install | sh
```

The installer supports macOS and Linux on arm64 and x64. It sets up the
`worktable` command (with a `wtb` shorthand), then starts interactive setup.
When setup finishes, open the address it prints. The default is:

```text
http://localhost:7480
```

## See it before you run it

Piping a script to `sh` deserves skepticism. The installer is short, needs no
sudo, and edits no shell profiles. See exactly what it would download and touch:

```sh
curl -fsSL https://worktable.dev/install | sh -s -- --dry-run
```

Every flag and default path is listed in the
[installer reference](/reference/installer/).

## Choose the workspace folder

Your workspace is a plain folder at `~/Worktable` by default. Docs, HTML docs,
records, annotations, threads, and history remain separate from app settings
and credentials.

Pick another folder during setup, or steer it explicitly:

```sh
worktable setup --workspace ~/work/notebook
```

```sh
WORKTABLE_WORKSPACE=~/work/notebook worktable
```

Worktable can adopt an existing valid workspace. It refuses to initialize a
non-empty unrelated folder or overwrite an unfamiliar workspace identity.

## Choose how it runs

Interactive setup offers a managed background service or a foreground process.
The background service is convenient for agents that should reach Worktable
after the terminal closes. Foreground mode keeps lifecycle control in the
current terminal.

To make a server reachable from another machine, finish the local setup first,
then follow [Reach Worktable from another machine](/guides/remote-access/).

## Verify the install

```sh
worktable doctor
```

`doctor` checks the installation and reports the active workspace, service, and
agent setup.

## Non-interactive installs

```sh
# Accept defaults without prompts
curl -fsSL https://worktable.dev/install | sh -s -- --yes

# Install only; run setup yourself later
curl -fsSL https://worktable.dev/install | sh -s -- --no-setup
```

You can also supply `--workspace`, `--port`, `--background` or `--foreground`,
and `--mcp <client-ids>` in the same pass. See the
[installer reference](/reference/installer/) for every flag and path.

## Next

[Connect an agent](/start/connect-your-agent/) or
[create your first space](/start/first-space/).
