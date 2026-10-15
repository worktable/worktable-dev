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

A site is its file and the enclosing function or variable, so moving lines
does not break an entry. When a registered site goes away, remove its entry:
the guard fails on stale entries too. The catalog list covers every server
caller of a catalog builder; a renamed function may move its entry, but the
count per builder cannot grow. Work that never runs while a request waits,
such as boot recovery, is listed with its reason in `BACKGROUND_FUNCTIONS` in
`scripts/perf/guards.ts`. The budget and shrink checks compare
with the pull request's base; locally they use the merge base with
`origin/main`, or pass `--base <ref>`.

The perf lane measures what static checks cannot: requests per click, revisit
caching, render cost and server latency. See the
[perf lane](../scripts/perf/README.md) for its commands.
