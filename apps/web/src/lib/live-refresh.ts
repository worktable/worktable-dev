import type {
  InvalidateQueryFilters,
  Query,
  QueryClient,
} from "@tanstack/react-query"

const trailing = new WeakSet<Query>()

function whenIdle(queryClient: QueryClient, query: Query): Promise<void> {
  if (query.state.fetchStatus !== "fetching") return Promise.resolve()
  return new Promise((resolve) => {
    const unsubscribe = queryClient.getQueryCache().subscribe((event) => {
      if (
        event.query === query &&
        (event.type === "removed" || query.state.fetchStatus !== "fetching")
      ) {
        unsubscribe()
        resolve()
      }
    })
  })
}

/**
 * Refresh queries after a change the server reported. A read already in
 * flight is joined rather than restarted, so a burst of changes costs one
 * request; because that read may have begun before this change, one more read
 * follows it. Only queries on screen refetch; the rest are marked stale.
 */
export function refreshLive(
  queryClient: QueryClient,
  filters: InvalidateQueryFilters[]
): void {
  if (filters.length === 0) return
  const cache = queryClient.getQueryCache()
  const behind = new Set<Query>()
  for (const filter of filters) {
    for (const query of cache.findAll(filter)) {
      if (query.state.fetchStatus === "fetching") behind.add(query)
    }
  }
  for (const filter of filters) {
    void queryClient.invalidateQueries(filter, { cancelRefetch: false })
  }
  for (const query of behind) {
    if (trailing.has(query)) continue
    trailing.add(query)
    void whenIdle(queryClient, query).then(() => {
      trailing.delete(query)
      void queryClient.invalidateQueries(
        { queryKey: query.queryKey, exact: true },
        { cancelRefetch: false }
      )
    })
  }
}
