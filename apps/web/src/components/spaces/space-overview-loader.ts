import { lazy } from "react"

type SpaceOverviewModule = typeof import("./space-overview")
type SpaceOverviewComponent = SpaceOverviewModule["SpaceOverview"]

// Space Home's page is its own chunk: a document opens in the Space's layout
// without it. The chunk is asked for as the navigation starts (and on hover,
// through the route's preload), so by the click it is usually in. A lazy
// component still suspends on its first render then, and React holds what a
// Suspense boundary reveals for 300 ms, so Space Home started its own
// requests that late. Once the chunk is in, the page renders it directly.
// This lives outside the route file, whose page and loader are split apart.
let loaded: SpaceOverviewComponent | undefined

export function loadSpaceOverview(): Promise<SpaceOverviewModule> {
  return import("./space-overview").then((module) => {
    loaded = module.SpaceOverview
    return module
  })
}

const LazySpaceOverview = lazy(() =>
  loadSpaceOverview().then((module) => ({ default: module.SpaceOverview }))
)

/** Space Home's page: the loaded component, or a lazy one until it loads. */
export function spaceOverviewComponent() {
  return loaded ?? LazySpaceOverview
}
