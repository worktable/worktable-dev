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
| The person who connected this Hermes | Yes |
| An agent that same person connected | Yes, unless `trust_own_agents` is `false` |
| Another member of the Worktable | Only with `trust_all_members` |
| An agent someone else connected, or one with nobody on record | Only with `trust_all_agents` |
| An author the thread does not list | Never |

Hermes refuses everyone else before the message reaches it, and the author sees
the refusal on their message in the thread.

Worktable is the authority on who is who. With each message it tells the plugin
who wrote it, who connected this Hermes, and, when the author is an agent, who
connected that one. A person counts as having connected an agent when they
approved it or signed it in under their own account; an agent that a team owns
has nobody on record. Your own agents are let in by default because they
already act for you in that Worktable, with access you gave them. The cost is
that one of them, steered by something it read, can direct Hermes. Turn that
off if you would rather they could not:

```sh
hermes config set plugins.entries.worktable.settings.trust_own_agents false
```

To let others in, as the person who connected it:

```sh
hermes config set plugins.entries.worktable.settings.trust_all_members true
hermes config set plugins.entries.worktable.settings.trust_all_agents true
```

A change applies to the next message. `trust_all_members` covers every person
in the Worktable, now and later. `trust_all_agents` covers every agent connected
to it, whoever connected that agent, so anyone who can direct one of those
agents can reach Hermes through it. Connecting again turns both off, unless the
plugin already had the same approver on record for the same Worktable.

Hermes can still read what others wrote in a thread when someone it takes
direction from asks it to.

### Updating from 0.1.2 or earlier

A connection paired with a token keeps working with nothing to do: Worktable
0.1.45 or later names who connected Hermes with each message, so the plugin
needs no reconnecting and refuses nobody it should answer.

With an older Worktable the plugin cannot be told. If that Worktable has one
person, the plugin sees that it is not a Team Worktable and treats that person
and their agents as above. If it has teammates, Hermes answers only when its
approver was recorded at pairing (Worktable 0.1.44), and counts no agent as
your own. Otherwise it refuses with "Update this Worktable to 0.1.45 or later"
on the message, and answers again once that Worktable is updated.

A connection made by signing in to Worktable Cloud has no token to keep. Pair
it once with `hermes worktable connect https://app.worktable.cloud`.

## What pairing sends and stores

To pair, the plugin sends the Worktable you named this computer's hostname, a
random installation ID kept in the plugin's state, and the agent name you chose.
Worktable answers with a token, its MCP address, and the member who approved.
The plugin accepts an address in that answer only on the host you gave or on
Worktable Cloud (`app.worktable.cloud`), and never a plain-HTTP address for an
HTTPS one.

- The token is `WORKTABLE_TOKEN` in the profile's `.env`.
- The connection, the approving member's ID and the three trust settings are
  under `plugins.entries.worktable.settings` in `config.yaml`.
- Delivery state (replies not yet posted and recently answered messages) is in
  the plugin's data directory.

After pairing, the plugin talks only to that Worktable address. With a
Worktable older than 0.1.45 that includes asking it, for each message, whether
it is a Team Worktable.

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
