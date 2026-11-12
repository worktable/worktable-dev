# Changelog

## 0.0.20

- The agent takes direction from the person who connected it and from the other agents that person connected. Other members and other people's agents are refused on their message in the thread, until that person turns on `trustAllMembers` or `trustAllAgents`. `trustOwnAgents false` turns the owner's own agents off. See "Who can direct the agent" in the README.
- An existing connection needs no reconnecting: Worktable 0.1.45 or later names who connected each agent with every message. With an older Worktable the plugin answers a one-person Worktable as before, and otherwise says on the message to update Worktable. An agent that a team owns has nobody on record and answers once it is connected again.
- OpenClaw commands in a message are read only from the person who connected the agent.
- Pairing follows a workspace address from Worktable's answer only on the host you gave or on Worktable Cloud.
- The connect command says why it failed, where OpenClaw printed only that it had.
- `--agent-registration` is gone. Run `openclaw worktable connect --server https://app.worktable.cloud` and approve the agent in Worktable instead. A connection already made with it keeps working.

## 0.0.19

- The README says what the plugin sends to Worktable when it pairs, and that messages addressed to the agent in Worktable run as its owner's commands.

## 0.0.18

- Answer Worktable messages as soon as the Gateway first starts after pairing. Before, the channel stopped once pairing finished, until the Gateway restarted again.
- Name new threads with Worktable's current thread tool, and keep naming them on older Worktables.
- Connect to Worktable with a small built-in client instead of a bundled MCP library. The package is about 80% smaller and bundles no third-party code.
- Let OpenClaw locate its own state directory instead of passing it the process environment.
- Leave Codex and ChatGPT prompt metadata out of the bundled skills. OpenClaw does not use it.

## 0.0.17

- Restore loading on current OpenClaw releases while keeping support for OpenClaw 2026.7.1-2 and later. Credential refresh continues to use the latest saved credentials without requiring reconnection.
- Preserve the existing pairing identity and retained-reply files when using OpenClaw releases that removed the SDK's JSON read helper.

## 0.0.16

- The bundled setup skill links to the Worktable install pages and asks you to run the installer yourself. The agent no longer pipes a downloaded script into a shell.

## 0.0.15

- Show the complete sign-in link when connecting to Worktable Cloud. OpenClaw masked part of it, so the link could not be opened.
- Accept the claim code exactly as Worktable Cloud shows it, including the hyphen.
- Connect to Worktable Cloud the same way: `openclaw worktable connect --server https://app.worktable.cloud` prints a link, and the agent joins the workspace of the owner who approves it.
- Keep the path of a Worktable address, such as a Worktable Cloud workspace's agent address.
- Connect to a local or self-hosted Worktable without a pairing code: `openclaw worktable connect --server <address>` prints a link, and the agent connects once you approve it in Worktable with its name, icon, and access.
- Keep waiting for approval through a dropped connection or a Worktable restart.
- The bundled setup skill covers connecting Hermes as well as OpenClaw.

## 0.0.14

- Keep an agent's reply when Worktable is briefly unavailable or restarts during a turn, and post it once Worktable is back.
- Retry an interrupted turn instead of reporting it as complete.

## 0.0.13

- Include the Worktable skills with the plugin so OpenClaw agents receive the matching workflow guidance automatically.

## 0.0.12

- Restore the compiled plugin files required by ClawHub installs.

## 0.0.11

- Update the bundled URL parser to its patched release.

## 0.0.10

- Present Worktable as the persistent workspace shared with OpenClaw agents and add the Worktable icon to the ClawHub listing.

## 0.0.9

- Publish the Worktable adapter through ClawHub with standalone source, explicit compatibility metadata, and an MIT license.

## 0.0.8

- Preserve durable Worktable thread delivery and add Worktable Cloud Agent Registration.
