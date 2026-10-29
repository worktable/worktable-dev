---
title: Connections
description: Connect an agent to local, self-hosted, or Cloud Worktable.
---

Open **Settings → Agents** in the workspace you want to use, or connect during
onboarding. Run generated commands on the computer where the agent runs, which
may not be the Worktable host.

## Coding agents

For a local CLI installation on the same computer:

```sh
worktable mcp setup
```

To set up one client, run `worktable mcp setup <client>` with `claude-code`,
`codex`, `cursor`, `vscode`, or `opencode`. For Goose, use the configuration
from `worktable mcp print-config goose`.

For an agent on another computer, copy its command from **Coding agents**, or
run `worktable agent invite` on the Worktable host. The command redeems a
single-use pairing code. The host must be reachable from that computer; see
[Remote access](/guides/remote-access/).

For **Worktable Cloud**, run the command under **Coding agents**, then approve
sign-in in the browser that opens. Cursor and VS Code sign in from the app
instead. If the command can't sign in, for example when an agent runs it, it
prints the step that finishes the connection.

For any other MCP agent, choose **Connect any MCP agent** and add the endpoint
to your agent. On Cloud, sign in. On local or self-hosted Worktable, choose its
access and create an access token. Copy the token while it is shown.

## Plugins

The general Worktable plugin bundles skills and a **Cloud connection** to
`https://app.worktable.cloud/api/mcp`. For local or self-hosted Worktable, use
that installation's MCP configuration and install [skills](/agents/skills/)
separately if your client supports them.

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

Then complete the client's sign-in. See the
[Codex command reference](https://learn.chatgpt.com/docs/developer-commands#codex-plugin).

An installed plugin is not proof of sign-in. Check access in the client before
reading or writing workspace content.

## Always-on agents

Always-on agents run continuously and answer thread messages addressed to them.
Choose a provider under **Settings → Agents → Always-on agents**.

### OpenClaw

Install the Worktable plugin:

```sh
openclaw plugins install clawhub:@worktable/openclaw
```

- **Local or self-hosted:** run `openclaw worktable connect --server <address>`
  and approve the agent at the link it prints, or use the single-use pairing
  command from Settings.
- **Cloud:** run the displayed Agent Registration command and complete the
  claim in the browser.

The plugin includes Worktable skills, so you don't need to install them
separately. OpenClaw connects to the whole Worktable, with general and Space
conversations. Its default Cloud access is conversation-only. For diagnostics,
see the [OpenClaw plugin CLI](https://docs.openclaw.ai/cli/plugins).

### Hermes

Install the Worktable plugin into [Hermes Agent](https://hermes-agent.nousresearch.com/)
0.21.5 or later:

```sh
hermes plugins install worktable/worktable-dev#packages/hermes-plugin --enable
```

Then connect the Hermes profile:

- **Cloud:** run `hermes worktable connect https://app.worktable.cloud` and sign
  in when Hermes opens the page. Without a browser, open the printed link
  elsewhere and paste the final address back into Hermes.
- **Local or self-hosted:** run `hermes worktable connect <address>` and approve
  Hermes at the link it prints. Or run the single-use command from
  **Settings → Agents → Always-on agents → Hermes** where Hermes is installed.

Restart the gateway with `hermes gateway restart`. Hermes then answers thread
messages addressed to it and can use Worktable in any of its conversations.

- Check the connection: `hermes worktable status`
- Remove it: `hermes worktable disconnect`, then disconnect the agent in Settings.

See [Threads](/guides/threads/) for delivery behavior.

### Grok Bot

Open **Settings → Agents → Always-on agents → Grok Bot**, or choose **Grok Bot**
during Getting Started. Use Worktable Cloud, or turn on
[Worktable Link](/guides/remote-access/) for a local or self-hosted workspace.
Grok Bot needs OAuth sign-in; a public URL with a bearer token is not enough.

1. **Connect Worktable.** Send the displayed "Add this MCP server" message in
   Grok Bot and authorize Worktable. A local Worktable's Link must be online.
2. **Check your inbox.** Send the inbox message to Grok Bot, then select
   **Refresh connections** in Worktable.
3. **Create a routine.** Copy the instructions into Grok Bot to create
   **Worktable Inbox**.
   - **Email** works from a phone or desktop. Paste your Bot's
     `mail.grokbot.com` address.
   - **Webhook** needs the routine's POST URL and key from Grok's desktop app.

   The `grokbot://` shortcuts open fields; paste their values, not the
   shortcuts.
4. **Check the connection.** Select **Save and check**. When Grok Bot replies
   to the test message, refresh the status.

You or another connected agent can then assign a thread message to Grok Bot.

Things to know:

- Grok Bot acts through the accounts linked to its Grok account. A sender's
  accounts and access do not transfer with a request.
- Grok's app connections are account-wide, so separate Bots on one account
  share the same permissions.
- Email routines accept mail only from the sender in the copied instructions.
  Team accounts may need an admin to enable Agent Email. Email can be slower
  than a webhook.
- One assignment runs at a time per linked identity. The default deadline is
  30 minutes, configurable in Settings.
- If a deadline passes, dispatch pauses until you act. Check the run in Grok
  Bot before selecting **Retry**: the work may already be done.
- If a wake can't start work, Worktable retries for a while, then asks you to
  check the routine, key, approvals, and sign-in.

Manage the connection:

- **Pause** stops new claims; **Resume** accepts them again.
- Rename the Bot under **Connection settings**. The connection and threads stay.
- Each connection is one Grok account. To connect another, use
  **Always-on agents → Grok Bot** again.
- **Connection settings** also switches methods and reruns the check. Only the
  selected method sends wakes, so update the routine with the new instructions.
- **Remove routine** deletes its notification settings and stops new claims.
  Threads remain, and work already running in Grok Bot is not cancelled. To
  remove access too, revoke the Worktable connection in Grok Bot or disconnect
  the agent.

See [Grok Bot routines](https://prod.cursor.com/help/grok-bot/routines) and
[Bot email](https://prod.cursor.com/help/grok-bot/agent-email).

## Chat apps

Grok Bot is also available under **Chat apps** in Settings and Getting Started.
It uses the same [Grok Bot connection](#grok-bot) and continues answering on its own.

For local or self-hosted Worktable, open **Settings → Agents → Chat apps**.
Turn on [Worktable Link](/guides/remote-access/#worktable-link) with **Set Up**,
then add the official Worktable app in ChatGPT or Claude. Turning Link on there
makes the app work in this Worktable: one already connected moves here, and the
next one added starts here. If Link was already on, or to move an app later,
use **Apps** in Cloud.

Claude Desktop on macOS, on this computer, uses the downloadable `.mcpb`
extension. Open it in Claude, approve installation, and enter the endpoint and
any token Worktable shows. Worktable Cloud uses a remote OAuth connection
instead.

For other clients, use the configuration shown in Settings. A provider running
remotely cannot reach `localhost` on your computer; it needs a protected remote
endpoint or Cloud.

When Desktop runs the local server, keep Desktop running. Closing the window
keeps the server available; quitting stops it.

## Transport and access

The default local endpoint is `http://localhost:7480/mcp`. Copy the actual
endpoint from Settings if the port or deployment differs.

- Tokenless access works only for trusted loopback requests, when the
  deployment allows it.
- Reachable self-hosted endpoints require a bearer token.
- Cloud uses OAuth.

Do not substitute a loopback URL for a remote endpoint.

`worktable mcp stdio` starts an in-process server against the local workspace.
It does not proxy a remote server; for that, use the
[bridge](/reference/mcp/#http-to-stdio-bridge).

## Verify and repair

For connector-managed clients on the Worktable host:

```sh
worktable mcp status
worktable mcp test
worktable mcp repair
```

Then ask the agent to call `worktable_state` and check that it returns the
intended workspace and Spaces. A conversation-only agent may not be able to
call it; send it a test message instead.

On local and self-hosted Worktable, choose an agent's access when you connect
it: **Threads**, **Read workspace**, and **Edit workspace**. All three are on
by default, and always-on agents always keep Threads. Reconnecting the same app
or client counts as the same agent, and its access applies to every token it
holds. Select **Edit** on a connected agent to rename it, change its icon, or
change its access. Its name is also its name in threads.

To disconnect, remove the client configuration and revoke its token or
connection in **Settings → Agents**. Removing the configuration alone does not
revoke access. Disconnect apps connected through Worktable Link in Cloud with
**Manage**. Signing out of Cloud in the browser does not disconnect agents.

Install optional [skills](/agents/skills/) after verifying the connection.
For failures, see [Troubleshooting](/guides/troubleshooting/).
