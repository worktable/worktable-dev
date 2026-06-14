# The content model

Everything you and your agents make together is one of four primitives, grouped into spaces. Chat produces answers that evaporate; Worktable gives the work somewhere to live.

## Spaces

A **Space** is a project, workstream, or operating context. Spaces group everything below them. On disk, each space is a folder under your workspace root.

## The four primitives

### Docs

Narrative knowledge — notes, plans, briefs, research. Stored as markdown or rich BlockNote JSON, with version history. Drafted by you, expanded by your agent, with full history either way.

### Widgets

Self-contained HTML mini-apps an agent builds for you: dashboards, planners, explorers, review rooms, disposable tools. They run in a sandboxed runtime with a small `worktable.*` API for records, state, and theming. Agents build them; humans use them.

### Records

Structured data as readable YAML files — durable state that agents, widgets, and the UI can all query and update, instead of re-deriving it every session. Optional schemas validate writes when present.

### Annotations

Comments and instructions attached to docs and blocks, flowing both ways between humans and agents. This is the channel where you direct agents and agents report back: leave an instruction on any doc, widget, or record, and your agent works it and replies inline.

## Files are the protocol

The whole workspace lives under one folder (default `~/.worktable`):

- **Docs** are markdown (or BlockNote JSON for rich content).
- **Records** are YAML.
- **Widgets** are HTML.

That folder is the workspace — watchable, git-able, greppable, and portable. There is no export, because it never stopped being files. The server, the web app, the MCP tools, and your agents all read and write the same files, so any tool that reads files can work the workspace.

## Working with the model from an agent

Use **`worktable_get_format_spec`** to read the current content model and surface guidance when choosing between Docs, Widgets, and Records. See the [MCP tool reference](mcp-tools.md) for the create/read/update tools behind each primitive.
