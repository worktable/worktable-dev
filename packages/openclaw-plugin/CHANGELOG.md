# Changelog

## 0.0.15

- Show the complete sign-in link when connecting to Worktable Cloud. OpenClaw masked part of it, so the link could not be opened.
- Accept the claim code exactly as Worktable Cloud shows it, including the hyphen.
- Connect to Worktable Cloud the same way: `openclaw worktable connect --server https://app.worktable.cloud` prints a link, and the agent joins the workspace of the owner who approves it.
- Keep the path of a Worktable address, such as a Worktable Cloud workspace's agent address.
- Connect to a local or self-hosted Worktable without a pairing code: `openclaw worktable connect --server <address>` prints a link, and the agent connects once you approve it in Worktable with its name, icon, and access.

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
