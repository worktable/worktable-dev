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

For a local or self-hosted Worktable, open **Settings → Agents → OpenClaw** and
run the generated connection command as the user who owns the OpenClaw Gateway.

For Worktable Cloud, run:

```sh
openclaw worktable connect \
  --server https://app.worktable.cloud \
  --agent-registration
```

Then start or restart the OpenClaw Gateway. Learn more in the Worktable docs for
[connections](https://docs.worktable.dev/agents/connections/) and
[threads](https://docs.worktable.dev/guides/threads/).

Browse the included [skills](https://docs.worktable.dev/agents/skills/). OpenClaw loads them while
the plugin is enabled. A same-named skill in an agent workspace,
`~/.agents/skills`, or another higher-priority location overrides the plugin
copy; remove an older standalone copy if you want the plugin to provide it.

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
openclaw plugins install npm-pack:/absolute/path/to/worktable-openclaw-<version>.tgz --pin
```

Use the archive path printed by `pack:dogfood`. See the
[release guide](https://github.com/worktable/worktable-dev/blob/main/docs/openclaw-release.md) for publication.

## License

The adapter uses the [MIT License](LICENSE).
