import { useEffect, useMemo } from "react"
import { useRouterState } from "@tanstack/react-router"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { usePageMeta } from "@/hooks/use-page-meta"
import { useSpaceEvents } from "@/hooks/use-space-events"
import {
  breadcrumbSpaceId,
  buildBreadcrumbs,
  isDocumentPathname,
} from "@/lib/breadcrumbs"
import type { Breadcrumb } from "@/lib/breadcrumbs"
import {
  documentQueryKeys,
  documentsQueryOptions,
} from "@/lib/documents-queries"
import { docQueryKeys, spaceDocsQueryOptions } from "@/lib/docs-queries"
import { useSpaces } from "@/lib/queries"
import {
  buildSpaceDocumentTrees,
  getDocOrder,
  getDocSort,
} from "@/lib/space-document-tree"

/** Route context for the shell header, labelled from the sidebar's catalog. */
export function useBreadcrumbs(): Breadcrumb[] {
  const pathname = useRouterState({ select: (s) => s.location.pathname })
  const { pageMeta } = usePageMeta()
  const spaceId = breadcrumbSpaceId(pathname)
  const { data: spaces } = useSpaces()
  const space = spaces?.find((candidate) => candidate.id === spaceId)
  const documentsEnabled = !!spaceId && isDocumentPathname(pathname)
  // Keep labels live even while the sidebar has this space collapsed.
  const queryClient = useQueryClient()
  const { subscribe } = useSpaceEvents(documentsEnabled ? spaceId : undefined)
  useEffect(() => {
    if (!spaceId) return
    return subscribe((message) => {
      if (message.type !== "doc_update" && message.type !== "doc_deleted") {
        return
      }
      void queryClient.invalidateQueries({
        queryKey: docQueryKeys.docs(spaceId),
        exact: true,
      })
      void queryClient.invalidateQueries({
        queryKey: documentQueryKeys.list(spaceId),
        exact: true,
      })
    })
  }, [subscribe, queryClient, spaceId])
  const { data: documents } = useQuery({
    ...documentsQueryOptions(spaceId ?? ""),
    enabled: documentsEnabled,
  })
  const { data: docs } = useQuery({
    ...spaceDocsQueryOptions(spaceId ?? ""),
    enabled: documentsEnabled,
  })
  const trees = useMemo(
    () =>
      documentsEnabled && space && documents && docs
        ? buildSpaceDocumentTrees({
            documents,
            docs,
            widgets: space.widgets ?? [],
            sort: getDocSort(space),
            order: getDocOrder(space),
          })
        : undefined,
    [documentsEnabled, space, documents, docs]
  )

  return buildBreadcrumbs({
    pathname,
    titleOverride: pageMeta?.titleOverride,
    parentTitleOverride: pageMeta?.parentTitleOverride,
    spaceName: space?.name,
    spaceIcon: space?.icon,
    documents: trees,
  })
}
