---
title: Desktop
description: Install the macOS app and open a local, self-hosted, or Cloud workspace.
---

Worktable Desktop runs on Apple Silicon Macs with macOS 13 or newer. The app is
signed and notarized.

<a href="https://www.worktable.dev/releases/latest/worktable-desktop-darwin-arm64.dmg" data-public-analytics-cta="macos_download" data-public-analytics-placement="docs_start">Download for macOS</a>, open the DMG, and move Worktable to Applications.
For Linux or a terminal-based installation, use the
<a href="/start/install/" data-public-analytics-cta="install_guide_open" data-public-analytics-placement="docs_start">CLI installer</a>.

Desktop source is available in the
[public repository](https://github.com/worktable/worktable-dev/tree/main/apps/desktop).

## Choose a connection

Desktop asks where your Worktable runs on first launch.

- **This Mac:** create a workspace, open an existing workspace folder, or use a
  valid local CLI installation. Desktop and the CLI share the same local
  workspace and service.
- **Self-hosted server:** enter the server origin, such as
  `https://worktable.example.com`, then sign in on its owner-password page.
  HTTPS is strongly recommended. Plain HTTP requires an explicit warning
  acknowledgement.
- **Worktable Cloud:** choose **Sign in**. Desktop opens the system browser for
  authentication and then opens your hosted workspace in the native window.

Desktop remembers saved workspaces and servers. It does not store a
self-hosted password. Cloud credentials remain in macOS Keychain rather than
being exposed to the workspace view.

For a local workspace, **Settings → Agents** also manages the official skills
in the Claude or standard Agent Skills folder. It previews changes and reports
missing, outdated, locally changed, or conflicting files. Installing skills and
connecting the agent are separate steps; see [Skills](/agents/skills/).

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

## Close or quit

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
[Connections](/start/connect-your-agent/) for the setup choices.

For system requirements, credential boundaries, connection persistence, and
recovery behavior, see the [Desktop reference](/reference/desktop/).
