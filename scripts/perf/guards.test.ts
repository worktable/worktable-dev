import { describe, expect, test } from "bun:test"
import {
  compareAllowlist,
  compareBudgets,
  compareSmokeBudgets,
  compareShrinkOnly,
  findCatalogBuilders,
  findInvalidation,
  findPolling,
} from "./guards.ts"

const register = { withKind: false, register: "Register it." }

describe("perf guards", () => {
  test("a new polling site fails until it is registered with a why", () => {
    const sources = [
      {
        file: "apps/web/src/lib/feed.ts",
        text: `export const feedOptions = () => ({ queryKey: ["feed"], refetchInterval: 5_000 })`,
      },
      {
        file: "apps/web/src/lib/clock.ts",
        text: `export function useClock(refetchInterval) { return useQuery({ queryKey: ["clock"], refetchInterval }) }`,
      },
    ]
    const sites = findPolling(sources)
    expect(sites.map((site) => site.site)).toEqual([
      "apps/web/src/lib/feed.ts#feedOptions",
      "apps/web/src/lib/clock.ts#useClock",
    ])
    const [feed] = sites

    const unregistered = compareAllowlist(
      "Polling",
      "polling.json",
      [feed!],
      { sites: [] },
      register
    )
    expect(unregistered).toHaveLength(1)
    expect(unregistered[0]!.message).toContain(
      `add {"site":"apps/web/src/lib/feed.ts#feedOptions","why":"..."} to polling.json`
    )

    const site = "apps/web/src/lib/feed.ts#feedOptions"
    expect(
      compareAllowlist(
        "Polling",
        "polling.json",
        [feed!],
        { sites: [{ site }] },
        register
      )[0]!.message
    ).toContain('needs a one-line "why"')
    expect(
      compareAllowlist(
        "Polling",
        "polling.json",
        [feed!],
        { sites: [{ site, why: "No event exists." }] },
        register
      )
    ).toEqual([])
    // A site that went away leaves a stale entry, which fails too.
    expect(
      compareAllowlist(
        "Polling",
        "polling.json",
        [],
        { sites: [{ site, why: "No event exists." }] },
        register
      )[0]!.message
    ).toContain("Remove 1 entry")
  })

  test("invalidation must be keyed and narrower than a Space", () => {
    const sites = findInvalidation([
      {
        file: "apps/web/src/lib/sync.ts",
        text: `
          export function onChange(client, spaceId, path) {
            client.invalidateQueries()
            client.invalidateQueries({ queryKey: queryKeys.space(spaceId) })
            client.invalidateQueries({ queryKey: queryKeys.space(spaceId), exact: true })
            client.invalidateQueries({ queryKey: documentQueryKeys.page(spaceId, path) })
            const refresh = [{ queryKey: ["spaces", spaceId] }]
            refreshLive(client, refresh)
            client.getQueryCache().findAll({ queryKey: ["spaces", spaceId] })
            const everything = { predicate: () => true }
            client.invalidateQueries(everything)
            return useQuery({ queryKey: queryKeys.space(spaceId), queryFn: read })
          }
        `,
      },
    ])
    expect(sites.map((site) => `${site.kind}:${site.line}`)).toEqual([
      "unkeyed:3",
      "space-wide:4",
      "space-wide:7",
      "predicate:11",
    ])
  })

  test("the catalog builder list can only shrink", () => {
    const sites = findCatalogBuilders([
      {
        file: "packages/server/src/routes/docs.ts",
        text: `import { listDocs as list } from "../store.ts"
docsRouter.get("/", async (c) => { const docs = await list(spaceId); return c.json(docs) })`,
      },
      {
        // Boot work is not on the request path.
        file: "packages/server/src/document-preflight.ts",
        text: `export async function preflightDocumentWorkspace() { await buildDocumentCatalog({}) }`,
      },
    ])
    expect(sites.map((site) => site.site)).toEqual([
      "packages/server/src/routes/docs.ts#GET /.docs",
    ])
    const site = {
      site: sites[0]!.site,
      kind: "listDocs",
      why: "Not yet moved.",
    }
    // A renamed function moves its entry without growing the list.
    expect(
      compareShrinkOnly(
        "Catalog",
        "catalog.json",
        { sites: [{ ...site, site: `${site.site}.renamed` }] },
        { sites: [site] }
      )
    ).toEqual([])
    expect(
      compareShrinkOnly(
        "Catalog",
        "catalog.json",
        { sites: [] },
        { sites: [site] }
      )
    ).toEqual([])
    expect(
      compareShrinkOnly(
        "Catalog",
        "catalog.json",
        { sites: [site] },
        { sites: [] }
      )[0]!.message
    ).toContain("can only shrink")
  })

  test("a bundle budget rises only with a new why", () => {
    const base = {
      budgets: {
        entry: { gzip: 100 },
        home: { gzip: 200, why: "Old reason." },
      },
    }
    expect(
      compareBudgets(
        {
          budgets: {
            entry: { gzip: 90 },
            home: { gzip: 200, why: "Old reason." },
          },
        },
        base
      )
    ).toEqual([])
    expect(
      compareBudgets(
        {
          budgets: {
            entry: { gzip: 110 },
            home: { gzip: 210, why: "Old reason." },
          },
        },
        base
      ).map((problem) => problem.message.split(" ")[0])
    ).toEqual(['"entry"', '"home"'])
    expect(
      compareBudgets(
        {
          budgets: {
            entry: { gzip: 110, why: "The date picker loads eagerly." },
            home: { gzip: 200 },
          },
        },
        base
      )
    ).toEqual([])
  })

  test("a perf-smoke budget rises only with a new why; new and lower budgets need none", () => {
    const base = {
      budgets: {
        "requests, first, open Space": { max: 7 },
        "io stat, recent": { max: 65, why: "Old reason." },
      },
    }
    expect(
      compareSmokeBudgets(
        {
          budgets: {
            "requests, first, open Space": { max: 8 },
            "io stat, recent": { max: 66, why: "Old reason." },
            "requests, first, open Records": { max: 3 },
          },
        },
        base
      ).map((problem) => problem.message.split(" rises")[0])
    ).toEqual(['"requests, first, open Space"', '"io stat, recent"'])
    expect(
      compareSmokeBudgets(
        {
          budgets: {
            "requests, first, open Space": {
              max: 8,
              why: "The tree loads with the Space.",
            },
            "io stat, recent": { max: 60 },
          },
        },
        base
      )
    ).toEqual([])
    const metrics = { "io stat": { why: "Stats per request.", slack: 0.5 } }
    expect(
      compareSmokeBudgets(
        {
          metrics: { "io stat": { why: "Stats per request.", slack: 1.5 } },
          budgets: base.budgets,
        },
        { metrics, budgets: base.budgets }
      ).map((problem) => problem.message.split(" metric")[0])
    ).toEqual(['The "io stat"'])
  })
})
