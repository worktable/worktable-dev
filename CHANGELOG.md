# Changelog

All notable changes to Worktable releases are documented here. This project follows [Keep a Changelog](https://keepachangelog.com/) conventions.

## [Unreleased]

## [0.0.1] — initial release

First public local release.

### Added

- **One-command install** — `curl -fsSL https://worktable.dev/install | sh` installs the `worktable` binary for macOS (Apple Silicon + Intel) and Linux x64. No npm, Bun, or source checkout required.
- **`worktable doctor`** — inspects the installed executable, packaged web assets, workspace path, app-private path, and MCP setup.
- **The content model** — Spaces, Docs (markdown or rich blocks, versioned), Widgets (sandboxed HTML), Records (file-backed YAML), and Annotations (two-way human↔agent comments).
- **MCP server** — connect any client over stdio (`worktable --mcp`) or Streamable HTTP (`/mcp`). Optional bearer token via `WORKTABLE_MCP_TOKEN`.
- **First-run experience** — starter workspace seeded on an empty workspace, with bundled agent skill docs the agent reads on arrival.
- **Live updates** — the web app reflects file changes in real time.

[Unreleased]: https://github.com/worktable/worktable-dev/compare/v0.0.1...HEAD
[0.0.1]: https://github.com/worktable/worktable-dev/releases/tag/v0.0.1
