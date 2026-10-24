---
title: Remote access
description: Reach a local or self-hosted workspace from another device or agent.
---

Worktable is available only on its own machine by default. Reachable mode lets
you use a self-hosted workspace from another device or connect an agent running
elsewhere.

## Turn it on

```sh
worktable setup --reachable
```

Setup asks you to create an owner password, protects agent connections, and
points you to the remote-agent flow. Worktable will not start in reachable mode
without the owner password.

## Add HTTPS

Worktable serves HTTP itself. Put HTTPS in front with Tailscale, Cloudflare
Tunnel, ngrok, or another reverse proxy, then acknowledge that setup:

```sh
worktable setup --reachable --behind-tls
```

If the tunnel gives Worktable a stable address, set it under
**Settings → General → Workspace URL** so links point to that address. Set the
owner password before saving a public address. Worktable Cloud manages its own
address and does not show this setting.

## Connect Worktable Desktop

Prefer a valid HTTPS address such as `https://worktable.example.com`.

1. In Desktop, choose **Self-hosted server**.
2. Enter the server address without a path or query.
3. If you use plain HTTP, acknowledge the warning. HTTPS is strongly
   recommended.
4. Sign in with your named account when Teams is enabled, or the Worktable
   owner password for a one-person workspace.

Desktop remembers the server but does not save the owner password. Use
**Change Connection…** to keep the saved server available, or **Forget this
server** to remove it from Desktop without changing the remote workspace.
Desktop does not create the tunnel or configure the server for you. See the
[Desktop reference](/reference/desktop/) for connection validation and storage
details.

## Invite teammates

Enable Teams from **Settings → Team**, then copy an invitation link for each
member. Choose a starting Space to open it for them when they join. Everyone
uses a named account. Existing Spaces remain restricted until
you share them; newly created Spaces are shared by default. The
[security model](/reference/security/) explains owners and restricted Spaces.

If Worktable Link was already connected, enabling Teams pauses it. In
**Settings → Cloud**, turn Link on again to connect your Cloud account to your
named member account.

## Connect a remote agent

Open **Settings → Agents** and choose **Connect an agent**, or create a pairing
from the Worktable host:

For Teams, use Settings so the connection belongs to the member who approves
it. The CLI commands below apply to one-person Worktables.

```sh
worktable agent invite
```

Run the one-line command it prints on the machine where the agent lives. The
single-use pairing expires after 15 minutes, preserves existing Worktable
client entries, and verifies the connection when it finishes.

For a machine where the guided command is not suitable, use **Manual install**
in Settings or print the client configuration from the Worktable host:

```sh
worktable mcp print-config <client> --with-token
```

This command prints a credential. Copy it directly into the client and keep it
out of shared documents, URLs, and command logs.

## Manage access

**Settings → Agents** lists connected agents, when they last used Worktable,
and a disconnect action. **Advanced → Access tokens** lists manually created
credentials as well. Disconnect or revoke a connection when it should no
longer have access.

Claude Desktop and ChatGPT use the **Desktop apps** section. The self-hosted
address must be reachable from the Mac or service running the app. A browser on
another device signs in with the owner password.

## Return to loopback

Run `worktable setup` again and choose loopback. Previously created agent
connections remain listed, so revoke any you no longer want to use.

The [security model](/reference/security/) explains the password, token, and
HTTPS boundaries in detail.

## Worktable Link

Where available for your Cloud account, Worktable Link connects a local or
self-hosted installation to supported AI apps and public document sharing.
Check **Settings → Remote Access** for availability and the device limit.
A remote self-hosted installation needs an HTTPS address.

1. Choose **Sign in** in **Settings → Remote Access**. Complete browser
   sign-in and confirm the server address when prompted.
2. Return to Settings, choose a payer-owned **Worktable subscription**, and turn
   on **Worktable Link**. Sign-in alone does not
   enable remote access. Complete subscription setup if requested.
3. In ChatGPT or Claude, add the official Worktable app after Link is on; an
   app added first is bound to another Worktable. For another AI app, open
   **Connect another app**, copy the device's **MCP URL** into its connector
   setup and choose OAuth authentication.
4. Sign in with the same Cloud account and approve the connection.

Keep the device online and Worktable running. Worktable Desktop keeps a
Worktable with Link on running while its window shows another Worktable, until
you quit Desktop. Authorized requests pass through Cloud to the device; Link
does not copy its workspace into the hosted workspace, synchronize the two, or
expose the full local interface remotely.
Each device follows its selected subscription: Solo links one device, Team
three and Business five. **Your Worktables** in Cloud lists each linked Worktable
with its device and whether it is online. On a team installation, an operator enables Link and its
AI apps follow that member's Space permissions as personal agents.

Turn off **Worktable Link** to pause AI access and public sharing. Turning it on
again restores the same MCP URL, share links, and approved connections. You can
also pause, resume, or disconnect individual apps under **Manage devices**.

**Unlink** ends that device's access. Linking the same Worktable again restores
its MCP URL and the AI apps approved for it, so disconnect any app you don't want
back before you unlink. Replacing the local workspace also requires linking again. Signing out of Cloud
in local Settings does not unlink the device; pause or unlink it to stop access.
