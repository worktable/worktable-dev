import type { QueryClient } from "@tanstack/react-query"
import type {
  DocListEntry,
  DocumentListItem,
  RecordCollectionSummary,
  ResolvedStartHerePin,
  WithContentRevision,
} from "@worktable/types"
import type { SpaceView } from "./api"
import { spaceDocsQueryOptions } from "./docs-queries"
import { documentsQueryOptions } from "./documents-queries"
import { fetchJSON } from "./http.ts"
import { recordCollectionsQueryOptions, spaceQueryOptions } from "./queries"
import { rememberOneSpaceAccess } from "./team-access"

/** One Space's sidebar contents, each part as its own route sends it. */
interface SidebarSpace {
  id: string
  page?: { space: SpaceView; pins?: WithContentRevision<ResolvedStartHerePin>[] }
  docs: DocListEntry[]
  documents?: WithContentRevision<DocumentListItem>[]
  collections?: RecordCollectionSummary[]
}

/**
 * Loads every Space's sidebar contents in one request and keeps them where
 * the tree reads them, so a Space opens with its tree in the frame of the
 * press instead of a round trip later. Contents the tab already holds are
 * left as they are; when a Space opens, its own queries refresh what it
 * shows.
 */
export async function loadSidebarContents(
  queryClient: QueryClient
): Promise<void> {
  const { spaces } = await fetchJSON<{ spaces: SidebarSpace[] }>(
    "/api/sidebar"
  )
  const keep = <T>(
    options: { queryKey: readonly unknown[] },
    data: T | undefined
  ) => {
    if (data === undefined) return
    if (queryClient.getQueryData(options.queryKey) !== undefined) return
    // Through the query's own options, so it is kept as long as one the
    // Space fetched itself.
    void queryClient.prefetchQuery({
      ...options,
      queryFn: () => Promise.resolve(data),
    } as Parameters<QueryClient["prefetchQuery"]>[0])
  }
  for (const space of spaces) {
    if (space.page) rememberOneSpaceAccess(space.page.space)
    keep(spaceQueryOptions(space.id), space.page)
    keep(spaceDocsQueryOptions(space.id), space.docs)
    keep(documentsQueryOptions(space.id), space.documents)
    keep(recordCollectionsQueryOptions(space.id), space.collections)
  }
}
