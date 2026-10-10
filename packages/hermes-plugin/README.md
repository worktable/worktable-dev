# Worktable for Hermes

Connect [Hermes Agent](https://hermes-agent.nousresearch.com/) to
[Worktable](https://www.worktable.cloud), a workspace for Docs, interactive HTML
Docs, structured Records, annotations, and threads shared with people and other
agents.

With the plugin, Hermes:

- answers Worktable thread messages addressed to it, in one Hermes conversation
  per thread;
- uses the Worktable tools in any of its conversations;
- has Worktable's skills for finding context, writing Docs, building HTML Docs,
  organizing Records, reviewing with annotations, and collaborating in threads.

Requires Hermes 0.21.5 or later.

## Install

```sh
hermes plugins install worktable/worktable-dev#packages/hermes-plugin --enable
```

## Connect

**Worktable Cloud:**

```sh
hermes worktable connect https://app.worktable.cloud
```

Sign in when Hermes opens the Worktable sign-in page. On a computer without a
browser, open the printed link on another device and paste the final address
back into Hermes.

**Local or self-hosted Worktable:** in Worktable, open **Settings → Agents →
Hermes**, select **Connect**, and run the command it shows:

```sh
hermes worktable connect https://worktable.example.com --pairing-code ABCDE-12345
```

Then restart the gateway:

```sh
hermes gateway restart
```

`hermes worktable status` shows the connection. `hermes worktable disconnect`
removes it from the Hermes profile; disconnect the agent in Worktable's
**Settings → Agents** to revoke its access.

## What it stores

- **Cloud:** Hermes keeps the Worktable sign-in in its own MCP OAuth storage.
- **Self-hosted:** the paired token is `WORKTABLE_TOKEN` in the profile's `.env`.
- The connection settings are under `plugins.entries.worktable` in
  `config.yaml`. Delivery state (replies not yet posted and recently answered
  messages) is in the plugin's data directory.

The plugin talks only to the Worktable address you connect.

## How replies work

The plugin claims messages addressed to this Hermes, runs each one in the
thread's Hermes conversation, and posts Hermes' final reply to the thread. It
claims through Hermes' own Worktable MCP connection, so it needs no separate
credential, and it keeps the delivery tool out of the agent's toolset.

If the gateway stops mid-turn, Hermes resumes the turn when it restarts and the
plugin posts that reply when Worktable offers the message again. A message that
Hermes did not resume runs again.

## Development

The skills in `skills/` are a generated copy of `plugins/worktable/skills`.
Edit those sources, then run `bun run generate:hermes-skills` from the
repository root.

Run the tests with Hermes installed in the same Python environment:

```sh
python -m pytest
hermes plugins validate .
hermes plugins doctor . --ci
```

## License

MIT. See [LICENSE](LICENSE).
