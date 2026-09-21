import { queryOptions, useQuery } from "@tanstack/react-query"
import { listDocuments, readDocumentPage } from "./documents-api.ts"

export const documentQueryKeys = {
  list: (spaceId: string) => ["spaces", spaceId, "documents"] as const,
  page: (spaceId: string, path: string) =>
    ["spaces", spaceId, "documents", "page", path] as const,
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

export const documentPageQueryOptions = (spaceId: string, path: string) =>
  queryOptions({
    queryKey: documentQueryKeys.page(spaceId, path),
    queryFn: () => readDocumentPage(spaceId, path),
    staleTime: 10_000,
  })

export function useDocumentPage(spaceId: string, path: string) {
  return useQuery({
    ...documentPageQueryOptions(spaceId, path),
    enabled: path.length > 0,
  })
}
