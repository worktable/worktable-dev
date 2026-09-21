---
title: Desktop reference
description: Supported platform, connection providers, lifecycle, updates, and local data boundaries.
---

Worktable Desktop is the native macOS shell for local, self-hosted, and Cloud
Worktable connections. It does not introduce a separate workspace format.

## Requirements and distribution

- Apple silicon Mac running macOS 13 or later.
- Distributed as a signed and notarized DMG.
- In-app updates are signed and install only after you choose **Download and
  Restart**. **Help → Check for Updates…** checks immediately.

## Connection providers

| Provider           | What Desktop does                                    | Authentication                     |
| ------------------ | ---------------------------------------------------- | ---------------------------------- |
| This Mac           | Opens a local workspace, starting a host when needed | Local owner trust or owner sign-in |
| Self-hosted server | Connects to one canonical server origin              | Server owner-password session      |
| Worktable Cloud    | Connects to the hosted workspace                     | System-browser sign-in             |

An unexposed local host uses implicit local-owner access. If Desktop attaches
to a protected CLI-managed service, it keeps that service's owner sign-in
requirement.

Self-hosted origins must not include a path or query. HTTPS uses normal macOS
certificate and hostname validation with no bypass. Plain HTTP requires an
explicit warning acknowledgement and should be limited to trusted networks.
Desktop rejects redirects, incompatible servers, Cloud servers entered through
the self-hosted provider, and a different workspace later appearing at the
same saved origin.

**Change Connection…** retains saved profiles and their origin-scoped sessions.
**Forget this server** removes that profile and its Worktable session cookie; it
does not change or delete anything on the server.

## Window and process lifecycle

Closing the window leaves Desktop running so its local host and agent endpoint
remain available. Choosing **Quit Worktable** stops the Desktop-owned host. A
self-hosted service or CLI-managed local service that Desktop merely connects
to is not owned or stopped by Desktop.

## Data boundaries

The selected workspace's portable content follows the normal
[workspace file contract](/reference/workspace-files/). Desktop also keeps
machine-local connection profiles, WebKit session data, logs, update state, and
local-host runtime data. Those files are not part of workspace exports.

Desktop stores a self-hosted origin, display name, and portable workspace
identity, but not the owner's password. Cloud tokens and browser sessions use
the operating system and WebKit storage appropriate to their provider. Agent
credentials remain separate from Desktop connection profiles.
