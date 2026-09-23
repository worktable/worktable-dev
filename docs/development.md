# Develop Worktable

This guide is for the [public application source](https://github.com/worktable/worktable-dev).
To use Worktable without building it, follow the [installation guide](https://docs.worktable.dev/start/install/).

## Prerequisites

- Node **24.15.0**.
- Bun **1.3.14**, as pinned by `packageManager` in `package.json`.
- Git.

Desktop development and full verification also need the pinned Rust toolchain
and platform dependencies. See [Desktop development](../apps/desktop/README.md)
and the [Linux CI workflow](../.github/workflows/ci.yml).

```sh
git clone https://github.com/worktable/worktable-dev.git
cd worktable-dev
bun install --frozen-lockfile
```

## Run the web app and API

Use a disposable workspace and separate application state so development does
not change your everyday workspace. In the first terminal, from the repo root:

```sh
WORKTABLE_WORKSPACE="$PWD/.local-dev/workspace" \
WORKTABLE_APP_DIR="$PWD/.local-dev/app" \
HOST=127.0.0.1 PORT=7481 \
bun run --cwd packages/server dev
```

In a second terminal, from the same repo root:

```sh
WORKTABLE_API_URL=http://127.0.0.1:7481 \
bun run --cwd apps/web dev --host 127.0.0.1 --port 5180 --strictPort
```

Open `http://127.0.0.1:5180`. Complete onboarding for this development workspace.
The web app proxies API requests to the first terminal. Stop both processes with
Ctrl+C. `.local-dev/` is ignored by Git; do not put real secrets in demo content.
If a port is occupied, choose another and keep the API port and URL consistent.

The development web app loads General Sans from Fontshare. Raw General Sans
font files are not included in this repository. See the
[font setup notes](../apps/desktop/ui/fonts/README.md) for Desktop.

## Find your way around

| Directory                                       | Purpose                                                        |
| ----------------------------------------------- | -------------------------------------------------------------- |
| `apps/web`                                      | Browser interface                                              |
| `apps/cli`                                      | Installed CLI, setup, service lifecycle, and agent connections |
| `apps/desktop`                                  | Native macOS application                                       |
| `apps/docs`                                     | Product documentation site                                     |
| `packages/server`                               | File storage, HTTP routes, authentication, and MCP tools       |
| `packages/mcp`, `packages/mcp-connect`          | MCP transport and remote-agent connector                       |
| `packages/openclaw-plugin`, `plugins/worktable` | Agent integrations and skills                                  |
| `packages/types`, `packages/ui`                 | Shared contracts and UI components                             |
| `scripts`, `fixtures`                           | Build tools, verification, and synthetic workspaces            |

Read [DESIGN_SYSTEM.md](../DESIGN_SYSTEM.md) before changing UI styling.
Hosted service operations and the marketing sites are not included here.

## Verify a change

See [AGENTS.md](../AGENTS.md) for testing and review principles.

Run commands from the repository root:

```sh
bun run typecheck
bun run typecheck:lab
bun run test:policy
bun run test:required
```

Use the least expensive canonical test lane that proves the changed behavior
while developing. `test:required` covers standard, server, CLI, and packaged
boundaries. `test:full` adds Desktop contracts and browser journeys.
`test:changed` retains required tests and selects browser/Desktop lanes for their
owning surface. Server protocols, shared contracts, toolchain inputs and unknown
paths select every lane; unavailable history also falls back conservatively.

Before relying on full verification, install Chromium with
`bunx playwright@1.61.1 install --with-deps chromium` and the Rust/native
dependencies listed in CI. `bun run verify:full` also builds release-lab artifacts;
follow the source-identity setup in [Building](building.md) first.
No test requires a production Cloud deployment.

Boot the affected runtime path and exercise the behavior as well as running
tests. Keep examples synthetic and describe what you verified in the PR.

Repository README, contributor guides, and issue templates use focused CI
checks for local Markdown links, YAML parsing, and unresolved merge conflicts.
Run `bun scripts/repository-docs.ts` to check these documents locally. Changes confined to `apps/docs` (optionally with repository guides) build the
documentation site and check its generated content. Changes to documentation
generators, shared contracts, catalogs, or CLI sources retain product checks.
Other product changes always retain build, typecheck and required tests. Independent web,
Desktop, CLI, plugin and lab changes select their owning expensive lanes;
shared inputs and unknown paths retain full verification. Public main, manual
runs and the weekly schedule run full verification. The weekly run omits the
Rust build cache to preserve cold-build evidence. Source checks, artifact builds,
required tests, native contracts and selected browser tests run on independent
runners. The required `verify` result checks every planned job and combines raw
test evidence bound to the same source, run and attempt; missing evidence fails.
Task caches cover declared build/typecheck outputs, never passing test results.
The release lab owns the production web build in CI, so the earlier workspace
build omits that surface. Plugin distribution checks
run only when plugin or build inputs change, with the required job still present.

## Generated files and docs

MCP metadata, theme files, and brand assets are checked in but generated.
Regenerate the corresponding output with `generate:tools`, `generate:theme`, or
`generate:brand`; do not edit it by hand. Check them with:

```sh
bun run check:tools
bun run check:theme
bun run check:brand
```

For product docs, use `bun run dev:docs` or `bun run build:docs`. CLI and MCP
reference pages are generated from source; edit the owning source instead.
See [Contributing](../CONTRIBUTING.md) before opening a pull request.
