# CLI reference

The `worktable` command runs the local server, the stdio MCP transport, and diagnostics.

## Commands

```sh
worktable
```

Start the Worktable server and serve the web app + API on `http://localhost:7432` (override the port with `PORT`).

```sh
worktable --mcp
```

Run the stdio MCP transport — this is the `command`/`args` an MCP client uses for a local connection. See [Connect your agent](connect-your-agent.md).

```sh
worktable doctor
```

Inspect the installed executable, packaged web assets, workspace path, app-private path, and MCP setup.

```sh
worktable --version
```

Print the installed version.

## Installer flags

The installer is invoked as `curl -fsSL https://worktable.dev/install | sh`. To pass flags, append `-s --`:

```sh
curl -fsSL https://worktable.dev/install | sh -s -- --version v0.0.1 --dry-run
```

| Flag | Purpose | Default |
|---|---|---|
| `--install-dir <dir>` | Directory for the `worktable` launcher | first writable of `/opt/homebrew/bin`, `/usr/local/bin`, `~/.local/bin` |
| `--app-dir <dir>` | App-private directory for releases and install data | OS app-data dir |
| `--version <version>` | Version to install | `latest` |
| `--release-base-url <url>` | Base URL for release artifacts | `https://worktable.dev/releases` |
| `--dry-run` | Print resolved target, URLs, and paths without installing | — |
| `--help` | Show installer help | — |

Each flag has an environment-variable equivalent: `WORKTABLE_INSTALL_DIR`, `WORKTABLE_APP_DIR`, `WORKTABLE_VERSION`, `WORKTABLE_RELEASE_BASE_URL`.

`--dry-run` is the safe way to preview exactly what the installer will fetch and where it will land before running it for real.
