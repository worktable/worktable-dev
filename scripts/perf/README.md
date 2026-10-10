# Perf lane

Scripts that measure Worktable's server and web bundles on synthetic
workspaces, so a performance change can show its numbers before and after.
They are tools, not tests: nothing here runs in the required test lanes except
the bundle gate.

Run them from the repository root after `bun install --frozen-lockfile`.
Outputs go to `.local-dev/perf/`, which Git ignores.

| Command                                   | What it does                                        |
| ----------------------------------------- | --------------------------------------------------- |
| `bun run perf:fixtures --profile 1k`      | Generate a perf workspace                           |
| `bun run perf:server --profile 1k`        | Boot, request and typing timings for one checkout   |
| `bun run perf:compare --base origin/main` | Paired runs of a base ref against your working tree |
| `bun run perf:bundle`                     | Bundle sizes against budgets (after a web build)    |

## Fixtures

`fixtures.ts` builds a workspace from a seed (`--seed`, default 1):

| Profile | Documents | HTML space | Activity events | Threads           | Records    |
| ------- | --------- | ---------- | --------------- | ----------------- | ---------- |
| `100`   | 100       | 20         | 2,000           | 20 × 50 messages  | 2 × 200    |
| `1k`    | 1,000     | 200        | 50,000          | 500 × 50 messages | 20 × 2,000 |
| `5k`    | 5,000     | 200        | 50,000          | 500 × 50 messages | 20 × 2,000 |

Documents are 70% Markdown, 25% rich text (mostly short, a few up to 5,000
blocks) and 5% HTML, spread over 2 to 20 spaces with the first space largest.
The "Dashboards" space holds the extra HTML documents. Every profile includes
probe documents in the first space: `perf/rich-2000`, `perf/rich-5000`,
`perf/markdown` and `perf/html`.

Documents are written through the managed write path that REST and MCP use,
so the workspace has real identities, provenance, version history and
activity. Spaces, records and threads use the canonical fixture builders in
`packages/server/src/fixtures`. The same seed gives the same content; ids and
save times come from the store, as in production.

A fixture is written once to `.local-dev/perf/fixtures/<profile>-seed<seed>/`
and reused until `fixtures.ts` changes. Each run works on a fresh copy. On a
loaded laptop, `1k` takes a few minutes to generate and `5k` considerably
longer; `--force` regenerates.

## Server timings

`server.ts` boots `packages/server` from a checkout (`--checkout`, default this
one) on a copy of the fixture and records:

- **Boot:** time to the listening line, and to the first `/api/spaces` response.
- **First response** of each endpoint after boot, before anything is warm.
- **p50 and p95** at concurrency 1 and 4 for the spaces list, a space's
  documents, Recent, Activity, Pending, threads, search, and opening a Markdown, a
  2,000-block rich and an HTML document (the page request plus the renderer's
  content requests). `--samples` sets the requests per measurement (default
  20; very slow endpoints stop after a minute with at least three samples per
  worker). While each concurrency-4 measurement runs, `/health` is requested
  every 100 ms: its p95 shows how long a trivial request waits behind the work.
- **Typing:** two headless Yjs clients join the 2,000-block document; one types
  5 characters per second for `--typing-minutes` (default 2; Plan 15 uses 10,
  and 0 skips it) while `/health` is sampled every 250 ms. It reports echo
  latency to the second client, `/health` latency, saves of the document file
  while typing, the longest stretch without a save, the delay from the last
  keystroke to the save, whether the saved file contains the typed text, and
  the server's CPU time and bytes written (Linux only, from `/proc`).

When the server exposes `GET /api/diagnostics/perf`, its response is stored in
`result.json` too. Each run writes `result.json` and `summary.md` to
`.local-dev/perf/results/<time>-server-<profile>/`.

## Base against candidate

`compare.ts` exports `--base` (and `--candidate`, or uses your working tree)
into `.local-dev/perf/checkouts/`, installs dependencies once per commit,
generates the fixture once, then alternates the two for `--rounds` (default 5)
on the same machine: base first in even rounds, candidate first in odd ones.
`compare.md` lists each metric's median per side, the change and how many
rounds the candidate was faster. Defaults: `--profile 1k --samples 10
--typing-minutes 2`.

Timings are advisory. Plan 15 keeps timing budgets advisory until 20
comparable runs exist; a change smaller than the round-to-round spread is
noise. Use the same machine for both sides and keep it otherwise idle. A
shared or busy machine is fine for checking that the scripts work, not for
numbers.

Quick local check:

```sh
bun run perf:server --profile 100 --samples 5 --typing-minutes 0.5
```

Real numbers on an idle Linux machine (the project uses a Namespace devbox),
with the pinned Bun and Node on `PATH`:

```sh
bun install --frozen-lockfile
bun run perf:compare --base origin/main --profile 1k
bun run perf:server --profile 5k --samples 10 --typing-minutes 10
```

## Bundle budgets

`bundle.ts` reads `apps/web/dist/client/.vite/manifest.json` from a production
web build (`bun run --cwd apps/web build`) and measures, with gzip level 6 and
Brotli quality 11:

- **entry:** the entry chunk and its static imports;
- **root css:** the stylesheet every page loads;
- **home, space, rich document, html document:** the entry plus the static
  imports of the route's modules, the lazily loaded sidebar and, for
  documents, the space layout and the document renderer. `ROUTES` in
  `bundle.ts` lists the modules.

It fails when a gzip size exceeds its budget in `bundle-budgets.json`. The
budgets sit 2% above the sizes when they were set, so a regression fails the
build job in CI. When a bundle shrinks, or a growth is intended, run
`bun scripts/perf/bundle.ts --update` and explain the change in the pull
request. The Plan 15 targets (entry 180 KB, root CSS 25 KB and rich document
600 KB, all gzip) are shown but not enforced yet. If the manifest no longer
contains a listed module, the script fails and names it.
