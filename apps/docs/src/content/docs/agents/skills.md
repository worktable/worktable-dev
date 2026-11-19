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
| [Check the Library](/agents/library-check/) | Follow your team's approved skills before other work. |
| [Find context](/agents/find-context/) | Retrieve sources and answer without changing the workspace. |
| [Edit documents](/agents/writing-docs/) | Create and revise prose while preserving existing work. |
| [Build HTML](/agents/building-widgets/) | Build and verify interactive HTML docs. |
| [Manage records](/agents/records-and-schemas/) | Model collections and update structured items. |
| [Review annotations](/agents/annotations-protocol/) | Attach feedback and handle requested revisions. |
| [Use threads](/agents/threads/) | Send and continue authorized conversations. |

The workflow skills are short. Each tells the agent to read its guide from
the connected Worktable with `worktable_guidance`, so a copy that an app never
updates still follows the current guide. Each page shows that guide. Set up
Worktable and Check the Library hold their full instructions.

Copy a skill for a one-off instruction, or download the complete package, with
supporting files and license, to install by hand. The
[skill manifest](/.well-known/skills/index.json) lists the files and the source
revision.

## Your team's skills

Your team can also keep its own skills as Docs in the
[Library](/concepts/#library). Agents get the version someone saved. When an
agent suggests a new skill or a change, it waits until a person approves it.

The Library is for how your team works. A skill that comes with a tool stays
with that tool, and a skill about one codebase stays in its repository.

## Installation

Plugins already include skills, so don't install a second copy:

- The general Worktable plugin bundles every skill except Set up Worktable,
  along with its **Cloud** MCP connection.
- Worktable Skills bundles the same skills without a connection. The connect
  command for a local or self-hosted Worktable installs it in Claude Code and
  Codex, where it shows as Worktable, unless the general plugin is already
  there. It also removes skills an earlier command copied, so none show twice.
  If the plugin can't be installed, the command copies the skills instead, as
  below, and says so.
- The Hermes plugin bundles the same skills except Check the Library. Hermes
  lists your team's skills itself.
- The OpenClaw plugin bundles all of them except Check the Library, for the
  same reason.

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

If Worktable runs on another computer and your agent isn't Claude Code or
Codex, install only the skills:

```sh
curl -fsSL https://worktable.dev/install-skills | sh -s -- --target agents
```

This does not install the app, create a workspace, or configure MCP.

### Gemini app

The Gemini app takes one skill folder and never updates it. Download
[worktable.tar](/downloads/skills/gemini/worktable.tar), unpack it, and upload
the `worktable` folder. It checks your team's Library and names each workflow
guide. Or save its [SKILL.md](/downloads/skills/gemini/worktable/SKILL.md) in a
folder named `worktable` and upload that.

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
