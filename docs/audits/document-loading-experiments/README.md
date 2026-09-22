# Loading investigation experiments

These are diagnostic fixtures and prototypes, not production features. See [findings and limitations](../document-loading-critical-follow-up.md). Use Bun and the repository's installed dependencies. Commands below start from the repository root unless a working directory is specified.

## Current application fixtures

Build the current application with `bun run build` from `apps/web`. Then, from the repository root:

```sh
WORKTABLE_STATIC_DIR="$PWD/apps/web/dist/client" bun docs/audits/document-loading-experiments/serve-fixtures.ts
```

This launches the real Bun server on a free loopback port with an isolated workspace and seeds rich documents (10/500/2,000 paragraphs), Markdown, and HTML. It prints the URL and writes `/tmp/worktable-review.json`. The harness deliberately preserves fixture files on shutdown. It does not use the user's workspace or relax remote-access authentication. Keep a stable copy of the assets if rebuilding concurrently.

`AUDIT_CONFIG=/tmp/another-config.json` selects another output config when starting an additional fixture server.

## Initial-response reader

With the fixture server running:

```sh
bun docs/audits/document-loading-experiments/serve-reader.tsx
```

Open `http://127.0.0.1:45551/rich-10`. `READER_PORT` overrides the port and `AUDIT_CONFIG` selects the source fixture server. The reader validates the fixture's canonical page and requests saved content before returning static markup using `DocumentPreview`. It is bounded to 80 blocks, omits embeds/app chrome/editing, and is intended only for this loopback fixture. It is not production private-document SSR or a full reader implementation.

## Editor and shell alternatives

`vite.config.ts` applies temporary build transforms without editing dependency files. `LOADING_EXPERIMENT=editor` changes the resolved-node lookup and skips empty annotation work. `LOADING_EXPERIMENT=shell` lazily imports the sidebar/onboarding. The transform depends on the exact BlockNote 0.51.4 compiled implementation; inspect it before using another dependency version.

Example for the editor experiment, from repository root:

```sh
mkdir -p /tmp/worktable-editor-prototype
ln -s "$PWD/node_modules" /tmp/worktable-editor-prototype/node_modules
```

If that symlink already exists, retain it if it points at this checkout. Build from `apps/web`:

```sh
LOADING_EXPERIMENT=editor bunx vite build --config ../../docs/audits/document-loading-experiments/vite.config.ts
```

Start another fixture server from repository root:

```sh
AUDIT_CONFIG=/tmp/worktable-editor-prototype.json WORKTABLE_STATIC_DIR=/tmp/worktable-editor-prototype/client bun docs/audits/document-loading-experiments/serve-fixtures.ts
```

For shell, replace `editor` with `shell` in the mode/output/config paths. The symlink allows prerendered server modules in the temporary output to resolve dependencies. The original editor run preceded this setup and used an unchanged production shell with its entry filename replaced after a prerender resolution failure; the report discloses that limitation. Rebuilt runs should complete prerender normally before measurement.

The transforms do not supply sourcemaps. Do not use their source mappings for detailed CPU attribution. The saved CPU summary came from an unmodified production build with sourcemaps.

## Measurements

The visible Chrome CDP endpoint defaults to `http://127.0.0.1:18800`; override with `CDP_URL`. Scripts create fresh contexts and close only their own contexts. They do not close the shared browser process.

```sh
node docs/audits/document-loading-experiments/measure.mjs
```

Requires review/editor config files and the reader server. Measures three alternating current/editor large-document pairs, current small-editor/reader samples, and optional shell pairs if `SHELL_ORIGIN` is set. Writes `/tmp/worktable-deep-measure.json`.

```sh
SHELL_ORIGIN=http://127.0.0.1:39899 node docs/audits/document-loading-experiments/measure-reading.mjs
```

Use the actual shell server URL. This script matches first-visible-paragraph readiness for current/reader and measures three alternating HTML pairs; writes `/tmp/worktable-reading-recheck.json`. `READER_ORIGIN` overrides the reader URL. The saved script fixes the original top-frame storage-probe bug; invalid original HTML samples remain explicitly excluded in the evidence.

Timing scripts use 100 ms latency, 10 Mbps download, 4 Mbps upload, and 4× relative CPU slowdown. They record resource timing, long tasks, and page errors without screencasting or repeated text/layout extraction. Locator readiness includes automation polling and is not exact physical paint time or typing latency. The preview rAF timestamp is supplementary and can be null if observation finishes before that callback.

For separate CPU diagnosis, build the current application with `bunx vite build --sourcemap` from `apps/web`, serve those assets, then run `node docs/audits/document-loading-experiments/profile.mjs rich-2000 large 4`. `PROFILE_ORIGIN` selects another server. Output is `/tmp/worktable-profile-large.json`; profile timings must not be pooled with unprofiled timings.

```sh
bun docs/audits/document-loading-experiments/catalog-benchmark.ts
```

This isolated benchmark creates and deletes its own temporary workspace, with no server/watcher. It writes `/tmp/worktable-pure-catalog.json`.

The retained evidence is from the investigation's actual runs, not newly invented results from these portable copies. These scripts are outside product code and do not represent regression coverage.

## Follow-up research diagnostics

`node docs/audits/document-loading-experiments/inspect-stylesheets.mjs` opens the existing editor prototype on port 43009 and inventories loaded main stylesheet contents through Chrome's CSS domain. It writes `/tmp/worktable-css-inventory.json` and verifies the small document reaches its last editor block.

`node docs/audits/document-loading-experiments/profile-selectors.mjs` records the 2,000-block editor with selector-statistics categories enabled at **1× CPU**, retaining the previous network profile. It writes `/tmp/worktable-selector-timeline.json` and `/tmp/worktable-selector-context.json`. This is an expensive diagnostic, not a speed benchmark; the raw trace can exceed 100 MB and can contain events from other shared-browser tabs. Analyze only the target navigation's renderer and do not publish the unfiltered trace. The checked-in research evidence retains only the tested renderer's selector summary. These scripts currently use the same local CDP endpoint and prototype port as the original run.

## Reading, warm reloads, and input checks

`measure-reading-and-input.mjs` tests the production fixture above with normal
(100 ms / 10 Mbps / 4× CPU) and constrained (400 ms / 1.6 Mbps / 4× CPU) profiles.
It captures a two-frame reading boundary, browser paint entries, editor/HTML/Markdown
readiness, long tasks, and Event Timing entries. For rich documents it types a
character and undoes it, so **use only an isolated fixture workspace**.

```sh
AUDIT_ORIGIN=http://192.168.2.211:39083 \
AUDIT_PASSWORD='your-review-password' \
node docs/audits/document-loading-experiments/measure-reading-and-input.mjs
```

Omit `AUDIT_PASSWORD` for a loopback fixture. `AUDIT_PROFILES=constrained` and
`AUDIT_TARGETS=rich-10,html-audit` narrow the run. `AUDIT_OUTPUT` selects the output
JSON. The password is not written to results. Do not run builds or other browser
checks concurrently with timing runs. These short sessions do not establish field
INP or p75 performance.

`throttled-fixture-proxy.mjs` exports a loopback-only HTTP proxy restricted to one
fixture origin. It applies request latency and a shared response-byte budget to
both the parent page and sandboxed iframe requests. Browser contexts can use its
`url` as their proxy; do not also enable CDP network throttling. Authenticate the
context before timing (the proxy deliberately does not support HTTPS CONNECT).
Always close the browser context and then call the proxy's `close()`.
WebSocket bodies pass through after a delayed handshake, so this helper verifies
HTML delivery; it is not a Yjs-throughput simulator. It is a diagnostic, not a
production server or an internet-facing proxy.


## Final implementation measurements

See [final results](../document-loading-results.md). Run from the repository root
with Playwright installed and the visible CDP browser available. Set
`AUDIT_PASSWORD` to the isolated fixture password without committing it.

```sh
AUDIT_BEFORE=http://192.168.2.211:45747 \
AUDIT_AFTER=http://192.168.2.211:39090 \
node docs/audits/document-loading-experiments/measure-paired-openings.mjs

AUDIT_ORIGIN=http://192.168.2.211:39090 \
AUDIT_TARGETS=rich-10,rich-2000,plain \
node docs/audits/document-loading-experiments/measure-reading-and-input.mjs

AUDIT_BEFORE=http://192.168.2.211:45747 \
AUDIT_AFTER=http://192.168.2.211:39090 \
node docs/audits/document-loading-experiments/measure-proxy-html.mjs
```

`AUDIT_OUTPUT` changes each script's JSON output path. `AUDIT_CDP` overrides
`http://127.0.0.1:18800`; that address controls the browser locally, while the
review URLs remain LAN-accessible. The input script types and undoes one character;
never aim it at a real document. Run these sequentially with builds/tests idle.
The paired script's CDP network emulation covers the parent page only; the proxy
script also constrains the sandboxed HTML response and checks its latency.
