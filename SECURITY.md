# Security policy

## Report a vulnerability privately

Use [GitHub private vulnerability reporting](https://github.com/worktable/worktable-dev/security/advisories/new)
or email **security@worktable.dev**. Do not report vulnerabilities in public
issues or discussions.

Include the affected Worktable version, platform, expected and observed behavior,
and a minimal reproduction with synthetic data. Remove credentials and private
workspace content from logs and attachments. We aim to acknowledge reports
within a few business days.

## Scope and versions

Reports are welcome for the application, local server and CLI, Desktop,
MCP connectors, agent plugins, installer, and released artifacts. Include the
exact component and version; application and plugin versions may differ.
Fixes are delivered in current releases. Older versions may require an upgrade.

An already-compromised host can read files and credentials available to its
user. Worktable does not isolate a workspace from programs running with that
user's filesystem access. Browser-origin bypasses, credential-scope violations,
and unintended remote access are within scope.

## Deployment boundaries

Local Worktable can provide implicit owner access on a literal loopback endpoint.
That convenience is constrained by request provenance and configured access
policy. A loopback bind alone does not mean every request is trusted: a configured
public URL or explicit credential requirement changes the authentication posture.
Agent credentials retain their own identity and scopes, and invalid credentials
must not fall back to owner access.

For reachable self-hosted installations, configure authentication and HTTPS as
described in the [security model](https://docs.worktable.dev/reference/security/)
and [remote access guide](https://docs.worktable.dev/guides/remote-access/).
Worktable Cloud has a separate hosted identity and OAuth flow. Those guides are
the maintained reference for setup and operational behavior.
