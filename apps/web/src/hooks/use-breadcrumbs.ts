import { useMemo } from "react"
import { useRouterState } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"
import { usePageMeta } from "@/hooks/use-page-meta"
import {
  breadcrumbSpaceId,
  buildBreadcrumbs,
  isDocumentPathname,
} from "@/lib/breadcrumbs"
import type { Breadcrumb } from "@/lib/breadcrumbs"
import { documentsQueryOptions } from "@/lib/documents-queries"
import { spaceDocsQueryOptions } from "@/lib/docs-queries"
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
