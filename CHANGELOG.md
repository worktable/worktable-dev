# Changelog

All notable, user-facing changes to Worktable are documented here. This file is
the source for published release notes: the release workflow extracts the section
matching the version being released. Agent PRs bind one public-docs and release-note decision
to their final head before readiness; a post-merge workflow handles a missing result. Entries are reviewed
before a release is cut. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

Keep entries public-safe — describe what changed for someone _using_ Worktable.
No internal infrastructure, repository names, PR numbers, or commit SHAs.

## [Unreleased]

## [0.1.8] - 2026-09-22

### Fixed

- **Settings startup:** Update notifications and other shortcuts open Settings reliably while the sidebar is still loading.

## [0.1.7] - 2026-09-22

### Changed

- **Faster document opening:** Saved document content appears sooner while the editor prepares, with smaller initial downloads and faster large-document initialization.

### Fixed

- **Consistent loading:** Documents and HTML docs use coordinated loading states, with the opening status in the existing sync indicator and matching document spacing.
- **Document navigation:** Renamed documents and folders open reliably, and the editor preserves the reading position when it becomes ready.

## [0.1.6] - 2026-09-22

### Added

- **Linked devices:** A limited Cloud rollout connects AI apps and read-only document sharing to up to three local or self-hosted installations while online.

### Fixed

- **Local installation:** Installation links point to the supported CLI setup while signed Desktop downloads are unavailable in the current release.



## [0.1.5] - 2026-09-20

### Added

- **Open source:** Worktable source is available under AGPL-3.0-only, with source links in the app and existing component licenses retained.

### Fixed

- **Connector downloads:** Standalone agent connectors and Claude Desktop extensions retain application licensing, third-party notices, and the exact public source reference in public builds.

- **Local access controls:** Local browser access is restricted to Worktable, and scoped credentials and token revocation are enforced across REST and realtime connections.

- **Review attribution:** Agent changes retain agent attribution, and human review actions require the human owner.

- **MCP bridge shutdown:** Local bridge processes exit cleanly when their client disconnects.

- **OpenClaw connection recovery:** Connections recover after failed initialization, and stopping a connection cancels pending setup requests.

## [0.1.4] - 2026-09-13

### Changed

- **Agent thread guidance:** Marketplace plugins now distinguish mentions, assigned responses, and replies without triggering unintended reply loops.

### Added

- **Drawing documents:** Sketch alongside your docs with Quickdraw, automatic saving, PNG export, and agent access on Worktables using V2 document storage.

- **Unified document workflows:** Connected agents can browse, search, read source, create, edit, version, move, archive, restore, and delete supported document formats through shared tools.

- **Movable HTML docs:** File HTML docs into folders while bookmarks, agent reads, history, comments, and saved interface state follow the new path.

- **Movable document folders:** Rename folders containing both Docs and HTML Docs while bookmarks, history, comments, and open views follow the move.

- **Archived document folders:** Archive and restore folders containing both Docs and HTML Docs as one change from the sidebar or connected agents.

- **Permanent document folders:** Permanently delete folders containing both Docs and HTML Docs as one all-or-nothing change from the sidebar or connected agents.

- **Interactive folder homes:** Agent-built HTML docs can open supporting documents directly, with links that keep working when paths move.

- **Plain-file HTML docs:** V2 workspaces store HTML beside Markdown and rich-text documents, with safe default permissions for files added directly on disk.

### Fixed

- **Lighter editing cursor:** The document editor now uses the lighter code-accent blue for a softer cursor in dark mode.

- **Safer document changes:** Format conversion, moving, version restoration, and deletion now preserve document identity and recover cleanly if Worktable stops mid-change.

- **Rich document annotations:** Block handles remain available after adding or cancelling an annotation, so you can continue working without refreshing.

## [0.1.3] - 2026-08-22

### Changed

- **Unified artifact controls:** Documents, HTML docs, records, and threads now share consistent navigation, header actions, contextual panels, and responsive drawers.

- **Markdown editing:** Edit Markdown docs as rich text and save compatible rich docs back to Markdown.

### Added

- **Collaborative threads:** Threads now support group conversations, visible mentions, directed replies, and automatic replies from always-on agents in one-on-one threads.

- **Help in Settings:** Find support, documentation, privacy, and terms links in Settings, with policies matched to each deployment.

### Fixed

- **External link navigation:** Links to other websites from documents and thread messages now open in a new tab instead of replacing Worktable.

- **Reliable in-app updates:** Starting another update no longer reloads Settings early or leaves the completed update still appearing as available.

## [0.1.2] - 2026-08-12

### Added

- **Guided first setup:** New Worktables now collect names, connect multiple agents through deployment-appropriate steps, and offer a useful first prompt or OpenClaw Thread.

### Fixed

- **Reliable Cloud checkout:** Checkout now opens correctly and unpaid sessions return to the checkout action instead of waiting for a payment that has not started.

## [0.1.1] - 2026-08-10

## [0.1.0] - 2026-08-10

### Added

- **Cloud document sharing:** Share live, view-only Docs and safe HTML representations with an unlisted link.
- **Agent skill installation:** Install and manage Worktable skills for Claude, ChatGPT/Codex, and other compatible agents through plugin packages, Desktop, the CLI, a standalone installer, or automatically via OpenClaw.

### Changed

- **Clearer billing and setup:** Worktable now uses simpler language and stronger action hierarchy across billing, Desktop setup, recovery, and updates.
- **Smaller agent results:** Worktable keeps structured MCP results while sending a compact JSON text fallback.
- **Neutral agent discovery:** Worktable now exposes factual MCP metadata and technical format and runtime contracts while distributing optional workflow guidance as Agent Skills.

### Fixed

- **Polished desktop chrome:** Desktop toolbars now share the macOS title bar, align document breadcrumbs consistently, and preserve the intended cursor over interactive workspace content.

## [0.0.53] - 2026-08-05

### Changed

- **Reliable agent tool results:** Worktable now publishes and validates structured output contracts for every MCP tool.

### Fixed

- **Reliable first launch:** Worktable now handles a rare startup timing race without interrupting workspace setup.

## [0.0.52] - 2026-08-05

### Added

- **Official ChatGPT plugin:** use Worktable as ChatGPT Company Knowledge, create durable Docs, HTML workspaces, and Records, and exchange thread messages while ChatGPT is active.
- **Cloud support:** get account, billing, connection, and workspace help from a dedicated public support page.

### Changed

- **Cleaner sidebar header:** The sidebar now leaves theme controls to Settings → Appearance and gives the logo and workspace search more breathing room.
- **Calmer thread conversations:** Threads now preserve reading position and per-tab drafts while presenting Markdown, reply context, and delivery status more clearly.

### Fixed

- **Reliable agent disconnects:** Retrying a failed Cloud OAuth disconnect no longer restores access from the earlier authorization.

## [0.0.51] - 2026-08-02

### Added

- **Landing discovery:** public sites now provide crawler guidance, agent-readable summaries, structured metadata, and branded social previews.

### Changed

- **More useful first workspace:** new Worktables now open with a guided welcome, practical prompts, a Mermaid-backed rich document, connected Records, and an interactive board.
- **Privacy-focused analytics:** public sites now use cookieless anonymous measurement with Do Not Track support and a per-site opt-out.

### Fixed

- **Reliable local startup:** Worktable now waits for exact ownership proof when a valid local service is temporarily busy.
- **Consistent record queries:** Indexed and file-backed record queries now return the same stable order when sort values match.

## [0.0.50] - 2026-08-01

### Changed

- **Calmer Cloud setup:** new hosted workspaces now show a branded transition with clearer progress and recovery actions while Worktable gets ready.
- **Simplified legal information:** public sites now group legal links separately, with Worktable Cloud refund terms included in its terms of use.

### Fixed

- **OpenClaw plugin installation:** ClawHub installs now include the compiled plugin files required by OpenClaw.

## [0.0.49] - 2026-07-30

### Added

- **Native Worktable Cloud for Desktop:** sign in through the system browser, keep the rotating credential in macOS Keychain, and open the same hosted workspace without exposing tokens to its WebView.
- **Public legal and security policies:** review Worktable and Worktable Cloud terms, privacy, refunds, and vulnerability reporting from each site.

### Fixed

- **Reliable Desktop Cloud sign-in:** Worktable Desktop no longer rejects valid WorkOS sign-in requests when the Mac and gateway clocks differ slightly.

## [0.0.48] - 2026-07-30

### Added

- **Portable workspace packages:** export a compressed `.wtb` with selectable history and an offline browser, then safely replace another workspace while preserving its identity.

## [0.0.47] - 2026-07-30

### Fixed

- **Cloud checkout from Account:** Subscribe now opens secure checkout directly when a signed-in workspace still needs payment.

## [0.0.46] - 2026-07-29

### Added

- **Worktable Cloud subscriptions:** start a $7.99 monthly workspace through secure hosted checkout, manage billing from Account settings, and retain full workspace export if billing access is suspended.

## [0.0.45] - 2026-07-29

### Added

- **Cloud agent setup and management:** connect coding agents without copying tokens, see and disconnect OAuth or OpenClaw connections, and register always-on OpenClaw participants with conversation-limited access.
- **Signed Desktop updates:** Worktable Desktop checks for signed releases, asks before downloading and restarting, and keeps a signed manual recovery path if installation fails.

### Fixed

- **Reliable service restarts:** updates and Desktop restarts now recover when an older runtime lease mislabels a manager-owned background service.

## [0.0.44] - 2026-07-28

## [0.0.43] - 2026-07-27

### Added

- **Worktable-level threads:** general agent conversations now live in Worktable, shown alongside Space threads in one top-level Threads view.

### Changed

- **OpenClaw connects to the whole Worktable:** new pairings no longer require a Home Space.
- **Clearer agent setup:** Settings groups OpenClaw with always-on agents, separates verified connections from access tokens, and shows last use without implying live presence.

### Fixed

- **Cloud document syncing:** hosted documents reconnect and persist edits instead of remaining stuck on "Syncing."
- **Distinct Cloud agents:** separately authorized MCP apps now stay distinct in threads and agent-authored changes, even when they share your account.

## [0.0.42] - 2026-07-26

## [0.0.41] - 2026-07-25

### Added

- **Durable agent conversations:** exchange messages in Space threads, continue follow-ups with the same agent context, follow delivery progress, and catch up after disconnects.

## [0.0.40] - 2026-07-24

### Fixed

- **Accurate document authorship:** version history no longer occasionally labels agent edits as external file changes.

## [0.0.39] - 2026-07-22


### Added

- **Connect Worktable Desktop to your own server:** save multiple self-hosted Worktable origins, sign in with the server's owner page, and switch or forget connections without disturbing local workspaces.

### Changed

- **Calmer update notices:** release badges remain visible, each release is announced once while Worktable is in view, and Settings continues to open on General unless you explicitly choose Review update.
- **Agent setup reorganized into expandable panels:** Quick connect, Desktop apps, and Manual install now live in separate disclosures, with a compact Connections summary that opens automatically when you have one.
- **Cloud sign-out feels native:** confirm in-app before signing out, and land back on the Cloud homepage with a signed-out banner and a one-click way to sign in again.

### Fixed

- **Update checks recover consistently:** concurrent checks are combined, failed checks retry on a bounded schedule, and Worktable never offers a blind update when release information is stale or unavailable.
- **Cloud sign-out works again:** the sign-out button now completes through the gateway's confirmation step instead of failing.

## [0.0.38] - 2026-07-20


### Changed

- **Cloud sign-out now syncs across tabs:** signing out of Worktable Cloud in one tab signs you out of every other open tab too.
- **Install Worktable Desktop from a trusted Mac disk image:** Apple Silicon releases now include a Developer ID signed and Apple-notarized DMG.
- **Connected agents favor Worktable for durable work:** agents now default to keeping context and artifacts in your workspace, preferring HTML docs for visual or interactive results.

## [0.0.37] - 2026-07-20


### Highlights

- **Consolidated the MCP API:** replaced 37 operation tools with 13 capability focused tools (reconnect your MCP client to pick up the change).
- **Connect desktop AI apps without editing config files:** a new Desktop apps panel in Settings → Agents lets you install a Claude Desktop extension or copy a direct endpoint for ChatGPT desktop.
- **Closing the desktop window no longer quits Worktable on macOS:** your workspace and agent connections stay live; reopen from the Dock or use Quit to fully shut down.

### Changed

- **Desktop setup feels at home on macOS:** first run begins with connection selection, calmer workspace guidance, and persistent workspace controls in the native app menu.
- **Desktop and CLI share one local workspace:** Desktop detects an existing CLI or background service install and offers to attach instead of starting a duplicate server.
- **Simpler Desktop connection-trouble screen:** it now leads with one recommended action, with logs and other options tucked behind a "More options" disclosure.
- **Consistent brand icon everywhere:** the sidebar, favicons, desktop app icon, and installable app icons now all use the same Worktable mark.

### Fixed

- **Fixed a false setup error:** Desktop no longer showed a "couldn't connect" screen while a new workspace was still finishing initial setup.
- **Codex connection respects a custom `CODEX_HOME`:** connecting Codex now writes its config to the location Codex actually reads when `CODEX_HOME` is set.
- **Workspace folder picker opens where you'd expect:** in Desktop, choosing a workspace folder now starts at your current or previously selected location instead of the OS default.
- **Sidebar toggle lines up with content:** the header's sidebar toggle now aligns with the content gutter instead of sitting slightly offset.

## [0.0.36] - 2026-07-17


### Changed

- **Settings adapt to your deployment:** Worktable Cloud hides local-only controls like Workspace URL and update checks, showing only settings that apply to your install.
- **Darker desktop sidebar:** the sidebar now sits visually recessed behind the main content, with clearer text hierarchy for space and navigation labels.

### Fixed

- **Codex connections repair reliably:** connecting or repairing Codex could leave its config broken; setup now repairs and validates it every time.

## [0.0.35] - 2026-07-16


### Fixed

- **Safer agent pairing:** connecting a client now checks every selected client before writing any config, and rolls back all changes if a check fails.

## [0.0.34] - 2026-07-16

## [0.0.33] - 2026-07-16


### Added

- **Cloud sign-out:** Account settings now shows your Cloud sign-in status with a clear Sign out action, landing you on a plain page to sign in again.

### Changed

- **Toasts match the design system:** notifications now use consistent styling, status colors and icons, and typography across the app.

### Fixed

- **Fixed docs stuck on "Syncing":** opening a doc right as its workspace comes online no longer leaves it stuck; it now syncs without a manual refresh.
- **Fixed Desktop setup hang:** a fresh Desktop install could get stuck before reaching the Welcome space; it now completes reliably.

## [0.0.32] - 2026-07-15


### Changed

- **Cloud agent connections use OAuth:** Worktable Cloud's Agents settings now walk you through OAuth sign-in instead of local access tokens, which aren't available there.
- **Smoother Cloud first run:** setting up a new Worktable Cloud workspace now shows a live status page instead of reloading, and takes you in automatically once it's ready.

## [0.0.31] - 2026-07-14


### Highlights

- **Records get new capabilities:** document links, index health checks with a one-click reconcile, and gentle schema advisories for oversized or duplicate fields.
- **Records get a fresh look:** the detail view opens in a resizable panel or full page, and the table gained a compact toolbar and reorderable columns.

### Added

- **Portable workspace export and import:** the CLI can now export your workspace to a single snapshot file and import it as a new workspace.

### Changed

- **Flatter, more neutral controls:** buttons, inputs, selects, checkboxes and switches shed their raised bevel for a cleaner flat look, with clearer shadows on menus and dialogs.

### Fixed

- **Version history ordering:** docs and widgets with versions saved in the same millisecond now correctly show the latest one as current, not an older one.
- **Mobile navigation drawer polish:** the mobile sidebar no longer shows overlapping translucent panels against the dimmed background.
- **Installed app launch scope:** fixed an issue where the installed Worktable app could open outside its intended window scope.
- **More reliable restarts:** the app now waits for in-progress edits to save before restarting, so changes are no longer lost.

## [0.0.30] - 2026-07-13


### Added

- **Shareable links from agent replies:** when an agent creates or edits a doc or widget, it can now share a clickable link back to you in chat.

### Changed

- **Sharper HTML doc design guidance:** agent-generated HTML docs and widgets now follow stronger visual design and comprehension standards for more polished, easier-to-scan results.

### Fixed

- **Editor hang on internal doc links:** documents containing a link to another doc no longer freeze the editor.

## [0.0.29] - 2026-07-11


### Fixed

- **Sidebar search polish:** result rows now have clear spacing, pressing Enter opens the top result, and excerpts no longer show raw markdown or repeat the title.

## [0.0.28] - 2026-07-11


### Highlights

- **Filter, group, and customize records:** narrow and group the records table, show or reorder columns, and preserve the current filters and table arrangement in shareable links.
- **Edit records and schemas inline:** edit any cell in place, manage a record fully from the peek panel, and add, rename, retype, or delete collection fields, right in the UI.

### Added

- **Search from any page:** the sidebar now has a persistent search that finds docs and records across your workspace, with match excerpts and highlights.
- **Update notifications:** a dot on the Settings button and a one-time toast let you know when a new version of Worktable is available.

### Changed

- **Refreshed Settings navigation:** the settings dialog now highlights the active section with a sliding indicator and shows a short description for each one.

### Fixed

- **Renaming a doc no longer breaks its links:** old bookmarks and authored links to a renamed or moved document keep resolving to it instead of 404ing.

## [0.0.27] - 2026-07-11


### Added

- **CLI agent pairing:** `worktable agent invite` and `worktable agent connect` pair a remote agent straight from the command line, no client config to hand-translate.

### Changed

- **No more raw tokens in setup output:** `worktable setup` and `mcp setup` point you to agent pairing instead of printing a bearer token and connection snippet.

## [0.0.26] - 2026-07-11


### Added

- **Records grid:** browse a record collection as a sortable, searchable table with typed columns, and click into any row for full detail.
- **One-line agent connect:** Settings → Agents now leads with a single command that installs and pairs a remote agent, with live status as each step completes.

### Changed

- **Connections replace access tokens:** the Agents settings list shows connected clients and machines with a last-seen status, instead of raw token records.

## [0.0.25] - 2026-07-10


### Highlights

- **New Settings:** a unified two-pane dialog (tabbed drawer on mobile) covering General, Appearance, Editor, Agents, History, and System, replacing scattered configuration screens.

### Added

- **Agent access tokens:** mint, reveal once, and revoke tokens for connecting AI clients, with a paste-ready connection snippet.
- **Doc version-history retention:** choose how long doc versions are kept: everything, 90 days, 30 days, or the last 50 per doc.
- **Automatic update checks:** choose whether Worktable checks for updates in the background.
- **Resizable sidebar:** drag the sidebar's edge to resize it; your preferred width is remembered.

### Changed

- **`worktable mcp print-config`:** shows token guidance for every client when a reachable install has no token yet, instead of a snippet that would fail.

## [0.0.24] - 2026-07-09

_Maintenance release._

## [0.0.23] - 2026-07-08


### Highlights

- **Widgets are now HTML docs:** one kind of doc alongside markdown and rich text, living in the same sidebar tree, folders, and space overview.
- **Version history for HTML docs:** every change (yours, an agent's, or on disk) becomes a restorable version you can browse, compare, and restore.
- **Annotations and freshness on HTML docs:** the same comments, review state, and stale markers your other docs already have.

### Changed

- **HTML docs open in place:** full-bleed in the main pane with a fullscreen toggle, instead of a framed preview that launched a browser tab.
- **Folders for agents:** agents can file HTML docs into folders by creating them with slash-style ids (for example `plans/q3-redesign`).
- **Mermaid editor:** diagram blocks open with the source collapsed, and the editor follows your light or dark theme.

### Added

- **Copy HTML:** copies an HTML doc's full source from the header or its menus, ready to paste into a conversation or another tool.
- **Archived banner:** archived HTML docs show a banner with one-click Restore, matching docs.
- **Live sidebar updates:** agent changes to HTML docs (create, rename, archive, delete) appear in the sidebar immediately.

### Fixed

- **Mermaid in exports:** copying, exporting, or reading a doc no longer drops its Mermaid diagrams; they come through as code blocks.
- **Table colors:** cells with custom text or background colors keep that formatting when saved.
- **Block selection outline:** selecting a Mermaid, image, or file block no longer shows a misaligned double outline.

## [0.0.22] - 2026-07-07


### Added

- **Doc export:** download any doc as a `.md` file, or print and save it as a clean PDF, from the header's export menu.

### Fixed

- **Mobile topbar icon:** shows the Worktable app icon instead of a generic lightning bolt.

## [0.0.21] - 2026-07-05


### Added

- **Nameless doc creation:** leave the name blank and Worktable names the doc `untitled`, then adopts its first heading as the title.
- **Copy as Markdown:** copies the current doc as clean markdown, even when it started as a rich document.
- **Sidebar drag-and-drop:** reorder documents and folders; your custom order is saved and syncs across clients.

### Changed

- **Docs site redesign:** a cleaner, flatter look with Worktable branding and tabbed navigation (Documentation, Agents, Reference, Changelog).
- **Select-all scope:** Cmd/Ctrl+A selects only document content, not the sidebar or header.
- **Live sidebar titles:** titles and freshness indicators update as you type instead of lagging behind.

### Fixed

- **Breadcrumb alignment:** the title no longer appears indented relative to its siblings when not hovered.
- **Breadcrumb popover:** removed a redundant "reviewed" sentence.

## [0.0.20] - 2026-07-04

_Maintenance release._

## [0.0.19] - 2026-07-04


### Highlights

- **Doc freshness in the app:** every open doc shows who last touched it and how long ago, stale docs get a sidebar marker, and Mark Reviewed clears it.
- **Richer records:** new field types, typed relations between collections, and a far more capable query language, with existing collections and queries unchanged.
- **Reachable mode stays put:** a network-reachable Worktable now remains reachable across restarts, reboots, and updates instead of quietly falling back to local-only.

### Added

- **Record field types:** text, url, email, person, select and multi-select, typed relations (single or list), and numbers with units.
- **Record queries:** and/or/not filters, filtering through relations, multi-field sort, cursor pagination, expanded references, backlinks, and grouped counts, sums, and averages.
- **Relation integrity:** per-field delete policies block or clear references to a deleted record, and dangling references surface as collection warnings.
- **Widget query permissions:** widgets following relations or expanding references need read permission on those collections too.
- **Collection descriptions:** collections and fields carry descriptions agents can see, plus an optional well-known type hint (like schema:Person).
- **Update visibility:** `worktable status`, `update --check`, Settings, and a one-line post-command nudge all report when a newer release is available.

### Fixed

- **Read-only commands:** `status`, `doctor`, `paths`, and `mcp status` never rewrite your configuration.
- **Durable configuration:** the config file is written durably and backed up; if it is ever unreadable, Worktable restores the last good copy instead of resetting to defaults.
- **Linux service startup:** the background service starts after a reboot on headless machines, and leftover competing service definitions are cleaned up with a warning.
- **Review accuracy:** simply opening an agent-written doc no longer marks it reviewed; only actually editing or interacting with the content does.

## [0.0.18] - 2026-07-03


### Added

- **Unreadable record reporting:** collections report which record files could not be read (and why) to the app, to agents, and once to the server log.
- **`worktable completion install`:** sets up shell tab completion for bash, zsh, or fish; the shell is auto-detected from `$SHELL`.

### Changed

- **Automatic completions:** shell tab completion is installed with Worktable by default; skip with `--no-completions`.
- **Record index:** queries and record search are served from a background index (machine-local, auto-rebuilding, safe to delete); records stay plain YAML files.
- **Widget query validation:** malformed widget queries are rejected with a clear error, and the 1000-result limit applies to widgets too.
- **Forward compatibility:** workspaces written by a newer Worktable stay readable and writable, and edits no longer strip fields this version doesn't understand.

## [0.0.17] - 2026-07-03

### Added

- **Space Home:** opening a space shows a generated overview (docs by folder, backlinks, stale markers, a needs-attention strip); agents get the same index read-only.
- **Doc freshness signals:** doc reads and search results carry how recently a human touched a doc and whether it has gone stale; reviews record a human checkpoint.
- **Wiki lint:** broken links, orphaned docs, and over-long docs are flagged as annotations that update and resolve themselves.
- **Write guidance for agents:** agent doc writes return convention warnings (broken links, missing title, deep folders) without blocking anything.
- **Documentation site:** docs.worktable.dev, with install guides, concepts, and reference material.

## [0.0.16] - 2026-06-28

### Added

- **Software update flow:** Settings shows the running version and updates Worktable in place (downloads in the background, then restarts into the new release).
- **Records in search:** records now appear in workspace search results.

### Fixed

- **Record query types:** numeric and date fields sort and filter by value, and combined filters (like a date range) apply all their conditions.
- **Concurrent record writes:** simultaneous edits no longer overwrite each other, and same-title creates no longer collide.
- **Widget network permission:** widgets reach the network only when their network permission is enabled.

## [0.0.15] - 2026-06-28

### Changed

- **Brand refresh:** new Worktable brand mark and app icons.

## [0.0.14] - 2026-06-27

### Changed

- **Clean doc file names:** file names are slugs derived from the title (`Planning Onsite` becomes `planning-onsite`); lists show the doc's first heading as its title.

### Fixed

- **History survives rename:** renaming a doc no longer detaches its version history.
- **Docs with spaces:** names with spaces no longer produce duplicate copies during live editing.
- **Annotation anchors:** badges re-anchor to their quoted text when a doc is rewritten, and each annotation shows the text it refers to.

## [0.0.13] - 2026-06-27

<!-- Not published; its changes shipped in 0.0.14. -->

## [0.0.12] - 2026-06-27

### Added

- **Uninstall preview:** `worktable uninstall` shows exactly what it will remove, accepts `--yes`, and offers `--purge` to also delete the workspace folder.

### Changed

- **Default port 7480:** setup checks the port before writing configuration and asks for (or picks) a free one when it is taken; existing installs keep theirs.

### Fixed

- **Claude Code connect:** connecting during setup no longer fails with a "missing required argument" error.

## [0.0.11] - 2026-06-27

### Added

- **`wtb` alias:** a short alias for the `worktable` command, installed alongside it.

### Changed

- **Clearer setup and status:** setup explains each choice before asking, and `worktable status` says why an agent client isn't connected.
- **Simpler exposure gating:** reaching Worktable beyond your machine is gated by the owner password alone; the redundant `--insecure` flag is gone.

## [0.0.10] - 2026-06-27

<!-- Not published; its changes shipped in 0.0.11. -->

## [0.0.9] - 2026-06-26

### Added

- **Optional network access:** setup can make Worktable reachable beyond your machine (off by default), protected by an owner password and an agent token.

### Changed

- **Workspace adoption:** setup names the workspace it adopts, and refuses (with a clear message) folders that already hold unrelated files.

### Fixed

- **Workspace identity:** an unfamiliar or unreadable identity file is never overwritten, so an existing workspace keeps its identity across upgrades.

## [0.0.8] - 2026-06-21

_Maintenance release._

## [0.0.7] - 2026-06-19

### Fixed

- **One-liner install:** the `curl | sh` installer's prompts now read from your terminal, and no longer crash partway through on macOS.
- **Setup restart:** re-running `worktable setup` while the service is running restarts it, so updated settings take effect right away.

## [0.0.6] - 2026-06-18

### Added

- **Linux arm64 support:** the installer detects arm64 machines and installs the matching build (Raspberry Pi, Ampere, Graviton).

## [0.0.5] - 2026-06-18

### Added

- **Shell completions:** for bash, zsh, and fish, with an installer option to set them up for your current shell.

### Changed

- **CLI subcommands:** the `worktable` CLI is organized into clearer subcommands, easier to discover from `--help`.

### Fixed

- **Explicit update version:** `worktable update <version>` accepts an explicit version correctly.
- **Startup reliability:** a more dependable health check before treating a local server as running, and clearer errors when launch or service start fails.

## [0.0.4] - 2026-06-18

### Added

- **Service without systemd:** a portable fallback keeps Worktable running in the background on Linux hosts without a system service manager.

### Changed

- **Setup default:** press Enter to accept the suggested workspace location.

### Fixed

- **Service status:** the background service reports accurate running status and keeps running after you close the terminal that started it.

## [0.0.3] - 2026-06-17

- Early releases predate this changelog; see the GitHub releases page for history.
