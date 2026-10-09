---
title: Security
description: Authentication, access, credentials, and content boundaries.
---

Worktable's access rules depend on the deployment. Local trust, self-hosted
credentials, and Cloud OAuth are separate mechanisms.

## Local access

The default server binds `127.0.0.1`. Trusted requests addressed to literal
`127.0.0.1`, `localhost`, or `::1` can act as the local owner when deployment
policy allows it. Cross-site browser requests and DNS-derived hostnames do not
receive that authority.

Scoped tokens can coexist with tokenless loopback access. A supplied invalid
or revoked bearer fails authentication; it never falls back to local trust.
Setting `WORKTABLE_MCP_TOKEN` requires a deployment credential for MCP, including
on loopback. It is an owner credential, unlike a scoped agent token.

## Reachable servers

A non-loopback bind, reachable mode, or public workspace URL requires protection:

- The browser and owner API use an owner password and session cookie.
- MCP uses bearer authentication. Pairing issues separate scoped credentials
  for remote agents; codes are single-use and expire after 15 minutes.
- `/health` remains available without authentication.

The server refuses to start in this posture without an owner password.
`worktable setup --reachable` configures the bind, password, and managed agent
connections. A tunnel or reverse proxy still needs these controls even when
Worktable itself binds loopback.

Worktable serves HTTP. Terminate HTTPS at a tunnel or reverse proxy before
sending credentials across an untrusted network. `--behind-tls` suppresses the
HTTP reminder; it does not enable TLS or change authentication.

## Agent permissions

Server-side scopes determine which operations a connection can perform.
Content access does not imply owner or token-management access. Credentials
delegated by an agent remain agent principals and cannot become the human owner.

Agents with `docs:write` can create, update, archive, and restore Spaces.
Changing a Space's pins also requires `documents:write`. Space deletion and
owner document-tree operations remain owner-only. The realtime collaborative
editor is reserved for human principals; agents edit through MCP or scoped APIs.

An HTML doc has its own declared permissions. Its runtime also checks caller
access where applicable. An agent authorized to write HTML can set the doc's
permissions; these are not necessarily grants made by a human. See
[HTML runtime](/reference/html-doc-runtime/) for the sandbox and bridge contract.

## Cloud access

Cloud uses hosted sign-in for people and OAuth approval for MCP clients.
Specialized registrations may receive narrower access, including OpenClaw's
default conversation-only scope. Disconnect each app or participant in
**Settings → Agents**. Signing out of the browser does not revoke agent access.

Current hosted-service commitments are published in the
[terms](https://www.worktable.cloud/terms) and
[privacy policy](https://www.worktable.cloud/privacy).

## Credentials

Worktable-managed token and password hashes live in machine-local application
storage, outside the portable workspace. Client configurations may contain raw
bearer tokens; Worktable writes managed credential-bearing files with owner-only
permissions. Provider applications control their own stored copies.

The Claude extension receives its token through a sensitive environment field.
The HTTP-to-stdio bridge accepts a token environment-variable name rather than
a raw token argument. Other connector paths place a bearer in a configuration header or launch
argument; some realtime endpoints also accept token query parameters. Treat
generated credential-bearing snippets,
configuration files, logs, and shell history accordingly.

Re-running `worktable mcp setup` can rotate a managed token and rewrite client
configuration. Rotation does not guarantee that a failed update preserves the
old token. Check each affected client afterward. Revoking a token does not
erase its copy from a provider's configuration.

Revocation also detaches existing local realtime subscriptions on the next
credential check. A transport can remain open briefly without retaining data
access.

## Desktop and exports

Desktop validates macOS certificates and hostnames without a bypass. It rejects
redirects during connection validation and verifies signed updates. Self-hosted
sessions use origin-scoped WebKit cookies; forgetting a profile removes its
Worktable cookie without changing the server.

Workspace exports exclude Worktable-managed credentials and connection state.
They still contain any secrets a user wrote in documents or records. Review
content before sharing, exporting, or committing it. See
[Workspace packages](/reference/workspace-packages/).
