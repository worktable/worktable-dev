import type { QueryClient, QueryFilters } from "@tanstack/react-query"
import type { DocumentPageResult, DocumentShareLinks, ShareLinksPage } from "@worktable/types"
import { visitorNoticeAfterRefresh } from "@/components/annotations/visitor-comment-notices"
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
  const notice = visitorNoticeAfterRefresh(queryClient, spaceId, value.documentId)
  const refresh: QueryFilters[] = [
    {
      queryKey: visitorCommentsQueryKey(spaceId, value.documentId),
      exact: true,
    },
    { queryKey: activityQueryKeys.pendingIn(spaceId), exact: true },
    { queryKey: activityQueryKeys.pendingIn(), exact: true },
  ]
  for (const query of queryClient.getQueryCache().findAll({
    queryKey: ["spaces", spaceId, "document-page"],
  })) {
    const page = query.state.data as DocumentPageResult | undefined
    if (page?.kind === "document" && page.sharing?.visitorComments?.documentId === value.documentId)
      refresh.push({queryKey: query.queryKey, exact: true})
  }
  for (const query of queryClient.getQueryCache().findAll({queryKey: ["share-links"]})) {
    const data = query.state.data
    if (!data || typeof data !== "object") continue
    const shaped = data as DocumentShareLinks | {pages?: ShareLinksPage[]}
    const links = "links" in shaped ? shaped.links : shaped.pages?.flatMap(page => page.links)
    if (links?.some(link => link.id === value.linkId))
      refresh.push({queryKey: query.queryKey, exact: true})
  }
  refreshLive(queryClient, refresh)
  notice()
}
