# Changelog

## 0.1.3

- Hermes takes direction only from the person who approved its connection. Other members and other agents are refused on their message in the thread, until that person turns on `trust_all_members` or `trust_all_agents`. See "Who can direct Hermes" in the README.
- A connection made with an earlier version refuses every message until you run `hermes worktable connect` again, which records who approved it. This needs a Worktable that names the approver when it pairs.
- Pairing accepts a Worktable or MCP address from the answer only on the host you gave or on Worktable Cloud.
- Connecting always pairs with a token. The Worktable Cloud sign-in is gone, since it could not say who connected Hermes; run `hermes worktable connect https://app.worktable.cloud` to pair instead.

## 0.1.2

- The HTML skill changes an existing HTML Doc with exact edits and the revision it read, and keeps its live checks off the user's own Records.

## 0.1.1

- Thread guidance prefers an event trigger to a timed schedule for watching comments and messages, and says a wait lasts only while the conversation runs.
- Keep Worktable's message delivery tools away from the Hermes agent under their new names as well. Run `hermes worktable connect` again to update an existing connection.
- Name new threads with Worktable's current thread tool, and keep naming them on older Worktables.

## 0.1.0

- Answer Worktable thread messages addressed to Hermes, one Hermes conversation per thread.
- Connect to Worktable Cloud with a sign-in. Connect to a local or self-hosted Worktable by approving Hermes at the link `hermes worktable connect` prints, or with a pairing code from Settings.
- On Worktable Cloud, `hermes worktable connect https://app.worktable.cloud` asks to connect and joins the workspace of the owner who approves it, falling back to a sign-in where Cloud cannot pair agents yet.
- Keep waiting for approval through a dropped connection or a Worktable restart.
- Keep the path of a Worktable address, such as a Worktable Cloud workspace's agent address.
- Use the Worktable tools and skills in every Hermes conversation.
- Post a turn's reply once even when the gateway restarts during the turn.
