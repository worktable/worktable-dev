import { infiniteQueryOptions, queryOptions, useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query"
import { useEffect } from "react"
import {
  getSpaces,
  getSpace,
  getWorkspace,
  searchWorkspace,
} from "./api"
import { getWidget } from "./widgets-api"
import { getRecordCollectionHealth, listRecordCollections, listRecords, queryRecords } from "./records-api"
import { docQueryKeys } from "./docs-queries"
import type { RecordQuery, SearchResult } from "@worktable/types"

/** Grid-facing query params; a stable subset of RecordQuery used as a cache key. */
export interface RecordPageParams {
  search?: string
  where?: Record<string, unknown>
  orderBy?: Array<{ field: string; dir?: "asc" | "desc" }>
  includeArchived?: boolean
  expand?: RecordQuery["expand"]
}

export const queryKeys = {
  spaces: ["spaces"] as const,
  workspace: ["workspace"] as const,
  space: (id: string) => ["spaces", id] as const,
  widget: (spaceId: string, widgetId: string) =>
    ["spaces", spaceId, "widgets", widgetId] as const,
  recordCollections: (spaceId: string) => ["spaces", spaceId, "records"] as const,
  records: (spaceId: string, collectionId: string) =>
    ["spaces", spaceId, "records", collectionId] as const,
  // Nested under records(...) so the WS record_update invalidation covers it.
  recordPages: (spaceId: string, collectionId: string, params: RecordPageParams) =>
    ["spaces", spaceId, "records", collectionId, "pages", params] as const,
  search: (opts: {
    query: string
    spaceId?: string
    includeArchived?: boolean
    maxResults?: number
  }) => ["search", opts] as const,
}

export const spacesQueryOptions = () =>
  queryOptions({
    queryKey: queryKeys.spaces,
    queryFn: getSpaces,
    staleTime: 10_000,
    refetchInterval: 15_000,
    refetchOnWindowFocus: "always",
    refetchOnReconnect: "always",
  })

export const workspaceQueryOptions = () =>
  queryOptions({
    queryKey: queryKeys.workspace,
    queryFn: getWorkspace,
    staleTime: 5 * 60_000,
  })

export const spaceQueryOptions = (spaceId: string) =>
  queryOptions({
    queryKey: queryKeys.space(spaceId),
    queryFn: () => getSpace(spaceId),
    staleTime: 2 * 60_000,
  })

export const widgetQueryOptions = (spaceId: string, widgetId: string) =>
  queryOptions({
    queryKey: queryKeys.widget(spaceId, widgetId),
    queryFn: () => getWidget(spaceId, widgetId),
    staleTime: 2 * 60_000,
  })

export const recordCollectionsQueryOptions = (spaceId: string) =>
  queryOptions({
    queryKey: queryKeys.recordCollections(spaceId),
    queryFn: () => listRecordCollections(spaceId),
    staleTime: 30_000,
  })

export const recordsQueryOptions = (spaceId: string, collectionId: string) =>
  queryOptions({
    queryKey: queryKeys.records(spaceId, collectionId),
    queryFn: () => listRecords(spaceId, collectionId),
    staleTime: 30_000,
  })

// Nested under records(...) so WS record events invalidate it with the rest.
export const recordHealthQueryOptions = (spaceId: string, collectionId: string) =>
  queryOptions({
    queryKey: [...queryKeys.records(spaceId, collectionId), "health"] as const,
    queryFn: () => getRecordCollectionHealth(spaceId, collectionId),
    staleTime: 30_000,
  })

const RECORD_PAGE_SIZE = 100

/** Keyset-paginated record pages for the grid. Always routes through the v2
 *  query path (orderBy array + cursor) so sort semantics match the paged records table. */
export const recordPagesQueryOptions = (
  spaceId: string,
  collectionId: string,
  params: RecordPageParams
) =>
  infiniteQueryOptions({
    queryKey: queryKeys.recordPages(spaceId, collectionId, params),
    queryFn: ({ pageParam }) =>
      queryRecords(spaceId, collectionId, {
        ...(params.search?.trim() ? { search: params.search.trim() } : {}),
        ...(params.where ? { where: params.where } : {}),
        // Cursor pagination needs a total order; record id breaks ties server-side.
        orderBy: params.orderBy?.length ? params.orderBy : [{ field: "createdAt", dir: "desc" }],
        ...(params.includeArchived ? { includeArchived: true } : {}),
        ...(params.expand && Object.keys(params.expand).length > 0 ? { expand: params.expand } : {}),
        limit: RECORD_PAGE_SIZE,
        ...(pageParam ? { cursor: pageParam } : {}),
      }),
    initialPageParam: "",
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    staleTime: 30_000,
  })

export const searchQueryOptions = (opts: {
  query: string
  spaceId?: string
  includeArchived?: boolean
  maxResults?: number
}) =>
  queryOptions({
    queryKey: queryKeys.search(opts),
    queryFn: () => searchWorkspace(opts),
    staleTime: 30_000,
    enabled: opts.query.trim().length > 0,
  })

export function useSpaces() {
  const queryClient = useQueryClient()
  const query = useQuery(spacesQueryOptions())

  useEffect(() => {
    if (!query.data) return
    for (const space of query.data) {
      if (space.docs && queryClient.getQueryData(docQueryKeys.docs(space.id)) === undefined) {
        // Seed COLD caches only, and stale-at-birth: the all-spaces payload
        // carries UNDECORATED docs (no freshness or backlink counts). Seeding
        // over existing data would clobber the decorated shape on every
        // all-spaces refetch; skipping warm caches keeps the instant
        // first-navigation paint without ever regressing richer data.
        queryClient.setQueryData(docQueryKeys.docs(space.id), space.docs, { updatedAt: 0 })
      }
    }
  }, [query.data, queryClient])

  return query
}

export function useWorkspace() {
  return useQuery(workspaceQueryOptions())
}

export function useSpace(spaceId: string) {
  return useQuery(spaceQueryOptions(spaceId))
}

export function useWidget(spaceId: string, widgetId: string) {
  return useQuery(widgetQueryOptions(spaceId, widgetId))
}

export function useRecordCollections(spaceId: string) {
  return useQuery(recordCollectionsQueryOptions(spaceId))
}

export function useRecords(spaceId: string, collectionId: string, enabled = true) {
  return useQuery({ ...recordsQueryOptions(spaceId, collectionId), enabled })
}

export function useRecordCollectionHealth(spaceId: string, collectionId: string) {
  return useQuery(recordHealthQueryOptions(spaceId, collectionId))
}

/** Group totals for the grouped grid: one aggregate query over the SAME
 *  filter scope as the pages, so header counts cover all matching records,
 *  not just loaded ones. */
export function useRecordGroups(
  spaceId: string,
  collectionId: string,
  params: RecordPageParams & { groupBy?: string; sums?: string[] }
) {
  const { groupBy, sums, ...scope } = params
  return useQuery({
    queryKey: [...queryKeys.records(spaceId, collectionId), "groups", { ...scope, groupBy, sums }] as const,
    queryFn: () =>
      queryRecords(spaceId, collectionId, {
        ...(scope.search?.trim() ? { search: scope.search.trim() } : {}),
        ...(scope.where ? { where: scope.where } : {}),
        ...(scope.includeArchived ? { includeArchived: true } : {}),
        aggregate: {
          groupBy: groupBy ?? "",
          select: {
            count: { fn: "count" },
            ...Object.fromEntries((sums ?? []).map((field) => [`sum:${field}`, { fn: "sum" as const, field }])),
          },
        },
      }),
    enabled: Boolean(groupBy),
    staleTime: 30_000,
  })
}

export function useRecordPages(
  spaceId: string,
  collectionId: string,
  params: RecordPageParams
) {
  return useInfiniteQuery(recordPagesQueryOptions(spaceId, collectionId, params))
}

export function useSearchResults(opts: {
  query: string
  spaceId?: string
  includeArchived?: boolean
  maxResults?: number
}): ReturnType<typeof useQuery<SearchResult[]>> {
  return useQuery(searchQueryOptions(opts))
}
