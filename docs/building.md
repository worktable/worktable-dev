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
bun scripts/provision-product-font.ts
bun run release:lab
```

The provisioning command downloads the reviewed General Sans variable WOFF2
from its official Fontshare URL and verifies a pinned SHA-256 digest before
writing the ignored local font file. It is reusable by local, CI and Desktop
build preparation; an existing differing file is preserved and reported.
The artifact CI job runs this step explicitly. Release assembly itself remains
offline for fonts and rejects a missing local asset. Rendering never downloads fonts.

`release:lab` builds Linux CLI and skill-installer bundles for the host architecture,
plus connector and plugin artifacts, in `dist/lab-releases`. Run
`bun run release:local` for the full release matrix in `dist/releases`.
Archive packaging also requires Python 3 and unzip. Release builds write phase
timings to `dist/release-timings-<profile>.json`, outside the published assets.
`release:lab` already builds and verifies the OpenClaw package; callers should
not repeat that packaging command.

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

## Installed CLI smoke

After building the local release archive in `dist/releases`, run
`bun run smoke:local-install`. This installs into temporary directories and checks
compiled CLI setup, client configuration and removal, HTTP health, and stdio MCP
with a document roundtrip. Stdio requests wait for their matching responses.
The repository's Bun parses the resulting JSON/TOML; the installed launcher runs
with an isolated home and a system-only PATH to verify its bundled runtime.

Use `-- --keep` to retain logs or `-- --review` for a running instance. The older
`bun run verify:local-e2e` entrypoint delegates to this same journey and preserves
its `WORKTABLE_E2E_*` settings and options. `--service` explicitly adds the native
user-service install/start/status/logs/stop/uninstall checks; ordinary runs do not
install a user service.

## Desktop

Desktop packaging requires macOS and the Rust toolchain pinned in
`apps/desktop/rust-toolchain.toml`. Follow the
[Desktop contributor guide](../apps/desktop/README.md). A source build does not
imply that a signed Desktop download is included in every application release.

## CI verification receipts

A successful full verification of a public `main` push publishes an exact-source
receipt after all selected job results and raw test evidence pass. The receipt
binds the commit, tree, lockfile, Bun/Node versions, workflow, run and attempt.
Release automation verifies the successful originating GitHub run before reusing
its source checks. Missing or incompatible proof runs those checks again.
Release candidate validation, compiled artifact smoke tests, signing, publication
and installed updater checks remain separate release guarantees.

## Managed visual preview runtime

Normal CLI and server archives include `preview-runtime/`: the pinned
Playwright driver, its matching Chromium headless shell, upstream notices and a
version/platform manifest. Desktop preparation copies that same runtime into
its resources. Release assembly downloads browser distributions for each target;
render requests never install software or download a browser. Skill-installer
archives remain independent and do not contain a browser.

The server owns Chromium through Bun's native process API and connects through
Playwright's public CDP transport over a native WebSocket. The debugging endpoint
binds only loopback on an ephemeral port; its random browser path stays inside a
private temporary profile. Browser processes receive a small environment
allowlist, without application credentials. This avoids Bun's extra-file-descriptor
child-process transport issue; each job still receives a fresh isolated context.

Preview workers require Chromium's OS sandbox. A host without the necessary
sandbox or Linux shared libraries reports preview unavailable; Worktable does
not retry with sandboxing disabled. Provision Linux browser dependencies and
sandbox support when preparing the host. The runtime manifest records its
installed size and browser executable checksum; the release archive checksum
covers the complete driver and browser. Release assembly also requires the
unmodified local General Sans WOFF2 described in
[the font provisioning guide](../apps/desktop/ui/fonts/README.md). It packages
that font with its source, license and SHA-256 identity under
`preview-runtime/fonts/`. Desktop verifies that its shell uses the same bytes.
Other fonts remain embedded application assets. Preview jobs never download fonts;
public-source development without the optional local file uses a shared fallback.

Development uses the pinned local Playwright package and previously installed
browser from the development prerequisites. It uses the same sandbox policy as
installed builds. Desktop release verification additionally checks that the
embedded browser executable has a valid code signature; native capture and
notarization must be exercised on macOS.

Before Desktop bundling, native preview libraries and the browser are signed
inside out while preserving Chromium's existing entitlements. Protected release
builds require `APPLE_SIGNING_IDENTITY` to name a Developer ID Application
identity already available in the build keychain; they fail rather than
substituting an ad hoc identity. Development builds retain the existing ad hoc
signing convention. The runtime manifest retains the original executable digest
and records the digest after signing.

The pinned Linux ARM64 headless archive omits standalone notices. Release
assembly therefore obtains the full Chromium archive at the exact same revision
and extracts its generated credits from `resources.pak`. Only those credits and
their source/hash provenance are added to the headless runtime; the full browser
is retained in the build cache rather than shipped.
