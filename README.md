# Worktable

Worktable is a local-first, file-backed workspace shared by humans and AI agents.
It includes a server, web app, CLI, Desktop app, MCP connector, plugins and user docs.

The application is licensed under [AGPL-3.0-only](./LICENSE). Exact shared MIT
exceptions and third-party notices remain separate; see [NOTICE](./NOTICE) and
the relevant package notices. Contributions follow the license of each file;
see [CONTRIBUTING.md](./CONTRIBUTING.md).

## Build

Install Node 24.15.0 and the version of Bun named in `package.json`, then run:

```sh
bun install --frozen-lockfile
bun run build
bun run check:tools
bun run check:theme
bun run check:brand
bun run typecheck
bun run typecheck:lab
```

`bun run release:lab` builds Linux CLI and skill-installer bundles for the host
architecture, plus connector and plugin artifacts, in `dist/lab-releases`.
Run the built CLI with `--help` for local
setup commands. `bun run lab --help` describes disposable acceptance environments.
For an AGPL checkout, release builds and artifact verification require a clean
Git tree and an explicit source identity. Set `WORKTABLE_PUBLIC_SOURCE_REPOSITORY` to the GitHub origin
repository and `WORKTABLE_PUBLIC_SOURCE_COMMIT` to the full checked-out commit.
All release archives then identify that commit and omit build-runner links.
A private runner does not make its own repository the public source. Local tags
are ignored unless `WORKTABLE_PUBLIC_SOURCE_TAG` explicitly supplies the captured
public release tag. It must match the package version and point to that commit.
Public builds reject a differing `WORKTABLE_VERSION`, ambient `VITE_` settings,
local environment files in build directories and ignored files in web public
assets or the OpenClaw skill staging directory.
Build from a fresh checkout. These settings bind build inputs; they do not
approve publication.

Desktop packaging requires macOS and the Rust toolchain pinned in
`apps/desktop/rust-toolchain.toml`.

## Verify

Run canonical tests from an independent Git checkout:

```sh
bun run test:policy
bun run test:required
bun run test:full
```

`required` covers standard, server, CLI and packaged-boundary tests. `full` adds
Desktop contracts and browser journeys; it requires Rust, Chromium and the native
Desktop build dependencies. `changed` currently selects every public changed lane.
Tests never need a Cloud deployment. See the workflow for Linux dependencies.

Generate MCP metadata, theme and brand files with the corresponding `generate:*`
commands. Generated files remain checked in and their checks reject drift.

## Runtime sources

Prebuilt Worktable downloads include the Bun runtime. [SOURCE-MATERIALS.json](./SOURCE-MATERIALS.json)
identifies its matching source and rebuild archive by URL, SHA256 and byte length.
Verify the archive's checksum before using the included build instructions and
replacement-runtime helper. The runtime identity must match the pinned Bun version and commit; release builds
reject a missing or malformed reference. Other dependencies retain their source
references and license terms in the release notices.

Release archive packaging requires Python 3 and unzip. Cloud acceptance labs require an explicit
non-production origin: `bun run lab -- cloud --origin https://staging.example.test --dry-run`.
Replace the example origin with your staging deployment for a real lab.
