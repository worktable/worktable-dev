import {
  infiniteQueryOptions,
  queryOptions,
  useInfiniteQuery,
  useQuery,
} from "@tanstack/react-query"
import type {
  ActivityActor,
  ActivityPage,
  PendingResult,
} from "@worktable/types"
import { fetchJSON } from "./http.ts"

export const activityQueryKeys = {
  all: ["activity"] as const,
  list: (options: ActivityOptions) => ["activity", options] as const,
  agents: (spaceId?: string) =>
    ["activity", "agents", spaceId ?? null] as const,
  pending: ["pending"] as const,
  pendingIn: (spaceId?: string) => ["pending", spaceId ?? null] as const,
}

export interface ActivityOptions {
  spaceId?: string
  actor?: "person" | "agent"
  /** One actor, such as a single agent. */
  actorId?: string
  limit?: number
}

function activityUrl(options: ActivityOptions, before?: string | null): string {
  const query = new URLSearchParams({
    limit: String(options.limit ?? 30),
    timezoneOffset: String(new Date().getTimezoneOffset()),
    ...(options.spaceId ? { spaceId: options.spaceId } : {}),
    ...(options.actor ? { actor: options.actor } : {}),
    ...(options.actorId ? { actorId: options.actorId } : {}),
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
export function useActivity(options: ActivityOptions, enabled = true) {
  return useQuery({
    ...activityQueryOptions(options),
    enabled,
    refetchInterval: 30_000,
  })
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

/** Agents that appear in Activity, most recently active first. */
export function useActivityAgents(spaceId?: string) {
  return useQuery({
    queryKey: activityQueryKeys.agents(spaceId),
    queryFn: () =>
      fetchJSON<{ agents: ActivityActor[] }>(
        `/api/activity/agents${spaceId ? `?spaceId=${encodeURIComponent(spaceId)}` : ""}`
      ),
    staleTime: 60_000,
  })
}

/** What is waiting on the reader, across Spaces or in one. */
export function usePending(spaceId?: string) {
  return useQuery({
    queryKey: activityQueryKeys.pendingIn(spaceId),
    queryFn: () =>
      fetchJSON<PendingResult>(
        `/api/pending${spaceId ? `?spaceId=${encodeURIComponent(spaceId)}` : ""}`
      ),
    staleTime: 10_000,
    refetchInterval: 30_000,
  })
}
