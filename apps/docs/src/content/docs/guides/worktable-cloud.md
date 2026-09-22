---
title: Worktable Cloud accounts and agents
description: Use the hosted workspace, share documents, connect agents, move portable content, and manage your account.
---

Worktable Cloud brings hosting, AI access, and document sharing into one
subscription. Open your hosted Worktable in a browser or add it as a connection
in Worktable Desktop. Your documents use the same portable format as local and
self-hosted Worktable.

Device linking is being tested in a limited rollout. When enabled, it connects
up to three local or self-hosted installations to AI apps and public document
sharing through your Cloud account.

## Manage a Cloud subscription

Open **Settings → Account** to start a subscription, see its status, or choose
**Manage billing** after subscribing. The personal plan renews monthly at
$7.99 USD, plus applicable taxes shown during checkout. Cancellation takes
effect at the end of the paid period.

For billing, refund, privacy, and service details, use the
[Worktable Cloud terms](https://www.worktable.cloud/terms) and
[privacy policy](https://www.worktable.cloud/privacy). Email
[support@worktable.dev](mailto:support@worktable.dev) when you need account or
billing help.

After a renewal payment fails, your workspace remains fully available for seven
days. If payment does not recover, normal workspace access is suspended. You
can still manage billing, sign out, and download a full workspace export.
For a linked device, use **Settings → Worktable Cloud → Manage devices** to
open your Cloud account. Your local documents remain accessible if your Cloud
subscription ends.

## Link a local or self-hosted device

When device linking is enabled:

1. Open **Settings → Worktable Cloud** on the device and choose **Link with Worktable Cloud**.
2. Choose **Continue in browser**, sign in, and approve that device. If needed,
   complete the subscription checkout and return to the approval screen.
3. Return to Settings. When connected, copy the **MCP URL** into your AI app's
   custom connector setup and choose OAuth authentication.
4. Sign in with the same Worktable Cloud account and approve the connection.

The AI app can read and change documents on that linked device. Keep Worktable
running and the device online; a sleeping laptop cannot serve requests. Each
device has its own MCP URL and approved AI connections. Content stays on that
device, and authorized requests pass through Cloud without creating a hosted
copy. This does not synchronize the device with your hosted Worktable or open
its full interface remotely.

Choose **Manage devices** to pause or resume access, disconnect an AI app, or
unlink the device. Pausing preserves its links and connections for resuming.
Unlinking ends access for that device; linking it again creates a new MCP URL.
Replacing the local workspace also requires linking it again.

## Share a document

Open a Doc or HTML doc in your hosted Worktable or a connected device and choose **Share** in the document
header. Choose **Create link**, then **Copy**. Anyone with the link can view the
document without signing in. Shared links are unlisted and not searchable.
For a linked device, the device must remain online and access must be active.

A shared Doc reflects its latest saved content. Choose **Stop sharing** to
disable the link. Moving, renaming, archiving, or deleting the document also
disables it. Sharing the document again creates a new link.

Shared HTML docs keep their layout and safe external links. Scripts, forms,
Records access, saved interface state, and links to private Worktable content
do not work in the shared version.

## Move a workspace into or out of Cloud

Open **Settings → Import & Export** to download a standard `.wtb` package
or replace the hosted workspace from one. The same package works in local,
self-hosted, and Desktop Worktable and includes a read-only offline browser.
Replacement keeps the Cloud workspace identity and account attachment; it is a
deliberate snapshot handoff, not sync or merge. See
[Import and export a workspace](/guides/import-export/) for the complete flow.

## Connect an agent or app

Open **Settings → Agents**. The page groups setup by connection type:

- **Quick connect** for supported coding agents and MCP clients.
- **Always-on agents** for participants such as OpenClaw that can receive and
  reply to Worktable threads.
- **Desktop and web apps** for providers that use a browser authorization flow.
- **Manual setup** when a client is not covered by a guided path.

Cloud-capable clients open a browser approval flow. After you approve it, the
client receives the access it needs without a Worktable token for you to copy.
An always-on participant may be limited to conversations. Follow the setup
shown in Settings for the client you chose. Local and self-hosted installs use
the token and pairing flows described in
[remote access](/guides/remote-access/), or the device linking flow above when
it is enabled for your Cloud account.

## Sign out of the browser

Open **Settings → Account** and choose **Sign out**. This ends the Worktable
Cloud session in the current browser. It does not delete workspace data,
or disconnect agents that have their own approved access. Your upstream
identity provider may remain signed in, depending on its session policy.

After sign-out, use **Sign in again** to start a new Worktable Cloud browser
session.
