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

## Run locally

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

## Repository map

| Directory                                                                 | Purpose                                                        |
| ------------------------------------------------------------------------- | -------------------------------------------------------------- |
| `apps/web`                                                                | Browser interface                                              |
| `apps/cli`                                                                | Installed CLI, setup, service lifecycle, and agent connections |
| `apps/desktop`                                                            | Native macOS application                                       |
| `apps/docs`                                                               | Product documentation site                                     |
| `packages/server`                                                         | File storage, HTTP routes, authentication, and MCP tools       |
| `packages/mcp`, `packages/mcp-connect`                                    | MCP transport and remote-agent connector                       |
| `packages/openclaw-plugin`, `packages/hermes-plugin`, `plugins/worktable` | Agent integrations and skills                                  |
| `packages/types`, `packages/ui`                                           | Shared contracts and UI components                             |
| `scripts`, `fixtures`                                                     | Build tools, verification, and synthetic workspaces            |

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
tests. Use the [synthetic fixtures](../fixtures/README.md) where useful and
describe what you verified in the PR.

For a change meant to make Worktable faster, measure it with the
[perf lane](../scripts/perf/README.md) and put the before and after numbers in
the PR. The CI build fails when a web bundle grows past its budget.

## Documentation checks

For repository guides and issue templates:

```sh
bun scripts/repository-docs.ts
```

This checks local links, YAML, and unresolved merge conflicts in its configured
scope. For product documentation, run `bun run build:docs`. The build generates
reference content from the owning source.

CI selects checks from the changed paths. Documentation-only changes use the
repository and site checks. Product changes retain build, typecheck, and required
tests; shared contracts and unknown paths select all lanes. Public `main`, manual
runs, and the weekly schedule run full verification. The required `verify` result
checks the selected jobs and their evidence for the same source and run.
See [CI](../.github/workflows/ci.yml) for lane selection and job details.

## Generated files

MCP metadata, theme files, brand assets, and drawing preview assets are checked
in but generated. Regenerate the corresponding output with `generate:tools`,
`generate:theme`, `generate:brand`, or `generate:previews`; do not edit it by hand.
`generate:previews` updates the shared font manifest and native drawing browser
bundle after changes to their source, font dependencies, or the Quickdraw patch.
Check generated outputs with:

```sh
bun run check:tools
bun run check:theme
bun run check:brand
bun run check:previews
```

CI source checks and standalone release assembly check preview asset integrity.
Run `check:previews` locally when changing preview sources or their dependencies;
ordinary build and test commands do not repeat this check. Regenerate and review
stale outputs rather than bypassing the check.

For product docs, use `bun run dev:docs` or `bun run build:docs`. CLI and MCP
reference pages, runtime references, skill pages, and skill downloads are generated
from their owning sources. Edit the command/tool definitions, runtime guide, or
canonical skill instead of the published output. Keep page titles within three
words where possible and link shared procedures rather than copying them.
See [Contributing](../CONTRIBUTING.md) before opening a pull request.
