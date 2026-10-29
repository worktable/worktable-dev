---
title: Desktop
description: Install the macOS app and open a local, self-hosted, or Cloud workspace.
---

Worktable Desktop runs on Apple Silicon Macs with macOS 13 or newer. The app is signed and notarized.

<a href="https://www.worktable.dev/releases/latest/worktable-desktop-darwin-arm64.dmg" data-public-analytics-cta="macos_download" data-public-analytics-placement="docs_start">Download for macOS</a>, open the DMG, and move Worktable to Applications.
For Linux or a terminal install, use the
<a href="/start/install/" data-public-analytics-cta="install_guide_open" data-public-analytics-placement="docs_start">CLI installer</a>.
The source is in the
[public repository](https://github.com/worktable/worktable-dev/tree/main/apps/desktop).

## Choose a connection

On first launch, Desktop asks where your Worktable runs:

- **This Mac:** create a workspace, open a workspace folder, or use a local CLI
  installation. Desktop and the CLI share the same workspace and service.
- **Self-hosted server:** enter the server origin, such as
  `https://worktable.example.com`, then sign in with the owner password. Use
  HTTPS; plain HTTP requires you to acknowledge a warning.
- **Worktable Cloud:** choose **Sign in** and finish in your browser. Desktop
  opens your first Worktable and remembers the last one you used.

Desktop does not store a self-hosted password. Cloud credentials stay in macOS
Keychain.

## Switch or remove a connection

The Worktable menu at the top of the sidebar lists every Worktable you can
reach:

- **On this Mac:** local Worktables. **Link** marks one with Worktable Link on.
- **Other devices:** Worktables you linked on other computers, when signed in
  to Cloud. They open in your browser while their device is online. One with
  only a local address, such as `localhost`, opens only on its own device.
- **Worktable Cloud:** hosted Worktables.
- **New Worktable** and **Open Folder** add another.

On a self-hosted server's page, **Switch Worktable** opens the connection
chooser.

Each Worktable has its own agent endpoint. When you open a local Worktable
other than the one agents on this Mac use, a notice offers to switch them.
**Switch them to** moves the CLI, the background service, and `worktable mcp`
to it. Update any agent app connected directly to the previous endpoint.

- **Change Connection…** returns to the connection chooser and keeps a saved
  self-hosted session.
- **Forget this server** removes its saved profile and session cookie. The
  server's workspace is untouched.
- **Sign Out of Worktable Cloud** removes the Cloud credential but remembers
  the workspace for your next sign-in.
- Removing a Cloud connection clears its Keychain credential and saved profile.
  The hosted workspace is not deleted.

## Close or quit

Closing the window hides it. Desktop and any local host it owns keep running,
so agents stay connected. Reopen it from the Dock or with **Window →
Worktable**.

**Worktable → Quit Worktable** stops the app and every local host it owns. A
CLI service that Desktop only attached to keeps running.

## Connect an agent

Open **Settings → Agents**. It covers coding agents, OpenClaw, Claude, ChatGPT,
and manual MCP configuration. See [Connections](/start/connect-your-agent/).

For a local workspace, the same page installs the official skills into the
Claude or standard Agent Skills folder. It previews changes and reports
missing, outdated, or changed files. Installing skills and connecting the agent
are separate steps; see [Skills](/agents/skills/).

For credentials, persistence, and recovery, see the
[Desktop reference](/reference/desktop/).
