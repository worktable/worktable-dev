import { useMutation, useQueryClient } from "@tanstack/react-query"
import {
  isThreadArchived,
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
import type { ThreadListView } from "./thread-list-view"
import { threadBase } from "./threads-api"
import { threadQueryKeys } from "./threads-queries"

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
  view: ThreadListView,
  viewerMemberId: string | undefined
): ThreadListItem[] {
  return view === "mine"
    ? threads.filter((thread) =>
        thread.members.some((member) => member.id === viewerMemberId)
      )
    : threads
}

/** Where an open thread stands: kept, archived, or neither. */
export function threadLifetime(
  thread: Thread,
  nowMs: number
): { choice?: ThreadLifetimeChoice; archived: boolean } {
  const choice = threadLifetimeChoice(thread)
  const lastMessage = thread.messages.at(-1)
  return {
    ...(choice ? { choice } : {}),
    archived: lastMessage
      ? isThreadArchived(
          { lastMessageAt: lastMessage.createdAt, lifetime: choice },
          nowMs
        )
      : false,
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
      for (const scope of [{ kind: "all" } as const, location]) {
        for (const queryKey of [
          threadQueryKeys.list(scope),
          threadQueryKeys.archivedList(scope),
        ]) {
          void queryClient.invalidateQueries({ queryKey, exact: true })
        }
      }
    },
  })
}
