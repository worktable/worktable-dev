# Keep Worktable fast

Worktable should feel instant for people and agents on every surface. Keep the
cost of a read close to the cost of sending what changed. These rules hold for
every change; `bun run perf:guards` enforces the ones a static check can see.

## Rules

- **One request per screen where possible.** A click should wait on one
  request, not a chain. Do not add a request a screen needs before it can
  render; extend the one it already makes.
- **Zero content requests on revisits.** A document or list the tab has
  already seen renders from the cache. Content at a revision never changes, so
  never invalidate or refetch it.
- **No new polling without registration.** Prefer a socket event, or a refetch
  when the user acts. Poll only when nothing can tell the client about a
  change, only while the screen needs it, and stop when it ends. Every
  `refetchInterval` and `setInterval` in `apps/web/src` is registered with its
  reason.
- **Exact invalidation.** Invalidate the keys a change touched. A document's
  page and content have their own keys, so a Space-wide prefix such as
  `["spaces", id]` without `exact: true` refetches open documents too.
- **No per-request catalog rebuilds or file scans.** Request handlers read
  through the catalog snapshot, thread summaries and other derived data keyed
  by file fingerprints. Never rebuild the catalog or read every thread or
  document file while answering a request.
- **Nothing on the request hot path for monitoring.** No added I/O and no
  allocation beyond what a request needs. Logs and diagnostics carry codes,
  opaque ids, counts and route templates, never document paths, titles or
  text.
- **Measure on Namespace.** Use the [perf lane](../scripts/perf/README.md),
  including `scripts/perf/io-count.ts` for file I/O and SQL per hot request,
  on a Namespace machine, and put before and after numbers in the PR.
  Maintainers run it through `perf-gates.yml` in the private repository.
  Never measure on a shared host: its timings are unreliable.

## Speed guards

`bun run perf:guards` runs in pull-request CI. It parses source and finishes
in a few seconds, without a build or a browser. It fails when:

| Guard                                | Registered in                               | To pass                                                                                          |
| ------------------------------------ | ------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| New polling                          | `scripts/perf/guards/polling.json`          | Use an event instead, or add the site with a one-line `why`.                                     |
| Unkeyed or Space-wide invalidation   | `scripts/perf/guards/invalidation.json`     | Invalidate exact keys, or add the site with a one-line `why`.                                    |
| Catalog builders on the request path | `scripts/perf/guards/catalog-builders.json` | Read through the snapshot or derived data. This list can only shrink.                            |
| A bundle budget rises                | `scripts/perf/bundle-budgets.json`          | Shrink the bundle, or add a `why` to the budget's entry saying what grew and why it is worth it. |
| A perf-smoke budget rises            | `scripts/perf/smoke-budgets.json`           | Fix the regression, or add a `why` to the budget's entry saying what it costs and why.           |

A site is its file and the enclosing function or variable, so moving lines
does not break an entry. When a registered site goes away, remove its entry:
the guard fails on stale entries too. The catalog list covers every server
caller of a catalog builder; a renamed function may move its entry, but the
count per builder cannot grow. Work that never runs while a request waits,
such as boot recovery, is listed with its reason in `BACKGROUND_FUNCTIONS` in
`scripts/perf/guards.ts`. The budget and shrink checks compare
with the pull request's base; locally they use the merge base with
`origin/main`, or pass `--base <ref>`.

## Speed gates

The perf lane measures what static checks cannot. Three gates run it:

| Gate           | When                                     | Checks                                                                                               |
| -------------- | ---------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `perf-smoke`   | Pull requests that touch the product     | Structural budgets in `scripts/perf/smoke-budgets.json`: counts, not timings                         |
| `perf-nightly` | Every night, public `main` (maintainers) | Timed clicks and server timings against a stored baseline, paired; a regression must repeat to alert |
| Release gate   | Every release (maintainers)              | The same timings, paired against the previous release; a waiver is recorded                          |

`perf-smoke` runs the click lane once, untimed, on the 100-document fixture
and io-count's counting run, in about 7 minutes beside the other checks. It
fails when one of these rises above its budget:

- requests per click, per journey and pass (API, frames and page loads);
- requests a click's content waited on one after another (the chain);
- document content requests on revisits (zero);
- requests from an untouched tab at Home over 75 seconds;
- redirects (zero);
- JavaScript files a cold page load fetches before its content;
- elements on each screen once it settles (10% headroom);
- file stats, file reads and SQL statements per hot server request.

These counts do not depend on the machine, so the gate has no timing noise.
When it fails, its summary lists the requests or paths behind each number.
Fix the regression, or, when the cost is worth it, run
`bun scripts/perf/smoke.ts --update` locally or copy the measured value into
the budget, and add a one-line `why` to each raised entry. `perf:guards`
fails a raised budget without a new `why`. Lower budgets when they fall.

Timings are never a pull request gate: phone timings move 15 to 20% between
runs on the same machine, more than the 10% limit. The nightly and release
gates pair a base and a head on one machine in alternating rounds and judge
them with `scripts/perf/gate.ts`. A change fails only when it exceeds both
its floor and k standard errors of the change, where the standard error
comes from the run-to-run spread in the same runs:

| Measure                            | Floor                          |
| ---------------------------------- | ------------------------------ |
| A journey's median time to content | 10% or 30 ms, whichever larger |
| A pass's typical journey           | 5%                             |
| A server route's median p95        | 10%, at least 1 ms under 1 ms  |

The typical journey (the median over a pass's journeys of head/base) catches
a slowdown that touches every screen long before any single noisy journey
can prove it. The nightly runs two independent stages: a 5-round screen
lists suspects at k = 2, then a confirmation re-times only their passes with
9 rounds and judges its own data at k = 3. It alerts only on a journey, pass
or route both stages found slower. With the phone's spread (about 15% per
run, about half of it shared by a run's journeys), 9 rounds detect a pass
whose typical journey is about 18% slower (around 270 ms on a 1.5 s cold
load) and a single journey about 30% slower. The release gate runs once, 3 rounds on the
desktop profile and 5 of server timings, at k = 3.
See the [perf lane](../scripts/perf/README.md) for the commands.
