import { useResolvedDocumentHandle } from "../document-query.ts"
import { countsViews } from "../routes/public-share-views.ts"
import {
  listDocumentShareLinks,
  ShareLinksStoreError,
} from "../share-links-store.ts"
import { shareViewSummaries, shareViewsForAgent } from "../share-views.ts"

/**
 * The views of an HTML Doc's share links that count them, for an agent that
 * can read the HTML Doc: counts, recent views and link previews. No token,
 * URL, digest or visitor name.
 */
export async function htmlShareLinkViews(
  spaceId: string,
  path: string
): Promise<
  Array<
    {
      label: string
      createdAt: string
      viewCount: number
      people: number
      lastViewAt: string | null
      lastFetchedAt: string | null
      recentViews: ReturnType<typeof shareViewsForAgent>["views"]
      previews: ReturnType<typeof shareViewsForAgent>["previews"]
    }
  >
> {
  const resolved = await useResolvedDocumentHandle(
    { spaceId, path, snapshot: true },
    async (handle) => handle.documentId
  ).catch(() => null)
  if (typeof resolved !== "string") return []
  let links
  try {
    links = listDocumentShareLinks(spaceId, resolved).filter(countsViews)
  } catch (error) {
    if (error instanceof ShareLinksStoreError) return []
    throw error
  }
  const summaries = shareViewSummaries(links.map((link) => link.id))
  return links.map((link) => {
    const summary = summaries.get(link.id)
    const detail = shareViewsForAgent(link.id)
    return {
      label: link.label,
      createdAt: new Date(link.createdAt).toISOString(),
      viewCount: summary?.views ?? 0,
      people: summary?.people ?? 0,
      lastViewAt: summary?.lastViewAt
        ? new Date(summary.lastViewAt).toISOString()
        : null,
      lastFetchedAt:
        link.lastUsedAt === null ? null : new Date(link.lastUsedAt).toISOString(),
      recentViews: detail.views,
      previews: detail.previews,
    }
  })
}
