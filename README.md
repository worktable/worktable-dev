# Worktable

**Worktable is a local-first, file-backed workspace shared by you and your AI agents.**

Agents get somewhere better than chat to put durable work — private docs, interactive HTML widgets, and file-backed records — and you get a calm visual surface to inspect, edit, and return to that work later. Everything lives as plain files in a folder you own.

> This repository hosts Worktable's **public releases, the installer, and documentation**. The Worktable application itself is maintained privately. The product home is [worktable.dev](https://worktable.dev).

## Install

```sh
curl -fsSL https://worktable.dev/install | sh
worktable
```

Open `http://localhost:7432`. Your workspace is created at `~/.worktable`. No npm, Bun, or source checkout required.

See **[docs/getting-started.md](docs/getting-started.md)** for the full first-run flow, and **[docs/connect-your-agent.md](docs/connect-your-agent.md)** to connect Claude Code, Claude Desktop, Cursor, or any MCP client.

## What you get

- **Docs** — versioned narrative knowledge: notes, plans, briefs. Markdown or rich blocks.
- **Widgets** — self-contained HTML mini-apps an agent builds for you, in a sandboxed runtime.
- **Records** — structured data as readable YAML files, shared between agents, widgets, and the UI.
- **Annotations** — comments and instructions attached to anything, flowing both ways between humans and agents.

**Files are the protocol.** The whole workspace lives under one folder (default `~/.worktable`) — watchable, git-able, greppable, and portable. The server, the web app, the MCP tools, and your agents all read and write the same files.

## Documentation

| Guide | What it covers |
|---|---|
| [Getting started](docs/getting-started.md) | Install, open the app, first-run workspace, `worktable doctor` |
| [Connect your agent](docs/connect-your-agent.md) | MCP over stdio and HTTP, tokens, introducing the workspace |
| [The content model](docs/content-model.md) | Spaces, Docs, Widgets, Records, Annotations, files-as-protocol |
| [Configuration](docs/configuration.md) | Environment variables, ports, running on a machine you control |
| [CLI reference](docs/cli.md) | `worktable` commands and installer flags |
| [MCP tool reference](docs/mcp-tools.md) | The full tool surface agents connect to |

## Releases

Platform builds and checksums are published under [Releases](../../releases). The installer resolves artifacts through `worktable.dev/releases/*`, which redirects to this repository's releases. Supported platforms: macOS (Apple Silicon + Intel) and Linux x64.

## Links

- Product site: [worktable.dev](https://worktable.dev)
- Report a bug or request a feature: [Issues](../../issues)
- Security: see [SECURITY.md](SECURITY.md)

## License

The Worktable application is proprietary. The documentation and installer script in this repository are provided for use with Worktable under a limited grant — see [LICENSE](LICENSE).
