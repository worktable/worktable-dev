import type { QueryClient, QueryKey } from "@tanstack/react-query"
import type {
  DocumentListItem,
  DocumentPageResult,
  ResolvedStartHerePin,
  SearchResult,
  WithContentRevision,
} from "@worktable/types"
import { documentQueryKeys } from "./documents-queries.ts"
import { recentQueryKeys, type RecentDocuments } from "./lifetime.ts"
import { queryKeys } from "./queries.ts"

// Rows the app opens documents from (the Space's documents, Recent, search
// results and pins) carry the revision of the content each would open. A row
// is a hint: opening a document still checks it, and shows it read-only
// until then.

/** What the tab knows about a document before checking it. */
export interface DocumentOpenHint {
  renderer: "doc" | "html"
  formatId: string
  revision: string
  title?: string
  archived?: boolean
}

const RENDERERS: Record<string, DocumentOpenHint["renderer"]> = {
  "worktable.markdown": "doc",
  "worktable.rich-text": "doc",
  "worktable.html": "html",
}

type SpaceDetail = {
  pins?: WithContentRevision<ResolvedStartHerePin>[]
}
type SearchData = { results: WithContentRevision<SearchResult>[] }

function rowHint(row: {
  format?: { id: string }
  revision?: string
  title?: string
  archived?: unknown
}): DocumentOpenHint | null {
  const renderer = row.format ? RENDERERS[row.format.id] : undefined
  if (!renderer || !row.revision || !row.format) return null
  return {
    renderer,
    formatId: row.format.id,
    revision: row.revision,
    ...(row.title ? { title: row.title } : {}),
    ...(row.archived ? { archived: true } : {}),
  }
}

/**
 * The newest thing the tab holds about the document at this path that names
 * its content revision: an earlier page check, or a row. Null when nothing
 * does, or when what it holds says the path opens another document.
 */
export function documentOpenHint(
  queryClient: QueryClient,
  spaceId: string,
  path: string
): DocumentOpenHint | null {
  let best: { hint: DocumentOpenHint; at: number } | null = null
  const consider = (queryKey: QueryKey, hint: DocumentOpenHint | null) => {
    if (!hint) return
    const at = queryClient.getQueryState(queryKey)?.dataUpdatedAt ?? 0
    if (!best || at > best.at) best = { hint, at }
  }

  const pageKey = documentQueryKeys.page(spaceId, path)
  const page = queryClient.getQueryData<DocumentPageResult>(pageKey)
  if (page?.kind === "document") {
    // An alias or a move: the path opens another document. Wait for the check.
    if (page.document.path !== path) return null
    const renderer = page.renderer?.key
    if ((renderer === "doc" || renderer === "html") && page.revision) {
      consider(pageKey, {
        renderer,
        formatId: page.document.format.id,
        revision: page.revision,
        title: page.document.title,
        ...(page.document.archived ? { archived: true } : {}),
      })
    }
  }

  const listKey = documentQueryKeys.list(spaceId)
  const listed = queryClient
    .getQueryData<WithContentRevision<DocumentListItem>[]>(listKey)
    ?.find((row) => row.kind === "document" && row.path === path)
  if (listed?.kind === "document") consider(listKey, rowHint(listed))

  for (const [queryKey, data] of queryClient.getQueriesData<RecentDocuments>({
    queryKey: recentQueryKeys.all,
  })) {
    const row = [...(data?.items ?? []), ...(data?.temporary ?? [])].find(
      (item) => item.spaceId === spaceId && item.document.path === path
    )
    if (row) consider(queryKey, rowHint(row.document))
  }

  for (const [queryKey, data] of queryClient.getQueriesData<SearchData>({
    queryKey: ["search"],
  })) {
    const row = data?.results?.find(
      (result) => result.spaceId === spaceId && result.path === path
    )
    if (row?.documentView) consider(queryKey, rowHint(row))
  }

  const spaceKey = queryKeys.space(spaceId)
  const pin = queryClient
    .getQueryData<SpaceDetail>(spaceKey)
    ?.pins?.find((item) => item.path === path && item.status !== "missing")
  if (pin) {
    consider(spaceKey, rowHint({ ...pin, archived: pin.status === "archived" }))
  }

  return (best as { hint: DocumentOpenHint } | null)?.hint ?? null
}

/**
 * Move every row of the document at this path to a new revision in place,
 * as a change event reports it, so the next open reads the new content
 * without reading a list again.
 */
export function patchDocumentRevision(
  queryClient: QueryClient,
  spaceId: string,
  path: string,
  revision: string
): void {
  const patched = <T extends { revision?: string }>(row: T): T =>
    row.revision === revision ? row : { ...row, revision }
  // Only lists holding a stale row are written, so the rest keep their age.
  const stale = (row: { revision?: string }) => row.revision !== revision

  const listKey = documentQueryKeys.list(spaceId)
  const rows =
    queryClient.getQueryData<WithContentRevision<DocumentListItem>[]>(listKey)
  if (
    rows?.some(
      (row) => row.kind === "document" && row.path === path && stale(row)
    )
  ) {
    queryClient.setQueryData(
      listKey,
      rows.map((row) =>
        row.kind === "document" && row.path === path ? patched(row) : row
      )
    )
  }
  const recentRow = (item: RecentDocuments["items"][number]) =>
    item.spaceId === spaceId && item.document.path === path
      ? { ...item, document: patched(item.document) }
      : item
  for (const [queryKey, data] of queryClient.getQueriesData<RecentDocuments>({
    queryKey: recentQueryKeys.all,
  })) {
    if (
      !data ||
      ![...data.items, ...(data.temporary ?? [])].some(
        (item) =>
          item.spaceId === spaceId &&
          item.document.path === path &&
          stale(item.document)
      )
    ) {
      continue
    }
    queryClient.setQueryData<RecentDocuments>(queryKey, {
      ...data,
      items: data.items.map(recentRow),
      ...(data.temporary ? { temporary: data.temporary.map(recentRow) } : {}),
    })
  }
  for (const [queryKey, data] of queryClient.getQueriesData<SearchData>({
    queryKey: ["search"],
  })) {
    if (
      !data?.results?.some(
        (result) =>
          result.spaceId === spaceId && result.path === path && stale(result)
      )
    ) {
      continue
    }
    queryClient.setQueryData<SearchData>(queryKey, {
      ...data,
      results: data.results.map((result) =>
        result.spaceId === spaceId && result.path === path
          ? patched(result)
          : result
      ),
    })
  }
  const spaceKey = queryKeys.space(spaceId)
  const detail = queryClient.getQueryData<SpaceDetail>(spaceKey)
  if (detail?.pins?.some((pin) => pin.path === path && stale(pin))) {
    queryClient.setQueryData<SpaceDetail>(spaceKey, {
      ...detail,
      pins: detail.pins.map((pin) => (pin.path === path ? patched(pin) : pin)),
    })
  }
}
