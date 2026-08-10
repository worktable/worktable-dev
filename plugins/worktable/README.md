# Worktable

Worktable gives agents a shared workspace for private Docs, interactive HTML,
structured Records, annotations, and threaded handoffs. This package connects
supported agents to Worktable and adds six skills for working with that content.

The package follows the Agent Plugins 1.0 standard. It also includes compatibility
adapters for Claude Code and OpenAI clients.

## Install

### Claude Code

```text
claude plugin marketplace add worktable/worktable-dev
claude plugin install worktable@worktable
```

In Claude Code, run `/mcp`, select `plugin:worktable:worktable`, and choose
**Authenticate** if Worktable is not already connected.

### Codex

```text
codex plugin marketplace add worktable/worktable-dev
codex plugin add worktable@worktable
```

### Other compatible agents

Install the `plugins/worktable` directory as an Agent Plugins 1.0 package. The
standard `plugin.json`, `mcp.json`, and `skills/` directory are at its root.

Complete the Worktable sign-in and consent flow when your agent first connects.
OAuth credentials are managed by the agent host and are not included in this
package.

## Use

Ask your agent to find or create Worktable content, build an interactive HTML
Doc, manage Records, review with annotations, or collaborate in a thread. Thread
checks happen when the collaboration workflow runs; this package does not run a
background inbox listener.

## Update or remove

Claude Code users can update or uninstall the package with:

```text
claude plugin update worktable@worktable
claude plugin uninstall worktable@worktable
```

Removing the plugin removes its skills and MCP connection. It does not delete
content from Worktable or close your account. Disconnect Worktable separately
if you also want to revoke access.

## Privacy and support

Worktable receives only the operations you ask your agent to perform. Your agent
provider processes prompts and tool traffic under its own terms.

- [Setup documentation](https://docs.worktable.dev/start/connect-your-agent)
- [Privacy](https://www.worktable.cloud/privacy)
- [Terms](https://www.worktable.cloud/terms)
- [Support](https://www.worktable.cloud/support)

## License

This package is licensed under the included MIT License.
