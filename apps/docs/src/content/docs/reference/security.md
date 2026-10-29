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

## Team access

Enable Teams from **Settings → Team** on a local or self-hosted Worktable.
Create the first named account, then invite members by copying invitation links.
No email service is required. A link authorizes joining; it does not verify
ownership of the invited email address. Everyone signs in after Teams is enabled.
On Worktable Cloud, invitations are emailed and only an account with the
invited address can accept one.

Existing Spaces remain restricted until an owner shares them. New Spaces let
members read and edit by default. Owners can read and administer every Space.
Space creators manage access to their Spaces through **Manage access** in the
Space menu or **Settings → Team**. Renaming, archiving, or deleting a Space
also requires managing its access. Threads inherit their Space's audience;
participants identify who is involved. Worktable threads are visible to all members.

Personal agents follow their member's current Space access unless narrowed; a
narrowed agent cannot use Worktable threads. Owners register team agents, which
have independent grants. Space managers can grant those agents access, and an
owner chooses whether each team agent can read or post in Worktable threads.
Removing a member revokes that member's sessions and personal agents. People
manage invitations and access; agents cannot do so. Restoring a full backup
cancels pending invitation links.

Team ownership grants application administration. Operating the underlying
machine is a separate authority. Machine operators can access its files.
Operators grant operation to other members from **Settings → Team**, and
removing a member removes it.

If someone forgets their password, an owner creates a single-use reset link
in **Settings → Team** and sends it to them. It expires after 24 hours and
signs them out everywhere. Owners' passwords are reset on the machine:

```sh
worktable team reset-password owner@example.com
worktable team operator grant owner@example.com
```

## Reachable servers

A non-loopback bind, reachable mode, or public workspace URL requires protection:

- The browser and owner API use an owner password and session cookie, or named
  member accounts when Teams is enabled.
- MCP uses bearer authentication. Pairing issues separate scoped credentials
  for remote agents; codes are single-use and expire after 15 minutes.
- `/health` remains available without authentication.

The server refuses to start in this posture without an owner password or
initialized Teams authentication.
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

## How HTML Docs are isolated

HTML Docs support JavaScript. In the web app and Desktop they run inside a
sandboxed iframe with an opaque origin, separate from the app's origin. They
cannot read the parent page, its cookies, browser storage or session credentials.
The server also applies a sandbox policy when a document's content URL is opened
directly. Forms, popups, downloads and navigation of the parent page are blocked.

A content security policy blocks external scripts, styles, images and embedded
pages. Fonts are limited to embedded data and Worktable's font assets. By default,
direct data requests are limited to the Worktable server, whose authentication
rejects the frame's opaque origin. The document's network permission additionally
allows HTTPS and WebSocket connections. An authorized agent can currently grant
that permission without a separate human approval.

Records and document state use a narrow message bridge. It accepts requests from
the active document frame only, and stops when that frame leaves the document.
It reaches only that document's state and permission-checked Records in its own
Space. Record queries also check permission on related collections. Calls run
with the viewer's current access, so the document's declared permissions are not
a guarantee of what its writing agent could access. The bridge gives no general
access to the Worktable API or other Spaces.

Agent previews run in a separate browser context with no signed-in session.
They allow permitted state and Record reads within the caller's access, block
persistent writes and external network requests, and return an image. Saved
versions are displayed with scripts and live data disabled.

Isolation does not make a document trustworthy. It can display misleading forms
or imitate a sign-in screen inside its frame. Browser policies also do not
guarantee that data cannot leave: a frame can navigate itself, and scripts may
signal through DNS or WebRTC. Network permission allows direct transmission of
anything the document can read. Review generated content and its data access
before using it or sharing it.

## Live tools and visitor comments

Live tools read data only through explicit, human-chosen access, and only when
the owner allows live tools in Settings → Sharing. A link grants only the selected Records rows and fields, further
restricted by the document's current permissions and owner policy. It does not
give the reader a member account or the maker's credentials. Visitor Records
access is read only, and interface preferences stay local to the tab.

Record rules constrain Records API reads. The complete tool program, including
any text or data embedded in it, is shared with every reader of the link.
Review that content before sharing; a Record rule does not hide it.

A live tool supports JavaScript in a sandboxed frame on a separate origin for
each Worktable. Its policy blocks external data requests, assets and forms even
if the document has network permission in the member app. It cannot read member
cookies or persistent browser storage. Static share views disable scripts and
remove interactive content. The frame is not
the data boundary: browsers still let a script signal out through DNS lookups
or WebRTC. Worktable therefore limits what a link exposes on the server, and
treats everything a link can read as visible to its readers.

Visitor comments are stored outside the portable workspace. Agents cannot read
them until a member passes them to the team as quoted outside input. See
[Sharing](/guides/sharing/#live-tools-and-visitor-comments) for link access,
owner controls and recovery behavior.

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

For Teams, connect agents from **Settings → Agents** so each connection belongs
to a member. Managed CLI setup is reserved for a one-person Worktable.

Re-running `worktable mcp setup` on a one-person Worktable can rotate a managed token and rewrite client
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
