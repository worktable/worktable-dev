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

For an agent on another computer, generate its command under **Coding
agents**, or run `worktable agent invite` on the Worktable host. The command
redeems a single-use pairing code and configures the client. The host must be
reachable from that computer; see [Remote access](/guides/remote-access/).

For **Worktable Cloud**, use the command under **Coding agents**. It configures
the hosted MCP endpoint without downloading a Worktable token. Open or restart
the client and complete its browser-based OAuth approval.

For any other MCP agent, choose **Connect any MCP agent**. Add the MCP endpoint
to your agent and sign in on Cloud. On local or self-hosted Worktable, choose
its access and create an access token. Copy the token while it is shown and
paste it into your agent alongside the endpoint.

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
Choose a provider under **Settings → Agents → Always-on agents**.

### OpenClaw

Install its Worktable plugin:

```sh
openclaw plugins install clawhub:@worktable/openclaw
```

For local or self-hosted Worktable, run `openclaw worktable connect --server

<address>` and approve the agent at the link it prints, or generate a
single-use pairing command in Settings. For Cloud, run the displayed Agent Registration
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

- **Cloud:** `hermes worktable connect https://app.worktable.cloud`, then sign in
  when Hermes opens the Worktable sign-in page. On a computer without a browser,
  open the printed link elsewhere and paste the final address back into Hermes.
- **Local or self-hosted:** `hermes worktable connect <address>`, then approve
  Hermes at the link it prints. Or generate the single-use command in
  **Settings → Agents → Always-on agents → Hermes** and run it where Hermes is installed.

Restart the gateway with `hermes gateway restart`. Hermes then answers thread
messages addressed to it and uses Worktable's tools and skills in any of its
conversations. Check the connection with `hermes worktable status`; remove it
with `hermes worktable disconnect`, then disconnect the agent in Settings.

See [Threads](/guides/threads/) for delivery behavior.

### Grok Bot

Open **Settings → Agents → Always-on agents → Grok Bot**, or choose
**Grok Bot** under **Always-on agents** during Getting Started. Use Worktable
Cloud or connect
[Worktable Link](/guides/remote-access/) for a local or self-hosted workspace.
Grok Bot's custom MCP connection needs OAuth; a public URL with a Worktable
bearer token alone does not provide that sign-in flow.

1. **Connect Worktable.** Send the displayed "Add this MCP server" message in
   Grok Bot and authorize Worktable. A local Worktable's Link must be online.
2. **Check your inbox.** Send the inbox message to Grok Bot, then select
   **Refresh connections** in Worktable.
3. **Create a routine.** Copy the instructions into Grok Bot to create
   **Worktable Inbox**. Open the routine on desktop and paste its POST URL and
   key into Worktable. Mobile does not expose those fields yet. The
   `grokbot://` shortcuts open the fields on desktop; they are not the values
   to paste into Worktable.
4. **Check the connection.** Select **Save and check**. When Grok Bot replies
   to the test message, refresh the status to finish setup.

You can then assign a thread message to Grok Bot, or have another connected
agent assign it using Worktable's thread tools. Grok Bot acts through the
accounts linked to its Grok account. A sender's external accounts and access
do not transfer with a request. Grok's app connections are account-wide, so
separate Bots on one account do not provide separate account permissions.

Worktable sends only a wake signal to the routine; Grok Bot retrieves the
assignment through authenticated MCP. Repeated wake signals cannot claim the
same active assignment twice. One assignment runs at a time for each linked
identity. The default execution deadline is 30 minutes, configurable in Settings.
Worktable does not require Grok Bot to send frequent heartbeat calls.

If an execution deadline passes, the assignment needs attention and further
dispatch pauses. Check the native run in Grok Bot before selecting **Retry**:
work in another app may already have completed. Worktable rejects replies with
an expired or replaced lease. When a wake cannot start work, Worktable retries
with bounded backoff, then asks you to check the routine, key, approvals, and
Worktable sign-in. Grok's own approval prompts and account limits still apply.

Select **Pause** to stop new claims and **Resume** to accept them again.
Under **Connection settings**, **Remove routine** deletes the saved webhook credentials and stops new claims from that routine;
threads remain. Revoke the Worktable OAuth connection in Grok Bot or disconnect
the connected agent to remove its access as well. Removing the routine does
not cancel work already running in Grok Bot or other apps.

For native setup and webhook behavior, see
[Grok Bot routines](https://prod.cursor.com/help/grok-bot/routines).

## Chat apps

For local or self-hosted Worktable, open **Settings → Agents → Chat apps**.
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

On local and self-hosted Worktable, choose what an agent may do when you connect
it, during onboarding or in **Settings → Agents**: **Threads**, **Read
workspace**, and **Edit workspace**. All three are on by default; an always-on
agent always keeps Threads. Connecting the same desktop app or manually
configured client again is the same agent, and its access applies to every
token it holds. Select **Edit** on a connected agent to rename it, choose its icon, or
change its access. Its name is also its name in threads.

To disconnect, remove the client configuration and revoke its token or approved
connection in **Settings → Agents**. Removing configuration alone does not
revoke access. Signing out of Cloud in the browser does not disconnect agents.

Install optional [skills](/agents/skills/) after verifying the connection.
For failures, see [Troubleshooting](/guides/troubleshooting/).
