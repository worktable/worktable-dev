---
title: Worktable Desktop
description: Install the native macOS app and open a local, self-hosted, or Worktable Cloud workspace.
---

Worktable Desktop is the native macOS home for Worktable. The signed and
notarized app supports Apple Silicon Macs running macOS 13 or newer.

<a href="https://worktable.dev/releases/latest/worktable-desktop-darwin-arm64.dmg" data-public-analytics-cta="macos_download" data-public-analytics-placement="docs_start">Download the latest DMG</a>,
open it, and move Worktable to Applications. Intel Macs and Linux can use the
[command-line install](/start/install/).

## Choose a connection

Desktop asks where your Worktable runs on first launch.

- **This Mac:** create a workspace, open an existing workspace folder, or use a
  valid local CLI installation. Desktop and the CLI share the same local
  workspace authority rather than starting competing servers.
- **Self-hosted server:** enter the server origin, such as
  `https://worktable.example.com`, then sign in on its owner-password page.
  HTTPS is strongly recommended. Plain HTTP requires an explicit warning
  acknowledgement.
- **Worktable Cloud:** choose **Sign in**. Desktop opens the system browser for
  authentication and then opens your hosted workspace in the native window.

Desktop remembers saved workspaces and servers. It does not store a
self-hosted password. Cloud credentials remain in macOS Keychain rather than
being exposed to the workspace view.

For an open local workspace, use **Settings → Agents** to manage the official
Worktable skills in either the Claude skills folder or the standard Agent
Skills folder. Desktop previews each filesystem change before applying it, and
this consent remains separate from connecting an agent to Worktable over MCP.
Worktable reports missing, outdated, locally changed, and conflicting skills
without overwriting files it cannot prove it owns.

## Switch or remove a connection

Use the Worktable application menu to change the selected workspace or server.
Returning to the same local workspace restores its stable agent endpoint.
Switching workspaces selects a different endpoint, so update an agent app that
was connected directly to the previous one.

- **Change Connection…** keeps a saved self-hosted session while returning to
  the connection chooser.
- **Forget this server** removes its saved Desktop profile and session cookie
  without touching the remote workspace.
- **Sign Out of Worktable Cloud** removes this Desktop installation's Cloud
  credential while remembering the workspace for a later sign-in.
- Removing a Cloud connection clears its Keychain credential and remembered
  profile without deleting the hosted workspace.

## Close versus quit

Closing the window with the red control or **File → Close Window** hides it.
Desktop and a local host it owns keep running, so agent connections stay
available. Reopen it from the Dock, by launching Worktable again, or with
**Window → Worktable**.

Use **Worktable → Quit Worktable** to stop the app. Quitting also stops a local
host owned by Desktop. A managed CLI service that Desktop only attached to
continues running.

## Connect an agent

Open **Settings → Agents** in the workspace. The same page supports coding
agents, OpenClaw, Claude, ChatGPT, and manual MCP configuration. See
[Connect your agent](/start/connect-your-agent/) for the setup choices.

For system requirements, credential boundaries, connection persistence, and
recovery behavior, see the [Desktop reference](/reference/desktop/).
