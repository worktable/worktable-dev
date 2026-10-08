import {
  infiniteQueryOptions,
  queryOptions,
  useInfiniteQuery,
  useQuery,
} from "@tanstack/react-query"
import type { ActivityPage, PendingResult } from "@worktable/types"
import { fetchJSON } from "./http.ts"

export const activityQueryKeys = {
  all: ["activity"] as const,
  list: (options: ActivityOptions) => ["activity", options] as const,
  pending: ["pending"] as const,
}

export interface ActivityOptions {
  spaceId?: string
  actor?: "person" | "agent"
  limit?: number
}

function activityUrl(options: ActivityOptions, before?: string | null): string {
  const query = new URLSearchParams({
    limit: String(options.limit ?? 30),
    timezoneOffset: String(new Date().getTimezoneOffset()),
    ...(options.spaceId ? { spaceId: options.spaceId } : {}),
    ...(options.actor ? { actor: options.actor } : {}),
    ...(before ? { before } : {}),
  })
  return `/api/activity?${query}`
}

export function activityQueryOptions(options: ActivityOptions) {
  return queryOptions({
    queryKey: activityQueryKeys.list(options),
    queryFn: () => fetchJSON<ActivityPage>(activityUrl(options)),
    staleTime: 10_000,
  })
}

/** The newest entries, refreshed while on screen like Recent. */
export function useActivity(options: ActivityOptions) {
  return useQuery({ ...activityQueryOptions(options), refetchInterval: 30_000 })
}

/** Every entry, a page at a time, for the Activity page. */
export function useActivityPages(options: ActivityOptions) {
  return useInfiniteQuery(
    infiniteQueryOptions({
      queryKey: [...activityQueryKeys.list(options), "pages"] as const,
      queryFn: ({ pageParam }) =>
        fetchJSON<ActivityPage>(activityUrl(options, pageParam)),
      initialPageParam: null as string | null,
      getNextPageParam: (page) => page.nextCursor,
      staleTime: 10_000,
      refetchInterval: 30_000,
    })
  )
}

export function usePending() {
  return useQuery({
    queryKey: activityQueryKeys.pending,
    queryFn: () => fetchJSON<PendingResult>("/api/pending"),
    staleTime: 10_000,
    refetchInterval: 30_000,
  })
}
