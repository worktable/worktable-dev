import {
  infiniteQueryOptions,
  queryOptions,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query"
import type {
  ActivityActor,
  ActivityPage,
  PendingResult,
} from "@worktable/types"
import { abandonableRead, fetchJSON } from "./http.ts"
import { pollUnlessLive } from "./space-observation.ts"

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
  /** One doc in `spaceId`. */
  docPath?: string
  limit?: number
}

function activityUrl(options: ActivityOptions, before?: string | null): string {
  const query = new URLSearchParams({
    limit: String(options.limit ?? 30),
    timezoneOffset: String(new Date().getTimezoneOffset()),
    ...(options.spaceId ? { spaceId: options.spaceId } : {}),
    ...(options.actor ? { actor: options.actor } : {}),
    ...(options.actorId ? { actorId: options.actorId } : {}),
    ...(options.docPath ? { docPath: options.docPath } : {}),
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

/** The newest entries, kept current by the Space's socket where there is one. */
export function useActivity(options: ActivityOptions, enabled = true) {
  return useQuery({
    ...activityQueryOptions(options),
    enabled,
    refetchInterval: pollUnlessLive(options.spaceId),
  })
}

/** Every entry, a page at a time, for the Activity page. */
export function useActivityPages(options: ActivityOptions) {
  return useInfiniteQuery(
    infiniteQueryOptions({
      queryKey: [...activityQueryKeys.list(options), "pages"] as const,
      queryFn: (context) =>
        abandonableRead(context, (read) =>
          fetchJSON<ActivityPage>(activityUrl(options, context.pageParam), read)
        ),
      initialPageParam: null as string | null,
      getNextPageParam: (page) => page.nextCursor,
      staleTime: 10_000,
      refetchInterval: pollUnlessLive(options.spaceId),
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
    refetchInterval: pollUnlessLive(spaceId),
  })
}

const pendingDoneKey = ["pending", "done"] as const

/**
 * Mark something that waits on the reader as done without answering it. The
 * row leaves at once and comes back if the server refuses. `spaceId` is the
 * Space whose list showed it.
 */
export function useMarkPendingDone(spaceId?: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationKey: pendingDoneKey,
    mutationFn: (id: string) =>
      fetchJSON<{ ok: true }>("/api/pending/done", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, ...(spaceId ? { spaceId } : {}) }),
      }),
    onMutate: async (id) => {
      await queryClient.cancelQueries({ queryKey: activityQueryKeys.pending })
      // Each list that shows the row, and where the row sat in it.
      const removed = queryClient
        .getQueriesData<PendingResult>({ queryKey: activityQueryKeys.pending })
        .flatMap(([key, data]) => {
          const index = data?.items.findIndex((item) => item.id === id) ?? -1
          return index < 0 ? [] : [{ key, index, item: data!.items[index]! }]
        })
      for (const { key } of removed) {
        queryClient.setQueryData<PendingResult>(key, (current) => {
          if (!current) return current
          const items = current.items.filter((item) => item.id !== id)
          return { items, total: items.length }
        })
      }
      return { removed }
    },
    // Only this row returns: another row marked done meanwhile stays gone.
    onError: (_error, id, context) => {
      for (const { key, index, item } of context?.removed ?? []) {
        queryClient.setQueryData<PendingResult>(key, (current) => {
          if (!current || current.items.some((other) => other.id === id)) {
            return current
          }
          const items = [...current.items]
          items.splice(Math.min(index, items.length), 0, item)
          return { items, total: items.length }
        })
      }
    },
    // Read the lists again once nothing else is on its way, so a list read
    // in between does not bring back a row that is still being marked done.
    onSettled: () => {
      if (queryClient.isMutating({ mutationKey: pendingDoneKey }) > 1) return
      return queryClient.invalidateQueries({
        queryKey: activityQueryKeys.pending,
      })
    },
  })
}
