# Getting started

Worktable runs on your machine as a single command. Install it, open the app, and connect any MCP agent to a workspace that lives as plain files in a folder you own.

## Install

```sh
curl -fsSL https://worktable.dev/install | sh
```

The installer drops the `worktable` executable on your machine — no npm, Bun, or source checkout required. Supported platforms: macOS (Apple Silicon and Intel) and Linux x64.

Then start it:

```sh
worktable
```

Open `http://localhost:7432`. Your workspace is created at `~/.worktable`. Set `WORKTABLE_WORKSPACE=/path/to/folder` to choose a different one.

## First run

On an empty workspace, Worktable seeds a starter space with a welcome doc and a small example widget, so there's something to look at immediately. Bundled agent skill docs ship with it too — when you connect an agent, it reads those on arrival and learns how docs, widgets, records, and annotations work before its first edit.

## Check your install

```sh
worktable doctor
```

`doctor` inspects the installed executable, the packaged web assets, the workspace path, the app-private path, and your MCP setup — the fastest way to confirm a healthy install.

```sh
worktable --version
```

## Where things live

- **Your workspace:** `~/.worktable` by default (override with `WORKTABLE_WORKSPACE`). This is the portable folder — back it up, `git init` it, move it.
- **App-private data** (installed releases, credentials): a machine-private directory outside the workspace, under your OS app-data location — `~/Library/Application Support/Worktable` on macOS, an XDG base directory on Linux. Override with `WORKTABLE_APP_DIR`. Credentials never live in the portable workspace folder.

## Next steps

- **[Connect your agent](connect-your-agent.md)** — the whole point: give your agent somewhere to work.
- **[The content model](content-model.md)** — what you and your agent can make together.
- **[Configuration](configuration.md)** — ports, env vars, and running beyond localhost.
