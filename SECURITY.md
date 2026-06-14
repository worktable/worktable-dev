# Security Policy

## Reporting a vulnerability

Please report security issues **privately** — do not open a public issue for a vulnerability.

- Preferred: use GitHub's [private vulnerability reporting](../../security/advisories/new) on this repository — it is enabled and routes directly to the maintainers.
- Or email **security@worktable.dev**.

Include where possible: affected version (`worktable --version`), platform, a description of the issue, and steps to reproduce. We aim to acknowledge reports within a few business days.

## Scope

- **In scope:** the Worktable local server and CLI, the MCP endpoint, the installer (`install.sh`), and released artifacts.
- **Out of scope:** issues that require an already-compromised host, and the deliberately documented behavior below.

## Known posture (not a vulnerability)

By design, the local server runs as a single-user app on `localhost`:

- The REST API under `/api/*` is unauthenticated. Run Worktable on localhost or behind your own network boundary.
- The MCP endpoint (`/mcp`) is open by default and accepts an optional bearer token via `WORKTABLE_MCP_TOKEN`.

See [docs/configuration.md](docs/configuration.md) for hardening guidance when exposing Worktable beyond localhost.
