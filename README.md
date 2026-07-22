# Worktable

**Worktable is a local-first workspace you share with your AI agents.**

Agents get somewhere better than chat to put durable work: private docs, interactive HTML docs, and file-backed records. You get a calm visual surface to inspect, edit, and come back to that work later. Everything lives as plain files in a folder you own.

> This repo is where Worktable's **releases and installer** live. The app itself is developed privately (more on that below). The product home is [worktable.dev](https://worktable.dev) and the docs live at [docs.worktable.dev](https://docs.worktable.dev).

## Install

```sh
curl -fsSL https://worktable.dev/install | sh
worktable
```

That's it: setup walks you through the rest and prints your URL (default `http://localhost:7480`). Your workspace lands at `~/Worktable`. No npm, no Bun, no source checkout.

Want to read the script before piping it into your shell? Sensible. It's [right here](./install.sh), and it's the same file `worktable.dev/install` serves.

From there, [getting started](https://docs.worktable.dev/start/install/) covers the first run, and [connect your agent](https://docs.worktable.dev/start/connect-your-agent/) hooks up Claude Code, Cursor, or any other MCP client.

## What you get

- **Docs:** versioned notes, plans, and briefs, as markdown or rich text.
- **HTML docs:** self-contained interactive pages an agent builds for you (dashboards, planners, little tools), running in a sandboxed runtime.
- **Records:** structured data as readable YAML files, shared between agents, HTML docs, and the UI.
- **Annotations:** comments and instructions attached to anything, flowing both ways between you and your agents.

Files are the protocol. The whole workspace lives in one folder: watchable, git-able, greppable, portable. The server, the web app, the MCP tools, and your agents all read and write the same files.

## Where's the source?

Worktable's source is private, for an ordinary reason: it started as a tool I built for myself, I use it every day, and right now I'd rather spend my time making it better than running an open-source project. Open-sourcing it properly is real work (auditing every corner of the codebase for release, then reviewing contributions and maintaining a stable surface), and doing it halfway would serve nobody.

If people genuinely want the source open, I'd gladly do that work. [Open an issue](../../issues) and say so.

Meanwhile, the part that matters day to day is already open: your workspace is plain files (markdown, YAML, HTML) in a folder you own. No database, no export step, no lock-in. If Worktable vanished tomorrow, your data would still be sitting there, readable by anything.

## Documentation

Guides, concepts, agent orientation, and the full CLI and MCP reference live at **[docs.worktable.dev](https://docs.worktable.dev)**. Release-by-release changes are on [What's new](https://docs.worktable.dev/whats-new/).

## Releases

Platform builds and checksums are published under [Releases](../../releases) for macOS (Apple Silicon and Intel) and Linux (x64 and arm64). The installer resolves artifacts through `worktable.dev/releases/*`, which redirects here.

Once installed, updating is built in: run `worktable update`, or use Settings → Software Update in the app.

## Links

- Product site: [worktable.dev](https://worktable.dev)
- Bugs and feature requests: [Issues](../../issues)
- Security: [SECURITY.md](SECURITY.md)

## License

The Worktable app is proprietary. The documentation and installer script in this repo are provided for use with Worktable under a limited grant: see [LICENSE](LICENSE).
