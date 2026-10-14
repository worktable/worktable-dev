import { queryOptions, useQuery, type QueryClient } from "@tanstack/react-query"
import type { DocumentContent } from "@worktable/types"
import {
  changedRevision,
  listDocuments,
  readDocumentContent,
  readDocumentPage,
} from "./documents-api.ts"
import { abandonableRead } from "./http.ts"
import {
  spaceReadMark,
  spaceUnchangedSince,
  spaceValidatedLive,
  trackSpaceRead,
} from "./space-observation.ts"

// The page check sits beside the list, not under it, so refreshing the list
// leaves an open document's page alone. Content sits beside both, keyed by
// revision: a revision's content never changes.
export const documentQueryKeys = {
  list: (spaceId: string) => ["spaces", spaceId, "documents"] as const,
  page: (spaceId: string, path: string) =>
    ["spaces", spaceId, "document-page", path] as const,
  contentIn: (spaceId: string, path: string) =>
    ["spaces", spaceId, "document-content", path] as const,
  content: (spaceId: string, path: string, revision: string) =>
    ["spaces", spaceId, "document-content", path, revision] as const,
}

/** Content queries are immutable; Space-wide refreshes leave them alone. */
export function isDocumentContentQuery(queryKey: readonly unknown[]): boolean {
  return queryKey[0] === "spaces" && queryKey[2] === "document-content"
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
      trackSpaceRead(
        spaceId,
        pageReadKey(spaceId, path),
        () =>
          abandonableRead(context, (read) =>
            readDocumentPage(spaceId, path, read)
          ),
        path
      ),
    staleTime: 10_000,
  })

/**
 * The cached page check is still current: it was read while the Space's
 * socket was live, and nothing about this document (or the whole Space) has
 * reached the tab since.
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
    // A check the live socket still proves is not read again on a revisit.
    staleTime: () =>
      documentPageValidatedLive(spaceId, path) ? Infinity : 10_000,
    enabled: path.length > 0,
  })
}

// ── Opening ──────────────────────────────────────────────────

// The route and the renderer can load separate copies of this module.
const openStartsGlobal = globalThis as typeof globalThis & {
  __worktableDocumentOpenStarts?: Map<string, number>
}
const openStarts =
  openStartsGlobal.__worktableDocumentOpenStarts ??
  (openStartsGlobal.__worktableDocumentOpenStarts = new Map())

/** A navigation to this document began; page checks from now on validate it. */
export function noteDocumentOpen(spaceId: string, path: string): void {
  openStarts.set(pageReadKey(spaceId, path), performance.now())
}

/**
 * The document is on screen. A navigation can reuse a preload's route work
 * without noting an open, so the page notes it then if nothing did.
 */
export function ensureDocumentOpen(spaceId: string, path: string): void {
  const key = pageReadKey(spaceId, path)
  if (!openStarts.has(key)) openStarts.set(key, performance.now())
}

/** The document left the screen; its next open starts afresh. */
export function forgetDocumentOpen(spaceId: string, path: string): void {
  openStarts.delete(pageReadKey(spaceId, path))
}

/**
 * The cached page check validates this open: the live socket still proves
 * it, or its answer arrived after the open began (it was asked then, or was
 * already on its way, as a tap's preload is) with nothing about the document
 * reported since it was asked. Until then the document is shown read-only,
 * if at all; editing and collaboration wait for this.
 */
export function documentPageValidated(spaceId: string, path: string): boolean {
  const mark = spaceReadMark(pageReadKey(spaceId, path))
  if (!mark) return false
  const openedAt = openStarts.get(pageReadKey(spaceId, path))
  return (
    spaceValidatedLive(spaceId, mark) ||
    (openedAt !== undefined &&
      (mark.answeredAt ?? mark.at) >= openedAt &&
      spaceUnchangedSince(spaceId, mark))
  )
}

// ── Content by revision ──────────────────────────────────────

// A content address answered with a newer revision points there, for the
// rows and earlier checks that still name the old one. Only one step is
// followed: the page check settles anything later. A revision the page check
// names is current, so it is read as is and drops its redirect: a hash can
// become current again (a version restored, say).
const redirectsGlobal = globalThis as typeof globalThis & {
  __worktableContentRedirects?: Map<string, string>
}
const contentRedirects =
  redirectsGlobal.__worktableContentRedirects ??
  (redirectsGlobal.__worktableContentRedirects = new Map())
const redirectKey = (spaceId: string, path: string, revision: string) =>
  `${spaceId}\0${path}\0${revision}`

/**
 * The revision to read for `revision`: itself, or the one it was answered
 * with unless the page check names it as current.
 */
export function documentContentRevision(
  spaceId: string,
  path: string,
  revision: string,
  current = false
): string {
  const key = redirectKey(spaceId, path, revision)
  if (current) {
    contentRedirects.delete(key)
    return revision
  }
  return contentRedirects.get(key) ?? revision
}

export const documentContentQueryOptions = (
  spaceId: string,
  path: string,
  revision: string
) =>
  queryOptions({
    queryKey: documentQueryKeys.content(spaceId, path, revision),
    queryFn: async (context): Promise<DocumentContent> => {
      try {
        return await abandonableRead(context, (read) =>
          readDocumentContent(spaceId, path, revision, read)
        )
      } catch (error) {
        const current = changedRevision(error)
        if (current) {
          contentRedirects.set(redirectKey(spaceId, path, revision), current)
        }
        throw error
      }
    },
    staleTime: Infinity,
    retry: false,
  })

/**
 * Start reading a Doc's content at the revision the tab knows, and once
 * more at the revision a stale one is answered with.
 */
export async function prefetchDocumentContent(
  queryClient: QueryClient,
  spaceId: string,
  path: string,
  revision: string,
  current = false
): Promise<void> {
  const effective = documentContentRevision(spaceId, path, revision, current)
  await queryClient.prefetchQuery(
    documentContentQueryOptions(spaceId, path, effective)
  )
  const next = documentContentRevision(spaceId, path, effective)
  if (next !== effective && effective === revision) {
    await queryClient.prefetchQuery(
      documentContentQueryOptions(spaceId, path, next)
    )
  }
}

/**
 * A Doc's content at `revision`, or at the newer revision a stale one was
 * answered with. While a new revision loads, the previous content of the
 * same document stays on screen.
 */
export function useDocumentContent(
  spaceId: string,
  path: string,
  revision: string | undefined,
  current = false
) {
  const effective =
    revision === undefined
      ? undefined
      : documentContentRevision(spaceId, path, revision, current)
  return useQuery({
    ...documentContentQueryOptions(spaceId, path, effective ?? ""),
    enabled: effective !== undefined,
    placeholderData: (previous, previousQuery) =>
      previousQuery?.queryKey[1] === spaceId &&
      previousQuery.queryKey[3] === path
        ? previous
        : undefined,
  })
}

/** Keep content a change event carried, if this tab reads the document. */
export function rememberDocumentContent(
  queryClient: QueryClient,
  spaceId: string,
  path: string,
  content: DocumentContent
): void {
  const read = queryClient.getQueriesData({
    queryKey: documentQueryKeys.contentIn(spaceId, path),
  })
  if (read.length === 0) return
  queryClient.setQueryData(
    documentQueryKeys.content(spaceId, path, content.revision),
    content
  )
}
