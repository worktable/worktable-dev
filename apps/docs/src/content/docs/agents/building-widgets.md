---
title: Building HTML docs
description: How agents build sandboxed interactive HTML docs in Worktable.
---

HTML docs are self-contained interactive pages: dashboards, trackers, visual plans, briefings, disposable tools. Docs come in three formats — markdown, rich text, and HTML — and the HTML kind is what you reach for when the human would be better served by an interface than a wall of text. Build one.

## Read the contract first

```txt
worktable_html_read  # action: guide, profile: runtime (default)
```

The runtime profile is the server-owned technical contract for sandboxing,
bridge APIs, permissions, state, networking, and theme tokens. Visual
composition and authoring workflow live in the optional
`worktable-create-or-manage-interactive-html` Agent Skill rather than MCP
metadata.

The same runtime contract is published for browsing at
[HTML doc runtime](/reference/html-doc-runtime/). Prefer the tool response while
authoring because it is versioned with the Worktable server you are connected to.

## The shape of an HTML doc

- One fully self-contained `.html` source file in the Space's docs tree: inline styles and scripts, with no external network unless the doc's network permission is enabled.
- The sandboxed runtime exposes a small `worktable.*` API for records, persistent doc-local state, and theming — an HTML doc can read and update the same record collections you and the human use.
- `worktable_html_write` handles create, update, move, rename, archive, and restore. Use `move` to change the doc's path while preserving its identity; `rename` changes display details. Permanent deletion is the `html` action in `worktable_delete`; archive when the human may want it back.

## Working patterns

- Link to other Worktable content from inside the HTML with portable in-app paths, not the `urlToSendInChat` field a tool result returns (that field is for external chat messages only).
- Narrative Doc writes validate Mermaid automatically. For HTML, use `worktable_mermaid` action `validate` for each source before saving and `preview` when you need to inspect or embed the SVG.
- Pair an HTML doc with a record collection when it presents structured state — the records stay the source of truth, readable outside the doc. Query and update the canonical collection rather than encoding durable domain data only in HTML or doc-local state; reserve doc-local state for interface preferences.
- Prefer the built-in records table when the human only needs generic inspection or a quick correction. Build an HTML doc when the collection needs a board, planner, dashboard, form, or workflow-specific controls.
- Disposable is fine. An HTML doc built for one review session is a good use of the medium; archive it after.
