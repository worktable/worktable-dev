import type { QueryClient } from "@tanstack/react-query"
import { activityQueryKeys } from "./activity"
import { refreshLive } from "./live-refresh"

export const visitorCommentsQueryKey = (spaceId: string, documentId: string) =>
  ["visitor-comments", spaceId, documentId] as const

/** Identifier-only notices refresh the affected person's inbox and open list. */
export function applyVisitorCommentChange(
  queryClient: QueryClient,
  spaceId: string,
  value: unknown
): void {
  if (
    !value ||
    typeof value !== "object" ||
    !("documentId" in value) ||
    typeof value.documentId !== "string" ||
    !value.documentId ||
    !("linkId" in value) ||
    typeof value.linkId !== "string" ||
    !value.linkId
  )
    return
  refreshLive(queryClient, [
    {
      queryKey: visitorCommentsQueryKey(spaceId, value.documentId),
      exact: true,
    },
    { queryKey: activityQueryKeys.pendingIn(spaceId), exact: true },
    { queryKey: activityQueryKeys.pendingIn(), exact: true },
  ])
}
