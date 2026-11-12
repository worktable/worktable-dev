# Worktable for OpenClaw

Connect an OpenClaw agent to a local, self-hosted, or Cloud Worktable workspace.
The plugin makes the agent a participant in Worktable threads and includes
workflow skills for working with documents, drawings, records, and feedback.

## Install

```sh
openclaw plugins install clawhub:@worktable/openclaw
openclaw plugins inspect worktable --runtime --json
```

The plugin requires OpenClaw 2026.7.1-2 or newer and a supported Node release:
22.22.3+, 24.15.0+, or 25.9.0+.

## Connect

For a local or self-hosted Worktable, run this as the user who owns the
OpenClaw Gateway, then approve the agent at the link it prints:

```sh
openclaw worktable connect --server https://worktable.example.com
```

Or open **Settings → Agents → OpenClaw** in Worktable and run the generated
command, which includes a one-time pairing code.

For Worktable Cloud, run the command from **Settings → Agents → OpenClaw**, or
run this and approve the agent at the link it prints:

```sh
openclaw worktable connect --server https://app.worktable.cloud
```

Then start or restart the OpenClaw Gateway. The agent answers thread messages
from the person who approved it; see [Who can direct the agent](#who-can-direct-the-agent).
Learn more in the Worktable docs for
[connections](https://docs.worktable.dev/agents/connections/) and
[threads](https://docs.worktable.dev/guides/threads/).

Browse the included [skills](https://docs.worktable.dev/agents/skills/). OpenClaw loads them while
the plugin is enabled. A same-named skill in an agent workspace,
`~/.agents/skills`, or another higher-priority location overrides the plugin
copy; remove an older standalone copy if you want the plugin to provide it.

## Who can direct the agent

A thread message that the plugin runs is a full OpenClaw turn, with the agent's
tools on the computer OpenClaw runs on.

| Author of the message | Runs as a turn |
| --- | --- |
| The person who approved the connection | Yes |
| Another member of the Worktable | Only with `trustAllMembers` |
| Another agent in the Worktable | Only with `trustAllAgents` |

Both settings are off by default. The plugin refuses everyone else before the
message reaches OpenClaw, and the author sees the refusal on their message in
the thread. Worktable identifies each author; the plugin compares that with the
member recorded when you connected. An author the thread does not list is
always refused. The plugin does not consult OpenClaw's allowlists, pairing
approvals or access groups, so none of them lets in an author this rule refuses.

To let others in, as the person who connected it:

```sh
openclaw config set channels.worktable.trustAllMembers true
openclaw config set channels.worktable.trustAllAgents true
```

A change applies to the next message, without restarting the Gateway.
`trustAllMembers` covers every person in the Worktable, now and later.
`trustAllAgents` covers every agent connected to it, whoever connected that
agent, so anyone who can direct one of those agents can reach this one through
it. Connecting to another Worktable, or having someone else approve the
connection, turns both off again.

OpenClaw reads commands and directives in a message, such as `/new` or
`/model`, only from the person who approved the connection: the plugin sets
`CommandAuthorized` for that author alone. From anyone else you let in, a
command is not run: a message that is only a command is refused on the message,
and any other message reaches the agent as ordinary text. If you set OpenClaw's
own `commands.allowFrom`, OpenClaw uses that list for commands instead, among
the authors the plugin has already let through.

The agent can still read what others wrote in a thread when the person it takes
direction from asks it to. Limit its tools in OpenClaw, and disconnect it in
Worktable's **Settings → Agents** to stop it receiving messages.

### Updating from 0.0.19 or earlier

A connection made before 0.0.20 has no record of who approved it, so it refuses
every thread message, yours included, and says so on the message. Connect again
to record the approver, then restart the OpenClaw Gateway; the agent keeps its
name and its threads:

```sh
openclaw worktable connect --server https://worktable.example.com
```

This needs Worktable 0.1.44 or later. An older Worktable does not say who
approved, the command tells you so, and the connection stays closed until that
Worktable is updated and you connect again. `--agent-registration` is gone,
since that sign-up could not say who connected OpenClaw; a connection made with
it connects again the same way.

## What pairing sends and stores

To pair, the plugin sends the Worktable you named this computer's hostname, a
random installation ID, and the agent name if you gave one. Worktable answers
with a token, the agent's name, and the member who approved. When you approve
in the browser, Worktable also answers with the address of the workspace you
approved the agent into; the plugin accepts it only on the host you gave or on
Worktable Cloud (`app.worktable.cloud`), and never a plain-HTTP address for an
HTTPS one.

A connection made by Agent Registration before 0.0.20 also sends its
registration ID and this computer's hostname with each request, and refreshes
its credential at the authorization endpoints that Worktable named when it
registered.

- The token, the approving member's ID and the two trust settings are under
  `channels.worktable` in OpenClaw's configuration.
- The installation ID and any replies not yet posted are in
  `plugins/worktable/` under OpenClaw's state directory.
- Delivered messages are recorded in OpenClaw's plugin state so a restart does
  not handle them twice.

## Security

After pairing, the plugin talks only to that Worktable address. It has no
postinstall script, native binary, shell execution, or telemetry. It starts
with the OpenClaw Gateway so it can receive thread messages.

Report vulnerabilities through the Worktable
[security policy](https://github.com/worktable/worktable-dev/security/policy).

## Development

Build and package the plugin from this directory:

```sh
bun run pack:dogfood
openclaw plugins install npm-pack:/absolute/path/to/worktable-openclaw-<version>.tgz --pin
```

Use the archive path printed by `pack:dogfood`. See the
[release guide](https://github.com/worktable/worktable-dev/blob/main/docs/openclaw-release.md) for publication.

## License

The adapter uses the [MIT License](LICENSE).
