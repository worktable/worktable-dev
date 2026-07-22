# Security Policy

## Reporting a vulnerability

Please report security issues **privately**. Do not open a public issue for a vulnerability.

- Preferred: use GitHub's [private vulnerability reporting](../../security/advisories/new) on this repository. It is enabled and routes directly to the maintainers.
- Or email **security@worktable.dev**.

Include where possible: affected version (`worktable --version`), platform, a description of the issue, and steps to reproduce. We aim to acknowledge reports within a few business days.

## Scope

- **In scope:** the Worktable local server and CLI, the MCP endpoint, the installer (`install.sh`), and released artifacts.
- **Out of scope:** issues that require an already-compromised host, and the deliberately documented behavior below.

## Known posture (not a vulnerability)

Worktable's auth model follows how the server is bound:

- **Loopback (the default):** the server binds `127.0.0.1` and runs owner-open, like a local app. The web app and the REST API under `/api/*` need no auth, and the MCP endpoint accepts an optional bearer token via `WORKTABLE_MCP_TOKEN`.
- **Reachable (`--reachable`, or any non-loopback host):** the server refuses to bind without an owner password. The web app and REST API are gated behind that password (a signed session cookie), and MCP requires bearer tokens. Worktable still serves plain HTTP: put it behind your own HTTPS tunnel or proxy when exposing it beyond your machine.

Reports that amount to "the loopback API is open on the local machine" describe this design, not a vulnerability.

See the [security model](https://docs.worktable.dev/reference/security/) and [remote access guide](https://docs.worktable.dev/guides/remote-access/) for hardening guidance.
