import { useRouterState } from "@tanstack/react-router"
import { usePageMeta } from "@/hooks/use-page-meta"
import { useLiveSpaceCatalog } from "@/hooks/use-live-space-catalog"
import { useSpaceDocumentTrees } from "@/hooks/use-space-document-trees"
import {
  breadcrumbSpaceId,
  buildBreadcrumbs,
  isDocumentPathname,
} from "@/lib/breadcrumbs"
import type { Breadcrumb } from "@/lib/breadcrumbs"
import { useSpaces } from "@/lib/queries"

/** Route context for the shell header, labelled from the sidebar's catalog. */
export function useBreadcrumbs(): Breadcrumb[] {
  const pathname = useRouterState({ select: (s) => s.location.pathname })
  const pageMeta = usePageMeta()
  const spaceId = breadcrumbSpaceId(pathname)
  const { data: spaces } = useSpaces()
  const space = spaces?.find((candidate) => candidate.id === spaceId)
  const documentsEnabled = !!spaceId && isDocumentPathname(pathname)
  // Keep labels live even while the sidebar has this space collapsed.
  useLiveSpaceCatalog(documentsEnabled ? spaceId : undefined)
  const trees = useSpaceDocumentTrees(spaceId, documentsEnabled)

  return buildBreadcrumbs({
    pathname,
    titleOverride: pageMeta?.titleOverride,
    parentTitleOverride: pageMeta?.parentTitleOverride,
    spaceName: space?.name,
    spaceIcon: space?.icon,
    documents: trees,
  })
}
