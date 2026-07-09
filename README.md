# Worktable

**Worktable is a local-first, file-backed workspace shared by you and your AI agents.**

Agents get somewhere better than chat to put durable work: private docs, interactive HTML widgets, and file-backed records. You get a calm visual surface to inspect, edit, and return to that work later. Everything lives as plain files in a folder you own.

> This repository hosts Worktable's **public releases and installer**. The Worktable application itself is maintained privately. The product home is [worktable.dev](https://worktable.dev); the documentation lives at [docs.worktable.dev](https://docs.worktable.dev).

## Install

```sh
curl -fsSL https://worktable.dev/install | sh
worktable
```

Setup walks you through it and prints your URL (default `http://localhost:7480`). Your workspace is created at `~/Worktable`. No npm, Bun, or source checkout required.

From there, [getting started](https://docs.worktable.dev/start/install/) covers the first run, and [connect your agent](https://docs.worktable.dev/start/connect-your-agent/) hooks up Claude Code, Claude Desktop, Cursor, or any MCP client.

## What you get

- **Docs:** versioned narrative knowledge (notes, plans, briefs) as markdown or rich blocks.
- **Widgets:** self-contained HTML mini-apps an agent builds for you, running in a sandboxed runtime.
- **Records:** structured data as readable YAML files, shared between agents, widgets, and the UI.
- **Annotations:** comments and instructions attached to anything, flowing both ways between humans and agents.

Files are the protocol: the whole workspace lives under one folder (default `~/Worktable`), watchable, git-able, greppable, and portable. The server, the web app, the MCP tools, and your agents all read and write the same files.

## Documentation

Guides, concepts, agent orientation, and the full CLI and MCP tool reference live at **[docs.worktable.dev](https://docs.worktable.dev)**. Release-by-release changes are on [What's new](https://docs.worktable.dev/whats-new/).

## Releases

Platform builds and checksums are published under [Releases](../../releases). The installer resolves artifacts through `worktable.dev/releases/*`, which redirects to this repository's releases. Supported platforms: macOS (Apple Silicon and Intel) and Linux (x64 and arm64).

Once installed, update in place with `worktable update` or Settings → Software Update in the app.

## Links

- Product site: [worktable.dev](https://worktable.dev)
- Report a bug or request a feature: [Issues](../../issues)
- Security: see [SECURITY.md](SECURITY.md)

## License

The Worktable application is proprietary. The documentation and installer script in this repository are provided for use with Worktable under a limited grant. See [LICENSE](LICENSE).
