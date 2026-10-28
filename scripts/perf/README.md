# Perf lane

Scripts that measure Worktable's server, web bundles and real clicks in a
browser on synthetic workspaces, so a performance change can show its numbers
before and after.
They are tools, not tests: nothing here runs in the required test lanes except
the bundle gate and the static speed guards. `perf-smoke` runs a structural
check on pull requests, and maintainers run timed gates nightly and before
each release (see [Speed gates](../../docs/performance.md#speed-gates)).

Run them from the repository root after `bun install --frozen-lockfile`.
Outputs go to `.local-dev/perf/`, which Git ignores.

| Command                                    | What it does                                          |
| ------------------------------------------ | ----------------------------------------------------- |
| `bun run perf:fixtures --profile 1k`       | Generate a perf workspace                             |
| `bun run perf:server --profile 1k`         | Boot, request and typing timings for one checkout     |
| `bun run perf:compare --base origin/main`  | Paired runs of a base ref against your working tree   |
| `bun run perf:clicks --profile 1k`         | Clicks in Chromium under desktop and phone conditions |
| `bun run perf:io --profile 1k`             | File I/O and SQL per hot request, against budgets     |
| `bun run perf:bundle`                      | Bundle sizes against budgets (after a web build)      |
| `bun run perf:guards`                      | Static speed guards (see `docs/performance.md`)       |
| `bun scripts/perf/smoke.ts`                | perf-smoke: structural budgets on the 100 fixture     |
| `bun scripts/perf/gate.ts --results <dir>` | Paired timing gate over click and server results      |

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
`perf/markdown` and `perf/html`, and for files two small images uploaded to
`perf/files/` and `perf/with-images`, a Markdown Doc that embeds both.

Documents are written through the managed write path that REST and MCP use,
so the workspace has real identities, provenance, version history and
activity. Spaces, records and threads use the canonical fixture builders in
`packages/server/src/fixtures`. The same seed gives the same content; ids and
save times come from the store, as in production.

A fixture is kept in `.local-dev/perf/fixtures/<profile>-seed<seed>/` and
reused until `fixtures.ts` changes; `--force` regenerates it. It is built in
`.local-dev/perf/runs/<profile>-seed<seed>/`, and every run restores a fresh
copy to that same path: the server keys machine-local state such as activity
history and the records index by workspace path, so a run starts like a
restart of an existing workspace. The generator builds the records index for
the same reason. Generation is slow because every write goes through the
store: on a busy 6-core machine `100` took 20 seconds and `1k` 21 minutes
(350 MB), mostly the 200-document HTML space and the records index. Generate
`5k` on an idle machine.

### Team variant

`team.ts` turns Worktable Teams on in a server running on a fixture copy,
through the routes Settings uses, so a team run starts from the same
workspace at the same path as a solo run. The solo owner activates Teams and
becomes the team's owner; a member is invited and enrolls with edit access to
about half of the Spaces (always the ones a click trace opens); a second
member holds grants on a few Spaces; and two team agents are created.
`click-trace.ts --as owner|member` and `io-count.ts --team` use it. A checkout
without Teams has no `/api/team` route, and those options fail with an error
that says so.

## Server timings

`server.ts` boots `packages/server` from a checkout (`--checkout`, default this
one) on a copy of the fixture and records:

- **Boot:** time to the listening line, to the first `/api/spaces` response,
  and until the server goes idle after its boot work (Linux only; it rescans
  every record file on start). Steady-state timings start once it is idle; a
  server still busy after 5 minutes fails the run.
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

A request that fails or takes longer than two minutes fails the run, so errors
never pass for fast responses. When the server sends `Server-Timing` headers,
the first and a warm header of each endpoint are kept; when it exposes
`GET /api/diagnostics/perf`, that response is kept too. Each run writes
`result.json` and `summary.md` to
`.local-dev/perf/results/<time>-server-<profile>/` (or `--out`).

## Base against candidate

`compare.ts` exports `--base` (and `--candidate`, or uses your working tree)
into `.local-dev/perf/checkouts/`, installs dependencies once per commit,
generates the fixture once, then alternates the two for `--rounds` (default 5)
on the same machine: base first in even rounds, candidate first in odd ones.
`compare.md` lists each metric's median per side with its lowest and highest
round, the change and how many rounds the candidate was faster. Defaults:
`--profile 1k --samples 10 --typing-minutes 2`.

Timings are advisory. Plan 15 keeps timing budgets advisory until 20
comparable runs exist; a change inside the round-to-round ranges is noise. Use the same machine for both sides and keep it otherwise idle. A
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

## Clicks in a browser

`click-trace.ts` measures what a person waits for: it drives headless Chromium
through the app on a copy of a fixture and times each click. It boots the
server from this checkout (or `--checkout <dir>`, which needs its own web
build) with the production web build (`WORKTABLE_STATIC_DIR`) and
`WORKTABLE_REQUIRE_AUTH=1`, signed in, as an instance behind a tunnel runs:
responses are compressed and the page carries its boot data. It adds Spaces
up to `--spaces` (default 28) and two 60-block rich documents under `perf/`.

`--as` picks who clicks: `solo` (the default) is the owner of a Worktable
without Teams; `owner` and `member` turn Teams on in the copy first (see
[Team variant](#team-variant)) and click as the team's owner or as the member
who can open half the Spaces.

Network profiles (`--networks`, all by default), applied with the Chrome
DevTools Protocol:

| Profile    | Round trip | Bandwidth          | CPU | Transport                                 |
| ---------- | ---------- | ------------------ | --- | ----------------------------------------- |
| `local`    | none       | unlimited          | 1x  | HTTP/1.1 to the server                    |
| `desktop`  | 40 ms      | unlimited          | 1x  | HTTP/2 through a local proxy (Cloudflare) |
| `phone`    | 150 ms     | 10 Mbps down, 3 up | 4x  | HTTP/2 through the proxy, Pixel 7, touch  |
| `phone-h1` | 150 ms     | 10 Mbps down, 3 up | 4x  | HTTP/1.1 to the server (Tailscale), touch |

The proxy is Caddy (`--caddy <path>`, default `caddy` on `PATH`), needed only
for `desktop` and `phone`. Over HTTP/1.1 Chromium opens at most six
connections per host, which queues a cold load's modules.

Per round and profile it runs cold page loads of each screen (new browser
context), then one tab that clicks through the journeys four times: first
visit in the tab, warm with new targets, revisit, and revisit after
`--idle-seconds` (default 20) of idle; and reopens the app with a warm cache.
The journeys are opening a Space from the sidebar, a Markdown, a rich (60 and
2,000 blocks) and an HTML document, an image's file page, a Doc with images
(content once its images have loaded), going back to Home, the Threads list,
a thread, and a search. Desktop clicks hover 150 ms first; the phone taps.

For each click it records:

- **content**: when the screen's meaningful content is in the DOM (a
  predicate per screen in `click-trace-page.ts`, such as Recent rows on Home
  or the document's first heading), and for rich documents when the editor is
  editable and when the Yjs room connected and synced;
- **settled**: the last request, DOM change or long task before a second of
  quiet;
- every request with its phases, bytes, `Server-Timing` and initiator, the JS
  and CSS fetched, long tasks and long animation frames;
- the chain of requests content waited for, and a main-thread breakdown
  (script, style and layout, paint) from a Chrome trace (`--no-trace` skips
  it).

Two optional passes run after the others, in the same tab, as revisits:

- **`--churn`** (with `--as member`): before each click the owner makes one
  admin change, 5 to 10 s apart, in turn: an invitation, an agent rename, a
  new Space the member cannot see, a grant change for the other member on a
  Space the member has open, and, as the control, a grant or revoke for the
  member on a Space no journey opens. For the 3 s after each change it
  records the tab's full reloads, route changes and requests. A change that
  leaves the member's access alone should cause none of them; the control
  should cause one refetch of the Spaces list. A new Space starts shared, so
  the member can see it until the owner restricts it a moment later.
- **`--backup`**: live operator snapshots run back to back, through the local
  operator entry point that `worktable-server workspace-snapshot` and hosted
  backups use, while the tab clicks and a second client reads every 100 ms
  and writes every second. It records the reads and writes that overlapped a
  snapshot, how many failed or were refused, the longest write wait, the
  tab's failed requests and its slowest click.

`summary.md` also counts document content requests on revisits, which should
be zero.

`--passes cold,first,warm,revisit,reopen,idle` runs only the listed passes
(all by default). `--idle-window <seconds>` leaves the tab at Home after it
reopens the app and records every request it makes in that time
(`idleWindows` in `result.json`). Each click also records `domNodes`, the
elements in the page once it settles, and each request how many redirects it
followed.

`summary.md` has the tables per profile, `waterfalls.md` every round-1 click
with its requests, and `result.json` the raw records; round 1 also saves a
screenshot of each settled screen and the phone's Chrome traces. Rewrite the
Markdown from a `result.json` with
`bun scripts/perf/click-trace-report.ts <result.json>`.

`--raw-traces` adds JS sampling and JS stacks to the Chrome traces and saves
every measured action's trace, each round and profile, as
`traces/trace-<profile>-<pass>-<journey>-r<round>.json.gz`. Open one in the
DevTools Performance panel for the call stacks behind a long task, the timer
or request that scheduled it, and each request's initiator. The web build has
no source maps; build with `vite build --sourcemap hidden` to map the frames.

Two limits of the emulation: Chromium applies the round trip as a minimum,
not on top of server time, so a slow response looks up to one round trip
faster than it would be; and it does not throttle an HTML document's frame
request, so HTML documents look about one round trip faster on emulated
profiles.

Locally it needs a fixture, a web build and Playwright's Chromium:

```sh
bun run perf:fixtures --profile 100
WORKTABLE_BUILD_ID=local bun run --cwd apps/web build
bunx playwright@1.61.1 install --with-deps chromium
bun run perf:clicks --profile 100 --rounds 1 --networks local,phone-h1
```

Set `WORKTABLE_BUILD_ID` for the web build until the build writes the same id
it compiles into the client; without it the served app reloads on every
navigation.

### On Namespace

`click-trace-remote.sh` runs it through `ns-verify`. It installs the pinned
Bun and Node and Caddy under `$HOME/toolchains`, copies the snapshot to a
stable checkout under `$HOME/perf-click-trace` (the fixture is keyed by its
path, so it is generated once and reused), builds the web app and writes
results to `click-results/`. Pass the commit being measured first, then any
`click-trace.ts` options. A smoke run checks the screens in about eight minutes:

```sh
ns-verify --repo . --timeout 5400 --collect click-results -- \
  bash scripts/perf/click-trace-remote.sh "$(git rev-parse --short HEAD)" \
  --profile 100 --rounds 1 --networks local,phone --idle-seconds 2 \
  --content-timeout 15
```

The full run (1k fixture, 3 rounds, all profiles) took 83 minutes on an
8-vCPU worker, including generating the fixture (5 minutes) the first time:

```sh
ns-verify --repo . --timeout 10800 --collect click-results -- \
  bash scripts/perf/click-trace-remote.sh "$(git rev-parse --short HEAD)" \
  --profile 1k --rounds 3
```

Namespace stops a devbox it sees as idle, and an instance stopped at that
deadline comes back "not shut down cleanly" and will not start. The script
writes a task marker in `$NAMESPACE_DEVBOX_TASKS_DIR` for the whole run and
runs `sync` before it exits, so the stop that follows finds every write on
disk. Keep a run inside the `--timeout` you give `ns-verify` (at most
10,800 s); results are written as each profile finishes, so a run cut short
still returns its finished rounds.

## File I/O and SQL per request

`io-count.ts` counts what one hot request costs the server in file system
calls and SQL. It boots the server from a checkout (`--checkout`, default this
one) on a fixture copy with `WORKTABLE_REQUIRE_AUTH=1` and a session cookie,
under `strace -f --seccomp-bpf` from the start, with
`io-count-preload.ts` (`bun --preload`) logging every SQL statement and timer
callback. strace is needed because Bun binds `node:fs` imports before a
preload could wrap them; bun:sqlite statements can be wrapped. Without
`--team` it measures as the solo owner; with `--team`, as the team's owner and
as the member (see [Team variant](#team-variant)).

Per endpoint (the Spaces list, a Space, its documents, the document page,
document content by revision, Recent, Pending, threads, search and
`/api/workspace`) it sends 3 warm-up requests, then `--requests` (default 20)
in sequence, then stays idle for as long; the per-request figure is the
difference over the request count. Each endpoint is measured `--attempts`
times (default 2). The attempt with the quietest idle window is kept, and
among equally quiet ones the attempt whose requests did the least, since
background work only adds to a window; `idleNoise` in `result.json` shows
what was subtracted. Calls count when they
touch the workspace or the app directory:

- **stat**: stat, lstat, newfstatat, statx, access, and fstat on a file;
- **open**, **read** and **readdir** (getdents), with reads of SQLite files
  apart;
- **SQL**: the server's statements, and Better Auth's own (its session and
  user lookups) apart.

`summary.md` lists the busiest paths and statements per endpoint, with the
code site of each statement. A calibration request (a document read through
the legacy route after its file changed) must show the file's open and read,
or the run fails.

A second boot without strace (skipped with `--no-timing`) records p50 and p95 per endpoint over
`--samples` (default 50) requests, the time for one Space change to reach
`--sockets` (default 20) WebSockets, and the server's CPU time, main-thread
wake-ups and timer callbacks while idle with no sockets and with `--sockets`
open tabs.

Budgets are relative to a base run, because `main` itself already does file
I/O on most of these requests. `--base <result.json>` names a solo counting
run of the base (usually `main`), and `--check` fails the run when an
endpoint costs more than the base's figure for the same endpoint plus the
allowance in `io-budgets.json`: for solo, 3 more stat-family calls and no
more SQL; for a team, 4 more stats and 1 more statement of ours, and at most
2 of Better Auth's. `summary.md` shows the base's figures in brackets.

```sh
bun run perf:io --profile 100 --requests 10 --samples 10
bun run perf:io --profile 1k --checkout ../base --out .local-dev/perf/results/base-io
bun run perf:io --profile 1k --team \
  --base .local-dev/perf/results/base-io/result.json --check
```

On Namespace, `PERF_TOOL=io-count` makes `click-trace-remote.sh` run it
instead of the click trace (no web build or browser; it installs strace if
missing):

```sh
ns-verify --repo . --timeout 3600 --collect click-results -- \
  env PERF_TOOL=io-count bash scripts/perf/click-trace-remote.sh \
  "$(git rev-parse --short HEAD)" --profile 1k
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

## perf-smoke

`smoke.ts` is the pull request gate (`.github/workflows/perf-smoke.yml`). It
generates the `100` fixture if needed, runs the click lane once on the desktop
profile with the passes cold, first, warm, revisit and reopen and a 75-second
idle window, then io-count's counting run without timings, and checks the
counts against `smoke-budgets.json`. What each budget guards is in
[Speed gates](../../docs/performance.md#speed-gates). It needs a web build of
the checkout, Playwright's Chromium, Caddy and strace, so run it on Namespace
or in CI rather than on a shared machine:

```sh
WORKTABLE_BUILD_ID=smoke bun run --cwd apps/web build
bun scripts/perf/smoke.ts                 # check
bun scripts/perf/smoke.ts --update        # rewrite budgets to the measured counts
bun scripts/perf/smoke.ts --clicks <clicks/result.json> --io <io/result.json>
```

Counts here are the same on every run of a commit, with two allowances: an
io-count figure may exceed its budget by half a call (it is a mean over
several requests), and a request that lands in the next click's window
counts against that click only if the pass's total also rises. A raised
budget needs a new `why`, which `bun run perf:guards` checks. A dispatch of
the workflow with `sha` measures another commit with the dispatching ref's
tooling and budgets.

## Paired gate

`gate.ts` compares paired timing runs of a base and a head: click-trace
results (median time to content per network, pass and journey, and per pass
the typical journey) and io-count timing results (median solo p95 per
route). It sorts every `result.json` under `--results` by its `commit`. A
change fails only above both its floor (max(10%, 30 ms) per journey, 5% per
pass, 10% or 1 ms per route) and `--k` standard errors of the change, from
the run-to-run spread pooled per network and pass. `--plan` writes the
passes to re-time for a confirmation run; `--confirm <verdict.json>` keeps
only regressions an earlier, independent run also found; `--check` exits 1
on a regression and 2 when the sides do not pair. The private perf-nightly
and release workflows run it after `perf-gates.sh` in its `paired` mode; see
[Speed gates](../../docs/performance.md#speed-gates) for the stages.

```sh
bun scripts/perf/gate.ts --results results/ --base <sha> --head <sha> --k 3 --out verdict.json
```
