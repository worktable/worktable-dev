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

Run connect with your Worktable's address and approve Hermes at the link it
prints, choosing its name, icon, and access. On Worktable Cloud the address is
`https://app.worktable.cloud`:

```sh
hermes worktable connect https://worktable.example.com
```

Or open **Settings → Agents → Hermes** in Worktable, select **Connect**, and
run the command it shows, which includes a one-time pairing code.

Then restart the gateway:

```sh
hermes gateway restart
```

`hermes worktable status` shows the connection and who Hermes takes direction
from. `hermes worktable disconnect` removes it from the Hermes profile;
disconnect the agent in Worktable's **Settings → Agents** to revoke its access.

## Who can direct Hermes

A thread message that Hermes runs is a full Hermes turn, with this profile's
terminal, file and MCP tools on the computer Hermes runs on. Gateway commands
and `/update` stay off for every thread author.

| Author of the message | Runs as a turn |
| --- | --- |
| The person who approved the connection | Yes |
| Another member of the Worktable | Only with `trust_all_members` |
| Another agent in the Worktable | Only with `trust_all_agents` |

Both settings are off by default. Hermes refuses everyone else before the
message reaches it, and the author sees the refusal on their message in the
thread. Worktable identifies each author; the plugin compares that with the
member recorded when you connected.

To let others in, as the person who connected it:

```sh
hermes config set plugins.entries.worktable.settings.trust_all_members true
hermes config set plugins.entries.worktable.settings.trust_all_agents true
```

A change applies to the next message. `trust_all_members` covers every person
in the Worktable, now and later. `trust_all_agents` covers every agent connected
to it, whoever connected that agent, so anyone who can direct one of those
agents can reach Hermes through it. Connecting to another Worktable, or having
someone else approve the connection, turns both off again.

Hermes can still read what others wrote in a thread when the person it takes
direction from asks it to.

## What pairing sends and stores

To pair, the plugin sends the Worktable you named this computer's hostname, a
random installation ID kept in the plugin's state, and the agent name you chose.
Worktable answers with a token, its MCP address, and the member who approved.
The plugin accepts an address in that answer only on the host you gave or on
Worktable Cloud (`app.worktable.cloud`), and never a plain-HTTP address for an
HTTPS one.

- The token is `WORKTABLE_TOKEN` in the profile's `.env`.
- The connection, the approving member's ID and the two trust settings are
  under `plugins.entries.worktable.settings` in `config.yaml`.
- Delivery state (replies not yet posted and recently answered messages) is in
  the plugin's data directory.

After pairing, the plugin talks only to that Worktable address.

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
