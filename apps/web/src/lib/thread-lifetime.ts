import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useState, useSyncExternalStore } from "react"
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
import {
  threadListKeys,
  threadQueryKeys,
  threadQueryOptions,
} from "./threads-queries"

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

/**
 * The view a list beside an open thread shows: the one asked for, or, when
 * the thread is one its filter leaves out (an agents' thread under People),
 * the one that holds it. Only for that thread, and only until someone picks
 * a view while it is open; the remembered filter stays as it was.
 */
export function useShownThreadView(
  location: ThreadLocation,
  threadId: string,
  view: ThreadListView
): [ThreadListView, () => void] {
  // Read from the cache the open thread fills; this asks for nothing.
  const open = useQuery({ ...threadQueryOptions(location, threadId), enabled: false })
  const [pickedFor, setPickedFor] = useState<string | null>(null)
  const members = open.data?.thread.members
  let shown = view
  if (members && pickedFor !== threadId && (view === "people" || view === "agents")) {
    const withPeople = members.some((member) => member.kind === "human")
    if (withPeople !== (view === "people")) shown = withPeople ? "people" : "agents"
  }
  return [shown, () => setPickedFor(threadId)]
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
