# Connect your agent

Worktable speaks [MCP](https://modelcontextprotocol.io). Connect any client — Claude Code, Claude Desktop, Cursor, or anything else that speaks MCP — over stdio or Streamable HTTP. There's no bundled assistant and no proprietary runtime: Worktable is a place your agent works, whatever your agent is.

## Local stdio (recommended for local agents)

Point the client at the installed CLI. For example, in an `.mcp.json`:

```json
{
  "mcpServers": {
    "worktable": {
      "command": "worktable",
      "args": ["--mcp"]
    }
  }
}
```

That's the whole integration — local agents get stdio with zero ceremony and implicit full access to the local workspace.

## HTTP (running server, remote clients)

The running server exposes a Streamable HTTP endpoint at `/mcp`. With Claude Code:

```sh
claude mcp add --transport http worktable http://localhost:7432/mcp
```

Other MCP clients: point them at `http://localhost:7432/mcp`.

### Requiring a token

The HTTP endpoint is open by default. To require auth, set a bearer token before starting the server and configure the client with the matching token:

```sh
WORKTABLE_MCP_TOKEN=your-secret worktable
```

> The REST API under `/api/*` is unauthenticated and the server binds like a local app. Run Worktable on localhost or behind your own network boundary — see [Configuration](configuration.md).

## Introduce the workspace

Agents learn how to work in Worktable through the tools themselves. A line in your agent's instructions like _"You have a Worktable workspace — call `worktable_get_format_spec` before working in it"_ goes a long way. The key discovery tools:

- **`worktable_state`** — orientation: what spaces and docs exist.
- **`worktable_get_format_spec`** — the content model and when to use Docs vs. Widgets vs. Records.
- **`worktable_read_skill`** — the workspace's house rules (`agent-instructions`); read once per session.
- **`worktable_get_widget_authoring_guide`** — read before building or editing widgets.

See the full [MCP tool reference](mcp-tools.md) for everything the agent can call.
