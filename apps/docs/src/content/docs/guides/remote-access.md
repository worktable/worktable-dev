---
title: Remote access
description: Reach a local or self-hosted workspace from another device or agent.
---

By default Worktable is only available on its own machine. Reachable mode lets
other devices and remote agents use a self-hosted workspace.

## Turn it on

```sh
worktable setup --reachable
```

Setup asks you to create an owner password. Worktable will not start in
reachable mode without it.

## Add HTTPS

Worktable serves plain HTTP. Put HTTPS in front with Tailscale, Cloudflare
Tunnel, ngrok or another reverse proxy, then run:

```sh
worktable setup --reachable --behind-tls
```

If the tunnel has a stable address, set it in
**Settings → General → Workspace URL** so links use it. Set the owner password
before saving a public address. Worktable Cloud manages its own address.

## Connect Worktable Desktop

1. In Desktop, choose **Self-hosted server**.
2. Enter the server address without a path or query, for example
   `https://worktable.example.com`.
3. If you use plain HTTP, acknowledge the warning. HTTPS is strongly
   recommended.
4. Sign in with your named account when Teams is on, or with the owner
   password.

Desktop remembers the server but not the owner password. **Forget this server**
removes it from Desktop without changing the workspace. Desktop does not create
the tunnel for you. See the [Desktop reference](/reference/desktop/).

## Invite teammates

Enable Teams in **Settings → Team**, then copy an invitation link for each
member. You can pick a starting Space for them. Existing Spaces stay restricted
until you share them; new Spaces are shared by default. See the
[security model](/reference/security/).

Enabling Teams pauses Worktable Link. Turn it on again in **Settings → Remote**
to connect your Cloud account to your member account.

## Connect a remote agent

Open **Settings → Agents** and choose **Connect an agent**. On a Teams
Worktable, always use Settings so the connection belongs to the member who
approves it.

On a one-person Worktable you can also create a pairing on the host:

```sh
worktable agent invite
```

Run the printed command on the agent's machine. The pairing is single-use,
expires after 15 minutes and keeps existing client entries.

If the guided command doesn't fit, use **Manual install** in Settings or print
the client configuration on the host:

```sh
worktable mcp print-config <client> --with-token
```

This prints a credential. Paste it straight into the client and keep it out of
shared documents, URLs and command logs.

## Manage access

**Settings → Agents** lists connected agents, when they last used Worktable,
and a disconnect action. **Advanced → Access tokens** lists manually created
credentials. Disconnect or revoke anything that should no longer have access.

Claude Desktop and ChatGPT use the **Desktop apps** section. The self-hosted
address must be reachable from the Mac or service running the app.

## Return to loopback

Run `worktable setup` again and choose loopback. Existing agent connections
stay listed, so revoke any you no longer want.

## Worktable Link

Worktable Link connects a local or self-hosted installation to supported AI
apps and public sharing through your Cloud account. Check **Settings → Remote**
for availability. A remote self-hosted installation needs an HTTPS address.

1. Choose **Sign in** in **Settings → Remote** and complete browser sign-in.
2. Choose a payer-owned **Worktable subscription** and turn on
   **Worktable Link**. Signing in alone does not enable access.
3. For ChatGPT or Claude, choose **Set Up** in that app's steps in
   **Settings → Agents → Chat apps**, then add the official Worktable app. To
   move an app later, or if Link was already on, use **Apps** in Cloud. For
   another AI app, open **Connect another app**, copy the device's
   **MCP URL** into its connector setup and choose OAuth.
4. Sign in with the same Cloud account and approve the connection.

Keep the device online and Worktable running. Desktop keeps a linked Worktable
running in the background until you quit. Link passes authorized requests
through Cloud to the device. It does not copy or sync the workspace to Cloud,
or expose the full local interface.

- Each subscription links a set number of devices: Solo one, Team three,
  Business five. Unlink one in Cloud to connect another.
- **Your Worktables** and the Worktable menu show each linked Worktable, its
  device and whether it is online.
- On a team installation, an operator turns on Link, and AI apps follow that
  member's Space permissions.

Turn off **Worktable Link** to pause AI access and public sharing. Turning it
on again restores the same MCP URL, share links and approved connections.
**Manage devices** pauses, resumes or disconnects individual apps. Linked apps
also appear under **Connected agents** in **Settings → Agents**.

**Unlink** ends the device's access. Linking the same Worktable again restores
its MCP URL and approved AI apps, so disconnect any app you don't want back
first. Replacing the local workspace requires linking again. Signing out of
Cloud does not unlink the device; pause or unlink it to stop access.
