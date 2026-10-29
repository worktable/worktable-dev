---
title: Skills
description: Read, install, update, and remove Worktable workflow skills.
---

Skills give agents instructions for working in Worktable. The MCP connection
gives them tools and access. You can use MCP without skills, and installing
skills does not connect an agent.

## Available skills

| Skill | Purpose |
| --- | --- |
| [Set up Worktable](/agents/setup/) | Install or connect Worktable for a user and verify access. |
| [Find context](/agents/find-context/) | Retrieve sources and answer without changing the workspace. |
| [Edit documents](/agents/writing-docs/) | Create and revise prose while preserving existing work. |
| [Build HTML](/agents/building-widgets/) | Build and verify interactive HTML docs. |
| [Manage records](/agents/records-and-schemas/) | Model collections and update structured items. |
| [Review annotations](/agents/annotations-protocol/) | Attach feedback and handle requested revisions. |
| [Use threads](/agents/threads/) | Send and continue authorized conversations. |

Each page is generated from its `SKILL.md`. Copy it for a one-off instruction,
or download the complete package, with supporting files and license, to
install by hand. The [skill manifest](/.well-known/skills/index.json) lists the
files and the source revision.

## Installation

Plugins already include skills, so don't install a second copy:

- The general Worktable plugin bundles every skill except Set up Worktable,
  along with its **Cloud** MCP connection.
- The Hermes plugin bundles the same skills as the general plugin.
- The OpenClaw plugin bundles all of them.

To add only Set up Worktable, download its package from the
[Set up Worktable](/agents/setup/) page into your client's skills folder.

For a client with Agent Skills support, the CLI manages two locations:

| Target | Directory |
| --- | --- |
| `claude` | `~/.claude/skills` |
| `agents` | `~/.agents/skills` |

Check which one your client reads, then install:

```sh
worktable skills status
worktable skills install agents
```

Use `claude` instead of `agents` where needed. Worktable setup and MCP setup do
not install skills.

If Worktable runs on another computer, install only the skills:

```sh
curl -fsSL https://worktable.dev/install-skills | sh -s -- --target agents
```

This does not install the app, create a workspace, or configure MCP.

## Update and remove

```sh
worktable skills update agents
worktable skills repair agents
worktable skills remove agents
```

Add `--preview` to inspect a change first. Automation can apply the reviewed
plan with `--plan-id <id> --yes`.

- `status` reports missing, outdated, modified, conflicting, and incomplete
  installations.
- `repair` restores missing files without overwriting your edits or unmanaged
  skills with the same name.
- `remove` deletes only unchanged files that Worktable installed.

With the skills-only installer, put `status`, `update`, `repair`, or `remove`
before `--target`. Plugin skills update with the plugin. Skills you copied by
hand are yours to update or remove.

Bundled skills match the installed Worktable or plugin release. Downloads on
this site may be newer; each page shows its source revision.

See [Connections](/agents/connections/) to configure access and
[CLI commands](/reference/cli-commands/) for command options.
