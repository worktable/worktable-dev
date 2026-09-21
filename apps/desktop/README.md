# Worktable Desktop

The Desktop app is a Tauri host for Worktable. It can open a local workspace,
connect to a self-hosted server, or sign in to Worktable Cloud. Local connections
use the same workspace identity and host authority as the CLI. The app attaches
to a verified running host or starts its packaged server as a supervised process.

The bundled shell manages connections and native commands. Workspace content
loads in a separate webview with limited capabilities. Keep that separation when
adding native integrations.

## Development

Use macOS, the Bun version in the root `package.json`, and the Rust toolchain
in `rust-toolchain.toml`. Run these commands from the repository root:

```sh
bun install --frozen-lockfile
bun run desktop:dev:isolated
```

The isolated launcher uses disposable, checkout-specific workspace and app-data
directories. It preserves state between runs. To return that environment to
first-run setup:

```sh
bun run desktop:dev:isolated -- --reset
```

Reset only removes state owned by this checkout's isolated launcher. For an
explicit development workspace, supply all three paths:

```sh
WORKTABLE_DESKTOP_WORKSPACE=/path/to/workspace \
WORKTABLE_DESKTOP_APP_DIR=/path/to/app-data \
WORKTABLE_DESKTOP_LOCAL_APP_DIR=/path/to/local-app-data \
bun run desktop:dev
```

Desktop development serves the shell at `http://127.0.0.1:15321` and loads
General Sans from Fontshare. Internet access is needed to load that font;
otherwise the system-font fallback is used. Packaged builds remain offline and
require the local font described in [font setup](ui/fonts/README.md).

## Build and verify

```sh
bun run desktop:check
bun run desktop:build
bun run desktop:ci
```

`desktop:check` prepares runtime resources and runs the Desktop contracts.
`desktop:build` creates and verifies a local macOS app bundle. `desktop:ci` also
exercises the packaged application's lifecycle with isolated state. These local
builds do not require production signing credentials; distribution signing and
notarization are separate release operations.

Run the browser contracts through the shared harness:

```sh
bun run test:full --suite desktop-browser
```

The [user guide](https://docs.worktable.dev/reference/desktop/) covers installation,
connection types and updates. The [root README](../../README.md) describes the
standalone build and verification commands. Font rights are recorded beside
the [bundled fonts](ui/fonts/README.md).

### Staging builds

Supply `WORKTABLE_DESKTOP_STAGING_ORIGIN` as the canonical HTTPS origin of your
staging deployment when building with the `staging` feature and when verifying
the resulting bundle. There is no default staging endpoint. Production builds
retain their fixed production origin and ignore this staging setting.
