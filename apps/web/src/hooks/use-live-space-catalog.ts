import { useEffect } from "react"
import { useQueryClient } from "@tanstack/react-query"
import type { InvalidateQueryFilters } from "@tanstack/react-query"
import { useSpaceEvents } from "@/hooks/use-space-events"
import { docQueryKeys } from "@/lib/docs-queries"
import { documentQueryKeys } from "@/lib/documents-queries"
import { queryKeys } from "@/lib/queries"

/**
 * Keep a Space's catalog live from its event stream: document headings, HTML
 * doc names, sort settings, and record collections. The sidebar and the
 * breadcrumb both name documents from it, and either may be the only one
 * mounted for a Space.
 */
export function useLiveSpaceCatalog(spaceId: string | undefined) {
  const { subscribe } = useSpaceEvents(spaceId)
  const queryClient = useQueryClient()

  useEffect(() => {
    if (!spaceId) return
    // The sidebar and breadcrumb may both subscribe to one Space. Joining a
    // refetch already in flight keeps their invalidations from restarting it.
    const refresh = (filters: InvalidateQueryFilters) =>
      void queryClient.invalidateQueries(filters, { cancelRefetch: false })
    return subscribe((msg) => {
      // A doc's label derives from its first heading, so an edit that adds an
      // H1 must show up without navigating away and back.
      if (msg.type === "doc_update" || msg.type === "doc_deleted") {
        refresh({
          queryKey: docQueryKeys.docs(spaceId),
          exact: true,
        })
        refresh({
          queryKey: documentQueryKeys.list(spaceId),
          exact: true,
        })
      }
      // HTML Doc events (create/rename/archive/delete) arrive as
      // widget_update / widget_moved / widget_deleted and change this Space's
      // document list. space_update carries settings changes (manual doc
      // order, sort mode) written by another client.
      if (
        msg.type === "space_update" ||
        msg.type === "widget_update" ||
        msg.type === "widget_moved" ||
        msg.type === "widget_deleted"
      ) {
        refresh({
          queryKey:
            msg.type === "space_update"
              ? queryKeys.spaces
              : documentQueryKeys.list(spaceId),
          exact: true,
        })
        // The per-space query carries resolved pins, which can name an HTML
        // Doc; refresh it so an edit elsewhere shows up live.
        refresh({
          queryKey: queryKeys.space(spaceId),
          exact: true,
        })
        // This may be the only subscriber for this event. Refresh the exact
        // HTML detail owner as well as its lists so a previously visited doc
        // cannot remain fresh with stale content or metadata. For moves,
        // widgetId is the canonical target; the mounted old route is
        // deliberately left to its redirect owner.
        if (
          msg.type !== "space_update" &&
          msg.type !== "widget_deleted" &&
          msg.widgetId
        ) {
          refresh({
            queryKey: queryKeys.widget(spaceId, msg.widgetId),
            exact: true,
          })
        }
      }
      // Collection list + counts in the records section below the tree. The
      // recordCollections key is the prefix of every record query, so this
      // also refreshes an open grid when the space page isn't mounted.
      if (
        msg.type === "record_update" ||
        msg.type === "record_deleted" ||
        msg.type === "record_collection_update"
      ) {
        refresh({
          queryKey: queryKeys.recordCollections(spaceId),
        })
      }
    })
  }, [subscribe, queryClient, spaceId])
}
