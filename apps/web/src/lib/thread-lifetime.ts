import { useMutation, useQueryClient } from "@tanstack/react-query"
import { useSyncExternalStore } from "react"
import {
  isStoredThreadArchived,
  THREAD_LIFETIME_KEY,
  threadLifetimeChoice,
  type Thread,
  type ThreadLifetimeChoice,
  type ThreadLifetimeResult,
  type ThreadLifetimeState,
  type ThreadListItem,
  type ThreadLocation,
  type ThreadReadResult,
} from "@worktable/types"
import { fetchJSON } from "./http"
import type { ThreadListFilter, ThreadListView } from "./thread-list-view"
import { threadBase } from "./threads-api"
import { threadListKeys, threadQueryKeys } from "./threads-queries"

function setThreadLifetime(
  location: ThreadLocation,
  threadId: string,
  state: ThreadLifetimeState
): Promise<ThreadLifetimeResult> {
  return fetchJSON(
    `${threadBase(location)}/${encodeURIComponent(threadId)}/lifetime`,
    { method: "PUT", body: JSON.stringify({ state }) }
  )
}

/** The threads a view shows, from the list it reads. */
export function threadsInView(
  threads: ThreadListItem[],
  view: ThreadListView
): ThreadListItem[] {
  if (view === "all" || view === "archived") return threads
  const withPeople = view === "people"
  return threads.filter(
    (thread) =>
      thread.members.some((member) => member.kind === "human") === withPeople
  )
}

// ── Remembered filter ──────────────────────────────────────

const FILTER_KEY = "worktable-thread-list-filter"
const filterListeners = new Set<() => void>()
let fallbackFilter: ThreadListFilter | undefined

/** Threads with people unless the person last chose otherwise. */
function readFilter(): ThreadListFilter {
  try {
    const stored = localStorage.getItem(FILTER_KEY)
    return stored === "agents" || stored === "all" ? stored : "people"
  } catch {
    return "people"
  }
}

function writeFilter(filter: ThreadListFilter): void {
  try {
    localStorage.setItem(FILTER_KEY, filter)
  } catch {
    // Private browsing: the choice lasts until the page reloads.
    fallbackFilter = filter
  }
  for (const listener of filterListeners) listener()
}

function subscribeFilter(listener: () => void): () => void {
  filterListeners.add(listener)
  const onStorage = (event: StorageEvent) => {
    if (event.key === FILTER_KEY) listener()
  }
  window.addEventListener("storage", onStorage)
  return () => {
    filterListeners.delete(listener)
    window.removeEventListener("storage", onStorage)
  }
}

/**
 * The filter every thread list opens on: one choice for the Threads page and
 * each Space's, kept in this browser so leaving and coming back keeps it.
 */
export function useThreadListFilter(): [
  ThreadListFilter,
  (filter: ThreadListFilter) => void,
] {
  const filter = useSyncExternalStore(
    subscribeFilter,
    () => fallbackFilter ?? readFilter()
  )
  return [filter, writeFilter]
}

/** Where an open thread stands: kept, archived, or neither. */
export function threadLifetime(
  thread: Thread,
  nowMs: number
): { choice?: ThreadLifetimeChoice; archived: boolean } {
  const choice = threadLifetimeChoice(thread)
  return {
    ...(choice ? { choice } : {}),
    archived: isStoredThreadArchived(thread, nowMs),
  }
}

/** Keep a thread, archive it, or return it to the usual rule. */
export function useThreadLifetime(location: ThreadLocation) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: { threadId: string; state: ThreadLifetimeState }) =>
      setThreadLifetime(location, input.threadId, input.state),
    onSuccess: (changed) => {
      queryClient.setQueryData<ThreadReadResult>(
        threadQueryKeys.detail(location, changed.threadId),
        (current) =>
          current && current.thread.revision <= changed.revision
            ? {
                ...current,
                thread: {
                  ...current.thread,
                  [THREAD_LIFETIME_KEY]: changed.lifetime,
                  revision: changed.revision,
                },
              }
            : current
      )
      // The choice moves the thread between the lists and the archive.
      for (const queryKey of threadListKeys(location)) {
        void queryClient.invalidateQueries({ queryKey, exact: true })
      }
    },
  })
}
