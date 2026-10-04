import { useEffect } from "react"
import { useQueryClient } from "@tanstack/react-query"
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
    return subscribe((msg) => {
      // A doc's label derives from its first heading, so an edit that adds an
      // H1 must show up without navigating away and back.
      if (msg.type === "doc_update" || msg.type === "doc_deleted") {
        void queryClient.invalidateQueries({
          queryKey: docQueryKeys.docs(spaceId),
          exact: true,
        })
        void queryClient.invalidateQueries({
          queryKey: documentQueryKeys.list(spaceId),
          exact: true,
        })
      }
      // Widget events (create/rename/archive/delete) arrive as widget_update /
      // widget_deleted; the widget list rides on the spaces query.
      // space_update carries settings changes (manual doc order, sort mode)
      // written by another client.
      if (
        msg.type === "space_update" ||
        msg.type === "widget_update" ||
        msg.type === "widget_moved" ||
        msg.type === "widget_deleted"
      ) {
        void queryClient.invalidateQueries({
          queryKey: queryKeys.spaces,
          exact: true,
        })
        // The per-space embed lists this Space's widgets for the overview;
        // refresh it too so an edit elsewhere shows up live.
        void queryClient.invalidateQueries({
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
          void queryClient.invalidateQueries({
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
        void queryClient.invalidateQueries({
          queryKey: queryKeys.recordCollections(spaceId),
        })
      }
    })
  }, [subscribe, queryClient, spaceId])
}
