import { Link } from "@tanstack/react-router"
import type { Query, QueryClient } from "@tanstack/react-query"
import type { DocumentPageResult, PendingItem } from "@worktable/types"
import { toast } from "@worktable/ui/components/sonner"
import { activityQueryKeys } from "@/lib/activity"

type Notice = {count: number; path?: string; title?: string}

function notice(query: Query, documentId: string): Notice | null {
  const data = query.state.data
  if (!data || typeof data !== "object") return null
  if ("kind" in data) {
    const page = data as DocumentPageResult
    return page.kind === "document" && page.sharing?.visitorComments?.documentId === documentId
      ? {count: page.sharing.visitorComments.newCount, path: page.document.path, title: page.document.title}
      : null
  }
  if (!("items" in data) || !Array.isArray(data.items)) return null
  const items = (data.items as PendingItem[]).filter(item => item.kind === "visitorComments" && item.documentId === documentId)
  return {
    count: items.reduce((count, item) => count + (item.kind === "visitorComments" ? item.count : 0), 0),
    ...(items[0]?.kind === "visitorComments" ? {path: items[0].docPath, title: items[0].docTitle} : {}),
  }
}

/** Use the reads already on screen; no visitor text, new request or polling. */
export function visitorNoticeAfterRefresh(client: QueryClient, spaceId: string, documentId: string): () => void {
  if (typeof window === "undefined") return () => {}
  const cache = client.getQueryCache()
  const queries = new Set([
    ...cache.findAll({queryKey: activityQueryKeys.pendingIn(), exact: true}),
    ...cache.findAll({queryKey: activityQueryKeys.pendingIn(spaceId), exact: true}),
    ...cache.findAll({queryKey: ["spaces", spaceId, "document-page"]}),
  ])
  const before = [...queries].filter(query => query.isActive()).map(query => ({query, count: notice(query, documentId)?.count}))
  return () => {
    let shown = false
    for (const {query, count} of before) {
      if (count === undefined) continue
      // A trailing live refresh follows a read that began before the event.
      void Promise.resolve(query.promise).catch(() => {}).then(() => query.promise).catch(() => {}).then(() => {
        if (shown || cache.find({queryKey: query.queryKey, exact: true}) !== query || query.state.status !== "success") return
        const after = notice(query, documentId)
        if (!after || after.count <= count) return
        shown = true
        toast(after.title ? `New visitor comment on ${after.title}` : "New visitor comment", {
          id: `visitor-comment:${spaceId}:${documentId}`,
          action: after.path ? <Link to="/spaces/$spaceId/documents/$" params={{spaceId, _splat: after.path}} hash="visitors">View</Link> : <Link to="/spaces/$spaceId" params={{spaceId}}>View</Link>,
        })
      })
    }
  }
}
