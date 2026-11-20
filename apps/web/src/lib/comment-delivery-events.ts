import type { QueryClient } from "@tanstack/react-query"
import type { Annotation } from "@worktable/types"
import { refreshLive } from "./live-refresh"

/**
 * An agent's runtime moved on with a comment: the comment lists that hold it
 * read again, so the comment shows Working, Replied or not answering.
 */
export function refreshCommentDelivery(
  queryClient: QueryClient,
  annotationId: string
): void {
  refreshLive(
    queryClient,
    queryClient
      .getQueryCache()
      .findAll({ queryKey: ["annotations"] })
      .filter((query) => {
        const data = query.state.data as
          | { annotations?: Annotation[] }
          | undefined
        // A list still on its first read may answer with the old state.
        if (!data) return query.state.fetchStatus === "fetching"
        return data.annotations?.some(
          (annotation) => annotation.id === annotationId
        )
      })
      .map((query) => ({ queryKey: query.queryKey, exact: true }))
  )
}
