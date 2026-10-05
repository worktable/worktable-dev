---
title: MCP
description: Endpoints, transports, authentication, supported clients, and diagnostics.
---

Worktable uses the same tool registry for Streamable HTTP and local stdio. The tools are listed in the
[MCP tool catalog](/reference/mcp-tools/).

Every successful object result is returned as MCP `structuredContent` together
with the JSON text fallback used by older clients. Tool descriptors include a
human-readable title, explicit safety annotations, and OAuth authentication
metadata. Worktable permissions are enforced server-side after authentication.
A refused action names the missing scope. Grant broader access only if the
requested task needs it.

## Content operations

The initialize response identifies the workspace content and tool surface.
Tool schemas define supported arguments, and descriptions provide usage guidance.
Optional skills supply broader workflows.

`worktable_guidance` exposes the `format_spec` action used to
serialize Worktable content. `worktable_html_read` action `guide` exposes the
HTML sandbox, bridge, permission, theme, and runtime contract. The former
skill-list and skill-read actions are retired. Workspace Docs under `skills/`
can still be searched and read through the ordinary Doc tools, but MCP never
promotes them to instructions.

`worktable_documents_read` lists Docs, HTML Docs, and other registered document
formats, then reads supported formats through one bounded text projection. It
can also return the exact source and version history for formats that support
those operations. Its `list` action filters by folder (`pathPrefix`), path
`glob`, format, and lifetime. In a glob, `*` and `?` match within one folder
and a `**` segment spans folders, matched against the extensionless path.
Action `diff` returns a unified line diff of a Doc's Markdown or an HTML Doc's
source between two points in its history. Each point is a revision returned
by an earlier read or write (a `sourceRevision`, or the Doc `revision` that
`worktable_docs_read` returns), or a version id from action `versions`. The
later point defaults to the current source, reported in the same revision
scheme as the earlier one. A revision that is no longer in
the retained history returns an error; use a version id instead. Formats without
a text projection, such as drawings, cannot be diffed. It requires
`documents:read`; the specialized Doc and HTML Doc tools remain available for
format-specific operations.

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

`worktable_spaces` creates, updates, archives, and restores Spaces with
`docs:write`. Setting a Space's Start here pins also requires
`documents:write`.

With `documents:read`, the `search` action in `worktable_discover` searches
Docs, HTML Docs, and other registered document formats, returning safe text
where available. Unknown formats and conflicting paths appear as metadata-only
results and do not open in another document view. Clients without
`documents:read` retain the earlier Docs and Records search results.

Clients with Agent Skills support can install the optional provider-neutral
Worktable suite for higher-level workflow judgment. Skills are not required for
MCP operation and do not replace server-side authentication, authorization,
validation, path boundaries, or destructive-operation separation.

## Search and fetch

The MCP server exposes a read-only search and retrieval pair for compatible
clients:

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

Use HTTP for clients that support Streamable HTTP MCP. Worktable's
connector and **Settings → Agents** render the endpoint appropriate to the
current install.

## stdio

The in-process stdio server opens the selected local workspace:

```json
{
  "command": "worktable",
  "args": ["mcp", "stdio"]
}
```

`worktable --mcp` is an equivalent hidden spawn form retained for compatibility.
This is a local workspace process, not a proxy to a remote HTTP endpoint.

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

## Client configuration

Support maturity and configuration method are separate:

| Client ID        | Product                                            | Setup                                                   |
| ---------------- | -------------------------------------------------- | ------------------------------------------------------- |
| `claude-code`    | Claude Code                                        | Connector-installable                                   |
| `codex`          | Codex CLI and IDE              | Connector-installable or provider-native Settings       |
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

## HTTP-to-stdio bridge

The normal Worktable binary also carries the shared machine-facing bridge:

```text
worktable mcp bridge [--url <mcp-url>] [--token-env <name>]
```

The command is hidden from interactive help because provider packages invoke it.
`--url` falls back to `WORKTABLE_MCP_URL`; `--token-env` defaults to
`WORKTABLE_MCP_TOKEN`. Raw bearer values are never accepted as arguments. This
bridge does not replace `mcp stdio` or `--mcp`.

## Claude extension download

Compatible local and self-hosted installations serve their matching macOS extension
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
Closing its window keeps it running; quitting Worktable stops it. After revoking
a token, reconnect the client with a new credential. When switching
workspaces or hosts, verify the endpoint shown in Settings and
update client configurations if it changed.

## Prose edits

`worktable_docs_read` action `grep` matches literal text or a JavaScript regular
expression one line at a time. It returns 1-based line numbers and revisions.
Check `truncated`, `lineTruncated`, and `skipped` before claiming a complete
search. `read` accepts `offset` and `limit` for exact line ranges.

`worktable_docs_write` action `edit` applies exact `oldText`/`newText` replacements.
Each match must be unique unless `replaceAll` is set. A batch applies completely
or not at all. Copy text from a read; reread after `no_match`, `ambiguous`, or
`revision_conflict`. Unsupported rich-block changes must be made in Worktable.

An edit preserves unchanged content and formatting. With `expectedRevision`,
concurrent edits to unrelated blocks can survive, while overlapping changes
can produce a conflict. Whole-document `write` requires `expectedRevision` for
an existing document and refuses formatting loss unless `force` is supplied.
Do not use `force` merely to bypass a refusal.

HTML previews capture the saved source with persistent writes and external
network disabled. A failed preview does not undo a successful save: retry the
read `render` action rather than repeating the mutation. See
[HTML runtime](/reference/html-doc-runtime/) and [Drawings](/agents/drawings/)
for format-specific verification.
