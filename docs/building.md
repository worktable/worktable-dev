# Build Worktable artifacts

For an editable web app and API, start with [Development](development.md).
This guide covers production builds, release archives, and their source identity.

## Build the application

Use Node 24.15.0 and the Bun version in `package.json`. From a fresh checkout:

```sh
bun install --frozen-lockfile
bun run build
bun run check:tools
bun run check:theme
bun run check:brand
```

## Bind a release to its source

Release builds require a clean Git tree and an explicit public source identity.
Commit your changes and make that exact source available at the repository you
name. For a fork, use your fork's URL and its full commit hash.

```sh
export WORKTABLE_PUBLIC_SOURCE_REPOSITORY=https://github.com/worktable/worktable-dev
export WORKTABLE_PUBLIC_SOURCE_COMMIT="$(git rev-parse HEAD)"
bun run release:lab
```

`release:lab` builds Linux CLI and skill-installer bundles for the host architecture,
plus connector and plugin artifacts, in `dist/lab-releases`. Run
`bun run release:local` for the full release matrix in `dist/releases`.
Archive packaging also requires Python 3 and unzip.

Archives identify the exact source commit, retain application and dependency
notices, and omit build-runner links. A private build runner does not make its
private repository the public source. Local tags are ignored unless
`WORKTABLE_PUBLIC_SOURCE_TAG` explicitly names the public release tag; that tag
must match the package version and point to the selected commit.

Public builds reject a differing `WORKTABLE_VERSION`, ambient `VITE_` settings,
local environment files in build directories, and ignored files in web public
assets or the OpenClaw skill staging directory. Build from a fresh checkout.
These checks establish build inputs; they do not publish or approve a release.

## Runtime sources and verification

Prebuilt Worktable downloads include Bun. [SOURCE-MATERIALS.json](../SOURCE-MATERIALS.json)
identifies the matching runtime source and rebuild archive by URL, SHA-256, and
byte length. Verify its checksum before following its build instructions and
replacement-runtime helper. Release packaging checks its identity against the
pinned Bun version and commit. Other dependencies retain their source references
and license terms in the release notices.

`bun run verify:full` runs typechecks, the complete portable test portfolio,
release-lab builds, and OpenClaw package verification. It requires the same
source identity plus the browser, Rust, and native dependencies described in
[Development](development.md).

`bun run lab --help` describes disposable acceptance environments. Cloud labs
require an explicit non-production origin, for example
`bun run lab -- cloud --origin https://staging.example.test --dry-run`.
Use a staging system you control for an actual run.

## Desktop

Desktop packaging requires macOS and the Rust toolchain pinned in
`apps/desktop/rust-toolchain.toml`. Follow the
[Desktop contributor guide](../apps/desktop/README.md). A source build does not
imply that a signed Desktop download is included in every application release.
