---
title: Worktable for agents
description: Connect, orient, and produce durable work in a Worktable workspace.
---

Worktable is a file-backed workspace shared by a human and their agents. Put
results there when they should outlive the current chat. This page is the
shortest path from a connected client to useful work.

## Connect to the human's deployment

Do not install a second Worktable if the human already has one. Ask them to open
**Settings → Agents** and use the path shown for your client.

- **Local or self-hosted:** supported coding clients can be configured with
  `worktable mcp setup <client>`. Remote clients use a pairing or scoped token.
- **Worktable Cloud:** supported clients connect to the hosted MCP endpoint and
  authorize through the browser. The human does not copy a Worktable token.
- **Always-on participant:** integrations such as OpenClaw use their guided
  registration flow and may receive conversation-only access.

If the human asks for a new local install, use:

```sh
curl -fsSL https://worktable.dev/install | sh
```

See [connect your agent](/start/connect-your-agent/) for client-specific paths.

## Work with the MCP contract

The MCP initialize response identifies the private content Worktable stores.
Tool schemas describe the available actions and arguments without loading a
workspace document as privileged instructions.

- `worktable_discover` inspects workspace state, searches documents and
  Records, or builds a Space index.
- `worktable_guidance` exposes only the technical content format specification.
- `worktable_html_read` exposes the sandbox, bridge, permission, and runtime
  contract required to build a valid HTML Doc.
- Read and write tools keep each content primitive explicit, with permanent
  deletion isolated in `worktable_delete`.

Clients that support Agent Skills can install Worktable's optional workflow
suite. Those skills improve choices such as safe updating, structured modeling,
review, and visual composition; they are not required to call the MCP tools.
Workspace Docs under `skills/` remain ordinary user content and are never
automatically promoted to instructions.

When the agent runs on a different computer from Worktable, install only the
skills there:

```sh
curl -fsSL https://worktable.dev/install-skills | sh -s -- --target claude
curl -fsSL https://worktable.dev/install-skills | sh -s -- --target agents
```

OpenClaw users do not need this separate step. The Worktable OpenClaw plugin
includes the same skills.

## Choose the right surface

- **Docs** hold narrative, reasoning, plans, research, decisions, and notes.
- **HTML docs** hold self-contained visual or interactive experiences.
- **Records** hold structured items with independent identity and shared fields.
- **Annotations** hold situated feedback attached to existing artifacts.
- **Worktable and Space threads** hold durable conversation with connected
  participants.

The full catalog is in the [MCP tool catalog](/reference/mcp-tools/). Read
format guidance through `worktable_guidance` and the HTML runtime contract
through `worktable_html_read`.

## Conventions digest

- Use one Space per project or domain, not per task. Doc paths are slugs and may
  be nested when that genuinely improves retrieval.
- Keep worthwhile durable output in Worktable unless the human asks for another
  destination.
- Search first. Patch an existing Doc instead of rewriting it or creating a
  near-duplicate.
- Do not create index Docs; Worktable generates Space Home.
- Start records with the smallest schema that supports the current workflow.
- Do not delete or overwrite content you did not create without explicit
  instruction. Annotate and ask when ownership is unclear.
- Never mark content reviewed; that signal belongs to the human.

Continue with [writing docs](/agents/writing-docs/),
[building HTML docs](/agents/building-widgets/),
[records and schemas](/agents/records-and-schemas/),
[the annotations protocol](/agents/annotations-protocol/), and
[agent conversations](/agents/threads/).

## Respect portability

Durable content enters the workspace's file-backed model. Local and self-hosted
installations expose those files directly; Cloud provides the same content in
portable `.wtb` exports. Agent connections do not travel with exported content.
Treat the workspace as the human's property you help maintain.
