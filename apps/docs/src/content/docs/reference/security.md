---
title: Security model
description: What protects your workspace locally, and what changes when Worktable becomes reachable.
---

Self-managed Worktable has two network postures, and the effective public
address decides which one applies. Worktable Cloud uses hosted identity and
OAuth instead.

## Local (the default)

Worktable binds loopback (`127.0.0.1`). Only processes on your machine can reach it, so it runs owner-open like any local app: no account, no login, no token. Your workspace is files in a folder you own. Installed releases periodically check Worktable's release manifest for updates unless `WORKTABLE_NO_UPDATE_CHECK` disables the check.

Local MCP trust applies only to literal `127.0.0.1`, `localhost`, or `::1`
request hosts. Cross-site browser requests and DNS-derived hostnames do not get
implicit owner access. This prevents a website or DNS-rebinding path from using
the local convenience boundary.

Scoped agent tokens may coexist with tokenless loopback use. Presenting one gives
that connection its own scopes and agent principal without changing every other
local client's authentication mode. A wrong or revoked bearer always fails; it
never falls back to the implicit owner.

Want to require a shared credential on loopback? Set `WORKTABLE_MCP_TOKEN` and
MCP requires that bearer as explicit deployment policy.

Local owner access is limited to requests addressing a literal loopback host from
the Worktable app or non-browser tools. Cross-origin and sandboxed browser
requests do not receive that authority. Explicit credentials keep their scopes
on both REST and realtime connections. HTML documents with network permission
disabled cannot make outbound WebSocket connections. Agent writes use the
verified agent identity; marking a document reviewed requires the human owner.
An agent with token-management permission can delegate credentials, but those
credentials remain agent principals and cannot certify human review.
The browser collaboration channel is reserved for human principals. Agents edit
through MCP or the scoped REST APIs.

Revoking a local token or signing out all owner-password sessions also detaches
their existing realtime subscriptions on the
next credential check, normally within one second plus local I/O and scheduling.
The transport may stay open until the peer disconnects, the idle timeout fires,
or the server stops, but it can no longer read or write workspace data.

## Reachable

`worktable setup --reachable` (or an explicit non-loopback `--host`) opens Worktable to other machines, and the posture changes with it:

- **The web app and API go behind your owner password.** You sign in once; a signed session cookie carries it. The server refuses to bind a non-loopback interface without an owner password — exposed-without-password is not a state Worktable can be in.
- **MCP goes behind a bearer token.** Setup mints a token bound to your workspace and scoped to workspace content (docs, HTML docs, records, annotations, and discovery, but not full control) and injects it into your same-machine agent configs so they keep working. Remote agents get their own scoped tokens through the pairing flow (`worktable agent invite` or Settings → Agents): pairing codes are single-use, expire in 15 minutes, and every connection can be revoked from Settings.
- **Health stays open.** `/health` answers without auth so load balancers and uptime checks work.

On a local or self-hosted install, setting a public URL (`WORKTABLE_PUBLIC_URL`, or Settings → General → Workspace URL) puts a loopback-bound install in this same protected posture: a saved tunnel or reverse-proxy origin is an exposed front door even though the bind itself is loopback, so the owner password and MCP bearer token requirements both apply, and the server refuses to start without an owner password already set. Worktable Cloud manages its public address separately.

## You bring the TLS

Worktable serves plain HTTP by design and warns when exposed. Front it with your own HTTPS — a tunnel (Tailscale, Cloudflare Tunnel, ngrok) or a reverse proxy — and pass `--behind-tls` to acknowledge you've done so (it silences the reminder; it doesn't change auth). Session cookies and bearer tokens travel with every request: don't expose plain HTTP across networks you don't trust.

## Worktable Cloud

Worktable Cloud puts the web app behind its hosted sign-in and gives agent
clients a separate OAuth approval flow. It does not issue the local `wt_`
tokens described above. Signing the current browser out does not revoke an
agent's approved connection or delete workspace data. See [Worktable Cloud
accounts and agents](/guides/worktable-cloud/) for the user-facing flows.

Cloud connections receive explicit scopes. A normal MCP content client can be
approved for workspace discovery and content operations; owner and credential
management remain separate. Specialized participants can receive narrower
access, such as OpenClaw's default conversation-only registration. Disconnect
each approved app or participant independently in **Settings → Agents**.

The current service, privacy, and security commitments live in the canonical
[terms](https://www.worktable.cloud/terms) and
[privacy policy](https://www.worktable.cloud/privacy), rather than being duplicated
in this technical reference.

## Worktable Desktop

Desktop keeps each self-hosted session in WebKit's origin-scoped cookie store
and removes that origin's Worktable cookie when you forget the profile. It uses
normal macOS certificate and hostname validation, rejects redirects during
connection validation, and offers no certificate bypass. Cloud authentication
uses the system browser. Signed Desktop updates are verified before install;
workspace content and saved connections survive an update.

## Where secrets live

Worktable-managed tokens are stored as hashes, and passwords as hashes, in the
machine-local app data folder, never in your workspace folder. Copying the
workspace does not copy those credentials. As with any user-owned folder, do
not put secrets in doc or record content that you plan to share or commit.
Agent config files that carry a bearer token are written with owner-only file
permissions.

The Settings UI shows a newly minted desktop-app token once and keeps it only in
component memory until Settings closes. The Claude extension marks its token
field sensitive and receives it through the environment; the CLI bridge also
accepts tokens only through an environment variable. Tokens are never put in
URLs or command-line arguments. After copying a token, the provider application
owns its stored copy: revoking it in Worktable means replacing it there.

## The practical rules

1. Literal same-machine loopback needs nothing unless you explicitly require a deployment credential.
2. Going reachable? Let `worktable setup --reachable` do it — it sequences the password, token, and client updates correctly.
3. Terminate TLS yourself, and tell Worktable with `--behind-tls`.
4. Rotate by re-running `worktable mcp setup`: it mints a fresh token, updates every same-machine client, and only revokes the prior token once every client is confirmed working, so a failed update leaves your existing token and configs untouched.
5. Keep Worktable Desktop running (closing its window is fine; don't quit it) while a provider uses its Desktop-local endpoint.
6. Treat a `.wtb` package like the workspace content it contains. It excludes
   Worktable-managed credentials but can still contain secrets written in docs
   or records.
