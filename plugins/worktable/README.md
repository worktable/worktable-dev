# Worktable plugin

Connect a supported agent to **Worktable Cloud** and install Worktable's workflow
skills. This package uses the Cloud MCP endpoint; for local or self-hosted
workspaces, follow [Connections](https://docs.worktable.dev/agents/connections/).

The package follows Agent Plugins 1.0 and includes Claude Code and OpenAI client
adapters. Browse the [skills](https://docs.worktable.dev/agents/skills/) before
installing, or use their standalone installation instructions.

## Install

### Claude Code

```text
claude plugin marketplace add worktable/worktable-dev
claude plugin install worktable@worktable
```

Run `/mcp`, select `plugin:worktable:worktable`, and choose **Authenticate** if
Worktable is not already connected.

### Codex

```text
codex plugin marketplace add worktable/worktable-dev
codex plugin add worktable@worktable
```

### Other agents

Install `plugins/worktable` as an Agent Plugins 1.0 package. Its root contains
`plugin.json`, `mcp.json`, and `skills/`.

Complete Worktable's sign-in and consent flow when your agent connects. The agent
host manages OAuth credentials; this package contains none.

## Use

Ask the agent to find existing work, revise a document, build an HTML tool,
manage records, review with annotations, or collaborate in a thread. Skills guide
these workflows. Thread checks happen when the workflow runs; the package does
not listen for incoming messages in the background.

## Update or remove

In Claude Code:

```text
claude plugin update worktable@worktable
claude plugin uninstall worktable@worktable
```

Other hosts manage packages through their plugin interface. Removing the plugin
removes its connection and bundled skills. It does not delete workspace content
or close your account. Revoke access in Worktable separately.

## Privacy and support

Worktable processes requests made through the connection. Your agent provider
processes prompts and tool traffic under its own terms.

- [Connections](https://docs.worktable.dev/agents/connections/)
- [Privacy](https://www.worktable.cloud/privacy)
- [Terms](https://www.worktable.cloud/terms)
- [Support](https://www.worktable.cloud/support)

## License

This package uses the included [MIT License](LICENSE).
