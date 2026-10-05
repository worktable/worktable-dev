---
title: Skills
description: Read, install, update, and remove Worktable workflow skills.
---

Skills provide instructions for working in Worktable. An MCP connection provides
tools and access. You can use MCP without installing skills, and installing
skills does not connect an agent or grant access.

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

Each page is generated from its canonical `SKILL.md`. Use its copy action for
inspection or a one-off instruction, or download the complete package for
manual installation. Packages include supporting files and their license.
The [skill manifest](/.well-known/skills/index.json) lists available files and
the documentation's source revision.

## Installation

The general Worktable plugin bundles these skills with its **Cloud** MCP
connection. The OpenClaw plugin also bundles the suite. If your client already
loads either bundle, avoid installing another copy.

For a client with Agent Skills support, the CLI manages two locations:

| Target | Directory |
| --- | --- |
| `claude` | `~/.claude/skills` |
| `agents` | `~/.agents/skills` |

Check which location your client supports. Then install:

```sh
worktable skills status
worktable skills install agents
```

Substitute `claude` where appropriate. Worktable setup and MCP setup do not
install skills automatically.

If Worktable runs on another computer, install only the skills locally:

```sh
curl -fsSL https://worktable.dev/install-skills | sh -s -- --target agents
```

This downloads a temporary installer. It does not install the application,
create a workspace, or configure MCP.

## Update and remove

```sh
worktable skills update agents
worktable skills repair agents
worktable skills remove agents
```

Use `--preview` to inspect a change before applying it. Automation can apply
the reviewed plan with `--plan-id <id> --yes`.

Status distinguishes missing, outdated, modified, conflicting, and incomplete
installations. Repair restores missing managed files without overwriting local
edits or unmanaged skills with the same name. Removal deletes only unchanged
files recorded in Worktable's ownership manifest.

With the skills-only installer, put `status`, `update`, `repair`, or `remove`
before `--target`. Plugin-bundled skills update with the plugin. Manually copied
skills are your responsibility to update or remove.

Bundled skills follow the installed Worktable or plugin release. This site's
downloads may include newer revisions; check the source revision on each page.

See [Connections](/agents/connections/) to configure access and
[CLI commands](/reference/cli-commands/) for exact command options.
