---
title: MCP reference
description: Endpoints, transports, authentication, supported clients, and diagnostics.
---

Worktable registers its tools once and exposes the same workspace over
Streamable HTTP and stdio. The tools are listed in the
[MCP tool catalog](/reference/mcp-tools/).

Every successful object result is returned as MCP `structuredContent` together
with the JSON text fallback used by older clients. Tool descriptors include a
human-readable title, explicit safety annotations, and OAuth authentication
metadata. Worktable permissions are enforced server-side after authentication.

## Discovery and optional skills

The initialize response states only that Worktable stores private Docs, HTML
Docs, Records, annotations, and threads. Tool descriptions explain their own
functions without prescribing cross-tool workflows or loading external
behavioral instructions.

`worktable_guidance` exposes the immutable `format_spec` action required to
serialize Worktable content. `worktable_html_read` action `guide` exposes the
HTML sandbox, bridge, permission, theme, and runtime contract. The former
skill-list and skill-read actions are retired. Workspace Docs under `skills/`
can still be searched and read through the ordinary Doc tools, but MCP never
promotes them to instructions.

`worktable_documents_read` lists Docs, HTML Docs, and other registered document
formats, then reads supported formats through one bounded text projection. It
can also return the exact source and version history for formats that support
those operations. It requires `documents:read`; the specialized Doc and HTML
Doc tools remain available for format-specific operations.

`worktable_documents_write` performs operations that span registered document
formats. It can create, replace, checkpoint, restore a version, move, archive,
or restore a document when that format supports the requested operation. Its
folder actions apply to a folder containing Docs, HTML Docs, or both as one
change. If any document format does not support an operation, the action fails
before changing it. It requires `documents:write`; the specialized write tools
remain available for format-specific changes.
Archiving a folder revokes its documents' share links. Restoring the folder
does not reactivate those links.

Permanent folder deletion stays on the destructive `worktable_delete` tool.
Its `document` action deletes one registered document, while `document_folder`
permanently deletes a folder containing Docs, HTML Docs, or both as one
all-or-nothing change. Both require `documents:write`. If any document format
does not support deletion, the action fails before removing anything. One
folder deletion can contain up to 128 documents, and it revokes their share
links.

With `documents:read`, the `search` action in `worktable_discover` searches
Docs, HTML Docs, and other registered document formats, returning safe text
where available. Unknown formats and conflicting paths appear as metadata-only
results and do not open in another document view. Clients without
`documents:read` retain the earlier Docs and Records search results.

Clients with Agent Skills support can install the optional provider-neutral
Worktable suite for higher-level workflow judgment. Skills are not required for
MCP operation and do not replace server-side authentication, authorization,
validation, path boundaries, or destructive-operation separation.

## ChatGPT Company Knowledge

The hosted MCP server exposes the exact read-only pair ChatGPT uses for Company
Knowledge:

- `search` searches non-archived Worktable documents and Records and returns
  opaque IDs, titles, and absolute user-openable Worktable URLs.
- `fetch` accepts one returned ID and provides a safe text representation,
  title, and URL without Worktable file metadata.

`search` requires `search:read` and includes all registered documents when the
connection also has `documents:read`. After decoding the selected result,
`fetch` checks `documents:read`, `docs:read`, or `records:read` as appropriate.
The normal `worktable_*` tools remain available alongside this pair for richer
reads, writes, interactive HTML Docs, annotations, and thread collaboration.

## Streamable HTTP

```text
http://localhost:7480/mcp
```

Worktable Cloud uses the hosted origin's canonical `/api/mcp` endpoint. Always
copy the endpoint or generated configuration from **Settings → Agents** rather
than adapting a localhost example.

Use HTTP for Claude Code, ChatGPT / Codex, Cursor, OpenCode, VS Code, Goose, and
other provider clients that support a Streamable HTTP MCP server. Worktable's
connector and **Settings → Agents** render the endpoint appropriate to the
current install.

## stdio

The existing in-process Worktable stdio server is:

```json
{
  "command": "worktable",
  "args": ["mcp", "stdio"]
}
```

`worktable --mcp` is an equivalent hidden spawn form retained for compatibility.

Claude Desktop uses a different stdio shape: its MCPB launches a bundled bridge
that proxies the configured Worktable HTTP endpoint. This keeps one server tool
registry while satisfying Claude's local-extension runtime. The bridge refuses
cross-origin redirects and currently accepts only Worktable's tools capability.

## Authentication

A bare request to a literal same-machine loopback endpoint can act as the local
owner when deployment policy does not require authentication. Minting a scoped
agent token does not disable that path: tokenless local clients and identified
token-bearing clients can coexist. A presented invalid or revoked bearer always
returns 401 rather than falling back to local trust.

MCP requires a bearer when any of these applies:

- Worktable binds a non-loopback interface or reachable mode is enabled.
- A public workspace URL fronts the server through a tunnel or reverse proxy.
- `WORKTABLE_MCP_TOKEN` explicitly sets a deployment credential.
- An authorization server supplies the install's identity contract.

Loopback trust is limited to literal `127.0.0.1`, `localhost`, and `::1` request
hosts. Cross-site browser requests and DNS-derived hosts do not inherit it.
On Worktable Cloud, each OAuth-connected MCP client keeps its own stable agent
identity, so activity from different apps remains separately attributed.
**Settings → Agents** also shows newly authorized OAuth apps before their first
MCP call, updates their last-used time as they connect, and lets you disconnect
them without handling a token.

The Cloud quick-connect command detects supported clients and configures the
canonical `/api/mcp` URL. Open or restart the client and complete OAuth to
verify the connection.

OpenClaw uses WorkOS Agent Registration instead of a static Cloud token. Follow
the claim flow once for each installation. Its default access is limited to
conversations, and you can disconnect it later from **Settings → Agents**.

## Supported clients and setup kinds

Support maturity and configuration method are separate:

| Client ID        | Product                                            | Setup                                                   |
| ---------------- | -------------------------------------------------- | ------------------------------------------------------- |
| `claude-code`    | Claude Code                                        | Connector-installable                                   |
| `codex`          | ChatGPT desktop, Codex CLI, Codex IDE              | Connector-installable or provider-native Settings       |
| `cursor`         | Cursor                                             | Connector-installable                                   |
| `opencode`       | OpenCode                                           | Connector-installable                                   |
| `vscode`         | VS Code                                            | Connector-installable                                   |
| `goose`          | Goose                                              | Manual snippet                                          |
| `claude-desktop` | Claude Desktop and supported local Cowork releases | Desktop extension or Cloud OAuth                        |
| `openclaw`       | OpenClaw                                           | ClawHub plugin plus local pairing or Cloud registration |

`worktable mcp setup`, detection, status, repair, removal, and pairing accept
only connector-installable IDs. `worktable mcp print-config goose` produces the
manual Goose configuration. Claude Desktop is installed from the MCPB in
**Settings → Agents → Desktop apps**; Worktable does not emit a fake CLI snippet
for it.

OpenClaw is not accepted by `worktable mcp setup`. Install its Worktable plugin
from ClawHub, then use the pairing command shown by a local/self-hosted
Worktable or the Cloud agent-registration flow. Its default Cloud scope is
conversation-only.

## HTTP-to-stdio bridge contract

The normal Worktable binary also carries the shared machine-facing bridge:

```text
worktable mcp bridge [--url <mcp-url>] [--token-env <name>]
```

The command is hidden from interactive help because provider packages invoke it.
`--url` falls back to `WORKTABLE_MCP_URL`; `--token-env` defaults to
`WORKTABLE_MCP_TOKEN`. Raw bearer values are never accepted as arguments. This
bridge does not replace `mcp stdio` or `--mcp`.

## Claude extension download

Compatible local and self-hosted installs serve their matching macOS extension
from `/integrations/claude-desktop.mcpb`. The artifact is secret-free and the
route is intentionally unauthenticated. Worktable Cloud disables this download
and uses OAuth. Extension upgrades are installed manually.

## Diagnostics

```sh
worktable mcp status    # connector-installable client state
worktable mcp test      # whether the endpoint is answering
worktable mcp repair    # re-apply connected client configuration
```

Desktop-local endpoints are available only while Worktable Desktop is running.
Closing its window keeps it running; quitting Worktable stops it. Revoking a
token requires replacing it in the provider that stored it. Switching
Desktop workspaces changes the selected endpoint, so update Claude or ChatGPT to
the endpoint shown for the new workspace.
