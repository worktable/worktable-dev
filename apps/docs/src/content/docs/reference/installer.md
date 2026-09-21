---
title: Installer reference
description: Every flag and environment override for the install script, and exactly what it touches.
---

The install script at `https://worktable.dev/install` downloads the release for your platform, places the `worktable` launcher (plus the `wtb` shorthand), and starts `worktable setup` when it has an interactive terminal.

Supported targets are macOS and Linux on arm64 or x64. Worktable Desktop is a
separate signed macOS application; this installer is for the CLI and local or
self-hosted service.

## What it touches

- **No sudo.** Everything installs into user-owned directories.
- **No shell-profile edits.** The launcher goes into the install directory; shell completions are placed in your shell's drop-in completions directory (skip with `--no-completions`).
- **Two locations:** the launcher in the install directory, and releases plus install data in the app-private directory. Your workspace folder is created by setup, not the installer.

The launcher prefers a writable `/opt/homebrew/bin`, then `/usr/local/bin`, and
falls back to `~/.local/bin`. App-private data defaults to
`~/Library/Application Support/Worktable` on macOS and
`${XDG_CONFIG_HOME:-~/.config}/worktable` on Linux. The default workspace from
setup is `~/Worktable`.

Not sure? `--dry-run` prints the resolved target, URLs, and paths without installing anything:

```sh
curl -fsSL https://worktable.dev/install | sh -s -- --dry-run
```

## Flags

Pass flags after `sh -s --`:

```sh
curl -fsSL https://worktable.dev/install | sh -s -- --yes --mcp claude-code,codex
```

| Flag                       | What it does                                               |
| -------------------------- | ---------------------------------------------------------- |
| `--yes`                    | Accept installer and setup defaults.                       |
| `--no-setup`               | Install only; do not run `worktable setup`.                |
| `--background`             | Configure Worktable as a background service during setup.  |
| `--foreground`             | Configure manual foreground launch during setup.           |
| `--workspace <path>`       | Workspace directory for setup.                             |
| `--port <port>`            | Local service port for setup.                              |
| `--host <host>`            | Local bind host for setup. Default: `127.0.0.1`.           |
| `--mcp <client-ids>`       | Comma-separated MCP clients to configure during setup.     |
| `--no-completions`         | Skip installing shell completion (installed by default).   |
| `--install-dir <dir>`      | Directory for the `worktable` launcher.                    |
| `--app-dir <dir>`          | App-private directory for releases and install data.       |
| `--version <version>`      | Version to install. Default: latest.                       |
| `--release-base-url <url>` | Base URL for release artifacts.                            |
| `--dry-run`                | Print resolved target, URLs, and paths without installing. |

## Environment overrides

| Variable                     | Overrides                                         |
| ---------------------------- | ------------------------------------------------- |
| `WORKTABLE_INSTALL_DIR`      | Launcher directory (`--install-dir`).             |
| `WORKTABLE_APP_DIR`          | App-private directory (`--app-dir`).              |
| `WORKTABLE_VERSION`          | Version to install (`--version`).                 |
| `WORKTABLE_RELEASE_BASE_URL` | Release artifact base URL (`--release-base-url`). |

## After the install

`worktable doctor` verifies the result. `worktable uninstall` reverses it — your workspace folder survives unless you pass `--purge`.
