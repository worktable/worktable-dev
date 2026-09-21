---
title: Configuration
description: Every user-facing environment variable and reachability flag.
---

Most installs never touch any of this — setup asks the questions that matter. This page is the reference for when you need to steer.

These environment variables and the Workspace URL control apply to local and self-hosted Worktable installs. Worktable Cloud manages its address and storage configuration for you.

## Environment variables

| Variable | Purpose | Default |
| --- | --- | --- |
| `PORT` | Server port | `7480` |
| `HOST` | Bind interface (`127.0.0.1` loopback; non-loopback implies reachable) | `127.0.0.1` |
| `WORKTABLE_WORKSPACE` | Workspace root folder | `~/Worktable` |
| `WORKTABLE_APP_DIR` | Machine-private app data folder | macOS Application Support, or `~/.config/worktable` |
| `WORKTABLE_MCP_TOKEN` | Bearer token required on `/mcp` (off if unset) | unset |
| `WORKTABLE_OWNER_PASSWORD` | Owner password for reachable mode, set non-interactively | unset |
| `WORKTABLE_NO_UPDATE_CHECK` | Disable update checks — `status`, `update --check`, and the CLI's and web app's passive update nudges | unset |
| `WORKTABLE_PUBLIC_URL` | The origin agents and links should use when a tunnel or reverse proxy fronts a local or self-hosted install (an absolute `http(s)://host` origin, no path). Requires an owner password, same as reachable mode. Same setting as Settings → General → Workspace URL in the web app; the env var wins when both are set | unset |

One that looks settable but isn't: `WORKTABLE_REQUIRE_AUTH` is derived from the effective bind host — loopback off, non-loopback on. Never set it by hand.

The [installer has its own overrides](/reference/installer/) (`WORKTABLE_INSTALL_DIR`, `WORKTABLE_APP_DIR`, `WORKTABLE_VERSION`, `WORKTABLE_RELEASE_BASE_URL`).

## Reachability flags

On `worktable setup` and `worktable launch`:

| Flag | What it does |
| --- | --- |
| `--reachable` | Bind all interfaces so other machines can connect. The web app goes behind an owner password, MCP behind a bearer token. |
| `--owner-password <pw>` | Set the owner password non-interactively (or use `WORKTABLE_OWNER_PASSWORD`). Required to bind non-loopback. |
| `--behind-tls` | You front Worktable with HTTPS (a tunnel or proxy); suppresses the plain-HTTP reminder. The reminder only — not auth. |
| `-H, --host <host>` | Explicit bind host. A non-loopback host implies reachable. |

The walkthrough is in [Reach Worktable from another machine](/guides/remote-access/); the model behind it is in [Security](/reference/security/).
