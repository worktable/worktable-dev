---
title: Connections
description: Connect an agent to local, self-hosted, or Cloud Worktable.
---

Open **Settings → Agents** in the workspace you want to use. Setup is also
available during onboarding. Run generated commands on the computer where the
agent runs, which may differ from the Worktable host.

## Coding agents

For a local CLI installation on the same computer:

```sh
worktable mcp setup
```

To select one client, run `worktable mcp setup <client>`. Supported IDs are
`claude-code`, `codex`, `cursor`, `vscode`, and `opencode`. Goose uses a manual
configuration from `worktable mcp print-config goose`.

For an agent on another computer, generate its command under **Connect an
agent**, or run `worktable agent invite` on the Worktable host. The command
redeems a single-use pairing code and configures the client. The host must be
reachable from that computer; see [Remote access](/guides/remote-access/).

For **Worktable Cloud**, use the command under **Connect an agent**. It configures
the hosted MCP endpoint without downloading a Worktable token. Open or restart
the client and complete its browser-based OAuth approval. **Manual install**
provides configuration for clients you manage yourself.

## Plugins

The general Worktable plugin bundles skills and a connection to
`https://app.worktable.cloud/api/mcp`. It is a **Cloud connection**. For local or
self-hosted Worktable, use that installation's MCP configuration and install
[skills](/agents/skills/) separately if your client supports them.

For Claude Code:

```sh
claude plugin marketplace add worktable/worktable-dev
claude plugin install worktable@worktable
```

Start a new session or run `/reload-plugins`, then use `/mcp` to authenticate
Worktable. See [Claude's plugin instructions](https://code.claude.com/docs/en/discover-plugins).

For Codex:

```sh
codex plugin marketplace add worktable/worktable-dev
codex plugin add worktable@worktable
```

Complete the client's authentication flow. See the
[Codex command reference](https://learn.chatgpt.com/docs/developer-commands#codex-plugin).

A plugin's presence does not prove that authorization completed. Verify access
in the connected client before reading or writing workspace content.

## Always-on agents

Always-on agents run continuously and answer thread messages addressed to them.
Set one up from its section in **Settings → Agents**.

### OpenClaw

Install its Worktable plugin:

```sh
openclaw plugins install clawhub:@worktable/openclaw
```

For local or self-hosted Worktable, generate the participant's single-use
pairing command in Settings. For Cloud, run the displayed Agent Registration
command and complete the claim in the browser. The OpenClaw plugin includes
Worktable skills; a separate skills installation is unnecessary.

For installer and runtime diagnostics, see the
[OpenClaw plugin CLI](https://docs.openclaw.ai/cli/plugins).

OpenClaw connects to the whole Worktable, with general and Space conversations.
Its default Cloud access is conversation-only.

### Hermes

Install the Worktable plugin into [Hermes Agent](https://hermes-agent.nousresearch.com/)
0.21.5 or later:

```sh
hermes plugins install worktable/worktable-dev#packages/hermes-plugin --enable
```

Then connect the Hermes profile:

- **Cloud:** run `hermes worktable connect https://app.worktable.cloud`. Hermes
  prints a link and a code; open the link on any device, sign in, and confirm
  the code. This works the same on a server without a browser.
- **Local or self-hosted:** generate the single-use command in **Settings →
  Agents → Hermes** and run it where Hermes is installed.

Restart the gateway with `hermes gateway restart`. Hermes then answers thread
messages addressed to it and uses Worktable's tools and skills in any of its
conversations. Check the connection with `hermes worktable status`; remove it
with `hermes worktable disconnect`, then disconnect the agent in Settings.

See [Threads](/guides/threads/) for delivery behavior.

## Desktop apps

For local or self-hosted Worktable, open **Desktop apps** in Settings.
Claude Desktop on macOS uses the downloadable `.mcpb` extension. Open it in
Claude, approve installation, and enter the endpoint and any token shown by
Worktable. Worktable Cloud uses a remote OAuth connection instead of this
extension.

For other clients, use the supported configuration shown in Settings. A
provider running remotely cannot reach `localhost` on your computer; it needs
a protected remote endpoint or Cloud. Provider availability depends on its
supported MCP transports and account policy.

When Desktop owns the local server, it must remain running. Closing the window
keeps the server available; quitting stops it. A separate managed service can
continue independently.

## Transport and access

The default CLI-local HTTP endpoint is `http://localhost:7480/mcp`.
Copy the actual endpoint from Settings when the port or deployment differs.

Tokenless access is limited to trusted literal-loopback requests when deployment
policy allows it. Reachable self-hosted endpoints require a bearer token;
Cloud uses OAuth. Do not substitute a loopback URL for a remote endpoint.

`worktable mcp stdio` starts an in-process server against the local workspace.
It does not proxy an existing remote server. Clients requiring a remote
HTTP-to-stdio connection need the [bridge](/reference/mcp/#http-to-stdio-bridge).

## Verify and repair

For connector-managed clients on the Worktable host:

```sh
worktable mcp status
worktable mcp test
worktable mcp repair
```

Then ask the agent to call `worktable_discover` with action `state`. Check that
it returns the intended workspace and Spaces. A conversation-only participant
may not have discovery access; verify it by sending an authorized test message.

To disconnect, remove the client configuration and revoke its token or approved
connection in **Settings → Agents**. Removing configuration alone does not
revoke access. Signing out of Cloud in the browser does not disconnect agents.

Install optional [skills](/agents/skills/) after verifying the connection.
For failures, see [Troubleshooting](/guides/troubleshooting/).
