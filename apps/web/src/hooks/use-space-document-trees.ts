import { useQuery } from "@tanstack/react-query"
import { documentsQueryOptions } from "@/lib/documents-queries"
import { spaceDocsQueryOptions } from "@/lib/docs-queries"
import { useSpaces } from "@/lib/queries"
import {
  getDocOrder,
  getDocSort,
  spaceDocumentTrees,
  type SpaceDocumentTrees,
} from "@/lib/space-document-tree"

/**
 * A Space's documents as the sidebar orders and labels them, from the same
 * cached reads and the same cached build.
 */
export function useSpaceDocumentTrees(
  spaceId: string | undefined,
  enabled = true
): SpaceDocumentTrees | undefined {
  const { data: spaces } = useSpaces()
  const space = spaces?.find((candidate) => candidate.id === spaceId)
  const active = enabled && !!spaceId
  const { data: documents } = useQuery({
    ...documentsQueryOptions(spaceId ?? ""),
    enabled: active,
  })
  const { data: docs } = useQuery({
    ...spaceDocsQueryOptions(spaceId ?? ""),
    enabled: active,
  })
  return active && space && documents && docs
    ? spaceDocumentTrees({
        documents,
        docs,
        sort: getDocSort(space),
        order: getDocOrder(space),
      })
    : undefined
}
