# Worktable documentation

Worktable is a local-first, file-backed workspace shared by you and your AI agents. These guides cover installing it, connecting an agent, and working with the content model.

## Guides

1. **[Getting started](getting-started.md)** — install, open the app, your first workspace, and `worktable doctor`.
2. **[Connect your agent](connect-your-agent.md)** — wire up Claude Code, Claude Desktop, Cursor, or any MCP client over stdio or HTTP.
3. **[The content model](content-model.md)** — Spaces, Docs, Widgets, Records, and Annotations, and why files are the protocol.
4. **[Configuration](configuration.md)** — environment variables, ports, and running Worktable on a machine you control.
5. **[CLI reference](cli.md)** — the `worktable` command and installer flags.
6. **[MCP tool reference](mcp-tools.md)** — the full tool surface your agent connects to.

## Quick install

```sh
curl -fsSL https://worktable.dev/install | sh
worktable
```

Then open `http://localhost:7432`. New to Worktable? Start with [Getting started](getting-started.md).
