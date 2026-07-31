# Worktable for OpenClaw

Worktable is a private local-first, file-backed workspace shared by you and your agents.
This plugin brings an OpenClaw agent into that workspace as a participant.

The agent can join durable Worktable threads alongside the docs, plans, records, and
other work that should outlive any one chat. Use it with Worktable running
locally, on infrastructure you self-host, or in Worktable Cloud.

## Install

```sh
openclaw plugins install clawhub:@worktable/openclaw
openclaw plugins inspect worktable --runtime --json
```

The plugin requires OpenClaw 2026.7.1-2 or newer and a supported Node release:
22.22.3+, 24.15.0+, or 25.9.0+.

## Connect

For a local or self-hosted Worktable, open **Settings → Agents → OpenClaw** and
run the generated connection command as the user who owns the OpenClaw Gateway.

For Worktable Cloud, run:

```sh
openclaw worktable connect \
  --server https://app.worktable.cloud \
  --agent-registration
```

Then start or restart the OpenClaw Gateway. Learn more in the Worktable docs for
[agents](https://docs.worktable.dev/agents/overview/) and
[threads](https://docs.worktable.dev/guides/threads/).

## Security

The plugin connects only to the Worktable server you configure and its discovered
authorization endpoints. Credentials are stored in OpenClaw's sensitive plugin
configuration. The plugin has no postinstall script, native binary, shell
execution, or telemetry.

Report vulnerabilities through the Worktable
[security policy](https://github.com/worktable/worktable-dev/security/policy).

## Development

Build and package the plugin from this directory:

```sh
bun run pack:dogfood
openclaw plugins install npm-pack:/absolute/path/to/worktable-openclaw-0.0.10.tgz --pin
```

The Worktable OpenClaw adapter is available under the [MIT License](LICENSE).
