# Configuration

Worktable reads a few environment variables. All are optional — the defaults give you a working local app.

| Variable | Purpose | Default |
|---|---|---|
| `PORT` | Server port | `7432` |
| `WORKTABLE_WORKSPACE` | Workspace root folder | `~/.worktable` |
| `WORKTABLE_APP_DIR` | Machine-private app data folder (releases, credentials) | macOS Application Support, otherwise `~/.config/worktable` |
| `WORKTABLE_STATIC_DIR` | Packaged web asset directory override | release or source build assets |
| `WORKTABLE_MCP_TOKEN` | Bearer token required on `/mcp` (off if unset) | — |

For example, to run on a different port against a project-specific workspace:

```sh
PORT=8000 WORKTABLE_WORKSPACE=~/projects/launch/.worktable worktable
```

## Running on a machine you control

Worktable runs as a single-user local server. You can run it on a machine you control (a home server, a VPS) so a workspace stays available while your laptop sleeps — but mind the security posture first.

> **Scope note:** the REST API under `/api/*` currently has no authentication, and the server binds like a local app. Run Worktable on `localhost` or behind your own network boundary (VPN, reverse proxy with auth, SSH tunnel). A minimal token layer for non-localhost deployments is on the roadmap.

Practical guidance when exposing it beyond your own machine:

- **Put it behind something.** Terminate TLS and require auth at a reverse proxy, or keep it on a private network (Tailscale, WireGuard, an SSH tunnel).
- **Set a token for MCP.** `WORKTABLE_MCP_TOKEN=...` requires a matching bearer token on the `/mcp` endpoint, so a networked agent can't connect unauthenticated.
- **Keep the workspace portable.** Point `WORKTABLE_WORKSPACE` at a folder you back up or sync; credentials stay in `WORKTABLE_APP_DIR`, never in the workspace.

## Related

- [CLI reference](cli.md) — flags accepted by the `worktable` command and the installer.
- [Connect your agent](connect-your-agent.md) — token setup for the MCP endpoint.
