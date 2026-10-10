import { queryOptions, useQuery } from "@tanstack/react-query"
import { listDocuments, readDocumentPage } from "./documents-api.ts"
import { abandonableRead } from "./http.ts"
import {
  spaceReadMark,
  spaceValidatedLive,
  trackSpaceRead,
} from "./space-observation.ts"

// The page check sits beside the list, not under it, so refreshing the list
// leaves an open document's page alone.
export const documentQueryKeys = {
  list: (spaceId: string) => ["spaces", spaceId, "documents"] as const,
  page: (spaceId: string, path: string) =>
    ["spaces", spaceId, "document-page", path] as const,
}

export const documentsQueryOptions = (spaceId: string) =>
  queryOptions({
    queryKey: documentQueryKeys.list(spaceId),
    queryFn: () => listDocuments(spaceId, true),
    staleTime: 30_000,
  })

export function useDocuments(spaceId: string) {
  return useQuery(documentsQueryOptions(spaceId))
}

const pageReadKey = (spaceId: string, path: string) =>
  `page\0${spaceId}\0${path}`

export const documentPageQueryOptions = (spaceId: string, path: string) =>
  queryOptions({
    queryKey: documentQueryKeys.page(spaceId, path),
    queryFn: (context) =>
      trackSpaceRead(spaceId, pageReadKey(spaceId, path), () =>
        abandonableRead(context, (read) =>
          readDocumentPage(spaceId, path, read)
        )
      ),
    staleTime: 10_000,
  })

/**
 * The cached page check is still current: it was read while the Space's
 * socket was live, and no change has reached the tab since.
 */
export function documentPageValidatedLive(
  spaceId: string,
  path: string
): boolean {
  const mark = spaceReadMark(pageReadKey(spaceId, path))
  return mark !== undefined && spaceValidatedLive(spaceId, mark)
}

export function useDocumentPage(spaceId: string, path: string) {
  return useQuery({
    ...documentPageQueryOptions(spaceId, path),
    enabled: path.length > 0,
  })
}
