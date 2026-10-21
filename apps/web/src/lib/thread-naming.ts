import {
  useMutation,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query"
import type {
  ThreadLocation,
  ThreadListItem,
  ThreadReadResult,
  ThreadRenameResult,
} from "@worktable/types"
import { threadLocationKey } from "@worktable/types/constants"
import { renameThread } from "./threads-api"
import { threadQueryKeys } from "./threads-queries"

export function useThreadRename(location: ThreadLocation) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: {
      threadId: string
      title: string
      expectedTitle: string
    }) => renameThread(location, input.threadId, input),
    onSuccess: (renamed) => applyThreadRename(queryClient, location, renamed),
  })
}

/** A preview-setting change can change capabilities without changing content. */
export async function refreshThreadNamingCapabilities(
  queryClient: QueryClient
): Promise<void> {
  const details = queryClient
    .getQueryCache()
    .findAll({ queryKey: [...threadQueryKeys.root, "detail"] })
  await Promise.all(
    details.map(({ queryKey }) =>
      queryClient.invalidateQueries({ queryKey, exact: true })
    )
  )
}

/** A rename changes metadata only; keep the cached conversation and list rows. */
export function applyThreadRename(
  queryClient: QueryClient,
  location: ThreadLocation,
  renamed: ThreadRenameResult
): void {
  const metadata = {
    title: renamed.title,
    revision: renamed.revision,
    updatedAt: renamed.updatedAt,
  }
  queryClient.setQueryData<ThreadReadResult>(
    threadQueryKeys.detail(location, renamed.threadId),
    (current) =>
      current && current.thread.revision <= renamed.revision
        ? { ...current, thread: { ...current.thread, ...metadata } }
        : current
  )
  for (const scope of [{ kind: "all" } as const, location]) {
    queryClient.setQueryData<{ threads: ThreadListItem[] }>(
      threadQueryKeys.list(scope),
      (current) =>
        current && {
          ...current,
          threads: current.threads
            .map((thread) =>
              thread.id === renamed.threadId &&
              threadLocationKey(thread.location) ===
                threadLocationKey(location) &&
              thread.revision <= renamed.revision
                ? { ...thread, ...metadata }
                : thread
            )
            .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
        }
    )
  }
}
