---
title: Connect Your Agent
description: Connect coding agents, always-on participants, and AI apps to the same Worktable workspace.
---

New Worktables offer agent setup during the first run. You can connect several
agents there, continue without one, or return to **Settings → Agents** later.
The available methods match the current deployment and how each agent runs.

Worktable speaks [MCP](https://modelcontextprotocol.io). Coding agents and AI
apps use the same workspace tools, subject to the access granted to each
connection. Always-on participants use the conversation layer to receive
Worktable threads when their normal chat window is not open.

## Coding agents

### Local or self-hosted Worktable

The quickest same-machine setup is:

```sh
worktable mcp setup
```

Worktable detects and configures supported clients. To choose one explicitly:

```sh
worktable mcp setup <client>
```

Connector-installable IDs are `claude-code`, `codex`, `cursor`, `vscode`, and
`opencode`. Goose uses a paste-ready manual snippet:

```sh
worktable mcp print-config goose
```

To connect an agent on another machine, open **Connect an agent** in Settings
and generate the one-line command, or run `worktable agent invite` on the
Worktable host. The command configures the selected clients and verifies the
connection. [Remote access](/guides/remote-access/) covers the network setup.

### Worktable Cloud

Open **Connect an agent**, choose a client or automatic detection, and run the
displayed command on the computer where the agent lives. It writes the Cloud
MCP endpoint without downloading a Worktable token. The client opens the
browser-based OAuth approval on first use.

Use **Manual install** when you prefer to edit the provider configuration
yourself. Cloud snippets remain tokenless; the client discovers OAuth from the
server.

## Always-on agents

Open **Always-on agents** to connect OpenClaw as a durable participant. Install
the Worktable plugin from ClawHub:

```sh
openclaw plugins install clawhub:@worktable/openclaw
```

For local or self-hosted Worktable, enter a participant name and generate the
single-use OpenClaw command in Settings. For Worktable Cloud, run the displayed
Agent Registration command; it uses an interactive claim rather than a reusable
API key.

OpenClaw connects to the whole Worktable. General conversations can live at the
Worktable level, while Space conversations retain their Space context. Its
default Cloud access is limited to conversations. See
[Worktable and Space threads](/guides/threads/).

## Official ChatGPT plugin

Install the official Worktable plugin from ChatGPT to connect a Worktable Cloud
workspace through OAuth. The plugin can search Worktable Docs, HTML Docs, and
Records as ChatGPT Company Knowledge and also exposes the fuller Worktable
surface for creating Docs, interactive HTML Docs, Records, annotations, and
threads.

In ChatGPT, **Company Knowledge** is the standard read path for searching a
connected service. Worktable implements it with a `search` tool that returns
matching item IDs and links, and a `fetch` tool that reads the selected document
or Record. It does not replace Worktable's other tools; those remain available
when ChatGPT needs to build or change workspace artifacts.

ChatGPT can register as a Worktable thread participant, read messages addressed
to it, and reply while you are actively using the plugin. Addressed messages
stay queued in Worktable between ChatGPT conversations. Ask ChatGPT to check
its Worktable messages to receive them. Use OpenClaw when a participant must
remain connected and process deliveries without a person invoking it.

## Desktop and web AI apps

### Local or self-hosted Worktable

Open **Desktop apps** in Settings.

- **Claude Desktop on macOS:** download the Worktable extension, open the `.mcpb`, and
  approve it in Claude. Paste the endpoint shown by Worktable. A literal
  same-machine loopback connection needs no token; a protected or
  network-reachable server also needs the one-time token Settings offers.
- **ChatGPT desktop:** add the displayed endpoint as a Streamable HTTP MCP
  server. ChatGPT desktop, Codex CLI, and the Codex IDE extension can share the
  same Codex MCP configuration, so check the existing entry before adding a
  duplicate.

A browser-based provider cannot reach a literal `localhost` server on another
machine. Use a protected self-hosted endpoint or Worktable Cloud when the
provider requires a public remote MCP server.

Worktable Desktop must remain running while an AI app uses a Desktop-owned
local endpoint. Closing the Desktop window keeps it available; quitting stops
it. An attached managed service remains available independently.

### Worktable Cloud

Open **Desktop and web apps** and copy the remote MCP endpoint into a provider
that supports remote MCP. Claude or ChatGPT opens WorkOS for approval and keeps
the resulting OAuth grant. Provider availability can depend on the provider's
plan and workspace policy.

This manual connection remains useful for provider-native MCP clients. In
ChatGPT, prefer the official Worktable plugin because it also supplies the
Worktable skills and Company Knowledge contract.

## Manual configuration

The default CLI-local Streamable HTTP endpoint is:

```text
http://localhost:7480/mcp
```

`worktable mcp print-config <client>` prints the supported configuration. For
apps that use stdio instead of HTTP:

```json
{
  "mcpServers": {
    "worktable": {
      "command": "worktable",
      "args": ["mcp", "stdio"]
    }
  }
}
```

A literal loopback install can be tokenless. Network-reachable and public
self-hosted endpoints require a bearer. Worktable Cloud uses OAuth instead of
local Worktable tokens. The [MCP reference](/reference/mcp/) has the complete
connection and authentication details.

## Verify and repair

For local connector-managed clients:

```sh
worktable mcp status
worktable mcp test
worktable mcp repair
```

To verify the connection, ask the agent to call `worktable_discover` with the
`state` action. A response containing your spaces confirms that it can reach
the workspace.

## Introduce the workspace

Worktable's MCP metadata is factual and provider-neutral. It describes the
private content types and callable capabilities, but does not load workspace
Docs as instructions. Clients that support Agent Skills can install the
optional Worktable skill suite separately.

If you want a short project-level reminder without installing skills, use:

```text
You have a Worktable workspace. Use its MCP tools when I ask you to find,
create, or update Worktable content.
```

The [agent overview](/agents/overview/) explains the neutral MCP contract and
optional workflow skills.
