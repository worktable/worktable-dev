# Worktable for OpenClaw

Connect an OpenClaw account to durable Worktable threads. Worktable owns thread
history and delivery recovery; OpenClaw owns the native agent session associated
with each `thread:<threadId>` conversation.

OpenClaw connects to the whole Worktable. Pairing asks for a participant name,
not a Home Space. A contextless new conversation is created in Worktable;
threads created inside a Space retain that Space context. Existing
`defaultSpaceId` configuration remains accepted as a legacy preference and
continues routing contextless new conversations to that Space.

The minimum supported OpenClaw release requires a safe `node:sqlite` runtime: Node
22.22.3+, 24.15.0+, or 25.9.0+. The channel refuses to start when durable
deduplication is unavailable.

## Install

Install the verified release from ClawHub:

```sh
openclaw plugins install clawhub:@worktable/openclaw
openclaw plugins inspect worktable --runtime --json
```

For Worktable Cloud, register the installation without a reusable API key:

```sh
openclaw worktable connect \
  --server https://app.worktable.cloud \
  --agent-registration
```

The command discovers WorkOS Agent Registration, asks for the Worktable email
and participant name, and walks through the service-auth claim. The one-time
claim credential is saved before verification; rotating refresh tokens are
saved before the replacement assertion is exchanged. Cloud defaults OpenClaw
to conversation access.

For local Worktable, use the `openclaw channels add --channel worktable ...`
command shown in Worktable Settings. The plugin-owned command is:

```sh
openclaw worktable connect \
  --server <worktable-origin> \
  --pairing-code <single-use-code>
```

The pairing code is redeemed by the plugin; the resulting token is stored in
OpenClaw's sensitive channel configuration.

## Develop locally

Build and package from the Worktable repository:

```sh
bun run --cwd packages/openclaw-plugin pack:dogfood
```

Install the resulting versioned tarball from the OpenClaw account:

```sh
openclaw plugins install npm-pack:/absolute/path/to/worktable-openclaw-0.0.9.tgz --pin
openclaw plugins inspect worktable --runtime --json
```

## Security and data handling

- The plugin connects only to the Worktable server you configure and to that
  server's discovered authorization endpoints.
- Local tokens, Agent Registration credentials, pairing state, and delivery
  cursors are stored in OpenClaw's plugin configuration and state directories.
- Credential fields are marked sensitive in the plugin manifest.
- The plugin has no postinstall script, native binary, shell execution, or
  telemetry.

Report vulnerabilities privately as described in the Worktable
[security policy](https://github.com/worktable/worktable-dev/security/policy).

## Thread compatibility

New V2 Worktable threads use `thread:<threadId>` targets. Space thread handles
include their Space so copied IDs remain addressable, and native OpenClaw
conversation identities include the location so copied IDs cannot share agent
context. Existing V1 Space threads keep the qualified
`thread:<spaceId>/<threadId>` target and `<spaceId>/<threadId>` session
identity so their conversation history remains continuous.

## License

The Worktable OpenClaw adapter is available under the [MIT License](LICENSE).
