---
title: Troubleshooting
description: Failure modes and the command that names each one.
---

Almost every problem below starts with the same move:

```sh
worktable doctor
```

`doctor` reports the executable, packaged web assets, workspace path, app-private path, and MCP setup — and `worktable status` shows the live server, service, and agent state.

## Worktable does not open

Run `worktable doctor`. Check that the server is listening on the expected port and that packaged web assets are present. If Worktable runs as a background service, check it directly:

```sh
worktable service status
worktable service logs -n 100
```

## The port is already in use

Something else owns `7480`. Interactive setup offers the next free port; non-interactive runs pick one automatically and say so. To choose explicitly:

```sh
worktable launch --port 7481
```

## `worktable` is not on my PATH

The installer places the launcher in its install directory without editing shell profiles. Open a new terminal first. If it still isn't found, re-run the installer and note the printed install path, or pass `--install-dir` to put the launcher somewhere already on your PATH.

## My agent cannot connect

Let the CLI name the problem:

```sh
worktable mcp status   # per-client state: configured, drifted, or missing
worktable mcp test     # is the endpoint answering right now
worktable mcp repair   # re-apply the right config for connected clients
```

The local endpoint is `http://localhost:7480/mcp`. On a default loopback install no token is needed; if you set `WORKTABLE_MCP_TOKEN`, the client must send the same bearer token.

For Desktop's **This Mac** provider, closing the window is fine but quitting
Worktable stops the endpoint. For self-hosted or Cloud connections, copy the
current configuration from **Settings → Agents**; do not substitute the
localhost URL. A Cloud client normally opens its OAuth approval in the browser.

For OpenClaw, inspect the plugin runtime first:

```sh
openclaw plugins inspect worktable --runtime --json
```

Then repeat the pairing command shown by a local/self-hosted workspace or the
Cloud agent-registration flow. OpenClaw is not configured by
`worktable mcp setup`.

## "Reachable install requires a bearer token"

`worktable mcp status` shows this when the install is reachable from other machines but a client config predates the token. The fix is the one the message names:

```sh
worktable mcp setup
```

It injects the token into your same-machine client configs.

## "Invalid Codex config"

`worktable mcp status` shows this when Codex's `config.toml` has a syntax error, most often a leftover duplicate `mcp_servers.worktable` table from an older config. Fix it with:

```sh
worktable mcp repair
```

It replaces Worktable's whole table in `config.toml` rather than editing around the broken part.

## The background service will not start

```sh
worktable service logs -f
```

streams the service log. `worktable service restart` after fixing the cause. On platforms without service support, run in the foreground: `worktable launch --foreground`.

## My client wants stdio, not HTTP

Both work against the same server. For clients that spawn MCP servers as subprocesses:

```json
{
  "mcpServers": {
    "worktable": { "command": "worktable", "args": ["mcp", "stdio"] }
  }
}
```

`worktable mcp print-config <client>` prints the right shape per client.

## I cannot find my files

The default local workspace folder is `~/Worktable`. If you chose a custom
folder during setup, `worktable doctor` prints the active workspace path.
Worktable Cloud manages its live storage; use **Settings → Import & Export** to
download the portable `.wtb` workspace.

## A workspace import fails

Keep the source `.wtb` package and read the validation message before retrying.
Worktable rejects unsupported manifests, unsafe paths, integrity failures, and
archives over the published limits. Import replaces the destination snapshot;
it does not merge two independently edited workspaces. See
[workspace packages](/reference/workspace-packages/).
