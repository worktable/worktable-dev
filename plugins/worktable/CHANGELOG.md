# Changelog

## [0.2.0] - 2026-11-17

### Added

- A Library skill has your agent check the skills your team approved in Worktable's Library, and follow the one that fits the task.

### Changed

- Each workflow skill now reads its current guide from the connected Worktable. Apps that keep their own copy of the plugin, such as Perplexity or an uploaded file, follow the current guide without an update.

## [0.1.10] - 2026-11-16

### Changed

- The plugin's logo fills its square, so apps that show it on a tile of their own, such as ChatGPT's plugin list, show the Worktable mark without white corners.

## [0.1.9] - 2026-11-16

### Added

- Antigravity installs the plugin with Worktable's server and skills: `agy plugin install https://github.com/worktable/worktable-plugin`, or from the plugin folder in the Antigravity app.
- In Claude, Plugins can add `worktable/worktable-plugin` as a marketplace, so the plugin updates itself.

## [0.1.8] - 2026-11-07

### Changed

- The HTML skill changes an existing HTML Doc with exact edits and the revision it read, and replaces the whole page only when most of it changes.
- The HTML skill exercises controls that change or delete Records only on Records it created, and asks before touching the user's own.
- The HTML skill points to the guide's advice on pages a reader can take in at a glance.
- The plugin ships a security policy.

## [0.1.7] - 2026-10-28

### Changed

- Thread guidance has agents that can run on Worktable's events, such as ChatGPT, watch with an event trigger rather than a timed schedule.

## [0.1.6] - 2026-10-28

### Changed

- Skills use Worktable's smaller set of tools, each of which does one thing with plain arguments.

## [0.1.5] - 2026-10-28

### Changed

- Skills use individual discovery tools and the file tool names, with fallbacks for older connections.
- Thread guidance covers naming conversations and watching addressed comments and messages.
- Space setup pins only the one or two Docs to read first.

## [0.1.4] - 2026-10-09

### Changed

- Skill guidance calls a Space's lead documents pinned docs, matching the app and the `pins` field agents read and set.

## [0.1.3] - 2026-10-06

### Changed

- The setup skill now ships separately from the plugin, so the plugin bundles six skills that never run local commands. Download Set up Worktable from its page in the documentation when you want an agent to set up Worktable on your computer.

## [0.1.2] - 2026-10-06

### Added

- A setup skill that helps install Worktable, connect an agent to an existing workspace, and add skills.
- Directory listing metadata for Anthropic's plugin directory and OpenAI's plugin directory, including the support page.

### Changed

- Updated skill guidance for exact text edits, document search and ranged reads, drawings, Start here pins, and content lifetimes.
- Rewrote the package README to describe what the plugin does, where its data goes, and when the setup skill runs the official installer.

## [0.1.1] - 2026-09-13

### Changed

- Updated thread guidance for mentions, assigned responses, and replies that complete delivered work without creating reply loops.

## [0.1.0] - 2026-08-07

### Added

- A portable Agent Plugins 1.0 package with six Worktable skills and one remote MCP connection.
- Compatibility adapters for Claude Code and OpenAI clients.
- Setup, privacy, support, update, and removal guidance.

### Changed

- Successful MCP results retain structured content and use a compact JSON text fallback.
